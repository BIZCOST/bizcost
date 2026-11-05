import { LEGAL_VERSION, type AcceptTermsInput, type ProfileDto } from '@bizcost/contracts'
import { profiles, type Tx } from '@bizcost/db'
import { isLocale } from '@bizcost/domain'
import { and, eq, sql } from 'drizzle-orm'
import type { AuthUser } from '../auth'
import { memoized, type Context } from '../context'
import { AppError } from '../errors'

/** Default display name for a new profile: the local part of the email. */
export function defaultDisplayName(email: string | null): string {
  return email?.split('@')[0]?.trim() ?? ''
}

/**
 * Creates the caller's profile if it is missing (not by a trigger on auth.users): display name from
 * the email, locale from user_metadata.locale ('ar' when missing), and the terms the sign-up form's box
 * accepted when they are the ones in force (D-358). An existing profile is never overwritten.
 */
export async function ensureProfile(tx: Tx, auth: AuthUser): Promise<void> {
  await tx
    .insert(profiles)
    .values({
      id: auth.userId,
      displayName: defaultDisplayName(auth.email),
      locale: auth.locale ?? 'ar',
      ...(auth.termsVersion === LEGAL_VERSION
        ? { termsVersion: LEGAL_VERSION, termsAcceptedAt: sql`now()` }
        : {}),
    })
    .onConflictDoNothing({ target: profiles.id })
}

/**
 * True when the user's profile is anonymized, i.e. the account was deleted. Access tokens are
 * verified locally, so a deleted account's token keeps a valid signature until it expires.
 */
export async function isDeletedAccount(tx: Tx, userId: string): Promise<boolean> {
  const [row] = await tx
    .select({ anonymizedAt: profiles.anonymizedAt })
    .from(profiles)
    .where(eq(profiles.id, userId))
  return row !== undefined && row.anonymizedAt !== null
}

export const profileColumns = {
  id: profiles.id,
  displayName: profiles.displayName,
  locale: profiles.locale,
  lastBusinessId: profiles.lastBusinessId,
  termsVersion: profiles.termsVersion,
}

export function toProfileDto(
  row: {
    id: string
    displayName: string | null
    locale: string
    lastBusinessId: string | null
    termsVersion: string | null
  },
  email: string | null,
): ProfileDto {
  return {
    id: row.id,
    displayName: row.displayName ?? defaultDisplayName(email),
    locale: isLocale(row.locale) ? row.locale : 'ar',
    lastBusinessId: row.lastBusinessId,
    termsAccepted: row.termsVersion === LEGAL_VERSION,
  }
}

/**
 * `account.acceptTerms` (D-358): the caller accepts the terms and privacy policy in force. Accepted
 * once: asked again it keeps the first time. Another version is refused (VALIDATION): a tab left open
 * across a release must not accept what its reader did not see.
 */
export async function acceptTerms(
  ctx: Context,
  auth: AuthUser,
  input: AcceptTermsInput,
): Promise<ProfileDto> {
  if (input.termsVersion !== LEGAL_VERSION) {
    throw new AppError('validation', { message: 'termsVersion: not the terms in force' })
  }
  const row = await ctx.tenantTx(null, async (tx) => {
    await ensureProfile(tx, auth)
    await tx
      .update(profiles)
      .set({ termsVersion: LEGAL_VERSION, termsAcceptedAt: sql`now()` })
      .where(
        and(eq(profiles.id, auth.userId), sql`terms_version is distinct from ${LEGAL_VERSION}`),
      )
    const [profile] = await tx
      .select(profileColumns)
      .from(profiles)
      .where(eq(profiles.id, auth.userId))
    return profile
  })
  if (!row) throw new AppError('internal', { message: 'profile missing after upsert' })
  return toProfileDto(row, auth.email)
}

/**
 * Whether the caller is a platform admin (BIZCOST_PLATFORM_ADMINS, D-357): their address, as Auth's own
 * row has it once confirmed, is on the server's list. No tenant role makes anyone one. Memoized per
 * request.
 */
export function isPlatformAdmin(ctx: Context, auth: AuthUser): Promise<boolean> {
  const admins = ctx.config.platformAdmins ?? []
  const named = (email: string | null | undefined) =>
    typeof email === 'string' && admins.includes(email.toLowerCase())
  // Nobody listed, or a token for another address: no query on every `me`.
  if (!named(auth.email)) return Promise.resolve(false)
  return memoized(ctx, 'platform-admin', async () => {
    const [row] = (await ctx.tenantTx(null, (tx) =>
      tx.execute(sql`select app.my_verified_email() as email`),
    )) as unknown as { email: string | null }[]
    return named(row?.email)
  })
}

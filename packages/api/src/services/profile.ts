import type { ProfileDto } from '@bizcost/contracts'
import { profiles, type Tx } from '@bizcost/db'
import { isLocale } from '@bizcost/domain'
import { eq } from 'drizzle-orm'
import type { AuthUser } from '../auth'

/** Default display name for a new profile: the local part of the email. */
export function defaultDisplayName(email: string | null): string {
  return email?.split('@')[0]?.trim() ?? ''
}

/**
 * Creates the caller's profile if it is missing (not by a trigger on auth.users): display name from
 * the email, locale from user_metadata.locale ('ar' when missing). An existing profile is never
 * overwritten.
 */
export async function ensureProfile(tx: Tx, auth: AuthUser): Promise<void> {
  await tx
    .insert(profiles)
    .values({
      id: auth.userId,
      displayName: defaultDisplayName(auth.email),
      locale: auth.locale ?? 'ar',
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
}

export function toProfileDto(
  row: { id: string; displayName: string | null; locale: string; lastBusinessId: string | null },
  email: string | null,
): ProfileDto {
  return {
    id: row.id,
    displayName: row.displayName ?? defaultDisplayName(email),
    locale: isLocale(row.locale) ? row.locale : 'ar',
    lastBusinessId: row.lastBusinessId,
  }
}

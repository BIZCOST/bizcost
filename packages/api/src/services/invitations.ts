import { createHash, randomBytes } from 'node:crypto'
import {
  INVITATION_MAX_RESENDS,
  INVITATION_TTL_DAYS,
  type AcceptInvitationDto,
  type CreateInvitationInput,
  type InvitationDto,
  type InvitationIdInput,
  type InvitationPreviewDto,
  type InvitationTokenInput,
  type OkDto,
} from '@bizcost/contracts'
import {
  businessCapabilities,
  businesses,
  businessInvitations,
  businessMembers,
  profiles,
  rolePermissions,
  roles,
  type Tx,
} from '@bizcost/db'
import { can, isLocale, newId, OWNER_TEMPLATE_KEY, type Locale } from '@bizcost/domain'
import { createI18n, type I18nKey } from '@bizcost/i18n'
import { isRoleTemplateKey } from '@bizcost/modules'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { loadBusinessAccess, type BusinessAccess } from '../access'
import type { AuthUser } from '../auth'
import type { BusinessCtx } from '../business-context'
import type { Context } from '../context'
import { invitationEmail } from '../email/invitation'
import type { EmailMessage } from '../email/sender'
import { AppError, constraintOf } from '../errors'
import { ensureProfile } from './profile'
import { canGrant } from './team-rules'

// Settings → Team, invitations (docs/ARCHITECTURE.md §Auth, docs/DATA_MODEL.md §4 business_invitations,
// ROADMAP.md Step 6). A token is 32 random bytes (base64url, 43 characters) that exists only in the
// email; the database keeps its SHA-256 hex. A link works for INVITATION_TTL_DAYS; a resend makes a new
// token (the old link stops working). Limits live in the database (app.invitation_limits: 20 a day per
// business, 40 a day per inviting user, 3 resends per invitation, 4 emails a day per address), and
// every write is audited by the database. The email is sent after the invitation is committed, never
// inside a transaction (a slow provider must not hold a database connection or the business's locks).
// Accepting goes through app.accept_invitation (the caller's verified email must be the invited one,
// and the sender must still be allowed to invite).

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url')
  return { token, hash: tokenHash(token) }
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function expiresAt(): Date {
  return new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000)
}

const invitationColumns = {
  id: businessInvitations.id,
  email: businessInvitations.email,
  roleId: businessInvitations.roleId,
  roleName: roles.name,
  roleTemplateKey: roles.templateKey,
  locale: businessInvitations.locale,
  status: businessInvitations.status,
  expiresAt: businessInvitations.expiresAt,
  createdAt: businessInvitations.createdAt,
  lastSentAt: businessInvitations.lastSentAt,
  sendCount: businessInvitations.sendCount,
  createdBy: businessInvitations.createdBy,
  requestHash: businessInvitations.requestHash,
  tokenHash: businessInvitations.tokenHash,
  invitedBy: sql<string | null>`(
    select m.display_name from ${businessMembers} m
    where m.business_id = ${businessInvitations.businessId}
      and m.user_id = ${businessInvitations.createdBy}
      and m.deleted_at is null
    limit 1)`,
}

type InvitationRow = {
  id: string
  email: string
  roleId: string
  roleName: string | null
  roleTemplateKey: string | null
  locale: string
  status: string
  expiresAt: Date
  createdAt: Date
  lastSentAt: Date | null
  sendCount: number
  createdBy: string
  requestHash: string | null
  tokenHash: string
  invitedBy: string | null
}

function toInvitationDto(row: InvitationRow): InvitationDto {
  return {
    id: row.id,
    email: row.email,
    roleId: row.roleId,
    roleName: row.roleName ?? '',
    roleTemplateKey: row.roleTemplateKey,
    locale: isLocale(row.locale) ? row.locale : 'ar',
    status: row.expiresAt.getTime() <= Date.now() ? 'expired' : 'pending',
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    lastSentAt: row.lastSentAt?.toISOString() ?? null,
    resendsLeft: Math.max(0, INVITATION_MAX_RESENDS + 1 - row.sendCount),
    invitedBy: row.invitedBy,
  }
}

function invitationsQuery(tx: Tx) {
  return tx
    .select(invitationColumns)
    .from(businessInvitations)
    .leftJoin(
      roles,
      and(
        eq(roles.businessId, businessInvitations.businessId),
        eq(roles.id, businessInvitations.roleId),
        isNull(roles.deletedAt),
      ),
    )
}

async function findInvitation(
  tx: Tx,
  businessId: string,
  id: string,
  { lock }: { lock: boolean },
): Promise<InvitationRow | undefined> {
  const where = and(
    eq(businessInvitations.businessId, businessId),
    eq(businessInvitations.id, id),
    isNull(businessInvitations.deletedAt),
  )
  if (lock) {
    // Lock the invitation alone (FOR UPDATE cannot name a schema-qualified table), then read it.
    const [locked] = await tx
      .select({ id: businessInvitations.id })
      .from(businessInvitations)
      .where(where)
      .for('update')
    if (!locked) return undefined
  }
  const [row] = await invitationsQuery(tx).where(where)
  return row
}

/** `invitation.list` (settings.members.view): pending invitations, expired ones included. */
export async function listInvitations(ctx: BusinessCtx): Promise<InvitationDto[]> {
  const rows = await ctx.tx((tx) =>
    invitationsQuery(tx)
      .where(
        and(
          eq(businessInvitations.businessId, ctx.businessId),
          eq(businessInvitations.status, 'pending'),
          isNull(businessInvitations.deletedAt),
        ),
      )
      .orderBy(desc(businessInvitations.createdAt), desc(businessInvitations.id)),
  )
  return rows.map(toInvitationDto)
}

/** The permission keys a role grants (none for the Owner role, whose permissions are implicit). */
async function roleKeys(tx: Tx, businessId: string, roleId: string): Promise<string[]> {
  const rows = await tx
    .select({ key: rolePermissions.permissionKey })
    .from(rolePermissions)
    .where(
      and(
        eq(rolePermissions.businessId, businessId),
        eq(rolePermissions.roleId, roleId),
        isNull(rolePermissions.deletedAt),
      ),
    )
  return rows.map((row) => row.key)
}

/**
 * The role an invitation may carry: any role of the business except the Owner role
 * (OWNER_TRANSFER_REQUIRED), and none granting more than the caller holds (FORBIDDEN).
 */
async function assertInvitableRole(
  tx: Tx,
  ctx: BusinessCtx,
  roleId: string,
): Promise<{ name: string; templateKey: string | null }> {
  const [role] = await tx
    .select({ name: roles.name, templateKey: roles.templateKey })
    .from(roles)
    .where(and(eq(roles.businessId, ctx.businessId), eq(roles.id, roleId), isNull(roles.deletedAt)))
  if (!role) throw new AppError('not_found', { message: 'no such role' })
  if (role.templateKey === OWNER_TEMPLATE_KEY) throw new AppError('owner_transfer_required')
  if (!canGrant(ctx.access, await roleKeys(tx, ctx.businessId, roleId))) {
    throw new AppError('forbidden', { message: 'cannot invite with more access than your own' })
  }
  return role
}

/** The invitation email for a new token (built inside the transaction, sent after it commits). */
async function invitationMessage(
  tx: Tx,
  ctx: BusinessCtx,
  invitation: { email: string; locale: Locale; roleName: string; roleTemplateKey: string | null },
  token: string,
): Promise<EmailMessage> {
  const [business] = await tx
    .select({ legalName: businesses.legalName })
    .from(businesses)
    .where(eq(businesses.id, ctx.businessId))
  const [inviter] = await tx
    .select({ displayName: businessMembers.displayName })
    .from(businessMembers)
    .where(
      and(
        eq(businessMembers.businessId, ctx.businessId),
        eq(businessMembers.id, ctx.access.memberId),
      ),
    )
  const i18n = createI18n({ locale: invitation.locale, namespaces: [] })
  const roleLabel =
    invitation.roleTemplateKey !== null && isRoleTemplateKey(invitation.roleTemplateKey)
      ? i18n.t(`common.roles.${invitation.roleTemplateKey}` as I18nKey)
      : invitation.roleName
  const link = `${ctx.config.appUrl.replace(/\/+$/, '')}/invite/${token}`
  return invitationEmail({
    locale: invitation.locale,
    to: invitation.email,
    businessName: business?.legalName ?? '',
    inviterName: inviter?.displayName ?? null,
    roleLabel,
    link,
  })
}

/**
 * `invitation.create` (settings.members.manage): invites an email with a role and emails the link.
 * Idempotent on the client's id: the same payload again returns the invitation without a second
 * email; another payload, or an id used elsewhere, is CONFLICT. ALREADY_MEMBER for an active
 * member's email, ALREADY_INVITED when the email has a pending invitation, RATE_LIMITED over a
 * database limit. The team capability is checked again with the business row locked, so turning the
 * team off cannot race an invitation. The email goes out after the commit; when it cannot be sent the
 * invitation is revoked (nobody got its link; it still counts toward the limits) and the call fails.
 */
export async function createInvitation(
  ctx: BusinessCtx,
  input: CreateInvitationInput,
): Promise<InvitationDto> {
  const email = input.email.trim().toLowerCase()
  const requestHash = createHash('sha256')
    .update(JSON.stringify({ email, roleId: input.roleId, locale: input.locale }))
    .digest('hex')
  const created = await ctx.tx(async (tx) => {
    const existing = await findInvitation(tx, ctx.businessId, input.id, { lock: false })
    if (existing) {
      // A retry of this create: the invitation as it is (no second email). Once accepted or revoked
      // the id is used up.
      if (
        existing.createdBy === ctx.auth.userId &&
        existing.requestHash === requestHash &&
        existing.status === 'pending'
      ) {
        return { dto: toInvitationDto(existing), message: null }
      }
      throw new AppError('conflict', { message: 'invitation id already used' })
    }

    await tx
      .select({ id: businesses.id })
      .from(businesses)
      .where(eq(businesses.id, ctx.businessId))
      .for('share')
    const [team] = await tx
      .select({ enabled: businessCapabilities.enabled })
      .from(businessCapabilities)
      .where(
        and(
          eq(businessCapabilities.businessId, ctx.businessId),
          eq(businessCapabilities.key, 'has_team'),
          isNull(businessCapabilities.deletedAt),
        ),
      )
    if (!team?.enabled) throw new AppError('capability_disabled')

    const role = await assertInvitableRole(tx, ctx, input.roleId)

    const [member] = await tx
      .select({ id: businessMembers.id })
      .from(businessMembers)
      .where(
        and(
          eq(businessMembers.businessId, ctx.businessId),
          sql`lower(${businessMembers.email}::text) = ${email}`,
          eq(businessMembers.status, 'active'),
          isNull(businessMembers.deletedAt),
        ),
      )
      .limit(1)
    if (member) throw new AppError('already_member')
    const [pending] = await tx
      .select({ id: businessInvitations.id })
      .from(businessInvitations)
      .where(
        and(
          eq(businessInvitations.businessId, ctx.businessId),
          sql`lower(${businessInvitations.email}::text) = ${email}`,
          eq(businessInvitations.status, 'pending'),
          isNull(businessInvitations.deletedAt),
        ),
      )
      .limit(1)
    if (pending) throw new AppError('already_invited')

    const { token, hash } = newToken()
    try {
      await tx.insert(businessInvitations).values({
        id: input.id,
        businessId: ctx.businessId,
        email,
        tokenHash: hash,
        expiresAt: expiresAt(),
        status: 'pending',
        roleId: input.roleId,
        locale: input.locale,
        sendCount: 1,
        lastSentAt: sql`now()`,
        requestHash,
      })
    } catch (error) {
      // A concurrent invitation for the same email (the one-pending-per-email index).
      if (constraintOf(error) === 'business_invitations_one_pending_key') {
        throw new AppError('already_invited', { cause: error })
      }
      throw error
    }
    const message = await invitationMessage(
      tx,
      ctx,
      { email, locale: input.locale, roleName: role.name, roleTemplateKey: role.templateKey },
      token,
    )
    const saved = await findInvitation(tx, ctx.businessId, input.id, { lock: false })
    if (!saved) throw new AppError('internal', { message: 'invitation missing after insert' })
    return { dto: toInvitationDto(saved), message }
  })

  if (created.message) {
    try {
      await ctx.email.send(created.message)
    } catch (error) {
      // Nobody got this link: cancel the invitation (best effort) and report the failure.
      await ctx
        .tx((tx) =>
          tx
            .update(businessInvitations)
            .set({ status: 'revoked' })
            .where(
              and(
                eq(businessInvitations.businessId, ctx.businessId),
                eq(businessInvitations.id, input.id),
                eq(businessInvitations.status, 'pending'),
              ),
            ),
        )
        .catch(() => undefined)
      throw error
    }
  }
  return created.dto
}

/**
 * `invitation.resend` (settings.members.manage): a new link (new token, new expiry) by email, at most
 * INVITATION_MAX_RESENDS times per invitation (RATE_LIMITED); also for an expired invitation. The
 * email goes out after the commit: when it cannot be sent the call fails and the new link reached
 * nobody (the old one no longer works; "send again" is still possible while resends are left).
 */
export async function resendInvitation(
  ctx: BusinessCtx,
  input: InvitationIdInput,
): Promise<InvitationDto> {
  const resent = await ctx.tx(async (tx) => {
    const invitation = await findInvitation(tx, ctx.businessId, input.id, { lock: true })
    if (!invitation || invitation.status !== 'pending') throw new AppError('not_found')
    const role = await assertInvitableRole(tx, ctx, invitation.roleId)
    if (invitation.sendCount >= INVITATION_MAX_RESENDS + 1) throw new AppError('rate_limited')
    const { token, hash } = newToken()
    await tx
      .update(businessInvitations)
      .set({
        tokenHash: hash,
        expiresAt: expiresAt(),
        sendCount: sql`${businessInvitations.sendCount} + 1`,
        lastSentAt: sql`now()`,
      })
      .where(
        and(
          eq(businessInvitations.businessId, ctx.businessId),
          eq(businessInvitations.id, invitation.id),
        ),
      )
    const message = await invitationMessage(
      tx,
      ctx,
      {
        email: invitation.email,
        locale: isLocale(invitation.locale) ? invitation.locale : 'ar',
        roleName: role.name,
        roleTemplateKey: role.templateKey,
      },
      token,
    )
    const saved = await findInvitation(tx, ctx.businessId, invitation.id, { lock: false })
    if (!saved) throw new AppError('internal', { message: 'invitation missing after resend' })
    return { dto: toInvitationDto(saved), message }
  })
  await ctx.email.send(resent.message)
  return resent.dto
}

/**
 * `invitation.revoke` (settings.members.manage): the link stops working. Like sending, cancelling is
 * only for invitations whose role grants nothing beyond the caller's own access (FORBIDDEN).
 * Revoking a revoked invitation again is fine; an accepted one is CONFLICT.
 */
export async function revokeInvitation(ctx: BusinessCtx, input: InvitationIdInput): Promise<OkDto> {
  await ctx.tx(async (tx) => {
    const invitation = await findInvitation(tx, ctx.businessId, input.id, { lock: true })
    if (!invitation) throw new AppError('not_found')
    if (!canGrant(ctx.access, await roleKeys(tx, ctx.businessId, invitation.roleId))) {
      throw new AppError('forbidden', { message: 'cannot cancel an invitation beyond your access' })
    }
    if (invitation.status === 'revoked') return
    if (invitation.status !== 'pending') {
      throw new AppError('conflict', { message: `invitation is ${invitation.status}` })
    }
    await tx
      .update(businessInvitations)
      .set({ status: 'revoked' })
      .where(
        and(
          eq(businessInvitations.businessId, ctx.businessId),
          eq(businessInvitations.id, invitation.id),
        ),
      )
  })
  return { ok: true }
}

/**
 * Revokes the pending invitations sent by `userId` in the business (they are leaving or being
 * removed). Runs as a member who is still active in the business.
 */
export async function revokeInvitationsSentBy(
  tx: Tx,
  businessId: string,
  userId: string,
): Promise<void> {
  await tx
    .update(businessInvitations)
    .set({ status: 'revoked' })
    .where(
      and(
        eq(businessInvitations.businessId, businessId),
        eq(businessInvitations.createdBy, userId),
        eq(businessInvitations.status, 'pending'),
        isNull(businessInvitations.deletedAt),
      ),
    )
}

/**
 * After a change of roles or members: revokes every pending invitation that its sender could not send
 * now (they are no longer an active member, may no longer invite, or its role grants more than they
 * hold). A removed or demoted member's invitations therefore stop working, like their own access.
 * app.accept_invitation checks the sender again when the invitation is accepted.
 */
export async function revokeInvitationsBeyondSenders(tx: Tx, businessId: string): Promise<void> {
  const pending = await tx
    .select({
      id: businessInvitations.id,
      createdBy: businessInvitations.createdBy,
      roleId: businessInvitations.roleId,
    })
    .from(businessInvitations)
    .where(
      and(
        eq(businessInvitations.businessId, businessId),
        eq(businessInvitations.status, 'pending'),
        isNull(businessInvitations.deletedAt),
      ),
    )
  if (pending.length === 0) return
  const senders = new Map<string, BusinessAccess | null>()
  const keysOf = new Map<string, string[]>()
  const beyond: string[] = []
  for (const invitation of pending) {
    if (!senders.has(invitation.createdBy)) {
      senders.set(
        invitation.createdBy,
        await loadBusinessAccess(tx, invitation.createdBy, businessId),
      )
    }
    const sender = senders.get(invitation.createdBy) ?? null
    let keys = keysOf.get(invitation.roleId)
    if (!keys) {
      keys = await roleKeys(tx, businessId, invitation.roleId)
      keysOf.set(invitation.roleId, keys)
    }
    if (!sender || !can(sender.effective, 'settings.members.manage') || !canGrant(sender, keys)) {
      beyond.push(invitation.id)
    }
  }
  if (beyond.length === 0) return
  await tx
    .update(businessInvitations)
    .set({ status: 'revoked' })
    .where(
      and(
        eq(businessInvitations.businessId, businessId),
        inArray(businessInvitations.id, beyond),
        eq(businessInvitations.status, 'pending'),
      ),
    )
}

interface PreviewRow extends Record<string, unknown> {
  business_name: string
  inviter_name: string | null
  role_name: string | null
  role_template_key: string | null
  masked_email: string
  expires_at: Date | string
  expired: boolean
  email_matches: boolean | null
}

/**
 * `invitation.preview` (public): what the invitation page shows, signed in or not. A token of the wrong
 * shape, unknown, used, revoked or of a deleted business is INVITATION_INVALID (one answer); an
 * expired one is shown as expired. At most 30 previews per invitation per hour (RATE_LIMITED).
 */
export async function previewInvitation(
  ctx: Context,
  input: InvitationTokenInput,
): Promise<InvitationPreviewDto> {
  if (!TOKEN_PATTERN.test(input.token)) throw new AppError('invitation_invalid')
  const run = async (tx: Tx) =>
    (await tx.execute(
      sql`select * from app.preview_invitation(${input.token})`,
    )) as unknown as PreviewRow[]
  const auth = await ctx.getAuth()
  const [row] = auth ? await ctx.tenantTx(null, run) : await ctx.anonymousTx(run)
  if (!row) throw new AppError('invitation_invalid')
  return {
    businessName: row.business_name,
    inviterName: row.inviter_name,
    roleName: row.role_name,
    roleTemplateKey: row.role_template_key,
    maskedEmail: row.masked_email,
    expiresAt: new Date(row.expires_at).toISOString(),
    expired: row.expired,
    emailMatches: row.email_matches,
  }
}

/**
 * `invitation.accept` (authed): joins the business through app.accept_invitation (INVITATION_INVALID
 * for any problem with the token, its email, its sender or its role; ALREADY_MEMBER for an active
 * member) and makes it the caller's last business, where the app goes next.
 */
export async function acceptInvitation(
  ctx: Context,
  auth: AuthUser,
  input: InvitationTokenInput,
): Promise<AcceptInvitationDto> {
  if (!TOKEN_PATTERN.test(input.token)) throw new AppError('invitation_invalid')
  const businessId = await ctx.tenantTx(null, async (tx) => {
    // The new membership takes the profile's name (created here if this is the first request).
    await ensureProfile(tx, auth)
    const [row] = (await tx.execute(
      sql`select app.accept_invitation(${input.token}, ${newId()}) as business_id`,
    )) as unknown as { business_id: string }[]
    if (!row) throw new AppError('invitation_invalid')
    await tx
      .update(profiles)
      .set({ lastBusinessId: row.business_id })
      .where(and(eq(profiles.id, auth.userId), isNull(profiles.anonymizedAt)))
    return row.business_id
  })
  return { businessId }
}

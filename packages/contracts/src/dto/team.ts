import { MEMBER_KINDS, MEMBER_STATUSES } from '@bizcost/domain'
import { z } from 'zod'
import { LOCATION_NAME_MAX_LENGTH } from '../business'
import { zUuid } from '../primitives'
import { CONTROL_CHARACTER } from '../text'
import { localeDto } from './me'

// Settings → Locations, Team (members and invitations) and Roles (ROADMAP.md Step 6). Timestamps are
// ISO strings.

const isoTimestamp = z.iso.datetime({ offset: true })

/** Nothing to return but success. */
export const okDto = z.object({ ok: z.literal(true) })
export type OkDto = z.infer<typeof okDto>

// ---------------------------------------------------------------------------------------------------
// Locations (capability multi_location; settings.locations.manage)
// ---------------------------------------------------------------------------------------------------

/** 1–100 characters after trimming, one line. */
export const locationNameInput = z
  .string()
  .trim()
  .min(1)
  .max(LOCATION_NAME_MAX_LENGTH)
  .refine((value) => !CONTROL_CHARACTER.test(value), { message: 'control character' })

export const locationDto = z.object({
  id: zUuid,
  name: z.string(),
  /** The main location: exactly one per business; it cannot be removed. */
  isDefault: z.boolean(),
  version: z.int().positive(),
})
export type LocationDto = z.infer<typeof locationDto>

export const locationListDto = z.array(locationDto)

/** `location.create`: `id` is a client UUIDv7, so a retry with the same name returns the location. */
export const createLocationInput = z.object({ id: zUuid, name: locationNameInput })
export type CreateLocationInput = z.input<typeof createLocationInput>

/** `location.rename`: `version` as read (another change in between is CONFLICT). */
export const renameLocationInput = z.object({
  id: zUuid,
  name: locationNameInput,
  version: z.int().positive(),
})
export type RenameLocationInput = z.input<typeof renameLocationInput>

/** `location.setDefault` / `location.remove`. */
export const locationIdInput = z.object({ id: zUuid })
export type LocationIdInput = z.input<typeof locationIdInput>

// ---------------------------------------------------------------------------------------------------
// Members (capability has_team; settings.members.view / settings.members.manage)
// ---------------------------------------------------------------------------------------------------

export const memberDto = z.object({
  id: zUuid,
  /** The name co-members see (business_members.display_name). */
  displayName: z.string(),
  /** The email the member joined with; null for staff without a login (pin_only). */
  email: z.string().nullable(),
  kind: z.enum(MEMBER_KINDS),
  status: z.enum(MEMBER_STATUSES),
  roleId: zUuid,
  roleName: z.string(),
  /** roles.template_key; null for a custom role. */
  roleTemplateKey: z.string().nullable(),
  isOwner: z.boolean(),
  /** The caller's own membership. */
  isYou: z.boolean(),
  joinedAt: isoTimestamp,
})
export type MemberDto = z.infer<typeof memberDto>

/** `member.list`: active and suspended members (removed ones are left out), owners first. */
export const memberListDto = z.array(memberDto)

/** `member.changeRole`: any role except the Owner role (ownership moves only by a transfer). */
export const changeMemberRoleInput = z.object({ memberId: zUuid, roleId: zUuid })
export type ChangeMemberRoleInput = z.input<typeof changeMemberRoleInput>

/** `member.remove` / `member.transferOwnership`. */
export const memberIdInput = z.object({ memberId: zUuid })
export type MemberIdInput = z.input<typeof memberIdInput>

// ---------------------------------------------------------------------------------------------------
// Invitations (capability has_team; settings.members.view / settings.members.manage)
// ---------------------------------------------------------------------------------------------------

/** An email address, trimmed and lowercased. */
export const invitationEmailInput = z.string().trim().toLowerCase().max(254).pipe(z.email())

export const invitationDto = z.object({
  id: zUuid,
  email: z.string(),
  roleId: zUuid,
  roleName: z.string(),
  roleTemplateKey: z.string().nullable(),
  /** Language of the email. */
  locale: localeDto,
  /** `expired`: still pending, but its link no longer works (resend it for a new link). */
  status: z.enum(['pending', 'expired']),
  expiresAt: isoTimestamp,
  createdAt: isoTimestamp,
  lastSentAt: isoTimestamp.nullable(),
  /** Resends left (INVITATION_MAX_RESENDS per invitation). */
  resendsLeft: z.int().nonnegative(),
  /** The name of the member who sent it (null when that membership is gone). */
  invitedBy: z.string().nullable(),
})
export type InvitationDto = z.infer<typeof invitationDto>

/** `invitation.list`: pending invitations (including expired ones), newest first. */
export const invitationListDto = z.array(invitationDto)

/**
 * `invitation.create`: `id` is a client UUIDv7 (a retry with the same payload returns the invitation
 * without emailing again); `locale` is the email's language (default: the business language). The
 * role may be any role except the Owner role.
 */
export const createInvitationInput = z.object({
  id: zUuid,
  email: invitationEmailInput,
  roleId: zUuid,
  locale: localeDto,
})
export type CreateInvitationInput = z.input<typeof createInvitationInput>

/** `invitation.resend` / `invitation.revoke`. */
export const invitationIdInput = z.object({ id: zUuid })
export type InvitationIdInput = z.input<typeof invitationIdInput>

/** `invitation.preview` / `invitation.accept`: the raw token from the link. */
export const invitationTokenInput = z.object({ token: z.string().min(1).max(200) })
export type InvitationTokenInput = z.input<typeof invitationTokenInput>

/**
 * `invitation.preview` (public): what the invitation page shows. The invited email is masked
 * (r•••@example.com); `emailMatches` is null when signed out, else whether the caller's verified
 * email is the invited one.
 */
export const invitationPreviewDto = z.object({
  businessName: z.string(),
  /** The inviter's name in that business; null when it is not known any more. */
  inviterName: z.string().nullable(),
  roleName: z.string().nullable(),
  roleTemplateKey: z.string().nullable(),
  maskedEmail: z.string(),
  expiresAt: isoTimestamp,
  expired: z.boolean(),
  emailMatches: z.boolean().nullable(),
})
export type InvitationPreviewDto = z.infer<typeof invitationPreviewDto>

/** `invitation.accept` (authed): the business the caller joined. */
export const acceptInvitationDto = z.object({ businessId: zUuid })
export type AcceptInvitationDto = z.infer<typeof acceptInvitationDto>

// ---------------------------------------------------------------------------------------------------
// Roles (capability has_team; settings.roles.manage)
// ---------------------------------------------------------------------------------------------------

export const roleDto = z.object({
  id: zUuid,
  name: z.string(),
  /** roles.template_key; null for a custom role. */
  templateKey: z.string().nullable(),
  /** The Owner role: every permission, now and later; read-only. */
  isOwner: z.boolean(),
  /** Granted permission keys, sorted (empty for the Owner, whose permissions are implicit). */
  permissionKeys: z.array(z.string()),
  /** Active and suspended members holding the role. */
  memberCount: z.int().nonnegative(),
  version: z.int().positive(),
})
export type RoleDto = z.infer<typeof roleDto>

/** `role.list`: Owner first, then the templates in their order, then custom roles by name. */
export const roleListDto = z.array(roleDto)

/**
 * `role.updatePermissions`: the full set of keys the role grants (from the permission catalog).
 * Not the Owner role. Members with the role get their permissions on their next request.
 */
export const updateRolePermissionsInput = z.object({
  id: zUuid,
  version: z.int().positive(),
  permissionKeys: z.array(z.string().min(1).max(80)).max(200),
})
export type UpdateRolePermissionsInput = z.input<typeof updateRolePermissionsInput>

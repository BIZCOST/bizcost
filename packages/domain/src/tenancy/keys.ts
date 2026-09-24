// Stored keys and enum values of the tenancy tables (docs/DATA_MODEL.md §4). The database CHECK
// constraints list the same values; pure code (permission engine, contracts) reads them from here.

/** Role template key whose members hold every permission (implicit; no role_permissions rows). */
export const OWNER_TEMPLATE_KEY = 'owner'

/** `account` members sign in with an auth user; `pin_only` staff have none. */
export const MEMBER_KINDS = ['account', 'pin_only'] as const
export type MemberKind = (typeof MEMBER_KINDS)[number]

export const MEMBER_STATUSES = ['invited', 'active', 'suspended', 'removed'] as const
export type MemberStatus = (typeof MEMBER_STATUSES)[number]

/** Per-member permission override: grants or removes one permission of the member's role. */
export const PERMISSION_EFFECTS = ['allow', 'deny'] as const
export type PermissionEffect = (typeof PERMISSION_EFFECTS)[number]

export const INVITATION_STATUSES = ['pending', 'accepted', 'revoked', 'expired'] as const
export type InvitationStatus = (typeof INVITATION_STATUSES)[number]

/** Who set a capability: Smart Setup or the user in settings. */
export const CAPABILITY_SOURCES = ['setup', 'user'] as const
export type CapabilitySource = (typeof CAPABILITY_SOURCES)[number]

/** `profiles.locale` and `businesses.default_locale`. */
export const LOCALES = ['en', 'ar'] as const
export type Locale = (typeof LOCALES)[number]

export function isLocale(value: unknown): value is Locale {
  return (LOCALES as readonly unknown[]).includes(value)
}

/** audit_log.action, written by the database audit trigger. */
export const AUDIT_ACTIONS = ['insert', 'update', 'delete'] as const
export type AuditAction = (typeof AUDIT_ACTIONS)[number]

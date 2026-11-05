// The closed beta's words between the app, the Auth hook and the API. No Zod here, so the sign-up
// page's bundle does not take the API schemas.

/**
 * The beta terms and privacy policy in force (D-358): stored with the time a person accepted them, and
 * asked again when it changes. Change it when /terms or /privacy change in substance.
 */
export const LEGAL_VERSION = '2026-11-05-beta'

/**
 * Where the sign-up form puts the version the person ticked, in Auth's user_metadata: `me` copies it
 * to the profile when it makes one (the person has no session until the code).
 */
export const LEGAL_METADATA_KEY = 'terms_version'

/**
 * The message of the Auth hook's refusal (supabase/migrations: auth_hooks.before_user_created). Auth
 * has no code of its own for it (it says `unknown`), so this is what the app reads.
 */
export const BETA_REFUSED_MESSAGE = 'beta_invite_only'

/** Where a refused person asks for access, and how to reach the operator (D-355, D-358). */
export const SUPPORT_EMAIL = 'support@bizcost.ae'

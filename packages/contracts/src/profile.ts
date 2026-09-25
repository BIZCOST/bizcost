// Profile limits shared by the API (dto/account.ts) and the app forms (@bizcost/app-core). No Zod
// here, so a client that needs only the numbers does not bundle the API schemas.

/** Longest display name (profiles.display_name), in characters after trimming. */
export const PROFILE_DISPLAY_NAME_MAX_LENGTH = 80

/** Shown instead of the name once an account is deleted (the profile is anonymized, never removed). */
export const DELETED_USER_DISPLAY_NAME = 'Deleted user'

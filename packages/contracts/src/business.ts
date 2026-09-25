// Business limits shared by the API (dto/business-setup.ts) and the app forms. No Zod here, so a
// client that needs only the numbers does not bundle the API schemas.

/** Longest business name (businesses.legal_name from Smart Setup), in characters after trimming. */
export const BUSINESS_NAME_MAX_LENGTH = 100

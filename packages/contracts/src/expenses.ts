// Limits of Expenses and Running Costs (M2 Step 5), shared by the API (dto/expenses.ts) and the app
// forms. No Zod here, so a client that needs only the numbers does not bundle the API schemas. The
// database CHECKs hold the same lengths (packages/db schema/expenses.ts). References, notes, payment
// notes and page sizes are those of purchases (purchasing.ts).

/** Longest category name (the catalog's). */
export const COST_CATEGORY_NAME_MAX_LENGTH = 100

/** Longest "what it was for" of an expense. */
export const EXPENSE_DESCRIPTION_MAX_LENGTH = 200

/** Longest reason given when an expense is rejected. */
export const REJECTION_REASON_MAX_LENGTH = 500

/** Longest running-cost name. */
export const RUNNING_COST_NAME_MAX_LENGTH = 100

// Limits of Stock (M4 Step 2): stock on hand, the stock card and counts, shared by the API
// (dto/stock.ts) and the app forms. No Zod here, so a client that needs only the numbers does not
// bundle the API schemas. The database CHECKs hold the same lengths (packages/db schema/stock.ts).

/** Most lines one count may have (materials × branches for a first count). */
export const STOCK_COUNT_LINES_MAX = 1000

/** Most parts one counted line may be typed in ("3 cartons + 4 bottles" is two). */
export const COUNT_PARTS_MAX = 10

/** Longest note of a count. */
export const STOCK_COUNT_NOTE_MAX_LENGTH = 500

/** Materials per page of the stock list and of "Start tracking": the default, and the most. */
export const STOCK_PAGE_SIZE = 50
export const STOCK_PAGE_SIZE_MAX = 100

/** Movements per page of a stock card: the default, and the most. */
export const STOCK_CARD_PAGE_SIZE = 50
export const STOCK_CARD_PAGE_SIZE_MAX = 200

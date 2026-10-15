// Limits of Sales (M3 Step 2), shared by the API (dto/sales.ts) and the app forms. No Zod here, so a
// client that needs only the numbers does not bundle the API schemas. The database CHECKs hold the
// same lengths (packages/db schema/sales.ts).

/** Longest name of a sales channel. */
export const SALES_CHANNEL_NAME_MAX_LENGTH = 100

/** Longest text of a sale line (an item copies its product's name; delivery its own text). */
export const SALE_LINE_DESCRIPTION_MAX_LENGTH = 200

/** Longest delivery area of a sale. */
export const DELIVERY_AREA_MAX_LENGTH = 200

/** Most lines on one sale: a day sheet lists what the member sold that day, one line a product. */
export const SALE_LINES_MAX = 300

/** Most products a day sheet lists (the branch's products, not archived). */
export const DAY_SHEET_PRODUCTS_MAX = 1000

/** Days of the member's own sales that order the day sheet's products (the most sold first). */
export const DAY_SHEET_ORDER_DAYS = 30

/** Most branches a member may be limited to (a business has fewer locations). */
export const MEMBER_LOCATIONS_MAX = 100

/** Most rows one `saleImport.addRows` carries (2,500: fewer calls for a big file, D-261). */
export const IMPORT_ROWS_CHUNK = 2500

/** Most staged rows (day × item totals) one import may have. */
export const IMPORT_ROWS_MAX = 100_000

/** Longest file name kept for an import. */
export const IMPORT_FILE_NAME_MAX_LENGTH = 255

/** Longest item name read from a file (a name and its variant together). */
export const IMPORT_NAME_MAX_LENGTH = 300

/** Longest item code read from a file. */
export const IMPORT_CODE_MAX_LENGTH = 100

/** Most answers one `saleImport.match` saves. */
export const IMPORT_ANSWERS_MAX = 1000

/** Longest header text kept in a mapping. */
export const IMPORT_HEADER_MAX_LENGTH = 200

/** Imports listed per page. */
export const IMPORT_PAGE_SIZE = 20

/** Longest notes of a channel statement. */
export const STATEMENT_NOTES_MAX_LENGTH = 1000

// Limits and choices of the Product costs page (M2 Step 6), shared by the API (dto/product-costs.ts)
// and the app. No Zod here, so a client that needs only the values does not bundle the API schemas.

/** Rows per page of the Product costs list: the default, and the most a client may ask for. */
export const PRODUCT_COST_PAGE_SIZE = 50
export const PRODUCT_COST_PAGE_SIZE_MAX = 100

/**
 * What the Product costs list is sorted by. `name` and `price` (not sensitive) for every member who
 * sees the page; `cost` needs costs visible, `margin` and `margin_percent` margins (FORBIDDEN
 * otherwise, never a silent ignore: a sort on a hidden value would reveal it).
 */
export const PRODUCT_COST_SORTS = ['name', 'price', 'cost', 'margin', 'margin_percent'] as const
export type ProductCostSort = (typeof PRODUCT_COST_SORTS)[number]

/**
 * Filters of the Product costs list: `incomplete` (something of its cost is missing: needs costs
 * visible) and `loss` (the price before VAT does not cover the cost: needs margins visible).
 */
export const PRODUCT_COST_FILTERS = ['incomplete', 'loss'] as const
export type ProductCostFilter = (typeof PRODUCT_COST_FILTERS)[number]

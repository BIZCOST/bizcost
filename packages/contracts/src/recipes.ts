// Limits of recipes and product costs (M2 Step 4), shared by the API (dto/recipes.ts) and the app
// forms. No Zod here, so a client that needs only the numbers does not bundle the API schemas.

/** Most lines one recipe may have (one per material). */
export const RECIPE_LINES_MAX = 60

/** Products one `product.costs` call may ask for (a page of the products list). */
export const PRODUCT_COSTS_MAX = 100

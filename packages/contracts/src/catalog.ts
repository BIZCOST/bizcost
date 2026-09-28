// Limits of Materials and Products & Services (M2 Step 2), shared by the API (dto/catalog.ts) and the
// app forms. No Zod here, so a client that needs only the numbers does not bundle the API schemas.
// The database CHECKs hold the same name lengths (packages/db schema/catalog.ts).

/** Longest material, product or service name, in characters after trimming. */
export const CATALOG_NAME_MAX_LENGTH = 100

/** Longest description of a product or service. */
export const PRODUCT_DESCRIPTION_MAX_LENGTH = 1000

/** Longest pack name ("carton", "bottle"). */
export const PACK_NAME_MAX_LENGTH = 50

/** Most packs one material may have. */
export const MATERIAL_PACKS_MAX = 10

/** Most cross factors one material may have: one per other dimension (six dimensions). */
export const MATERIAL_CROSS_FACTORS_MAX = 5

/** Longest search text of a list. */
export const CATALOG_SEARCH_MAX_LENGTH = 100

/** Rows per page of a list: the default, and the most a client may ask for. */
export const CATALOG_PAGE_SIZE = 50
export const CATALOG_PAGE_SIZE_MAX = 100

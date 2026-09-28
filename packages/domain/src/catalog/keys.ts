// Stored values of the catalog tables of M2 Step 2 (docs/DATA_MODEL.md §6: materials,
// material_units, products_services). The database CHECK constraints list the same values; pure code
// (contracts, the API) reads them from here.

/** `products_services.type`: something you make or sell, or work you do. */
export const PRODUCT_TYPES = ['product', 'service'] as const
export type ProductType = (typeof PRODUCT_TYPES)[number]

/**
 * `products_services.vat_category` (D-121): how VAT applies when the business is VAT-registered.
 * `standard` charges the country's standard rate (5 % in the UAE); `zero_rated` charges 0 % (input VAT
 * stays reclaimable); `exempt` charges none (input VAT is not reclaimable). The rate itself is not
 * stored: documents copy it when they are posted.
 */
export const VAT_CATEGORIES = ['standard', 'zero_rated', 'exempt'] as const
export type VatCategory = (typeof VAT_CATEGORIES)[number]

/**
 * `material_units.kind`: a pack ("1 carton = 12 bottles", a named unit of the material) or a cross
 * factor ("1 l = 920 g", the one way to use a standard unit of another dimension). D-108, D-122.
 */
export const MATERIAL_UNIT_KINDS = ['pack', 'cross'] as const
export type MaterialUnitKind = (typeof MATERIAL_UNIT_KINDS)[number]

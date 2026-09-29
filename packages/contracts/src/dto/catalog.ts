import {
  checkDecimal,
  compareDecimal,
  DIMENSIONS,
  isValidFactor,
  PRODUCT_TYPES,
  STANDARD_UNITS,
  VAT_CATEGORIES,
  type StandardUnit,
} from '@bizcost/domain'
import { z } from 'zod'
import {
  CATALOG_NAME_MAX_LENGTH,
  CATALOG_PAGE_SIZE,
  CATALOG_PAGE_SIZE_MAX,
  CATALOG_SEARCH_MAX_LENGTH,
  MATERIAL_CROSS_FACTORS_MAX,
  MATERIAL_PACKS_MAX,
  PACK_NAME_MAX_LENGTH,
  PRODUCT_DESCRIPTION_MAX_LENGTH,
} from '../catalog'
import { zDecimal, zUuid } from '../primitives'
import { cleanName, CONTROL_CHARACTER, hasVisibleCharacter } from '../text'

// Materials and Products & Services (ROADMAP.md M2 Step 2; docs/DATA_MODEL.md §6, D-121–D-123).
// Decimals are strings (Arabic-Indic digits accepted), timestamps ISO strings. One name per record,
// in any language (D-113). Nothing here is sensitive: costs come with purchases (Step 3) and recipes
// (Step 4, dto/recipes.ts). An item bought ready to sell (D-117) is a product and its material,
// created together and linked: productDto.resaleMaterialId, materialDto.resaleProductId.

const isoTimestamp = z.iso.datetime({ offset: true })

/**
 * A one-line name: no control characters; stored as cleanName leaves it (invisible characters
 * removed, spaces and marks trimmed from its ends), 1–`max` characters with something to see
 * (D-131).
 */
export function nameInput(max: number) {
  return z
    .string()
    .refine((value) => !CONTROL_CHARACTER.test(value), { message: 'control character' })
    .overwrite(cleanName)
    .min(1)
    .max(max)
    .refine(hasVisibleCharacter, { message: 'nothing to see' })
}

const STANDARD_UNIT_CODES = Object.keys(STANDARD_UNITS) as [StandardUnit, ...StandardUnit[]]

/** A standard unit code: mg, g, kg, ml, l, piece, mm, cm, m, mm2, cm2, m2, s, min, h. */
export const standardUnitDto = z.enum(STANDARD_UNIT_CODES)

/** How a material is costed: its quantities and costs are kept per base unit of this dimension. */
export const dimensionDto = z.enum(DIMENSIONS)

/** A unit's quantity: more than zero, and it fits numeric(28,12). */
const factorInput = zDecimal.refine(isValidFactor, { message: 'must be more than zero' })

/** Page of a list: a search in the names, which records, and where the page starts. */
export const catalogListInput = z
  .object({
    /** Part of the name, any case (empty: everything). */
    search: z.string().trim().max(CATALOG_SEARCH_MAX_LENGTH).optional(),
    /** `active` (default), `archived`, or `all`. */
    status: z.enum(['active', 'archived', 'all']).default('active'),
    /** `nextCursor` of the previous page, as it came. */
    cursor: z.string().min(1).max(500).optional(),
    limit: z.int().min(1).max(CATALOG_PAGE_SIZE_MAX).default(CATALOG_PAGE_SIZE),
  })
  .prefault({})
export type CatalogListInput = z.input<typeof catalogListInput>

/** `material.get`, `material.archive`, `product.get`, … */
export const catalogIdInput = z.object({ id: zUuid })
export type CatalogIdInput = z.input<typeof catalogIdInput>

// ---------------------------------------------------------------------------------------------------
// Materials (module materials; materials.items.view / materials.items.manage)
// ---------------------------------------------------------------------------------------------------

/**
 * A pack: 1 <name> = qty <ofUnit | the pack ofPackId>. `id` is a client UUIDv7 (a new pack may be
 * named by another pack of the same request). Every chain ends at a standard unit without loops,
 * and a unit of another dimension needs a cross factor (validateMaterialUnits: VALIDATION).
 */
export const materialPackInput = z
  .object({
    id: zUuid,
    name: nameInput(PACK_NAME_MAX_LENGTH),
    qty: factorInput,
    ofUnit: standardUnitDto.nullish(),
    ofPackId: zUuid.nullish(),
  })
  .refine((pack) => (pack.ofUnit == null) !== (pack.ofPackId == null), {
    message: 'exactly one of ofUnit and ofPackId',
  })
export type MaterialPackInput = z.input<typeof materialPackInput>

/**
 * A cross factor: 1 <unit> = qty <ofUnit>, where `unit` is a standard unit of another dimension and
 * `ofUnit` one of the material's own ("1 l = 920 g"). At most one per other dimension.
 */
export const materialCrossFactorInput = z.object({
  id: zUuid,
  unit: standardUnitDto,
  qty: factorInput,
  ofUnit: standardUnitDto,
})
export type MaterialCrossFactorInput = z.input<typeof materialCrossFactorInput>

const materialFields = {
  name: nameInput(CATALOG_NAME_MAX_LENGTH),
  /** The unit it is counted in (kg, l, piece…); its dimension is the material's. */
  unit: standardUnitDto,
  packs: z.array(materialPackInput).max(MATERIAL_PACKS_MAX).default([]),
  crossFactors: z.array(materialCrossFactorInput).max(MATERIAL_CROSS_FACTORS_MAX).default([]),
}

/** `material.create`: `id` is a client UUIDv7, so a retry with the same payload returns it. */
export const createMaterialInput = z.object({ id: zUuid, ...materialFields })
export type CreateMaterialInput = z.input<typeof createMaterialInput>

/**
 * `material.update`: the whole material with its units, `version` as read (CONFLICT when it changed).
 * Packs and cross factors not sent are taken out; ids sent are kept or added.
 */
export const updateMaterialInput = z.object({
  id: zUuid,
  version: z.int().positive(),
  ...materialFields,
})
export type UpdateMaterialInput = z.input<typeof updateMaterialInput>

export const materialPackDto = z.object({
  id: zUuid,
  name: z.string(),
  qty: zDecimal,
  /** Exactly one of these is set. */
  ofUnit: standardUnitDto.nullable(),
  ofPackId: zUuid.nullable(),
})
export type MaterialPackDto = z.infer<typeof materialPackDto>

export const materialCrossFactorDto = z.object({
  id: zUuid,
  unit: standardUnitDto,
  qty: zDecimal,
  ofUnit: standardUnitDto,
})
export type MaterialCrossFactorDto = z.infer<typeof materialCrossFactorDto>

export const materialDto = z.object({
  id: zUuid,
  name: z.string(),
  dimension: dimensionDto,
  unit: standardUnitDto,
  /** In the order they were added. */
  packs: z.array(materialPackDto),
  crossFactors: z.array(materialCrossFactorDto),
  /**
   * The product it is sold as, when it is bought ready to sell (D-117): its name, unit and archiving
   * change with the product's. Null for anything used to make or do something.
   */
  resaleProductId: zUuid.nullable(),
  /** When it was archived (hidden from pickers); null while active. */
  archivedAt: isoTimestamp.nullable(),
  version: z.int().positive(),
})
export type MaterialDto = z.infer<typeof materialDto>

/** `material.list`: by name (case ignored); `nextCursor` null on the last page. */
export const materialListDto = z.object({
  items: z.array(materialDto),
  nextCursor: z.string().nullable(),
})
export type MaterialListDto = z.infer<typeof materialListDto>

// ---------------------------------------------------------------------------------------------------
// Products & Services (module products; products.items.view / products.items.manage)
// ---------------------------------------------------------------------------------------------------

/** A selling price: zero or more, and it fits numeric(20,4). */
const priceInput = zDecimal.refine(
  (value) => checkDecimal(value, 'money') === null && compareDecimal(value, '0') >= 0,
  { message: 'must be zero or more, with at most 4 decimals' },
)

const productFields = {
  name: nameInput(CATALOG_NAME_MAX_LENGTH),
  /** Optional; several lines are fine. */
  description: z
    .string()
    .trim()
    .max(PRODUCT_DESCRIPTION_MAX_LENGTH)
    .nullish()
    .transform((value) => (value ? value : null)),
  type: z.enum(PRODUCT_TYPES),
  /** The unit it is sold by (piece, kg, h…). */
  unit: standardUnitDto,
  /** The usual selling price per unit in the business currency; null (default) while not set. */
  defaultPrice: priceInput.nullable().default(null),
  /** VAT when the business is VAT-registered (D-121). */
  vatCategory: z.enum(VAT_CATEGORIES).default('standard'),
  /** Whether defaultPrice includes VAT (D-121). */
  priceIncludesVat: z.boolean().default(false),
  /**
   * Where it is sold (capability multi_location; CAPABILITY_DISABLED otherwise): empty = every
   * location, including ones added later.
   */
  locationIds: z
    .array(zUuid)
    .max(100)
    .default([])
    .refine((ids) => new Set(ids).size === ids.length, { message: 'duplicate location' }),
}

/**
 * "Bought ready to sell" (D-117): the product is created with its material, in one transaction, both
 * with the product's name and unit; `materialId` is the material's client UUIDv7. Its packs and cross
 * factors are the material's (how it is bought: 1 carton = 24 cans). Only for a product (not a
 * service); needs the Materials module and materials.items.manage too.
 */
export const resaleInput = z.object({
  materialId: zUuid,
  packs: z.array(materialPackInput).max(MATERIAL_PACKS_MAX).default([]),
  crossFactors: z.array(materialCrossFactorInput).max(MATERIAL_CROSS_FACTORS_MAX).default([]),
})
export type ResaleInput = z.input<typeof resaleInput>

/**
 * `product.create`: `id` is a client UUIDv7, so a retry with the same payload returns it. `resale`
 * (default null) makes it an item bought ready to sell; the link never changes afterwards.
 */
export const createProductInput = z
  .object({ id: zUuid, ...productFields, resale: resaleInput.nullable().default(null) })
  .refine((product) => product.resale === null || product.type === 'product', {
    message: 'only a product is bought ready to sell',
    path: ['resale'],
  })
export type CreateProductInput = z.input<typeof createProductInput>

/** `product.update`: the whole record, `version` as read (CONFLICT when it changed). */
export const updateProductInput = z.object({
  id: zUuid,
  version: z.int().positive(),
  ...productFields,
})
export type UpdateProductInput = z.input<typeof updateProductInput>

export const productDto = z.object({
  id: zUuid,
  name: z.string(),
  description: z.string().nullable(),
  type: z.enum(PRODUCT_TYPES),
  unit: standardUnitDto,
  defaultPrice: zDecimal.nullable(),
  vatCategory: z.enum(VAT_CATEGORIES),
  priceIncludesVat: z.boolean(),
  /** Where it is sold; empty = every location. */
  locationIds: z.array(zUuid),
  /**
   * Bought ready to sell (D-117): the material it is bought as (its cost is that material's average
   * for one unit sold; it has no recipe). Null for a product made, or a service.
   */
  resaleMaterialId: zUuid.nullable(),
  archivedAt: isoTimestamp.nullable(),
  version: z.int().positive(),
})
export type ProductDto = z.infer<typeof productDto>

/** `product.list`: by name (case ignored); `nextCursor` null on the last page. */
export const productListDto = z.object({
  items: z.array(productDto),
  nextCursor: z.string().nullable(),
})
export type ProductListDto = z.infer<typeof productListDto>

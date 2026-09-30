import {
  CATALOG_NAME_MAX_LENGTH,
  hasVisibleCharacter,
  PRODUCT_DESCRIPTION_MAX_LENGTH,
  type CreateProductInput,
  type ProductDto,
} from '@bizcost/contracts'
import type { ProductType, StandardUnit, VatCategory } from '@bizcost/domain'
import {
  checkMaterial,
  formName,
  type MaterialCheck,
  type MaterialCheckOptions,
  type MaterialDraft,
} from './material-draft'
import { readPrice, readQuantity, type FieldError } from './numbers'

// The product and service form (M2 Step 2; D-121, D-123): what the person typed, checked, and
// turned into product.create / product.update's fields. Fields a business doesn't use are hidden and
// kept as stored: VAT without VAT registration, branches without multi_location or without the right
// to see them.

export interface ProductDraft {
  readonly type: ProductType
  readonly name: string
  readonly unit: StandardUnit
  /** As typed; empty for no usual price. */
  readonly price: string
  readonly description: string
  readonly vatCategory: VatCategory
  readonly priceIncludesVat: boolean
  /** Sold everywhere, or only at `locationIds`. */
  readonly where: 'all' | 'some'
  readonly locationIds: readonly string[]
}

export interface ProductErrors {
  name?: FieldError
  price?: FieldError
  description?: FieldError
  locations?: FieldError
}

/**
 * product.create's fields (without the id and `resale`, which the form adds for an item bought ready to
 * sell); product.update adds the id and the version.
 */
export type ProductFields = Omit<CreateProductInput, 'id' | 'resale'>

/** What the business uses and the member may do, for the fields of the form. */
export interface ProductFormAccess {
  /** capability multi_location: the business has branches. */
  readonly multiLocation: boolean
  /** The member can see the branches (settings.locations.manage), so can choose them. */
  readonly canPickLocations: boolean
}

/**
 * The form's first state: a new product sold by the piece (a new service for a business that sells
 * only services, `type`, D-200), or the record as it is stored.
 */
export function productDraft(product?: ProductDto, type: ProductType = 'product'): ProductDraft {
  if (!product) {
    return {
      type,
      name: '',
      unit: 'piece',
      price: '',
      description: '',
      vatCategory: 'standard',
      priceIncludesVat: false,
      where: 'all',
      locationIds: [],
    }
  }
  return {
    type: product.type,
    name: product.name,
    unit: product.unit,
    price: product.defaultPrice ?? '',
    description: product.description ?? '',
    vatCategory: product.vatCategory,
    priceIncludesVat: product.priceIncludesVat,
    where: product.locationIds.length > 0 ? 'some' : 'all',
    locationIds: product.locationIds,
  }
}

/**
 * Every problem of the form, and the fields to send when there is none. Branches: with
 * multi_location and the right to see them, the choice made here (every branch is an empty list);
 * otherwise what is stored (`stored`), which the API keeps.
 */
export function checkProduct(
  draft: ProductDraft,
  access: ProductFormAccess,
  stored: readonly string[] = [],
): { errors: ProductErrors; fields: ProductFields | null } {
  const errors: ProductErrors = {}
  const name = formName(draft.name)
  if (!hasVisibleCharacter(name)) errors.name = { key: 'catalog.form.nameRequired' }
  else if (name.length > CATALOG_NAME_MAX_LENGTH) {
    errors.name = { key: 'catalog.form.nameTooLong', values: { count: CATALOG_NAME_MAX_LENGTH } }
  }
  const price = readPrice(draft.price)
  if (!price.ok) errors.price = price.error
  const description = draft.description.trim()
  if (description.length > PRODUCT_DESCRIPTION_MAX_LENGTH) {
    errors.description = {
      key: 'catalog.products.descriptionTooLong',
      values: { count: PRODUCT_DESCRIPTION_MAX_LENGTH },
    }
  }
  const choosing = access.multiLocation && access.canPickLocations
  if (choosing && draft.where === 'some' && draft.locationIds.length === 0) {
    errors.locations = { key: 'catalog.products.locations.pickOne' }
  }
  if (Object.values(errors).some(Boolean) || !price.ok) return { errors, fields: null }

  let locationIds: string[] = []
  if (choosing) locationIds = draft.where === 'some' ? [...draft.locationIds] : []
  else if (access.multiLocation) locationIds = [...stored]
  return {
    errors,
    fields: {
      name,
      type: draft.type,
      unit: draft.unit,
      description: description === '' ? null : description,
      defaultPrice: price.value,
      vatCategory: draft.vatCategory,
      priceIncludesVat: draft.priceIncludesVat,
      locationIds,
    },
  }
}

/**
 * The owner's minutes for one unit (M2 Step 6, D-119), as typed: empty for none (null, which clears
 * them), else more than zero with at most 6 decimals (numeric(24,6)), in either language's digits.
 * Only for a business without a team whose member sees costs; the form sends them only once changed,
 * so minutes it never showed are never cleared.
 */
export function readOwnerMinutes(
  input: string,
): { ok: true; value: string | null } | { ok: false; error: FieldError } {
  if (input.trim() === '') return { ok: true, value: null }
  return readQuantity(input)
}

/**
 * The material side of an item bought ready to sell (M2 Step 4, D-117): the packs and conversions it
 * is bought in, checked by the units engine with the product's own unit (the material's is the
 * product's). Its name is the product's, checked there, so only the units' problems count here.
 */
export function checkResaleUnits(
  product: Pick<ProductDraft, 'unit'>,
  units: Pick<MaterialDraft, 'packs' | 'crossFactors'>,
  options: MaterialCheckOptions = {},
): MaterialCheck {
  return checkMaterial(
    { name: 'resale', unit: product.unit, packs: units.packs, crossFactors: units.crossFactors },
    options,
  )
}

import {
  CATALOG_NAME_MAX_LENGTH,
  hasVisibleCharacter,
  PRODUCT_DESCRIPTION_MAX_LENGTH,
  type CreateProductInput,
  type ProductDto,
} from '@bizcost/contracts'
import type { ProductType, StandardUnit, VatCategory } from '@bizcost/domain'
import { formName } from './material-draft'
import { readPrice, type FieldError } from './numbers'

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

/** product.create's fields (without the id); product.update adds the id and the version. */
export type ProductFields = Omit<CreateProductInput, 'id'>

/** What the business uses and the member may do, for the fields of the form. */
export interface ProductFormAccess {
  /** capability multi_location: the business has branches. */
  readonly multiLocation: boolean
  /** The member can see the branches (settings.locations.manage), so can choose them. */
  readonly canPickLocations: boolean
}

/** The form's first state: a new product sold by the piece, or the record as it is stored. */
export function productDraft(product?: ProductDto): ProductDraft {
  if (!product) {
    return {
      type: 'product',
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

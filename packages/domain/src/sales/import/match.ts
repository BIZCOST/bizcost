import { keyedNames, matchKeyedNames, nameKey, type KeyedName } from '../../catalog/names'
import { headerKey } from './headers'

// Which product an imported name is (M3 Step 4, `matchName`; the owner's answer Q15 of D-218), in
// order: the answer saved for its item code (retail item codes live in the aliases: products have no
// SKU of their own; a code tells sizes of one name apart, so its answer comes first), the answer saved
// for its name, the name itself as the business reads it (nameKey, D-158), else unmatched with the 3
// closest names to offer ("Did you mean …?": matchNames; "Latte · Large" offers "Latte"). An item code
// no answer names yet never lands, by its name alone, on a product another code's answer names: that is
// another size of the name ("Juice" 250 ml answered, 500 ml new), so it waits for its own answer, the
// product offered as "Did you mean" (D-262). An alias may
// also say the name is not something the business sells, and how it counts: skipped (tips), a charge
// (a service charge: a sale with no cost) or delivery charged (the delivery margin). Product lists are
// small enough to compare in memory; their keys are worked out once per index, and "Did you mean" is
// worked out only for the names a screen shows (suggestionsFor), never to finalize.

/** What a saved answer makes of a name or a code. */
export const ALIAS_TARGETS = ['product', 'skip', 'charge', 'delivery'] as const
export type AliasTarget = (typeof ALIAS_TARGETS)[number]

/** What an alias is keyed by: a name (its nameKey) or an item code. */
export const ALIAS_KINDS = ['name', 'code'] as const
export type AliasKind = (typeof ALIAS_KINDS)[number]

/** The source the general importer saves its answers for (named POS presets come with their own). */
export const IMPORT_SOURCE_FILE = 'file'

/** The key an alias of a name is saved under. */
export const aliasKeyOfName = (name: string) => nameKey(name)
/** The key an alias of an item code is saved under (case and digits folded like names). */
export const aliasKeyOfCode = (code: string) => nameKey(code)

export interface ImportAlias {
  readonly kind: AliasKind
  readonly key: string
  readonly target: AliasTarget
  /** With `product`. */
  readonly productId: string | null
}

export interface MatchProduct {
  readonly id: string
  readonly name: string
}

export type NameMatch =
  | {
      readonly state: 'matched'
      readonly via: 'alias' | 'code' | 'name'
      readonly target: AliasTarget
      readonly productId: string | null
    }
  | { readonly state: 'unmatched'; readonly suggestions: readonly MatchProduct[] }

/** Up to this many names are offered for an unmatched one. */
export const MATCH_SUGGESTIONS = 3

/**
 * An index of the business's answers and products, so many names are matched without scanning the
 * aliases each time, and compared to the products without working out their keys again.
 */
export interface MatchIndex {
  readonly names: ReadonlyMap<string, ImportAlias>
  readonly codes: ReadonlyMap<string, ImportAlias>
  /** The products an item code's answer names. */
  readonly coded: ReadonlySet<string>
  readonly byKey: ReadonlyMap<string, MatchProduct>
  readonly products: readonly MatchProduct[]
  readonly keyed: readonly KeyedName<MatchProduct>[]
}

export function matchIndexOf(
  aliases: readonly ImportAlias[],
  products: readonly MatchProduct[],
): MatchIndex {
  const names = new Map<string, ImportAlias>()
  const codes = new Map<string, ImportAlias>()
  const coded = new Set<string>()
  for (const alias of aliases) {
    ;(alias.kind === 'name' ? names : codes).set(alias.key, alias)
    if (alias.kind === 'code' && alias.target === 'product' && alias.productId !== null) {
      coded.add(alias.productId)
    }
  }
  const keyed = keyedNames(products, (p) => p.name)
  const byKey = new Map<string, MatchProduct>()
  for (const { record, key } of keyed) {
    if (key !== '' && !byKey.has(key)) byKey.set(key, record)
  }
  return { names, codes, coded, byKey, products, keyed }
}

/**
 * The names that look like `name` ("Did you mean …?"), the closest first: the product of the very
 * name first (a second item code of it waits for its own answer, see above).
 */
export function suggestionsFor(name: string, index: MatchIndex): readonly MatchProduct[] {
  const { same, similar } = matchKeyedNames(name, index.keyed, MATCH_SUGGESTIONS)
  return same === null ? similar : [same, ...similar].slice(0, MATCH_SUGGESTIONS)
}

/**
 * Which product (or other treatment) an imported item is (see above). `suggest: false` leaves an
 * unmatched name's "Did you mean" empty (finalizing, or a name no screen shows).
 */
export function matchName(
  item: { readonly name: string; readonly code: string | null },
  index: MatchIndex,
  options: { readonly suggest?: boolean } = {},
): NameMatch {
  if (item.code !== null) {
    const byCode = index.codes.get(aliasKeyOfCode(item.code))
    if (byCode) {
      return { state: 'matched', via: 'code', target: byCode.target, productId: byCode.productId }
    }
  }
  // A code with no answer of its own is not put on a product another code's answer names (see above).
  const anotherSize = (productId: string | null) =>
    item.code !== null && productId !== null && index.coded.has(productId)
  const key = aliasKeyOfName(item.name)
  const alias = index.names.get(key)
  if (alias) {
    if (!anotherSize(alias.productId)) {
      return { state: 'matched', via: 'alias', target: alias.target, productId: alias.productId }
    }
  } else {
    const product = index.byKey.get(key)
    if (product && !anotherSize(product.id)) {
      return { state: 'matched', via: 'name', target: 'product', productId: product.id }
    }
  }
  return {
    state: 'unmatched',
    suggestions: options.suggest === false ? [] : suggestionsFor(item.name, index),
  }
}

/**
 * Names POS exports give what is not sold (folded as headers are): tips, discounts, a service charge,
 * delivery charged. They are never made products in bulk ("Add all as new" leaves them out); the
 * person says what each is.
 */
const NOT_SOLD: Readonly<Record<Exclude<AliasTarget, 'product'>, readonly string[]>> = {
  skip: [
    'tip',
    'tips',
    'gratuity',
    'gratuities',
    'discount',
    'discounts',
    'rounding',
    'بقشيش',
    'اكراميه',
    'الاكراميه',
    'خصم',
    'الخصم',
    'تقريب',
  ],
  charge: [
    'service charge',
    'service',
    'service fee',
    'رسوم خدمه',
    'رسوم الخدمه',
    'خدمه',
    'الخدمه',
  ],
  delivery: [
    'delivery',
    'delivery fee',
    'delivery charge',
    'shipping',
    'shipping fee',
    'توصيل',
    'التوصيل',
    'رسوم التوصيل',
    'رسوم توصيل',
    'شحن',
    'الشحن',
    'رسوم الشحن',
  ],
}

const NOT_SOLD_KEYS = (Object.entries(NOT_SOLD) as [Exclude<AliasTarget, 'product'>, string[]][])
  .flatMap(([target, words]) => words.map((word) => ({ target, key: headerKey(word) })))
  // The longest first ("service charge" before "service").
  .sort((a, b) => b.key.length - a.key.length)

/**
 * What a name looks like when it is not something sold (a tip, a service charge, delivery charged):
 * the name is one of the words above, or starts with one ("Tips (cash)", "Delivery fee 5%"). Null
 * for anything else.
 */
export function looksNotSold(name: string): Exclude<AliasTarget, 'product'> | null {
  const key = headerKey(name)
  if (key === '') return null
  for (const word of NOT_SOLD_KEYS) {
    if (key === word.key || key.startsWith(`${word.key} `)) return word.target
  }
  return null
}

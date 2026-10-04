import type Decimal from 'decimal.js'
import type { VatCategory } from '../catalog/keys'
import { VAT_CATEGORIES } from '../catalog/keys'
import { saleVatRate } from '../costing/product-cost'
import { exactProduct, fixed, pow10, roundHalfUp, toDec } from '../numbers/decimal'
import { DECIMAL_COLUMNS, type Money, type Percent, type Quantity } from '../numbers/kinds'
import { currencyMinorUnit, type CurrencyCode } from '../numbers/rounding'
import { computeLine, lineError, type LineDiscount, type LineError } from './line'
import { splitByWeights } from './split'
import { vatIn } from './vat'

// What a sale, an order, a quotation, an invoice and a credit note come to (M3 Step 1, D-220; the
// owner's answer Q4 of D-218). One engine for every sales document:
//   - each line: qty × unit price = subtotal, rounded half away from zero to the currency's minor
//     unit; its own discount (% or an amount) comes off before VAT; the price, the discount amount
//     and the document discount are typed like the price: before VAT, or with it when the product's
//     price includes VAT (D-121). For a business not registered for VAT a price is only a price;
//   - a document discount (% of the item lines' net, or an amount) comes off the item lines only,
//     split by their net with splitByWeights (largest remainder, D-114 rule 4); delivery and other
//     charges keep their amounts. Typed like the item prices, it has one meaning: before VAT (the
//     net falls by it) when they are before VAT, with VAT (the total falls by it) when they include
//     it. A VAT-registered sale whose taxed item lines are priced both ways refuses it
//     (`document_discount_mixed_prices`): there it would mean neither, so each line takes its own;
//   - delivery charged to the customer is a `delivery` line, standard-rated for a VAT-registered
//     business; any other charge (a service charge) is a `charge` line with its own VAT category;
//   - each line copies its VAT category and rate from what it sells (saleVatRate: 5 % standard, 0
//     for zero-rated and exempt, which stay apart: they are different lines of a tax invoice). For a
//     business not registered for VAT no line carries a VAT category or rate, whatever the product
//     says (D-121, D-206), and the document says which it was made under (frozen at posting);
//   - VAT is worked out ONCE per VAT rate (category), not per line: the exact VAT of the rate's lines
//     (net × rate ÷ 100 on a price before VAT, gross × rate ÷ (100 + rate) in a price that includes
//     it), rounded once. With prices before VAT that is round(the rate's net × rate ÷ 100), so VAT =
//     taxable × rate exactly (PINT-AE aligned-ibrp-s-09). With prices that include VAT the rate's
//     total stays exactly what the customer was asked: VAT = round(gross × 5 ÷ 105) and the net is
//     the rest (S-09 then holds within 0.01, inside the rule's 0.02 slack; 1 gross in 21 at 5 %);
//   - the rate's VAT is split back over its lines by largest remainder, so the printed line VAT adds
//     up to it: 7 lines of 10.10 at 5 % are 70.70 with VAT 3.54 (four lines of 0.51 and three of
//     0.50), never 7 × 0.51 = 3.57. A line whose price includes VAT keeps its gross as its total;
//   - "Round the total" (solveRoundAmount, D-221) gives an adjustment before VAT, split over the
//     rates by their net and then over each rate's lines by their net (no line below zero); a rate
//     it changes works its VAT out again on its adjusted net (round(net × rate ÷ 100)); a fils no
//     rate can reach is a rounding difference (ibt-114) of at most 2 minor units, outside any line;
//   - a refund or a credit has negative quantities: the whole document mirrors the sale it takes back
//     (every amount negated; half away from zero makes round(−x) = −round(x)), so one document's lines
//     are all sold or all taken back.
// Purchases keep their per-line rounding (D-107, D-114 rule 4): they are the supplier's documents.
//
// IBR-147-AE (pintLineOf): a line's net = quantity × net price ÷ price base quantity + its charges −
// its allowances. A line priced before VAT maps its own unit price for 1 and its discounts as
// allowances; a line whose price includes VAT maps its net per unit when that is exact in 4 decimals,
// else its net for the line's quantity (IBT-149 = the quantity). A credit maps as positive numbers.

/** `sale_lines.kind`: what the customer is charged for. */
export const SALE_LINE_KINDS = ['item', 'delivery', 'charge'] as const
export type SaleLineKind = (typeof SALE_LINE_KINDS)[number]

/** The most a rounding difference may be, in minor units of the currency (0.02 in AED; D-221). */
export const ROUNDING_DIFFERENCE_MINOR_UNITS = 2

interface SaleLineBase {
  /** Not zero; negative on a refund or a credit note (every line of it). */
  readonly qty: Quantity
  /** Per unit, as typed: zero or more. */
  readonly unitPrice: Money
  /** Whether the price (and the line's discount amount) includes VAT (the product's, D-121). */
  readonly priceIncludesVat: boolean
  readonly discount?: LineDiscount | null
}

/** Something sold: a product or a service (it may carry a share of running costs, D-202). */
export interface SaleItemLineInput extends SaleLineBase {
  readonly kind: 'item'
  /** The product's VAT category, copied onto the line. */
  readonly vatCategory: VatCategory
}

/** Delivery charged to the customer: standard-rated for a VAT-registered business. */
export interface SaleDeliveryLineInput extends SaleLineBase {
  readonly kind: 'delivery'
}

/** Another charge (a service charge): counts as a sale, never carries a share of running costs. */
export interface SaleChargeLineInput extends SaleLineBase {
  readonly kind: 'charge'
  readonly vatCategory: VatCategory
}

export type SaleLineInput = SaleItemLineInput | SaleDeliveryLineInput | SaleChargeLineInput

export interface SaleInput {
  readonly lines: readonly SaleLineInput[]
  /** businesses.vat_registered when the document is made (frozen at posting). */
  readonly vatRegistered: boolean
  /**
   * Discount on the whole document: a % of the item lines' net, or an amount typed like their prices
   * (refused over taxed item lines priced both ways: `document_discount_mixed_prices`).
   */
  readonly discount?: LineDiscount | null
  /** "Round the total" (solveRoundAmount): an amount before VAT, in the document's sign. */
  readonly adjustment?: Money | null
  /** What no VAT rate can reach (ibt-114), at most 2 minor units, in the document's sign. */
  readonly roundingDifference?: Money | null
}

/** A line's amounts, each with exactly the currency's minor-unit digits ("31.50"). */
export interface SaleLineAmounts {
  readonly kind: SaleLineKind
  /** Null for a business not registered for VAT. */
  readonly vatCategory: VatCategory | null
  readonly vatRate: Percent | null
  /** Whether its price was taken as including VAT (never for a business not registered for VAT). */
  readonly priceIncludesVat: boolean
  /** qty × unit price, as typed (with VAT when the price includes it). */
  readonly subtotal: Money
  /** Its own discount, as typed. */
  readonly discount: Money
  /** Its share of the document discount, as typed (item lines; 0 otherwise). */
  readonly documentDiscount: Money
  /** Its share of "Round the total", before VAT. */
  readonly adjustment: Money
  /** Before VAT, after every discount: what VAT is on, the line net amount (IBT-131), its sales. */
  readonly net: Money
  readonly vat: Money
  /** net + vat (a price including VAT: the gross after its discounts, until a rounding adjustment). */
  readonly total: Money
}

/** One VAT rate of the document (a tax invoice's VAT breakdown, ibg-23). */
export interface SaleVatRate {
  readonly vatCategory: VatCategory | null
  readonly vatRate: Percent | null
  /** Σ of its lines' net (ibt-116). */
  readonly net: Money
  /** Worked out once on the rate (ibt-117); Σ of its lines' VAT. */
  readonly vat: Money
}

export interface SaleAmounts {
  readonly vatRegistered: boolean
  readonly lines: readonly SaleLineAmounts[]
  /** By VAT category (standard, zero-rated, exempt), or one without VAT when not registered. */
  readonly rates: readonly SaleVatRate[]
  /** The document discount as an amount, as typed (Σ the item lines' shares). */
  readonly documentDiscount: Money
  /** "Round the total", before VAT (Σ the lines' shares). */
  readonly adjustment: Money
  /** Σ of the lines' net, before VAT (ibt-109). */
  readonly net: Money
  readonly vat: Money
  /** net + vat (ibt-112). */
  readonly total: Money
  /** ibt-114: outside every line and VAT rate. */
  readonly roundingDifference: Money
  /** total + roundingDifference: what the customer pays (ibt-115). */
  readonly payable: Money
}

export type SaleErrorCode =
  | Exclude<LineError, 'negative_quantity' | 'negative_vat_rate'>
  | 'zero_quantity'
  | 'mixed_signs'
  | 'no_item_line'
  | 'no_line'
  | 'document_discount_negative'
  | 'document_discount_over_100_percent'
  | 'document_discount_over_net'
  | 'document_discount_mixed_prices'
  | 'adjustment_over_net'
  | 'too_many_decimals'
  | 'rounding_difference_too_large'

export interface SaleError {
  readonly code: SaleErrorCode
  /** The line concerned (index in `lines`), for a line's own problem. */
  readonly line?: number
}

const ZERO = '0'

/** The line as the line maths read it: its quantity as a positive number, no VAT (worked out later). */
function lineMaths(line: SaleLineInput, qty: string) {
  return {
    qty: qty as Quantity,
    unitPrice: line.unitPrice,
    discount: line.discount,
    vatRate: ZERO as Percent,
  }
}

/** -1 for a refund or credit (its first line's quantity is negative), 1 otherwise. */
function signOf(input: SaleInput): 1 | -1 {
  const first = input.lines.find((line) => !toDec(line.qty).isZero())
  return first !== undefined && toDec(first.qty).lt(0) ? -1 : 1
}

interface RateGroup {
  readonly key: VatCategory | 'none'
  readonly rate: string
  readonly indexes: number[]
}

interface Worked {
  readonly sign: 1 | -1
  readonly groups: readonly RateGroup[]
  readonly base: readonly { subtotal: Decimal; discount: Decimal; documentDiscount: Decimal }[]
  readonly adjustment: readonly Decimal[]
  readonly net: readonly Decimal[]
  readonly vat: readonly Decimal[]
  readonly documentDiscount: Decimal
  readonly roundingDifference: Decimal
}

/** The VAT category a line charges: delivery is standard-rated; null when not VAT-registered. */
function categoryOf(line: SaleLineInput, vatRegistered: boolean): VatCategory | null {
  if (!vatRegistered) return null
  return line.kind === 'delivery' ? 'standard' : line.vatCategory
}

/** Splits a signed `amount` by `weights` (zero or more): the split of |amount|, in its sign. */
function splitSigned(amount: Decimal, weights: readonly Decimal[], digits: number): Decimal[] {
  const parts = splitByWeights(
    fixed(amount.abs(), digits),
    weights.map((w) => fixed(w, digits)),
    digits,
  )
  return parts.map((part) => (amount.lt(0) ? toDec(part).negated() : toDec(part)))
}

/** Works the document out on its absolute values (see above), or says what is wrong with it. */
function work(input: SaleInput, currency: CurrencyCode): Worked | SaleError {
  const digits = currencyMinorUnit(currency)
  const round = (value: Decimal) => roundHalfUp(value, digits)
  const sign = signOf(input)

  // Each line on its own: quantities as positive numbers.
  const base: { subtotal: Decimal; discount: Decimal; net: Decimal }[] = []
  for (const [index, line] of input.lines.entries()) {
    const qty = toDec(line.qty)
    if (qty.isZero()) return { code: 'zero_quantity', line: index }
    if (qty.lt(0) !== (sign === -1)) return { code: 'mixed_signs', line: index }
    const maths = lineMaths(line, qty.abs().toString())
    const error = lineError(maths, currency)
    if (error) return { code: error as SaleErrorCode, line: index }
    const amounts = computeLine(maths, currency)
    base.push({
      subtotal: toDec(amounts.subtotal),
      discount: toDec(amounts.discount),
      net: toDec(amounts.net),
    })
  }

  // The document discount, typed like the prices, off the item lines by their net.
  const items = input.lines.flatMap((line, i) => (line.kind === 'item' ? [i] : []))
  const itemNet = items.reduce((acc, i) => acc.plus(base[i]!.net), toDec(ZERO))
  const discount = input.discount
  let documentDiscount = toDec(ZERO)
  if (discount) {
    if (items.length === 0) return { code: 'no_item_line' }
    const value = toDec('percent' in discount ? discount.percent : discount.amount)
    if (value.lt(0)) return { code: 'document_discount_negative' }
    if ('percent' in discount && value.gt(100)) {
      return { code: 'document_discount_over_100_percent' }
    }
    documentDiscount = round('percent' in discount ? itemNet.times(value).dividedBy(100) : value)
    if (documentDiscount.gt(itemNet)) return { code: 'document_discount_over_net' }
    // Typed like the prices: over taxed item lines priced both ways it would mean neither.
    const taxed = items.filter((i) => toDec(saleVatRate(categoryOf(input.lines[i]!, true)!)).gt(0))
    const ways = new Set(taxed.map((i) => input.lines[i]!.priceIncludesVat))
    if (input.vatRegistered && ways.size > 1 && !documentDiscount.isZero()) {
      return { code: 'document_discount_mixed_prices' }
    }
  }
  const discountShares = new Map<number, Decimal>()
  splitSigned(
    documentDiscount,
    items.map((i) => base[i]!.net),
    digits,
  ).forEach((share, k) => discountShares.set(items[k]!, share))
  const left = base.map((b, i) => b.net.minus(discountShares.get(i) ?? toDec(ZERO)))

  // "Round the total" and the rounding difference, as on the document (made positive here).
  const typed = (value: Money | null | undefined): Decimal | null => {
    if (value === null || value === undefined) return toDec(ZERO)
    const amount = toDec(value)
    if (amount.decimalPlaces() > digits) return null
    return sign === -1 ? amount.negated() : amount
  }
  const adjustment = typed(input.adjustment)
  const roundingDifference = typed(input.roundingDifference)
  if (adjustment === null || roundingDifference === null) return { code: 'too_many_decimals' }
  if (roundingDifference.abs().gt(pow10(-digits).times(ROUNDING_DIFFERENCE_MINOR_UNITS))) {
    return { code: 'rounding_difference_too_large' }
  }
  if (!adjustment.isZero() && input.lines.length === 0) return { code: 'no_line' }

  // The VAT rates: one group per category (one with no VAT when not registered), in a fixed order.
  const keyOf = (line: SaleLineInput) => categoryOf(line, input.vatRegistered) ?? 'none'
  const groups: RateGroup[] = [...VAT_CATEGORIES, 'none' as const]
    .map((key) => ({
      key,
      rate: key === 'none' ? ZERO : saleVatRate(key),
      indexes: input.lines.flatMap((line, i) => (keyOf(line) === key ? [i] : [])),
    }))
    .filter((group) => group.indexes.length > 0)

  // VAT once per rate: the exact VAT of its lines rounded once; the part in the prices that include
  // it, rounded once on their gross, keeps their total exact. Each part is split back over its lines.
  const net = left.map((value) => value)
  const vat = left.map(() => toDec(ZERO))
  const inclusive = (i: number) => input.vatRegistered && input.lines[i]!.priceIncludesVat
  for (const group of groups) {
    const r = toDec(group.rate)
    const incl = group.indexes.filter((i) => inclusive(i) && r.gt(0))
    const excl = group.indexes.filter((i) => !incl.includes(i))
    const gross = incl.reduce((acc, i) => acc.plus(left[i]!), toDec(ZERO))
    const before = excl.reduce((acc, i) => acc.plus(left[i]!), toDec(ZERO))
    const inGross = vatIn(gross, group.rate, digits)
    // (before × rate × (100 + rate) + gross × rate × 100) ÷ (100 × (100 + rate)), divided once.
    const exact = exactProduct([before, r, r.plus(100)])
      .plus(exactProduct([gross, r, toDec('100')]))
      .dividedBy(r.plus(100).times(100))
    const total = round(exact)
    splitSigned(
      inGross,
      incl.map((i) => left[i]!),
      digits,
    ).forEach((share, k) => {
      vat[incl[k]!] = share
      net[incl[k]!] = left[incl[k]!]!.minus(share)
    })
    splitSigned(
      total.minus(inGross),
      excl.map((i) => left[i]!),
      digits,
    ).forEach((share, k) => (vat[excl[k]!] = share))
  }

  // "Round the total": over the rates by their net, then over each rate's lines by their net; a rate
  // it changes works its VAT out again on its new net.
  const shares = left.map(() => toDec(ZERO))
  if (!adjustment.isZero()) {
    const groupNet = groups.map((g) => g.indexes.reduce((acc, i) => acc.plus(net[i]!), toDec(ZERO)))
    const allNet = groupNet.reduce((acc, value) => acc.plus(value), toDec(ZERO))
    if (adjustment.lt(0) && adjustment.abs().gt(allNet)) return { code: 'adjustment_over_net' }
    splitSigned(adjustment, groupNet, digits).forEach((part, g) => {
      if (part.isZero()) return
      const group = groups[g]!
      splitSigned(
        part,
        group.indexes.map((i) => net[i]!),
        digits,
      ).forEach((share, k) => {
        const i = group.indexes[k]!
        shares[i] = share
        net[i] = net[i]!.plus(share)
      })
      const adjusted = groupNet[g]!.plus(part)
      const rateVat = round(adjusted.times(toDec(group.rate)).dividedBy(100))
      splitSigned(
        rateVat,
        group.indexes.map((i) => net[i]!),
        digits,
      ).forEach((share, k) => (vat[group.indexes[k]!] = share))
    })
  }

  return {
    sign,
    groups,
    base: base.map((b, i) => ({
      subtotal: b.subtotal,
      discount: b.discount,
      documentDiscount: discountShares.get(i) ?? toDec(ZERO),
    })),
    adjustment: shares,
    net,
    vat,
    documentDiscount,
    roundingDifference,
  }
}

function isError(worked: Worked | SaleError): worked is SaleError {
  return 'code' in worked
}

/** The first problem with a sale's input (for a form message), or null when it can be computed. */
export function saleError(input: SaleInput, currency: CurrencyCode): SaleError | null {
  const worked = work(input, currency)
  return isError(worked) ? worked : null
}

/** A sales document's amounts (see the rules above). Throws RangeError when saleError finds one. */
export function computeSale(input: SaleInput, currency: CurrencyCode): SaleAmounts {
  const worked = work(input, currency)
  if (isError(worked)) {
    const where = worked.line === undefined ? '' : ` (line ${worked.line + 1})`
    throw new RangeError(`Invalid sale: ${worked.code}${where}`)
  }
  const digits = currencyMinorUnit(currency)
  const print = (value: Decimal) =>
    fixed(worked.sign === -1 ? value.negated() : value, digits) as Money
  const lines: SaleLineAmounts[] = input.lines.map((line, i) => {
    const category = categoryOf(line, input.vatRegistered)
    return {
      kind: line.kind,
      vatCategory: category,
      vatRate: category === null ? null : saleVatRate(category),
      priceIncludesVat: input.vatRegistered && line.priceIncludesVat,
      subtotal: print(worked.base[i]!.subtotal),
      discount: print(worked.base[i]!.discount),
      documentDiscount: print(worked.base[i]!.documentDiscount),
      adjustment: print(worked.adjustment[i]!),
      net: print(worked.net[i]!),
      vat: print(worked.vat[i]!),
      total: print(worked.net[i]!.plus(worked.vat[i]!)),
    }
  })
  const sum = (indexes: readonly number[], values: readonly Decimal[]) =>
    indexes.reduce((acc, i) => acc.plus(values[i]!), toDec(ZERO))
  const all = input.lines.map((_, i) => i)
  const rates: SaleVatRate[] = worked.groups.map((group) => ({
    vatCategory: group.key === 'none' ? null : group.key,
    vatRate: group.key === 'none' ? null : saleVatRate(group.key),
    net: print(sum(group.indexes, worked.net)),
    vat: print(sum(group.indexes, worked.vat)),
  }))
  const net = sum(all, worked.net)
  const vat = sum(all, worked.vat)
  const total = net.plus(vat)
  return {
    vatRegistered: input.vatRegistered,
    lines,
    rates,
    documentDiscount: print(worked.documentDiscount),
    adjustment: print(sum(all, worked.adjustment)),
    net: print(net),
    vat: print(vat),
    total: print(total),
    roundingDifference: print(worked.roundingDifference),
    payable: print(total.plus(worked.roundingDifference)),
  }
}

// ---------------------------------------------------------------------------------------------------
// Round the total (D-221)
// ---------------------------------------------------------------------------------------------------

export type RoundTheTotalErrorCode =
  SaleErrorCode | 'wanted_too_many_decimals' | 'wanted_opposite_sign' | 'unreachable'

export interface RoundTheTotal {
  /** Before VAT, in the document's sign: pass it as the sale's `adjustment`. */
  readonly adjustment: Money
  /** What the rates could not reach (0 to 2 minor units): pass it as `roundingDifference`. */
  readonly roundingDifference: Money
  /** The sale with both: its `payable` is the total wanted. */
  readonly sale: SaleAmounts
}

/** The input with an adjustment and rounding difference in place of its own. */
function withRounding(input: SaleInput, adjustment: string, difference: string): SaleInput {
  return {
    ...input,
    adjustment: adjustment as Money,
    roundingDifference: difference as Money,
  }
}

/**
 * The first problem with rounding the sale to `wanted` (with VAT), or null. `unreachable` only when no
 * adjustment comes within the rounding difference (it never happens for a document with a line).
 */
export function roundTheTotalError(
  input: SaleInput,
  wanted: Money,
  currency: CurrencyCode,
): { readonly code: RoundTheTotalErrorCode; readonly line?: number } | null {
  try {
    solveRoundAmount(input, wanted, currency)
    return null
  } catch (error) {
    if (error instanceof RoundingRefusal) return error.refusal
    throw error
  }
}

class RoundingRefusal extends RangeError {
  constructor(readonly refusal: { readonly code: RoundTheTotalErrorCode; readonly line?: number }) {
    super(`Cannot round the total: ${refusal.code}`)
  }
}

/** A worked document's total (net + VAT), made positive as `work` gives it. */
function totalOf(worked: Worked): Decimal {
  return worked.net.reduce((acc, net, i) => acc.plus(net).plus(worked.vat[i]!), toDec(ZERO))
}

/**
 * "Round the total" (D-221): the adjustment before VAT that brings the sale's total (with VAT) to the
 * largest total it can reach that is not above `wanted`, and the rounding difference left (0 to 2
 * minor units), so the sale's `payable` is `wanted`. The adjustment is split over the VAT rates by
 * their net and over each rate's lines by their net (no line below zero). 1,120.00 → 1,100.00 is
 * −19.05 before VAT with VAT 52.38; 1,000.12 at 5 % is 1,000.11 + 0.01. A refund rounds in its own
 * sign. Throws RangeError when roundTheTotalError finds a problem.
 */
export function solveRoundAmount(
  input: SaleInput,
  wanted: Money,
  currency: CurrencyCode,
): RoundTheTotal {
  const digits = currencyMinorUnit(currency)
  const unit = pow10(-digits)
  const base = work(withRounding(input, ZERO, ZERO), currency)
  if (isError(base)) throw new RoundingRefusal(base)
  if (input.lines.length === 0) throw new RoundingRefusal({ code: 'no_line' })
  const want = toDec(wanted)
  if (want.decimalPlaces() > digits) throw new RoundingRefusal({ code: 'wanted_too_many_decimals' })
  const sign = base.sign
  const target = sign === -1 ? want.negated() : want
  if (target.lt(0)) throw new RoundingRefusal({ code: 'wanted_opposite_sign' })
  const inSign = (value: Decimal) => fixed(sign === -1 ? value.negated() : value, digits)

  let chosen = toDec(ZERO)
  let reached = totalOf(base)
  if (!reached.eq(target)) {
    // The exact adjustment: the difference ÷ what one unit before VAT adds with its VAT, the rates
    // weighted by their net (equally when they are all zero). Then the fils around it are tried.
    const groupNet = base.groups.map((g) =>
      g.indexes.reduce((acc, i) => acc.plus(base.net[i]!), toDec(ZERO)),
    )
    const allNet = groupNet.reduce((acc, value) => acc.plus(value), toDec(ZERO))
    const weights = allNet.isZero() ? groupNet.map(() => toDec('1')) : groupNet
    const withVat = base.groups.reduce(
      (acc, g, k) => acc.plus(weights[k]!.times(toDec(g.rate).plus(100)).dividedBy(100)),
      toDec(ZERO),
    )
    const weight = weights.reduce((acc, value) => acc.plus(value), toDec(ZERO))
    const exact = target.minus(reached).times(weight).dividedBy(withVat)
    const start = roundHalfUp(exact, digits)
    let best: { adjustment: Decimal; total: Decimal; off: Decimal } | null = null
    const span = 4 + 2 * base.groups.length
    for (let k = -span; k <= span; k++) {
      const adjustment = start.plus(unit.times(k))
      if (adjustment.lt(0) && adjustment.abs().gt(allNet)) continue
      const worked = work(withRounding(input, inSign(adjustment), ZERO), currency)
      if (isError(worked)) continue
      const total = totalOf(worked)
      if (total.gt(target)) continue
      // The highest total; of two the same, the closer to the exact adjustment, then the larger.
      const off = adjustment.minus(exact).abs()
      const better =
        best === null ||
        total.gt(best.total) ||
        (total.eq(best.total) &&
          (off.lt(best.off) || (off.eq(best.off) && adjustment.gt(best.adjustment))))
      if (better) best = { adjustment, total, off }
    }
    if (best === null || target.minus(best.total).gt(unit.times(ROUNDING_DIFFERENCE_MINOR_UNITS))) {
      throw new RoundingRefusal({ code: 'unreachable' })
    }
    chosen = best.adjustment
    reached = best.total
  }
  const adjustment = inSign(chosen) as Money
  const roundingDifference = inSign(target.minus(reached)) as Money
  return {
    adjustment,
    roundingDifference,
    sale: computeSale(withRounding(input, adjustment, roundingDifference), currency),
  }
}

// ---------------------------------------------------------------------------------------------------
// A line as e-invoicing reads it (IBR-147-AE)
// ---------------------------------------------------------------------------------------------------

/** A line's PINT-AE price fields: net = quantity × netPrice ÷ baseQuantity + charges − allowances. */
export interface PintLine {
  /** IBT-129 (credited quantity on a credit note): positive. */
  readonly quantity: Quantity
  /** IBT-146: the price before VAT for `baseQuantity` units (a price including VAT never maps). */
  readonly netPrice: Money
  /** IBT-149: 1, or the line's quantity when its net per unit is not exact in 4 decimals. */
  readonly baseQuantity: Quantity
  /** IBT-136: its discount, its share of the document discount, a rounding adjustment down. */
  readonly allowances: Money
  /** IBT-141: a rounding adjustment up. */
  readonly charges: Money
  /** IBT-131: the line's net, positive. */
  readonly lineNet: Money
}

/**
 * How a computed line maps for e-invoicing (IBR-147-AE, see above): `line` as typed and `amounts` as
 * computeSale gave them for it. Every amount is positive (a credit note's lines are).
 */
export function pintLineOf(
  line: SaleLineInput,
  amounts: SaleLineAmounts,
  currency: CurrencyCode,
): PintLine {
  const digits = currencyMinorUnit(currency)
  const print = (value: Decimal) => fixed(value, digits) as Money
  const quantity = toDec(line.qty).abs()
  const lineNet = toDec(amounts.net).abs()
  // The adjustment in the line's own direction: down is an allowance, up a charge.
  const sign = toDec(line.qty).lt(0) ? -1 : 1
  const adjustment = toDec(amounts.adjustment).times(sign)
  const rated = amounts.vatRate !== null && toDec(amounts.vatRate).gt(0)
  if (!(amounts.priceIncludesVat && rated)) {
    return {
      quantity: quantity.toString() as Quantity,
      netPrice: toDec(line.unitPrice).toString() as Money,
      baseQuantity: '1' as Quantity,
      allowances: print(
        toDec(amounts.discount)
          .abs()
          .plus(toDec(amounts.documentDiscount).abs())
          .plus(adjustment.lt(0) ? adjustment.abs() : toDec(ZERO)),
      ),
      charges: print(adjustment.gt(0) ? adjustment : toDec(ZERO)),
      lineNet: print(lineNet),
    }
  }
  // A price that includes VAT: its discounts are inside the net price.
  const perUnit = lineNet.dividedBy(quantity)
  const exact =
    perUnit.times(quantity).eq(lineNet) && perUnit.decimalPlaces() <= DECIMAL_COLUMNS.money.scale
  return {
    quantity: quantity.toString() as Quantity,
    netPrice: (exact ? perUnit : lineNet).toString() as Money,
    baseQuantity: (exact ? '1' : quantity.toString()) as Quantity,
    allowances: print(toDec(ZERO)),
    charges: print(toDec(ZERO)),
    lineNet: print(lineNet),
  }
}

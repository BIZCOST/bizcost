import type Decimal from 'decimal.js'
import { fixed, toDec } from '../numbers/decimal'
import type { Money, Percent, Quantity } from '../numbers/kinds'
import { currencyMinorUnit, type CurrencyCode } from '../numbers/rounding'
import { computeLine, lineError, type LineDiscount, type LineError } from './line'
import { splitByWeights } from './split'

// A purchase document's amounts and what its goods cost (D-114 rule 4; PRODUCT.md §4 rules 11–12):
//   - each material line: qty × unit price = subtotal; its own discount (% or fixed) comes off first
//     (net), then its share of the document discount (taxable); VAT is on the taxable amount;
//   - the document discount (% of the lines' net, or a fixed amount) is split over the material lines
//     by their net amount (largest remainder, split.ts: no share below zero or above its line's net);
//   - delivery charged on the same invoice (a delivery line: an amount and its VAT rate) is split over
//     the material lines the same way and becomes part of their cost; a separate delivery bill is an
//     expense, not a purchase line;
//   - VAT is part of the cost only when it cannot be reclaimed (vatInCost, purchasing/keys.ts);
//   - a material line's cost = taxable + its delivery share + its VAT when in cost. It is what the
//     receipt brings into stock (the WAC engine's receipt value, D-109).
// Every amount is rounded half away from zero to the currency's minor unit as it is computed, so
// the printed lines add up to the printed totals, and the line costs add up to what was paid for the
// goods (net + VAT when in cost).

/** A material bought: quantity in its purchase unit, price per purchase unit, optional discount. */
export interface PurchaseMaterialLineInput {
  readonly kind: 'material'
  readonly qty: Quantity
  readonly unitPrice: Money
  readonly discount?: LineDiscount | null
  /** VAT rate in percent (5 for the UAE standard rate, 0 when the document shows no VAT). */
  readonly vatRate: Percent
}

/** Delivery charged on the same invoice. */
export interface PurchaseDeliveryLineInput {
  readonly kind: 'delivery'
  readonly amount: Money
  readonly vatRate: Percent
}

export type PurchaseLineInput = PurchaseMaterialLineInput | PurchaseDeliveryLineInput

export interface PurchaseInput {
  readonly lines: readonly PurchaseLineInput[]
  /** Discount on the whole document: a percentage of the material lines' net, or an amount. */
  readonly discount?: LineDiscount | null
  /** Whether VAT is part of the cost (vatInCost). */
  readonly vatInCost: boolean
}

/** A line's amounts, each with exactly the currency's minor-unit digits. */
export interface PurchaseLineAmounts {
  readonly kind: 'material' | 'delivery'
  /** qty × unit price (delivery: its amount). */
  readonly subtotal: Money
  /** The line's own discount (0 for delivery). */
  readonly discount: Money
  /** subtotal − discount. */
  readonly net: Money
  /** Its share of the document discount (0 for delivery). */
  readonly documentDiscount: Money
  /** net − documentDiscount: what VAT is charged on. */
  readonly taxable: Money
  readonly vat: Money
  /** taxable + vat. */
  readonly total: Money
  /** Material lines: their share of the delivery (with its VAT when in cost); 0 for delivery. */
  readonly deliveryShare: Money
  /** Material lines: what the goods cost (the receipt's value); 0 for delivery. */
  readonly cost: Money
}

export interface PurchaseAmounts {
  readonly lines: readonly PurchaseLineAmounts[]
  /** The document discount as an amount. */
  readonly documentDiscount: Money
  /** Σ line subtotals (delivery included). */
  readonly subtotal: Money
  /** Σ line discounts + the document discount. */
  readonly discount: Money
  /** Σ taxable amounts (delivery included). */
  readonly net: Money
  readonly vat: Money
  /** net + vat: what the document asks to be paid. */
  readonly total: Money
  /** Σ material line costs: net + vat when VAT is part of the cost, else net. */
  readonly cost: Money
}

export type PurchaseErrorCode =
  | LineError
  | 'no_material_line'
  | 'document_discount_negative'
  | 'document_discount_over_100_percent'
  | 'document_discount_over_net'

export interface PurchaseError {
  readonly code: PurchaseErrorCode
  /** The line concerned (index in `lines`), for a line's own problem. */
  readonly line?: number
}

const ZERO = '0'

function materialLine(line: PurchaseMaterialLineInput) {
  return {
    qty: line.qty,
    unitPrice: line.unitPrice,
    discount: line.discount,
    vatRate: line.vatRate,
  }
}

/** The first problem with a purchase's input (for a form message), or null when it can be computed. */
export function purchaseError(input: PurchaseInput, currency: CurrencyCode): PurchaseError | null {
  const digits = currencyMinorUnit(currency)
  let materials = 0
  let net = toDec(ZERO)
  for (const [index, line] of input.lines.entries()) {
    if (line.kind === 'material') {
      const error = lineError(materialLine(line), currency)
      if (error) return { code: error, line: index }
      materials++
      net = net.plus(toDec(computeLine(materialLine(line), currency).net))
    } else {
      if (toDec(line.amount).lt(0)) return { code: 'negative_price', line: index }
      if (toDec(line.vatRate).lt(0)) return { code: 'negative_vat_rate', line: index }
    }
  }
  const hasDelivery = input.lines.some((line) => line.kind === 'delivery')
  const discount = input.discount
  if (materials === 0 && (hasDelivery || discount)) return { code: 'no_material_line' }
  if (!discount) return null
  const value = toDec('percent' in discount ? discount.percent : discount.amount)
  if (value.lt(0)) return { code: 'document_discount_negative' }
  if ('percent' in discount) {
    return value.gt(100) ? { code: 'document_discount_over_100_percent' } : null
  }
  return toDec(fixed(value, digits)).gt(net) ? { code: 'document_discount_over_net' } : null
}

/** A purchase's amounts and line costs (see the rules above). Throws RangeError on purchaseError. */
export function computePurchase(input: PurchaseInput, currency: CurrencyCode): PurchaseAmounts {
  const error = purchaseError(input, currency)
  if (error) {
    const where = error.line === undefined ? '' : ` (line ${error.line + 1})`
    throw new RangeError(`Invalid purchase: ${error.code}${where}`)
  }
  const digits = currencyMinorUnit(currency)
  const round = (value: Decimal) => toDec(fixed(value, digits))
  const print = (value: Decimal) => fixed(value, digits) as Money

  // Line subtotals, discounts and nets, delivery lines as they are.
  const base = input.lines.map((line) => {
    if (line.kind === 'material') {
      const amounts = computeLine(materialLine(line), currency)
      return { line, subtotal: amounts.subtotal, discount: amounts.discount, net: amounts.net }
    }
    const amount = print(toDec(line.amount))
    return { line, subtotal: amount, discount: print(toDec(ZERO)), net: amount }
  })
  const materialIndexes = base.flatMap((b, i) => (b.line.kind === 'material' ? [i] : []))
  const weights = materialIndexes.map((i) => base[i]!.net)
  const materialNet = weights.reduce((acc, w) => acc.plus(toDec(w)), toDec(ZERO))

  // The document discount, split by net amount.
  const discount = input.discount
  const documentDiscount = !discount
    ? toDec(ZERO)
    : 'percent' in discount
      ? round(materialNet.times(toDec(discount.percent)).dividedBy(100))
      : round(toDec(discount.amount))
  const discountShares = new Map<number, string>()
  splitByWeights(fixed(documentDiscount, digits), weights, digits).forEach((share, k) =>
    discountShares.set(materialIndexes[k]!, share),
  )

  // Taxable amounts and VAT.
  const taxed = base.map((b, i) => {
    const share = toDec(discountShares.get(i) ?? ZERO)
    const taxable = toDec(b.net).minus(share)
    const vat = round(taxable.times(toDec(b.line.vatRate)).dividedBy(100))
    return { ...b, share, taxable, vat }
  })
  if (taxed.some((t) => t.taxable.lt(0))) {
    throw new RangeError('Invalid purchase: document_discount_over_net')
  }

  // Delivery (with its VAT when VAT is part of the cost), split over the material lines the same way.
  const inCost = (t: (typeof taxed)[number]) =>
    input.vatInCost ? t.taxable.plus(t.vat) : t.taxable
  const delivery = taxed
    .filter((t) => t.line.kind === 'delivery')
    .reduce((acc, t) => acc.plus(inCost(t)), toDec(ZERO))
  const deliveryShares = new Map<number, string>()
  if (materialIndexes.length > 0) {
    splitByWeights(fixed(delivery, digits), weights, digits).forEach((share, k) =>
      deliveryShares.set(materialIndexes[k]!, share),
    )
  }

  const lines: PurchaseLineAmounts[] = taxed.map((t, i) => {
    const isMaterial = t.line.kind === 'material'
    const deliveryShare = toDec(deliveryShares.get(i) ?? ZERO)
    return {
      kind: t.line.kind,
      subtotal: t.subtotal as Money,
      discount: t.discount as Money,
      net: t.net as Money,
      documentDiscount: print(t.share),
      taxable: print(t.taxable),
      vat: print(t.vat),
      total: print(t.taxable.plus(t.vat)),
      deliveryShare: print(isMaterial ? deliveryShare : toDec(ZERO)),
      cost: print(isMaterial ? inCost(t).plus(deliveryShare) : toDec(ZERO)),
    }
  })
  const sum = (pick: (line: PurchaseLineAmounts) => string) =>
    lines.reduce((acc, line) => acc.plus(toDec(pick(line))), toDec(ZERO))
  const net = sum((l) => l.taxable)
  const vat = sum((l) => l.vat)
  return {
    lines,
    documentDiscount: print(documentDiscount),
    subtotal: print(sum((l) => l.subtotal)),
    discount: print(sum((l) => l.discount).plus(documentDiscount)),
    net: print(net),
    vat: print(vat),
    total: print(net.plus(vat)),
    cost: print(sum((l) => l.cost)),
  }
}

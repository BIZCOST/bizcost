import { Dec, fixed, plain, roundHalfUp, toDec } from '../../numbers/decimal'
import type { AliasTarget } from './match'

// The lines an imported day becomes (M3 Step 4): one sale per day × branch × channel, with one line
// per product (its rows' quantities and amounts added up), one service charge line (a sale with no
// cost) and one delivery charged line (the delivery margin); tips and everything else "not something I
// sell" are skipped. A product whose day comes to less than nothing (more refunded than sold) goes on
// the day's refund (a sale of negative quantities: one document is all sold or all taken back, D-220).
//
// A line keeps its amount exactly: qty × unit price − its discount = the amount, the unit price the
// amount ÷ qty rounded up to 4 decimals and the discount the few fils that leaves over (a line of 3 at
// AED 10.00 is 3 × 3.3334 = 10.00 − 0.00; 7 at 10.00 is 7 × 1.4286 = 10.00, 0 off). A line with
// nothing to divide by (no quantity left, an amount left) counts as 1.

export interface ImportDayEntry {
  readonly target: AliasTarget
  readonly productId: string | null
  /** In the file's kind of amount (before VAT, or with VAT when the import's amounts include it). */
  readonly qty: string
  readonly amount: string
}

export interface ImportSaleLine {
  readonly kind: 'item' | 'charge' | 'delivery'
  readonly productId: string | null
  /** Negative on the day's refund. */
  readonly qty: string
  /** Per unit, 4 decimals at most, zero or more. */
  readonly unitPrice: string
  /** What takes the line back to its amount exactly (0 or more), null when nothing. */
  readonly discountAmount: string | null
  /** The line's amount, as a positive number. */
  readonly amount: string
}

export interface ImportDayLines {
  readonly sold: readonly ImportSaleLine[]
  readonly returned: readonly ImportSaleLine[]
}

const PRICE_SCALE = 4

function lineOf(
  kind: ImportSaleLine['kind'],
  productId: string | null,
  qty: ReturnType<typeof toDec>,
  amount: ReturnType<typeof toDec>,
  minorUnit: number,
): { line: ImportSaleLine; returned: boolean } | null {
  if (amount.isZero() && qty.isZero()) return null
  const returned = amount.isZero() ? qty.lt(0) : amount.lt(0)
  const size = amount.abs()
  // The quantity on the amount's side; none left (or the other way): 1.
  const sameSide = !qty.isZero() && qty.lt(0) === returned
  const units = sameSide ? qty.abs() : new Dec(1)
  const unitPrice = size.dividedBy(units).toDecimalPlaces(PRICE_SCALE, Dec.ROUND_UP)
  const subtotal = roundHalfUp(units.times(unitPrice), minorUnit)
  const discount = subtotal.minus(size)
  return {
    returned,
    line: {
      kind,
      productId,
      qty: plain(returned ? units.negated() : units),
      unitPrice: plain(unitPrice),
      discountAmount: discount.isZero() ? null : fixed(discount, minorUnit),
      amount: fixed(size, minorUnit),
    },
  }
}

/**
 * The lines of one imported day (see above). Entries that are skipped are left out; every product
 * gets one line, in the order of its first entry; the service charge and the delivery charged follow.
 */
export function importDayLines(
  entries: readonly ImportDayEntry[],
  minorUnit: number,
): ImportDayLines {
  const products = new Map<
    string,
    { qty: ReturnType<typeof toDec>; amount: ReturnType<typeof toDec> }
  >()
  let charge = { qty: new Dec(0), amount: new Dec(0), any: false }
  let delivery = { qty: new Dec(0), amount: new Dec(0), any: false }
  for (const entry of entries) {
    const qty = toDec(entry.qty)
    const amount = toDec(entry.amount)
    if (entry.target === 'product') {
      if (entry.productId === null) throw new RangeError('A product entry names its product')
      const sum = products.get(entry.productId) ?? { qty: new Dec(0), amount: new Dec(0) }
      products.set(entry.productId, { qty: sum.qty.plus(qty), amount: sum.amount.plus(amount) })
    } else if (entry.target === 'charge') {
      charge = { qty: charge.qty.plus(qty), amount: charge.amount.plus(amount), any: true }
    } else if (entry.target === 'delivery') {
      delivery = { qty: delivery.qty.plus(qty), amount: delivery.amount.plus(amount), any: true }
    }
  }
  const sold: ImportSaleLine[] = []
  const returned: ImportSaleLine[] = []
  const add = (made: ReturnType<typeof lineOf>) => {
    if (made) (made.returned ? returned : sold).push(made.line)
  }
  for (const [productId, sum] of products) {
    add(lineOf('item', productId, sum.qty, sum.amount, minorUnit))
  }
  // A charge and a delivery are one line each, of 1 (their amounts are what counts). Delivery taken
  // back (more refunded than charged that day) is a charge on the refund: a delivery line is 1.
  const one = (amount: ReturnType<typeof toDec>) => (amount.lt(0) ? new Dec(-1) : new Dec(1))
  if (charge.any) add(lineOf('charge', null, one(charge.amount), charge.amount, minorUnit))
  if (delivery.any) {
    const kind = delivery.amount.lt(0) ? 'charge' : 'delivery'
    add(lineOf(kind, null, one(delivery.amount), delivery.amount, minorUnit))
  }
  return { sold, returned }
}

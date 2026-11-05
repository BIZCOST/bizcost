import type Decimal from 'decimal.js'
import {
  compareDecimal,
  Dec,
  exactProduct,
  plain,
  pow10,
  roundHalfUp,
  toDec,
} from '../numbers/decimal'
import { checkDecimal } from '../numbers/kinds'
import { currencyMinorUnit, fitsCurrency, type CurrencyCode } from '../numbers/rounding'
import { proportionOf, splitDecimals, subtractDecimals, sumDecimals } from './split'
import { vatIn } from './vat'

// What is left to refund or credit on each line of a finalized sale, and how a refund line is made
// (M3 Step 5; the plan's "credit maths"; VAT Executive Regulation Art. 60: a credit states the value
// the supply had and the value after it, so each later credit starts from the value its earlier ones
// left). Step 8's credit notes use the same maths.
//
//   - By quantity (goods returned): q of what is left. It takes the line's value left × q ÷ the
//     quantity left (one division, rounded half away from zero to the currency's minor unit), as its
//     prices are typed (with VAT when the line's price includes it, else before VAT). The last return
//     of what is left takes exactly what is left of the line: its quantity, net, VAT and total.
//   - By amount (a price cut): an amount, typed as the line's prices are, at most what is left of its
//     value; it takes back no quantity. An amount equal to what is left takes exactly what is left.
//   - Never more than is left (`exceeds_left`).
//
// A refund is a negative document (D-220): its lines have negative quantities and mirror what they
// take back. A line that takes a part is worked out by computeSale with the refund's other partial
// lines (VAT once per rate): the line's own unit price, and a discount that brings it to the value
// wanted (when the value wanted is more than the quantity × the unit price, by a minor unit of the
// rounding of earlier returns, the unit price is the value ÷ the quantity rounded up to 4 decimals).
// A line that takes what is left is copied exactly, so a sale refunded whole leaves nothing, not a fils.
// The VAT computeSale works out for a part (once per rate on the refund) can pass the VAT left on the
// line by a minor unit of earlier roundings: `fitCredit` keeps the part within what is left of each of
// net, VAT and total, so nothing left ever goes below zero (a credit never takes back more VAT than
// the supply was charged).

/** How a refund or a credit takes back a sale's line. */
export const CREDIT_BY = ['quantity', 'amount'] as const
export type CreditBy = (typeof CREDIT_BY)[number]

/** A line of the finalized document being credited, as it was finalized (positive amounts). */
export interface CreditedLine {
  /** More than zero. */
  readonly qty: string
  /** Per unit as typed (before VAT, or with VAT when its price includes it). */
  readonly unitPrice: string
  /** Its price includes VAT (never for a business not registered for VAT). */
  readonly priceIncludesVat: boolean
  readonly net: string
  readonly vat: string
  readonly total: string
}

/** A credit already made on that line (its refund line that stands), as positive amounts. */
export interface CreditMade {
  readonly by: CreditBy
  /** By quantity: the quantity it took back; by amount: zero. */
  readonly qty: string
  readonly net: string
  readonly vat: string
  readonly total: string
}

/** What is left of a line after its credits. */
export interface CreditLeft {
  readonly qty: string
  readonly net: string
  readonly vat: string
  readonly total: string
  /** The value left as the line's prices are typed: its total when they include VAT, else its net. */
  readonly typed: string
}

/** What is left of `line` after the credits `made` on it. */
export function creditLeft(line: CreditedLine, made: readonly CreditMade[]): CreditLeft {
  const qty = subtractDecimals(line.qty, ...made.map((c) => (c.by === 'quantity' ? c.qty : '0')))
  const net = subtractDecimals(line.net, ...made.map((c) => c.net))
  const vat = subtractDecimals(line.vat, ...made.map((c) => c.vat))
  const total = subtractDecimals(line.total, ...made.map((c) => c.total))
  return { qty, net, vat, total, typed: line.priceIncludesVat ? total : net }
}

/** What a credit asks of a line. */
export type CreditRequest =
  | { readonly by: 'quantity'; readonly qty: string }
  | { readonly by: 'amount'; readonly amount: string }

export type CreditErrorCode = 'not_positive' | 'too_many_decimals' | 'exceeds_left'

/** The first problem with `request` on a line with `left`, or null. */
export function creditError(
  left: CreditLeft,
  request: CreditRequest,
  currency: CurrencyCode,
): CreditErrorCode | null {
  if (request.by === 'quantity') {
    if (compareDecimal(request.qty, '0') <= 0) return 'not_positive'
    if (checkDecimal(request.qty, 'quantity') !== null) return 'too_many_decimals'
    return compareDecimal(request.qty, left.qty) > 0 ? 'exceeds_left' : null
  }
  if (compareDecimal(request.amount, '0') <= 0) return 'not_positive'
  if (!fitsCurrency(request.amount, currency)) return 'too_many_decimals'
  return compareDecimal(request.amount, left.typed) > 0 ? 'exceeds_left' : null
}

/**
 * How a credit line is made (negative quantities): `whole`, everything left of the line, copied
 * exactly; otherwise computeSale's input for it (a negative quantity, a unit price and a discount
 * amount typed as the line's prices are).
 */
export type CreditLinePlan =
  | {
      readonly whole: true
      readonly qty: string
      readonly net: string
      readonly vat: string
      readonly total: string
    }
  | {
      readonly whole: false
      readonly qty: string
      readonly unitPrice: string
      readonly discountAmount: string | null
    }

const negated = (value: string) => plain(toDec(value).negated())

/**
 * The credit line that takes `request` of `line` (with `left` left of it). Throws RangeError when
 * creditError refuses the request.
 */
export function planCredit(
  line: CreditedLine,
  left: CreditLeft,
  request: CreditRequest,
  currency: CurrencyCode,
): CreditLinePlan {
  const error = creditError(left, request, currency)
  if (error) throw new RangeError(`Credit refused: ${error}`)
  const digits = currencyMinorUnit(currency)
  const rest = (qty: string): CreditLinePlan => ({
    whole: true,
    qty,
    net: negated(left.net),
    vat: negated(left.vat),
    total: negated(left.total),
  })
  if (request.by === 'amount') {
    if (compareDecimal(request.amount, left.typed) === 0) return rest('-1')
    return { whole: false, qty: '-1', unitPrice: request.amount, discountAmount: null }
  }
  if (compareDecimal(request.qty, left.qty) === 0) return rest(negated(request.qty))
  const qty = toDec(request.qty)
  const wanted = toDec(proportionOf(left.typed, request.qty, left.qty, digits))
  let unitPrice = toDec(line.unitPrice)
  let subtotal = roundHalfUp(qty.times(unitPrice), digits)
  if (subtotal.lt(wanted)) {
    unitPrice = wanted.dividedBy(qty).toDecimalPlaces(4, Dec.ROUND_UP)
    subtotal = roundHalfUp(qty.times(unitPrice), digits)
  }
  const discount = subtotal.minus(wanted)
  return {
    whole: false,
    qty: negated(request.qty),
    unitPrice: plain(unitPrice),
    discountAmount: discount.isZero() ? null : plain(discount),
  }
}

/** A credit line's amounts: negative, as on a refund. */
export interface CreditAmounts {
  readonly net: string
  readonly vat: string
  readonly total: string
}

/**
 * The amounts of a part (a computeSale line of a plan that is not `whole`, negative) kept within
 * `left`: what is typed stays (the net, or the total when the line's price includes VAT); the VAT is
 * at most the VAT left, and, with VAT included, the net at most the net left; total = net + VAT.
 */
export function fitCredit(
  left: CreditLeft,
  part: CreditAmounts,
  priceIncludesVat: boolean,
): CreditAmounts {
  const leftNet = Dec.max(toDec(left.net), 0)
  const leftVat = Dec.max(toDec(left.vat), 0)
  let net = toDec(part.net).abs()
  let vat = toDec(part.vat).abs()
  let total: Decimal
  if (priceIncludesVat) {
    total = Dec.min(toDec(part.total).abs(), leftNet.plus(leftVat))
    if (vat.gt(leftVat)) vat = leftVat
    net = total.minus(vat)
    if (net.gt(leftNet)) {
      net = leftNet
      vat = total.minus(net)
    }
  } else {
    net = Dec.min(net, leftNet)
    vat = Dec.min(vat, leftVat)
    total = net.plus(vat)
  }
  return {
    net: plain(net.negated()),
    vat: plain(vat.negated()),
    total: plain(total.negated()),
  }
}

/**
 * What a credit note works its VAT out from at one rate (more than zero) of its invoice: the invoice's
 * VAT at that rate (after any deposit it took off), and its lines priced before VAT and those priced
 * with VAT, each kind on its own (D-365).
 */
export interface CreditRateBasis {
  readonly vatRate: string
  readonly invoiceVat: string
  readonly beforeVat: CreditRatePart
  readonly withVat: CreditRatePart
}

/**
 * One kind of price at the rate: the VAT the invoice's lines of that kind were charged, what the credit
 * notes issued before took back of them (their amounts as typed and their VAT), and whether this one
 * takes back all that is left of them.
 */
export interface CreditRatePart {
  readonly charged: string
  readonly before: { readonly typed: string; readonly vat: string }
  readonly takesAllLeft: boolean
}

/** PINT-AE aligned-ibrp-s-09's slack on a note's VAT against its taxable amount × the rate (0.02 in AED). */
const CREDIT_NOTE_VAT_SLACK_MINOR_UNITS = 2

/** A line of a credit note at the rate: what it takes back as its prices are typed (positive). */
export interface CreditRateLine {
  readonly priceIncludesVat: boolean
  readonly typed: string
}

/**
 * The VAT a credit note takes back at one rate, and its share on each of its lines (M3 Step 8 review;
 * PINT-AE aligned-ibrp-s-09 on every credit note, as on its invoice, D-220). Lines priced before VAT and
 * lines priced with VAT are worked out apart, as computeSale works their invoice out (D-365): each
 * kind's VAT is the VAT of the running total of the invoice's credit notes on that kind (this one's
 * amounts added to those before them, the VAT worked out once on the sum: prices without VAT times the
 * rate, prices with VAT their VAT inside) less the VAT the credit notes before took back of it, and the
 * note that takes back all that is left of a kind takes exactly the VAT left on it. So each kind's VAT
 * adds up to what its lines were charged, and a supply cancelled whole leaves nothing owed, however many
 * notes it took. One kind's VAT is within a fils of its taxable amount × the rate; a note holding both
 * kinds is within the rule's 0.02 slack. Never below zero nor more than the VAT left, of the kind and of
 * the rate. Shared over the kind's lines by what each takes back (largest remainder), all in one basis,
 * so a row's VAT stays near the rate on its before VAT: a line keeps what it took as typed (its net, or
 * its total when its price includes VAT), so its VAT and its other amount move together. Returns the
 * lines' VAT in order.
 */
export function creditRateVat(
  basis: CreditRateBasis,
  lines: readonly CreditRateLine[],
  currency: CurrencyCode,
): string[] {
  const digits = currencyMinorUnit(currency)
  const r = toDec(basis.vatRate)
  if (!r.gt(0) || lines.length === 0) return lines.map(() => '0')
  const zero = toDec('0')
  const kinds = [
    {
      withVat: false,
      part: basis.beforeVat,
      vatOf: (typed: Decimal) => roundHalfUp(exactProduct([typed, r]).dividedBy(100), digits),
    },
    {
      withVat: true,
      part: basis.withVat,
      vatOf: (typed: Decimal) => vatIn(typed, basis.vatRate, digits),
    },
  ].map(({ withVat, part, vatOf }) => {
    const at = lines.flatMap((l, i) => (l.priceIncludesVat === withVat ? [i] : []))
    const weights = at.map((i) => toDec(lines[i]!.typed))
    const typed = weights.reduce((a, w) => a.plus(w), zero)
    const before = toDec(part.before.vat)
    const left = Dec.max(toDec(part.charged).minus(before), 0)
    // Never more VAT than is left of the kind, nor than what the lines priced with it hold.
    const most = withVat ? Dec.min(left, typed) : left
    const running = vatOf(toDec(part.before.typed).plus(typed)).minus(before)
    const vat =
      at.length === 0 ? zero : part.takesAllLeft ? most : Dec.min(Dec.max(running, 0), most)
    return { at, weights, typed, part, most, vat }
  })
  const outside = kinds[0]!
  const inside = kinds[1]!
  // A deposit taken off at the rate leaves less than the kinds were charged: never past the rate's.
  const rateLeft = Dec.max(
    toDec(basis.invoiceVat)
      .minus(toDec(outside.part.before.vat))
      .minus(toDec(inside.part.before.vat)),
    0,
  )
  const wanted = [outside.vat, inside.vat]
  const capped = outside.vat.plus(inside.vat).gt(rateLeft)
  const vats = capped ? splitDecimals(rateLeft, wanted, digits) : wanted
  // Two kinds' roundings on one note can add up past the rule's slack (by under half a fils, about 3 in
  // 10,000 notes that finish one kind and not the other): the kind still running gives a fils back, and
  // its running total takes it up on its next note.
  if (!capped && outside.at.length > 0 && inside.at.length > 0) {
    const taxable = outside.typed.plus(inside.typed).minus(vats[1]!)
    const off = vats[0]!.plus(vats[1]!).minus(exactProduct([taxable, r]).dividedBy(100))
    const unit = pow10(-digits)
    if (off.abs().gt(unit.times(CREDIT_NOTE_VAT_SLACK_MINOR_UNITS))) {
      const k = inside.part.takesAllLeft ? 0 : 1
      const kind = kinds[k]!
      if (!kind.part.takesAllLeft) {
        const moved = vats[k]!.plus(off.gt(0) ? unit.negated() : unit)
        vats[k] = Dec.min(Dec.max(moved, 0), kind.most)
      }
    }
  }
  const shares = lines.map(() => '0')
  kinds.forEach((kind, k) => {
    splitDecimals(vats[k]!, kind.weights, digits).forEach((share, j) => {
      shares[kind.at[j]!] = plain(share)
    })
  })
  return shares
}

/** What a set of credit lines takes back in all (positive): Σ of their nets, VAT and totals. */
export function creditTotals(
  lines: readonly { readonly net: string; readonly vat: string; readonly total: string }[],
): { net: string; vat: string; total: string } {
  const abs = (value: string) => plain(toDec(value).abs())
  return {
    net: sumDecimals(lines.map((l) => abs(l.net))),
    vat: sumDecimals(lines.map((l) => abs(l.vat))),
    total: sumDecimals(lines.map((l) => abs(l.total))),
  }
}

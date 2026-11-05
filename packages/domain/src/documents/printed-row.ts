import type { VatCategory } from '../catalog/keys'
import { fixed, roundHalfUp, toDec } from '../numbers/decimal'
import type { Money } from '../numbers/kinds'
import { currencyMinorUnit, type CurrencyCode } from '../numbers/rounding'
import { rateKey } from './invoice'

// A row of an invoice or a credit note as it prints (D-360; the owner's request of 2026-11-04): unit
// price, quantity, discount, before VAT, VAT, total, so a reader can check each row with a calculator.
//
//   - A price before VAT: unit price × qty − discount = before VAT; before VAT + VAT = total.
//   - A price typed with VAT (marked so on its row): unit price × qty − discount = total; before VAT +
//     VAT = total. The price stays as it was typed and asked: the shelf price with its VAT, which no
//     price before VAT of 2 or 4 decimals could carry exactly (D-220: 3 × 10.00 with VAT is 28.57 + 1.43,
//     and three single cups of 10.00 are 9.52, 9.52 and 9.53 before VAT).
//
// The discount printed is what separates quantity × price from the amount it leads to: the line's own
// discount, its share of the document's discount and of "Round the total" (D-220's and D-221's splits),
// all in the line's basis. It is worked out from what prints, never stored, so it reads right on every
// document: a credit note that takes back all that is left of a discounted line keeps the line's price
// and quantity and stores no discount of its own. A total rounded UP gives a negative discount (−5.00):
// it is what makes the row add up, and the totals' "Rounding adjustment" says the same. The last of a
// line's returns in parts can too, by a fils, even on a line never discounted: it takes exactly what is
// left, so the rounding of the returns before it shows here as 0.01 or −0.01 (2.5 × 101.01 returned as
// 1.2 and 1.3 reads 1.3 × 101.01 − (−0.01) = 131.32). Never clamped: the row must add up (D-360).

/** What a row is made from (the line's stored amounts). */
export interface PrintedRowInput {
  /** As stored: a deposit taken off has −1, its price positive. */
  readonly qty: string
  readonly unitPrice: string
  /** The price was typed with VAT (only ever true for a business registered for VAT). */
  readonly priceIncludesVat: boolean
  /** Null for a business not registered for VAT. */
  readonly vatRate: string | null
  /** Before VAT, after every discount and adjustment. */
  readonly net: string
  /** net + VAT. */
  readonly total: string
}

export interface PrintedRow {
  /** A taxed line whose price includes VAT: its row reads to the total, and says so. */
  readonly includesVat: boolean
  /** qty × unit price, rounded half away from zero to the currency's minor unit (the engine's rule). */
  readonly asTyped: Money
  /**
   * asTyped − (total when `includesVat`, else net); below zero when a total was rounded up, or by a fils
   * on the last of a line's returns in parts (see above).
   */
  readonly discount: Money
}

/** The row of a line (see above). Throws RangeError for a value that is not a decimal string. */
export function printedRow(line: PrintedRowInput, currency: CurrencyCode): PrintedRow {
  const digits = currencyMinorUnit(currency)
  const includesVat = line.priceIncludesVat && line.vatRate !== null && toDec(line.vatRate).gt(0)
  const asTyped = roundHalfUp(toDec(line.qty).times(toDec(line.unitPrice)), digits)
  const reached = toDec(includesVat ? line.total : line.net)
  return {
    includesVat,
    asTyped: fixed(asTyped, digits) as Money,
    discount: fixed(asTyped.minus(reached), digits) as Money,
  }
}

/**
 * The VAT column of a document (ER Art. 59(1)(h), each item's rate): one rate, said once in its heading
 * (`one`), or several (`mixed`): each row then says its own. `none`: no line carries VAT.
 */
export type PrintedVatColumn =
  | { readonly kind: 'none' }
  | { readonly kind: 'one'; readonly vatCategory: VatCategory; readonly vatRate: string }
  | { readonly kind: 'mixed' }

/** The VAT column of a document's lines. */
export function printedVatColumn(
  lines: readonly { readonly vatCategory: VatCategory | null; readonly vatRate: string | null }[],
): PrintedVatColumn {
  const taxed = lines.flatMap((line) =>
    line.vatCategory === null
      ? []
      : [{ vatCategory: line.vatCategory, vatRate: line.vatRate ?? '0' }],
  )
  const first = taxed[0]
  if (!first) return { kind: 'none' }
  return new Set(taxed.map(rateKey)).size === 1
    ? { kind: 'one', vatCategory: first.vatCategory, vatRate: first.vatRate }
    : { kind: 'mixed' }
}

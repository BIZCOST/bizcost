import type { InvoiceLineDto } from '@bizcost/contracts'
import { compareDecimal, printedRow, subtractDecimals, type CurrencyCode } from '@bizcost/domain'

// What the invoice page shows of each line, as the invoice's PDF prints it (D-360, printedRow): unit
// price, quantity, discount, before VAT, VAT, total, so a row on the screen and on the paper are the
// same numbers. A deposit taken off reads 1 × its price below zero (stored −1 × its price).

/**
 * Whether a credit note can still take something back of a line: what is left of it as its prices are
 * typed, as the API reads it. Its total is no guide: VAT is shared per note, so a line priced before VAT
 * and taken back whole can keep a fils of VAT left (30.30 + 10.10, returned second line first: 0.01 and
 * −0.01), with nothing a note could take.
 */
export function lineHasLeft(line: Pick<InvoiceLineDto, 'kind' | 'priceIncludesVat' | 'left'>) {
  if (line.kind === 'deduction') return false
  return compareDecimal(line.priceIncludesVat ? line.left.total : line.left.net, '0') > 0
}

/** The amounts of a line's row, as decimal strings. */
export interface InvoiceLineRow {
  readonly unitPrice: string
  readonly qty: string
  readonly discount: string
  readonly beforeVat: string
  readonly vat: string
  readonly total: string
  /** A price typed with VAT: its row reads to the total, and says so. */
  readonly includesVat: boolean
}

type RowSource = Pick<
  InvoiceLineDto,
  'kind' | 'qty' | 'unitPrice' | 'priceIncludesVat' | 'vatRate' | 'net' | 'vat' | 'total'
>

export function invoiceLineRow(line: RowSource, currency: string): InvoiceLineRow {
  const row = printedRow(
    {
      qty: line.qty,
      unitPrice: line.unitPrice,
      priceIncludesVat: line.priceIncludesVat,
      vatRate: line.vatRate,
      net: line.net,
      total: line.total,
    },
    currency as CurrencyCode,
  )
  const deduction = line.kind === 'deduction'
  return {
    unitPrice: deduction ? subtractDecimals('0', line.unitPrice) : line.unitPrice,
    qty: deduction ? '1' : line.qty,
    discount: row.discount,
    beforeVat: line.net,
    vat: line.vat,
    total: line.total,
    includesVat: row.includesVat,
  }
}

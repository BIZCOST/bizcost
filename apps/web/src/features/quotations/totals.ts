import {
  printedSubtotal,
  subtractDecimals,
  type CurrencyCode,
  type Money,
  type Percent,
  type VatCategory,
} from '@bizcost/domain'

// A quotation's totals as its screens show them and its PDF prints them (M3 Step 7; D-220, D-221,
// D-296): the subtotal and the discount in one basis with the total before VAT, so the rows add up.

export interface QuotationTotalsValues {
  /** Σ of the lines after their own discounts (before VAT when a price includes VAT). */
  readonly lines: string
  /** The discount on the whole quotation (an amount, positive; in the same basis). */
  readonly discount: string
  readonly adjustment: string
  readonly net: string
  readonly rates: readonly {
    readonly vatCategory: VatCategory | null
    readonly vatRate: string | null
    readonly net: string
    readonly vat: string
  }[]
  readonly total: string
  readonly difference: string
  readonly payable: string
}

/** The totals of a quotation from its lines' and its own amounts (the API's or the editor's). */
export function totalsOf(source: {
  readonly currency: string
  readonly lines: readonly {
    readonly subtotal: string
    readonly discount: string
    readonly priceIncludesVat: boolean
    readonly vatRate: string | null
  }[]
  readonly documentDiscount: string
  readonly adjustment: string
  readonly net: string
  readonly rates: QuotationTotalsValues['rates']
  readonly total: string
  readonly difference: string
  readonly payable: string
}): QuotationTotalsValues {
  const printed = printedSubtotal(
    source.lines.map((line) => ({
      amount: subtractDecimals(line.subtotal, line.discount) as Money,
      priceIncludesVat: line.priceIncludesVat,
      vatRate: line.vatRate as Percent | null,
    })),
    {
      documentDiscount: source.documentDiscount as Money,
      net: source.net as Money,
      adjustment: source.adjustment as Money,
    },
    source.currency as CurrencyCode,
  )
  return {
    lines: printed.subtotal,
    discount: printed.discount,
    adjustment: source.adjustment,
    net: source.net,
    rates: source.rates,
    total: source.total,
    difference: source.difference,
    payable: source.payable,
  }
}

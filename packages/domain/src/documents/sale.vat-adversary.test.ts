import { describe, expect, it } from 'vitest'
import { toDec } from '../numbers/decimal'
import type { Money, Percent, Quantity } from '../numbers/kinds'
import { computeSale, saleError, type SaleLineInput } from './sale'

// Adversary cases for sales documents (M3 Step 1, D-220). A product's price includes VAT or not per
// product (D-121), so one sale can hold both kinds of line. The document discount is "typed like the
// prices" (sale.ts), which has no single meaning on such a sale: the amount would come off gross on one
// line and before VAT on the other. Each case below failed against the engine as first built; the
// engine now refuses such a discount (`document_discount_mixed_prices`, D-220).

const item = (unitPrice: string, priceIncludesVat: boolean): SaleLineInput => ({
  kind: 'item',
  qty: '1' as Quantity,
  unitPrice: unitPrice as Money,
  priceIncludesVat,
  vatCategory: 'standard',
})
// A croissant priced 100 before VAT and a cake priced 105 with VAT: 200.00 + VAT 10.00 = 210.00.
const lines = [item('100', false), item('105', true)]

describe('a document discount on a sale with prices before VAT and prices with VAT', () => {
  it('AED 10.00 off takes 10.00 off the total with VAT, or 10.00 off the net; it is refused otherwise', () => {
    const input = { lines, vatRegistered: true, discount: { amount: '10' as Money } }
    if (saleError(input, 'AED') !== null) return
    const before = computeSale({ lines, vatRegistered: true }, 'AED')
    const after = computeSale(input, 'AED')
    // As built: 210.00 → 199.75 (10.25 off with VAT) and 200.00 → 190.24 (9.76 off before VAT),
    // while the document says its discount is 10.00.
    const offTotal = toDec(before.total).minus(toDec(after.total))
    const offNet = toDec(before.net).minus(toDec(after.net))
    expect(offTotal.eq(toDec('10')) || offNet.eq(toDec('10'))).toBe(true)
  })

  it('10 % off: the document discount it prints is what came off, before VAT or with it', () => {
    const input = { lines, vatRegistered: true, discount: { percent: '10' as Percent } }
    if (saleError(input, 'AED') !== null) return
    const before = computeSale({ lines, vatRegistered: true }, 'AED')
    const after = computeSale(input, 'AED')
    // As built: documentDiscount 20.50, while 20.00 came off the net and 21.00 off the total.
    const printed = toDec(after.documentDiscount)
    const offTotal = toDec(before.total).minus(toDec(after.total))
    const offNet = toDec(before.net).minus(toDec(after.net))
    expect(printed.eq(offTotal) || printed.eq(offNet)).toBe(true)
  })
})

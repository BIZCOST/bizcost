import {
  computeSale,
  solveRoundAmount,
  sumDecimals,
  type Money,
  type Quantity,
} from '@bizcost/domain'
import { describe, expect, it } from 'vitest'
import { totalsOf } from './totals'

// A quotation's totals on the screen add up as printed (M3 Step 7 review, D-296): the subtotal, less
// the discount, plus the "Round the total" adjustment, is the total before VAT, also when prices
// include VAT (then both are before VAT, as the PDF prints them). Fictional amounts.

const line = (unitPrice: string, priceIncludesVat: boolean) => ({
  kind: 'item' as const,
  qty: '1' as Quantity,
  unitPrice: unitPrice as Money,
  priceIncludesVat,
  vatCategory: 'standard' as const,
})

function rowsAddUp(amounts: ReturnType<typeof computeSale>) {
  const totals = totalsOf({
    currency: 'AED',
    lines: amounts.lines,
    documentDiscount: amounts.documentDiscount,
    adjustment: amounts.adjustment,
    net: amounts.net,
    rates: amounts.rates,
    total: amounts.total,
    difference: amounts.roundingDifference,
    payable: amounts.payable,
  })
  const added = sumDecimals([totals.lines, `-${totals.discount}`, totals.adjustment])
  expect(Number(added)).toBe(Number(totals.net))
  return totals
}

describe('the totals add up as printed', () => {
  it('prices before VAT: the lines as typed and the discount', () => {
    const amounts = computeSale(
      { lines: [line('1000', false)], vatRegistered: true, discount: { amount: '100' as Money } },
      'AED',
    )
    expect(rowsAddUp(amounts)).toMatchObject({ lines: '1000.00', discount: '100.00' })
  })

  it('prices with VAT, a 10 % discount: 1,000.00 less 100.00 before VAT', () => {
    const amounts = computeSale(
      { lines: [line('1050', true)], vatRegistered: true, discount: { percent: '10' as never } },
      'AED',
    )
    expect(rowsAddUp(amounts)).toMatchObject({
      lines: '1000.00',
      discount: '100.00',
      net: '900.00',
    })
  })

  it('a price with VAT rounded from 1,120.00 to 1,100.00: 1,066.67 then −19.05 before VAT', () => {
    const solved = solveRoundAmount(
      { lines: [line('1120', true)], vatRegistered: true },
      '1100' as Money,
      'AED',
    )
    expect(rowsAddUp(solved.sale)).toMatchObject({ lines: '1066.67', discount: '0.00' })
  })
})

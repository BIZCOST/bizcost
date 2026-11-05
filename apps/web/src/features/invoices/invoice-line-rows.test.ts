import {
  computeSale,
  solveRoundAmount,
  type Money,
  type Quantity,
  type SaleInput,
} from '@bizcost/domain'
import { describe, expect, it } from 'vitest'
import { invoiceLineRow, lineHasLeft } from './invoice-line-rows'

// The invoice page shows each line's row as the PDF prints it (D-360). Fictional amounts.

const item = (qty: string, unitPrice: string, priceIncludesVat = false) => ({
  kind: 'item' as const,
  qty: qty as Quantity,
  unitPrice: unitPrice as Money,
  priceIncludesVat,
  vatCategory: 'standard' as const,
})

const rowsOf = (input: SaleInput, wanted?: string) => {
  const sale = wanted
    ? solveRoundAmount(input, wanted as Money, 'AED').sale
    : computeSale(input, 'AED')
  return sale.lines.map((line, i) =>
    invoiceLineRow(
      {
        kind: 'item',
        qty: input.lines[i]!.qty,
        unitPrice: input.lines[i]!.unitPrice,
        priceIncludesVat: line.priceIncludesVat,
        vatRate: line.vatRate,
        net: line.net,
        vat: line.vat,
        total: line.total,
      },
      'AED',
    ),
  )
}

describe('a row on the invoice page', () => {
  it('no discount is 0.00, and the row reads to before VAT', () => {
    expect(rowsOf({ vatRegistered: true, lines: [item('120', '45')] })).toEqual([
      {
        unitPrice: '45',
        qty: '120',
        discount: '0.00',
        beforeVat: '5400.00',
        vat: '270.00',
        total: '5670.00',
        includesVat: false,
      },
    ])
  })

  it('holds its share of the document\'s discount and of "Round the total"', () => {
    const [row] = rowsOf(
      { vatRegistered: true, lines: [item('1', '1000')], discount: { amount: '100' as Money } },
      '900.00',
    )
    // 1,000 − 142.86 = 857.14 before VAT + 42.86 VAT = 900.00.
    expect(row).toMatchObject({ discount: '142.86', beforeVat: '857.14', total: '900.00' })
  })

  it('a price with VAT reads to the total, and says so', () => {
    const [row] = rowsOf({ vatRegistered: true, lines: [item('3', '10', true)] })
    expect(row).toMatchObject({
      unitPrice: '10',
      discount: '0.00',
      beforeVat: '28.57',
      vat: '1.43',
      total: '30.00',
      includesVat: true,
    })
  })

  it('a deposit taken off reads 1 × its price below zero', () => {
    expect(
      invoiceLineRow(
        {
          kind: 'deduction',
          qty: '-1',
          unitPrice: '5000',
          priceIncludesVat: false,
          vatRate: '5',
          net: '-5000',
          vat: '-250',
          total: '-5250',
        },
        'AED',
      ),
    ).toEqual({
      unitPrice: '-5000',
      qty: '1',
      discount: '0.00',
      beforeVat: '-5000',
      vat: '-250',
      total: '-5250',
      includesVat: false,
    })
  })
})

describe('whether a credit note can still take something back of a line', () => {
  const line = (priceIncludesVat: boolean, net: string, vat: string, total: string) => ({
    kind: 'item' as const,
    priceIncludesVat,
    left: { qty: '0', net, vat, total },
  })

  it('reads what is left as the prices are typed, not the fils of VAT a note left behind', () => {
    // 30.30 + 10.10 before VAT, returned second line first (through the API): 0.01 and -0.01 of VAT left
    // on two lines nothing can take back; the invoice owes nothing.
    expect(lineHasLeft(line(false, '0', '0.01', '0.01'))).toBe(false)
    expect(lineHasLeft(line(false, '0', '-0.01', '-0.01'))).toBe(false)
    expect(lineHasLeft(line(true, '0.01', '-0.01', '0'))).toBe(false)
    // What is really left, even when its total reads nothing.
    expect(lineHasLeft(line(false, '0.01', '-0.01', '0'))).toBe(true)
    expect(lineHasLeft(line(false, '100', '5', '105'))).toBe(true)
    expect(lineHasLeft(line(true, '100', '5', '105'))).toBe(true)
  })

  it('never a deposit taken off', () => {
    expect(lineHasLeft({ ...line(false, '100', '5', '105'), kind: 'deduction' as const })).toBe(
      false,
    )
  })
})

import { describe, expect, it } from 'vitest'
import type { Money, Percent, Quantity } from '../numbers/kinds'
import type { LineDiscount } from './line'
import { vatInCost } from '../purchasing/keys'
import {
  computePurchase,
  purchaseError,
  type PurchaseInput,
  type PurchaseLineInput,
} from './purchase'
import { splitByWeights, sumDecimals } from './split'

// A purchase's amounts and what its goods cost (D-114 rule 4): discounts before VAT, the document
// discount and the delivery split by line net (largest remainder, D-142), VAT in the cost only when
// it cannot be reclaimed.

const m = (value: string) => value as Money
const material = (
  qty: string,
  unitPrice: string,
  vatRate = '0',
  discount: LineDiscount | null = null,
): PurchaseLineInput => ({
  kind: 'material',
  qty: qty as Quantity,
  unitPrice: m(unitPrice),
  vatRate: vatRate as Percent,
  discount,
})
const delivery = (amount: string, vatRate = '0'): PurchaseLineInput => ({
  kind: 'delivery',
  amount: m(amount),
  vatRate: vatRate as Percent,
})
const buy = (input: Partial<PurchaseInput> & Pick<PurchaseInput, 'lines'>) =>
  computePurchase({ vatInCost: true, ...input }, 'AED')

describe('the owner’s milk purchases', () => {
  it('50 L at AED 6 costs 300; 100 L at AED 7 costs 700', () => {
    expect(buy({ lines: [material('50', '6')] }).lines[0]?.cost).toBe('300.00')
    expect(buy({ lines: [material('100', '7')] }).cost).toBe('700.00')
  })

  it('the carton: 1 carton of 12 × 1 L for AED 72 costs 72', () => {
    const purchase = buy({ lines: [material('1', '72')] })
    expect(purchase).toMatchObject({
      subtotal: '72.00',
      net: '72.00',
      total: '72.00',
      cost: '72.00',
    })
  })
})

describe('VAT in or out of the cost (D-114 rule 4)', () => {
  const cases = [
    // registered, document type, marked "can't be reclaimed" → VAT in cost
    [true, 'tax_invoice', false, false],
    [true, 'tax_invoice', true, true],
    [true, 'non_tax_invoice', false, true],
    [true, 'no_invoice', false, true],
    [false, 'tax_invoice', false, true],
    [false, 'non_tax_invoice', false, true],
    [false, 'no_invoice', false, true],
  ] as const
  it.each(cases)(
    'registered %s, %s, marked not reclaimable %s → VAT in cost %s',
    (vatRegistered, documentType, vatNotReclaimable, expected) => {
      const inCost = vatInCost({ vatRegistered, documentType, vatNotReclaimable })
      expect(inCost).toBe(expected)
      const purchase = computePurchase(
        { lines: [material('10', '10', '5')], vatInCost: inCost },
        'AED',
      )
      expect(purchase).toMatchObject({ net: '100.00', vat: '5.00', total: '105.00' })
      expect(purchase.cost).toBe(expected ? '105.00' : '100.00')
    },
  )
})

describe('discounts come before VAT', () => {
  it('a line discount (% or amount), then VAT on what is left', () => {
    const purchase = buy({
      lines: [
        material('10', '10', '5', { percent: '10' as Percent }),
        material('1', '50', '5', { amount: m('5') }),
      ],
      vatInCost: false,
    })
    expect(purchase.lines.map((l) => [l.subtotal, l.discount, l.net, l.vat, l.total])).toEqual([
      ['100.00', '10.00', '90.00', '4.50', '94.50'],
      ['50.00', '5.00', '45.00', '2.25', '47.25'],
    ])
    expect(purchase).toMatchObject({
      discount: '15.00',
      net: '135.00',
      vat: '6.75',
      total: '141.75',
    })
    expect(purchase.lines.map((l) => l.cost)).toEqual(['90.00', '45.00'])
  })

  it('the document discount is split by line net, the missing cent to the line that lost most', () => {
    const purchase = buy({
      lines: [material('1', '10'), material('1', '10'), material('1', '10.01')],
      discount: { amount: m('10') },
    })
    // 10 × 10 ÷ 30.01 = 3.33, 3.33, 10 × 10.01 ÷ 30.01 = 3.34: they add up to 10 exactly.
    expect(purchase.lines.map((l) => l.documentDiscount)).toEqual(['3.33', '3.33', '3.34'])
    expect(purchase.lines.map((l) => l.taxable)).toEqual(['6.67', '6.67', '6.67'])
    expect(purchase).toMatchObject({ documentDiscount: '10.00', discount: '10.00', net: '20.01' })
  })

  it('on a tie the missing cents go to the larger weight, then the first line', () => {
    expect(splitByWeights('10', ['10', '10', '10'], 2)).toEqual(['3.34', '3.33', '3.33'])
    expect(splitByWeights('0.01', ['1', '3', '3'], 2)).toEqual(['0.00', '0.01', '0.00'])
    expect(splitByWeights('9', ['0', '0', '0'], 2)).toEqual(['3.00', '3.00', '3.00'])
    expect(splitByWeights('0', [], 2)).toEqual([])
    expect(() => splitByWeights('1', [], 2)).toThrow(RangeError)
    expect(() => splitByWeights('-1', ['1'], 2)).toThrow(RangeError)
  })

  it('a document discount in percent of the lines’ net, VAT on what is left', () => {
    const purchase = buy({
      lines: [material('3', '33.33', '5'), material('2', '10', '5')],
      discount: { percent: '10' as Percent },
      vatInCost: false,
    })
    // net 99.99 + 20 = 119.99; 10 % = 12.00 split 10.00 / 2.00
    expect(purchase.documentDiscount).toBe('12.00')
    expect(purchase.lines.map((l) => [l.documentDiscount, l.taxable, l.vat])).toEqual([
      ['10.00', '89.99', '4.50'],
      ['2.00', '18.00', '0.90'],
    ])
    expect(purchase).toMatchObject({ net: '107.99', vat: '5.40', total: '113.39', cost: '107.99' })
  })
})

describe('delivery on the same invoice becomes part of the goods’ cost', () => {
  it('is split over the material lines by net amount, with its VAT when VAT is in cost', () => {
    const lines = [material('1', '300', '5'), material('1', '100', '5'), delivery('20', '5')]
    const reclaimable = computePurchase({ lines, vatInCost: false }, 'AED')
    expect(reclaimable.lines.map((l) => [l.deliveryShare, l.cost])).toEqual([
      ['15.00', '315.00'],
      ['5.00', '105.00'],
      ['0.00', '0.00'],
    ])
    expect(reclaimable).toMatchObject({
      net: '420.00',
      vat: '21.00',
      total: '441.00',
      cost: '420.00',
    })

    const notReclaimable = computePurchase({ lines, vatInCost: true }, 'AED')
    expect(notReclaimable.lines.map((l) => [l.deliveryShare, l.cost])).toEqual([
      ['15.75', '330.75'],
      ['5.25', '110.25'],
      ['0.00', '0.00'],
    ])
    expect(notReclaimable.cost).toBe('441.00')
  })

  it('the line costs always add up to what was paid for the goods', () => {
    const purchase = buy({
      lines: [material('3', '1.11', '5'), material('7', '2.22', '5'), delivery('9.99', '5')],
      discount: { amount: m('1.01') },
    })
    expect(sumDecimals(purchase.lines.map((l) => l.cost))).toBe(sumDecimals([purchase.total]))
    expect(purchase.cost).toBe(purchase.total)
  })
})

describe('rounding to the currency', () => {
  it('KWD keeps 3 decimals', () => {
    const purchase = computePurchase(
      { lines: [material('3', '0.3335', '5')], vatInCost: true },
      'KWD',
    )
    expect(purchase).toMatchObject({
      subtotal: '1.001',
      vat: '0.050',
      total: '1.051',
      cost: '1.051',
    })
  })
})

describe('errors', () => {
  it('names the problem and the line', () => {
    expect(purchaseError({ lines: [delivery('5')], vatInCost: true }, 'AED')).toEqual({
      code: 'no_material_line',
    })
    expect(
      purchaseError(
        { lines: [material('1', '10')], discount: { amount: m('10.01') }, vatInCost: true },
        'AED',
      ),
    ).toEqual({ code: 'document_discount_over_net' })
    expect(
      purchaseError(
        {
          lines: [material('1', '10')],
          discount: { percent: '100.5' as Percent },
          vatInCost: true,
        },
        'AED',
      ),
    ).toEqual({ code: 'document_discount_over_100_percent' })
    expect(
      purchaseError({ lines: [material('1', '10'), material('1', '-1')], vatInCost: true }, 'AED'),
    ).toEqual({ code: 'negative_price', line: 1 })
    expect(
      purchaseError(
        { lines: [material('1', '10', '0', { amount: m('11') })], vatInCost: true },
        'AED',
      ),
    ).toEqual({ code: 'discount_over_subtotal', line: 0 })
    expect(() => buy({ lines: [delivery('1')] })).toThrow(/no_material_line/)
  })

  it('an empty draft computes to zeros', () => {
    expect(buy({ lines: [] })).toMatchObject({ subtotal: '0.00', total: '0.00', cost: '0.00' })
  })
})

describe('proportionOf', () => {
  it('takes a share with one rounding', async () => {
    const { proportionOf } = await import('./split')
    expect(proportionOf('120000', '3', '10', 6)).toBe('36000.000000')
    expect(proportionOf('10', '1', '3', 2)).toBe('3.33')
    expect(proportionOf('10', '2', '3', 2)).toBe('6.67')
    expect(() => proportionOf('1', '1', '0', 2)).toThrow(RangeError)
  })
})

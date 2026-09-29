import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { Dec, fixed, toDec } from '../numbers/decimal'
import type { Money, Percent, Quantity } from '../numbers/kinds'
import type { CurrencyCode } from '../numbers/rounding'
import type { LineDiscount } from './line'
import { computePurchase, type PurchaseInput, type PurchaseLineInput } from './purchase'
import { sumDecimals } from './split'

// Prices typed with their VAT (the owner's request of 2026-09-29): a line's gross = qty × price − its
// discount, VAT = round(gross × rate ÷ (100 + rate)), net = gross − VAT; every amount returned keeps
// its before-VAT meaning, so posting and the average read both modes the same way.

const m = (value: string) => value as Money
const material = (
  qty: string,
  unitPrice: string,
  vatRate = '5',
  discount: LineDiscount | null = null,
): PurchaseLineInput => ({
  kind: 'material',
  qty: qty as Quantity,
  unitPrice: m(unitPrice),
  vatRate: vatRate as Percent,
  discount,
})
const delivery = (amount: string, vatRate = '5'): PurchaseLineInput => ({
  kind: 'delivery',
  amount: m(amount),
  vatRate: vatRate as Percent,
})
const withVat = (input: Omit<PurchaseInput, 'pricesIncludeVat'>, currency: CurrencyCode = 'AED') =>
  computePurchase({ ...input, pricesIncludeVat: true }, currency)

describe('a line typed with its VAT', () => {
  it('105 including 5 % is 100 + 5', () => {
    const purchase = withVat({ lines: [material('1', '105')], vatInCost: false })
    expect(purchase.lines[0]).toMatchObject({
      subtotal: '100.00',
      discount: '0.00',
      net: '100.00',
      documentDiscount: '0.00',
      taxable: '100.00',
      vat: '5.00',
      total: '105.00',
      cost: '100.00',
    })
    expect(purchase).toMatchObject({
      subtotal: '100.00',
      net: '100.00',
      vat: '5.00',
      total: '105.00',
    })
  })

  it('takes the VAT out of each line once, rounded to the fils', () => {
    // 3 × 10.50 = 31.50: VAT 31.50 × 5 ÷ 105 = 1.50. 10.00: VAT 0.476… → 0.48, net 9.52.
    const purchase = withVat({
      lines: [material('3', '10.5'), material('1', '10')],
      vatInCost: false,
    })
    expect(purchase.lines.map((l) => [l.taxable, l.vat, l.total])).toEqual([
      ['30.00', '1.50', '31.50'],
      ['9.52', '0.48', '10.00'],
    ])
    expect(purchase).toMatchObject({ net: '39.52', vat: '1.98', total: '41.50', cost: '39.52' })
  })

  it('VAT in the cost: the goods cost what was paid', () => {
    const purchase = withVat({ lines: [material('1', '105')], vatInCost: true })
    expect(purchase.lines[0]?.cost).toBe('105.00')
    expect(purchase.cost).toBe('105.00')
  })

  it('no VAT: the price is what the goods cost', () => {
    const purchase = withVat({ lines: [material('2', '7.5', '0')], vatInCost: true })
    expect(purchase).toMatchObject({ net: '15.00', vat: '0.00', total: '15.00', cost: '15.00' })
  })

  it('the line discount comes off the price with its VAT', () => {
    // 10 × 10.50 = 105.00 − 10 % (10.50) = 94.50 → VAT 4.50, net 90.00; before the discount the
    // subtotal is 100.00 before VAT, so the discount before VAT is 10.00.
    const purchase = withVat({
      lines: [material('10', '10.5', '5', { percent: '10' as Percent })],
      vatInCost: false,
    })
    expect(purchase.lines[0]).toMatchObject({
      subtotal: '100.00',
      discount: '10.00',
      net: '90.00',
      taxable: '90.00',
      vat: '4.50',
      total: '94.50',
    })
    expect(purchase).toMatchObject({ discount: '10.00', net: '90.00', total: '94.50' })
  })

  it('the document discount is split by the lines’ gross and comes off before VAT is taken out', () => {
    // Gross 210.00 + 100.00 (no VAT) = 310.00; 10 % = 31.00, split 21.00 / 10.00.
    const purchase = withVat({
      lines: [material('2', '105'), material('1', '100', '0')],
      discount: { percent: '10' as Percent },
      vatInCost: false,
    })
    expect(
      purchase.lines.map((l) => [l.net, l.documentDiscount, l.taxable, l.vat, l.total]),
    ).toEqual([
      ['200.00', '20.00', '180.00', '9.00', '189.00'],
      ['100.00', '10.00', '90.00', '0.00', '90.00'],
    ])
    // Each line pays 10 % less whatever its VAT rate.
    expect(purchase).toMatchObject({
      documentDiscount: '30.00',
      discount: '30.00',
      net: '270.00',
      vat: '9.00',
      total: '279.00',
    })
  })

  it('delivery typed with its VAT is split by the lines’ net before VAT', () => {
    // Lines 315.00 and 100.00 (no VAT): nets 300.00 and 100.00. Delivery 21.00 with VAT = 20 + 1.
    const lines = [material('1', '315'), material('1', '100', '0'), delivery('21')]
    const reclaimable = withVat({ lines, vatInCost: false })
    expect(reclaimable.lines.map((l) => [l.deliveryShare, l.cost])).toEqual([
      ['15.00', '315.00'],
      ['5.00', '105.00'],
      ['0.00', '0.00'],
    ])
    expect(reclaimable.lines[2]).toMatchObject({ taxable: '20.00', vat: '1.00', total: '21.00' })
    expect(reclaimable).toMatchObject({ net: '420.00', vat: '16.00', total: '436.00' })
    const inCost = withVat({ lines, vatInCost: true })
    expect(inCost.lines.map((l) => l.deliveryShare)).toEqual(['15.75', '5.25', '0.00'])
    expect(inCost.cost).toBe(inCost.total)
  })

  it('KWD keeps 3 decimals', () => {
    const purchase = withVat({ lines: [material('1', '1.001')], vatInCost: false }, 'KWD')
    // 1.001 × 5 ÷ 105 = 0.04766… → 0.048
    expect(purchase).toMatchObject({ net: '0.953', vat: '0.048', total: '1.001' })
  })
})

// ---------------------------------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------------------------------

const qtyArb = fc
  .integer({ min: 1, max: 5_000_000 })
  .map((n) => toDec(String(n)).dividedBy(1000).toString())
const priceArb = fc
  .integer({ min: 0, max: 50_000_000 })
  .map((n) => toDec(String(n)).dividedBy(10_000).toString())
const rateArb = fc.constantFrom('0', '5', '15', '12.5')
const currencyArb = fc.constantFrom<CurrencyCode>('AED', 'KWD')

/** A price with 4 decimals, rounded up: qty × it is at least `amount`. */
function priceAtLeast(amount: string, qty: string): string {
  return toDec(amount).dividedBy(toDec(qty)).toDecimalPlaces(4, Dec.ROUND_UP).toString()
}

describe('properties', () => {
  it('a purchase typed before VAT and the same one typed with VAT (each line’s total as its gross) agree', () => {
    fc.assert(
      fc.property(
        currencyArb,
        fc.array(
          fc.record({
            qty: qtyArb,
            price: priceArb,
            rate: rateArb,
            discountPercent: fc.option(fc.integer({ min: 0, max: 100 }), { nil: null }),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        fc.array(fc.record({ amount: priceArb, rate: rateArb }), { maxLength: 2 }),
        fc.boolean(),
        (currency, materials, deliveries, vatInCost) => {
          const before = computePurchase(
            {
              lines: [
                ...materials.map((l) =>
                  material(
                    l.qty,
                    l.price,
                    l.rate,
                    l.discountPercent === null
                      ? null
                      : { percent: String(l.discountPercent) as Percent },
                  ),
                ),
                ...deliveries.map((d) => delivery(d.amount, d.rate)),
              ],
              vatInCost,
            },
            currency,
          )
          // The same goods typed with VAT: the same quantity, a price rounded up, and a discount that
          // brings the line to the total it had before VAT.
          const lines = [
            ...materials.map((l, i) => {
              const total = before.lines[i]!.total
              const price = priceAtLeast(total, l.qty)
              const gross = fixed(toDec(l.qty).times(toDec(price)), currency === 'KWD' ? 3 : 2)
              const off = toDec(gross).minus(toDec(total))
              return material(
                l.qty,
                price,
                l.rate,
                off.gt(0) ? { amount: m(off.toString()) } : null,
              )
            }),
            ...deliveries.map((d, k) =>
              delivery(before.lines[materials.length + k]!.total, d.rate),
            ),
          ]
          const after = withVat({ lines, vatInCost }, currency)
          const pick = (l: (typeof before.lines)[number]) => [
            l.taxable,
            l.vat,
            l.total,
            l.deliveryShare,
            l.cost,
          ]
          expect(after.lines.map(pick)).toEqual(before.lines.map(pick))
          expect([after.net, after.vat, after.total, after.cost]).toEqual([
            before.net,
            before.vat,
            before.total,
            before.cost,
          ])
        },
      ),
    )
  })

  it('with VAT typed, every line and the totals add up, and nothing is below zero', () => {
    fc.assert(
      fc.property(
        currencyArb,
        fc.array(fc.record({ qty: qtyArb, price: priceArb, rate: rateArb }), {
          minLength: 1,
          maxLength: 6,
        }),
        fc.array(fc.record({ amount: priceArb, rate: rateArb }), { maxLength: 2 }),
        fc.option(fc.integer({ min: 0, max: 100 }), { nil: null }),
        fc.boolean(),
        (currency, materials, deliveries, documentPercent, vatInCost) => {
          const digits = currency === 'KWD' ? 3 : 2
          const purchase = withVat(
            {
              lines: [
                ...materials.map((l) => material(l.qty, l.price, l.rate)),
                ...deliveries.map((d) => delivery(d.amount, d.rate)),
              ],
              discount:
                documentPercent === null ? null : { percent: String(documentPercent) as Percent },
              vatInCost,
            },
            currency,
          )
          const typed = [
            ...materials.map((l) => fixed(toDec(l.qty).times(toDec(l.price)), digits)),
            ...deliveries.map((d) => fixed(toDec(d.amount), digits)),
          ]
          const rates = [...materials.map((l) => l.rate), ...deliveries.map((d) => d.rate)]
          for (const [i, line] of purchase.lines.entries()) {
            for (const value of [
              line.subtotal,
              line.discount,
              line.net,
              line.documentDiscount,
              line.taxable,
              line.vat,
              line.deliveryShare,
              line.cost,
            ]) {
              expect(toDec(value).gte(0)).toBe(true)
            }
            expect(sumDecimals([line.net, line.discount])).toBe(sumDecimals([line.subtotal]))
            expect(sumDecimals([line.taxable, line.documentDiscount])).toBe(sumDecimals([line.net]))
            expect(sumDecimals([line.taxable, line.vat])).toBe(sumDecimals([line.total]))
            // VAT taken out of the gross once.
            const rate = toDec(rates[i]!)
            expect(line.vat).toBe(
              fixed(toDec(line.total).times(rate).dividedBy(rate.plus(100)), digits),
            )
            // The gross after the document discount is never more than what was typed.
            expect(toDec(line.total).lte(toDec(typed[i]!))).toBe(true)
          }
          // The lines' gross adds up to what was typed less the document discount (with its VAT).
          const typedMaterials = sumDecimals(typed.slice(0, materials.length))
          const documentGross =
            documentPercent === null
              ? '0'
              : fixed(toDec(typedMaterials).times(documentPercent).dividedBy(100), digits)
          expect(sumDecimals(purchase.lines.map((l) => l.total))).toBe(
            sumDecimals([sumDecimals(typed), `-${documentGross}`]),
          )
          expect(sumDecimals([purchase.net, purchase.vat])).toBe(sumDecimals([purchase.total]))
          expect(sumDecimals(purchase.lines.map((l) => l.cost))).toBe(
            sumDecimals([vatInCost ? purchase.total : purchase.net]),
          )
          expect(sumDecimals([purchase.subtotal, `-${purchase.discount}`])).toBe(
            sumDecimals([purchase.net]),
          )
        },
      ),
    )
  })
})

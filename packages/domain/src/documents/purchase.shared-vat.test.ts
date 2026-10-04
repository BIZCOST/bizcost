import type Decimal from 'decimal.js'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { exactProduct, fixed, toDec } from '../numbers/decimal'
import type { Money, Percent, Quantity } from '../numbers/kinds'
import { currencyMinorUnit, type CurrencyCode } from '../numbers/rounding'
import { computeLine, type LineDiscount } from './line'
import {
  computePurchase,
  purchaseError,
  type PurchaseAmounts,
  type PurchaseInput,
  type PurchaseLineAmounts,
  type PurchaseLineInput,
  type PurchaseMaterialLineInput,
} from './purchase'
import { splitByWeights } from './split'

// M3 Step 1 (D-220): the VAT taken out of an amount typed with it moved out of computePurchase into a
// helper shared with sales (vat.ts). A purchase's results must stay byte-identical: this file keeps a
// frozen copy of computePurchase as it was before the move (main at f1e0fb9) and compares every
// string of both results, over generated purchases in both price modes and every currency digit count.

const ZERO = '0'

function materialLine(line: PurchaseMaterialLineInput) {
  return {
    qty: line.qty,
    unitPrice: line.unitPrice,
    discount: line.discount,
    vatRate: line.vatRate,
  }
}

/** computePurchase before M3 Step 1, verbatim but for its name (its own VAT helper inline). */
function legacyComputePurchase(input: PurchaseInput, currency: CurrencyCode): PurchaseAmounts {
  const error = purchaseError(input, currency)
  if (error) {
    const where = error.line === undefined ? '' : ` (line ${error.line + 1})`
    throw new RangeError(`Invalid purchase: ${error.code}${where}`)
  }
  const digits = currencyMinorUnit(currency)
  const round = (value: Decimal) => toDec(fixed(value, digits))
  const print = (value: Decimal) => fixed(value, digits) as Money
  const includesVat = input.pricesIncludeVat === true
  const beforeVat = (amount: Decimal, rate: string) => {
    if (!includesVat) return amount
    const r = toDec(rate)
    return amount.minus(round(exactProduct([amount, r]).dividedBy(r.plus(100))))
  }
  const base = input.lines.map((line) => {
    if (line.kind === 'material') {
      const amounts = computeLine(materialLine(line), currency)
      return { line, subtotal: amounts.subtotal, discount: amounts.discount, net: amounts.net }
    }
    const amount = print(toDec(line.amount))
    return { line, subtotal: amount, discount: print(toDec(ZERO)), net: amount }
  })
  const materialIndexes = base.flatMap((b, i) => (b.line.kind === 'material' ? [i] : []))
  const weights = materialIndexes.map((i) => base[i]!.net)
  const materialNet = weights.reduce((acc, w) => acc.plus(toDec(w)), toDec(ZERO))
  const discount = input.discount
  const documentDiscount = !discount
    ? toDec(ZERO)
    : 'percent' in discount
      ? round(materialNet.times(toDec(discount.percent)).dividedBy(100))
      : round(toDec(discount.amount))
  const discountShares = new Map<number, string>()
  splitByWeights(fixed(documentDiscount, digits), weights, digits).forEach((share, k) =>
    discountShares.set(materialIndexes[k]!, share),
  )
  const taxed = base.map((b, i) => {
    const rate = b.line.vatRate
    const left = toDec(b.net).minus(toDec(discountShares.get(i) ?? ZERO))
    const taxable = beforeVat(left, rate)
    const vat = includesVat ? left.minus(taxable) : round(left.times(toDec(rate)).dividedBy(100))
    return {
      kind: b.line.kind,
      subtotal: beforeVat(toDec(b.subtotal), rate),
      net: beforeVat(toDec(b.net), rate),
      taxable,
      vat,
    }
  })
  if (taxed.some((t) => t.taxable.lt(0))) {
    throw new RangeError('Invalid purchase: document_discount_over_net')
  }
  const inCost = (t: (typeof taxed)[number]) =>
    input.vatInCost ? t.taxable.plus(t.vat) : t.taxable
  const delivery = taxed
    .filter((t) => t.kind === 'delivery')
    .reduce((acc, t) => acc.plus(inCost(t)), toDec(ZERO))
  const deliveryShares = new Map<number, string>()
  if (materialIndexes.length > 0) {
    const netWeights = materialIndexes.map((i) => fixed(taxed[i]!.net, digits))
    splitByWeights(fixed(delivery, digits), netWeights, digits).forEach((share, k) =>
      deliveryShares.set(materialIndexes[k]!, share),
    )
  }
  const lines: PurchaseLineAmounts[] = taxed.map((t, i) => {
    const isMaterial = t.kind === 'material'
    const deliveryShare = toDec(deliveryShares.get(i) ?? ZERO)
    return {
      kind: t.kind,
      subtotal: print(t.subtotal),
      discount: print(t.subtotal.minus(t.net)),
      net: print(t.net),
      documentDiscount: print(t.net.minus(t.taxable)),
      taxable: print(t.taxable),
      vat: print(t.vat),
      total: print(t.taxable.plus(t.vat)),
      deliveryShare: print(isMaterial ? deliveryShare : toDec(ZERO)),
      cost: print(isMaterial ? inCost(t).plus(deliveryShare) : toDec(ZERO)),
    }
  })
  const sum = (pick: (line: PurchaseLineAmounts) => string) =>
    lines.reduce((acc, line) => acc.plus(toDec(pick(line))), toDec(ZERO))
  const net = sum((l) => l.taxable)
  const vat = sum((l) => l.vat)
  const documentDiscountNet = sum((l) => l.documentDiscount)
  return {
    lines,
    documentDiscount: print(documentDiscountNet),
    subtotal: print(sum((l) => l.subtotal)),
    discount: print(sum((l) => l.discount).plus(documentDiscountNet)),
    net: print(net),
    vat: print(vat),
    total: print(net.plus(vat)),
    cost: print(sum((l) => l.cost)),
  }
}

/** Both engines' results, or the error each throws. */
function both(input: PurchaseInput, currency: CurrencyCode) {
  const run = (engine: typeof computePurchase) => {
    try {
      return { amounts: engine(input, currency) }
    } catch (error) {
      return { error: (error as Error).message }
    }
  }
  return { now: run(computePurchase), before: run(legacyComputePurchase) }
}

const decimal = (max: number, places: number) =>
  fc
    .tuple(fc.integer({ min: 0, max }), fc.integer({ min: 0, max: 10 ** places - 1 }))
    .map(([whole, fraction]) =>
      places === 0 ? String(whole) : `${whole}.${String(fraction).padStart(places, '0')}`,
    )
const rate = fc.constantFrom('0', '5', '15', '7.5', '12.345678')
const discount: fc.Arbitrary<LineDiscount | null> = fc.oneof(
  fc.constant(null),
  decimal(100, 2).map((percent) => ({ percent: percent as Percent })),
  decimal(500, 4).map((amount) => ({ amount: amount as Money })),
)
const line: fc.Arbitrary<PurchaseLineInput> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('material' as const),
      qty: decimal(1000, 6).map((v) => v as Quantity),
      unitPrice: decimal(5000, 4).map((v) => v as Money),
      discount,
      vatRate: rate.map((v) => v as Percent),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('delivery' as const),
      amount: decimal(300, 4).map((v) => v as Money),
      vatRate: rate.map((v) => v as Percent),
    }),
  },
)
const purchase: fc.Arbitrary<PurchaseInput> = fc.record({
  lines: fc.array(line, { minLength: 0, maxLength: 7 }),
  discount,
  vatInCost: fc.boolean(),
  pricesIncludeVat: fc.boolean(),
})

describe('purchases after VAT moved to its shared helper (D-220)', () => {
  it('give byte-identical results to the engine before the move, in both price modes', () => {
    fc.assert(
      fc.property(purchase, fc.constantFrom<CurrencyCode>('AED', 'KWD'), (input, currency) => {
        const { now, before } = both(input, currency)
        expect(now).toEqual(before)
      }),
      { numRuns: 2000 },
    )
  })

  it('the owner’s examples are unchanged: 105 including 5 % is 100 + 5; 31.50 and 10.00 with VAT', () => {
    const m = (value: string) => value as Money
    const material = (qty: string, unitPrice: string): PurchaseLineInput => ({
      kind: 'material',
      qty: qty as Quantity,
      unitPrice: m(unitPrice),
      vatRate: '5' as Percent,
    })
    for (const input of [
      { lines: [material('1', '105')], vatInCost: false, pricesIncludeVat: true },
      {
        lines: [material('3', '10.5'), material('1', '10')],
        vatInCost: true,
        pricesIncludeVat: true,
      },
      { lines: [material('7', '10.1')], vatInCost: false },
    ]) {
      const { now, before } = both(input, 'AED')
      expect(now).toEqual(before)
    }
    expect(
      computePurchase(
        { lines: [material('1', '105')], vatInCost: false, pricesIncludeVat: true },
        'AED',
      ),
    ).toMatchObject({ net: '100.00', vat: '5.00', total: '105.00' })
  })
})

import type { ProductDto, SaleDto } from '@bizcost/contracts'
import { describe, expect, it } from 'vitest'
import {
  checkSale,
  newItemLine,
  saleDraft,
  type SaleDraft,
  type SaleFormContext,
} from './sale-draft'

// One sale as typed (M3 Step 2; Q9, D-230): lines naming products or services with a quantity, a
// price and a discount, and delivery with what the customer was charged and what it cost. The running
// amounts are the domain's sale maths (D-220).

const LOGO = '0190a4f2-7b5c-7c3e-9b1a-2f3c4d5e6f21'
const GUIDE = '0190a4f2-7b5c-7c3e-9b1a-2f3c4d5e6f22'
const TODAY = '2026-10-08'

function service(id: string, name: string, price: string, extra: Partial<ProductDto> = {}) {
  return {
    id,
    name,
    description: null,
    type: 'service',
    unit: 'piece',
    defaultPrice: price,
    vatCategory: 'standard',
    priceIncludesVat: false,
    locationIds: [],
    resaleMaterialId: null,
    archivedAt: null,
    version: 1,
    ...extra,
  } as unknown as ProductDto
}

const PRODUCTS = new Map([
  [LOGO, service(LOGO, 'Logo design', '1500')],
  [GUIDE, service(GUIDE, 'Brand guide', '500')],
])

function context(extra: Partial<SaleFormContext> = {}): SaleFormContext {
  return {
    currency: 'AED',
    vatRegistered: false,
    today: TODAY,
    products: PRODUCTS,
    deliveryCostShown: true,
    storedDeliveryCost: '',
    ...extra,
  }
}

function designerSale(): SaleDraft {
  const draft = saleDraft(undefined, { today: TODAY, channelId: null, locationId: null })
  return {
    ...draft,
    lines: [
      { ...newItemLine(PRODUCTS.get(LOGO)), id: 'l1' },
      { ...newItemLine(PRODUCTS.get(GUIDE)), id: 'l2', discountKind: 'percent', discount: '10' },
    ],
    deliveryNeeded: true,
    deliveryArea: ' Al Barsha ',
    deliveryCharged: '20',
    deliveryCost: '25',
  }
}

describe('One sale', () => {
  it("adds up the designer's sale: 1,500 + 500 less 10% + delivery charged 20 = 1,970", () => {
    const draft = designerSale()
    const check = checkSale(draft, context())
    expect(check.amounts).toMatchObject({ net: '1970.00', vat: '0.00', total: '1970.00' })
    expect(check.lineAmounts.get('l2')?.total).toBe('450.00')
    expect(check.deliveryAmounts?.total).toBe('20.00')
    expect(check.hasItem).toBe(true)
    expect(check.fields).toEqual({
      businessDate: TODAY,
      periodFrom: null,
      locationId: null,
      channelId: null,
      deliveryNeeded: true,
      deliveryArea: 'Al Barsha',
      deliveryCost: '25',
      notes: null,
      lines: [
        {
          kind: 'item',
          id: 'l1',
          productId: LOGO,
          description: undefined,
          qty: '1',
          unitPrice: '1500',
          discount: null,
        },
        {
          kind: 'item',
          id: 'l2',
          productId: GUIDE,
          description: undefined,
          qty: '1',
          unitPrice: '500',
          discount: { percent: '10' },
        },
        {
          kind: 'delivery',
          id: draft.deliveryLineId,
          amount: '20',
          amountIncludesVat: false,
        },
      ],
    })
  })

  it('sends the delivery cost only when typed here: kept when untouched, cleared when emptied', () => {
    const draft = designerSale()
    // Untouched (the member's own stored 25): left out, so an update keeps it.
    expect(checkSale(draft, context({ storedDeliveryCost: '25' })).fields).not.toHaveProperty(
      'deliveryCost',
    )
    // Emptied: cleared.
    expect(
      checkSale({ ...draft, deliveryCost: '' }, context({ storedDeliveryCost: '25' })).fields
        ?.deliveryCost,
    ).toBeNull()
    // Not the member's to type (another's sale, without the costs switch): never sent.
    expect(checkSale(draft, context({ deliveryCostShown: false })).fields).not.toHaveProperty(
      'deliveryCost',
    )
    // Without delivery: no area, no charge, no cost.
    const none = checkSale({ ...draft, deliveryNeeded: false }, context()).fields
    expect(none).toMatchObject({ deliveryNeeded: false, deliveryArea: null })
    expect(none).not.toHaveProperty('deliveryCost')
    expect(none?.lines?.some((line) => line.kind === 'delivery')).toBe(false)
  })

  it('charges no delivery line when it was free for the customer', () => {
    const check = checkSale({ ...designerSale(), deliveryCharged: '' }, context())
    expect(check.fields?.lines?.map((line) => line.kind)).toEqual(['item', 'item'])
    expect(check.deliveryAmounts).toBeNull()
  })

  it('says what is wrong: nothing picked, a day after today, a discount over its line', () => {
    const draft = saleDraft(undefined, { today: TODAY, channelId: null, locationId: null })
    const empty = checkSale(draft, context())
    expect(empty.fields).toBeNull()
    expect(empty.hasItem).toBe(false)
    expect(Object.values(empty.errors.lines)[0]?.item?.key).toBe('sales.editor.errors.item')
    const later = checkSale({ ...designerSale(), businessDate: '2026-10-09' }, context())
    expect(later.errors.businessDate?.key).toBe('errors.future_date')
    expect(later.fields).toBeNull()
    const over = designerSale()
    const overLine = { ...over.lines[1]!, discountKind: 'amount' as const, discount: '600' }
    const tooMuch = checkSale({ ...over, lines: [over.lines[0]!, overLine] }, context())
    expect(tooMuch.errors.lines.l2?.discount?.key).toBe('sales.editor.errors.discountOverLine')
    expect(tooMuch.fields).toBeNull()
  })

  it('works VAT out once for a VAT-registered business, with prices as the product says', () => {
    const products = new Map([
      [LOGO, service(LOGO, 'Logo design', '1050', { priceIncludesVat: true })],
      [GUIDE, service(GUIDE, 'Brand guide', '500')],
    ])
    const draft = designerSale()
    const lines = [{ ...draft.lines[0]!, price: '1050' }, draft.lines[1]!]
    const check = checkSale({ ...draft, lines }, context({ vatRegistered: true, products }))
    // 1,050 incl. VAT = 1,000 + 50; 450 + 5% = 22.50; delivery 20 + 1.00.
    expect(check.amounts).toMatchObject({ net: '1470.00', vat: '73.50', total: '1543.50' })
  })

  it("opens a saved draft as it is stored, keeping a line's own name while it names the same product", () => {
    const stored = {
      businessDate: '2026-10-07',
      channelId: 'c1',
      locationId: 'loc1',
      deliveryNeeded: true,
      deliveryArea: 'Mirdif',
      deliveryCost: undefined,
      ownDeliveryCost: '15',
      notes: 'Call first',
      lines: [
        {
          id: 'l1',
          kind: 'item',
          productId: LOGO,
          description: 'Logo design (two options)',
          qty: '1',
          unitPrice: '1400',
          discount: { amount: '100' },
          priceIncludesVat: false,
        },
        { id: 'd1', kind: 'delivery', productId: null, unitPrice: '30', priceIncludesVat: false },
      ],
    } as unknown as SaleDto
    const draft = saleDraft(stored, { today: TODAY, channelId: null, locationId: null })
    expect(draft).toMatchObject({
      businessDate: '2026-10-07',
      channelId: 'c1',
      locationId: 'loc1',
      deliveryArea: 'Mirdif',
      deliveryLineId: 'd1',
      deliveryCharged: '30',
      deliveryCost: '15',
      notes: 'Call first',
    })
    expect(draft.lines).toEqual([
      {
        id: 'l1',
        productId: LOGO,
        qty: '1',
        price: '1400',
        discountKind: 'amount',
        discount: '100',
        savedName: 'Logo design (two options)',
        savedProductId: LOGO,
      },
    ])
    const fields = checkSale(draft, context({ storedDeliveryCost: '15' })).fields
    expect(fields?.lines?.[0]).toMatchObject({ description: 'Logo design (two options)' })
    // Another product on the line: its own name, not the old one.
    const other = { ...draft, lines: [{ ...draft.lines[0]!, productId: GUIDE }] }
    expect(checkSale(other, context()).fields?.lines?.[0]).toMatchObject({ description: undefined })
  })
})

import type { MaterialDto, PurchaseDto } from '@bizcost/contracts'
import { describe, expect, it } from 'vitest'
import {
  checkPurchase,
  defaultVatRate,
  materialNames,
  newDeliveryLine,
  newMaterialLine,
  purchaseDraft,
  type MaterialLineDraft,
  type PurchaseDraft,
} from './purchase-draft'

// The purchase editor's form: what is checked before a save, the running amounts (the domain's
// purchase maths, as the API stores a draft) and purchase.create's fields.

const TODAY = '2026-09-28'

const MILK: MaterialDto = {
  id: '0190a4f2-7b5c-7c3e-9b1a-000000000001',
  name: 'Milk',
  dimension: 'volume',
  unit: 'l',
  packs: [{ id: 'carton', name: 'carton', qty: '12', ofUnit: 'l', ofPackId: null }],
  crossFactors: [],
  archivedAt: null,
  version: 1,
}
const BEANS: MaterialDto = {
  id: '0190a4f2-7b5c-7c3e-9b1a-000000000002',
  name: 'بن',
  dimension: 'mass',
  unit: 'kg',
  packs: [{ id: 'bag', name: 'كيس', qty: '1', ofUnit: 'kg', ofPackId: null }],
  crossFactors: [],
  archivedAt: null,
  version: 1,
}
const MATERIALS = new Map([MILK, BEANS].map((m) => [m.id, m] as const))

function context(vatRegistered: boolean) {
  return { currency: 'AED' as const, materials: MATERIALS, vatRegistered, today: TODAY }
}

function line(fields: Partial<MaterialLineDraft>): MaterialLineDraft {
  return { ...newMaterialLine('5'), ...fields }
}

function draft(fields: Partial<PurchaseDraft>): PurchaseDraft {
  return { ...purchaseDraft(undefined, { today: TODAY, vatRegistered: true }), ...fields }
}

describe('a new purchase', () => {
  it('starts today with one empty line; a tax invoice with VAT for a VAT-registered business', () => {
    const registered = purchaseDraft(undefined, { today: TODAY, vatRegistered: true })
    expect(registered.businessDate).toBe(TODAY)
    expect(registered.documentType).toBe('tax_invoice')
    expect(registered.lines).toHaveLength(1)
    expect(registered.lines[0]).toMatchObject({ kind: 'material', materialId: '', vatRate: '5' })
    const other = purchaseDraft(undefined, { today: TODAY, vatRegistered: false })
    expect(other.documentType).toBe('non_tax_invoice')
    expect(other.lines[0]).toMatchObject({ vatRate: '0' })
    expect(defaultVatRate(true, 'no_invoice')).toBe('0')
  })
})

describe('checkPurchase', () => {
  it("the owner's milk: 50 L at AED 6 with 5% VAT", () => {
    const milk = line({ materialId: MILK.id, qty: '50', unit: 'unit:l', price: '6' })
    const checked = checkPurchase(draft({ lines: [milk], supplierId: 's1' }), context(true))
    expect(checked.errors).toEqual({ lines: {} })
    expect(checked.amounts).toMatchObject({ subtotal: '300.00', vat: '15.00', total: '315.00' })
    expect(checked.lineAmounts.get(milk.id)).toMatchObject({ taxable: '300.00', total: '315.00' })
    expect(checked.fields).toEqual({
      supplierId: 's1',
      businessDate: TODAY,
      documentType: 'tax_invoice',
      reference: null,
      paymentMethod: null,
      locationId: null,
      vatNotReclaimable: false,
      discount: null,
      notes: null,
      lines: [
        {
          kind: 'material',
          id: milk.id,
          materialId: MILK.id,
          qty: '50',
          unit: 'l',
          packId: null,
          unitPrice: '6',
          discount: null,
          vatRate: '5',
        },
      ],
    })
    expect(checked.hasMaterial).toBe(true)
  })

  it('reads Arabic digits; a bag of beans priced per bag; no VAT when not VAT-registered', () => {
    const beans = line({ materialId: BEANS.id, qty: '٣', unit: 'pack:bag', price: '٤٥' })
    const checked = checkPurchase(draft({ lines: [beans] }), context(false))
    expect(checked.amounts).toMatchObject({ subtotal: '135.00', vat: '0.00', total: '135.00' })
    expect(checked.fields?.lines?.[0]).toMatchObject({
      qty: '3',
      unit: null,
      packId: 'bag',
      unitPrice: '45',
      vatRate: '0',
    })
  })

  it('says what is missing on the line, and counts the lines that read', () => {
    const milk = line({ materialId: MILK.id, qty: '10', unit: 'unit:l', price: '6' })
    const empty = line({})
    const checked = checkPurchase(draft({ lines: [milk, empty] }), context(true))
    expect(checked.fields).toBeNull()
    expect(checked.errors.lines[empty.id]).toEqual({
      material: { key: 'purchasing.editor.errors.material' },
      qty: { key: 'catalog.numbers.required' },
      unit: { key: 'catalog.form.pickUnit' },
      price: { key: 'catalog.numbers.required' },
    })
    expect(checked.amounts.total).toBe('63.00')
  })

  it('takes discounts off before VAT, and refuses one larger than what it is on', () => {
    const milk = line({
      materialId: MILK.id,
      qty: '10',
      unit: 'unit:l',
      price: '10',
      discountKind: 'percent',
      discount: '10',
    })
    let checked = checkPurchase(draft({ lines: [milk] }), context(true))
    expect(checked.amounts).toMatchObject({ discount: '10.00', vat: '4.50', total: '94.50' })
    expect(checked.fields?.lines?.[0]).toMatchObject({ discount: { percent: '10' } })

    const tooMuch = { ...milk, discountKind: 'amount' as const, discount: '101' }
    checked = checkPurchase(draft({ lines: [tooMuch] }), context(true))
    expect(checked.errors.lines[milk.id]?.discount?.key).toBe(
      'purchasing.editor.errors.discountOverLine',
    )

    checked = checkPurchase(
      draft({ lines: [milk], discountKind: 'amount', discount: '500' }),
      context(true),
    )
    expect(checked.errors.discount?.key).toBe('purchasing.editor.errors.discountOverNet')
    // The running amounts leave the wrong discount out until it is fixed.
    expect(checked.amounts.total).toBe('94.50')

    checked = checkPurchase(
      draft({ lines: [milk], discountKind: 'percent', discount: '120' }),
      context(true),
    )
    expect(checked.errors.discount?.key).toBe('catalog.numbers.percent')
  })

  it('shares delivery on the invoice over the materials, and needs a material for it', () => {
    const milk = line({ materialId: MILK.id, qty: '10', unit: 'unit:l', price: '6' })
    const delivery = { ...newDeliveryLine('5'), amount: '10' }
    let checked = checkPurchase(draft({ lines: [milk, delivery] }), context(true))
    expect(checked.amounts).toMatchObject({ subtotal: '70.00', vat: '3.50', total: '73.50' })
    expect(checked.fields?.lines?.[1]).toEqual({
      kind: 'delivery',
      id: delivery.id,
      description: null,
      amount: '10',
      vatRate: '5',
    })
    checked = checkPurchase(draft({ lines: [delivery] }), context(true))
    expect(checked.errors.document?.key).toBe('purchasing.editor.errors.noMaterial')
    expect(checked.fields).toBeNull()
    expect(checked.hasMaterial).toBe(false)
  })

  it('refuses a day after today, a unit no longer the material’s and a quantity too large', () => {
    const milk = line({ materialId: MILK.id, qty: '1', unit: 'pack:gone', price: '6' })
    const checked = checkPurchase(
      draft({ businessDate: '2026-09-29', lines: [milk] }),
      context(true),
    )
    expect(checked.errors.businessDate?.key).toBe('errors.future_date')
    expect(checked.errors.lines[milk.id]?.unit?.key).toBe('purchasing.editor.errors.unitGone')

    const huge = line({
      materialId: MILK.id,
      qty: '999999999999999999',
      unit: 'unit:l',
      price: '1',
    })
    expect(
      checkPurchase(draft({ lines: [huge] }), context(true)).errors.lines[huge.id]?.qty?.key,
    ).toBe('purchasing.editor.errors.qtyTooLarge')
  })

  it('names each material once, for the confirmations', () => {
    const lines = [
      line({ materialId: MILK.id }),
      line({ materialId: BEANS.id }),
      line({ materialId: MILK.id }),
      line({ materialId: 'removed', savedName: 'Sugar' }),
    ]
    expect(materialNames({ lines }, MATERIALS)).toEqual(['Milk', 'بن', 'Sugar'])
  })
})

describe('a saved draft', () => {
  it('opens as it is stored', () => {
    const stored = {
      supplierId: null,
      businessDate: '2026-09-27',
      documentType: 'no_invoice',
      reference: 'R-1',
      paymentMethod: 'cash',
      locationId: 'loc',
      vatNotReclaimable: false,
      discount: { amount: '5' },
      notes: null,
      lines: [
        {
          id: 'l1',
          kind: 'material',
          materialId: BEANS.id,
          description: 'بن',
          qty: '2',
          unit: null,
          packId: 'bag',
          vatRate: '0',
          unitPrice: '45',
          discount: { percent: '10' },
        },
        { id: 'l2', kind: 'delivery', description: 'Van', qty: '1', unitPrice: '15', vatRate: '5' },
      ],
    } as unknown as PurchaseDto
    const opened = purchaseDraft(stored, { today: TODAY, vatRegistered: true })
    expect(opened).toMatchObject({
      supplierId: '',
      businessDate: '2026-09-27',
      documentType: 'no_invoice',
      reference: 'R-1',
      paymentMethod: 'cash',
      locationId: 'loc',
      discountKind: 'amount',
      discount: '5',
    })
    expect(opened.lines).toEqual([
      {
        kind: 'material',
        id: 'l1',
        materialId: BEANS.id,
        qty: '2',
        unit: 'pack:bag',
        price: '45',
        discountKind: 'percent',
        discount: '10',
        vatRate: '0',
        savedName: 'بن',
      },
      { kind: 'delivery', id: 'l2', description: 'Van', amount: '15', vatRate: '5' },
    ])
  })
})

import type { ProductDto } from '@bizcost/contracts'
import { createI18n } from '@bizcost/i18n'
import { areaNames } from '@bizcost/domain'
import { describe, expect, it } from 'vitest'
import {
  amountsKey,
  carriedRounding,
  checkQuotation,
  isBlankLine,
  newQuotationLine,
  newStage,
  quotationDraft,
  type QuotationDraft,
  type QuotationFormContext,
  type QuotationLineDraft,
} from './quotation-draft'

// The quotation editor's rules (M3 Step 7; D-220, D-221, D-283): typed lines and products, "Round the
// total" worked out as the API works it out, payment stages that share the amount to pay, and the
// fields sent (a new quotation's empty validity and terms left to the business's defaults).

const CUSTOMER = {
  id: '0190a4f2-7b5c-7c3e-9b1a-2f3c4d5e6f71',
  name: 'يوسف الحمادي',
  kind: 'individual' as const,
  phone: null,
  phoneLast4: '0123',
  archived: false,
}

const WARDROBE: ProductDto = {
  id: '0190a4f2-7b5c-7c3e-9b1a-2f3c4d5e6f72',
  name: 'Wardrobe, sliding doors',
  description: null,
  type: 'product',
  unit: 'm2',
  defaultPrice: '980',
  vatCategory: 'standard',
  priceIncludesVat: false,
  locationIds: [],
  resaleMaterialId: null,
  archivedAt: null,
  version: 1,
}

const context = (over: Partial<QuotationFormContext> = {}): QuotationFormContext => ({
  currency: 'AED',
  vatRegistered: true,
  today: '2026-10-16',
  products: new Map([[WARDROBE.id, WARDROBE]]),
  saved: false,
  ...over,
})

const line = (patch: Partial<QuotationLineDraft>): QuotationLineDraft => ({
  ...newQuotationLine(),
  ...patch,
})

/** The demo fit-out's three lines in two areas, one with a product, one typed with a picture. */
function fitOut(patch: Partial<QuotationDraft> = {}): QuotationDraft {
  return {
    ...quotationDraft(undefined, { today: '2026-10-16', locationId: null }),
    customer: CUSTOMER,
    site: 'Villa 18, Al Barsha',
    lines: [
      line({
        area: 'المجلس',
        title: 'تكسية جدار',
        details: 'الخامة: MDF\nإضاءة LED',
        qty: '9.5',
        unit: 'm2',
        price: '650',
      }),
      line({ area: 'المجلس', title: 'وحدة تلفزيون', qty: '1', unit: 'piece', price: '4800' }),
      line({
        area: 'غرفة النوم',
        productId: WARDROBE.id,
        title: WARDROBE.name,
        qty: '3.5',
        price: '980',
      }),
    ],
    ...patch,
  }
}

describe('checkQuotation', () => {
  it('adds up typed lines and products, with VAT', () => {
    const checked = checkQuotation(fitOut(), context())
    expect(checked.errors.lines).toEqual({})
    // 6,175 + 4,800 + 3,430 = 14,405 before VAT; 720.25 VAT.
    expect(checked.amounts).toMatchObject({ net: '14405.00', vat: '720.25', total: '15125.25' })
    expect(checked.fields?.lines?.map((l) => [l.productId, l.description, l.unit, l.area])).toEqual(
      [
        [null, 'تكسية جدار', 'm2', 'المجلس'],
        [null, 'وحدة تلفزيون', 'piece', 'المجلس'],
        [WARDROBE.id, WARDROBE.name, null, 'غرفة النوم'],
      ],
    )
    expect(checked.fields?.lines?.[0]?.details).toBe('الخامة: MDF\nإضاءة LED')
  })

  it('rounds the total to 15,000.00 with the change before VAT, as the API does', () => {
    const checked = checkQuotation(fitOut({ roundTo: '15000' }), context())
    expect(checked.errors.roundTo).toBeUndefined()
    expect(checked.amounts?.payable).toBe('15000.00')
    expect(checked.rounding).not.toBeNull()
    // 14,285.71 before VAT + 714.29 VAT = 15,000.00: −119.29 before VAT.
    expect(checked.rounding?.adjustment).toBe('-119.29')
    expect(checked.amounts?.net).toBe('14285.71')
    expect(checked.fields?.roundTo).toBe('15000')
  })

  it('shares the amount to pay in stages of 50/35/15, the last taking the rest', () => {
    const stages = [
      { ...newStage('50'), due: 'عند التوقيع' },
      { ...newStage('35'), due: 'عند التوريد' },
      { ...newStage('15'), due: 'بعد التسليم' },
    ]
    const checked = checkQuotation(fitOut({ roundTo: '15000', stages }), context())
    expect(stages.map((s) => checked.stageAmounts.get(s.key))).toEqual([
      '7500.00',
      '5250.00',
      '2250.00',
    ])
    expect(checked.fields?.stages).toEqual([
      { label: null, due: 'عند التوقيع', percent: '50' },
      { label: null, due: 'عند التوريد', percent: '35' },
      { label: null, due: 'بعد التسليم', percent: '15' },
    ])
  })

  it('refuses stages that do not add up to 100%, or have no "when"', () => {
    const stages = [{ ...newStage('50'), due: 'Upon signing' }, newStage('40')]
    const checked = checkQuotation(fitOut({ stages }), context())
    expect(checked.errors.stageRows[stages[1]!.key]?.due?.key).toBe(
      'documents.quotations.editor.errors.due',
    )
    expect(checked.fields).toBeNull()
    const sum = checkQuotation(
      fitOut({
        stages: [
          { ...newStage('60'), due: 'a' },
          { ...newStage('30'), due: 'b' },
        ],
      }),
      context(),
    )
    expect(sum.errors.stages?.key).toBe('documents.quotations.editor.errors.stagesNot100')
  })

  it('needs a customer and a title on every line', () => {
    const checked = checkQuotation(
      fitOut({ customer: null, lines: [line({ title: ' ', qty: '1', price: '10' })] }),
      context(),
    )
    expect(checked.errors.customer?.key).toBe('documents.quotations.editor.errors.customer')
    expect(Object.values(checked.errors.lines)[0]?.title?.key).toBe(
      'documents.quotations.editor.errors.title',
    )
    expect(checked.fields).toBeNull()
  })

  it('leaves a new quotation’s empty validity and terms to the defaults, and clears them once saved', () => {
    const fresh = checkQuotation(fitOut(), context())
    expect(fresh.fields).not.toHaveProperty('validUntil')
    expect(fresh.fields).not.toHaveProperty('terms')
    const saved = checkQuotation(fitOut(), context({ saved: true }))
    expect(saved.fields).toMatchObject({ validUntil: null, terms: null })
  })

  it('without VAT registration: no VAT, a typed line standard-rated', () => {
    const checked = checkQuotation(
      fitOut({
        lines: [line({ title: 'Logo design', qty: '1', price: '2500', vatCategory: 'exempt' })],
      }),
      context({ vatRegistered: false, products: new Map() }),
    )
    expect(checked.amounts).toMatchObject({ net: '2500.00', vat: '0.00', total: '2500.00' })
    expect(checked.fields?.lines?.[0]?.vatCategory).toBe('standard')
  })

  it('reads the areas already used, in order; a line without one sends none', () => {
    expect(areaNames(fitOut().lines)).toEqual(['المجلس', 'غرفة النوم'])
    const draft = fitOut()
    const lines = [...draft.lines, line({ title: 'Site visit', qty: '1', price: '100' })]
    const checked = checkQuotation({ ...draft, lines }, context())
    expect(checked.fields?.lines?.map((l) => l.area)).toEqual([
      'المجلس',
      'المجلس',
      'غرفة النوم',
      null,
    ])
  })
})

describe('isBlankLine (D-299: "Add an area" takes a blank line in)', () => {
  it('is a line nothing was entered in', () => {
    expect(isBlankLine(newQuotationLine())).toBe(true)
    expect(isBlankLine(line({ title: 'x' }))).toBe(false)
    expect(isBlankLine(line({ price: '10' }))).toBe(false)
    expect(isBlankLine(line({ qty: '2' }))).toBe(false)
    expect(isBlankLine(line({ details: 'MDF' }))).toBe(false)
    expect(isBlankLine(line({ productId: WARDROBE.id }))).toBe(false)
    expect(
      isBlankLine(
        line({ picture: { saved: null, pending: new File(['x'], 'p.jpg'), remove: false } }),
      ),
    ).toBe(false)
  })
})

describe('a rounded total and the lines under it (D-297)', () => {
  it('tells when the amounts changed after rounding: the lines and the discount, never the words', () => {
    const draft = fitOut({ roundTo: '15000' })
    const key = amountsKey(draft)
    expect(amountsKey({ ...draft, terms: 'Supply and installation.', roundTo: '' })).toBe(key)
    const [first, ...rest] = draft.lines
    expect(amountsKey({ ...draft, lines: [{ ...first!, details: 'Oak veneer' }, ...rest] })).toBe(
      key,
    )
    expect(amountsKey({ ...draft, lines: [{ ...first!, price: '5200' }, ...rest] })).not.toBe(key)
    expect(amountsKey({ ...draft, lines: rest })).not.toBe(key)
    expect(amountsKey({ ...draft, discountKind: 'percent', discount: '5' })).not.toBe(key)
  })

  it('says where a carried rounded total was rounded: the revision before, or the quotation copied (D-297)', () => {
    const source = '0190a4f2-7b5c-7c3e-9b1a-2f3c4d5e6f79'
    expect(carriedRounding({ roundTo: '15000.00', revision: 2, copiedFromId: null })).toBe(
      'revision',
    )
    // A copy is revision 1 of a new quotation: never "the revision before".
    expect(carriedRounding({ roundTo: '15000.00', revision: 1, copiedFromId: source })).toBe('copy')
    expect(carriedRounding({ roundTo: '15000.00', revision: 1, copiedFromId: null })).toBeNull()
    expect(carriedRounding({ roundTo: null, revision: 2, copiedFromId: null })).toBeNull()
    expect(carriedRounding({ roundTo: null, revision: 1, copiedFromId: source })).toBeNull()
    expect(carriedRounding(undefined)).toBeNull()
    for (const [locale, revision, copy] of [
      ['en', 'revision before', 'copied from'],
      ['ar', 'النسخة السابقة', 'نُسخ منه'],
    ] as const) {
      const { t } = createI18n({ locale })
      const said = (key: 'roundCarried' | 'roundCarriedCopy') =>
        t(`documents.quotations.editor.${key}`, { amount: '-519.29' })
      expect(said('roundCarried')).toContain(revision)
      expect(said('roundCarriedCopy')).toContain(copy)
      expect(said('roundCarriedCopy')).not.toContain(revision)
      expect(said('roundCarriedCopy')).toContain('-519.29')
    }
  })

  it('a line priced higher under a kept total: the payable stays, the rounding adjustment takes it', () => {
    const before = checkQuotation(fitOut({ roundTo: '15000' }), context())
    const draft = fitOut({ roundTo: '15000' })
    const [first, ...rest] = draft.lines
    const after = checkQuotation(
      { ...draft, lines: [{ ...first!, price: String(Number(first!.price) + 600) }, ...rest] },
      context(),
    )
    expect(after.amounts?.payable).toBe(before.amounts?.payable)
    expect(after.rounding?.wanted).toBe('15000')
    expect(Number(after.rounding?.adjustment)).toBeLessThan(Number(before.rounding?.adjustment))
  })
})

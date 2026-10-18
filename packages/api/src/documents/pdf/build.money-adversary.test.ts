import {
  compareDecimal,
  computeSale,
  solveRoundAmount,
  sumDecimals,
  type Money,
  type Quantity,
  type SaleAmounts,
  type SaleInput,
} from '@bizcost/domain'
import { describe, expect, it } from 'vitest'
import { buildQuotationPdfInput, type PdfQuotation } from './build'

// Money adversary of M3 Step 7: a quotation's totals block on the PDF (and on the screen, which prints
// the same rows: apps/web/src/features/quotations/quotation-totals.tsx) must add up as printed: the
// subtotal, less the discount, plus the "Round the total" adjustment, is the total before VAT; with VAT
// per rate it is the total. The amounts come from the domain's own engine (computeSale,
// solveRoundAmount), as quotation.create stores them. Fictional data only.

/** A quotation's frozen values from the sales engine's amounts (as prepareQuotation stores them). */
function quotationOf(amounts: SaleAmounts, roundTo: { adjustment: string; difference: string }) {
  const lineDiscounts = sumDecimals(amounts.lines.map((l) => l.discount))
  const quotation: PdfQuotation = {
    number: 'Q-0007',
    revision: 1,
    draft: false,
    businessDate: '2026-10-08',
    validUntil: null,
    customerRef: null,
    site: null,
    currency: 'AED',
    vatRegistered: true,
    subtotal: sumDecimals(amounts.lines.map((l) => l.subtotal)),
    discountTotal: sumDecimals([lineDiscounts, amounts.documentDiscount]),
    adjustment: roundTo.adjustment,
    roundingDifference: roundTo.difference,
    netTotal: amounts.net,
    vatTotal: amounts.vat,
    total: amounts.total,
    payable: amounts.payable,
    vatRates: amounts.rates,
    greeting: null,
    intro: null,
    terms: null,
    notes: null,
    issuedAt: new Date('2026-10-08T08:00:00Z'),
    lines: amounts.lines.map((l, i) => ({
      area: null,
      title: `Fit-out item ${i + 1}`,
      details: null,
      note: null,
      qty: '1',
      unit: null,
      unitPrice: l.subtotal,
      subtotal: l.subtotal,
      lineDiscount: l.discount,
      priceIncludesVat: l.priceIncludesVat,
      vatCategory: l.vatCategory,
      vatRate: l.vatRate,
      picture: null,
    })),
    stages: [],
  }
  return buildQuotationPdfInput({
    business: {
      legalName: 'Modern Touch Interiors',
      legalNameAr: 'لمسة عصرية للديكور',
      locale: 'en',
      vatRegistered: true,
      trn: '100123456700003',
      phone: null,
      phone2: null,
      email: null,
      addressLine: null,
      city: null,
      emirate: null,
      tradeLicenceNo: null,
      accent: 'navy',
      watermark: false,
      wholeAmounts: false,
      signatory: null,
      footer: null,
    },
    quotation,
    customer: {
      name: 'Khalid Al Mansoori',
      phone: null,
      trn: null,
      addressLine: null,
      city: null,
      emirate: null,
    },
    businessImages: { logo: null, signature: null, stamp: null },
    images: {},
  })
}

/** "1,047.62" → "1047.62" (a decimal string; the maths stays in the domain's decimal helpers). */
const plain = (printed: string) => printed.replace(/,/g, '')

/** The totals block's rows by their English label. */
function rowsOf(input: ReturnType<typeof quotationOf>) {
  return new Map(input.totals.map((row) => [row.label.en, row.amount]))
}

/** Subtotal − discount + adjustment, as printed, must be the printed total before VAT. */
function expectRowsAddUp(input: ReturnType<typeof quotationOf>) {
  const rows = rowsOf(input)
  const subtotal = rows.get('Subtotal')
  expect(subtotal, 'the subtotal row').toBeDefined()
  const discount = rows.get('Discount') ?? '0'
  const adjustment = rows.get('Rounding adjustment') ?? '0'
  const net = rows.get('Total before VAT')!
  const added = sumDecimals([plain(subtotal!), plain(discount), plain(adjustment)])
  expect(
    compareDecimal(added, plain(net)),
    `${subtotal} + ${discount} + ${adjustment} = ${added}, printed before VAT: ${net}`,
  ).toBe(0)
}

const included = (unitPrice: string) => ({
  kind: 'item' as const,
  qty: '1' as Quantity,
  unitPrice: unitPrice as Money,
  priceIncludesVat: true,
  vatCategory: 'standard' as const,
})

describe('the totals block adds up as printed (prices that include VAT)', () => {
  it('control: prices before VAT, 1,066.67 rounded to 1,100.00, add up', () => {
    const input: SaleInput = {
      lines: [{ ...included('1066.67'), priceIncludesVat: false }],
      vatRegistered: true,
    }
    const solved = solveRoundAmount(input, '1100.00' as Money, 'AED')
    expectRowsAddUp(
      quotationOf(solved.sale, {
        adjustment: solved.adjustment,
        difference: solved.roundingDifference,
      }),
    )
  })

  it('"Round the total": 1,120.00 with VAT rounded to 1,100.00 prints Subtotal 1,120.00, adjustment −19.05, then 1,047.62 before VAT', () => {
    // D-221's own example "the same with the price including VAT". The subtotal row is the lines'
    // gross (with VAT) and the adjustment is before VAT: 1,120.00 − 19.05 = 1,100.95, not 1,047.62.
    const input: SaleInput = { lines: [included('1120.00')], vatRegistered: true }
    const solved = solveRoundAmount(input, '1100.00' as Money, 'AED')
    expect(solved.adjustment).toBe('-19.05')
    expectRowsAddUp(
      quotationOf(solved.sale, {
        adjustment: solved.adjustment,
        difference: solved.roundingDifference,
      }),
    )
  })

  it('a 10 % discount on 1,050.00 with VAT prints Subtotal 1,050.00, Discount −105.00, then 900.00 before VAT', () => {
    const input: SaleInput = {
      lines: [included('1050.00')],
      vatRegistered: true,
      discount: { percent: '10' as never },
    }
    const amounts = computeSale(input, 'AED')
    expect(amounts).toMatchObject({ net: '900.00', vat: '45.00', total: '945.00' })
    expectRowsAddUp(quotationOf(amounts, { adjustment: '0', difference: '0' }))
  })
})

import { readFileSync } from 'node:fs'
import {
  compareDecimal,
  computeSale,
  proportionOf,
  saleError,
  solveRoundAmount,
  subtractDecimals,
  sumDecimals,
  type Money,
  type Percent,
  type Quantity,
  type SaleAmounts,
  type SaleInput,
  type SaleLineInput,
  type VatCategory,
} from '@bizcost/domain'
import fc from 'fast-check'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  buildCreditNotePdfInput,
  buildInvoicePdfInput,
  buildQuotationPdfInput,
  formatAmount,
  type PdfBusiness,
  type PdfCreditNote,
  type PdfInvoice,
  type PdfInvoiceLine,
} from './build'
import { pdfImageInfo } from './images'
import type { DocumentPdfImage, DocumentPdfInput, DocumentPdfLine } from './input'
import { normalizeText, pdfFullText, pdfRuns, type PlacedRun } from './text-layer'
import { createCore, type Core } from './typst-core.mjs'

// The columns of an invoice and a credit note (D-360; the owner's request of 2026-11-04): «سعر الوحدة،
// الكمية، السعر قبل الضريبة، سعر الضريبة، السعر الإجمالي، والخصم قبل الإجمالي، وإذا ما في خصم اكتب 0.0،
// وفوق اكتب بس VAT 5%». The rows always add up as printed, whatever the document's discount, "Round the
// total", its rates or its prices with VAT; drawn by the real compiler, in both languages, the columns
// stay in their order and in their cells, however large the amounts. Fictional data only.

const MM = 72 / 25.4
const PAGE_W = 210 * MM
const MARGIN = 14 * MM
const FOOT = 32 * MM

const business = (over: Partial<PdfBusiness> = {}): PdfBusiness => ({
  legalName: 'Modern Touch Interiors',
  legalNameAr: 'لمسة عصرية للديكور',
  locale: 'en',
  vatRegistered: true,
  trn: '100123456700003',
  phone: '+971 4 555 0142',
  phone2: null,
  email: 'hello@moderntouch.example',
  addressLine: 'Warehouse 7, Al Quoz',
  city: null,
  emirate: 'dubai',
  tradeLicenceNo: null,
  accent: 'navy',
  watermark: false,
  wholeAmounts: false,
  signatory: 'Abdullah Al Kaabi',
  footer: null,
  ...over,
})

const customer = {
  name: 'Gulf Horizon Properties LLC',
  phone: null,
  trn: '100555666700003',
  addressLine: 'Office 1402, Marina Plaza',
  city: 'Dubai Marina',
  emirate: 'dubai' as const,
  showTrn: true,
}

/** A line of the sales engine's input. */
const item = (
  qty: string,
  unitPrice: string,
  over: Partial<Omit<SaleLineInput, 'kind'>> & { vatCategory?: VatCategory } = {},
): SaleLineInput => ({
  kind: 'item',
  qty: qty as Quantity,
  unitPrice: unitPrice as Money,
  priceIncludesVat: false,
  vatCategory: 'standard',
  ...over,
})

type LineExtras = Partial<
  Pick<PdfInvoiceLine, 'title' | 'details' | 'area' | 'picture' | 'unit' | 'kind'>
>

/** An invoice as an issued one stores the engine's amounts. */
function invoiceOf(
  input: SaleInput,
  amounts: SaleAmounts,
  over: { extras?: (i: number) => LineExtras; number?: string } = {},
): PdfInvoice {
  return {
    kind: input.vatRegistered ? 'tax_invoice' : 'invoice',
    number: over.number ?? 'INV-0042',
    draft: false,
    issueDate: '2026-10-20',
    supplyDate: '2026-10-20',
    dueDate: null,
    lpo: null,
    quotationNumber: null,
    orderNumber: null,
    currency: 'AED',
    vatRegistered: input.vatRegistered,
    subtotal: sumDecimals(amounts.lines.map((l) => l.subtotal)),
    discountTotal: sumDecimals([...amounts.lines.map((l) => l.discount), amounts.documentDiscount]),
    adjustment: amounts.adjustment,
    roundingDifference: amounts.roundingDifference,
    netTotal: amounts.net,
    vatTotal: amounts.vat,
    total: amounts.total,
    payable: amounts.payable,
    vatRates: input.vatRegistered ? amounts.rates : [],
    terms: null,
    notes: null,
    issuedAt: new Date(Date.UTC(2026, 9, 20, 9, 0, 0)),
    payments: [],
    lines: amounts.lines.map((line, i) => ({
      kind: 'item',
      area: null,
      title: `Work item ${i + 1}`,
      details: null,
      note: null,
      qty: input.lines[i]!.qty,
      unit: 'piece',
      unitPrice: input.lines[i]!.unitPrice,
      subtotal: line.subtotal,
      lineDiscount: line.discount,
      net: line.net,
      vat: line.vat,
      total: line.total,
      priceIncludesVat: line.priceIncludesVat,
      vatCategory: line.vatCategory,
      vatRate: line.vatRate,
      picture: null,
      ...over.extras?.(i),
    })),
  }
}

function invoicePdf(
  input: SaleInput,
  over: {
    locale?: 'en' | 'ar'
    extras?: (i: number) => LineExtras
    wanted?: string
    wholeAmounts?: boolean
    images?: Readonly<Record<string, DocumentPdfImage>>
  } = {},
): DocumentPdfInput {
  const amounts = over.wanted
    ? solveRoundAmount(input, over.wanted as Money, 'AED').sale
    : computeSale(input, 'AED')
  return buildInvoicePdfInput({
    business: business({
      locale: over.locale ?? 'en',
      vatRegistered: input.vatRegistered,
      trn: input.vatRegistered ? '100123456700003' : null,
      wholeAmounts: over.wholeAmounts ?? false,
    }),
    invoice: invoiceOf(input, amounts, over.extras ? { extras: over.extras } : {}),
    customer,
    businessImages: { logo: null, signature: null, stamp: null },
    images: over.images ?? {},
  })
}

const creditLine = (over: Partial<PdfCreditNote['lines'][number]>) => ({
  title: 'Painting',
  qty: '100',
  unit: 'm2' as const,
  unitPrice: '18',
  priceIncludesVat: false,
  vatCategory: 'standard' as const,
  vatRate: '5',
  net: '1800.00',
  vat: '90.00',
  total: '1890.00',
  ...over,
})

function creditPdf(
  lines: readonly ReturnType<typeof creditLine>[],
  over: Partial<PdfCreditNote> & { locale?: 'en' | 'ar' } = {},
): DocumentPdfInput {
  const { locale, ...note } = over
  const tax = over.kind !== 'credit_note'
  return buildCreditNotePdfInput({
    business: business({ locale: locale ?? 'en', vatRegistered: tax, trn: tax ? '1001' : null }),
    creditNote: {
      kind: 'tax_credit_note',
      number: 'CN-0001',
      draft: false,
      issueDate: '2026-10-25',
      invoiceNumber: 'INV-0001',
      invoiceDate: '2026-10-18',
      reason: 'price_changed',
      reasonText: 'Part of the work was not done.',
      currency: 'AED',
      vatRegistered: tax,
      netTotal: sumDecimals(lines.map((l) => l.net)),
      vatTotal: sumDecimals(lines.map((l) => l.vat)),
      total: sumDecimals(lines.map((l) => l.total)),
      vatRates: [],
      valueBefore: '13725.00',
      valueAfter: '11925.00',
      notes: null,
      issuedAt: new Date(Date.UTC(2026, 9, 25, 8, 0, 0)),
      lines,
      ...note,
    },
    customer,
    businessImages: { logo: null, signature: null, stamp: null },
    images: {},
  })
}

/** "1,047.62" → "1047.62". */
const plain = (printed: string | null | undefined) => {
  if (printed === null || printed === undefined) throw new Error('a column did not print')
  return printed.replace(/,/g, '')
}

/** A row as a person checks it, with the amounts as they print. */
function expectRowReads(line: DocumentPdfLine): void {
  const asTyped = proportionOf(plain(line.unitPrice), plain(line.qty), '1', 2)
  const reached = subtractDecimals(asTyped, plain(line.discount))
  const said = `${line.unitPrice} × ${line.qty} − ${line.discount}`
  const before = plain(line.beforeVat)
  const vat = plain(line.vatAmount)
  const total = plain(line.amount)
  expect(compareDecimal(reached, line.includesVat ? total : before), said).toBe(0)
  expect(compareDecimal(sumDecimals([before, vat]), total), `${before} + ${vat}`).toBe(0)
}

// ---------------------------------------------------------------------------------------------------
// What each row prints
// ---------------------------------------------------------------------------------------------------

const decimal = (max: number, digits: number) =>
  fc.integer({ min: 0, max: max * 10 ** digits }).map((value) => {
    const text = String(value).padStart(digits + 1, '0')
    return `${text.slice(0, -digits)}.${text.slice(-digits)}`
  })

const generated: fc.Arbitrary<SaleInput> = fc
  .constantFrom<'before' | 'with' | 'both'>('before', 'with', 'both')
  .chain((ways) =>
    fc.record({
      lines: fc.array(
        fc
          .record({
            qty: decimal(40, 3).filter((qty) => compareDecimal(qty, '0') > 0),
            unitPrice: decimal(9000, 2),
            priceIncludesVat: ways === 'both' ? fc.boolean() : fc.constant(ways === 'with'),
            vatCategory: fc.constantFrom<VatCategory>(
              'standard',
              'standard',
              'zero_rated',
              'exempt',
            ),
            percent: fc.option(decimal(40, 2), { nil: null }),
          })
          .map(({ qty, unitPrice, priceIncludesVat, vatCategory, percent }) =>
            item(qty, unitPrice, {
              priceIncludesVat,
              vatCategory,
              discount: percent === null ? null : { percent: percent as Percent },
            }),
          ),
        { minLength: 1, maxLength: 8 },
      ),
      vatRegistered: fc.constant(true),
      discount: fc.oneof(
        { weight: 2, arbitrary: fc.constant(null) },
        {
          weight: 1,
          arbitrary: decimal(30, 2).map((percent) => ({ percent: percent as Percent })),
        },
      ),
    }),
  )
  .filter((input) => saleError(input, 'AED') === null)

describe('every row adds up as printed', () => {
  it('whatever its discounts, rates and prices; the columns come to the rates and the total', () => {
    fc.assert(
      fc.property(generated, (input) => {
        const amounts = computeSale(input, 'AED')
        const printed = invoicePdf(input)
        printed.lines.forEach(expectRowReads)
        for (const rate of amounts.rates) {
          const at = printed.lines.filter((_, i) => {
            const line = amounts.lines[i]!
            return line.vatCategory === rate.vatCategory && line.vatRate === rate.vatRate
          })
          expect(sumDecimals(at.map((l) => plain(l.vatAmount)))).toBe(sumDecimals([rate.vat]))
          expect(sumDecimals(at.map((l) => plain(l.beforeVat)))).toBe(sumDecimals([rate.net]))
        }
        expect(sumDecimals(printed.lines.map((l) => plain(l.amount)))).toBe(
          sumDecimals([amounts.total]),
        )
      }),
      { numRuns: 400 },
    )
  })

  it('with "Round the total": the line totals and the rounding difference come to what is asked', () => {
    fc.assert(
      fc.property(generated, fc.integer({ min: 50, max: 150 }), (input, percent) => {
        const total = computeSale(input, 'AED').total
        const wanted = proportionOf(total, String(percent), '100', 2)
        const solved = solveRoundAmount(input, wanted as Money, 'AED')
        const printed = invoicePdf(input, { wanted })
        printed.lines.forEach(expectRowReads)
        expect(
          sumDecimals([...printed.lines.map((l) => plain(l.amount)), solved.roundingDifference]),
        ).toBe(sumDecimals([wanted]))
      }),
      { numRuns: 300 },
    )
  })

  it('a plain invoice: unit price × qty − discount = total, whatever its document discount', () => {
    const input: SaleInput = {
      vatRegistered: false,
      lines: [item('2', '500', { discount: { amount: '100' as Money } }), item('1', '250')],
      discount: { percent: '10' as Percent },
    }
    const printed = invoicePdf(input)
    expect(printed.table).toMatchObject({ rows: 'plain' })
    expect(printed.table.vatHead).toBeUndefined()
    expect(printed.lines.map((l) => [l.discount, l.amount, l.beforeVat, l.vatAmount])).toEqual([
      ['190.00', '810.00', null, null],
      ['25.00', '225.00', null, null],
    ])
  })
})

describe('the hard cases read', () => {
  it('no discount prints 0.00 on a tax document, and never a rate per line with one rate', () => {
    const printed = invoicePdf({ vatRegistered: true, lines: [item('120', '45')] })
    expect(printed.table.vatHead).toBe('VAT 5%')
    expect(printed.lines[0]).toMatchObject({
      unitPrice: '45.00',
      qty: '120',
      discount: '0.00',
      beforeVat: '5,400.00',
      vatAmount: '270.00',
      amount: '5,670.00',
      vatRate: null,
    })
  })

  it('a price with VAT stays as typed and is marked; its row reads to the total', () => {
    const printed = invoicePdf({
      vatRegistered: true,
      lines: [item('3', '10', { priceIncludesVat: true })],
    })
    expect(printed.lines[0]).toMatchObject({
      unitPrice: '10.00',
      discount: '0.00',
      beforeVat: '28.57',
      vatAmount: '1.43',
      amount: '30.00',
      includesVat: true,
    })
  })

  it('"Round the total" with a price with VAT: 1,120.00 → 1,100.00 reads with a discount of 20.00', () => {
    const printed = invoicePdf(
      { vatRegistered: true, lines: [item('1', '1120', { priceIncludesVat: true })] },
      { wanted: '1100.00' },
    )
    expect(printed.lines[0]).toMatchObject({
      unitPrice: '1,120.00',
      discount: '20.00',
      beforeVat: '1,047.62',
      vatAmount: '52.38',
      amount: '1,100.00',
    })
  })

  it('a total rounded up prints a negative discount, so the row still adds up', () => {
    const printed = invoicePdf(
      { vatRegistered: true, lines: [item('1', '1000')] },
      { wanted: '1100.00' },
    )
    expect(printed.lines[0]).toMatchObject({
      discount: '-47.62',
      beforeVat: '1,047.62',
      amount: '1,100.00',
    })
  })

  it('a deposit taken off reads 1 × its price below zero, with 0.00', () => {
    const line: PdfInvoiceLine = {
      kind: 'deduction',
      area: null,
      title: 'Less deposit invoice INV-0005',
      details: null,
      note: null,
      qty: '-1',
      unit: null,
      unitPrice: '5000.00',
      subtotal: '-5000.00',
      lineDiscount: '0',
      net: '-5000.00',
      vat: '-250.00',
      total: '-5250.00',
      priceIncludesVat: false,
      vatCategory: 'standard',
      vatRate: '5',
      picture: null,
    }
    const input: SaleInput = { vatRegistered: true, lines: [item('1', '20000')] }
    const amounts = computeSale(input, 'AED')
    const invoice = invoiceOf(input, amounts)
    const printed = buildInvoicePdfInput({
      business: business(),
      invoice: { ...invoice, lines: [...invoice.lines, line] },
      customer,
      businessImages: { logo: null, signature: null, stamp: null },
      images: {},
    })
    expect(printed.lines[1]).toMatchObject({
      qty: '1',
      unitPrice: '-5,000.00',
      discount: '0.00',
      beforeVat: '-5,000.00',
      vatAmount: '-250.00',
      amount: '-5,250.00',
    })
    printed.lines.forEach(expectRowReads)
  })

  it('a part of a quotation, priced with VAT with its share of the VAT, reads to its total', () => {
    const input: SaleInput = { vatRegistered: true, lines: [item('1', '0')] }
    const invoice = invoiceOf(input, computeSale(input, 'AED'))
    const printed = buildInvoicePdfInput({
      business: business(),
      invoice: {
        ...invoice,
        lines: [
          {
            ...invoice.lines[0]!,
            qty: '1',
            unit: null,
            unitPrice: '11850.00',
            subtotal: '11850.00',
            net: '11285.72',
            vat: '564.28',
            total: '11850.00',
            priceIncludesVat: true,
          },
        ],
      },
      customer,
      businessImages: { logo: null, signature: null, stamp: null },
      images: {},
    })
    expect(printed.lines[0]).toMatchObject({ discount: '0.00', includesVat: true })
    expectRowReads(printed.lines[0]!)
  })

  it('a credit note: what is left of a discounted line keeps its price and shows the discount', () => {
    // The invoice's 10 × 100.00 with 10 % off the document: all that is left, 900.00, as stored.
    const printed = creditPdf([
      creditLine({
        title: 'Partitions',
        qty: '10',
        unitPrice: '100',
        net: '900.00',
        vat: '45.00',
        total: '945.00',
      }),
    ])
    expect(printed.table).toMatchObject({ rows: 'tax', vatHead: 'VAT 5%' })
    expect(printed.lines[0]).toMatchObject({
      unitPrice: '100.00',
      discount: '100.00',
      beforeVat: '900.00',
      vatAmount: '45.00',
      amount: '945.00',
    })
    expectRowReads(printed.lines[0]!)
  })

  it('a credit note by amount: no price or quantity, 0.00, and its row is before VAT + VAT = total', () => {
    const printed = creditPdf(
      [
        creditLine({
          qty: '1',
          unit: null,
          unitPrice: '105',
          priceIncludesVat: true,
          net: '100.00',
          vat: '5.00',
          total: '105.00',
        }),
      ],
      { by: 'amount' },
    )
    expect(printed.lines[0]).toMatchObject({
      unitPrice: '—',
      qty: '—',
      unit: null,
      discount: '0.00',
      beforeVat: '100.00',
      vatAmount: '5.00',
      amount: '105.00',
      includesVat: false,
    })
  })

  it('a credit note with a price with VAT: its total, its before VAT and its VAT each in its column', () => {
    const printed = creditPdf([
      creditLine({
        qty: '2',
        unit: 'piece',
        unitPrice: '105',
        priceIncludesVat: true,
        net: '200.00',
        vat: '10.00',
        total: '210.00',
      }),
    ])
    expect(printed.lines[0]).toMatchObject({
      discount: '0.00',
      beforeVat: '200.00',
      amount: '210.00',
      includesVat: true,
    })
    expectRowReads(printed.lines[0]!)
  })

  it('a plain credit note has no VAT columns', () => {
    const printed = creditPdf(
      [
        creditLine({
          vatCategory: null as never,
          vatRate: null as never,
          vat: '0',
          total: '1800.00',
        }),
      ],
      { kind: 'credit_note' },
    )
    expect(printed.table.rows).toBe('plain')
    expect(printed.table.vatHead).toBeUndefined()
    expect(printed.lines[0]).toMatchObject({
      beforeVat: null,
      vatAmount: null,
      vatRate: null,
      amount: '1,800.00',
    })
  })
})

describe('the VAT heading', () => {
  const heading = (categories: readonly VatCategory[]) =>
    invoicePdf({
      vatRegistered: true,
      lines: categories.map((vatCategory) => item('1', '100', { vatCategory })),
    })

  it('one rate is said once: VAT 5%, VAT 0%, VAT exempt, in Latin in both languages', () => {
    expect(heading(['standard', 'standard']).table.vatHead).toBe('VAT 5%')
    expect(heading(['zero_rated']).table.vatHead).toBe('VAT 0%')
    expect(heading(['exempt']).table.vatHead).toBe('VAT exempt')
    for (const input of [heading(['standard']), heading(['zero_rated']), heading(['exempt'])]) {
      expect(input.lines.every((line) => line.vatRate === null)).toBe(true)
    }
    const arabic = invoicePdf({ vatRegistered: true, lines: [item('1', '100')] }, { locale: 'ar' })
    expect(arabic.table.vatHead).toBe('VAT 5%')
  })

  it('mixed rates: the heading is VAT and each row says its own', () => {
    const mixed = heading(['standard', 'zero_rated', 'exempt'])
    expect(mixed.table.vatHead).toBe('VAT')
    expect(mixed.lines.map((line) => line.vatRate)).toEqual(['5%', '0%', 'Exempt'])
    const arabic = invoicePdf(
      {
        vatRegistered: true,
        lines: [item('1', '100'), item('1', '100', { vatCategory: 'exempt' })],
      },
      { locale: 'ar' },
    )
    expect(arabic.table.vatHead).toBe('VAT')
    expect(arabic.lines.map((line) => line.vatRate)).toEqual(['5%', 'معفى'])
  })
})

// ---------------------------------------------------------------------------------------------------
// As drawn, by the real compiler
// ---------------------------------------------------------------------------------------------------

let core: Core

beforeAll(async () => {
  core = await createCore()
}, 60_000)

const samples = new URL('../../../scripts/samples/images/', import.meta.url)
function sampleImage(file: string): { bytes: Uint8Array; image: DocumentPdfImage } {
  const bytes = new Uint8Array(readFileSync(new URL(file, samples)))
  const info = pdfImageInfo(bytes)!
  return {
    bytes,
    image: {
      path: `/img/${file.replace(/\.\w+$/, '')}.${info.format}`,
      format: info.format,
      width: info.width,
      height: info.height,
    },
  }
}

const render = (input: DocumentPdfInput, images: { path: string; bytes: Uint8Array }[] = []) =>
  core.render({ data: JSON.stringify(input), images })

const named = (runs: readonly PlacedRun[], pattern: RegExp) =>
  runs.filter((run) => pattern.test(normalizeText(run.text)))
const one = (runs: readonly PlacedRun[], pattern: RegExp) => {
  const found = named(runs, pattern)
  expect(found.length, String(pattern)).toBe(1)
  return found[0]!
}
const right = (run: PlacedRun) => run.x + run.width

/** The x of each head, in the columns' reading order. */
const HEADS = [/^Unit price$/, /^Qty$/, /^Discount$/, /^Before VAT$/, /^VAT 5%$/, /^Total$/]

/** The table head's run (the totals repeat some of its words, lower down). */
const headRun = (runs: readonly PlacedRun[], pattern: RegExp) =>
  named(runs, pattern).reduce((a, b) => (a.y > b.y ? a : b))

describe('as drawn', () => {
  const mix: SaleInput = {
    vatRegistered: true,
    lines: [item('120', '45', { discount: { percent: '10' as Percent } }), item('300', '18')],
  }

  it('reads Unit price | Qty | Discount | Before VAT | VAT 5% | Total, in both directions', async () => {
    for (const locale of ['en', 'ar'] as const) {
      const [page] = await pdfRuns(await render(invoicePdf(mix, { locale })))
      const xs = HEADS.map((pattern) => headRun(page!.runs, pattern).x)
      const inOrder = locale === 'en' ? xs : [...xs].reverse()
      expect(inOrder).toEqual([...inOrder].sort((a, b) => a - b))
      // The description on the start side of them all.
      const description = one(page!.runs, /^Description$/)
      if (locale === 'en') expect(right(description)).toBeLessThan(Math.min(...xs))
      else expect(description.x).toBeGreaterThan(Math.max(...xs))
    }
  }, 30_000)

  it('the VAT heading is one Latin line, no Arabic pair, and no rate per line', async () => {
    const pdf = await render(invoicePdf(mix))
    const [page] = await pdfRuns(pdf)
    const vat = one(page!.runs, /^VAT 5%$/)
    const before = headRun(page!.runs, /^Before VAT$/)
    const total = headRun(page!.runs, /^Total$/)
    const head = page!.runs.filter(
      (run) =>
        Math.abs(run.y - vat.y) < 14 && run.x > right(before) + 1 && right(run) < total.x - 1,
    )
    expect(head.map((run) => normalizeText(run.text))).toEqual(['VAT 5%'])
    // One rate: said once, never on a row.
    expect(named(page!.runs, /^5%$/)).toEqual([])
  }, 30_000)

  it('prints each amount under its own heading, 0.00 where there is no discount', async () => {
    const [page] = await pdfRuns(await render(invoicePdf(mix)))
    const edge = (pattern: RegExp) => right(headRun(page!.runs, pattern))
    const under = (text: RegExp, heading: RegExp) => {
      const run = one(page!.runs, text)
      expect(Math.abs(right(run) - edge(heading)), String(text)).toBeLessThan(1)
    }
    // 120 × 45.00 = 5,400.00 − 540.00 = 4,860.00 + 243.00 = 5,103.00.
    under(/^540\.00$/, /^Discount$/)
    under(/^4,860\.00$/, /^Before VAT$/)
    under(/^243\.00$/, /^VAT 5%$/)
    under(/^5,103\.00$/, /^Total$/)
    // 300 × 18.00 = 5,400.00 − 0.00.
    under(/^0\.00$/, /^Discount$/)
    under(/^5,400\.00$/, /^Before VAT$/)
    under(/^270\.00$/, /^VAT 5%$/)
    under(/^5,670\.00$/, /^Total$/)
  }, 30_000)

  it('mixed rates: the heading is VAT, each row says its rate or word under its VAT', async () => {
    const input: SaleInput = {
      vatRegistered: true,
      lines: [
        item('1', '1000'),
        item('1', '500', { vatCategory: 'zero_rated' }),
        item('1', '250', { vatCategory: 'exempt' }),
      ],
    }
    const [en] = await pdfRuns(await render(invoicePdf(input)))
    const vat = one(en!.runs, /^VAT$/)
    expect(named(en!.runs, /^VAT 5%$/)).toEqual([])
    for (const word of [/^5%$/, /^0%$/, /^Exempt$/]) {
      expect(Math.abs(right(one(en!.runs, word)) - right(vat))).toBeLessThan(1)
    }
    const [ar] = await pdfRuns(await render(invoicePdf(input, { locale: 'ar' })))
    const heading = one(ar!.runs, /^VAT$/)
    expect(Math.abs(right(one(ar!.runs, /^5%$/)) - right(heading))).toBeLessThan(1)
    expect(named(ar!.runs, /^VAT 5%$/)).toEqual([])
  }, 30_000)

  it('a price with VAT says so under the price, not under the total', async () => {
    const [page] = await pdfRuns(
      await render(
        invoicePdf({
          vatRegistered: true,
          lines: [item('2', '105', { priceIncludesVat: true })],
        }),
      ),
    )
    const mark = one(page!.runs, /^incl\. VAT$/)
    expect(Math.abs(right(mark) - right(headRun(page!.runs, /^Unit price$/)))).toBeLessThan(1)
    // Its row and the totals' rows.
    expect(named(page!.runs, /^210\.00$/).length).toBeGreaterThan(0)
    expect(named(page!.runs, /^200\.00$/).length).toBeGreaterThan(0)
  }, 30_000)

  it('a plain invoice has Unit price | Qty | Discount | Total and never the word VAT or tax', async () => {
    const input: SaleInput = {
      vatRegistered: false,
      lines: [item('2', '500', { discount: { amount: '100' as Money } }), item('1', '250')],
    }
    for (const locale of ['en', 'ar'] as const) {
      const pdf = await render(invoicePdf(input, { locale }))
      const [page] = await pdfRuns(pdf)
      const xs = [/^Unit price$/, /^Qty$/, /^Discount$/, /^Total$/].map(
        (pattern) => headRun(page!.runs, pattern).x,
      )
      const inOrder = locale === 'en' ? xs : [...xs].reverse()
      expect(inOrder).toEqual([...inOrder].sort((a, b) => a - b))
      const text = normalizeText(await pdfFullText(pdf))
      expect(text).not.toMatch(/\bVAT\b/i)
      expect(text).not.toMatch(/\btax\b/i)
      expect(text).not.toContain(normalizeText('الضريب'))
      expect(text).not.toContain(normalizeText('قبل'))
      expect(text).toContain('0.00')
      expect(text).toContain('900.00')
    }
    // With whole amounts on, its discount follows the business's setting.
    const whole = await render(invoicePdf(input, { wholeAmounts: true }))
    const [wholePage] = await pdfRuns(whole)
    expect(one(wholePage!.runs, /^0$/)).toBeDefined()
    expect(one(wholePage!.runs, /^100$/)).toBeDefined()
  }, 60_000)

  it('a tax credit note has the same columns, 0.00 and the rows that add up', async () => {
    const pdf = await render(creditPdf([creditLine({})]))
    const [page] = await pdfRuns(pdf)
    const xs = HEADS.map((pattern) => headRun(page!.runs, pattern).x)
    expect(xs).toEqual([...xs].sort((a, b) => a - b))
    const text = normalizeText(await pdfFullText(pdf))
    expect(text).toContain('0.00')
    expect(text).toContain('1,890.00')
  }, 30_000)

  it('a page break repeats the head with its VAT 5%, on every page that has lines', async () => {
    const lines = Array.from({ length: 60 }, () => item('2', '150'))
    const pages = await pdfRuns(await render(invoicePdf({ vatRegistered: true, lines })))
    expect(pages.length).toBeGreaterThan(1)
    for (const page of pages.filter((p) => named(p.runs, /^Work item \d+$/).length > 0)) {
      for (const pattern of HEADS) expect(named(page.runs, pattern).length).toBeGreaterThan(0)
    }
    const all = pages.flatMap((page) => page.runs)
    expect(named(all, /^Work item 60$/)).toHaveLength(1)
    expect(named(all, /^0\.00$/)).toHaveLength(60)
  }, 60_000)

  /** No two runs drawn on one line touch, and each stays inside the page's margins. */
  function expectNoOverlap(runs: readonly PlacedRun[]): void {
    for (const run of runs) {
      expect(run.x, run.text).toBeGreaterThanOrEqual(MARGIN - 1)
      expect(right(run), run.text).toBeLessThanOrEqual(PAGE_W - MARGIN + 1)
    }
    for (const [i, a] of runs.entries()) {
      for (const b of runs.slice(i + 1)) {
        if (Math.abs(a.y - b.y) > 2) continue
        const shared = Math.min(right(a), right(b)) - Math.max(a.x, b.x)
        expect(shared, `${a.text} and ${b.text}`).toBeLessThan(0.5)
      }
    }
  }

  /** The table's runs: between its head and the first totals row. */
  const tableRuns = (runs: readonly PlacedRun[]) => {
    const head = runs.find((run) => /^Description$/.test(normalizeText(run.text)))!
    const end = Math.max(...named(runs, /^(Total before VAT|Total)$/).map((r) => r.y))
    const bottom = named(runs, /^Total before VAT$/)[0]?.y ?? end
    return runs.filter((run) => run.y <= head.y && run.y > bottom + 8)
  }

  it('amounts in the millions, in areas with pictures: the numbers go smaller, whole, nothing touches', async () => {
    const made = sampleImage('line-1.jpg')
    const input: SaleInput = {
      vatRegistered: true,
      lines: [
        item('62.5', '125000', { discount: { percent: '1' as Percent } }),
        item('12', '98765.43', { vatCategory: 'exempt' }),
      ],
    }
    // The same amounts with the page to themselves print at the full size.
    const [roomy] = await pdfRuns(await render(invoicePdf(input)))
    const fullWidth = named(roomy!.runs, /^8,121,093\.75$/)[0]!.width
    for (const locale of ['en', 'ar'] as const) {
      const printed = invoicePdf(input, {
        locale,
        images: { 'line-1': made.image },
        extras: () => ({ area: 'MAJLIS', picture: 'line-1', title: 'W'.repeat(60) }),
      })
      const pdf = await render(printed, [{ path: made.image.path, bytes: made.bytes }])
      const pages = await pdfRuns(pdf)
      const page = pages[0]!
      expectNoOverlap(tableRuns(page.runs))
      expect(named(page.runs, /^8,121,093\.75$/)[0]!.width).toBeLessThan(fullWidth)
      // Every amount printed whole, each on one line under its heading.
      const under = (amount: string, heading: RegExp) => {
        const edge = right(headRun(page.runs, heading))
        const runs = named(page.runs, new RegExp(`^${amount.replace(/[.,]/g, '\\$&')}$`))
        expect(
          runs.some((run) => Math.abs(right(run) - edge) < 1),
          amount,
        ).toBe(true)
      }
      for (const line of printed.lines) {
        under(line.unitPrice, /^Unit price$/)
        under(line.discount!, /^Discount$/)
        under(line.beforeVat!, /^Before VAT$/)
        under(line.vatAmount!, /^VAT$/)
        under(line.amount, /^Total$/)
      }
      const text = pages.flatMap((p) => p.runs.map((run) => run.text)).join('')
      expect(text.split('W').length - 1).toBeGreaterThanOrEqual(2 * 60)
    }
  }, 120_000)

  it('billions beside a picture and an area: they break after a comma, in their own cells', async () => {
    const made = sampleImage('line-1.jpg')
    const input: SaleInput = {
      vatRegistered: true,
      lines: [item('1250.5', '1250000', { discount: { percent: '1' as Percent } })],
    }
    for (const locale of ['en', 'ar'] as const) {
      const pdf = await render(
        invoicePdf(input, {
          locale,
          images: { 'line-1': made.image },
          extras: () => ({ area: 'MAJLIS', picture: 'line-1' }),
        }),
        [{ path: made.image.path, bytes: made.bytes }],
      )
      const [page] = await pdfRuns(pdf)
      expectNoOverlap(tableRuns(page!.runs))
      // 1,547,493,750.00 before VAT: its last groups end on its heading's edge, its comma too.
      const edge = right(headRun(page!.runs, /^Before VAT$/))
      for (const piece of [/^493,$/, /^750\.00$/]) {
        const run = named(page!.runs, piece).find((r) => Math.abs(right(r) - edge) < 1)
        expect(run, String(piece)).toBeDefined()
      }
    }
  }, 60_000)

  it('sixteen-digit amounts, more than any size can hold: they break after a comma, in their cells', async () => {
    const input: SaleInput = {
      vatRegistered: true,
      lines: [
        item('999', '9999999999999', { discount: { percent: '5' as Percent } }),
        item('1', '450'),
      ],
    }
    for (const locale of ['en', 'ar'] as const) {
      const pdf = await render(invoicePdf(input, { locale }))
      const pages = await pdfRuns(pdf)
      expectNoOverlap(tableRuns(pages[0]!.runs))
      // No digit lost: 9,490,499,999,999,051.05 before VAT, as the amount's parts drawn in order.
      const digits = pages[0]!.runs.map((run) => normalizeText(run.text)).join('')
      expect(digits.replace(/[^\d.,-]/g, '')).toContain('9,490,499,')
      expect(normalizeText(await pdfFullText(pdf))).toContain('450.00')
    }
  }, 60_000)

  it('sixteen digits in a VAT label of the totals: it wraps in its cell, never over its amount', async () => {
    const input: SaleInput = {
      vatRegistered: true,
      lines: [
        item('999', '9999999999999', { discount: { percent: '5' as Percent } }),
        item('1', '450'),
      ],
    }
    const amounts = computeSale(input, 'AED')
    const vat = formatAmount(amounts.vat, 2, false)
    const net = formatAmount(amounts.net, 2, false)
    for (const locale of ['en', 'ar'] as const) {
      const pdf = await render(invoicePdf(input, { locale }))
      const [page] = await pdfRuns(pdf)
      const amount = one(page!.runs, new RegExp(`^${vat.replace(/[.,]/g, '\\$&')}$`))
      for (const run of page!.runs) {
        if (run === amount || Math.abs(run.y - amount.y) > 7) continue
        const shared = Math.min(right(run), right(amount)) - Math.max(run.x, amount.x)
        expect(shared, `${run.text} and ${vat}`).toBeLessThan(0.5)
      }
      // The whole number is there, in order, across its lines.
      const text = normalizeText(await pdfFullText(pdf)).replace(/[\s\p{Cf}]/gu, '')
      expect(text).toContain(`VAT5%on${net}`)
    }
  }, 60_000)

  it('wide letters stay in the description beside ten-digit amounts, a row taller than a page breaks', async () => {
    const pdf = await render(
      invoicePdf(
        {
          vatRegistered: true,
          lines: [item('1250.5', '1250000'), item('1', '50')],
        },
        {
          extras: (i) =>
            i === 0
              ? { title: 'W'.repeat(60) }
              : {
                  details: Array.from({ length: 160 }, (_, k) => `Fitting ${k + 1}`).join('\n'),
                },
        },
      ),
    )
    const pages = await pdfRuns(pdf)
    expect(pages.length).toBeGreaterThan(1)
    const head = headRun(pages[0]!.runs, /^Unit price$/)
    for (const run of named(pages[0]!.runs, /W{4}/)) expect(right(run)).toBeLessThan(head.x)
    for (const page of pages) {
      for (const run of named(page.runs, /^Fitting \d+$/)) expect(run.y).toBeGreaterThan(FOOT)
    }
    expect(normalizeText(await pdfFullText(pdf))).toContain('Fitting 160')
  }, 60_000)

  it('areas over a page break: each page names its area, the rows keep their columns', async () => {
    const lines = Array.from({ length: 30 }, () => item('2', '150'))
    const pages = await pdfRuns(
      await render(
        invoicePdf(
          { vatRegistered: true, lines },
          { extras: (i) => ({ area: `Area ${Math.floor(i / 12) + 1}` }) },
        ),
      ),
    )
    expect(pages.length).toBeGreaterThan(1)
    for (const page of pages.filter((p) => named(p.runs, /^Work item \d+$/).length > 0)) {
      expect(named(page.runs, /^Area \d+$/).length).toBeGreaterThan(0)
      expect(named(page.runs, /^VAT 5%$/).length).toBeGreaterThan(0)
    }
  }, 60_000)
})

describe('a quotation keeps its own columns', () => {
  const quotation = (lineDiscount: string) =>
    buildQuotationPdfInput({
      business: business(),
      quotation: {
        number: 'Q-0042',
        revision: 1,
        draft: false,
        businessDate: '2026-10-08',
        validUntil: null,
        customerRef: null,
        site: null,
        currency: 'AED',
        vatRegistered: true,
        subtotal: '1000.00',
        discountTotal: lineDiscount,
        adjustment: '0',
        roundingDifference: '0',
        netTotal: '1000.00',
        vatTotal: '50.00',
        total: '1050.00',
        payable: '1050.00',
        vatRates: [{ vatCategory: 'standard', vatRate: '5', net: '1000.00', vat: '50.00' }],
        greeting: null,
        intro: null,
        terms: null,
        notes: null,
        issuedAt: new Date(Date.UTC(2026, 9, 8, 9, 30, 0)),
        lines: [
          {
            area: null,
            title: 'Wall cladding',
            details: null,
            note: null,
            qty: '1',
            unit: 'piece',
            unitPrice: '1000.00',
            subtotal: '1000.00',
            lineDiscount,
            priceIncludesVat: false,
            vatCategory: 'standard',
            vatRate: '5',
            picture: null,
          },
        ],
        stages: [],
      },
      customer: { ...customer, trn: null },
      businessImages: { logo: null, signature: null, stamp: null },
      images: {},
    })

  it('Unit price | Qty | Amount; no discount column without a discount; no VAT column', async () => {
    const [page] = await pdfRuns(await render(quotation('0')))
    expect(one(page!.runs, /^Amount$/)).toBeDefined()
    expect(named(page!.runs, /^Discount$/).filter((r) => r.y > FOOT * 4)).toEqual([])
    expect(named(page!.runs, /^Before VAT$/)).toEqual([])
    expect(named(page!.runs, /^VAT 5%$/)).toEqual([])
  }, 30_000)

  it('its discount column appears only with a discount, and it prints no 0.00 for it', () => {
    const none = quotation('0')
    expect(none.table.rows).toBeUndefined()
    expect(none.lines[0]).toMatchObject({ discount: null, amount: '1,000.00' })
    const some = quotation('50.00')
    expect(some.table.showDiscount).toBe(true)
    expect(some.lines[0]).toMatchObject({ discount: '50.00', amount: '950.00' })
  })
})

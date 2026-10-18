import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { breakable, buildQuotationPdfInput, type PdfQuotationLine } from './build'
import { pdfImageInfo } from './images'
import type { DocumentPdfImage } from './input'
import { normalizeText, pdfFullText, pdfGlyphCount, pdfRuns, type PlacedRun } from './text-layer'
import { createCore, type Core } from './typst-core.mjs'

// Hostile layouts (M3 Step 7 review fixes; D-224 "no text is ever cut", D-295): text typed to run out
// of its cell, terms and rows taller than a page, a long address, each rendered by the real compiler
// and checked by where its text is drawn, not only that it is there: a run of no-break spaces never
// pushes a price into the next column, long stage names and references wrap in their own columns, a
// long email stays in the footer, the closing and a tall row never reach the footer, and the footer's
// contact lines never reach the content. Fictional data only (the demo fit-out's kind of work).

const MM = 72 / 25.4
const PAGE_W = 210 * MM
const MARGIN = 14 * MM
/** The least bottom margin (32 mm): content stays above it. */
const FOOT = 32 * MM

const samples = new URL('../../../scripts/samples/images/', import.meta.url)
function sampleImage(file: string): { bytes: Uint8Array; image: DocumentPdfImage } {
  const bytes = new Uint8Array(readFileSync(new URL(file, samples)))
  const info = pdfImageInfo(bytes)!
  const key = file.replace(/\.\w+$/, '')
  return {
    bytes,
    image: {
      path: `/img/${key}.${info.format}`,
      format: info.format,
      width: info.width,
      height: info.height,
    },
  }
}

interface Options {
  locale?: 'en' | 'ar'
  lines?: readonly Partial<PdfQuotationLine>[]
  customerName?: string
  customerRef?: string | null
  email?: string | null
  addressLine?: string | null
  city?: string | null
  terms?: string | null
  footer?: string | null
  stages?: readonly { label: string | null; due: string; percent: string; amount: string }[]
  logo?: boolean
}

function render(core: Core, options: Options) {
  const images: Record<string, DocumentPdfImage> = {}
  const files: { path: string; bytes: Uint8Array }[] = []
  const map = (key: string, file: string) => {
    const made = sampleImage(file)
    images[key] = made.image
    files.push({ path: made.image.path, bytes: made.bytes })
  }
  if (options.logo) map('logo', 'logo.png')
  const lines = (options.lines ?? [{}]).map((over, i): PdfQuotationLine => ({
    area: null,
    title: `Work item ${i + 1}`,
    details: null,
    note: null,
    qty: '1',
    unit: 'piece',
    unitPrice: '500.00',
    subtotal: '500.00',
    lineDiscount: '0',
    priceIncludesVat: false,
    vatCategory: 'standard',
    vatRate: '5',
    picture: null,
    ...over,
  }))
  lines.forEach((line, i) => {
    if (line.picture) map(line.picture, `line-${(i % 3) + 1}.jpg`)
  })
  const input = buildQuotationPdfInput({
    business: {
      legalName: 'Modern Touch Interiors',
      legalNameAr: 'لمسة عصرية للديكور',
      locale: options.locale ?? 'en',
      vatRegistered: true,
      trn: '100123456700003',
      phone: '+971 4 555 0142',
      phone2: '+971 50 555 0199',
      email: options.email === undefined ? 'hello@moderntouch.example' : options.email,
      addressLine: options.addressLine === undefined ? 'Warehouse 7, Al Quoz' : options.addressLine,
      city: options.city ?? null,
      emirate: 'dubai',
      tradeLicenceNo: 'DED-778812',
      accent: 'navy',
      watermark: true,
      wholeAmounts: false,
      signatory: 'Abdullah Al Kaabi',
      footer: options.footer ?? null,
    },
    quotation: {
      number: 'Q-0042',
      revision: 1,
      draft: false,
      businessDate: '2026-10-08',
      validUntil: '2026-11-07',
      customerRef: options.customerRef ?? null,
      site: 'Villa 18, Al Barsha South',
      currency: 'AED',
      vatRegistered: true,
      subtotal: '500.00',
      discountTotal: '0',
      adjustment: '0',
      roundingDifference: '0',
      netTotal: '500.00',
      vatTotal: '25.00',
      total: '525.00',
      payable: '525.00',
      vatRates: [{ vatCategory: 'standard', vatRate: '5', net: '500.00', vat: '25.00' }],
      greeting: null,
      intro: null,
      terms: options.terms ?? null,
      notes: null,
      issuedAt: new Date(Date.UTC(2026, 9, 8, 9, 30, 0)),
      lines,
      stages: options.stages ?? [],
    },
    customer: {
      name: options.customerName ?? 'Al Noor Hospitality Group Holdings LLC',
      phone: '+971 55 555 0123',
      trn: null,
      addressLine: null,
      city: null,
      emirate: null,
    },
    businessImages: { logo: options.logo ? 'logo' : null, signature: null, stamp: null },
    images,
  })
  return core.render({ data: JSON.stringify(input), images: files })
}

const touching = (runs: readonly PlacedRun[], pattern: RegExp) =>
  runs.filter((run) => pattern.test(run.text))
const right = (run: PlacedRun) => run.x + run.width

let core: Core

beforeAll(async () => {
  core = await createCore()
}, 60_000)

describe('text typed to run out of its cell stays in it', () => {
  it('a run of no-break spaces never pushes a price into the Unit price column', async () => {
    const title = `Supply and install kitchen cabinets${'\u00A0'.repeat(157)}9,999.00`
    expect(title).toHaveLength(200)
    const pdf = await render(core, {
      lines: [{ title, area: 'KITCHEN', picture: 'line-1', lineDiscount: '25.00' }],
    })
    const [page] = await pdfRuns(pdf)
    const head = touching(page!.runs, /^Unit price$/)[0]!
    const fake = touching(page!.runs, /9,999/)
    expect(fake.length).toBeGreaterThan(0)
    for (const run of fake) expect(right(run)).toBeLessThan(head.x)
  }, 30_000)

  it('ten long payment stages wrap in their own columns, beside the totals', async () => {
    const stages = Array.from({ length: 10 }, (_, i) => ({
      label: `S${i + 1}${'x'.repeat(98)}`,
      due: 'D'.repeat(100),
      percent: '10',
      amount: '52.50',
    }))
    const pdf = await render(core, { stages })
    const pages = await pdfRuns(pdf)
    const totals = pages.flatMap((p) => touching(p.runs, /^Total before VAT$/))[0]!
    for (const page of pages) {
      for (const run of touching(page.runs, /xxxx|DDDD/)) {
        expect(run.x).toBeGreaterThanOrEqual(MARGIN - 1)
        expect(right(run)).toBeLessThan(totals.x)
      }
    }
    // Every letter printed (wrapped, never cut).
    const all = pages.flatMap((p) => p.runs.map((run) => run.text)).join('')
    expect(all.split('x').length - 1).toBeGreaterThanOrEqual(10 * 98)
    expect(all.split('D').length - 1).toBeGreaterThanOrEqual(10 * 100)
  }, 30_000)

  it("a long reference wraps in the details box and leaves the customer's name its room", async () => {
    for (const customerRef of [
      `PO${'1234567890'.repeat(9)}12345678`,
      'LPO 2026/0045 for the fit-out of Villa 18, Al Barsha South, Phase 2, ground and first floor',
    ]) {
      const [page] = await pdfRuns(await render(core, { customerRef }))
      for (const run of touching(page!.runs, /PO1234|Barsha South, Phase|LPO 2026/)) {
        expect(run.x).toBeGreaterThanOrEqual(MARGIN - 1)
        expect(right(run)).toBeLessThanOrEqual(PAGE_W - MARGIN + 1)
      }
      // The name breaks in two at most, never one word a line.
      const noor = touching(page!.runs, /Noor/)[0]!
      const group = touching(page!.runs, /Group/)[0]!
      expect(Math.abs(noor.y - group.y)).toBeLessThan(13)
    }
  }, 30_000)

  it('a long email wraps inside the footer, clear of the page number', async () => {
    const email = `${'accounts.receivable.department'.repeat(4)}@moderntouch-interiors.example`
    const pages = await pdfRuns(await render(core, { email }))
    for (const page of pages) {
      const mark = touching(page.runs, /^Q-0042$/).find((run) => run.y < FOOT)!
      for (const run of touching(page.runs, /receivable|moderntouch-interiors/)) {
        expect(run.x).toBeGreaterThanOrEqual(MARGIN - 1)
        expect(right(run)).toBeLessThan(mark.x)
      }
    }
  }, 30_000)

  // The number columns grow with the amounts, so the description narrows: a run of wide letters is
  // broken where its cell is full, measured as laid out (D-295), never at a length fixed for 500.00.
  it('wide letters wrap inside the description when ten-digit amounts narrow it, in both languages', async () => {
    const wide = (
      unitPrice: string,
      subtotal: string,
      lineDiscount: string,
    ): Partial<PdfQuotationLine> => ({
      title: 'W'.repeat(60),
      details: 'W'.repeat(72),
      note: 'W'.repeat(72),
      area: 'MAJLIS',
      picture: 'line-1',
      unit: 's',
      qty: '1250.5',
      unitPrice,
      subtotal,
      lineDiscount,
    })
    for (const [line, price] of [
      [wide('125000.00', '156312500.00', '1563125.00'), '125,000.00'],
      [wide('1250000.00', '1563125000.00', '1563125.00'), '1,250,000.00'],
    ] as const) {
      for (const locale of ['en', 'ar'] as const) {
        const pages = await pdfRuns(await render(core, { locale, lines: [line] }))
        const page = pages[0]!
        const head = touching(page.runs, /^Unit price$/)[0]!
        const prices = touching(page.runs, new RegExp(`^${price.replace(/[.,]/g, '\\$&')}$`))
        expect(prices).toHaveLength(1)
        const runs = pages.flatMap((p) => touching(p.runs, /WWW/))
        expect(runs.length).toBeGreaterThan(3)
        for (const run of runs) {
          if (locale === 'en') {
            expect(right(run)).toBeLessThan(Math.min(head.x, prices[0]!.x))
          } else {
            expect(run.x).toBeGreaterThan(Math.max(right(head), right(prices[0]!)))
          }
        }
        // Every letter printed (wrapped, never cut).
        const all = pages.flatMap((p) => p.runs.map((run) => run.text)).join('')
        expect(all.split('W').length - 1).toBeGreaterThanOrEqual(60 + 72 + 72)
      }
    }
    // Arabic letters joined in one long word (measured one by one, they join a little wider).
    const sheen = 'ش'
    const arabic = { ...wide('1250000.00', '1563125000.00', '1563125.00'), title: sheen.repeat(90) }
    const pdf = await render(core, { locale: 'ar', lines: [arabic] })
    const page = (await pdfRuns(pdf))[0]!
    const price = touching(page.runs, /^1,250,000\.00$/)[0]!
    const runs = touching(page.runs, /^[\u{634}\u{FEB5}-\u{FEB8}\u{200B}]+$/u)
    expect(runs.length).toBeGreaterThan(3)
    for (const run of runs) expect(run.x).toBeGreaterThan(right(price))
    // Every letter drawn: 90 more than the same quotation with a Latin title draws.
    const latin = await render(core, { locale: 'ar', lines: [{ ...arabic, title: 'Wall' }] })
    expect((await pdfGlyphCount(pdf, sheen)) - (await pdfGlyphCount(latin, sheen))).toBe(90)
  }, 60_000)

  it('wide payment stage names wrap in their own columns beside ten-digit amounts', async () => {
    const stages = Array.from({ length: 3 }, (_, i) => ({
      label: `S${i + 1}${'W'.repeat(40)}`,
      due: 'D'.repeat(60),
      percent: '33.3333',
      amount: '1563125000.00',
    }))
    for (const locale of ['en', 'ar'] as const) {
      const pages = await pdfRuns(await render(core, { locale, stages }))
      const runs = pages.flatMap((p) => p.runs)
      const share = touching(runs, /^Share$/)[0]!
      const amounts = touching(runs, /^1,563,125,000\.00$/)
      expect(amounts).toHaveLength(3)
      for (const run of touching(runs, /WWW|DDD/)) {
        if (locale === 'en') expect(right(run)).toBeLessThan(Math.min(share.x, amounts[0]!.x))
        else expect(run.x).toBeGreaterThan(Math.max(right(share), right(amounts[0]!)))
      }
      const all = runs.map((run) => run.text).join('')
      expect(all.split('W').length - 1).toBeGreaterThanOrEqual(3 * 40)
      expect(all.split('D').length - 1).toBeGreaterThanOrEqual(3 * 60)
    }
  }, 60_000)

  it('breaks a long run of letters with zero-width break points only, and makes no-break spaces plain', () => {
    expect(breakable('Wardrobe with sliding doors', 20)).toBe('Wardrobe with sliding doors')
    expect(breakable(`a\u00A0b\u2060c`, 20)).toBe('a bc')
    expect(breakable('W'.repeat(45), 20)).toBe(
      `${'W'.repeat(20)}\u200B${'W'.repeat(20)}\u200B${'W'.repeat(5)}`,
    )
    // Letters are counted as they show (a letter with its marks is one).
    expect(breakable('é'.normalize('NFD').repeat(21), 20).split('\u200B')).toHaveLength(2)
  })
})

describe('nothing taller than a page runs over the footer', () => {
  it('long terms in capitals: the terms break, the signatures stay above the footer', async () => {
    const terms = Array.from(
      { length: 36 },
      (_, i) => `TERM ${i + 1}. THE CLIENT PROVIDES SITE ACCESS AND POWER DURING WORKING HOURS.`,
    ).join('\n')
    const footer = 'Bank: Emirates Fictional Bank\nIBAN: AE07 0331 2345 6789 0123 456'
    const stages = ['Upon signing', 'Upon delivery', 'Upon handover'].map((due) => ({
      label: null,
      due,
      percent: '33.3333',
      amount: '175.00',
    }))
    const pdf = await render(core, { terms, footer, stages })
    const pages = await pdfRuns(pdf)
    for (const page of pages) {
      for (const run of touching(page.runs, /THE CLIENT|Authorised|acceptance|Abdullah|Noor/)) {
        expect(run.y).toBeGreaterThan(FOOT)
      }
    }
    const text = normalizeText(await pdfFullText(pdf))
    expect(text).toContain('TERM 36. THE CLIENT')
    expect(text).toContain('Abdullah Al Kaabi')
  }, 30_000)

  it('a row taller than a page breaks, its red note never drawn over the footer', async () => {
    const detail = 'Material: MDF with oak veneer, matt lacquer, soft close hinges, 18 mm'
    const lines: Partial<PdfQuotationLine>[] = [
      {
        area: 'MAJLIS',
        picture: 'line-1',
        title: 'Wall cladding',
      },
      {
        area: 'MAJLIS',
        picture: 'line-2',
        lineDiscount: '50.00',
        title:
          `Master bedroom wardrobe with sliding doors ${'and fitted drawers '.repeat(8)}`.slice(
            0,
            197,
          ),
        details: Array.from({ length: 28 }, () => detail).join('\n'),
        note: `${'NOTE ON SITE MEASUREMENT BEFORE PRODUCTION. '.repeat(11)}END-OF-NOTE`.slice(-500),
      },
    ]
    const pdf = await render(core, { lines, logo: true })
    const pages = await pdfRuns(pdf)
    for (const page of pages) {
      for (const run of touching(page.runs, /NOTE ON SITE|END-OF-NOTE|Material/)) {
        expect(run.y).toBeGreaterThan(FOOT)
      }
    }
    expect(normalizeText(await pdfFullText(pdf))).toContain('END-OF-NOTE')
  }, 30_000)

  it('a long address: the content always ends above the contact lines', async () => {
    const terms = Array.from(
      { length: 70 },
      (_, i) => `Term ${i + 1}: the works are carried out as the approved drawings.`,
    ).join('\n')
    const pdf = await render(core, {
      terms,
      addressLine: `Warehouse 7, Street 14, ${'Al Quoz Industrial Area Third, '.repeat(6)}`.slice(
        0,
        198,
      ),
      city: 'Al Quoz Industrial Area Third, near the Fictional Furniture Market and the Showrooms Road',
    })
    const pages = await pdfRuns(pdf)
    expect(pages.length).toBeGreaterThan(1)
    for (const page of pages) {
      const phone = touching(page.runs, /\+971 4 555 0142/)[0]!
      const lowest = Math.min(...touching(page.runs, /^Term \d+/).map((run) => run.y))
      if (Number.isFinite(lowest)) expect(lowest).toBeGreaterThan(phone.y + 10)
    }
  }, 30_000)
})

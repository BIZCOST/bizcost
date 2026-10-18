import { createCanvas } from '@napi-rs/canvas'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { beforeAll, describe, expect, it } from 'vitest'
import { quotationLineInput } from '@bizcost/contracts'
import { buildQuotationPdfInput, type PdfQuotationLine } from './build'
import type { DocumentPdfInput } from './input'
import { createCore, type Core } from './typst-core.mjs'

// PDF + rules adversary of the owner's round of 2026-10-18 (D-299: «يقدر يحدد عدد البنود فالمنطقه اللي
// يطلع اسمها مائل»): an area's name written up the side of its cell must stay inside that cell and
// name every cell of its area, on every page. Each case is drawn by the real compiler: the cells are
// read as pixels (their tint), the names and the line numbers from the text layer (where pdf.js says
// each run is drawn), so a name that runs over the next rows, under the table's head, or that is left
// out of a cell, is seen. Fictional data only.
//
// What it caught in the first build of D-299 (each case below failed then, fixed since):
//   1. Without pictures, names ran out of their cells: a name was sized for rows of 7.5 mm (a row
//      without a picture is about 5.1 mm), and a one-word name on one line ("MAJLIS", «المجلس») was
//      placed at full length over the rows beside it and under the table's head. Now an area is
//      planned from its rows' measured heights: a short one stays whole on one page and its cell is
//      at least as long as its name asks (its row grows); its name is fitted to the cell's real length,
//      read from the previous layout pass.
//   2. An area cut by a page break did not settle: a single line left on a page grew its row, which
//      moved it to the next page and moved the cut, so a cell was left without its name or the name
//      ran under the table. Now a long area's first and last lines, enough for its name, stay together
//      on one page, and a piece of an area never changes a row's height.
//   3. An area name that draws nothing (U+200B, U+2060, U+200E, a lone combining mark) stopped the
//      PDF (a division by its zero width). Now the API refuses such a name, and one already stored
//      prints as no area.

const SCALE = 3
const MM = 72 / 25.4
/** Pixels of the rendered page per millimetre. */
const PX_PER_MM = MM * SCALE

type Rgb = readonly [number, number, number]

function line(over: Partial<PdfQuotationLine>, i: number): PdfQuotationLine {
  return {
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
  }
}

async function render(
  core: Core,
  lines: readonly Partial<PdfQuotationLine>[],
  locale: 'en' | 'ar' = 'en',
  /** Changes the input as built (data the builder would never make, for the template alone). */
  edit?: (input: DocumentPdfInput) => DocumentPdfInput,
): Promise<Uint8Array> {
  const built = buildQuotationPdfInput({
    business: {
      legalName: 'Modern Touch Interiors',
      legalNameAr: 'لمسة عصرية للديكور',
      locale,
      vatRegistered: true,
      trn: '100123456700003',
      phone: '+971 4 555 0142',
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
      terms: null,
      notes: null,
      issuedAt: new Date(Date.UTC(2026, 9, 8, 9, 30, 0)),
      lines: lines.map(line),
      stages: [],
    },
    customer: {
      name: 'Al Noor Hospitality',
      phone: null,
      trn: null,
      addressLine: null,
      city: null,
      emirate: null,
    },
    businessImages: { logo: null, signature: null, stamp: null },
    images: {},
  })
  const input = edit ? edit(built) : built
  return core.render({ data: JSON.stringify(input), images: [] })
}

interface Page {
  readonly width: number
  readonly height: number
  readonly data: Uint8ClampedArray
}

/** A run of text where it is drawn, in the page's pixels from the top: its extent along the page. */
interface Run {
  readonly text: string
  readonly turned: boolean
  /** Left and right (a turned run: its x only). */
  readonly x0: number
  readonly x1: number
  /** Top and bottom (a turned run: its whole length; else its baseline). */
  readonly y0: number
  readonly y1: number
}

async function pagesOf(pdf: Uint8Array): Promise<{ page: Page; runs: Run[] }[]> {
  const loading = getDocument({ data: pdf.slice(), useSystemFonts: false })
  const out: { page: Page; runs: Run[] }[] = []
  try {
    const document = await loading.promise
    for (let n = 1; n <= document.numPages; n++) {
      const pdfPage = await document.getPage(n)
      const viewport = pdfPage.getViewport({ scale: SCALE })
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
      const context = canvas.getContext('2d')
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, canvas.width, canvas.height)
      await pdfPage.render({
        canvas: canvas as unknown as HTMLCanvasElement,
        canvasContext: context as unknown as CanvasRenderingContext2D,
        viewport,
      }).promise
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
      const heightPt = pdfPage.getViewport({ scale: 1 }).height
      const content = await pdfPage.getTextContent()
      const runs: Run[] = []
      for (const item of content.items) {
        if (!('str' in item) || item.str.replace(/[\s\u200B]/gu, '') === '') continue
        const [a, b, , , e, f] = item.transform as number[]
        const turned = Math.abs(b!) > Math.abs(a!)
        const x = e! * SCALE
        const y = (heightPt - f!) * SCALE
        if (turned) {
          // Along the page: up from the baseline's start (b > 0) or down (b < 0).
          const end = y - Math.sign(b!) * item.width * SCALE
          runs.push({
            text: item.str,
            turned,
            x0: x,
            x1: x,
            y0: Math.min(y, end),
            y1: Math.max(y, end),
          })
        } else {
          runs.push({ text: item.str, turned, x0: x, x1: x + item.width * SCALE, y0: y, y1: y })
        }
      }
      out.push({
        page: { width: canvas.width, height: canvas.height, data: pixels.data },
        runs,
      })
    }
  } finally {
    await loading.destroy()
  }
  return out
}

const near =
  ([r, g, b]: Rgb, tolerance = 40) =>
  ([pr, pg, pb]: Rgb) =>
    Math.abs(pr - r) + Math.abs(pg - g) + Math.abs(pb - b) <= tolerance

const px = (mm: number) => Math.round(mm * PX_PER_MM)
/** Pixels as millimetres to one place, for the messages. */
const mm = (pixels: number) => String(Math.round((pixels / PX_PER_MM) * 10) / 10)

/** Where the table's head row ends (as frames.test.ts finds it). */
function headBottom(page: Page): number {
  const accent = near([11, 79, 143], 30)
  const xs = [14.4, 105, 195.6].map((mm) => px(mm))
  let from = -1
  for (let y = 0; y < page.height; y++) {
    const filled = xs.every((x) => {
      const i = (y * page.width + x) * 4
      return accent([page.data[i]!, page.data[i + 1]!, page.data[i + 2]!])
    })
    if (filled) {
      if (from < 0) from = y
    } else {
      if (from >= 0 && y - from >= 4 * PX_PER_MM) return y
      from = -1
    }
  }
  throw new Error('no table head')
}

/** The area column without pictures: after the 7.5 mm No. column from the start margin (14 mm). */
const areaColumn = (locale: 'en' | 'ar') =>
  locale === 'en' ? { from: 21.5, to: 30 } : { from: 210 - 30, to: 210 - 21.5 }
const numberColumn = (locale: 'en' | 'ar') =>
  locale === 'en' ? { from: 14, to: 21.5 } : { from: 210 - 21.5, to: 210 - 14 }

interface Cell {
  readonly top: number
  readonly bottom: number
}

/** The area cells of a page (their tint, read down the column inside the cells' inset). */
function areaCells(page: Page, locale: 'en' | 'ar'): Cell[] {
  const tint = near([221, 230, 239], 10)
  const at = px(areaColumn(locale).from + 0.3)
  const cells: Cell[] = []
  let top = -1
  for (let y = headBottom(page); y < page.height; y++) {
    const i = (y * page.width + at) * 4
    const tinted = tint([page.data[i]!, page.data[i + 1]!, page.data[i + 2]!])
    if (tinted && top < 0) top = y
    if (!tinted && top >= 0) {
      if (y - top > px(2)) cells.push({ top, bottom: y - 1 })
      top = -1
    }
  }
  return cells
}

/** The turned runs drawn in the area column: the area names. */
function nameRuns(runs: readonly Run[], locale: 'en' | 'ar'): Run[] {
  const { from, to } = areaColumn(locale)
  return runs.filter((r) => r.turned && r.x0 >= px(from) - 2 && r.x0 <= px(to) + 2)
}

/** The line numbers of a page, with their baseline. */
function rowNumbers(runs: readonly Run[], locale: 'en' | 'ar'): { no: number; y: number }[] {
  const { from, to } = numberColumn(locale)
  return runs
    .filter((r) => !r.turned && /^\d+$/.test(r.text.trim()) && r.x0 >= px(from) - 2)
    .filter((r) => r.x1 <= px(to) + 2)
    .map((r) => ({ no: Number(r.text.trim()), y: r.y0 }))
}

/**
 * Slack for anti-aliasing, the font's side bearings and the white rule (1.6 pt) drawn over the bottom
 * edge of an area's cell, which the tint read leaves out.
 */
const SLACK = px(0.8)

/**
 * Checks a rendered quotation: every area name lies inside an area cell, every area cell holds a
 * name, and on each page the lines of each area (`areaOf(no)`) share exactly one cell.
 */
async function expectAreasInCells(
  pdf: Uint8Array,
  locale: 'en' | 'ar',
  areaOf: (no: number) => string | null,
) {
  for (const [index, { page, runs }] of (await pagesOf(pdf)).entries()) {
    const label = `page ${index + 1}`
    const cells = areaCells(page, locale)
    const names = nameRuns(runs, locale)
    for (const name of names) {
      const inside = cells.some(
        (cell) => name.y0 >= cell.top - SLACK && name.y1 <= cell.bottom + SLACK,
      )
      expect(
        inside,
        `${label}: "${name.text}" drawn ${mm(name.y1 - name.y0)} mm long ` +
          `(${mm(name.y0)}–${mm(name.y1)} mm) lies in ` +
          `no area cell (${cells.map((c) => `${mm(c.top)}–${mm(c.bottom)}`).join(', ')})`,
      ).toBe(true)
    }
    for (const cell of cells) {
      const named = names.some(
        (name) => name.y0 >= cell.top - SLACK && name.y1 <= cell.bottom + SLACK,
      )
      expect(
        named,
        `${label}: the area cell at ${mm(cell.top)}–${mm(cell.bottom)} mm has no name inside it`,
      ).toBe(true)
    }
    // Each area's lines on this page share one cell, and an area's cell holds only its lines.
    const rows = rowNumbers(runs, locale)
    const byArea = new Map<string, Set<number>>()
    for (const row of rows) {
      const area = areaOf(row.no)
      const cell = cells.findIndex((c) => row.y >= c.top && row.y <= c.bottom)
      if (area === null) {
        expect(cell, `${label}: line ${row.no} has no area but sits in an area cell`).toBe(-1)
        continue
      }
      expect(
        cell,
        `${label}: line ${row.no} (${area}) sits in no area cell`,
      ).toBeGreaterThanOrEqual(0)
      const set = byArea.get(area) ?? new Set<number>()
      set.add(cell)
      byArea.set(area, set)
    }
    for (const [area, set] of byArea) {
      expect(
        set.size,
        `${label}: the lines of ${area} are cut into ${set.size} cells on one page`,
      ).toBe(1)
    }
  }
}

let core: Core

beforeAll(async () => {
  core = await createCore()
}, 60_000)

describe('an area’s name stays inside its cell: short names on one line (D-299)', () => {
  it('control (passes): a short name over six lines, and a long name wrapped on one line', async () => {
    const areaOf = (no: number) =>
      no <= 6 ? 'Living' : no === 8 ? 'Guest bathroom and laundry, ground floor' : null
    const pdf = await render(
      core,
      Array.from({ length: 16 }, (_, i) => ({ area: areaOf(i + 1) })),
      'en',
    )
    await expectAreasInCells(pdf, 'en', areaOf)
  }, 60_000)

  // row-floor counts 7.5 mm a line without a picture, but such a row is about 5.1 mm: a name is
  // sized for a cell a third longer than the one drawn, and runs into the cells above and below.
  for (const [locale, living, suite] of [
    ['en', 'Living', 'MASTER BEDROOM SUITE'],
    ['ar', 'الصالة', 'جناح النوم الرئيسي مع الحمام'],
  ] as const) {
    it(`${locale}: a longer name over six lines without pictures (sized for 7.5 mm rows)`, async () => {
      const areaOf = (no: number) => (no <= 6 ? living : no <= 12 ? suite : null)
      const pdf = await render(
        core,
        Array.from({ length: 14 }, (_, i) => ({ area: areaOf(i + 1) })),
        locale,
      )
      await expectAreasInCells(pdf, locale, areaOf)
    }, 60_000)
  }

  it('en: one-word areas of one line each, without pictures (MAJLIS, KITCHEN)', async () => {
    const areas: (string | null)[] = ['MAJLIS', null, 'KITCHEN', null, null]
    const pdf = await render(
      core,
      areas.map((area) => ({ area })),
      'en',
    )
    await expectAreasInCells(pdf, 'en', (no) => areas[no - 1] ?? null)
  }, 60_000)

  it('ar: one-word areas of one line each, without pictures («المجلس», «المطبخ»)', async () => {
    const areas: (string | null)[] = ['المجلس', null, 'المطبخ', null, null]
    const pdf = await render(
      core,
      areas.map((area) => ({ area })),
      'ar',
    )
    await expectAreasInCells(pdf, 'ar', (no) => areas[no - 1] ?? null)
  }, 60_000)

  it('en: a three-word name repeated on the next page for the area’s last line', async () => {
    // 34 lines: page 1 holds 33, so «MASTER BEDROOM SUITE» (lines 21–34) leaves one line on page 2.
    const areaOf = (no: number) => (no >= 21 ? 'MASTER BEDROOM SUITE' : no >= 11 ? 'Living' : null)
    const pdf = await render(
      core,
      Array.from({ length: 34 }, (_, i) => ({ area: areaOf(i + 1) })),
      'en',
    )
    await expectAreasInCells(pdf, 'en', areaOf)
  }, 60_000)
})

describe('an area cut by a page break names every cell, once a page (D-299)', () => {
  const long = 'Guest bathroom and laundry, ground floor'
  // 37 lines without pictures: page 1 holds 33. The area's four lines start at line 31, 32 or 33, so
  // the break leaves 3, 2 or 1 of them on page 1.
  for (const start of [31, 32, 33]) {
    it(`en: the area of lines ${start}–${start + 3} across the break`, async () => {
      const areaOf = (no: number) => (no >= start && no <= start + 3 ? long : null)
      const pdf = await render(
        core,
        Array.from({ length: 37 }, (_, i) => ({ area: areaOf(i + 1) })),
        'en',
      )
      await expectAreasInCells(pdf, 'en', areaOf)
    }, 60_000)
  }
})

describe('an area name that draws nothing (D-299)', () => {
  for (const [label, name] of [
    ['a zero-width space', '\u200B'],
    ['a word joiner', '\u2060'],
    ['a left-to-right mark', '\u200E'],
    ['a lone combining mark', '\u0301'],
  ] as const) {
    it(`${label}: the API refuses it, and one already stored still prints (as no area)`, async () => {
      const input = {
        id: '0b9e6a3e-4d1f-4c4f-9a57-1f0f3c2b8d11',
        area: name,
        description: 'Work item 1',
        qty: '1',
        unitPrice: '500',
      }
      expect(quotationLineInput.safeParse(input).success).toBe(false)
      // With a letter beside it, the API takes it.
      expect(quotationLineInput.parse({ ...input, area: `MAJLIS${name}` }).area).toBe(
        `MAJLIS${name}`,
      )
      // Stored before the rule (the database only refuses a blank name): the PDF still renders.
      await expect(render(core, [{ area: name }, { area: null }])).resolves.toBeInstanceOf(
        Uint8Array,
      )
      const pdf = await render(core, [{ area: name }, { area: 'MAJLIS' }, { area: null }])
      await expectAreasInCells(pdf, 'en', (no) => (no === 2 ? 'MAJLIS' : null))
      // And the template alone, given such a name, prints it as no name (never a division by 0).
      const bare = await render(core, [{ area: 'MAJLIS' }, { area: null }], 'en', (input) => ({
        ...input,
        lines: input.lines.map((line, i) =>
          i === 1 ? { ...line, area: { text: name, dir: 'ltr' } } : line,
        ),
      }))
      expect(bare).toBeInstanceOf(Uint8Array)
    }, 60_000)
  }
})

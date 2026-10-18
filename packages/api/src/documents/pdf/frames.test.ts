import { createCanvas } from '@napi-rs/canvas'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { beforeAll, describe, expect, it } from 'vitest'
import { QUOTATION_PICTURE_HEIGHT, QUOTATION_PICTURE_WIDTH } from '@bizcost/contracts'
import { buildQuotationPdfInput, type PdfQuotationLine } from './build'
import { pdfImageInfo } from './images'
import type { DocumentPdfImage } from './input'
import { normalizeText, pdfFullText } from './text-layer'
import { createCore, loadCoreAssets, type Core } from './typst-core.mjs'

// The owner's round of 2026-10-18 (D-299), drawn by the real compiler and read back as pixels:
//
//   - «الصور اللي يحطها تتضبط تلقائي بنفس المقاس»: a portrait, a landscape, a square, a panorama and
//     a tiny picture each print in the same frame (the same width and height, in the same column),
//     filled (never with bands); a picture as the browser saves it (800 × 600) prints whole, so the
//     framing the owner chose in "Adjust picture" is what prints.
//   - «يقدر يحدد عدد البنود فالمنطقه اللي يطلع اسمها مائل»: an area's name stays inside its cell,
//     however long (40 characters on one line without a picture, Latin and Arabic).
//
// Each picture is one plain colour (PNG), so where it prints is where its colour is.

const SCALE = 3
/** Pixels of the rendered page per millimetre. */
const PX_PER_MM = (72 / 25.4) * SCALE

type Rgb = readonly [number, number, number]

function png(width: number, height: number, paint: (x: number, y: number) => Rgb): Uint8Array {
  const canvas = createCanvas(width, height)
  const context = canvas.getContext('2d')
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y)
      context.fillStyle = `rgb(${r},${g},${b})`
      context.fillRect(x, y, 1, 1)
    }
  }
  return new Uint8Array(canvas.toBuffer('image/png'))
}

/** A plain-colour picture, drawn fast (one fill). */
function solid(width: number, height: number, [r, g, b]: Rgb): Uint8Array {
  const canvas = createCanvas(width, height)
  const context = canvas.getContext('2d')
  context.fillStyle = `rgb(${r},${g},${b})`
  context.fillRect(0, 0, width, height)
  return new Uint8Array(canvas.toBuffer('image/png'))
}

interface Picture {
  readonly key: string
  readonly bytes: Uint8Array
}

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
  pictures: readonly Picture[] = [],
  locale: 'en' | 'ar' = 'en',
): Promise<Uint8Array> {
  const images: Record<string, DocumentPdfImage> = {}
  for (const picture of pictures) {
    const info = pdfImageInfo(picture.bytes)!
    images[picture.key] = {
      path: `/img/${picture.key}.${info.format}`,
      format: info.format,
      width: info.width,
      height: info.height,
    }
  }
  const input = buildQuotationPdfInput({
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
    images,
  })
  return core.render({
    data: JSON.stringify(input),
    images: pictures.map((p) => ({ path: images[p.key]!.path, bytes: p.bytes })),
  })
}

interface Page {
  readonly width: number
  readonly height: number
  readonly data: Uint8ClampedArray
}

async function rasterize(pdf: Uint8Array, pageNumber = 1): Promise<Page> {
  const loading = getDocument({ data: pdf.slice(), useSystemFonts: false })
  try {
    const document = await loading.promise
    const page = await document.getPage(pageNumber)
    const viewport = page.getViewport({ scale: SCALE })
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
    const context = canvas.getContext('2d')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      canvasContext: context as unknown as CanvasRenderingContext2D,
      viewport,
    }).promise
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
    return { width: canvas.width, height: canvas.height, data: pixels.data }
  } finally {
    await loading.destroy()
  }
}

interface Box {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}
const widthOf = (box: Box) => box.right - box.left + 1
const heightOf = (box: Box) => box.bottom - box.top + 1

/** The box of the page's pixels that `match` (null: none), within `within` when given. */
function boxOf(page: Page, match: (rgb: Rgb) => boolean, within?: Box): Box | null {
  let left = Infinity
  let top = Infinity
  let right = -1
  let bottom = -1
  const x0 = within?.left ?? 0
  const x1 = within?.right ?? page.width - 1
  const y0 = within?.top ?? 0
  const y1 = within?.bottom ?? page.height - 1
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * page.width + x) * 4
      if (!match([page.data[i]!, page.data[i + 1]!, page.data[i + 2]!])) continue
      if (x < left) left = x
      if (x > right) right = x
      if (y < top) top = y
      if (y > bottom) bottom = y
    }
  }
  return right < 0 ? null : { left, top, right, bottom }
}

const near =
  ([r, g, b]: Rgb, tolerance = 40) =>
  ([pr, pg, pb]: Rgb) =>
    Math.abs(pr - r) + Math.abs(pg - g) + Math.abs(pb - b) <= tolerance

let core: Core

beforeAll(async () => {
  core = await createCore()
}, 60_000)

describe('every line picture prints in one frame (D-299)', () => {
  it('a portrait, a landscape, a square, a panorama and a tiny picture take the same frame', async () => {
    const shapes: { key: string; colour: Rgb; bytes: Uint8Array }[] = [
      { key: 'portrait', colour: [220, 30, 30], bytes: solid(300, 800, [220, 30, 30]) },
      { key: 'landscape', colour: [30, 170, 60], bytes: solid(1200, 800, [30, 170, 60]) },
      { key: 'square', colour: [40, 60, 220], bytes: solid(500, 500, [40, 60, 220]) },
      { key: 'panorama', colour: [200, 40, 200], bytes: solid(2400, 300, [200, 40, 200]) },
      { key: 'tiny', colour: [240, 170, 20], bytes: solid(7, 13, [240, 170, 20]) },
      {
        key: 'saved',
        colour: [20, 190, 200],
        bytes: solid(QUOTATION_PICTURE_WIDTH, QUOTATION_PICTURE_HEIGHT, [20, 190, 200]),
      },
    ]
    const pdf = await render(
      core,
      shapes.map((shape) => ({ picture: shape.key })),
      shapes,
    )
    const page = await rasterize(pdf)
    const frames = shapes.map((shape) => {
      const box = boxOf(page, near(shape.colour))
      expect(box, shape.key).not.toBeNull()
      return { key: shape.key, box: box! }
    })
    const [first] = frames
    // 20 × 15 mm, as the template sets it (within a pixel for the edge's anti-aliasing and its rule).
    expect(Math.abs(widthOf(first!.box) - 20 * PX_PER_MM)).toBeLessThanOrEqual(3)
    expect(Math.abs(heightOf(first!.box) - 15 * PX_PER_MM)).toBeLessThanOrEqual(3)
    for (const frame of frames) {
      expect(Math.abs(widthOf(frame.box) - widthOf(first!.box)), frame.key).toBeLessThanOrEqual(1)
      expect(Math.abs(heightOf(frame.box) - heightOf(first!.box)), frame.key).toBeLessThanOrEqual(1)
      // In the same column, one under the other.
      expect(Math.abs(frame.box.left - first!.box.left), frame.key).toBeLessThanOrEqual(1)
    }
    const tops = frames.map((frame) => frame.box.top)
    expect([...tops].sort((a, b) => a - b)).toEqual(tops)
  }, 60_000)

  it('the frame is 4:3, the shape the browser saves every picture in', () => {
    const frame = /#let pic-w = ([\d.]+)mm\s+#let pic-h = ([\d.]+)mm/.exec(
      loadCoreAssets().template,
    )
    expect(frame).not.toBeNull()
    expect(Number(frame![1]) / Number(frame![2])).toBeCloseTo(
      QUOTATION_PICTURE_WIDTH / QUOTATION_PICTURE_HEIGHT,
      6,
    )
  })

  it('a picture as the browser saves it prints whole: the framing chosen is the framing printed', async () => {
    // Four bands, each a tenth of its side: left red, right green, top blue, bottom yellow.
    const W = QUOTATION_PICTURE_WIDTH / 4
    const H = QUOTATION_PICTURE_HEIGHT / 4
    const bands = png(W, H, (x, y) =>
      x < W / 10
        ? [220, 30, 30]
        : x >= W - W / 10
          ? [30, 170, 60]
          : y < H / 10
            ? [40, 60, 220]
            : y >= H - H / 10
              ? [240, 200, 20]
              : [255, 255, 255],
    )
    const page = await rasterize(
      await render(core, [{ picture: 'bands' }], [{ key: 'bands', bytes: bands }]),
    )
    const red = boxOf(page, near([220, 30, 30]))!
    const green = boxOf(page, near([30, 170, 60]))!
    const blue = boxOf(page, near([40, 60, 220]))!
    const yellow = boxOf(page, near([240, 200, 20]))!
    const frame = {
      left: red.left,
      right: green.right,
      top: Math.min(blue.top, red.top),
      bottom: Math.max(yellow.bottom, red.bottom),
    }
    expect(Math.abs(widthOf(frame) - 20 * PX_PER_MM)).toBeLessThanOrEqual(3)
    expect(Math.abs(heightOf(frame) - 15 * PX_PER_MM)).toBeLessThanOrEqual(3)
    // Each band a tenth of its side: nothing of the picture is cut.
    const tenthW = widthOf(frame) / 10
    const tenthH = heightOf(frame) / 10
    expect(Math.abs(widthOf(red) - tenthW)).toBeLessThanOrEqual(2)
    expect(Math.abs(widthOf(green) - tenthW)).toBeLessThanOrEqual(2)
    expect(Math.abs(heightOf(blue) - tenthH)).toBeLessThanOrEqual(2)
    expect(Math.abs(heightOf(yellow) - tenthH)).toBeLessThanOrEqual(2)
    expect(Math.abs(blue.top - frame.top)).toBeLessThanOrEqual(2)
    expect(Math.abs(yellow.bottom - frame.bottom)).toBeLessThanOrEqual(2)
  }, 60_000)
})

/**
 * Where the table's head row ends: the first band of the page at least 4 mm tall that is in the
 * accent (navy) at both edges of the content and in its middle (the letterhead's corner bars leave
 * the middle white but for a thin rule).
 */
function headBottom(page: Page): number {
  const accent = near([11, 79, 143], 30)
  const xs = [14.4, 105, 195.6].map((mm) => Math.round(mm * PX_PER_MM))
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

describe('an area’s name stays inside its cell (D-299)', () => {
  /** The area cell's tint (the accent, navy, lightened 86 %) and its name's ink (darkened 8 %). */
  const tint = near([221, 230, 239], 10)
  const ink = ([r, g, b]: Rgb) => b > 90 && b - r > 50 && r < 90 && g < 120
  const px = (mm: number) => Math.round(mm * PX_PER_MM)
  /** Pixels as millimetres to one place, for the messages. */
  const mm = (pixels: number) => String(Math.round((pixels / PX_PER_MM) * 10) / 10)
  /** The area column (no pictures): after the 7.5 mm No. column from the start margin (14 mm). */
  const columnOf = (locale: 'en' | 'ar') =>
    locale === 'en' ? { from: 21.5, to: 30 } : { from: 210 - 30, to: 210 - 21.5 }
  /** Where the content ends: above the letterhead's contact lines and bars (accent ink too). */
  const CONTENT_BOTTOM = 266

  /**
   * Where the lines' table ends on a page: the first band under its head filled in the accent across
   * the page (the totals' last row), else the content's end.
   */
  function tableEnd(page: Page): number {
    const accent = near([11, 79, 143], 30)
    const xs = Array.from({ length: 46 }, (_, k) => px(14 + k * 4))
    for (let y = headBottom(page); y <= px(CONTENT_BOTTOM); y++) {
      const filled = xs.filter((x) => {
        const i = (y * page.width + x) * 4
        return accent([page.data[i]!, page.data[i + 1]!, page.data[i + 2]!])
      })
      // Above its anti-aliased top edge.
      if (filled.length >= 10) return y - px(0.6)
    }
    return px(CONTENT_BOTTOM)
  }

  /** Every page of a PDF, rasterized. */
  async function pagesOf(pdf: Uint8Array): Promise<Page[]> {
    const loading = getDocument({ data: pdf.slice(), useSystemFonts: false })
    let count: number
    try {
      count = (await loading.promise).numPages
    } finally {
      await loading.destroy()
    }
    const pages: Page[] = []
    for (let n = 1; n <= count; n++) pages.push(await rasterize(pdf, n))
    return pages
  }

  /** The area cells of a page under the table's head: the rows tinted down the column's inset. */
  function cellsOf(page: Page, locale: 'en' | 'ar'): { top: number; bottom: number }[] {
    const at = px(columnOf(locale).from + 0.3)
    const cells: { top: number; bottom: number }[] = []
    let top = -1
    const end = tableEnd(page)
    for (let y = headBottom(page); y <= end + 1; y++) {
      const i = (y * page.width + at) * 4
      const tinted = y <= end && tint([page.data[i]!, page.data[i + 1]!, page.data[i + 2]!])
      if (tinted && top < 0) top = y
      if (!tinted && top >= 0) {
        if (y - top > px(2)) cells.push({ top, bottom: y - 1 })
        top = -1
      }
    }
    return cells
  }

  /**
   * Every stroke of every area name lies inside an area cell, along the page and across the column:
   * the whole table under its head is searched, in the area column and 1.5 mm on each side of it (a
   * name running out of its column crosses its edge; nothing else there is drawn in the accent). And
   * every cell holds a name.
   */
  function expectNamesInCells(page: Page, locale: 'en' | 'ar', label: string) {
    const { from, to } = columnOf(locale)
    const band = { left: px(from - 1.5), right: px(to + 1.5) }
    const cells = cellsOf(page, locale)
    expect(cells.length, `${label}: area cells`).toBeGreaterThan(0)
    const slack = px(0.3)
    const inked = new Set<number>()
    for (let y = headBottom(page); y <= tableEnd(page); y++) {
      for (let x = band.left; x <= band.right; x++) {
        const i = (y * page.width + x) * 4
        if (!ink([page.data[i]!, page.data[i + 1]!, page.data[i + 2]!])) continue
        inked.add(y)
        const where = `${label}: ink at ${mm(x)}, ${mm(y)} mm`
        expect(x, where).toBeGreaterThanOrEqual(px(from) - 1)
        expect(x, where).toBeLessThanOrEqual(px(to) + 1)
        expect(
          cells.some((cell) => y >= cell.top - slack && y <= cell.bottom + slack),
          `${where} is in no area cell`,
        ).toBe(true)
      }
    }
    for (const cell of cells) {
      let named = false
      for (let y = cell.top; y <= cell.bottom && !named; y++) named = inked.has(y)
      expect(named, `${label}: the cell at ${mm(cell.top)} mm has no name`).toBe(true)
    }
    return cells
  }

  for (const [name, locale] of [
    ['Guest bathroom and laundry, ground floor', 'en'],
    ['جناح النوم الرئيسي والحمام - الدور الأول', 'ar'],
  ] as const) {
    it(`${locale}: 40 characters on one line without a picture, smaller and wrapped`, async () => {
      expect([...name].length).toBeLessThanOrEqual(40)
      const pdf = await render(core, [{ area: name }, { area: null }], [], locale)
      const [page] = await pagesOf(pdf)
      const [cell] = expectNamesInCells(page!, locale, name)
      // Wrapped along a cell taller than one row's least (7.5 mm): its row grew to hold it.
      expect(cell!.bottom - cell!.top).toBeGreaterThan(px(7.5))
      if (locale === 'en') {
        // Every word printed (the text layer reads each turned line as a run of its own).
        const compact = (value: string) => normalizeText(value).replace(/[\s,]+/g, '')
        const text = compact(await pdfFullText(pdf))
        for (const word of name.split(' ')) expect(text).toContain(compact(word))
      }
    }, 60_000)
  }

  for (const [locale, living, suite] of [
    ['en', 'Living', 'MASTER BEDROOM SUITE'],
    ['ar', 'الصالة', 'جناح النوم الرئيسي مع الحمام'],
  ] as const) {
    it(`${locale}: names over six lines without pictures stay in their cells`, async () => {
      const areaOf = (no: number) => (no <= 6 ? living : no <= 12 ? suite : null)
      const pdf = await render(
        core,
        Array.from({ length: 14 }, (_, i) => ({ area: areaOf(i + 1) })),
        [],
        locale,
      )
      const [page] = await pagesOf(pdf)
      expect(expectNamesInCells(page!, locale, suite)).toHaveLength(2)
    }, 60_000)
  }

  for (const [locale, areas] of [
    ['en', ['MAJLIS', null, 'KITCHEN', 'WARDROBES', 'BATHROOM', null]],
    ['ar', ['المجلس', null, 'المطبخ', 'الخزائن', 'الحمام', null]],
  ] as const) {
    it(`${locale}: one-word areas of one line each, without pictures: each row grows to hold its name`, async () => {
      const pdf = await render(
        core,
        areas.map((area) => ({ area })),
        [],
        locale,
      )
      const [page] = await pagesOf(pdf)
      const cells = expectNamesInCells(page!, locale, areas.join(', '))
      expect(cells).toHaveLength(4)
      for (const cell of cells) expect(cell.bottom - cell.top).toBeGreaterThan(px(7.5))
    }, 60_000)
  }

  it('en: an area cut by the page break names its piece on each page, inside it', async () => {
    // 50 lines without pictures: page 1 holds 33; the area's lines 26–45 cross the break.
    const name = 'Guest bathroom and laundry, ground floor'
    const pdf = await render(
      core,
      Array.from({ length: 50 }, (_, i) => ({ area: i >= 25 && i < 45 ? name : null })),
    )
    const pages = await pagesOf(pdf)
    expect(pages).toHaveLength(2)
    for (const [n, page] of pages.entries()) {
      expect(expectNamesInCells(page, 'en', `page ${n + 1}`)).toHaveLength(1)
    }
  }, 60_000)
})

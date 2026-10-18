import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'

// Reads a PDF's text layer for the tests (M3 Step 7; D-224's text-layer goldens): pdf.js gives each
// page's text runs in drawing order, a right-to-left run's words from left to right; this puts each
// line's runs back in reading order (by position: right to left on a line that is mostly Arabic,
// left to right otherwise), then normalizes (NFKC, harakat and tatweel removed, spaces collapsed), so a
// phrase can be found as a person reads it. The drawn page is what counts; this only checks that copy
// and search see the words in order (D-224's known limits: Plex Arabic's required ligatures may still
// come out reversed in pdf.js, so test phrases avoid them).

interface Run {
  readonly text: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly rtl: boolean
}

/** Runs closer than this (points) are parts of one word (Typst places some glyph clusters apart). */
const WORD_GAP = 1.2

/** The bidi isolates a sentence puts around a name (FSI, LRI, RLI, PDI): invisible on the page. */
const ISOLATES = new RegExp(
  `[${String.fromCodePoint(0x2066)}-${String.fromCodePoint(0x2069)}]`,
  'gu',
)
/** The zero-width break points the server gives long runs (D-295): invisible on the page. */
const BREAK_POINTS = /\u200B/gu
const HARAKAT = /[\u064B-\u065F\u0670\u0640]/gu
const ARABIC = /[\u0600-\u06FF\uFB50-\uFDFF\uFE70-\uFEFF]/u

/** One page's text, line by line, in reading order. */
export interface PageText {
  readonly lines: readonly string[]
}

/** Text normalized as the tests compare it. */
export function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(HARAKAT, '')
    .replace(ISOLATES, '')
    .replace(BREAK_POINTS, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * A line's text in reading order: its runs by position in the line's direction, a stretch of the
 * other direction's runs turned back (a simple bidi: an Arabic name inside an English line, an amount
 * in an Arabic one), and runs that touch joined without a space.
 */
function lineText(line: readonly Run[]): string {
  const rtl = line.filter((r) => r.rtl && r.text.trim() !== '').length * 2 > line.length
  const ordered = [...line].sort((a, b) => (rtl ? b.x - a.x : a.x - b.x))
  const groups: Run[][] = []
  for (const run of ordered) {
    const last = groups.at(-1)
    if (last && (last[0]!.rtl === run.rtl || run.text.trim() === '')) last.push(run)
    else groups.push([run])
  }
  const runs = groups.flatMap((group) => (group[0]!.rtl !== rtl ? [...group].reverse() : group))
  let text = ''
  for (const [i, run] of runs.entries()) {
    const before = runs[i - 1]
    if (before) {
      const gap =
        run.x > before.x ? run.x - (before.x + before.width) : before.x - (run.x + run.width)
      if (gap > WORD_GAP) text += ' '
    }
    text += run.text
  }
  return normalizeText(text)
}

/** The text of every page of `pdf`, in reading order. */
export async function pdfText(pdf: Uint8Array): Promise<PageText[]> {
  const loading = getDocument({ data: pdf.slice(), useSystemFonts: false })
  const document = await loading.promise
  const pages: PageText[] = []
  try {
    for (let n = 1; n <= document.numPages; n++) {
      const page = await document.getPage(n)
      const content = await page.getTextContent()
      const runs: Run[] = []
      for (const item of content.items) {
        if (!('str' in item) || item.str === '') continue
        runs.push({
          text: item.str,
          x: item.transform[4] as number,
          y: Math.round(item.transform[5] as number),
          width: item.width,
          rtl: item.dir === 'rtl' || ARABIC.test(item.str),
        })
      }
      // A line: the runs whose baselines are within 2 points of each other.
      const lines: Run[][] = []
      for (const run of [...runs].sort((a, b) => b.y - a.y)) {
        const line = lines.find((l) => Math.abs(l[0]!.y - run.y) <= 2)
        if (line) line.push(run)
        else lines.push([run])
      }
      pages.push({ lines: lines.map(lineText) })
    }
  } finally {
    await loading.destroy()
  }
  return pages
}

/** Every page's lines joined, for a search across the document. */
export async function pdfFullText(pdf: Uint8Array): Promise<string> {
  const pages = await pdfText(pdf)
  return pages.map((page) => page.lines.join('\n')).join('\n')
}

/** A text run where it is drawn: its baseline's start (x, y from the page's bottom) and its width. */
export interface PlacedRun {
  readonly text: string
  readonly x: number
  readonly y: number
  readonly width: number
}

/** Each page's size and its text runs where they are drawn (points), for the layout tests. */
export async function pdfRuns(
  pdf: Uint8Array,
): Promise<{ width: number; height: number; runs: PlacedRun[] }[]> {
  const loading = getDocument({ data: pdf.slice(), useSystemFonts: false })
  const document = await loading.promise
  const pages: { width: number; height: number; runs: PlacedRun[] }[] = []
  try {
    for (let n = 1; n <= document.numPages; n++) {
      const page = await document.getPage(n)
      const viewport = page.getViewport({ scale: 1 })
      const content = await page.getTextContent()
      const runs: PlacedRun[] = []
      for (const item of content.items) {
        if (!('str' in item) || item.str.trim() === '') continue
        runs.push({
          text: item.str,
          x: item.transform[4] as number,
          y: item.transform[5] as number,
          width: item.width,
        })
      }
      pages.push({ width: viewport.width, height: viewport.height, runs })
    }
  } finally {
    await loading.destroy()
  }
  return pages
}

/**
 * How many glyphs the pages draw for `letter` (a glyph's own text may carry the zero-width break point
 * beside it), for the layout tests: every letter is drawn even where pdf.js leaves a letter that a
 * break point joined out of its text runs (Arabic: the glyph's text is its whole cluster, D-224).
 */
export async function pdfGlyphCount(pdf: Uint8Array, letter: string): Promise<number> {
  const loading = getDocument({ data: pdf.slice(), useSystemFonts: false })
  const document = await loading.promise
  let count = 0
  try {
    for (let n = 1; n <= document.numPages; n++) {
      const list = await (await document.getPage(n)).getOperatorList()
      list.fnArray.forEach((fn, i) => {
        if (fn !== OPS.showText && fn !== OPS.showSpacedText) return
        for (const glyph of (list.argsArray[i] as unknown[][])[0] ?? []) {
          if (typeof glyph !== 'object' || glyph === null || !('unicode' in glyph)) continue
          if (String(glyph.unicode).replace(BREAK_POINTS, '') === letter) count++
        }
      })
    }
  } finally {
    await loading.destroy()
  }
  return count
}

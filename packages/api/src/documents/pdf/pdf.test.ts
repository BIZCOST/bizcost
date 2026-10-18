import { createHash } from 'node:crypto'
import childProcess from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildQuotationPdfInput, firstStrongDir, formatAmount, formatDate } from './build'
import { PdfEngine } from './engine'
import type { DocumentPdfInput } from './input'
import { normalizeText, pdfFullText, pdfText } from './text-layer'
import { createCore, loadCoreAssets, type Core } from './typst-core.mjs'

// The documents' PDFs (M3 Step 7; D-224's Step 7 tests), rendered by the real Typst compiler: the text
// layer in reading order («عرض سعر», an Arabic customer name, the TRN left to right), hostile text
// printed as text, a row taller than a page printed whole, 200 lines over several pages within the
// budget, the same PDF byte for byte twice, no file, network or process call while rendering, and the
// worker replaced after its renders while the main thread stays free. Fictional data only.

const pdfInput = (over: {
  lines?: number
  customer?: string
  title?: (i: number) => string
  details?: string | null
  intro?: string | null
  draft?: boolean
  locale?: 'en' | 'ar'
  site?: string | null
  greeting?: string | null
  /** Lines in areas of 10 ("Area 1", "Area 2"…). */
  areas?: boolean
}): DocumentPdfInput =>
  buildQuotationPdfInput({
    business: {
      legalName: 'Modern Touch Interiors',
      legalNameAr: 'لمسة عصرية للديكور',
      locale: over.locale ?? 'en',
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
      watermark: true,
      wholeAmounts: false,
      signatory: 'Abdullah Al Kaabi',
      footer: null,
    },
    quotation: {
      number: 'Q-0042',
      revision: 1,
      draft: over.draft ?? false,
      businessDate: '2026-10-08',
      validUntil: '2026-10-15',
      customerRef: 'LPO-7781/B',
      site: over.site ?? null,
      currency: 'AED',
      vatRegistered: true,
      subtotal: '1000.00',
      discountTotal: '0',
      adjustment: '0',
      roundingDifference: '0',
      netTotal: '1000.00',
      vatTotal: '50.00',
      total: '1050.00',
      payable: '1050.00',
      vatRates: [{ vatCategory: 'standard', vatRate: '5', net: '1000.00', vat: '50.00' }],
      greeting: over.greeting ?? null,
      intro: over.intro ?? null,
      terms: null,
      notes: null,
      issuedAt: new Date(Date.UTC(2026, 9, 8, 9, 30, 0)),
      lines: Array.from({ length: over.lines ?? 2 }, (_, i) => ({
        area: over.areas ? `Area ${Math.floor(i / 10) + 1}` : null,
        title: over.title ? over.title(i) : `Work item ${i + 1}`,
        details: over.details ?? null,
        note: null,
        qty: '1',
        unit: 'piece' as const,
        unitPrice: '500.0000',
        subtotal: '500.0000',
        lineDiscount: '0',
        priceIncludesVat: false,
        vatCategory: 'standard' as const,
        vatRate: '5',
        picture: null,
      })),
      stages: [],
    },
    customer: {
      name: over.customer ?? 'خالد المنصوري',
      phone: null,
      trn: null,
      addressLine: null,
      city: null,
      emirate: null,
    },
    businessImages: { logo: null, signature: null, stamp: null },
    images: {},
  })

let core: Core

beforeAll(async () => {
  core = await createCore()
}, 60_000)

const render = (input: DocumentPdfInput) => core.render({ data: JSON.stringify(input), images: [] })

/**
 * A distinct document's PDF and how long its warm render took: the best of three renders of three
 * documents (a test run shares the machine with the other packages' tests, so one slow moment is not
 * the template's time).
 */
async function timed(
  make: (k: number) => DocumentPdfInput,
): Promise<{ pdf: Uint8Array; took: number }> {
  await render(make(0))
  let took = Number.POSITIVE_INFINITY
  let pdf: Uint8Array = new Uint8Array()
  for (let k = 1; k <= 3; k++) {
    const started = performance.now()
    pdf = await render(make(k))
    took = Math.min(took, performance.now() - started)
  }
  return { pdf, took }
}

describe('the text layer', () => {
  it('reads «عرض سعر», the Arabic customer name in logical order, and the TRN left to right', async () => {
    const text = await pdfFullText(await render(pdfInput({})))
    expect(text).toContain('عرض سعر')
    expect(text).toContain(normalizeText('خالد المنصوري'))
    expect(text).toContain('100123456700003')
    expect(text).toContain('Q-0042')
    expect(text).toContain('Quotation')
  }, 30_000)

  it('prints a name or a description holding HTML, Typst markup or code as text', async () => {
    const hostile = '<b>Ali</b> #read("/etc/passwd") #import "@preview/x:0.1.0" *bold* $x^2$ ]'
    const pdf = await render(
      pdfInput({
        customer: hostile,
        title: () => '#eval("1 + 1") <script>alert(1)</script>',
        details: '#let x = 1\n= Heading\n- list',
      }),
    )
    // A long name may wrap: the lines are joined before the text is compared.
    const text = normalizeText(await pdfFullText(pdf))
    expect(text).toContain('<b>Ali</b>')
    expect(text).toContain('#read("/etc/passwd")')
    expect(text).toContain('#import "@preview/x:0.1.0"')
    expect(text).toContain('*bold* $x^2$ ]')
    expect(text).toContain('#eval("1 + 1") <script>alert(1)</script>')
    expect(text).toContain('#let x = 1')
    expect(text).toContain('= Heading')
  }, 30_000)

  it('greets with the name and the project each in its own isolate, «السادة» in Arabic', async () => {
    const english = normalizeText(
      await pdfFullText(await render(pdfInput({ site: 'Villa 12, Al Barsha' }))),
    )
    expect(english).toContain('Dear')
    expect(english).toContain(normalizeText('خالد المنصوري'))
    expect(english).toContain('Villa 12, Al Barsha,')
    const arabic = normalizeText(
      await pdfFullText(await render(pdfInput({ locale: 'ar', site: 'فيلا 7، الرحمانية' }))),
    )
    expect(arabic).toContain(normalizeText('السادة'))
    expect(arabic).not.toContain(normalizeText('عزيزنا'))
    const typed = normalizeText(
      await pdfFullText(await render(pdfInput({ greeting: 'Dear Eng. Hamdan and team,' }))),
    )
    expect(typed).toContain('Dear Eng. Hamdan and team,')
    expect(typed).not.toContain('Dear خالد')
  }, 30_000)

  it('marks a draft as a draft, in both languages', async () => {
    const text = normalizeText(await pdfFullText(await render(pdfInput({ draft: true }))))
    expect(text).toContain('DRAFT')
    expect(text).toContain(normalizeText('مسودة'))
  }, 30_000)

  it('prints a bare tax credit note with its title and the invoice it corrects', async () => {
    const base = pdfInput({ lines: 1 })
    const bare: DocumentPdfInput = {
      ...base,
      kind: 'tax_credit_note',
      title: base.labels['title.taxCreditNote']!,
      number: 'CN-0001',
      revision: null,
      validUntil: null,
      validity: null,
      customerRef: null,
      opening: null,
      references: [
        { label: base.labels['references.invoiceNo']!, value: 'INV-0042' },
        {
          label: base.labels['references.invoiceDate']!,
          value: { en: '8 October 2026', ar: '8 أكتوبر 2026' },
        },
      ],
      letterhead: {
        ...base.letterhead,
        nameEn: null,
        logo: null,
        phones: [],
        email: null,
        address: null,
        trn: null,
        tradeLicence: null,
      },
      stages: [],
      terms: null,
      notes: null,
      paymentDetails: null,
      signature: { signatory: null, signature: null, stamp: null, acceptance: false },
    }
    const pages = await pdfText(await render(bare))
    expect(pages).toHaveLength(1)
    const text = normalizeText(pages[0]!.lines.join(' '))
    // «ضريبي» is one of D-224's known ligature cases in pdf.js: the title is checked without it.
    expect(text).toContain(normalizeText('إشعار دائن'))
    expect(text).toContain('Tax Credit Note')
    expect(text).toContain('CN-0001')
    expect(text).toContain('INV-0042')
    expect(text).not.toContain('Dear')
  }, 30_000)

  it('prints a description taller than a page whole, across pages', async () => {
    const details = Array.from({ length: 160 }, (_, i) => `Fitting ${i + 1}`).join('\n')
    const pages = await pdfText(await render(pdfInput({ lines: 1, details })))
    expect(pages.length).toBeGreaterThan(1)
    const text = pages.map((p) => p.lines.join('\n')).join('\n')
    expect(text).toContain('Fitting 1')
    expect(text).toContain('Fitting 160')
  }, 30_000)
})

describe('pages, speed and determinism', () => {
  it('200 lines paginate with the table head on every page, in under 1 s warm', async () => {
    const { pdf, took } = await timed((k) =>
      pdfInput({ lines: 200, intro: `Document ${k}, a different one.` }),
    )
    expect(took).toBeLessThan(1000)
    const pages = await pdfText(pdf)
    expect(pages.length).toBeGreaterThanOrEqual(4)
    // Every page with lines repeats the table's head.
    for (const page of pages.filter((p) => p.lines.some((line) => line.includes('Work item')))) {
      expect(page.lines.some((line) => line.includes('Description'))).toBe(true)
    }
    const text = pages.map((p) => p.lines.join(' ')).join(' ')
    expect(text).toContain('Work item 1 ')
    expect(text).toContain('Work item 200')
  }, 60_000)

  it('200 lines in areas paginate, each page naming its areas, in under 1 s warm', async () => {
    const { pdf, took } = await timed((k) =>
      pdfInput({ lines: 200, areas: true, intro: `Document ${k}, a different one.` }),
    )
    expect(took).toBeLessThan(1000)
    const pages = await pdfText(pdf)
    expect(pages.length).toBeGreaterThanOrEqual(4)
    // An area that runs over a page is named again on the next one.
    for (const page of pages.filter((p) => p.lines.some((line) => line.includes('Work item')))) {
      expect(page.lines.some((line) => /Area \d+/.test(line))).toBe(true)
    }
    const text = pages.map((p) => p.lines.join(' ')).join(' ')
    expect(text).toContain('Work item 200')
    expect(text).toContain('Area 20')
  }, 60_000)

  it('renders the same PDF byte for byte, in another compiler too, dated by the document', async () => {
    const input = pdfInput({})
    const first = await render(input)
    const again = await render(input)
    const other = await (
      await createCore(loadCoreAssets())
    ).render({
      data: JSON.stringify(input),
      images: [],
    })
    const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
    expect(sha(again)).toBe(sha(first))
    expect(sha(other)).toBe(sha(first))
    expect(Buffer.from(first).toString('latin1')).toContain('D:20261008093000')
  }, 60_000)

  it('makes no file, network or process call while rendering', async () => {
    const input = JSON.stringify(pdfInput({ lines: 3 }))
    const calls: string[] = []
    const spies = [
      vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
        calls.push('fs.readFileSync')
        throw new Error('no file access')
      }),
      vi.spyOn(fs, 'readFile').mockImplementation(() => {
        calls.push('fs.readFile')
        throw new Error('no file access')
      }),
      vi.spyOn(fs, 'openSync').mockImplementation(() => {
        calls.push('fs.openSync')
        throw new Error('no file access')
      }),
      vi.spyOn(fs.promises, 'readFile').mockImplementation(() => {
        calls.push('fs.promises.readFile')
        throw new Error('no file access')
      }),
      vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(() => {
        calls.push('net.connect')
        throw new Error('no network')
      }),
      vi.spyOn(http, 'request').mockImplementation(() => {
        calls.push('http.request')
        throw new Error('no network')
      }),
      vi.spyOn(https, 'request').mockImplementation(() => {
        calls.push('https.request')
        throw new Error('no network')
      }),
      vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
        calls.push('fetch')
        throw new Error('no network')
      }),
      vi.spyOn(childProcess, 'spawn').mockImplementation(() => {
        calls.push('child_process.spawn')
        throw new Error('no process')
      }),
      vi.spyOn(childProcess, 'exec').mockImplementation(() => {
        calls.push('child_process.exec')
        throw new Error('no process')
      }),
    ]
    try {
      const pdf = await core.render({ data: input, images: [] })
      expect(pdf.byteLength).toBeGreaterThan(1000)
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
    expect(calls).toEqual([])
  }, 30_000)

  it('refuses an image path the server did not make', async () => {
    await expect(
      core.render({
        data: JSON.stringify(pdfInput({})),
        images: [{ path: '/etc/passwd', bytes: new Uint8Array([1]) }],
      }),
    ).rejects.toThrow(/not an image path/)
  })
})

describe('the worker', () => {
  let engine: PdfEngine

  afterAll(async () => {
    await engine.close()
  })

  it('is replaced after its renders, and the main thread stays free while it renders', async () => {
    engine = new PdfEngine({ maxRenders: 2 })
    const data = JSON.stringify(pdfInput({ lines: 200 }))
    let longest = 0
    let last = performance.now()
    const timer = setInterval(() => {
      const now = performance.now()
      longest = Math.max(longest, now - last)
      last = now
    }, 5)
    try {
      for (let i = 0; i < 5; i++) {
        const pdf = await engine.render({ data, images: [] })
        expect(Buffer.from(pdf.subarray(0, 5)).toString('latin1')).toBe('%PDF-')
      }
    } finally {
      clearInterval(timer)
    }
    expect(engine.workersStarted).toBe(3)
    // A render takes ~0.2–1 s on its worker; the main thread answers timers all along.
    expect(longest).toBeLessThan(150)
  }, 120_000)
})

describe('the input', () => {
  it('formats amounts, dates and directions as the documents print them', () => {
    expect(formatAmount('16100', 2, false)).toBe('16,100.00')
    expect(formatAmount('16100.00', 2, true)).toBe('16,100')
    expect(formatAmount('16100.5', 2, true)).toBe('16,100.50')
    expect(formatAmount('-89', 2, false)).toBe('-89.00')
    expect(formatAmount('1234567.125', 3, false)).toBe('1,234,567.125')
    expect(formatDate('2026-10-08')).toEqual({ en: '8 October 2026', ar: '8 أكتوبر 2026' })
    expect(firstStrongDir('123 خالد', 'ltr')).toBe('rtl')
    expect(firstStrongDir('Villa 12 فيلا', 'rtl')).toBe('ltr')
    expect(firstStrongDir('123', 'rtl')).toBe('rtl')
  })
})

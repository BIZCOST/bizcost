import { afterAll, describe, expect, it } from 'vitest'
import { buildQuotationPdfInput } from '../src/documents/pdf/build'
import { PdfEngine, PDF_WORKER_MAX_RENDERS } from '../src/documents/pdf/engine'

// The PDF worker under load (M3 Step 7; D-224: "at least 500 distinct renders staying under 2 GB, the
// worker replaced along the way"). The compiler's WebAssembly memory grows with every distinct PDF and
// is only given back when its worker ends, so the engine replaces the worker every 50 renders: 500
// distinct quotations keep the process under 2 GB. No database: it runs with the integration suites
// for its length (about a minute and a half). Fictional data.

const engine = new PdfEngine()

afterAll(async () => {
  await engine.close()
})

function quotation(n: number): string {
  return JSON.stringify(
    buildQuotationPdfInput({
      business: {
        legalName: 'Al Itqan Carpentry',
        legalNameAr: 'نجارة الإتقان',
        locale: n % 2 === 0 ? 'en' : 'ar',
        vatRegistered: true,
        trn: '100678901200003',
        phone: '+971 6 555 0177',
        phone2: null,
        email: 'orders@alitqan.example',
        addressLine: 'Industrial Area 2',
        city: null,
        emirate: 'sharjah',
        tradeLicenceNo: null,
        accent: 'brown',
        watermark: false,
        wholeAmounts: false,
        signatory: null,
        footer: null,
      },
      quotation: {
        number: `Q-${String(n).padStart(4, '0')}`,
        revision: 1,
        draft: false,
        businessDate: '2026-10-16',
        validUntil: null,
        customerRef: null,
        site: null,
        currency: 'AED',
        vatRegistered: true,
        subtotal: '100.00',
        discountTotal: '0',
        adjustment: '0',
        roundingDifference: '0',
        netTotal: '100.00',
        vatTotal: '5.00',
        total: '105.00',
        payable: '105.00',
        vatRates: [{ vatCategory: 'standard', vatRate: '5', net: '100.00', vat: '5.00' }],
        greeting: null,
        intro: null,
        terms: null,
        notes: null,
        issuedAt: new Date(Date.UTC(2026, 9, 16, 8, 0, n % 60)),
        lines: Array.from({ length: 8 }, (_, i) => ({
          area: null,
          title: `Job ${n} item ${i + 1}`,
          details: `Customer request ${n}-${i}`,
          note: null,
          qty: '1',
          unit: 'piece' as const,
          unitPrice: '12.5000',
          subtotal: '12.5000',
          lineDiscount: '0',
          priceIncludesVat: false,
          vatCategory: 'standard' as const,
          vatRate: '5',
          picture: null,
        })),
        stages: [],
      },
      customer: {
        name: `Customer ${n}`,
        phone: null,
        trn: null,
        addressLine: null,
        city: null,
        emirate: null,
      },
      businessImages: { logo: null, signature: null, stamp: null },
      images: {},
    }),
  )
}

describe('the PDF worker', () => {
  it('renders 500 distinct PDFs under 2 GB, replaced every 50 renders', async () => {
    let peak = 0
    for (let n = 1; n <= 500; n++) {
      const pdf = await engine.render({ data: quotation(n), images: [] })
      expect(pdf.byteLength).toBeGreaterThan(1000)
      peak = Math.max(peak, process.memoryUsage().rss)
    }
    expect(engine.workersStarted).toBeGreaterThanOrEqual(500 / PDF_WORKER_MAX_RENDERS)
    expect(peak).toBeLessThan(2 * 1024 * 1024 * 1024)
  }, 600_000)
})

import type { DocumentPdfDto, InvoiceDto } from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { InvoicesApi, InvoiceScope } from './invoices'
import { ok } from './purchasing'
import { FIT_OUT } from './quotations'

// The time budget of a PDF (M3 definition of done, Budgets: "a 2-page invoice PDF: under 1 s warm";
// the plan's Step 10). A tax invoice of a fit-out company with enough typed lines for two pages, each
// with its details: `invoice.pdf` of the draft (made on request, as every draft's is) and of the
// issued invoice (its stored copy), through the API as the owner, after a first call warms the
// server's engine as a running server is. Locally, each well under 1 s.

const BUDGET_MS = 1000

let api: InvoicesApi
let shop: InvoiceScope

beforeAll(async () => {
  api = new InvoicesApi()
  shop = await InvoiceScope.open(api, FIT_OUT)
  await shop.taxReady()
}, 120_000)

afterAll(async () => {
  await api.close()
})

/** The PDF of an invoice, and how long the call took. */
async function timed(id: string): Promise<{ pdf: DocumentPdfDto; ms: number }> {
  const started = performance.now()
  const pdf = ok(await shop.run<DocumentPdfDto>('invoice.pdf', { id }))
  return { pdf, ms: performance.now() - started }
}

describe('a two-page tax invoice’s PDF in under 1 s warm', () => {
  it('its draft made on request, and the issued one, each in under 1 s', async () => {
    const buyer = await shop.buyer()
    const draft: InvoiceDto = await shop.invoice({
      customerId: buyer.id,
      channelId: await shop.channelId(),
      countedElsewhere: false,
      lines: Array.from({ length: 24 }, (_, i) => ({
        id: newId(),
        productId: null,
        description: `Gypsum partition, room ${i + 1}`,
        details: 'Supply and fix, 12.5 mm board on a metal stud frame, joints taped and filled',
        qty: '12.5',
        unit: 'm2',
        unitPrice: '45',
      })),
    })
    // Warm: the engine's first render compiles its fonts and template.
    await timed(draft.id)
    const made = await timed(draft.id)
    expect(made.pdf.pages).toBe(2)
    console.info(`invoice.pdf of a two-page draft: ${Math.round(made.ms)} ms`)
    expect(made.ms).toBeLessThan(BUDGET_MS)

    const issued = await shop.issue(draft)
    expect(issued.status).toBe('issued')
    const stored = await timed(issued.id)
    expect(stored.pdf.pages).toBe(2)
    console.info(`invoice.pdf of the issued invoice: ${Math.round(stored.ms)} ms`)
    expect(stored.ms).toBeLessThan(BUDGET_MS)
  }, 120_000)
})

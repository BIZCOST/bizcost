import type { MaterialDto, PurchaseDto, SaleDto } from '@bizcost/contracts'
import { SALE_LINES_MAX } from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { tag } from './product-costs'
import { ok, purchaseInput } from './purchasing'
import { bought, CAFE, item, SalesApi, SaleScope, shift } from './sales'

// The time budget of a fill (M3 Step 10; D-328). A business that enters its sales before its first
// supplier bill (Q5) leaves their materials "no price yet"; the first purchase of those materials
// fills every waiting row in the same posting (fillSaleMaterialCosts, D-229). Three sales of
// SALE_LINES_MAX lines of a product made of 24 materials leave 21,600 material rows and 900 lines
// waiting: their purchase posts, filling them all, in under FILL_BUDGET_MS locally, well within the
// 15 s statement timeout (security/m3-step2-costing-adversary posts the same purchase and checks a
// line's cost; it timed out under a loaded full run before D-328). Only purchase.post is timed.

const FILL_BUDGET_MS = 4000
const MATERIALS = 24
const SALES = 3

let api: SalesApi

beforeAll(() => {
  api = new SalesApi()
})

afterAll(async () => {
  await api.close()
})

describe('a purchase that fills 21,600 waiting material rows posts within its budget (D-328)', () => {
  it(`fills ${SALES} × ${SALE_LINES_MAX} lines × ${MATERIALS} materials in under ${FILL_BUDGET_MS} ms`, async () => {
    const cafe = await SaleScope.open(api, CAFE)
    const today = await cafe.today()
    const parts: MaterialDto[] = []
    for (let i = 0; i < MATERIALS; i++) {
      parts.push(await cafe.newMaterial({ name: `Part ${i} ${tag()}`, unit: 'kg', packs: [] }))
    }
    const platter = await cafe.product({ name: `Platter ${tag()}`, defaultPrice: '10' })
    await cafe.recipe(
      platter.id,
      parts.map((m) => ({ id: newId(), materialId: m.id, qty: '1', unit: 'g' })),
    )
    const sales: SaleDto[] = []
    for (let i = 0; i < SALES; i++) {
      sales.push(
        await cafe.sell({
          businessDate: shift(today, -SALES + i),
          lines: Array.from({ length: SALE_LINES_MAX }, () => item(platter.id, '1', '10')),
        }),
      )
    }
    expect(sales.every((s) => s.lines.every((l) => l.cost === null))).toBe(true)
    const draft = await cafe.draft(
      purchaseInput(
        today,
        parts.map((m) => bought(m.id, '1', '10', { unit: 'kg' })),
      ),
    )

    const started = performance.now()
    const posted = await cafe.run<{ data: PurchaseDto }>('purchase.post', {
      id: draft.id,
      version: draft.version,
    })
    const elapsed = performance.now() - started
    expect(posted.error?.data.appCode).toBeUndefined()
    expect(ok(posted).data.status).toBe('posted')
    console.info(
      `fill of ${SALES * SALE_LINES_MAX * MATERIALS} material rows: ${Math.round(elapsed)} ms`,
    )
    expect(elapsed).toBeLessThan(FILL_BUDGET_MS)

    // Every line of every sale is filled, once: 24 materials × 1 g at 0.01 a gram, 0.24 a platter.
    for (const sale of sales) {
      const lines = (await cafe.sale(sale.id)).lines
      expect(lines).toHaveLength(SALE_LINES_MAX)
      expect(lines.every((l) => l.cost === '0.24')).toBe(true)
    }
  }, 300_000)
})

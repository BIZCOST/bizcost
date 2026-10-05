import type { MaterialDto, ProductDto, PurchaseDto, SaleDto } from '@bizcost/contracts'
import { SALE_LINES_MAX } from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { tag } from '../product-costs'
import { ok, purchaseInput } from '../purchasing'
import { bought, CAFE, item, SalesApi, SaleScope, shift } from '../sales'

// COSTING AND CONCURRENCY REVIEW of M3 Step 2 (sales data and API). Each case is a defect found by the
// adversarial review; they fail until it is fixed (none is fixed here). The lock order of D-228 itself
// held under forced interleavings (a purchase posting between a sale's read of the purchases and its
// commit, a first purchase racing a sale both ways, a reversal holding the header during a fill, the
// hourly rate set while a sale posts, two purchases filling two materials of one line): those are not
// repeated here.
//
// 1. sale.list's day totals (D-227: "one reversed on a later day is taken back on that day") lose a
//    closed day's reversal: the negative row is filtered by the SALE's day (`from`/`to` apply to
//    s.business_date in both halves of dayTotalsOf), and the reversal day is only totalled when a sale
//    of that day is on the page. A list of this month after closing last month shows the reversed
//    sale's negative nowhere, so the month's sales read higher than they are.
//
// 2. A fill is missed after a return is reversed. A purchase fully returned leaves its material with
//    no standing purchase, so a sale finalized then freezes "no price yet". Reversing the return makes
//    the purchase stand again, but only purchase.post fills (D-229), so the sale keeps "no price yet"
//    while a standing purchase prices it: the invariant of sales.concurrency.api.test.ts ("a material
//    row still without a price has no purchase standing of its material") is broken.
//
// 3. A valid sale cannot be finalized: postSale inserts every line's material rows in ONE statement
//    (insertMaterialRows: 9 bind parameters a row), and postgres.js refuses 65,534 parameters or more
//    (MAX_PARAMETERS_EXCEEDED → INTERNAL). SALE_LINES_MAX (300) × a recipe of 25 materials (the DTO
//    allows 60) = 7,500 rows = 67,500 parameters.
//
// 4. A purchase can no longer be posted once enough sales wait for its materials' price:
//    fillSaleMaterialCosts writes every waiting material row in ONE statement (4 parameters a row), so
//    16,384 waiting rows (a business that entered its sales for weeks before its first supplier bill:
//    the onboarding case Q5 allows) make purchase.post fail with INTERNAL, every time, for every
//    purchase of those materials, until sales are reversed. Purchases are released; this breaks them
//    as soon as Sales is.

let api: SalesApi

beforeAll(() => {
  api = new SalesApi()
})

afterAll(async () => {
  await api.close()
})

/** `count` materials counted in kg (never bought). */
async function materials(scope: SaleScope, count: number): Promise<MaterialDto[]> {
  const list: MaterialDto[] = []
  for (let i = 0; i < count; i++) {
    list.push(await scope.newMaterial({ name: `Part ${i} ${tag()}`, unit: 'kg', packs: [] }))
  }
  return list
}

/** A product whose recipe uses 1 g of each of `parts`. */
async function productOf(scope: SaleScope, parts: readonly MaterialDto[]): Promise<ProductDto> {
  const product = await scope.product({ name: `Platter ${tag()}`, defaultPrice: '10' })
  await scope.recipe(
    product.id,
    parts.map((m) => ({ id: newId(), materialId: m.id, qty: '1', unit: 'g' })),
  )
  return product
}

describe('sale.list day totals: a closed day’s reversal is taken back on its own day (D-227)', () => {
  let cafe: SaleScope
  let today: string
  let yesterday: string

  beforeAll(async () => {
    cafe = await SaleScope.open(api, CAFE)
    today = await cafe.today()
    yesterday = shift(today, -1)
  }, 60_000)

  // Each case closes the books through yesterday; each starts with them open.
  beforeEach(async () => {
    ok(await cafe.run('books.close', { closedThrough: null }))
  })

  it('a list of the reversal’s day alone still takes the reversed sale back on it', async () => {
    const coffee = await cafe.product({ name: `Coffee ${tag()}`, defaultPrice: '10' })
    await cafe.sell({ businessDate: yesterday, lines: [item(coffee.id, '10', '10')] })
    const old = await cafe.sell({ businessDate: yesterday, lines: [item(coffee.id, '5', '10')] })
    await cafe.sell({ businessDate: today, lines: [item(coffee.id, '3', '10')] })
    ok(await cafe.run('books.close', { closedThrough: yesterday }))
    expect((await cafe.reverseSale(old.id)).reversalBusinessDate).toBe(today)

    // The whole range: yesterday 150 (its month keeps it), today 30 − 50 = −20.
    const both = await cafe.sales({ from: yesterday, to: today })
    expect(both.dayTotals?.find((d) => d.businessDate === today)?.netTotal).toBe('-20')

    // Today alone (the Sales page filtered to this month after last month was closed): the same −20.
    const todayOnly = await cafe.sales({ from: today, to: today })
    expect(todayOnly.dayTotals).toEqual([
      expect.objectContaining({ businessDate: today, netTotal: '-20' }),
    ])
  })

  it('a reversal day with no sale of its own is still listed with what it takes back', async () => {
    const tea = await cafe.product({ name: `Tea ${tag()}`, defaultPrice: '8' })
    const search = tea.name
    const old = await cafe.sell({ businessDate: yesterday, lines: [item(tea.id, '4', '8')] })
    ok(await cafe.run('books.close', { closedThrough: yesterday }))
    await cafe.reverseSale(old.id)
    // Only the reversed sale matches: yesterday keeps its 32, today takes the 32 back.
    const list = await cafe.sales({ search })
    expect(list.items.map((s) => s.id)).toEqual([old.id])
    expect(list.dayTotals?.find((d) => d.businessDate === today)?.netTotal).toBe('-32')
  })
})

describe('a return reversed makes its purchase stand again: the sales it left without a price take it (D-229)', () => {
  it('the sale finalized while the purchase was fully returned is priced once the return is reversed', async () => {
    const cafe = await SaleScope.open(api, CAFE)
    const today = await cafe.today()
    const [flour] = await materials(cafe, 1)
    const cake = await productOf(cafe, [flour!])
    const purchase: PurchaseDto = await cafe.buy(
      purchaseInput(shift(today, -2), [bought(flour!.id, '2', '10', { unit: 'kg' })]),
    )
    const returned = await cafe.postReturn(
      await cafe.returnDraft({
        id: newId(),
        purchaseId: purchase.id,
        kind: 'return',
        businessDate: shift(today, -1),
        lines: [{ id: newId(), purchaseLineId: purchase.lines[0]!.id, qty: '2' }],
      }),
    )
    const sold: SaleDto = await cafe.sell({
      businessDate: today,
      lines: [item(cake.id, '1', '10')],
    })
    expect(sold.lines[0]?.cost).toBeNull()

    ok(await cafe.run('purchaseReturn.reverse', { id: returned.id }))
    // 2 kg at 10 stand again: 1 g costs 0.01. Without a fill the sale says "no price yet" forever (or
    // until the next purchase of flour), though a standing purchase prices it.
    expect((await cafe.sale(sold.id)).lines[0]).toMatchObject({ cost: '0.01' })
  }, 60_000)
})

describe('no number of lines or waiting sales makes a posting fail (D-209’s rule, H3)', () => {
  it(`a sale of ${SALE_LINES_MAX} lines of a product made of 25 materials is finalized`, async () => {
    const cafe = await SaleScope.open(api, CAFE)
    const today = await cafe.today()
    const platter = await productOf(cafe, await materials(cafe, 25))
    const draft = await cafe.saleDraft({
      businessDate: today,
      lines: Array.from({ length: SALE_LINES_MAX }, () => item(platter.id, '1', '10')),
    })
    const posted = await cafe.run<{ data: SaleDto }>('sale.post', {
      id: draft.id,
      version: draft.version,
    })
    expect(posted.error?.data.appCode).toBeUndefined()
    expect(ok(posted).data.status).toBe('posted')
  }, 120_000)

  it('the first purchase of materials that 3 big sales wait for is posted, and fills them', async () => {
    const cafe = await SaleScope.open(api, CAFE)
    const today = await cafe.today()
    const parts = await materials(cafe, 24)
    const platter = await productOf(cafe, parts)
    // Each sale: 300 lines × 24 materials = 7,200 rows waiting for a price (it posts: 64,800
    // parameters). Three of them: 21,600 rows.
    const sales: SaleDto[] = []
    for (let i = 0; i < 3; i++) {
      sales.push(
        await cafe.sell({
          businessDate: shift(today, -3 + i),
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
    const posted = await cafe.run<{ data: PurchaseDto }>('purchase.post', {
      id: draft.id,
      version: draft.version,
    })
    expect(posted.error?.data.appCode).toBeUndefined()
    // 24 materials × 1 g at 0.01 a gram: 0.24 a platter.
    expect((await cafe.sale(sales[0]!.id)).lines[0]?.cost).toBe('0.24')
  }, 300_000)
})

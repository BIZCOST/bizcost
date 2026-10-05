import type { LocationDto, MaterialDto } from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { tag } from './product-costs'
import { ProfitApi, ProfitScope } from './profit'
import { ok, purchaseInput } from './purchasing'
import { bought, CAFE_BRANCHES, shift } from './sales'

// The time budget of real profit worked out on read (ROADMAP.md M3 Step 3; the plan's risk "Real
// profit computed on read, under the 15 s statement timeout"; definition of done: under 1 s locally):
// a year of a two-branch café's daily sales (two channels at each branch every day, 20 products of 5
// materials each: 1,460 sales, 29,200 lines, 146,000 material rows), then profit.summary over the
// year by month, week, day, product, channel and branch, and the Dashboard's cards. The year is written
// straight into the database (as postgres, a local test) since 1,460 postings through the API would
// take minutes; the reads go through the API as the owner.

const BUDGET_MS = 1000
const PRODUCTS = 20
const MATERIALS = 10

let api: ProfitApi
let cafe: ProfitScope
let today: string
let from: string

beforeAll(async () => {
  api = new ProfitApi()
  cafe = await ProfitScope.open(api, CAFE_BRANCHES)
  today = await cafe.today()
  from = shift(today, -364)
  ok(await cafe.run<LocationDto>('location.create', { id: newId(), name: `Marina ${tag()}` }))
  await cafe.deliveryApp('18')
  await cafe.monthly('20000', shift(from, -40))
  const materials: MaterialDto[] = []
  for (let i = 0; i < MATERIALS; i += 1) {
    materials.push(await cafe.newMaterial({ name: `Material ${i} ${tag()}`, unit: 'piece' }))
  }
  await cafe.buy(
    purchaseInput(
      shift(from, -1),
      materials.map((m, i) => bought(m.id, '100000', String(1 + i / 10), { unit: 'piece' })),
    ),
  )
  for (let p = 0; p < PRODUCTS; p += 1) {
    const product = await cafe.product({ name: `Item ${p} ${tag()}`, defaultPrice: String(10 + p) })
    await cafe.recipe(
      product.id,
      [0, 1, 2, 3, 4].map((k) => ({
        id: newId(),
        materialId: materials[(p + k) % MATERIALS]!.id,
        qty: '1',
        unit: 'piece',
      })),
    )
  }
  const userId = cafe.owner.user.id
  await api.admin.begin(async (sql) => {
    // Straight into the tables (a local test): no audit rows for a generated year.
    await sql`set local session_replication_role = replica`
    await sql`
      insert into app.sales (id, business_id, source, business_date, location_id, channel_id,
                             status, vat_registered, currency, posted_at, posted_by, created_by)
      select gen_random_uuid(), ${cafe.id}, 'single', d::date, l.id, c.id, 'posted', true, 'AED',
             now(), ${userId}, ${userId}
        from generate_series(${from}::date, ${today}::date, interval '1 day') d
        cross join app.locations l
        cross join app.sales_channels c
       where l.business_id = ${cafe.id} and l.deleted_at is null
         and c.business_id = ${cafe.id} and c.deleted_at is null
         and c.kind in ('shop', 'delivery_app')`
    await sql`
      insert into app.sale_lines (id, business_id, sale_id, position, kind, product_id, description,
                                  qty, unit, unit_price, subtotal, net, total, cost_basis, cost,
                                  created_by)
      select gen_random_uuid(), s.business_id, s.id, p.ord::int, 'item', p.id, p.name,
             1 + (p.ord + extract(day from s.business_date)::int) % 7, 'piece', p.default_price,
             0, (1 + (p.ord + extract(day from s.business_date)::int) % 7) * p.default_price, 0,
             'recipe', 5 * (1 + (p.ord + extract(day from s.business_date)::int) % 7), ${userId}
        from app.sales s
        cross join lateral (
          select x.id, x.name, x.default_price, row_number() over (order by x.name) as ord
            from app.products_services x
           where x.business_id = s.business_id and x.deleted_at is null) p
       where s.business_id = ${cafe.id}`
    await sql`
      insert into app.sale_line_materials (id, business_id, sale_id, sale_line_id, material_id,
                                           base_qty, unit_cost, cost, basis, created_by)
      select gen_random_uuid(), l.business_id, l.sale_id, l.id, rl.material_id, l.qty, 1, l.qty,
             'purchases_90_days', ${userId}
        from app.sale_lines l
        join app.recipes r on r.business_id = l.business_id and r.product_id = l.product_id
        join app.recipe_lines rl on rl.business_id = r.business_id and rl.recipe_id = r.id
       where l.business_id = ${cafe.id}`
  })
  // As autovacuum would after such a load: the planner knows the year.
  await api.admin`analyze app.sales`
  await api.admin`analyze app.sale_lines`
  await api.admin`analyze app.sale_line_materials`
}, 600_000)

afterAll(async () => {
  await api.close()
})

describe('a year of a two-branch café’s daily sales', () => {
  it('has the year’s rows', async () => {
    const [count] = await api.admin<{ sales: number; lines: number; rows: number }[]>`
      select (select count(*)::int from app.sales where business_id = ${cafe.id}) as sales,
             (select count(*)::int from app.sale_lines where business_id = ${cafe.id}) as lines,
             (select count(*)::int from app.sale_line_materials where business_id = ${cafe.id})
               as rows`
    expect(count).toEqual({ sales: 1460, lines: 1460 * PRODUCTS, rows: 1460 * PRODUCTS * 5 })
  })

  it(`profit.summary over the year, every grouping, under ${BUDGET_MS} ms`, async () => {
    // A first call warms the server code (as a running server is).
    await cafe.summary({ from, to: today })
    const times: Record<string, number> = {}
    for (const groupBy of ['month', 'week', 'day', 'product', 'channel', 'branch'] as const) {
      const started = performance.now()
      const summary = await cafe.summary({ from, to: today, groupBy })
      times[groupBy] = Math.round(performance.now() - started)
      expect(summary.groups.length, groupBy).toBeGreaterThan(0)
      expect(summary.total.profit, groupBy).not.toBeNull()
    }
    for (const [groupBy, ms] of Object.entries(times)) {
      expect(ms, `${groupBy}: ${ms} ms`).toBeLessThan(BUDGET_MS)
    }
  })

  it(`the Dashboard’s cards under ${BUDGET_MS} ms`, async () => {
    await cafe.cards()
    const started = performance.now()
    const cards = await cafe.cards()
    const ms = Math.round(performance.now() - started)
    expect(cards.sales).not.toBeNull()
    expect(ms, `${ms} ms`).toBeLessThan(BUDGET_MS)
  })
})

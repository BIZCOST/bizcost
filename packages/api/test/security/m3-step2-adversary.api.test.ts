import type { SaleDto } from '@bizcost/contracts'
import { newId, SALE_LINE_QTY_MAX } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addMember } from '../helpers'
import { tag } from '../product-costs'
import { codeOf, line, ok, purchaseInput, type Person } from '../purchasing'
import { CAFE, item, SalesApi, SaleScope } from '../sales'

// ADVERSARY (M3 Step 2, D-209 and H3 of the plan): no answer of a sale's posting depends on a cost the
// caller cannot see. A member without the costs switch (a Manager with data.cost.view denied, so
// supplier prices and margins go with it) chooses a sale's quantity and price; the cost frozen at
// posting is qty × the recipe's base quantity × the materials' hidden averages. Were the cost columns
// bounded, a posting would fail exactly when that hidden product passed their limit, and a binary
// search of the quantity would read the average out. They are unbounded numeric (with a scale check),
// and their outputs unbounded decimals, so a price of 0 and the largest quantity never fail differently
// from a small one, whatever the materials cost; and the owner, who sees the huge cost, reads it.

let api: SalesApi
let cafe: SaleScope
let today: string
let attacker: Person

beforeAll(async () => {
  api = new SalesApi()
  cafe = await SaleScope.open(api, CAFE)
  today = await cafe.today()
  attacker = await api.person()
  await addMember(api.db, cafe.owner.user, cafe.id, attacker.user, {
    template: 'manager',
    overrides: [{ key: 'data.cost.view', effect: 'deny' }],
  })
}, 60_000)

afterAll(async () => {
  await api.close()
})

describe('posting a sale is no oracle for a hidden average (D-209)', () => {
  it('a price of 0 and the largest quantity answer the same for a cheap and a dear material', async () => {
    const context = ok(await cafe.as<{ visibleCategories: string[] }>(attacker, 'business.context'))
    expect(context.visibleCategories).toEqual([]) // the premise: no costs
    const cheap = await cafe.material()
    const dear = await cafe.material()
    // What the attacker sees is the same: 1 L of each bought today, from a no-invoice purchase.
    await cafe.buy(purchaseInput(today, [line(cheap.id, '1', '0.0001')]))
    await cafe.buy(purchaseInput(today, [line(dear.id, '1', '9999999999999')]))
    const product = async (materialId: string) => {
      const p = await cafe.product({ name: `Probe ${tag()}`, defaultPrice: '0' })
      // About the largest recipe quantity a line takes (its base quantity is numeric(24,6) in ml).
      await cafe.recipe(p.id, [{ id: newId(), materialId, qty: '999999999999', unit: 'l' }])
      return p
    }
    const onCheap = await product(cheap.id)
    const onDear = await product(dear.id)
    const answer = async (productId: string, qty: string) => {
      const draft = await cafe.as<{ data: SaleDto }>(attacker, 'sale.create', {
        id: newId(),
        source: 'single',
        businessDate: today,
        channelId: await cafe.channelId(),
        lines: [item(productId, qty, '0')],
      })
      if (draft.error) return { create: codeOf(draft) }
      const posted = await cafe.as<{ data: SaleDto; meta: { redacted: string[] } }>(
        attacker,
        'sale.post',
        { id: draft.data!.data.id, version: draft.data!.data.version },
      )
      return {
        post: codeOf(posted) ?? 'ok',
        status: posted.data?.data.status,
        total: posted.data?.data.total,
        redacted: posted.data?.meta.redacted,
      }
    }
    const small = await answer(onCheap.id, '1')
    const hugeCheap = await answer(onCheap.id, SALE_LINE_QTY_MAX)
    const hugeDear = await answer(onDear.id, SALE_LINE_QTY_MAX)
    expect(small).toMatchObject({ post: 'ok', status: 'posted', total: '0' })
    expect(hugeCheap).toEqual(small)
    expect(hugeDear).toEqual(small)

    // The owner sees the cost, however large: answered, never an error.
    // The last sale entered (the dear one): the list is newest first.
    const owners = ok(await cafe.run<{ items: { id: string }[] }>('sale.list', { limit: 1 }))
      .items[0]!
    const sale = ok(await cafe.run<{ data: SaleDto }>('sale.get', { id: owners.id })).data
    // About 10^33: beyond any bounded cost column (material_costs.value is numeric(38,12)).
    expect(sale.lines[0]?.cost).toMatch(/^\d{30,}(?:\.\d+)?$/)
  })

  it('a quantity over the cap is refused by its input alone, whatever the product', async () => {
    const p = await cafe.product({ name: `Capped ${tag()}`, defaultPrice: '1' })
    const refused = await cafe.as(attacker, 'sale.create', {
      id: newId(),
      source: 'single',
      businessDate: today,
      channelId: await cafe.channelId(),
      lines: [item(p.id, '1000000000.000001', '0')],
    })
    expect(codeOf(refused)).toBe('validation')
  })
})

import type { PurchaseDto, RunningCostDto } from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ExpenseScope, ExpensesApi, type Envelope } from '../expenses'
import { addMember } from '../helpers'
import { codeOf, line, ok, purchaseInput, type Person } from '../purchasing'
import { WORKSHOP } from '../settings'

// ACCESS REVIEW of the last fixes of M2 Step 8 (D-209, D-210, and D-214, which it led to). The member
// is the one of D-210: a Manager with the costs switch off (a deny override on data.cost.view), who
// keeps running_costs.items.manage and products.recipes.manage. The buyer is a Manager without
// supplier prices (a deny override on data.supplier_price.view), who keeps purchases.documents.manage.

let api: ExpensesApi
let shop: ExpenseScope
let today: string
let member: Person
let buyer: Person

beforeAll(async () => {
  api = new ExpensesApi()
  shop = await ExpenseScope.open(api, WORKSHOP)
  today = await shop.today()
  member = await api.person()
  await addMember(api.db, shop.owner.user, shop.id, member.user, {
    template: 'manager',
    overrides: [{ key: 'data.cost.view', effect: 'deny' }],
  })
  buyer = await api.person()
  await addMember(api.db, shop.owner.user, shop.id, buyer.user, {
    template: 'manager',
    overrides: [{ key: 'data.supplier_price.view', effect: 'deny' }],
  })
}, 60_000)

afterAll(async () => {
  await api.close()
})

describe('D-210: a running cost the member entered, whose amount someone else changed since', () => {
  // D-210's reason: "an update is the whole record, so it replaces an amount the member never read,
  // and a removal takes out one they cannot check". Own-ness was created_by alone, so once the owner
  // corrected the amount of a running cost the member entered, the member (who cannot read the new
  // amount) still replaced it blind or removed it. D-214: it is the member's own only while they
  // wrote it last.
  async function enteredByMemberThenCorrectedByOwner() {
    const category = await shop.category()
    const fields = {
      name: `Internet ${newId().slice(-6)}`,
      categoryId: category.id,
      amount: '300',
      frequency: 'monthly',
      startsOn: today,
      endsOn: null,
      notes: null,
    }
    const id = newId()
    ok(await shop.as<Envelope<RunningCostDto>>(member, 'runningCost.create', { id, ...fields }))
    const current = ok(await shop.run<Envelope<RunningCostDto>>('runningCost.get', { id })).data
    ok(
      await shop.run<Envelope<RunningCostDto>>('runningCost.update', {
        ...fields,
        id,
        version: current.version,
        amount: '12000',
      }),
    )
    // The premise: the member cannot read the amount the owner set.
    const seen = ok(await shop.as<Envelope<RunningCostDto>>(member, 'runningCost.get', { id }))
    expect(seen.data.amount).toBeUndefined()
    return { id, fields, version: seen.data.version }
  }

  it('runningCost.update by the member is FORBIDDEN, and the owner’s amount stays', async () => {
    const { id, fields, version } = await enteredByMemberThenCorrectedByOwner()
    const result = await shop.as(member, 'runningCost.update', {
      ...fields,
      id,
      version,
      amount: '1',
    })
    const after = ok(await shop.run<Envelope<RunningCostDto>>('runningCost.get', { id })).data
    expect({ code: codeOf(result) ?? 'ok', amount: after.amount }).toEqual({
      code: 'forbidden',
      amount: '12000',
    })
  })

  it('runningCost.remove by the member is FORBIDDEN, and it stays', async () => {
    const { id, version } = await enteredByMemberThenCorrectedByOwner()
    const result = await shop.as(member, 'runningCost.remove', { id, version })
    const after = await shop.run<Envelope<RunningCostDto>>('runningCost.get', { id })
    expect({ code: codeOf(result) ?? 'ok', stays: codeOf(after) ?? 'ok' }).toEqual({
      code: 'forbidden',
      stays: 'ok',
    })
  })

  it('one nobody else changed stays the member’s own: saved again and again, then removed', async () => {
    const category = await shop.category()
    const fields = {
      name: `Water ${newId().slice(-6)}`,
      categoryId: category.id,
      amount: '80',
      frequency: 'monthly',
      startsOn: today,
      endsOn: null,
      notes: null,
    }
    const id = newId()
    let version = ok(
      await shop.as<Envelope<RunningCostDto>>(member, 'runningCost.create', { id, ...fields }),
    ).data.version
    for (const amount of ['90', '95']) {
      version = ok(
        await shop.as<Envelope<RunningCostDto>>(member, 'runningCost.update', {
          ...fields,
          id,
          version,
          amount,
        }),
      ).data.version
    }
    const after = ok(await shop.run<Envelope<RunningCostDto>>('runningCost.get', { id })).data
    expect(after.amount).toBe('95')
    ok(await shop.as(member, 'runningCost.remove', { id, version }))
  })
})

describe('D-214: a purchase draft the buyer entered, whose prices someone else saved since', () => {
  // The same gap as D-210's for purchase drafts (D-200): the buyer cannot read the prices of a saved
  // draft, so once the owner saves it with a price of their own, the buyer's whole save would replace
  // it blind, and a discard would take out what they cannot check.
  async function enteredByBuyerThenSavedByOwner() {
    const material = await shop.material()
    const input = purchaseInput(today, [line(material.id, '10', '7')])
    const lineId = (input.lines[0] as { id: string }).id
    const draft = ok(await shop.as<Envelope<PurchaseDto>>(buyer, 'purchase.create', input)).data
    ok(
      await shop.run<Envelope<PurchaseDto>>('purchase.update', {
        ...input,
        id: draft.id,
        version: draft.version,
        lines: [line(material.id, '10', '70', { id: lineId })],
      }),
    )
    // The premise: the buyer reads it with its prices locked.
    const seen = ok(await shop.as<Envelope<PurchaseDto>>(buyer, 'purchase.get', { id: draft.id }))
    expect(seen.meta.redacted.length).toBeGreaterThan(0)
    return { input, lineId, materialId: material.id, id: draft.id, version: seen.data.version }
  }

  async function priceOf(id: string) {
    const [row] = await api.admin<{ unit_price: string }[]>`
      select trim_scale(unit_price)::text as unit_price from app.purchase_lines
       where business_id = ${shop.id} and purchase_id = ${id} and deleted_at is null`
    return row?.unit_price
  }

  it('purchase.update by the buyer is FORBIDDEN, and the owner’s price stays', async () => {
    const { input, lineId, materialId, id, version } = await enteredByBuyerThenSavedByOwner()
    const result = await shop.as(buyer, 'purchase.update', {
      ...input,
      id,
      version,
      lines: [line(materialId, '10', '1', { id: lineId })],
    })
    expect({ code: codeOf(result) ?? 'ok', price: await priceOf(id) }).toEqual({
      code: 'forbidden',
      price: '70',
    })
  })

  it('purchase.discard by the buyer is FORBIDDEN, and it stays', async () => {
    const { id, version } = await enteredByBuyerThenSavedByOwner()
    const result = await shop.as(buyer, 'purchase.discard', { id, version })
    const after = await shop.run<Envelope<PurchaseDto>>('purchase.get', { id })
    expect({ code: codeOf(result) ?? 'ok', stays: codeOf(after) ?? 'ok' }).toEqual({
      code: 'forbidden',
      stays: 'ok',
    })
  })

  it('one nobody else saved stays the buyer’s own: saved again and again, then discarded', async () => {
    const material = await shop.material()
    const input = purchaseInput(today, [line(material.id, '10', '7')])
    const lineId = (input.lines[0] as { id: string }).id
    let version = ok(await shop.as<Envelope<PurchaseDto>>(buyer, 'purchase.create', input)).data
      .version
    for (const price of ['8', '9']) {
      version = ok(
        await shop.as<Envelope<PurchaseDto>>(buyer, 'purchase.update', {
          ...input,
          version,
          lines: [line(material.id, '10', price, { id: lineId })],
        }),
      ).data.version
    }
    expect(await priceOf(input.id)).toBe('9')
    ok(await shop.as(buyer, 'purchase.discard', { id: input.id, version }))
  })
})

describe('D-209: a too-large recipe saved by a member without costs', () => {
  // The member's save now stands where the owner's would be refused. What the owner then reads of
  // that product must still work (it says the cost is too large, as after a price rise).
  it('the owner’s Product costs, the product’s cost, its recipe and the checklist still answer', async () => {
    const material = await shop.material()
    await shop.buy(purchaseInput(today, [line(material.id, '10', '7.26')]))
    const product = ok(
      await shop.as<{ id: string }>(member, 'product.create', {
        id: newId(),
        name: `Probe ${newId().slice(-8)}`,
        type: 'product',
        unit: 'piece',
        defaultPrice: '10',
      }),
    )
    ok(
      await shop.as(member, 'recipe.save', {
        productId: product.id,
        version: 0,
        yieldQty: '0.000001',
        lines: [{ id: newId(), materialId: material.id, qty: '1378000000', unit: 'l' }],
      }),
    )
    const recipe = ok(
      await shop.run<Envelope<{ cost: { tooLarge: boolean } }>>('recipe.get', {
        productId: product.id,
      }),
    )
    expect(recipe.data.cost.tooLarge).toBe(true)
    ok(await shop.run('product.costs', { ids: [product.id] }))
    ok(await shop.run('productCost.get', { productId: product.id }))
    for (const sort of ['name', 'cost', 'margin', 'margin_percent']) {
      ok(await shop.run('productCost.list', { sort }))
    }
    ok(await shop.run('productCost.list', { filter: 'incomplete' }))
    ok(await shop.run('dashboard.checklist'))
  })
})

import type { MaterialCostsDto, PurchaseDto, PurchaseReturnDto } from '@bizcost/contracts'
import { compareDecimal, newId, proportionOf, subtractDecimals, sumDecimals } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addMember } from './helpers'
import { line, ok, purchaseInput, PurchasingApi, Scope, type Person } from './purchasing'
import { WORKSHOP } from './settings'

// Security review of M2 Step 3, attacker B (cost and supplier-price confidentiality).
//
// A member who may see costs but not supplier prices (a Manager with a deny override on
// data.supplier_price.view, or any role saved through role.updatePermissions with data.cost.view and
// without data.supplier_price.view) must not read what a purchase paid: D-140 tags every price and
// amount of a purchase, and what its goods cost, `supplier_price`, and rejects `cost` on purchase lines
// "because a member who may see costs but not supplier prices would read them". The accepted residue
// is only "with a single purchase in its window, a material's average equals that purchase's price
// (but not the supplier)".
//
// The average (`cost`, visible) is Σ value ÷ Σ base quantity of the receipts that still stand, and
// every receipt's base quantity is visible (purchase.get lines.*.baseQty). So:
//   - passively: the average read before and after a posting gives the new receipt's value exactly
//     (value = avg_after × Q_after − avg_before × Q_before), whatever else is in the window;
//   - actively (the Manager may post and reverse returns, which take quantities): returning all of the
//     other receipts leaves one, so the average is its price; reversing the return puts things back.
// And material.costs names the purchase (lastPurchase.purchaseId), whose supplier purchase.get shows.
//
// Fixed by D-144: costs and supplier prices are visible only together (SENSITIVITY_REQUIRES), so such a
// member sees no average either, and every step of both attacks finds it hidden. The owner's view of
// the same moments shows what the member would have read.

let api: PurchasingApi
let a: Scope
let today: string
/** Granted costs, not supplier prices (since D-144 the grouping rule hides costs from it too). */
let costOnly: Person

beforeAll(async () => {
  api = new PurchasingApi()
  a = await Scope.open(api, WORKSHOP)
  today = await a.today()
  costOnly = await api.person()
  await addMember(api.db, a.owner.user, a.id, costOnly.user, {
    template: 'manager',
    overrides: [{ key: 'data.supplier_price.view', effect: 'deny' }],
  })
}, 60_000)

afterAll(async () => {
  await api.close()
})

type Envelope<T> = { data: T; meta: { redacted: string[] } }

async function costsAs(person: Person, materialId: string) {
  const got = ok(await a.as<MaterialCostsDto>(person, 'material.costs', { ids: [materialId] }))
  return { item: got.data.items[0]!, redacted: got.meta.redacted }
}

async function purchaseAs(person: Person, id: string) {
  return ok(await a.as<Envelope<PurchaseDto>>(person, 'purchase.get', { id }))
}

/** The average as the owner reads it. */
async function ownersAverage(materialId: string) {
  const got = ok(await a.run<MaterialCostsDto>('material.costs', { ids: [materialId] }))
  return got.data.items[0]!.average!
}

/** value = avg × qty, to 12 decimals. */
const valueOf = (avg: string, qty: string) => proportionOf(avg, qty, '1', 12)

/** The average's fields, hidden from members who may not see costs. */
const AVERAGE_FIELDS = ['items.*.average.perUnit', 'items.*.average.perBaseUnit']

/** What the attacks need of the average: absent from what the member reads. */
function expectNoAverage(seen: Awaited<ReturnType<typeof costsAs>>) {
  expect(seen.redacted).toEqual(expect.arrayContaining(AVERAGE_FIELDS))
  expect(seen.item.average?.perUnit).toBeUndefined()
  expect(seen.item.average?.perBaseUnit).toBeUndefined()
}

describe('a member who sees costs but not supplier prices reads the prices paid', () => {
  it('the member really may not see the prices (the premise), nor, since D-144, the costs', async () => {
    const context = ok(
      await a.as<{ permissions: { keys: string[] }; visibleCategories: string[] }>(
        costOnly,
        'business.context',
      ),
    )
    expect(context.permissions.keys).toContain('data.cost.view')
    expect(context.permissions.keys).not.toContain('data.supplier_price.view')
    expect(context.visibleCategories).toEqual([])
    const milk = await a.material()
    const supplier = await a.supplier()
    const bought = await a.buy(
      purchaseInput(today, [line(milk.id, '10', '71.43')], { supplierId: supplier.id }),
    )
    const got = await purchaseAs(costOnly, bought.id)
    expect(got.meta.redacted).toEqual(
      expect.arrayContaining(['lines.*.unitPrice', 'lines.*.cost', 'total']),
    )
    expect(got.data.lines[0]?.unitPrice).toBeUndefined()
    expect(got.data.lines[0]?.cost).toBeUndefined()
    const costs = await costsAs(costOnly, milk.id)
    expect(costs.redacted).toContain('items.*.lastPurchase.pricePerUnit')
    expect(costs.item.lastPurchase?.pricePerUnit).toBeUndefined()
    expectNoAverage(costs)
    expect((await ownersAverage(milk.id)).perUnit).toBeDefined()
  })

  it('passively: the average before and after a posting gives that purchase’s hidden cost', async () => {
    const milk = await a.material()
    const first = await a.supplier()
    const second = await a.supplier()
    const p1 = await a.buy(
      purchaseInput(today, [line(milk.id, '10', '71.43')], { supplierId: first.id }),
    )
    // What the member reads while the Materials list is open: the average and each purchase's
    // quantity in base units.
    const before = await costsAs(costOnly, milk.id)
    const ownersBefore = await ownersAverage(milk.id)
    const q1 = (await purchaseAs(costOnly, p1.id)).data.lines[0]!.baseQty!

    const p2 = await a.buy(
      purchaseInput(today, [line(milk.id, '4', '88.17')], { supplierId: second.id }),
    )
    const after = await costsAs(costOnly, milk.id)
    const ownersAfter = await ownersAverage(milk.id)
    const seen = await purchaseAs(costOnly, after.item.lastPurchase!.purchaseId)
    const q2 = seen.data.lines[0]!.baseQty!
    expect(after.item.average?.basis).toBe('purchases_90_days')
    expect(after.item.lastPurchase?.purchaseId).toBe(p2.id)

    // Two purchases stand in the window (not the accepted "single purchase" residue of D-140). With
    // the averages (the owner's view), the quantities give p2's hidden cost exactly; the member has
    // the quantities but neither average.
    const derived = proportionOf(
      subtractDecimals(
        valueOf(ownersAfter.perBaseUnit!, sumDecimals([q1, q2])),
        valueOf(ownersBefore.perBaseUnit!, q1),
      ),
      '1',
      '1',
      2,
    )
    expect(compareDecimal(derived, p2.lines[0]!.cost!)).toBe(0)
    expectNoAverage(before)
    expectNoAverage(after)
  })

  it('actively: returning the other receipts and reversing the return isolates any price', async () => {
    const milk = await a.material()
    const first = await a.supplier()
    const second = await a.supplier()
    const p1 = await a.buy(
      purchaseInput(today, [line(milk.id, '10', '71.43')], { supplierId: first.id }),
    )
    const p2 = await a.buy(
      purchaseInput(today, [line(milk.id, '4', '88.17')], { supplierId: second.id }),
    )
    // The blended average (two purchases in the window) is not either price.
    const blended = await costsAs(costOnly, milk.id)
    expectNoAverage(blended)

    // The member sends back all of p1 (a quantity: allowed without supplier prices) and posts it.
    const seenP1 = (await purchaseAs(costOnly, p1.id)).data
    const back = ok(
      await a.as<Envelope<PurchaseReturnDto>>(costOnly, 'purchaseReturn.create', {
        id: newId(),
        purchaseId: p1.id,
        kind: 'return',
        businessDate: today,
        lines: [{ id: newId(), purchaseLineId: seenP1.lines[0]!.id, qty: seenP1.lines[0]!.qty }],
      }),
    ).data
    ok(await a.as(costOnly, 'purchaseReturn.post', { id: back.id, version: back.version }))
    const isolated = await costsAs(costOnly, milk.id)
    // What the member would have read (the owner's view): p2's hidden price alone.
    expect(compareDecimal((await ownersAverage(milk.id)).perUnit!, p2.lines[0]!.unitPrice!)).toBe(0)
    // ... and puts everything back as it was.
    ok(await a.as(costOnly, 'purchaseReturn.reverse', { id: back.id }))
    const restored = await costsAs(costOnly, milk.id)
    expect(restored.item.average?.perUnit).toBe(blended.item.average?.perUnit)

    expectNoAverage(isolated)
    expectNoAverage(restored)
  })
})

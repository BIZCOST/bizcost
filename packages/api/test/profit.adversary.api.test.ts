import type {
  DashboardCardsDto,
  LocationDto,
  MemberLocationsDto,
  ProductCostBreakdownDto,
} from '@bizcost/contracts'
import { addMonths, newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addMember, handlerFor, SECRET_KEY } from './helpers'
import { tag } from './product-costs'
import { dayOf, lastOf, ProfitApi, ProfitScope } from './profit'
import { ok, purchaseInput, type Person } from './purchasing'
import { bought, CAFE, CAFE_BRANCHES, item } from './sales'
import { WORKSHOP } from './settings'

// The security review of M3 Step 3 (real profit on read): values withheld from a member must not be
// derivable from what the same member is shown (ARCHITECTURE.md §Redaction, D-209), a member limited
// to some branches sees only their branches (D-231, D-237), and a released business sees no change
// before Release A (the plan's D3). Each test states the derivation it closes.

let api: ProfitApi

beforeAll(() => {
  api = new ProfitApi()
})

afterAll(async () => {
  await api.close()
})

/** The café of the branch test: 1,000 a month of running costs, 3,000 sold at the main shop and
 * 1,000 at Marina last month (business-wide item sales 4,000, rate 25 %), and its Manager limited to
 * Marina. */
async function cafeWithBranch() {
  const cafe = await ProfitScope.open(api, CAFE_BRANCHES)
  const { last } = await cafe.months()
  await cafe.monthly('1000', dayOf(addMonths(last, -2), 1))
  const branch = ok(
    await cafe.run<LocationDto>('location.create', { id: newId(), name: `Marina ${tag()}` }),
  )
  const service = await cafe.service('100')
  const channel = await cafe.channelId()
  await cafe.sell({
    businessDate: dayOf(last, 1),
    channelId: channel,
    lines: [item(service.id, '30', '100')],
  })
  await cafe.sell({
    businessDate: dayOf(last, 2),
    channelId: channel,
    locationId: branch.id,
    lines: [item(service.id, '10', '100')],
  })
  const manager = await api.member(cafe, 'manager')
  const scope = ok(
    await cafe.run<MemberLocationsDto>('member.locations', { memberId: manager.memberId }),
  )
  ok(
    await cafe.run('member.updateLocations', {
      memberId: manager.memberId,
      version: scope.version,
      locationIds: [branch.id],
    }),
  )
  return { cafe, last, branch, service, channel, manager }
}

async function breakdownAs(cafe: ProfitScope, person: Person, productId: string) {
  return ok(await cafe.as<ProductCostBreakdownDto>(person, 'productCost.get', { productId })).data
}

describe('the item sales behind the rate go with the costs it divides (D-250)', () => {
  // The review found Product costs withholding `monthCosts.sales` while showing `total` and `rate`:
  // costs ÷ rate gave the sales anyway, and the costs are on the running-cost and expense pages of
  // whoever reads them, the rate any share ÷ its price (D-203). D-250 accepts that residue (as Q11's
  // rate × sales = costs): the sales go with the costs. What stays withheld is withheld for real: a
  // member who does not see the month's costs gets neither, so nothing divides into the sales.

  it('a Manager limited to one branch who sees the month’s costs reads the sales behind them, consistently', async () => {
    const { cafe, last, service, manager } = await cafeWithBranch()
    // profit.summary gives them the rate, without the business-wide costs and sales behind it (D-237).
    const summary = await cafe.summary({ from: dayOf(last, 1), to: lastOf(last) }, manager)
    expect(summary.months[0]).toMatchObject({ rate: '0.25', rateCosts: null, rateSales: null })
    expect(summary.total.sales).toBe('1000')
    // Product costs show the costs they divide (running costs and expenses are theirs to read) and
    // so the sales with them: 1,000 ÷ 0.25 = 4,000, said rather than claimed withheld.
    const theirs = await breakdownAs(cafe, manager, service.id)
    expect(theirs.monthCosts).toMatchObject({ total: '1000', rate: '0.25', sales: '4000' })
  })

  it('a Manager limited to one branch without running costs gets neither the costs nor the sales', async () => {
    const { cafe, last, branch, service } = await cafeWithBranch()
    const person = await api.person()
    const { memberId } = await addMember(api.db, cafe.owner.user, cafe.id, person.user, {
      template: 'manager',
      overrides: [{ key: 'running_costs.items.view', effect: 'deny' }],
    })
    const scope = ok(await cafe.run<MemberLocationsDto>('member.locations', { memberId }))
    ok(
      await cafe.run('member.updateLocations', {
        memberId,
        version: scope.version,
        locationIds: [branch.id],
      }),
    )
    const summary = await cafe.summary({ from: dayOf(last, 1), to: lastOf(last) }, person)
    expect(summary.months[0]).toMatchObject({ rate: '0.25', rateCosts: null, rateSales: null })
    expect(summary.total.monthCosts).toBeNull()
    const theirs = await breakdownAs(cafe, person, service.id)
    expect(theirs.monthCosts).toMatchObject({ rate: '0.25', total: null, sales: null })
    const raw = JSON.stringify(theirs)
    expect(raw).not.toContain('4000')
  })

  it('a member who does not see every sale (H1) but sees the month’s costs reads the sales behind them', async () => {
    const shop = await ProfitScope.open(api, CAFE)
    const { last } = await shop.months()
    await shop.monthly('1234.56', dayOf(addMonths(last, -2), 1))
    const service = await shop.service('1')
    await shop.sell({
      businessDate: dayOf(last, 1),
      channelId: await shop.channelId(),
      lines: [item(service.id, '9876', '1')],
    })
    // An Accountant kept from "see every sale": no sales totals (H1), so no Reports either (D-190).
    const person = await api.person()
    await addMember(api.db, shop.owner.user, shop.id, person.user, {
      template: 'accountant',
      overrides: [{ key: 'sales.documents.view', effect: 'deny' }],
    })
    const report = await shop.as(person, 'profit.summary', {
      from: dayOf(last, 1),
      to: lastOf(last),
    })
    expect(report.raw).not.toContain('9876')
    const theirs = await breakdownAs(shop, person, service.id)
    expect(theirs.monthCosts).toMatchObject({ total: '1234.56', sales: '9876' })
    // Without the expenses they would add the costs up from, neither shows.
    const other = await api.person()
    await addMember(api.db, shop.owner.user, shop.id, other.user, {
      template: 'accountant',
      overrides: [
        { key: 'sales.documents.view', effect: 'deny' },
        { key: 'expenses.documents.view', effect: 'deny' },
      ],
    })
    const hidden = await breakdownAs(shop, other, service.id)
    expect(hidden.monthCosts).toMatchObject({ total: null, sales: null })
    expect(JSON.stringify(hidden)).not.toContain('9876')
  })
})

describe('a member limited to some branches sees only their branches (D-231) on the cards', () => {
  it('"Needs a look" does not name a material only another branch’s sale used', async () => {
    const { cafe, branch, service, channel, manager } = await cafeWithBranch()
    const today = await cafe.today()
    // Their branch sold this month, so their cards show.
    await cafe.sell({
      businessDate: today,
      channelId: channel,
      locationId: branch.id,
      lines: [item(service.id, '1', '100')],
    })
    // The main shop (not theirs) sold a product made of a material with no price yet.
    const saffron = await cafe.newMaterial({ name: `Saffron ${tag()}`, unit: 'piece' })
    const dish = await cafe.madeOf(saffron, '50')
    await cafe.sell({ businessDate: today, channelId: channel, lines: [item(dish.id, '1', '50')] })
    const owners = await cafe.cards()
    expect(owners.needsLook?.unpricedMaterials.map((m) => m.id)).toContain(saffron.id)
    const theirs = ok(await cafe.as<DashboardCardsDto>(manager, 'dashboard.cards')).data
    expect(theirs.profitShown).toBe(true)
    expect(theirs.needsLook?.unpricedMaterials.map((m) => m.id) ?? []).not.toContain(saffron.id)
  })
})

describe('a released business sees no change before Release A (the plan’s D3)', () => {
  it('Product costs’ month’s costs do not start counting materials no product uses (Q13 A) without the preview', async () => {
    const shop = await ProfitScope.open(api, WORKSHOP)
    const { last } = await shop.months()
    await shop.monthly('1000', dayOf(addMonths(last, -2), 1))
    const work = await shop.service('100')
    // Bought last month, in no recipe: in M2 it never counted in the month's costs.
    const gypsum = await shop.newMaterial({ name: `Gypsum ${tag()}`, unit: 'piece' })
    await shop.buy(
      purchaseInput(dayOf(last, 6), [bought(gypsum.id, '10', '40', { unit: 'piece' })]),
    )
    const released = handlerFor(api.db, undefined, { supabaseSecretKey: SECRET_KEY })
    const breakdown = ok(
      await api.call<ProductCostBreakdownDto>(
        shop.owner,
        shop.id,
        'productCost.get',
        { productId: work.id },
        released,
      ),
    ).data
    expect(breakdown.monthCosts).toMatchObject({ state: 'awaiting_sales', month: last })
    // As on main before Step 3: the running costs only, no materials list.
    expect(breakdown.monthCosts.total).toBe('1000')
    expect(breakdown.monthCosts.materials ?? null).toBeNull()
  })
})

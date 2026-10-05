import type { ProductCostBreakdownDto, ProfitSummaryDto } from '@bizcost/contracts'
import { addMonths } from '@bizcost/domain'
import { ROLE_TEMPLATE_KEYS, type RoleTemplateKey } from '@bizcost/modules'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addMember } from './helpers'
import { dayOf, lastOf, ProfitApi, ProfitScope } from './profit'
import { codeOf, ok, type Person } from './purchasing'
import { CAFE, item } from './sales'

// Who sees real profit (ROADMAP.md M3 Step 3; Q10, Q11 of D-218; H1, H2; D-190): the sales figures
// with "see Real profit" (Owner, Admin, Manager, Accountant, Sales, Supervisor: those who see every
// sale), profit and every cost (materials, fees, delivery, running costs, the owner's time, the rates,
// the month's costs, the completeness note) only with "See profit reports", which grants nothing
// without the costs switch and Product costs. Withheld in the service (null), not only redacted. A
// custom role with profit reports but without running costs sees the month's running-cost total,
// never its categories (Q11 A). Sorting or showing by a hidden value is FORBIDDEN.

let api: ProfitApi
let cafe: ProfitScope
let last: string
let serviceId: string
const members = new Map<RoleTemplateKey, Person>()

/** Distinctive amounts: a hidden one must never be in an answer. */
const RUNNING = '1234.56'
const SOLD = '9876'

beforeAll(async () => {
  api = new ProfitApi()
  cafe = await ProfitScope.open(api, CAFE)
  ;({ last } = await cafe.months())
  await cafe.monthly(RUNNING, dayOf(addMonths(last, -2), 1))
  const service = await cafe.service('1')
  serviceId = service.id
  await cafe.sell({
    businessDate: dayOf(last, 1),
    channelId: await cafe.channelId(),
    lines: [item(service.id, SOLD, '1')],
  })
  for (const template of ROLE_TEMPLATE_KEYS) {
    if (template === 'owner') continue
    members.set(template, await api.member(cafe, template))
  }
  members.set('owner', cafe.owner)
}, 180_000)

afterAll(async () => {
  await api.close()
})

const input = () => ({ from: dayOf(last, 1), to: lastOf(last) })

describe('profit.summary for each template (Q10)', () => {
  it('Owner, Admin, Manager and Accountant see the profit and the month’s costs', async () => {
    for (const template of ['owner', 'admin', 'manager', 'accountant'] as const) {
      const summary = await cafe.summary(input(), members.get(template)!)
      expect(summary.profitShown, template).toBe(true)
      expect(summary.total, template).toMatchObject({
        sales: SOLD,
        monthCosts: RUNNING,
        profit: '8641.44',
      })
      expect(summary.months[0]?.rateCosts, template).toBe(RUNNING)
    }
  })

  it('Sales and Supervisor see the sales figures only: every cost and profit withheld', async () => {
    for (const template of ['sales', 'supervisor'] as const) {
      const result = await cafe.as<ProfitSummaryDto>(
        members.get(template)!,
        'profit.summary',
        input(),
      )
      const summary = ok(result).data
      expect(summary.profitShown, template).toBe(false)
      expect(summary.total.sales, template).toBe(SOLD)
      for (const field of ['materials', 'fees', 'runningCosts', 'monthCosts', 'profit'] as const) {
        expect(summary.total[field] ?? null, `${template} ${field}`).toBeNull()
      }
      expect(summary.months[0]?.rate ?? null, template).toBeNull()
      expect(summary.completeness ?? null, template).toBeNull()
      expect(result.raw, template).not.toContain(RUNNING)
      expect(result.raw, template).not.toContain('8641.44')
      // Sorting or showing by profit: FORBIDDEN.
      for (const extra of [{ sort: 'profit' }, { sort: 'margin_percent' }, { show: 'loss' }]) {
        const refused = await cafe.as(members.get(template)!, 'profit.summary', {
          ...input(),
          ...extra,
        })
        expect(codeOf(refused), `${template} ${JSON.stringify(extra)}`).toBe('forbidden')
      }
    }
  })

  it('the Employee is refused (FORBIDDEN): they see neither every sale nor profit', async () => {
    const result = await cafe.as(members.get('employee')!, 'profit.summary', input())
    expect(codeOf(result)).toBe('forbidden')
    expect(result.raw).not.toContain(SOLD)
  })
})

describe('a key missing what it needs grants nothing (D-190)', () => {
  it('a Supervisor allowed "See profit reports" without the costs switch still sees no profit', async () => {
    const person = await api.person()
    await addMember(api.db, cafe.owner.user, cafe.id, person.user, {
      template: 'supervisor',
      overrides: [{ key: 'reports.profit.view', effect: 'allow' }],
    })
    const summary = await cafe.summary(input(), person)
    expect(summary.profitShown).toBe(false)
    expect(summary.total.profit ?? null).toBeNull()
  })
})

describe('profit reports without running costs (Q11 A)', () => {
  it('the month’s running-cost total shows, never its categories', async () => {
    const person = await api.person()
    await addMember(api.db, cafe.owner.user, cafe.id, person.user, {
      template: 'accountant',
      overrides: [{ key: 'running_costs.items.view', effect: 'deny' }],
    })
    const summary = await cafe.summary(input(), person)
    expect(summary.profitShown).toBe(true)
    expect(summary.total.monthCosts).toBe(RUNNING)
    expect(summary.months[0]).toMatchObject({ rateCosts: RUNNING, costs: RUNNING })
    // Product costs: the share and its rate (any share ÷ its price), but neither the categories nor
    // the total of the month's costs (they stay with running costs and expenses, D-202).
    const breakdown = ok(
      await cafe.as<ProductCostBreakdownDto>(person, 'productCost.get', { productId: serviceId }),
    ).data
    expect(breakdown.cost.runningCosts.state).toBe('applied')
    expect(breakdown.monthCosts).toMatchObject({
      amountsShown: false,
      total: null,
      categories: null,
      sales: null,
    })
  })
})

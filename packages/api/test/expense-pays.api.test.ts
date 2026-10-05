import type {
  AppErrorCode,
  CostCategoryDto,
  ExpenseDto,
  ExpenseListDto,
  ExpensePaysInput,
  MineExpenseListDto,
  MineExpenseResultDto,
  PayableRunningCostsDto,
  ProductCostListDto,
  RunningCostDto,
} from '@bizcost/contracts'
import { addMonths, monthOf, newId } from '@bizcost/domain'
import { ROLE_TEMPLATE_KEYS, type RoleTemplateKey } from '@bizcost/modules'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { billOf, EXTRA, ExpenseScope, ExpensesApi, type Envelope } from './expenses'
import { addMember } from './helpers'
import { codeOf, ok, type Person } from './purchasing'
import { WORKSHOP } from './settings'

// What an expense pays (the owner's decision of 2026-10-01, "1أ", D-216), through the real fetch
// handler: an expense in a category that has running costs says which one it pays («فاتورة لـ…»: it
// takes the place of that running cost's regular amount alone) or that it is an extra («مصروف
// إضافي»: it counts on top). The running costs it can pay, by name only (expense.payableRunningCosts);
// what is checked when it is saved, approved and finalized; the finalize requirement
// (RUNNING_COST_CHOICE_REQUIRED) and who says it when the one who entered it may not see running
// costs (the approver or the one who finalizes); a correction and a reversal keep it; who sees the
// running cost's name (never its amount); the month's costs per running cost with what is inside each
// category; another business's running cost; the audit log.

let api: ExpensesApi
let shop: ExpenseScope
let other: ExpenseScope
let today: string
let month: string
let lastMonth: string
const members = new Map<RoleTemplateKey, Person & { memberId: string }>()
const cat = {} as Record<'power' | 'salaries' | 'rent' | 'ads' | 'licence', CostCategoryDto>
const run = {} as Record<
  'power' | 'salaries' | 'shop' | 'warehouse' | 'licence' | 'later',
  RunningCostDto
>
let theirs: RunningCostDto
let theirCategory: CostCategoryDto

/** Distinctive regular amounts: none may ever be in an answer about what an expense pays. */
const AMOUNTS = {
  power: '3011.17',
  salaries: '16023.41',
  shop: '12037.59',
  warehouse: '30041.83',
  licence: '15053.29',
  later: '777.61',
} as const

/** The first day of `month` + `months`. */
const firstOf = (from: string, months: number) => `${addMonths(from, months)}-01`

beforeAll(async () => {
  api = new ExpensesApi()
  shop = await ExpenseScope.open(api, WORKSHOP)
  other = await ExpenseScope.open(api, WORKSHOP)
  today = await shop.today()
  month = monthOf(today)
  lastMonth = addMonths(month, -1)
  for (const template of ROLE_TEMPLATE_KEYS) {
    if (template !== 'owner') members.set(template, await api.member(shop, template))
  }
  const names = { power: 'Power', salaries: 'Pay', rent: 'Premises', ads: 'Ads', licence: 'Permit' }
  for (const [key, name] of Object.entries(names)) {
    cat[key as keyof typeof cat] = await shop.category(`${name} ${newId().slice(-6)}`)
  }
  const since = firstOf(month, -6)
  const cost = async (key: keyof typeof run, name: string, categoryId: string, extra = {}) => {
    run[key] = await shop.runningCost({
      id: newId(),
      name,
      categoryId,
      amount: AMOUNTS[key],
      startsOn: since,
      ...extra,
    })
  }
  await cost('power', 'DEWA', cat.power.id)
  await cost('salaries', 'Staff salaries', cat.salaries.id)
  await cost('shop', 'Shop rent', cat.rent.id)
  await cost('warehouse', 'Warehouse rent', cat.rent.id, { frequency: 'quarterly' })
  await cost('licence', 'Trade licence', cat.licence.id, { frequency: 'yearly' })
  // In the rent's category, from next month: nothing a bill of this month can pay.
  await cost('later', 'New store rent', cat.rent.id, { startsOn: firstOf(month, 1) })
  theirCategory = (await other.categories()).find((c) => c.name === 'Rent')!
  theirs = await other.runningCost({
    id: newId(),
    name: 'Their rent',
    categoryId: theirCategory.id,
    amount: '999.99',
    startsOn: since,
  })
}, 120_000)

afterAll(async () => {
  await api.close()
})

const member = (template: RoleTemplateKey) => members.get(template)!
const as = <T>(template: RoleTemplateKey, path: string, input?: unknown) =>
  template === 'owner' ? shop.run<T>(path, input) : shop.as<T>(member(template), path, input)

/** A draft of 100 in `category` for this month, as `template` (the owner by default). */
async function draft(
  category: CostCategoryDto,
  extra: object = {},
  template: RoleTemplateKey = 'owner',
): Promise<ExpenseDto> {
  const input = shop.expenseInput(category.id, today, { periodMonth: month, ...extra })
  return ok(await as<Envelope<ExpenseDto>>(template, 'expense.create', input)).data
}

/** The fields of an update of `expense` as it is (an update is the whole draft). */
function wholeDraft(expense: ExpenseDto, change: object = {}) {
  return {
    id: expense.id,
    version: expense.version,
    categoryId: expense.categoryId,
    businessDate: expense.businessDate,
    periodMonth: expense.periodMonth,
    documentType: expense.documentType,
    paymentMethod: expense.paymentMethod,
    amount: '100',
    vatRate: '5',
    ...change,
  }
}

const expectNoAmount = (raw: string) => {
  for (const amount of Object.values(AMOUNTS)) expect(raw, amount).not.toContain(amount)
}

// ---------------------------------------------------------------------------------------------------

describe('the running costs an expense can pay (expense.payableRunningCosts)', () => {
  it('by name, with when each counts and what a bill of each pays for: never an amount', async () => {
    const result = await shop.run<PayableRunningCostsDto>('expense.payableRunningCosts', {
      categoryId: cat.rent.id,
      periodMonth: month,
    })
    const { items } = ok(result)
    // The warehouse's quarter holds this month, counted from the month it started.
    const quarterFrom = addMonths(monthOf(firstOf(month, -6)), 6 - (6 % 3))
    expect(items).toEqual([
      {
        id: run.shop.id,
        name: 'Shop rent',
        frequency: 'monthly',
        startsOn: firstOf(month, -6),
        endsOn: null,
        period: { from: month, to: month, months: 1 },
      },
      {
        id: run.warehouse.id,
        name: 'Warehouse rent',
        frequency: 'quarterly',
        startsOn: firstOf(month, -6),
        endsOn: null,
        period: { from: quarterFrom, to: addMonths(quarterFrom, 2), months: 3 },
      },
    ])
    expectNoAmount(result.raw)
    // Next month the new store's rent can be paid too.
    const next = ok(
      await shop.run<PayableRunningCostsDto>('expense.payableRunningCosts', {
        categoryId: cat.rent.id,
        periodMonth: addMonths(month, 1),
      }),
    ).items.map((r) => r.name)
    expect(next).toEqual(['New store rent', 'Shop rent', 'Warehouse rent'])
  })

  it('none in a category without running costs, nor before they started', async () => {
    for (const [category, periodMonth] of [
      [cat.ads, month],
      [cat.power, addMonths(month, -7)],
    ] as const) {
      expect(
        ok(
          await shop.run<PayableRunningCostsDto>('expense.payableRunningCosts', {
            categoryId: category.id,
            periodMonth,
          }),
        ).items,
      ).toEqual([])
    }
  })

  it('only to who may see running costs and expenses; another business’s category is NOT_FOUND', async () => {
    const input = { categoryId: cat.power.id, periodMonth: month }
    const expected: Record<RoleTemplateKey, AppErrorCode | 'ok'> = {
      owner: 'ok',
      admin: 'ok',
      manager: 'ok',
      accountant: 'ok',
      supervisor: 'forbidden',
      sales: 'forbidden',
      employee: 'forbidden',
    }
    for (const template of ROLE_TEMPLATE_KEYS) {
      const result = await as<PayableRunningCostsDto>(
        template,
        'expense.payableRunningCosts',
        input,
      )
      expect(codeOf(result) ?? 'ok', template).toBe(expected[template])
      expectNoAmount(result.raw)
      if (!result.error)
        expect(
          result.data?.items.map((r) => r.name),
          template,
        ).toEqual(['DEWA'])
    }
    const foreign = await shop.run('expense.payableRunningCosts', {
      categoryId: theirCategory.id,
      periodMonth: month,
    })
    expect(codeOf(foreign)).toBe('not_found')
    expect(foreign.raw).not.toContain('Their rent')
  })
})

describe('saying it on a draft', () => {
  it('the bill of a running cost of its category, or an extra; shown by name to the owner', async () => {
    const bill = await draft(cat.power, { pays: billOf(run.power) })
    expect(bill.pays).toEqual({
      kind: 'running_cost',
      runningCost: { id: run.power.id, name: 'DEWA' },
      channel: null,
    })
    const bonus = await draft(cat.salaries, { pays: EXTRA })
    expect(bonus.pays).toEqual({ kind: 'extra', runningCost: null, channel: null })
    // Nothing said: it can wait until it is finalized.
    expect((await draft(cat.power)).pays).toBeNull()
  })

  it('refuses what does not fit: an extra without running costs, another category’s, another month’s, unknown', async () => {
    const refused = async (category: CostCategoryDto, pays: object, extra: object = {}) =>
      codeOf(
        await shop.run(
          'expense.create',
          shop.expenseInput(category.id, today, { periodMonth: month, pays, ...extra }),
        ),
      )
    expect(await refused(cat.ads, EXTRA)).toBe('validation')
    expect(await refused(cat.power, billOf(run.shop))).toBe('validation')
    expect(await refused(cat.rent, billOf(run.later))).toBe('validation')
    expect(await refused(cat.power, billOf(run.power), { periodMonth: addMonths(month, -7) })).toBe(
      'validation',
    )
    expect(await refused(cat.power, billOf({ id: newId() }))).toBe('not_found')
    // Another business's running cost is not there at all.
    expect(await refused(cat.power, billOf(theirs))).toBe('not_found')
    // A removed running cost is not paid any more.
    const gone = await shop.runningCost({
      id: newId(),
      name: 'Removed',
      categoryId: cat.ads.id,
      amount: '10',
      startsOn: firstOf(month, -1),
    })
    ok(await shop.run('runningCost.remove', { id: gone.id, version: gone.version }))
    expect(await refused(cat.ads, billOf(gone))).toBe('not_found')
  })

  it('an update keeps it while it fits; a new category or month that it no longer fits says nothing', async () => {
    const bill = await draft(cat.power, { pays: billOf(run.power) })
    const kept = ok(
      await shop.run<Envelope<ExpenseDto>>('expense.update', wholeDraft(bill, { reference: 'X' })),
    ).data
    expect(kept.pays?.runningCost?.id).toBe(run.power.id)
    const moved = ok(
      await shop.run<Envelope<ExpenseDto>>(
        'expense.update',
        wholeDraft(kept, { categoryId: cat.ads.id }),
      ),
    ).data
    expect(moved.pays).toBeNull()
    const extra = await draft(cat.salaries, { pays: EXTRA })
    const earlier = ok(
      await shop.run<Envelope<ExpenseDto>>(
        'expense.update',
        wholeDraft(extra, { periodMonth: addMonths(month, -7), businessDate: today }),
      ),
    ).data
    expect(earlier.pays).toBeNull()
    // Null clears it.
    const cleared = ok(
      await shop.run<Envelope<ExpenseDto>>(
        'expense.update',
        wholeDraft(await draft(cat.power, { pays: EXTRA }), { pays: null }),
      ),
    ).data
    expect(cleared.pays).toBeNull()
  })

  it('a member who may not see running costs never says it (FORBIDDEN, even null), and keeps what was said', async () => {
    for (const pays of [EXTRA, billOf(run.power), null]) {
      const input = shop.expenseInput(cat.power.id, today, { periodMonth: month, pays })
      expect(codeOf(await as('employee', 'expense.create', input)), JSON.stringify(pays)).toBe(
        'forbidden',
      )
    }
    const own = await draft(cat.power, {}, 'employee')
    expect(own.pays).toBeNull()
    // The owner says it on the employee's draft; the employee's own save keeps it.
    const said = ok(
      await shop.run<Envelope<ExpenseDto>>(
        'expense.update',
        wholeDraft(own, { pays: billOf(run.power) }),
      ),
    ).data
    const resaved = ok(
      await as<Envelope<ExpenseDto>>('employee', 'expense.update', {
        ...wholeDraft(said, { description: 'Bill' }),
      }),
    ).data
    expect(resaved.pays).toEqual({ kind: 'running_cost', runningCost: null, channel: null })
    expect(
      ok(await shop.run<Envelope<ExpenseDto>>('expense.get', { id: own.id })).data.pays,
    ).toEqual({
      kind: 'running_cost',
      runningCost: { id: run.power.id, name: 'DEWA' },
      channel: null,
    })
  })
})

describe('finalizing needs it said whenever its category has a running cost for its month', () => {
  it('RUNNING_COST_CHOICE_REQUIRED until it is said; said with the posting, it counts', async () => {
    const bill = await draft(cat.power)
    const refused = await shop.run('expense.post', { id: bill.id, version: bill.version })
    expect(codeOf(refused)).toBe('running_cost_choice_required')
    expect(refused.error?.data.i18nKey).toBe('errors.running_cost_choice_required')
    const posted = await shop.postExpense(bill, billOf(run.power))
    expect(posted).toMatchObject({
      status: 'posted',
      pays: {
        kind: 'running_cost',
        runningCost: { id: run.power.id, name: 'DEWA' },
        channel: null,
      },
    })
    // Said on the draft: finalized as it is.
    const extra = await draft(cat.salaries, { pays: EXTRA })
    expect((await shop.postExpense(extra)).pays).toEqual({
      kind: 'extra',
      runningCost: null,
      channel: null,
    })
    // Without running costs in its category, nothing is asked.
    expect((await shop.postExpense(await draft(cat.ads))).pays).toBeNull()
    // Nor for a month before its running costs started.
    const early = await draft(cat.power, { periodMonth: addMonths(month, -7) })
    expect((await shop.postExpense(early)).pays).toBeNull()
  })

  it('checked again when it is finalized: a running cost removed since is asked again', async () => {
    const second = await shop.runningCost({
      id: newId(),
      name: 'Generator rental',
      categoryId: cat.power.id,
      amount: '450',
      startsOn: firstOf(month, -1),
    })
    const bill = await draft(cat.power, { pays: billOf(second) })
    ok(await shop.run('runningCost.remove', { id: second.id, version: second.version }))
    expect(codeOf(await shop.run('expense.post', { id: bill.id, version: bill.version }))).toBe(
      'running_cost_choice_required',
    )
    // With nothing left to pay in its category, a stale choice simply goes.
    const alone = await shop.runningCost({
      id: newId(),
      name: 'Ad retainer',
      categoryId: cat.ads.id,
      amount: '300',
      startsOn: firstOf(month, -1),
    })
    const ad = await draft(cat.ads, { pays: billOf(alone) })
    ok(await shop.run('runningCost.remove', { id: alone.id, version: alone.version }))
    expect((await shop.postExpense(ad)).pays).toBeNull()
  })

  it('a member who may not see running costs never says it when finalizing (FORBIDDEN)', async () => {
    const own = await draft(cat.ads)
    // A Manager without running costs (a member's own change) finalizes, saying nothing: fine;
    // saying it: FORBIDDEN, before anything is read.
    const manager = await api.person()
    await addMember(api.db, shop.owner.user, shop.id, manager.user, {
      template: 'manager',
      overrides: [{ key: 'running_costs.items.view', effect: 'deny' }],
    })
    const said = await shop.as(manager, 'expense.post', {
      id: own.id,
      version: own.version,
      pays: EXTRA,
    })
    expect(codeOf(said)).toBe('forbidden')
    const bill = await draft(cat.power)
    expect(
      codeOf(await shop.as(manager, 'expense.post', { id: bill.id, version: bill.version })),
    ).toBe('running_cost_choice_required')
    ok(await shop.as(manager, 'expense.post', { id: own.id, version: own.version }))
  })

  it('with approval on: the employee sends it, the approver says it with the approval or the one who finalizes', async () => {
    ok(await shop.run('expense.updateSettings', { approval: true }))
    try {
      const send = async () => {
        const own = await draft(cat.power, { description: 'Power bill' }, 'employee')
        return ok(
          await as<Envelope<ExpenseDto>>('employee', 'expense.submit', {
            id: own.id,
            version: own.version,
          }),
        ).data
      }
      // Sending it never needs it.
      const sent = await send()
      expect(sent).toMatchObject({ status: 'submitted', pays: null })
      // The Manager approves it, saying it is the bill of the electricity; the owner finalizes.
      const approved = ok(
        await as<Envelope<ExpenseDto>>('manager', 'expense.approve', {
          id: sent.id,
          version: sent.version,
          pays: billOf(run.power),
        }),
      ).data
      expect(approved).toMatchObject({
        status: 'approved',
        pays: {
          kind: 'running_cost',
          runningCost: { id: run.power.id, name: 'DEWA' },
          channel: null,
        },
      })
      expect((await shop.postExpense(approved)).pays?.runningCost?.id).toBe(run.power.id)
      // Approved without saying it: the one who finalizes says it.
      const plain = await send()
      const approvedPlain = ok(
        await as<Envelope<ExpenseDto>>('manager', 'expense.approve', {
          id: plain.id,
          version: plain.version,
        }),
      ).data
      expect(
        codeOf(
          await shop.run('expense.post', { id: approvedPlain.id, version: approvedPlain.version }),
        ),
      ).toBe('running_cost_choice_required')
      expect((await shop.postExpense(approvedPlain, EXTRA)).pays?.kind).toBe('extra')
      // An approver who may approve finalizes a sent one directly, saying it then.
      const direct = await send()
      const finalized = ok(
        await as<Envelope<ExpenseDto>>('manager', 'expense.post', {
          id: direct.id,
          version: direct.version,
          pays: billOf(run.power),
        }),
      ).data
      expect(finalized).toMatchObject({
        status: 'posted',
        approvedBy: { memberId: member('manager').memberId },
      })
      // What the employee reads of it: a bill of a running cost, without its name.
      const mine = ok(
        await as<MineExpenseResultDto>('employee', 'expense.getMine', { id: direct.id }),
      ).data
      expect(mine.pays).toEqual({ kind: 'running_cost', runningCost: null, channel: null })
    } finally {
      ok(await shop.run('expense.updateSettings', { approval: false }))
    }
  })

  it('with Running Costs off nothing is asked, and what was said stays', async () => {
    const said = await draft(cat.power, { pays: billOf(run.power) })
    const unsaid = await draft(cat.power)
    ok(
      await shop.run('business.customize', {
        item: { kind: 'module', id: 'running_costs' },
        enabled: false,
      }),
    )
    try {
      expect((await shop.postExpense(unsaid)).pays).toBeNull()
      const posted = await shop.postExpense(said)
      expect(posted.pays).toEqual({ kind: 'running_cost', runningCost: null, channel: null })
      // Nobody says it while the module is off.
      const another = await draft(cat.power)
      expect(
        codeOf(
          await shop.run('expense.post', { id: another.id, version: another.version, pays: EXTRA }),
        ),
      ).toBe('forbidden')
    } finally {
      ok(
        await shop.run('business.customize', {
          item: { kind: 'module', id: 'running_costs' },
          enabled: true,
        }),
      )
    }
    const read = ok(await shop.run<Envelope<ExpenseDto>>('expense.get', { id: said.id })).data
    expect(read.pays?.runningCost?.id).toBe(run.power.id)
  })
})

describe('kept by a correction and a reversal', () => {
  it('the copy says what the expense paid; the reversed one keeps it', async () => {
    const posted = await shop.spend(
      shop.expenseInput(cat.power.id, today, { periodMonth: month }),
      billOf(run.power),
    )
    const newIdOfCopy = newId()
    const copy = ok(
      await shop.run<Envelope<ExpenseDto>>('expense.correct', {
        id: posted.id,
        newId: newIdOfCopy,
      }),
    ).data
    expect(copy).toMatchObject({ status: 'draft', copiedFromId: posted.id })
    expect(copy.pays).toEqual(posted.pays)
    const reversed = ok(await shop.run<Envelope<ExpenseDto>>('expense.get', { id: posted.id })).data
    expect(reversed).toMatchObject({ status: 'reversed', pays: posted.pays })
    // The copy is finalized as it says.
    expect((await shop.postExpense(copy)).pays).toEqual(posted.pays)
  })
})

describe('who sees the running cost’s name (never its amount)', () => {
  it('the name to members who may see running costs; the kind alone to anyone else who sees the expense', async () => {
    const bill = await shop.spend(
      shop.expenseInput(cat.power.id, today, {
        periodMonth: month,
        description: `Who sees ${newId().slice(-6)}`,
      }),
      billOf(run.power),
    )
    for (const template of ROLE_TEMPLATE_KEYS) {
      const one = await as<Envelope<ExpenseDto>>(template, 'expense.get', { id: bill.id })
      const list = await as<ExpenseListDto>(template, 'expense.list', {
        search: bill.description,
      })
      expectNoAmount(one.raw)
      expectNoAmount(list.raw)
      if (template === 'supervisor' || template === 'sales') {
        expect(codeOf(one), template).toBe('forbidden')
        expect(one.raw).not.toContain('DEWA')
        continue
      }
      const named = template !== 'employee'
      const expected = {
        kind: 'running_cost',
        runningCost: named ? { id: run.power.id, name: 'DEWA' } : null,
        channel: null,
      }
      expect(ok(one).data.pays, template).toEqual(expected)
      expect(ok(list).data.items[0]?.pays, template).toEqual(expected)
      if (!named) expect(one.raw).not.toContain('DEWA')
    }
  })

  it('My expenses says it too: the name only to who may see running costs', async () => {
    const own = await draft(cat.power, { description: 'Mine' }, 'employee')
    ok(
      await shop.run('expense.post', { id: own.id, version: own.version, pays: billOf(run.power) }),
    )
    const mine = ok(await as<MineExpenseListDto>('employee', 'expense.mine', { limit: 100 }))
    expect(mine.items.find((e) => e.id === own.id)?.pays).toEqual({
      kind: 'running_cost',
      runningCost: null,
      channel: null,
    })
    const managerOwn = await draft(cat.power, { description: 'Mine too' }, 'manager')
    ok(
      await as('manager', 'expense.post', {
        id: managerOwn.id,
        version: managerOwn.version,
        pays: billOf(run.power),
      }),
    )
    const managers = ok(await as<MineExpenseListDto>('manager', 'expense.mine', { limit: 100 }))
    expect(managers.items.find((e) => e.id === managerOwn.id)?.pays).toEqual({
      kind: 'running_cost',
      runningCost: { id: run.power.id, name: 'DEWA' },
      channel: null,
    })
  })
})

describe('the month’s costs per running cost (D-216)', () => {
  it('a bonus adds to the salaries; a bill replaces only its own running cost; what is inside each category', async () => {
    // A business of its own: its last month holds only what this test enters.
    const cafe = await ExpenseScope.open(api, WORKSHOP)
    const since = firstOf(month, -3)
    const categories = await cafe.categories()
    const id = (name: string) => categories.find((c) => c.name === name)!.id
    const salaries = await cafe.runningCost({
      id: newId(),
      name: 'Staff salaries',
      categoryId: id('Salaries'),
      amount: '16000',
      startsOn: since,
    })
    const power = await cafe.runningCost({
      id: newId(),
      name: 'DEWA',
      categoryId: id('Electricity'),
      amount: '3000',
      startsOn: since,
    })
    const generator = await cafe.runningCost({
      id: newId(),
      name: 'Generator',
      categoryId: id('Electricity'),
      amount: '500',
      startsOn: since,
    })
    const spend = (category: string, amount: string, pays?: ExpensePaysInput) =>
      cafe.spend(
        cafe.expenseInput(id(category), today, { amount, vatRate: '0', periodMonth: lastMonth }),
        pays,
      )
    // The owner's example: a 300 bonus is an extra, on top of the regular 16 000.
    await spend('Salaries', '300', EXTRA)
    // DEWA's bill of 3 150 replaces DEWA's 3 000; the generator keeps its 500.
    await spend('Electricity', '3150', billOf(power))
    // An ad, in a category without running costs, counts as itself.
    await spend('Marketing', '480')
    const { monthCosts } = ok(
      await cafe.run<{ data: ProductCostListDto['data'] }>('productCost.list', {}),
    ).data
    expect(monthCosts).toMatchObject({ month: lastMonth, amountsShown: true, total: '20430' })
    const line = (over: object) => ({
      regular: null,
      period: null,
      takenBack: null,
      ...over,
    })
    expect(monthCosts.categories).toEqual([
      {
        categoryId: id('Salaries'),
        name: 'Salaries',
        amount: '16300',
        lines: [
          line({
            kind: 'running_cost',
            runningCostId: salaries.id,
            name: 'Staff salaries',
            source: 'regular',
            amount: '16000',
            regular: '16000',
          }),
          line({
            kind: 'extra',
            runningCostId: null,
            name: null,
            source: 'expenses',
            amount: '300',
          }),
        ],
      },
      {
        categoryId: id('Electricity'),
        name: 'Electricity',
        amount: '3650',
        lines: [
          line({
            kind: 'running_cost',
            runningCostId: power.id,
            name: 'DEWA',
            source: 'bills',
            amount: '3150',
            regular: '3000',
          }),
          line({
            kind: 'running_cost',
            runningCostId: generator.id,
            name: 'Generator',
            source: 'regular',
            amount: '500',
            regular: '500',
          }),
        ],
      },
      {
        categoryId: id('Marketing'),
        name: 'Marketing',
        amount: '480',
        lines: [
          line({
            kind: 'extra',
            runningCostId: null,
            name: null,
            source: 'expenses',
            amount: '480',
          }),
        ],
      },
    ])
    // Withheld exactly as before: an employee gets none of it.
    const employee = await api.member(cafe, 'employee')
    const hidden = await cafe.as<{ data: ProductCostListDto['data'] }>(
      employee,
      'productCost.list',
      {},
    )
    expect(codeOf(hidden) ?? 'served').not.toBe('served')
    expect(hidden.raw).not.toContain('Staff salaries')
  })
})

describe('another business’s running cost, and the audit log', () => {
  it('approving or finalizing never names another business’s running cost (NOT_FOUND, nothing written)', async () => {
    const bill = await draft(cat.power)
    const foreign = await shop.run('expense.post', {
      id: bill.id,
      version: bill.version,
      pays: billOf(theirs),
    })
    expect(codeOf(foreign)).toBe('not_found')
    expect(foreign.raw).not.toContain('Their rent')
    const read = ok(await shop.run<Envelope<ExpenseDto>>('expense.get', { id: bill.id })).data
    expect(read).toMatchObject({ status: 'draft', pays: null, version: bill.version })
  })

  it('what an expense pays is in the audit log with the posting, by the caller', async () => {
    const bill = await draft(cat.power)
    await shop.postExpense(bill, billOf(run.power))
    const rows = await api.admin<{ actor: string; pays: string | null; running: string | null }[]>`
      select actor_user_id as actor, changes -> 'after' ->> 'pays' as pays,
             changes -> 'after' ->> 'running_cost_id' as running
        from app.audit_log
       where business_id = ${shop.id} and entity = 'expenses' and entity_id = ${bill.id}
       order by id`
    expect(rows.map((r) => [r.pays, r.running])).toEqual([
      [null, null],
      ['running_cost', run.power.id],
    ])
    expect(rows.every((r) => r.actor === shop.owner.user.id)).toBe(true)
  })
})

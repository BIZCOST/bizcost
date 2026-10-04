import type {
  ExpenseDto,
  PayableRunningCostsDto,
  ProductCostListDto,
  RunningCostDto,
} from '@bizcost/contracts'
import { addMonths, monthOf, newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { billOf, EXTRA, ExpenseScope, ExpensesApi, type Envelope } from './expenses'
import { codeOf, ok } from './purchasing'
import { WORKSHOP } from './settings'

// The costing and security adversary's proof tests for D-216 (the owner's decision of 2026-10-01,
// "1أ": an expense in a category that has running costs says which one it pays, or that it is an
// extra), through the real fetch handler. Each test states the rule and fails while the build does
// otherwise.

let api: ExpensesApi

beforeAll(() => {
  api = new ExpensesApi()
})

afterAll(async () => {
  await api.close()
})

interface Shop {
  readonly shop: ExpenseScope
  readonly today: string
  readonly lastMonth: string
  /** A category of the business by its Smart Setup name. */
  readonly category: (name: string) => string
  /** A monthly running cost from three months before last month (unless `extra` says otherwise). */
  readonly runningCost: (
    name: string,
    category: string,
    amount: string,
    extra?: object,
  ) => Promise<RunningCostDto>
}

async function openShop(): Promise<Shop> {
  const shop = await ExpenseScope.open(api, WORKSHOP)
  const today = await shop.today()
  const lastMonth = addMonths(monthOf(today), -1)
  const categories = await shop.categories()
  const category = (name: string) => {
    const found = categories.find((c) => c.name === name)
    if (!found) throw new Error(`no category ${name}`)
    return found.id
  }
  const runningCost = (name: string, categoryName: string, amount: string, extra: object = {}) =>
    shop.runningCost({
      id: newId(),
      name,
      categoryId: category(categoryName),
      amount,
      startsOn: `${addMonths(lastMonth, -3)}-01`,
      ...extra,
    })
  return { shop, today, lastMonth, category, runningCost }
}

/** An update of `expense` as it is (an update is the whole draft), with `change`. */
function wholeDraft(expense: ExpenseDto, change: object = {}) {
  return {
    id: expense.id,
    version: expense.version,
    categoryId: expense.categoryId,
    businessDate: expense.businessDate,
    periodMonth: expense.periodMonth,
    documentType: expense.documentType,
    paymentMethod: expense.paymentMethod,
    amount: expense.amount,
    vatRate: expense.vatRate,
    ...change,
  }
}

const runningCostsModule = async (shop: ExpenseScope, enabled: boolean) => {
  ok(
    await shop.run('business.customize', {
      item: { kind: 'module', id: 'running_costs' },
      enabled,
    }),
  )
}

describe('D-216: a running cost is paid only by an expense of its own category', () => {
  it('with Running Costs off, a draft moved to another category does not stay the bill of the first category’s running cost', async () => {
    // A workshop: DEWA 3 000 a month under Electricity, the shop rent 10 000 a month under Rent.
    // Last month's rent (10 000) was entered under Electricity and said to be DEWA's bill. Running
    // Costs is then turned off for a while; the owner sees the mistake and moves the draft to Rent.
    // While the module is off the owner cannot touch what it pays (`pays`, even null, is FORBIDDEN)
    // and the update keeps it as it is, so the Rent expense is finalized as DEWA's bill. Once Running
    // Costs is back on, the month's costs put the rent under Electricity in place of DEWA's 3 000
    // ("Electricity 10 000: DEWA, from its bill in place of its regular 3 000"), and the expense list
    // says «فاتورة لـ DEWA» on a Rent expense. D-216: the running cost's category is the expense's.
    const { shop, today, lastMonth, category, runningCost } = await openShop()
    const power = await runningCost('DEWA', 'Electricity', '3000')
    await runningCost('Shop rent', 'Rent', '10000')
    const draft = await shop.expenseDraft(
      shop.expenseInput(category('Electricity'), today, {
        amount: '10000',
        vatRate: '0',
        periodMonth: lastMonth,
        pays: billOf(power),
      }),
    )
    expect(draft.pays?.runningCost?.id).toBe(power.id)
    await runningCostsModule(shop, false)
    let posted: ExpenseDto
    try {
      // Nobody may say what it pays while the module is off.
      expect(
        codeOf(
          await shop.run(
            'expense.update',
            wholeDraft(draft, { categoryId: category('Rent'), pays: null }),
          ),
        ),
      ).toBe('forbidden')
      const moved = ok(
        await shop.run<Envelope<ExpenseDto>>(
          'expense.update',
          wholeDraft(draft, { categoryId: category('Rent') }),
        ),
      ).data
      expect(moved.categoryId).toBe(category('Rent'))
      posted = await shop.postExpense(moved)
    } finally {
      await runningCostsModule(shop, true)
    }
    const read = ok(await shop.run<Envelope<ExpenseDto>>('expense.get', { id: posted.id })).data
    expect(read).toMatchObject({ status: 'posted', categoryId: category('Rent') })
    // Never the bill of a running cost of another category.
    expect.soft(read.pays?.runningCost?.id ?? null).not.toBe(power.id)
    // Last month's electricity is DEWA's regular 3 000: the rent is not counted under it.
    const { monthCosts } = ok(
      await shop.run<{ data: ProductCostListDto['data'] }>('productCost.list', {}),
    ).data
    const electricity = monthCosts.categories?.find((c) => c.categoryId === category('Electricity'))
    expect(electricity?.amount).toBe('3000')
    expect(electricity?.lines.map((line) => line.source)).toEqual(['regular'])
  })
})

describe('D-216: what an expense pays is said for its own category ("a new category asks again")', () => {
  it('an extra said under Salaries is not carried to Electricity by an employee’s move: DEWA’s bill is asked before it is finalized', async () => {
    // The barista (employee: never sees running costs) enters 3 150 under Salaries for last month.
    // The owner reads it as a bonus and says it is an extra («مصروف إضافي»: on top of the salaries).
    // It is in fact last month's electricity bill: the barista moves it to Electricity, which has
    // DEWA (3 000 a month). She cannot say what it pays, and the update keeps "extra" because an
    // extra "fits" any category with a running cost. Nobody ever chose among Electricity's running
    // costs, yet finalizing is not asked (RUNNING_COST_CHOICE_REQUIRED is skipped) and last month's
    // electricity becomes DEWA's 3 000 + an extra 3 150 = 6 150: the electricity counted twice.
    const { shop, today, lastMonth, category, runningCost } = await openShop()
    await runningCost('DEWA', 'Electricity', '3000')
    await runningCost('Staff salaries', 'Salaries', '16000')
    const barista = await api.member(shop, 'employee')
    const own = ok(
      await shop.as<Envelope<ExpenseDto>>(
        barista,
        'expense.create',
        shop.expenseInput(category('Salaries'), today, {
          amount: '3150',
          vatRate: '0',
          periodMonth: lastMonth,
        }),
      ),
    ).data
    const said = ok(
      await shop.run<Envelope<ExpenseDto>>(
        'expense.update',
        wholeDraft(own, { amount: '3150', vatRate: '0', pays: EXTRA }),
      ),
    ).data
    expect(said.pays).toEqual({ kind: 'extra', runningCost: null })
    const moved = ok(
      await shop.as<Envelope<ExpenseDto>>(
        barista,
        'expense.update',
        wholeDraft(said, { categoryId: category('Electricity'), amount: '3150', vatRate: '0' }),
      ),
    ).data
    expect(moved.categoryId).toBe(category('Electricity'))
    // What it pays was said for Salaries: under Electricity it is asked again.
    expect.soft(moved.pays).toBeNull()
    expect(codeOf(await shop.run('expense.post', { id: moved.id, version: moved.version }))).toBe(
      'running_cost_choice_required',
    )
  })
})

describe('D-216 with D-176: the month a rent changes', () => {
  it('the old and the new rent offered to a bill of that month can be told apart, and one bill of either pays the rent of that month once', async () => {
    // The shop rent goes from 10 000 to 12 000 on the 16th of last month: the old one stops on the
    // 16th and the new one starts that day (D-176; both named "Shop rent", as the owner would). A
    // bill for last month is offered «فاتورة لـ Shop rent» twice, with the same hint ("for <month>"):
    // nothing tells them apart but the id. And whichever is chosen, it replaces only that half: one
    // rent bill of 11 000 (5 000 + 6 000) said to pay the new rent leaves the old rent's 5 000 for
    // the 15 days counted on top, so the month's rent is 16 000, not 11 000 (costPool, checked in
    // @bizcost/domain), where D-202 promised that a rent that changes mid-month counts once.
    const { shop, today, lastMonth, category, runningCost } = await openShop()
    const handover = `${lastMonth}-16`
    await runningCost('Shop rent', 'Rent', '10000', { endsOn: handover })
    await runningCost('Shop rent', 'Rent', '12000', { startsOn: handover })
    const { items } = ok(
      await shop.run<PayableRunningCostsDto>('expense.payableRunningCosts', {
        categoryId: category('Rent'),
        periodMonth: lastMonth,
      }),
    )
    expect(items).toHaveLength(2)
    const shown = new Set(items.map(({ id: _id, ...rest }) => JSON.stringify(rest)))
    expect(shown.size).toBe(2)
    // One rent bill of 11 000 for that month, said to pay the old rent (D-217: a bill of either
    // pays for both that month): last month's rent is 11 000, on one line, never 16 000 or 17 000.
    const old = items.find((item) => item.endsOn === handover)!
    await shop.spend(
      shop.expenseInput(category('Rent'), today, {
        amount: '11000',
        vatRate: '0',
        periodMonth: lastMonth,
      }),
      billOf(old),
    )
    const { monthCosts } = ok(
      await shop.run<{ data: ProductCostListDto['data'] }>('productCost.list', {}),
    ).data
    const rent = monthCosts.categories?.find((c) => c.categoryId === category('Rent'))
    expect(rent?.amount).toBe('11000')
    expect(rent?.lines).toHaveLength(1)
    expect(rent?.lines[0]).toMatchObject({ name: 'Shop rent', source: 'bills' })
  })
})

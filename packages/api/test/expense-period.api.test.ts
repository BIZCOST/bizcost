import { readdirSync, readFileSync } from 'node:fs'
import { join as joinPath } from 'node:path'
import type {
  CostCategoryDto,
  ExpenseDto,
  ExpenseListDto,
  MineExpenseListDto,
} from '@bizcost/contracts'
import { addMonths, BILLED_NEXT_MONTH_CATEGORIES, monthOf, newId } from '@bizcost/domain'
import { createI18n, type I18nKey } from '@bizcost/i18n'
import { withTenantTx } from '@bizcost/db'
import { sql, type SQL } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ExpenseScope, ExpensesApi, type Envelope } from './expenses'
import { tenant } from './helpers'
import { codeOf, ok } from './purchasing'
import { BAKER, setupBusiness, WORKSHOP } from './settings'

// The month an expense is for, "For which month?" / «لأي شهر هذه الفاتورة؟» (the owner's request of
// 2026-09-30): expenses.period_month, apart from the bill's date. Left out, the month before the
// bill's date in a category billed the month after (electricity, water, internet, phone), else the
// bill's month; from 12 months before the bill's month to 1 month after it; shown in lists, details
// and "My expenses", and a filter of expense.list. Categories say whether their bills come the month
// after (costCategory.*, the starter utilities marked by Smart Setup and by the migration).

let api: ExpensesApi
let shop: ExpenseScope
let today: string
let electricity: CostCategoryDto
let rent: CostCategoryDto

beforeAll(async () => {
  api = new ExpensesApi()
  shop = await ExpenseScope.open(api, WORKSHOP)
  today = await shop.today()
  const categories = await shop.categories()
  electricity = categories.find((c) => c.name === 'Electricity')!
  rent = categories.find((c) => c.name === 'Rent')!
}, 60_000)

afterAll(async () => {
  await api.close()
})

/** Runs SQL as bizcost_api in the business, as the owner: its rows, or the SQLSTATE of a refusal. */
async function asApi<T>(statement: SQL): Promise<T[] | string> {
  try {
    return (await withTenantTx(api.db, tenant(shop.owner.user.id, shop.id), (tx) =>
      tx.execute(statement),
    )) as unknown as T[]
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause
    return cause?.code ?? (error as { code?: string }).code ?? 'error'
  }
}

/** The first day of a month `count` months from `day`'s month. */
const dayIn = (day: string, count: number) => `${addMonths(monthOf(day), count)}-01`

describe('the categories billed the month after', () => {
  it('Smart Setup marks electricity, water, internet and phone, in either language', async () => {
    const marked = (list: CostCategoryDto[]) =>
      list
        .filter((c) => c.billedNextMonth)
        .map((c) => c.name)
        .sort()
    const en = createI18n({ locale: 'en', namespaces: ['setup'] })
    expect(marked(await shop.categories())).toEqual(
      BILLED_NEXT_MONTH_CATEGORIES.map((key) =>
        en.t(`setup.cost_categories.${key}` as I18nKey),
      ).sort(),
    )
    const owner = await api.person()
    const id = await setupBusiness(api.handler, owner.token, BAKER, { locale: 'ar', name: 'مخبز' })
    const arabic = ok(
      await api.call<{ items: CostCategoryDto[] }>(owner, id, 'costCategory.list', {
        status: 'all',
        limit: 100,
      }),
    ).items
    expect(marked(arabic)).toEqual(['الإنترنت', 'الكهرباء', 'الماء', 'الهاتف'].sort())
  })

  it('the migration marks the same starter names of businesses made before (a guard)', () => {
    const dir = joinPath(__dirname, '..', '..', '..', 'supabase', 'migrations')
    const file = readdirSync(dir).find((name) => name.endsWith('_costing_core_release.sql'))!
    const sql = readFileSync(joinPath(dir, file), 'utf8')
    for (const locale of ['en', 'ar'] as const) {
      const i18n = createI18n({ locale, namespaces: ['setup'] })
      for (const key of BILLED_NEXT_MONTH_CATEGORIES) {
        const name = i18n.t(`setup.cost_categories.${key}` as I18nKey)
        expect(sql, `${locale} ${key}`).toContain(`('${name}')`)
      }
    }
  })

  it('any category can be marked or unmarked; a rename alone keeps its mark', async () => {
    const created = ok(
      await shop.run<CostCategoryDto>('costCategory.create', {
        id: newId(),
        name: `Gas ${newId().slice(-6)}`,
        billedNextMonth: true,
      }),
    )
    expect(created.billedNextMonth).toBe(true)
    const renamed = ok(
      await shop.run<CostCategoryDto>('costCategory.update', {
        id: created.id,
        version: created.version,
        name: `${created.name} bill`,
      }),
    )
    expect(renamed.billedNextMonth).toBe(true)
    const unmarked = ok(
      await shop.run<CostCategoryDto>('costCategory.update', {
        id: created.id,
        version: renamed.version,
        name: renamed.name,
        billedNextMonth: false,
      }),
    )
    expect(unmarked.billedNextMonth).toBe(false)
    const plain = ok(
      await shop.run<CostCategoryDto>('costCategory.create', {
        id: newId(),
        name: `Cleaning ${newId().slice(-6)}`,
      }),
    )
    expect(plain.billedNextMonth).toBe(false)
  })
})

describe('the month an expense is for', () => {
  it("defaults to the month before the bill's date for electricity, else the bill's month", async () => {
    const bill = await shop.expenseDraft(shop.expenseInput(electricity.id, today))
    expect(bill.periodMonth).toBe(addMonths(monthOf(today), -1))
    const rentBill = await shop.expenseDraft(shop.expenseInput(rent.id, today))
    expect(rentBill.periodMonth).toBe(monthOf(today))
    const [row] = await api.admin<{ period_month: string }[]>`
      select period_month::text from app.expenses where id = ${bill.id}`
    expect(row?.period_month).toBe(dayIn(today, -1))
  })

  it('takes the month the person says, from 12 months before the bill to 1 month after it', async () => {
    const month = (count: number) => addMonths(monthOf(today), count)
    for (const count of [-12, -3, 0, 1]) {
      const draft = await shop.expenseDraft(
        shop.expenseInput(rent.id, today, { periodMonth: month(count) }),
      )
      expect(draft.periodMonth, String(count)).toBe(month(count))
    }
    for (const count of [-13, 2]) {
      expect(
        codeOf(
          await shop.run(
            'expense.create',
            shop.expenseInput(rent.id, today, { periodMonth: month(count) }),
          ),
        ),
        String(count),
      ).toBe('validation')
    }
    // Not a month: refused by its shape; Arabic-Indic digits are read.
    for (const periodMonth of ['2026-13', '2026-9', `${today}`]) {
      expect(
        codeOf(
          await shop.run('expense.create', shop.expenseInput(rent.id, today, { periodMonth })),
        ),
        periodMonth,
      ).toBe('validation')
    }
    const arabic = await shop.expenseDraft(
      shop.expenseInput(rent.id, today, {
        periodMonth: month(0).replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)]!),
      }),
    )
    expect(arabic.periodMonth).toBe(month(0))
  })

  it('an update keeps the month it has while it fits the bill, and takes a new one', async () => {
    const draft = await shop.expenseDraft(
      shop.expenseInput(rent.id, today, { periodMonth: addMonths(monthOf(today), -2) }),
    )
    const { id, version, periodMonth, ...rest } = draft
    const input = {
      id,
      version,
      categoryId: rest.categoryId,
      businessDate: rest.businessDate,
      documentType: rest.documentType,
      paymentMethod: rest.paymentMethod,
      amount: '120',
      vatRate: rest.vatRate,
    }
    const kept = ok(await shop.run<Envelope<ExpenseDto>>('expense.update', input)).data
    expect(kept.periodMonth).toBe(periodMonth)
    // A bill dated 13 months after the month it had: that month no longer fits, so the default.
    const later = dayIn(today, -14)
    const moved = ok(
      await shop.run<Envelope<ExpenseDto>>('expense.update', {
        ...input,
        version: kept.version,
        businessDate: later,
        categoryId: electricity.id,
      }),
    ).data
    expect(moved.periodMonth).toBe(addMonths(monthOf(later), -1))
    const chosen = ok(
      await shop.run<Envelope<ExpenseDto>>('expense.update', {
        ...input,
        version: moved.version,
        periodMonth: monthOf(today),
      }),
    ).data
    expect(chosen.periodMonth).toBe(monthOf(today))
  })

  it('is in the list, can filter it, is in My expenses, and a correction keeps it', async () => {
    const month = addMonths(monthOf(today), -5)
    const posted = await shop.spend(
      shop.expenseInput(rent.id, today, { periodMonth: month, description: 'Old rent' }),
    )
    expect(posted.periodMonth).toBe(month)
    const list = ok(
      await shop.run<Envelope<ExpenseListDto['data']>>('expense.list', { periodMonth: month }),
    ).data.items
    expect(list.map((i) => i.id)).toContain(posted.id)
    expect(list.every((i) => i.periodMonth === month)).toBe(true)
    const other = ok(
      await shop.run<Envelope<ExpenseListDto['data']>>('expense.list', {
        periodMonth: addMonths(month, -1),
      }),
    ).data.items
    expect(other.map((i) => i.id)).not.toContain(posted.id)
    const mine = ok(await shop.run<MineExpenseListDto>('expense.mine', {})).items
    expect(mine.find((i) => i.id === posted.id)?.periodMonth).toBe(month)
    const newId_ = newId()
    const copy = ok(
      await shop.run<Envelope<ExpenseDto>>('expense.correct', { id: posted.id, newId: newId_ }),
    ).data
    expect(copy).toMatchObject({ id: newId_, status: 'draft', periodMonth: month })
  })

  it('the database keeps the range, and a final expense never changes its month', async () => {
    const change = async (id: string, set: string) => {
      const result = await asApi(
        sql`update app.expenses set period_month = ${sql.raw(set)} where id = ${id}`,
      )
      return typeof result === 'string' ? result : 'ok'
    }
    const draft = await shop.expenseDraft(shop.expenseInput(rent.id, today))
    // Out of range, or not the first day of a month: the check refuses it whatever writes it.
    expect(await change(draft.id, `(business_date - interval '2 years')::date`)).toBe('23514')
    expect(await change(draft.id, `date_trunc('month', business_date)::date + 1`)).toBe('23514')
    expect(
      await change(draft.id, `(date_trunc('month', business_date) - interval '1 month')::date`),
    ).toBe('ok')
    // A row written without its month gets its bill's month (default_period_month).
    const inserted = await asApi<{ period_month: string }>(sql`
      insert into app.expenses (id, business_id, category_id, location_id, business_date,
                                document_type, payment_method, currency, amount, net_total,
                                vat_total, total)
      select ${newId()}, ${shop.id}, ${rent.id}, l.id, ${today}::date, 'no_invoice', 'cash', 'AED',
             1, 1, 0, 1
        from app.locations l where l.business_id = ${shop.id} and l.is_default
      returning period_month::text`)
    expect(typeof inserted === 'string' ? inserted : inserted[0]?.period_month).toBe(
      dayIn(today, 0),
    )
    // In range, but the expense is final (guard_expense).
    const posted = await shop.spend(shop.expenseInput(rent.id, today))
    expect(
      await change(posted.id, `(date_trunc('month', business_date) - interval '1 month')::date`),
    ).not.toBe('ok')
  })
})

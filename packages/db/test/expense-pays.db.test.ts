import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { newId } from '@bizcost/domain'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withTenantTx, type Db } from '../src'
import {
  connectAdmin,
  connectApi,
  createAuthUser,
  createBusiness,
  ctx,
  type Admin,
  type TestBusiness,
  type TestUser,
} from './helpers'

// What the expenses already final paid (the owner's decision of 2026-10-01, D-216; migration
// expense_running_cost). The migration's own backfill statement, read from the migration file, is run
// again on fixtures of this file (in a transaction that is rolled back), the way the migration ran it
// on the data that existed: a final expense in a category with exactly one running cost a bill for
// its month can pay (billPeriodOf in @bizcost/domain) becomes that running cost's bill, one in a
// category with two or more an extra, one in a category with none says nothing; drafts, removed
// running costs and expenses that already say what they pay are left alone. 23_expense_pays (pgTAP)
// checks the columns, the constraint, the foreign key and the guard.

const migrations = fileURLToPath(new URL('../../../supabase/migrations/', import.meta.url))

/** The UPDATE of the expenses already final, as the migration wrote it. */
function backfillStatement(): string {
  const file = readdirSync(migrations).find((name) => name.endsWith('_expense_running_cost.sql'))
  if (!file) throw new Error('migration expense_running_cost not found')
  const statements = readFileSync(`${migrations}${file}`, 'utf8').split('--> statement-breakpoint')
  const found = statements.filter((s) => s.includes('WITH "payable"'))
  if (found.length !== 1) throw new Error('the backfill statement is not found once')
  return found[0]!.trim()
}

let admin: Admin
let db: Db
let owner: TestUser
let biz: TestBusiness
const id: Record<string, string> = {}
const key = (name: string) => (id[name] ??= newId())

beforeAll(async () => {
  admin = connectAdmin()
  db = connectApi()
  owner = await createAuthUser(admin)
  biz = await createBusiness(db, owner, 'Backfill Cafe')
  await withTenantTx(db, ctx(owner.id, biz.id), async (tx) => {
    await tx.execute(sql`
      insert into app.locations (id, business_id, name, is_default)
      values (${key('loc')}, ${biz.id}, 'Main', true)`)
    for (const name of ['Electricity', 'Rent', 'Licences', 'Marketing', 'Water', 'Phone']) {
      await tx.execute(sql`
        insert into app.cost_categories (id, business_id, name)
        values (${key(name)}, ${biz.id}, ${name})`)
    }
    const running: [string, string, string, string, string | null][] = [
      ['power', 'Electricity', 'monthly', '2026-01-01', null],
      ['shop', 'Rent', 'monthly', '2026-01-01', null],
      ['warehouse', 'Rent', 'quarterly', '2026-01-15', null],
      // A year from 10 March 2025 to February 2026, given up on 1 August 2025.
      ['licence', 'Licences', 'yearly', '2025-03-10', '2025-08-01'],
      ['water', 'Water', 'monthly', '2026-06-01', null],
      ['phone', 'Phone', 'monthly', '2026-01-01', null],
    ]
    for (const [name, category, frequency, startsOn, endsOn] of running) {
      await tx.execute(sql`
        insert into app.running_costs (id, business_id, name, category_id, amount, frequency,
                                       starts_on, ends_on)
        values (${key(name)}, ${biz.id}, ${name}, ${key(category)}, 1000, ${frequency},
                ${startsOn}, ${endsOn})`)
    }
    // The phone line was entered by mistake and removed.
    await tx.execute(
      sql`update app.running_costs set deleted_at = now() where id = ${key('phone')}`,
    )
    const final = (status: string) =>
      status === 'draft' ? sql`` : sql`, status, posted_at, posted_by, vat_in_cost, cost_total`
    const finalValues = (status: string) =>
      status === 'draft' ? sql`` : sql`, 'posted', now(), ${owner.id}, false, 100`
    const expenses: [string, string, string, string][] = [
      ['e power', 'Electricity', '2026-09-01', 'posted'],
      ['e rent', 'Rent', '2026-09-01', 'posted'],
      ['e ads', 'Marketing', '2026-09-01', 'posted'],
      ['e water early', 'Water', '2026-05-01', 'posted'],
      ['e water', 'Water', '2026-06-01', 'posted'],
      ['e licence', 'Licences', '2026-01-01', 'posted'],
      ['e licence next', 'Licences', '2026-03-01', 'posted'],
      ['e phone', 'Phone', '2026-09-01', 'posted'],
      ['e power draft', 'Electricity', '2026-09-01', 'draft'],
      ['e power reversed', 'Electricity', '2026-08-01', 'posted'],
      ['e power said', 'Electricity', '2026-07-01', 'draft'],
    ]
    for (const [name, category, month, status] of expenses) {
      await tx.execute(sql`
        insert into app.expenses (id, business_id, category_id, location_id, business_date,
                                  period_month, document_type, payment_method, currency, amount,
                                  net_total, vat_total, total ${final(status)})
        values (${key(name)}, ${biz.id}, ${key(category)}, ${key('loc')}, ${month}, ${month},
                'no_invoice', 'cash', 'AED', 100, 100, 0, 100 ${finalValues(status)})`)
    }
    await tx.execute(sql`
      update app.expenses
         set status = 'reversed', reversed_at = now(), reversed_by = ${owner.id},
             reversal_date = business_date
       where id = ${key('e power reversed')}`)
    // Said already (written after the migration): kept.
    await tx.execute(sql`
      update app.expenses set pays = 'extra' where id = ${key('e power said')}`)
    await tx.execute(sql`
      update app.expenses set status = 'posted', posted_at = now(), posted_by = ${owner.id},
                              vat_in_cost = false, cost_total = 100
       where id = ${key('e power said')}`)
  })
})

afterAll(async () => {
  await db?.$client.end()
  await admin?.end()
})

interface Stamp {
  id: string
  version: number
  updated_at: Date
  updated_by: string | null
}

/**
 * What each expense of the fixtures pays after the backfill (`pays`, or the running cost's name),
 * and their versions and who changed them last, before and after it.
 */
async function backfilled(): Promise<{
  pays: Record<string, string>
  before: Stamp[]
  after: Stamp[]
}> {
  const rollback = new Error('rollback')
  const result = { pays: {} as Record<string, string>, before: [] as Stamp[], after: [] as Stamp[] }
  const stamps = (tx: Admin) => tx<Stamp[]>`
    select id, version, updated_at, updated_by from app.expenses
     where business_id = ${biz.id} order by id`
  try {
    await admin.begin(async (tx) => {
      result.before = await stamps(tx as unknown as Admin)
      await tx.unsafe('ALTER TABLE "app"."expenses" DISABLE TRIGGER "guard_expense"')
      await tx.unsafe('ALTER TABLE "app"."expenses" DISABLE TRIGGER "touch_row"')
      await tx.unsafe(backfillStatement())
      await tx.unsafe('ALTER TABLE "app"."expenses" ENABLE TRIGGER "touch_row"')
      await tx.unsafe('ALTER TABLE "app"."expenses" ENABLE TRIGGER "guard_expense"')
      const rows = await tx<{ id: string; pays: string | null; running: string | null }[]>`
        select e.id, e.pays, r.name as running
          from app.expenses e
          left join app.running_costs r on r.business_id = e.business_id and r.id = e.running_cost_id
         where e.business_id = ${biz.id}`
      const names = Object.fromEntries(Object.entries(id).map(([name, value]) => [value, name]))
      result.after = await stamps(tx as unknown as Admin)
      result.pays = Object.fromEntries(
        rows.map((row) => [
          names[row.id]!,
          row.pays === null ? '-' : row.running === null ? row.pays : `bill of ${row.running}`,
        ]),
      )
      throw rollback
    })
  } catch (error) {
    if (error !== rollback) throw error
  }
  return result
}

describe('migration expense_running_cost: what the expenses already final paid (D-216)', () => {
  it('one running cost a bill of its month can pay: its bill; two or more: an extra; none: nothing said', async () => {
    expect((await backfilled()).pays).toEqual({
      'e power': 'bill of power',
      // The shop's rent and the warehouse's quarter (July to September) could both be paid.
      'e rent': 'extra',
      'e ads': '-',
      // Before the water's first month: nothing to pay.
      'e water early': '-',
      'e water': 'bill of water',
      // The licence's year from March 2025 holds January 2026, though it was given up in August.
      'e licence': 'bill of licence',
      // Its next year began after it stopped.
      'e licence next': '-',
      // A removed running cost is never paid.
      'e phone': '-',
      // Drafts are asked when they are finalized; what is said already stays.
      'e power draft': '-',
      'e power reversed': 'bill of power',
      'e power said': 'extra',
    })
  })

  it('is not an edit of them: versions and who changed them last stay as they were', async () => {
    const { before, after } = await backfilled()
    expect(before.length).toBe(11)
    expect(after).toEqual(before)
  })
})

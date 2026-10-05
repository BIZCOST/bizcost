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

// The starter sales channels of the businesses that existed before M3 Step 2 (D-226; migration
// sales_security). The migration's own statement, read from the migration file, is run again on
// fixtures of this file (in a transaction that is rolled back), the way the migration ran it on the
// data that existed: each business gets the channels its stored Smart Setup answers name, in its
// language ("Shop", "WhatsApp & phone", "Online"), or one "Direct" channel when none fits or it has no
// answers; a business that has a channel already, or was deleted, is left alone. 24_sales (pgTAP)
// checks the tables; sales-channels.test.ts in @bizcost/api compares the rows with Smart Setup's.

const migrations = fileURLToPath(new URL('../../../supabase/migrations/', import.meta.url))

/** The INSERT of the starter channels, as the migration wrote it. */
function seedStatement(): string {
  const file = readdirSync(migrations).find((name) => name.endsWith('_sales_security.sql'))
  if (!file) throw new Error('migration sales_security not found')
  const text = readFileSync(`${migrations}${file}`, 'utf8')
  const start = text.indexOf('with starters (key, answer, kind, en, ar, position) as (')
  const end = text.indexOf('order by k.business_id, k.position;', start)
  if (start < 0 || end < 0) throw new Error('the seed statement is not found')
  return text.slice(start, end + 'order by k.business_id, k.position;'.length)
}

let admin: Admin
let db: Db
let owner: TestUser
const businesses: Record<string, TestBusiness> = {}

async function business(
  name: string,
  locale: 'en' | 'ar',
  answers: Record<string, unknown> | null,
): Promise<TestBusiness> {
  const created = await createBusiness(db, owner, name)
  await withTenantTx(db, ctx(owner.id, created.id), async (tx) => {
    await tx.execute(
      sql`update app.businesses set default_locale = ${locale} where id = ${created.id}`,
    )
    if (answers) {
      await tx.execute(sql`
        insert into app.setup_answers (id, business_id, question_set_version, answers)
        values (${newId()}, ${created.id}, 1, ${JSON.stringify(answers)}::jsonb)`)
    }
  })
  return created
}

beforeAll(async () => {
  admin = connectAdmin()
  db = connectApi()
  owner = await createAuthUser(admin)
  businesses.cafe = await business('Seed cafe', 'en', {
    sales_channels: ['walk_in', 'online', 'quotes'],
  })
  businesses.baker = await business('Seed baker', 'ar', { sales_channels: ['messages'] })
  businesses.fitout = await business('Seed fit-out', 'en', {
    sales_channels: ['quotes', 'invoice_later'],
  })
  businesses.none = await business('Seed without answers', 'ar', null)
  businesses.has = await business('Seed with a channel', 'en', { sales_channels: ['walk_in'] })
  businesses.gone = await business('Seed deleted', 'en', { sales_channels: ['walk_in'] })
  await withTenantTx(db, ctx(owner.id, businesses.has!.id), (tx) =>
    tx.execute(sql`
      insert into app.sales_channels (id, business_id, name, kind)
      values (${newId()}, ${businesses.has!.id}, 'Talabat', 'delivery_app')`),
  )
  await admin`update app.businesses set deleted_at = now() where id = ${businesses.gone!.id}`
})

afterAll(async () => {
  await db?.$client.end()
  await admin?.end()
})

/** Each fixture business's channels after the seed ("name kind"), in a rolled-back transaction. */
async function seeded(): Promise<Record<string, string[]>> {
  const rollback = new Error('rollback')
  const result: Record<string, string[]> = {}
  try {
    await admin.begin(async (tx) => {
      // Only the fixtures: the other businesses of the local database have their channels already.
      await tx.unsafe(seedStatement())
      for (const [key, b] of Object.entries(businesses)) {
        const rows = await tx<{ name: string; kind: string }[]>`
          select name, kind from app.sales_channels where business_id = ${b.id}
           order by name`
        result[key] = rows.map((row) => `${row.name} ${row.kind}`)
      }
      throw rollback
    })
  } catch (error) {
    if (error !== rollback) throw error
  }
  return result
}

describe('migration sales_security: the starter channels of the businesses that existed (D-226)', () => {
  it('the channels the answers name, in the business’s language; "Direct" when none fits', async () => {
    expect(await seeded()).toEqual({
      cafe: ['Online website', 'Shop shop'],
      baker: ['واتساب والهاتف messages'],
      fitout: ['Direct other'],
      none: ['البيع المباشر other'],
      // A business with a channel already is left as it is.
      has: ['Talabat delivery_app'],
      // A deleted business gets none.
      gone: [],
    })
  })
})

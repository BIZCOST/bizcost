import { newId } from '@bizcost/domain'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withTenantTx, type Db, type Tx } from '../src'
import {
  connectAdmin,
  connectApi,
  createAuthUser,
  createBusiness,
  ctx,
  failsWith,
  sqlState,
  type Admin,
  type TestBusiness,
  type TestUser,
} from './helpers'

// The books-closed date at the database (M2 Step 8; migration books_closed_guard, D-114 rule 6, D-135):
// the trigger books_closed reads the business row FOR SHARE where a posting is written, so a posting
// and a change of the date never pass each other, even for a writer that did not lock the business
// row first (the API does, lock 2 of D-135). Two connections as bizcost_api, like two API instances:
//   - a close waits for a posting in flight; the next posting on the closed day is refused;
//   - a posting waits for a close in flight, and then sees the closed date (BZ412, BOOKS_CLOSED).
// supabase/tests/19_books_closed_guard.test.sql checks every document and payment the trigger guards.

const BOOKS_CLOSED = 'BZ412'

let admin: Admin
let db: Db
let other: Db
let owner: TestUser
let biz: TestBusiness
let locationId: string
let materialId: string
let day: string

beforeAll(async () => {
  admin = connectAdmin()
  db = connectApi()
  other = connectApi()
  owner = await createAuthUser(admin)
  biz = await createBusiness(db, owner, 'Ledger Bakery')
  locationId = newId()
  materialId = newId()
  await withTenantTx(db, ctx(owner.id, biz.id), async (tx) => {
    await tx.execute(sql`
      insert into app.locations (id, business_id, name, is_default)
      values (${locationId}, ${biz.id}, 'Main', true)`)
    await tx.execute(sql`
      insert into app.materials (id, business_id, name, dimension, unit)
      values (${materialId}, ${biz.id}, 'Flour', 'mass', 'kg')`)
  })
  const [row] = await admin<{ day: string }[]>`select (current_date - 1)::text as day`
  day = row!.day
})

afterAll(async () => {
  await db?.$client.end()
  await other?.$client.end()
  await admin?.end()
})

/** A draft purchase dated `day` with one line of flour; returns the line's id. */
async function draftLine(): Promise<string> {
  const purchaseId = newId()
  const lineId = newId()
  await withTenantTx(db, ctx(owner.id, biz.id), async (tx) => {
    await tx.execute(sql`
      insert into app.purchases (id, business_id, location_id, business_date, document_type, currency)
      values (${purchaseId}, ${biz.id}, ${locationId}, ${day}, 'no_invoice', 'AED')`)
    await tx.execute(sql`
      insert into app.purchase_lines (id, business_id, purchase_id, position, kind, material_id, qty,
                                      unit, unit_price)
      values (${lineId}, ${biz.id}, ${purchaseId}, 0, 'material', ${materialId}, 1, 'kg', 4)`)
  })
  return lineId
}

/** The goods of a purchase line come into the ledger on `day`. */
function receive(tx: Tx, lineId: string) {
  return tx.execute(sql`
    insert into app.stock_movements (id, business_id, business_date, location_id, material_id, kind,
                                     qty, value, purchase_line_id)
    values (${newId()}, ${biz.id}, ${day}, ${locationId}, ${materialId}, 'purchase', 1000, 4,
            ${lineId})`)
}

function closeBooks(tx: Tx, through: string | null) {
  return tx.execute(sql`
    update app.businesses set books_closed_through = ${through}::date where id = ${biz.id}`)
}

/** Waits until backend `pid` waits for a lock (another transaction holds what it needs). */
async function waitsForLock(pid: number): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    const [row] = await admin<{ waiting: boolean }[]>`
      select coalesce(bool_or(wait_event_type = 'Lock'), false) as waiting
        from pg_stat_activity where pid = ${pid}`
    if (row?.waiting) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

/** A transaction on `on` that runs `first`, then holds until `release` is called. */
function held(on: Db, first: (tx: Tx) => Promise<unknown>) {
  let release!: () => void
  const released = new Promise<void>((resolve) => (release = resolve))
  let ready!: () => void
  const started = new Promise<void>((resolve) => (ready = resolve))
  const done = withTenantTx(on, ctx(owner.id, biz.id), async (tx) => {
    await first(tx)
    ready()
    await released
  })
  return { started, release, done }
}

describe('the books-closed date and postings at the same time', () => {
  it('a close waits for a posting in flight; the next posting on the closed day is refused', async () => {
    const [first, second] = [await draftLine(), await draftLine()]
    const posting = held(db, (tx) => receive(tx, first))
    await posting.started

    let pid = 0
    let settled = false
    const close = withTenantTx(other, ctx(owner.id, biz.id), async (tx) => {
      const [row] = (await tx.execute(sql`select pg_backend_pid() as pid`)) as unknown as {
        pid: number
      }[]
      pid = row!.pid
      await closeBooks(tx, day)
    }).finally(() => (settled = true))

    while (pid === 0) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(await waitsForLock(pid)).toBe(true)
    expect(settled).toBe(false)
    posting.release()
    await posting.done
    await close

    expect(
      await failsWith(withTenantTx(db, ctx(owner.id, biz.id), (tx) => receive(tx, second))),
    ).toBe(BOOKS_CLOSED)
    await withTenantTx(db, ctx(owner.id, biz.id), (tx) => closeBooks(tx, null))
  })

  it('a posting waits for a close in flight, then sees the closed date', async () => {
    const lineId = await draftLine()
    const close = held(other, (tx) => closeBooks(tx, day))
    await close.started

    let pid = 0
    let outcome: string | undefined
    const posting = withTenantTx(db, ctx(owner.id, biz.id), async (tx) => {
      const [row] = (await tx.execute(sql`select pg_backend_pid() as pid`)) as unknown as {
        pid: number
      }[]
      pid = row!.pid
      await receive(tx, lineId)
    }).then(
      () => (outcome = 'posted'),
      (error: unknown) => (outcome = sqlState(error) ?? String(error)),
    )

    while (pid === 0) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(await waitsForLock(pid)).toBe(true)
    expect(outcome).toBeUndefined()
    close.release()
    await close.done
    await posting
    expect(outcome).toBe(BOOKS_CLOSED)

    // Opened again, the same goods come in.
    await withTenantTx(db, ctx(owner.id, biz.id), (tx) => closeBooks(tx, null))
    await withTenantTx(db, ctx(owner.id, biz.id), (tx) => receive(tx, lineId))
    const [count] = await admin<{ n: number }[]>`
      select count(*)::int as n from app.stock_movements where purchase_line_id = ${lineId}`
    expect(count?.n).toBe(1)
  })
})

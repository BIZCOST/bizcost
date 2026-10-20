import { newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chooseTestData, deleteBusinesses, tenantTables } from '../demo/clean'
import { businessDigest } from './hardening/fixture'
import { mutate } from './helpers'
import { tag } from './product-costs'
import { purchaseInput } from './purchasing'
import { bought, CAFE, item, SalesApi, SaleScope, shift } from './sales'

// The local tools learn the sales of M3 Step 2 (D-182, D-185):
//   - `pnpm dev:clean-test-data` removes every row of a test business from every table of schema app
//     that has a business_id, found from the catalog (the sales tables included), with the local-only
//     bypass of the guards (a finalized or reversed sale, its lines and their frozen costs are never
//     deleted otherwise), and nothing of another business; and never a business or user a run may
//     still be using (made, changed or written to in the last hour, D-338);
//   - `pnpm demo:reset` deletes a demo account the way the app does (account.delete): the business it
//     owns alone is soft-deleted with its sales kept.

let api: SalesApi

/** A café with a finalized sale whose materials were filled, a reversed one and a channel. */
async function cafeWithSales(): Promise<SaleScope> {
  const cafe = await SaleScope.open(api, CAFE)
  const today = await cafe.today()
  const flour = await cafe.newMaterial({ name: `Flour ${tag()}`, unit: 'kg', packs: [] })
  const cake = await cafe.product({ name: `Cake ${tag()}`, defaultPrice: '30' })
  await cafe.recipe(cake.id, [{ id: newId(), materialId: flour.id, qty: '500', unit: 'g' }])
  await cafe.channel({ name: `Talabat ${tag()}`, feePercent: '20' })
  await cafe.sell({ businessDate: shift(today, -2), lines: [item(cake.id, '2', '30')] })
  await cafe.buy(purchaseInput(today, [bought(flour.id, '10', '50', { unit: 'kg' })]))
  const other = await cafe.sell({ businessDate: today, lines: [item(cake.id, '1', '30')] })
  await cafe.reverseSale(other.id)
  return cafe
}

beforeAll(() => {
  api = new SalesApi()
})

afterAll(async () => {
  await api.close()
})

describe('dev:clean-test-data: every row of a test business, the sales tables included', () => {
  it('finds the sales tables in the catalog and removes a business with finalized sales, nothing else', async () => {
    const tables = await tenantTables(api.admin)
    expect(tables).toEqual(
      expect.arrayContaining(['sales_channels', 'sales', 'sale_lines', 'sale_line_materials']),
    )
    const removed = await cafeWithSales()
    const kept = await cafeWithSales()
    const keptBefore = await businessDigest(api.admin, kept.id)
    // Without the bypass, a finalized sale is never deleted (the guards).
    await expect(
      api.admin`delete from app.sales where business_id = ${removed.id} and status = 'posted'`,
    ).rejects.toThrow(/never deleted/)

    await deleteBusinesses(api.admin, [removed.id], tables)
    for (const table of tables) {
      const [row] = await api.admin.unsafe<{ n: number }[]>(
        `select count(*)::int as n from app."${table}" where business_id = $1`,
        [removed.id],
      )
      expect(row?.n, table).toBe(0)
    }
    const [business] = await api.admin<{ n: number }[]>`
      select count(*)::int as n from app.businesses where id = ${removed.id}`
    expect(business?.n).toBe(0)
    expect(await businessDigest(api.admin, kept.id)).toEqual(keptBefore)
  })
})

describe('dev:clean-test-data: never what a run may still be using (D-338)', () => {
  it('chooses a test business idle for two hours with its owner, and leaves one written to now', async () => {
    const idle = await cafeWithSales()
    const busy = await cafeWithSales()
    const members = (business: string) => api.admin<{ id: string }[]>`
      select user_id as id from app.business_members where business_id = ${business}`
    const idleUsers = (await members(idle.id)).map((r) => r.id)
    const busyUsers = (await members(busy.id)).map((r) => r.id)
    expect(idleUsers.length).toBeGreaterThan(0)
    const rollback = new Error('dev-tools: roll back')
    await expect(
      api.admin.begin(async (tx) => {
        // The idle business and its owner as if made, written to and signed in two hours ago (past
        // the guards, as the clean-up itself deletes: local only, rolled back below).
        await tx`set local session_replication_role = replica`
        await tx`
          update app.businesses
             set created_at = created_at - interval '2 hours', updated_at = updated_at - interval '2 hours'
           where id = ${idle.id}`
        await tx`
          update app.audit_log set created_at = created_at - interval '2 hours'
           where business_id = ${idle.id}`
        await tx`
          update auth.users
             set created_at = created_at - interval '2 hours',
                 updated_at = updated_at - interval '2 hours',
                 last_sign_in_at = last_sign_in_at - interval '2 hours'
           where id = any(${idleUsers}::uuid[])`
        await tx`set local session_replication_role = origin`

        await chooseTestData(tx as unknown as Parameters<typeof chooseTestData>[0])
        const chosen = await tx<{ id: string }[]>`
          select id from clean_businesses where id in (${idle.id}, ${busy.id})`
        expect(chosen.map((r) => r.id)).toEqual([idle.id])
        const users = await tx<{ id: string }[]>`
          select id from clean_users where id = any(${[...idleUsers, ...busyUsers]}::uuid[])`
        expect(users.map((r) => r.id).sort()).toEqual([...idleUsers].sort())
        const [inUse] = await tx<{ n: number }[]>`
          select count(*)::int as n from clean_in_use_businesses where id = ${busy.id}`
        expect(inUse?.n).toBe(1)
        throw rollback
      }),
    ).rejects.toBe(rollback)
  }, 90_000)
})

describe('demo:reset: account.delete keeps a deleted business’s sales', () => {
  it('soft-deletes the business the owner had alone, its finalized sales kept as they were', async () => {
    const cafe = await cafeWithSales()
    const [before] = await api.admin<{ n: number }[]>`
      select count(*)::int as n from app.sales where business_id = ${cafe.id}`
    const result = await mutate(api.handler, 'account.delete', { token: cafe.owner.token })
    expect(result.error, result.raw).toBeUndefined()
    const [business] = await api.admin<{ deleted: boolean }[]>`
      select deleted_at is not null as deleted from app.businesses where id = ${cafe.id}`
    expect(business?.deleted).toBe(true)
    const [after] = await api.admin<{ n: number }[]>`
      select count(*)::int as n from app.sales where business_id = ${cafe.id}`
    expect(after?.n).toBe(before?.n)
    expect(before?.n).toBeGreaterThan(0)
  })
})

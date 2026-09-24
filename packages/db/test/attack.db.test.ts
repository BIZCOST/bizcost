// Attack tests (security review of Step 1), kept as regression tests.
import { newId } from '@bizcost/domain'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { businessMembers, withTenantTx, type Db } from '../src'
import {
  connectAdmin,
  connectApi,
  createAuthUser,
  createBusiness,
  ctx,
  sqlState,
  type Admin,
} from './helpers'

let admin: Admin
let db: Db

beforeAll(() => {
  admin = connectAdmin()
  db = connectApi()
})

afterAll(async () => {
  await db?.$client.end()
  await admin?.end()
})

describe('owner invariant under REPEATABLE READ', () => {
  // An advisory lock alone serialises the owner checks but, in REPEATABLE READ, the check reads the
  // transaction snapshot taken before the other commit, so two transactions that each suspend one of
  // the last two owners would both pass. bizcost_api may choose the isolation level (BEGIN ISOLATION
  // LEVEL ..., or default_transaction_isolation), so app.enforce_active_owner() confirms the owner it
  // relies on with FOR SHARE NOWAIT, which raises 40001 on a row changed by a concurrent commit.
  it('two REPEATABLE READ transactions cannot each remove one of the last two owners', async () => {
    const owner = await createAuthUser(admin)
    const coOwner = await createAuthUser(admin)
    const biz = await createBusiness(db, owner)
    const coOwnerMemberId = newId()
    await withTenantTx(db, ctx(owner.id, biz.id), (tx) =>
      tx.insert(businessMembers).values({
        id: coOwnerMemberId,
        businessId: biz.id,
        userId: coOwner.id,
        kind: 'account',
        displayName: 'Co-owner',
        status: 'active',
        roleId: biz.ownerRoleId,
      }),
    )

    const url = process.env.DATABASE_URL ?? ''
    const api1 = postgres(url, { max: 1, prepare: false, onnotice: () => {} })
    const api2 = postgres(url, { max: 1, prepare: false, onnotice: () => {} })
    try {
      const [c1, c2] = await Promise.all([api1.reserve(), api2.reserve()])
      const begin = async (conn: postgres.ReservedSql, userId: string) => {
        await conn`begin isolation level repeatable read`
        await conn`select set_config('app.user_id', ${userId}, true), set_config('app.business_id', ${biz.id}, true), set_config('app.request_id', ${newId()}, true)`
      }
      // Both transactions start (and take their snapshots) while both owners are active.
      await begin(c1, owner.id)
      await begin(c2, coOwner.id)
      await c1`update app.business_members set status = 'suspended' where id = ${biz.ownerMemberId}`
      await c2`update app.business_members set status = 'suspended' where id = ${coOwnerMemberId}`

      // Deferred owner checks run at COMMIT, one after the other.
      const outcome = async (conn: postgres.ReservedSql) => {
        try {
          await conn`commit`
          return 'committed'
        } catch (error) {
          await conn`rollback`.catch(() => {})
          return sqlState(error) ?? String(error)
        }
      }
      const first = await outcome(c1)
      const second = await outcome(c2)
      c1.release()
      c2.release()

      const [row] = await admin<{ owners: number }[]>`
        select count(*)::int as owners
        from app.business_members m
        join app.roles r on r.business_id = m.business_id and r.id = m.role_id
        where m.business_id = ${biz.id} and m.kind = 'account' and m.status = 'active'
          and m.deleted_at is null and r.template_key = 'owner' and r.deleted_at is null`

      expect({ first, second, activeOwners: row?.owners }).toEqual({
        first: 'committed',
        second: expect.stringMatching(/^(23514|40001)$/),
        activeOwners: 1,
      })
    } finally {
      await api1.end()
      await api2.end()
    }
  })
})

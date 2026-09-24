import { newId } from '@bizcost/domain'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  businessMembers,
  ConflictError,
  insertIdempotent,
  locations,
  roles,
  withTenantTx,
  type Db,
} from '../src'
import {
  connectAdmin,
  connectApi,
  createAuthUser,
  createBusiness,
  ctx,
  failsWith,
  type Admin,
  type TestBusiness,
  type TestUser,
} from './helpers'

// insertIdempotent() against app.locations as bizcost_api (docs/DATA_MODEL.md §1.2).

let admin: Admin
let db: Db
let owner: TestUser
let coMember: TestUser
let outsider: TestUser
let biz: TestBusiness
let otherBiz: TestBusiness

beforeAll(async () => {
  admin = connectAdmin()
  db = connectApi()
  owner = await createAuthUser(admin)
  coMember = await createAuthUser(admin)
  outsider = await createAuthUser(admin)
  biz = await createBusiness(db, owner, 'Idempotent A')
  otherBiz = await createBusiness(db, outsider, 'Idempotent B')

  // A second active member of `biz` (any role works: RLS only checks membership).
  await withTenantTx(db, ctx(owner.id, biz.id), async (tx) => {
    const roleId = newId()
    await tx.insert(roles).values({ id: roleId, businessId: biz.id, name: 'Staff' })
    await tx.insert(businessMembers).values({
      id: newId(),
      businessId: biz.id,
      userId: coMember.id,
      kind: 'account',
      displayName: 'Co member',
      status: 'active',
      roleId,
    })
  })
})

afterAll(async () => {
  await admin.end()
  await db.$client.end()
})

function createLocation(user: TestUser, businessId: string, id: string, requestHash: string) {
  return withTenantTx(db, ctx(user.id, businessId), (tx) =>
    insertIdempotent(tx, locations, { id, businessId, name: 'Main', requestHash }),
  )
}

async function rowCount(id: string): Promise<number> {
  const [row] = await admin<
    { n: number }[]
  >`select count(*)::int as n from app.locations where id = ${id}`
  return row?.n ?? 0
}

describe('insertIdempotent', () => {
  it('returns the existing row when the same create is retried', async () => {
    const id = newId()
    const first = await createLocation(owner, biz.id, id, 'hash-1')
    const retry = await createLocation(owner, biz.id, id, 'hash-1')
    expect(retry).toEqual(first)
    expect(first).toMatchObject({
      id,
      businessId: biz.id,
      createdBy: owner.id,
      requestHash: 'hash-1',
    })
    expect(await rowCount(id)).toBe(1)
    const [audit] = await admin<{ n: number }[]>`
      select count(*)::int as n from app.audit_log where entity = 'locations' and entity_id = ${id}`
    expect(audit?.n).toBe(1)
  })

  it('throws ConflictError when the payload differs', async () => {
    const id = newId()
    await createLocation(owner, biz.id, id, 'hash-1')
    await expect(createLocation(owner, biz.id, id, 'hash-2')).rejects.toBeInstanceOf(ConflictError)
    expect(await rowCount(id)).toBe(1)
  })

  it('throws ConflictError when another member of the business retries the id', async () => {
    const id = newId()
    await createLocation(owner, biz.id, id, 'hash-1')
    await expect(createLocation(coMember, biz.id, id, 'hash-1')).rejects.toBeInstanceOf(
      ConflictError,
    )
  })

  it('throws ConflictError, revealing nothing, when the id belongs to another business', async () => {
    const id = newId()
    await createLocation(outsider, otherBiz.id, id, 'hash-1')
    await expect(createLocation(owner, biz.id, id, 'hash-1')).rejects.toBeInstanceOf(ConflictError)
    const [row] = await admin<{ business_id: string }[]>`
      select business_id from app.locations where id = ${id}`
    expect(row?.business_id).toBe(otherBiz.id)
  })

  it('does not absorb other unique violations', async () => {
    await withTenantTx(db, ctx(owner.id, biz.id), (tx) =>
      insertIdempotent(tx, locations, {
        id: newId(),
        businessId: biz.id,
        name: 'Default',
        isDefault: true,
        requestHash: 'default-1',
      }),
    )
    const secondDefault = withTenantTx(db, ctx(owner.id, biz.id), (tx) =>
      insertIdempotent(tx, locations, {
        id: newId(),
        businessId: biz.id,
        name: 'Another default',
        isDefault: true,
        requestHash: 'default-2',
      }),
    )
    expect(await failsWith(secondDefault)).toBe('23505')
  })

  it('stores the request hash on the row', async () => {
    const id = newId()
    await createLocation(owner, biz.id, id, 'stored-hash')
    const [row] = await withTenantTx(db, ctx(owner.id, biz.id), (tx) =>
      tx.select().from(locations).where(eq(locations.id, id)),
    )
    expect(row?.requestHash).toBe('stored-hash')
  })
})

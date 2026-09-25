import { DELETED_USER_DISPLAY_NAME, type MeDto } from '@bizcost/contracts'
import type { Db } from '@bizcost/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  addMember,
  connectAdmin,
  connectApi,
  createBusiness,
  createUser,
  deleteUser,
  handlerFor,
  mintToken,
  mutate,
  query,
  SECRET_KEY,
  signIn,
  SUPABASE_URL,
  type Admin,
  type TestUser,
} from './helpers'

// ATTACK (Step 3 security review): account.updateProfile / account.delete. These tests failed before
// the fixes (D-064, D-065) and now guard against regressions.

let db: Db
let admin: Admin
let handler: ReturnType<typeof handlerFor>
const users: TestUser[] = []

beforeAll(() => {
  db = connectApi()
  admin = connectAdmin()
  handler = handlerFor(db, undefined, { supabaseSecretKey: SECRET_KEY })
})

afterAll(async () => {
  for (const user of users) await deleteUser(user)
  await admin.end()
  await db.$client.end()
})

async function newUser(metadata: Record<string, unknown> = { locale: 'en' }) {
  const user = await createUser(metadata)
  users.push(user)
  return { user, token: await mintToken(user) }
}

async function authUserExists(id: string): Promise<boolean> {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${id}`, {
    headers: { apikey: SECRET_KEY, authorization: `Bearer ${SECRET_KEY}` },
  })
  return response.ok
}

async function profileRow(id: string) {
  const [row] = await admin<{ display_name: string | null; anonymized_at: Date | null }[]>`
    select display_name, anonymized_at from app.profiles where id = ${id}`
  return row
}

async function memberRow(businessId: string, userId: string) {
  const [row] = await admin<{ status: string; display_name: string }[]>`
    select status, display_name from app.business_members
    where business_id = ${businessId} and user_id = ${userId}`
  return row
}

async function businessDeleted(businessId: string): Promise<boolean> {
  const [row] = await admin<{ deleted_at: Date | null }[]>`
    select deleted_at from app.businesses where id = ${businessId}`
  return row?.deleted_at !== null
}

describe('a deleted account keeps a working access token', () => {
  // The API verifies tokens locally (getClaims + JWKS), so the access token of a deleted auth user
  // keeps a valid signature until it expires (jwt_expiry = 3600 s). Signed-in procedures outside a
  // business therefore refuse an anonymized profile.

  it('refuses the real access token of a deleted account', async () => {
    const user = await createUser({ locale: 'en' })
    users.push(user)
    const session = await signIn(user)
    await query(handler, 'me', { token: session.access_token })

    const deleted = await mutate(handler, 'account.delete', { token: session.access_token })
    expect(deleted.error).toBeUndefined()
    expect(await authUserExists(user.id)).toBe(false)

    const me = await query<MeDto>(handler, 'me', { token: session.access_token })
    expect(me.error?.data.appCode).toBe('unauthorized')
  })

  it('cannot restore the name of an anonymized profile', async () => {
    const { user, token } = await newUser()
    await query(handler, 'me', { token })
    expect((await mutate(handler, 'account.delete', { token })).error).toBeUndefined()
    expect(await profileRow(user.id)).toMatchObject({ display_name: DELETED_USER_DISPLAY_NAME })

    const renamed = await mutate(handler, 'account.updateProfile', {
      token,
      input: { displayName: 'Real Name Again' },
    })
    expect(renamed.error).toBeDefined()
    expect(await profileRow(user.id)).toMatchObject({ display_name: DELETED_USER_DISPLAY_NAME })
  })
})

describe('account.delete partial failure', () => {
  it('changes nothing when the Auth admin call fails (e.g. a wrong or rotated secret key)', async () => {
    // A key the Auth server rejects (or an Auth outage) must fail the deletion before any change:
    // otherwise the account stays alive and signed in while its business is gone and its name is
    // 'Deleted user'.
    const { user, token } = await newUser()
    const business = await createBusiness(db, user, 'Half Deleted Bakery')
    await query(handler, 'me', { token })
    const wrongKey = handlerFor(db, undefined, {
      // Built at runtime so secret scanners don't mistake this fake for a real key.
      supabaseSecretKey: ['sb', 'secret', 'this_key_is_not_valid_000000000'].join('_'),
    })

    const result = await mutate(wrongKey, 'account.delete', { token })
    expect(result.error?.data.appCode).toBe('internal')
    expect(await authUserExists(user.id)).toBe(true)
    expect(await businessDeleted(business.id)).toBe(false)
    expect((await memberRow(business.id, user.id))?.status).toBe('active')
    expect((await profileRow(user.id))?.anonymized_at).toBeNull()
  })
})

describe("co-members' view of a person's name (D-048: kept in sync with the profile)", () => {
  it('account.updateProfile updates the name co-members see', async () => {
    const { user: owner } = await newUser()
    const { user: staff, token } = await newUser()
    const business = await createBusiness(db, owner, 'Sync Name Cafe')
    await addMember(db, owner, business.id, staff, { template: 'employee' })

    const saved = await mutate(handler, 'account.updateProfile', {
      token,
      input: { displayName: 'Sara' },
    })
    expect(saved.error).toBeUndefined()
    expect((await memberRow(business.id, staff.id))?.display_name).toBe('Sara')
  })

  it('account.delete anonymizes the name co-members see', async () => {
    const { user: owner } = await newUser()
    const { user: staff, token } = await newUser()
    const business = await createBusiness(db, owner, 'Anonymized Name Cafe')
    await addMember(db, owner, business.id, staff, { template: 'employee' })

    expect((await mutate(handler, 'account.delete', { token })).error).toBeUndefined()
    const row = await memberRow(business.id, staff.id)
    expect(row?.status).toBe('removed')
    expect(row?.display_name).toBe(DELETED_USER_DISPLAY_NAME)
  })
})

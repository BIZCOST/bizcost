import {
  AUTH_RECENT_SIGN_IN_SECONDS,
  DELETED_USER_DISPLAY_NAME,
  type MeDto,
  type ProfileDto,
} from '@bizcost/contracts'
import { businessMembers, withTenantTx, type Db } from '@bizcost/db'
import { and, eq } from 'drizzle-orm'
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
  ORIGIN,
  query,
  SECRET_KEY,
  SUPABASE_URL,
  tenant,
  type Admin,
  type TestUser,
} from './helpers'

// account.updateProfile and account.delete through the real fetch handler, with real auth users
// (the deletion calls the local Auth admin API) and the database checked as postgres.

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
  const [row] = await admin<
    { display_name: string | null; locale: string; anonymized_at: Date | null }[]
  >`select display_name, locale, anonymized_at from app.profiles where id = ${id}`
  return row
}

async function memberStatus(businessId: string, userId: string) {
  const [row] = await admin<{ status: string }[]>`
    select status from app.business_members where business_id = ${businessId} and user_id = ${userId}`
  return row?.status
}

async function businessDeleted(businessId: string): Promise<boolean> {
  const [row] = await admin<{ deleted_at: Date | null }[]>`
    select deleted_at from app.businesses where id = ${businessId}`
  return row?.deleted_at !== null
}

describe('account.updateProfile', () => {
  it('saves the name and language of the caller only', async () => {
    const { user, token } = await newUser()
    const other = await newUser()
    await query(handler, 'me', { token: other.token })

    const saved = await mutate<ProfileDto>(handler, 'account.updateProfile', {
      token,
      input: { displayName: '  Rashed  ', locale: 'ar' },
    })
    expect(saved.error).toBeUndefined()
    expect(saved.data).toMatchObject({ id: user.id, displayName: 'Rashed', locale: 'ar' })

    const me = await query<MeDto>(handler, 'me', { token })
    expect(me.data?.profile).toMatchObject({ displayName: 'Rashed', locale: 'ar' })
    expect(await profileRow(other.user.id)).toMatchObject({
      display_name: other.user.email.split('@')[0],
      locale: 'en',
    })
  })

  it('changes one field at a time and creates a missing profile', async () => {
    const { user, token } = await newUser({ locale: 'ar' })
    expect(await profileRow(user.id)).toBeUndefined()
    const saved = await mutate<ProfileDto>(handler, 'account.updateProfile', {
      token,
      input: { locale: 'en' },
    })
    expect(saved.data).toMatchObject({ displayName: user.email.split('@')[0], locale: 'en' })
    const renamed = await mutate<ProfileDto>(handler, 'account.updateProfile', {
      token,
      input: { displayName: 'Sara' },
    })
    expect(renamed.data).toMatchObject({ displayName: 'Sara', locale: 'en' })
  })

  it.each([[{}], [{ displayName: '   ' }], [{ displayName: 'x'.repeat(81) }], [{ locale: 'fr' }]])(
    'rejects %j',
    async (input) => {
      const { token } = await newUser()
      const result = await mutate(handler, 'account.updateProfile', { token, input })
      expect(result.error?.data.appCode).toBe('validation')
    },
  )

  it('needs a session', async () => {
    // Signed out, from the app's own origin (a foreign origin is refused first).
    const result = await mutate(handler, 'account.updateProfile', {
      headers: { origin: ORIGIN },
      input: { displayName: 'Nobody' },
    })
    expect(result.error?.data.appCode).toBe('unauthorized')
  })
})

describe('account.delete', () => {
  it('without businesses: anonymizes the profile and deletes the auth user', async () => {
    const { user, token } = await newUser()
    await query(handler, 'me', { token })

    const result = await mutate<{ deletedBusinessIds: string[] }>(handler, 'account.delete', {
      token,
    })
    expect(result.error).toBeUndefined()
    expect(result.data).toEqual({ deletedBusinessIds: [] })
    expect(await profileRow(user.id)).toMatchObject({ display_name: DELETED_USER_DISPLAY_NAME })
    expect((await profileRow(user.id))?.anonymized_at).not.toBeNull()
    expect(await authUserExists(user.id)).toBe(false)
  })

  it('soft-deletes a business whose only member is the caller', async () => {
    const { user, token } = await newUser()
    const business = await createBusiness(db, user, 'Solo Bakery')

    const result = await mutate<{ deletedBusinessIds: string[] }>(handler, 'account.delete', {
      token,
    })
    expect(result.error).toBeUndefined()
    expect(result.data).toEqual({ deletedBusinessIds: [business.id] })
    expect(await businessDeleted(business.id)).toBe(true)
    expect(await memberStatus(business.id, user.id)).toBe('removed')
    expect(await authUserExists(user.id)).toBe(false)
  })

  it('is refused for the only owner of a business with other members, and changes nothing', async () => {
    const { user: owner, token } = await newUser()
    const { user: staff } = await newUser()
    const business = await createBusiness(db, owner, 'Team Cafe')
    await addMember(db, owner, business.id, staff, { template: 'employee' })
    await query(handler, 'me', { token })

    const result = await mutate(handler, 'account.delete', { token })
    expect(result.status).toBe(409)
    expect(result.error?.data).toMatchObject({
      appCode: 'sole_owner',
      i18nKey: 'errors.sole_owner',
    })
    expect(await businessDeleted(business.id)).toBe(false)
    expect(await memberStatus(business.id, owner.id)).toBe('active')
    expect(await memberStatus(business.id, staff.id)).toBe('active')
    expect((await profileRow(owner.id))?.anonymized_at).toBeNull()
    expect(await authUserExists(owner.id)).toBe(true)
  })

  it('also counts a suspended member as another member', async () => {
    const { user: owner, token } = await newUser()
    const { user: staff } = await newUser()
    const business = await createBusiness(db, owner, 'Quiet Workshop')
    const { memberId } = await addMember(db, owner, business.id, staff, { template: 'employee' })
    await withTenantTx(db, tenant(owner.id, business.id), (tx) =>
      tx
        .update(businessMembers)
        .set({ status: 'suspended' })
        .where(and(eq(businessMembers.businessId, business.id), eq(businessMembers.id, memberId))),
    )
    const result = await mutate(handler, 'account.delete', { token })
    expect(result.error?.data.appCode).toBe('sole_owner')
  })

  it('leaves a business that keeps another owner, and other users are untouched', async () => {
    const { user: first, token } = await newUser()
    const { user: second, token: secondToken } = await newUser()
    const { user: staff } = await newUser()
    const business = await createBusiness(db, first, 'Two Owners Trading')
    await addMember(db, first, business.id, second, { template: 'owner' })
    await addMember(db, first, business.id, staff, { template: 'employee' })
    const before = await query<MeDto>(handler, 'me', { token: secondToken })

    const result = await mutate<{ deletedBusinessIds: string[] }>(handler, 'account.delete', {
      token,
    })
    expect(result.error).toBeUndefined()
    expect(result.data).toEqual({ deletedBusinessIds: [] })
    expect(await businessDeleted(business.id)).toBe(false)
    expect(await memberStatus(business.id, first.id)).toBe('removed')
    expect(await memberStatus(business.id, second.id)).toBe('active')
    expect(await memberStatus(business.id, staff.id)).toBe('active')

    const after = await query<MeDto>(handler, 'me', { token: secondToken })
    expect(after.data).toEqual(before.data)
    expect(await authUserExists(second.id)).toBe(true)
  })

  it("an employee leaves the owner's business without changing it", async () => {
    const { user: owner } = await newUser()
    const { user: staff, token } = await newUser()
    const business = await createBusiness(db, owner, 'Owner Co')
    await addMember(db, owner, business.id, staff, { template: 'employee' })

    const result = await mutate(handler, 'account.delete', { token })
    expect(result.error).toBeUndefined()
    expect(await businessDeleted(business.id)).toBe(false)
    expect(await memberStatus(business.id, staff.id)).toBe('removed')
    expect(await memberStatus(business.id, owner.id)).toBe('active')
    expect(await profileRow(owner.id)).toBeUndefined()
  })

  it('fails before any change when the secret key is not configured', async () => {
    const { user, token } = await newUser()
    const business = await createBusiness(db, user, 'Unchanged Shop')
    const noKey = handlerFor(db, undefined, { supabaseSecretKey: undefined })

    const result = await mutate(noKey, 'account.delete', { token })
    expect(result.error?.data.appCode).toBe('internal')
    expect(await businessDeleted(business.id)).toBe(false)
    expect(await memberStatus(business.id, user.id)).toBe('active')
    expect(await authUserExists(user.id)).toBe(true)
  })

  it('needs a recent sign-in, and changes nothing without one', async () => {
    const { user } = await newUser()
    const business = await createBusiness(db, user, 'Old Session Shop')
    const now = Math.floor(Date.now() / 1000)
    const old = await mintToken(user, { signedInAt: now - AUTH_RECENT_SIGN_IN_SECONDS - 60 })

    const result = await mutate(handler, 'account.delete', { token: old })
    expect(result.status).toBe(403)
    expect(result.error?.data).toMatchObject({
      appCode: 'reauth_required',
      i18nKey: 'errors.reauth_required',
    })
    expect(await businessDeleted(business.id)).toBe(false)
    expect(await memberStatus(business.id, user.id)).toBe('active')
    expect((await profileRow(user.id))?.anonymized_at ?? null).toBeNull()
    expect(await authUserExists(user.id)).toBe(true)

    // A fresh sign-in (or an emailed code just entered) is enough.
    const fresh = await mintToken(user, { signedInAt: now - 5 })
    expect((await mutate(handler, 'account.delete', { token: fresh })).error).toBeUndefined()
    expect(await authUserExists(user.id)).toBe(false)
  })

  it('reports the sole-owner block before asking for a recent sign-in', async () => {
    const { user: owner } = await newUser()
    const { user: staff } = await newUser()
    const business = await createBusiness(db, owner, 'Blocked Early Cafe')
    await addMember(db, owner, business.id, staff, { template: 'employee' })
    const old = await mintToken(owner, { signedInAt: Math.floor(Date.now() / 1000) - 86_400 })
    const result = await mutate(handler, 'account.delete', { token: old })
    expect(result.error?.data.appCode).toBe('sole_owner')
  })

  it('needs a session', async () => {
    const result = await mutate(handler, 'account.delete', { headers: { origin: ORIGIN } })
    expect(result.error?.data.appCode).toBe('unauthorized')
  })
})

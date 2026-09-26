import type { ChecklistItemDto, DashboardChecklistDto } from '@bizcost/contracts'
import type { Db } from '@bizcost/db'
import { newId } from '@bizcost/domain'
import { ROLE_TEMPLATE_KEYS, type RoleTemplateKey } from '@bizcost/modules'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  addMember,
  connectAdmin,
  connectApi,
  createUser,
  deleteUser,
  handlerFor,
  mintToken,
  mutate,
  query,
  type Admin,
  type TestUser,
} from './helpers'
import {
  appCode,
  BAKER,
  CapturedEmails,
  join,
  setupBusiness,
  templateRoleId,
  WORKSHOP,
} from './settings'

// dashboard.checklist through the real fetch handler (ROADMAP.md Step 7, docs/PRODUCT.md §10, D-090):
// the steps each role template can act on, the steps each capability brings, the milestones reached
// before a member joined, and each step's state following the business's real data as the owner
// completes it.

let db: Db
let admin: Admin
let handler: ReturnType<typeof handlerFor>
const users: TestUser[] = []
const emails = new CapturedEmails()

beforeAll(() => {
  db = connectApi()
  admin = connectAdmin()
  handler = handlerFor(db, undefined, {}, { emailSender: emails })
})

afterAll(async () => {
  for (const user of users) await deleteUser(user)
  await admin.end()
  await db.$client.end()
})

type Person = { user: TestUser; token: string }

async function newUser(): Promise<Person> {
  const user = await createUser({ locale: 'en' })
  users.push(user)
  return { user, token: await mintToken(user) }
}

function call<T = unknown>(token: string, businessId: string, path: string, input?: unknown) {
  return input === undefined
    ? query<T>(handler, path, { token, businessId })
    : mutate<T>(handler, path, { token, businessId, input })
}

async function checklist(token: string, businessId: string): Promise<ChecklistItemDto[]> {
  const result = await call<DashboardChecklistDto>(token, businessId, 'dashboard.checklist')
  expect(result.error).toBeUndefined()
  return result.data?.items ?? []
}

const ids = (items: ChecklistItemDto[]) => items.map((item) => item.id)
const state = (items: ChecklistItemDto[]) =>
  Object.fromEntries(items.map((item) => [item.id, item.done]))

async function profileVersion(businessId: string): Promise<number> {
  const [row] = await admin<{ version: number }[]>`
    select version from app.businesses where id = ${businessId}`
  return row?.version ?? 0
}

describe('dashboard.checklist: who sees which step', () => {
  it('gives each role template of a business that uses everything the steps it can act on', async () => {
    const owner = await newUser()
    const businessId = await setupBusiness(handler, owner.token, WORKSHOP)
    // The team had started when the others joined: only the owner gets "Invite your first team
    // member". The business still has one branch, so the second one is open to those who manage them.
    const expected: Record<RoleTemplateKey, string[]> = {
      owner: ['profile', 'trn', 'invite', 'location'],
      admin: ['profile', 'trn', 'location'],
      manager: ['location'],
      accountant: [],
      sales: [],
      supervisor: [],
      employee: [],
    }
    for (const template of ROLE_TEMPLATE_KEYS) {
      let token = owner.token
      if (template !== 'owner') {
        const member = await newUser()
        await join(db, owner.user, businessId, member.user, template)
        token = member.token
      }
      expect(ids(await checklist(token, businessId)), template).toEqual(expected[template])
    }
  })

  it('follows the capabilities: TRN with VAT, invite with a team, a branch with branches', async () => {
    const owner = await newUser()
    const businessId = await setupBusiness(handler, owner.token, BAKER)
    expect(ids(await checklist(owner.token, businessId))).toEqual(['profile'])

    const customize = (key: string, enabled: boolean) =>
      call(owner.token, businessId, 'business.customize', {
        item: { kind: 'capability', key },
        enabled,
      })
    expect((await customize('has_team', true)).error).toBeUndefined()
    expect(ids(await checklist(owner.token, businessId))).toEqual(['profile', 'invite'])
    expect((await customize('multi_location', true)).error).toBeUndefined()
    expect(ids(await checklist(owner.token, businessId))).toEqual(['profile', 'invite', 'location'])
    // VAT is switched in the business profile, with its TRN: the step appears already done.
    const saved = await call(owner.token, businessId, 'business.updateProfile', {
      version: await profileVersion(businessId),
      legalName: 'Test Workshop',
      legalNameAr: null,
      vatRegistered: true,
      trn: '100123456700003',
    })
    expect(saved.error).toBeUndefined()
    expect(state(await checklist(owner.token, businessId))).toEqual({
      profile: false,
      trn: true,
      invite: false,
      location: false,
    })
    expect((await customize('has_team', false)).error).toBeUndefined()
    expect((await customize('multi_location', false)).error).toBeUndefined()
    expect(ids(await checklist(owner.token, businessId))).toEqual(['profile', 'trn'])
  })

  it('follows a role that was edited, and needs dashboard.home.view', async () => {
    const owner = await newUser()
    const businessId = await setupBusiness(handler, owner.token, WORKSHOP)
    // A member whose Employee role may also manage the branches.
    const branches = await newUser()
    await addMember(db, owner.user, businessId, branches.user, {
      template: 'employee',
      overrides: [{ key: 'settings.locations.manage', effect: 'allow' }],
    })
    expect(ids(await checklist(branches.token, businessId))).toEqual(['location'])
    // Without the dashboard, no checklist at all.
    const noDashboard = await newUser()
    await addMember(db, owner.user, businessId, noDashboard.user, {
      template: 'admin',
      overrides: [{ key: 'dashboard.home.view', effect: 'deny' }],
    })
    expect(appCode(await call(noDashboard.token, businessId, 'dashboard.checklist'))).toBe(
      'forbidden',
    )
    // Not a member: the same FORBIDDEN as any business procedure.
    const stranger = await newUser()
    expect(appCode(await call(stranger.token, businessId, 'dashboard.checklist'))).toBe('forbidden')
  })
})

describe('dashboard.checklist: milestones reached before a member joined', () => {
  it('leaves out the first team member and the second branch for those who joined after them', async () => {
    const owner = await newUser()
    const businessId = await setupBusiness(handler, owner.token, WORKSHOP)
    // Joins while the business has one branch: the second one is theirs to see, open then done.
    const early = await newUser()
    await join(db, owner.user, businessId, early.user, 'manager')
    expect(await checklist(early.token, businessId)).toEqual([
      { id: 'location', done: false, missing: [] },
    ])
    const branchId = newId()
    expect(
      (await call(owner.token, businessId, 'location.create', { id: branchId, name: 'Mirdif' }))
        .error,
    ).toBeUndefined()
    expect(state(await checklist(early.token, businessId))).toEqual({ location: true })

    // Join after the second branch: no branch step; an admin, no team step either.
    const late = await newUser()
    await join(db, owner.user, businessId, late.user, 'manager')
    expect(await checklist(late.token, businessId)).toEqual([])
    const admin = await newUser()
    await join(db, owner.user, businessId, admin.user, 'admin')
    expect(ids(await checklist(admin.token, businessId))).toEqual(['profile', 'trn'])
    // The owner keeps every step, done.
    expect(state(await checklist(owner.token, businessId))).toMatchObject({
      invite: true,
      location: true,
    })

    // The second branch removed: the step is open again, for everyone who manages branches.
    expect(
      (await call(owner.token, businessId, 'location.remove', { id: branchId })).error,
    ).toBeUndefined()
    expect(await checklist(late.token, businessId)).toEqual([
      { id: 'location', done: false, missing: [] },
    ])
  })
})

describe('dashboard.checklist: each step follows the data', () => {
  it('profile: the name in Arabic and a logo', async () => {
    const owner = await newUser()
    const businessId = await setupBusiness(handler, owner.token, WORKSHOP)
    const profile = async () =>
      (await checklist(owner.token, businessId)).find((item) => item.id === 'profile')
    expect(await profile()).toEqual({ id: 'profile', done: false, missing: ['arabicName', 'logo'] })

    const saved = await call(owner.token, businessId, 'business.updateProfile', {
      version: await profileVersion(businessId),
      legalName: 'Test Workshop',
      legalNameAr: 'ورشة الاختبار',
      vatRegistered: true,
      trn: '100123456700003',
    })
    expect(saved.error).toBeUndefined()
    expect(await profile()).toEqual({ id: 'profile', done: false, missing: ['logo'] })
    // The logo path is set directly: uploads have their own tests (settings.logo.api.test.ts).
    await admin`update app.businesses set logo_path = ${`${businessId}/logo/${newId()}.png`}
      where id = ${businessId}`
    expect(await profile()).toEqual({ id: 'profile', done: true, missing: [] })
  })

  it('profile: a name written in Arabic needs no second Arabic name', async () => {
    const owner = await newUser()
    const businessId = await setupBusiness(handler, owner.token, BAKER, { name: 'حلويات سارة' })
    expect(await checklist(owner.token, businessId)).toEqual([
      { id: 'profile', done: false, missing: ['logo'] },
    ])
  })

  it('TRN: done once saved', async () => {
    const owner = await newUser()
    const businessId = await setupBusiness(handler, owner.token, WORKSHOP)
    // Smart Setup asks whether the business is VAT registered, not for its TRN.
    expect(state(await checklist(owner.token, businessId)).trn).toBe(false)
    await call(owner.token, businessId, 'business.updateProfile', {
      version: await profileVersion(businessId),
      legalName: 'Test Workshop',
      legalNameAr: null,
      vatRegistered: true,
      trn: '100-1234-5670-0003',
    })
    expect(state(await checklist(owner.token, businessId)).trn).toBe(true)
  })

  it('invite: an invitation waiting or another member; not an expired or cancelled one', async () => {
    const owner = await newUser()
    const businessId = await setupBusiness(handler, owner.token, WORKSHOP)
    const invite = async () => state(await checklist(owner.token, businessId)).invite
    expect(await invite()).toBe(false)

    const invitationId = newId()
    const created = await call(owner.token, businessId, 'invitation.create', {
      id: invitationId,
      email: `dash-${newId()}@test.bizcost.local`,
      roleId: await templateRoleId(db, owner.user, businessId, 'employee'),
      locale: 'en',
    })
    expect(created.error).toBeUndefined()
    expect(await invite()).toBe(true)
    await admin`update app.business_invitations set expires_at = now() - interval '1 minute'
      where id = ${invitationId}`
    expect(await invite()).toBe(false)
    await admin`update app.business_invitations set expires_at = now() + interval '1 day'
      where id = ${invitationId}`
    expect(await invite()).toBe(true)
    expect(
      (await call(owner.token, businessId, 'invitation.revoke', { id: invitationId })).error,
    ).toBeUndefined()
    expect(await invite()).toBe(false)

    const member = await newUser()
    await join(db, owner.user, businessId, member.user, 'employee')
    expect(await invite()).toBe(true)
  })

  it('location: a second branch', async () => {
    const owner = await newUser()
    const businessId = await setupBusiness(handler, owner.token, WORKSHOP)
    const location = async () => state(await checklist(owner.token, businessId)).location
    expect(await location()).toBe(false)
    const id = newId()
    expect(
      (await call(owner.token, businessId, 'location.create', { id, name: 'Mirdif' })).error,
    ).toBeUndefined()
    expect(await location()).toBe(true)
    expect((await call(owner.token, businessId, 'location.remove', { id })).error).toBeUndefined()
    expect(await location()).toBe(false)
  })
})

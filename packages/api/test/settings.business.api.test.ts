import type {
  BusinessContextDto,
  BusinessProfileDto,
  CustomizationDto,
  CustomizeDto,
  LocationDto,
  UpdateBusinessProfileDto,
} from '@bizcost/contracts'
import type { Db } from '@bizcost/db'
import { newId } from '@bizcost/domain'
import type { RoleTemplateKey } from '@bizcost/modules'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  connectAdmin,
  connectApi,
  createUser,
  deleteUser,
  handlerFor,
  mintToken,
  mutate,
  query,
  SECRET_KEY,
  type Admin,
  type TestUser,
} from './helpers'
import { appCode, BAKER, join, setupBusiness, WORKSHOP } from './settings'

// Settings → Business profile, language, Customize BizCost and Locations through the real fetch
// handler (ROADMAP.md Step 6), with the database checked as postgres: permissions per role template,
// capability guards, dependency rules and cross-tenant attempts.

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

async function newUser() {
  const user = await createUser({ locale: 'en' })
  users.push(user)
  return { user, token: await mintToken(user) }
}

/** A workshop (every capability on) owned by a new user, with one member per other template. */
async function workshopWithTeam() {
  const owner = await newUser()
  const businessId = await setupBusiness(handler, owner.token, WORKSHOP)
  const members = {} as Record<Exclude<RoleTemplateKey, 'owner'>, { user: TestUser; token: string }>
  for (const template of [
    'admin',
    'manager',
    'accountant',
    'sales',
    'supervisor',
    'employee',
  ] as const) {
    const member = await newUser()
    await join(db, owner.user, businessId, member.user, template)
    members[template] = member
  }
  return { owner, businessId, members }
}

function profileOf(token: string, businessId: string) {
  return query<BusinessProfileDto>(handler, 'business.profile', { token, businessId })
}

function updateProfile(token: string, businessId: string, input: object) {
  return mutate<UpdateBusinessProfileDto>(handler, 'business.updateProfile', {
    token,
    businessId,
    input,
  })
}

async function moduleRow(businessId: string, key: string) {
  const [row] = await admin<{ enabled: boolean }[]>`
    select enabled from app.business_modules where business_id = ${businessId} and module_key = ${key}`
  return row?.enabled
}

describe('business.profile / business.updateProfile', () => {
  it('shows the profile with the M1 fixed values', async () => {
    const owner = await newUser()
    const businessId = await setupBusiness(handler, owner.token, WORKSHOP, { name: 'Nour Works' })
    const result = await profileOf(owner.token, businessId)
    expect(result.error).toBeUndefined()
    expect(result.data).toMatchObject({
      id: businessId,
      legalName: 'Nour Works',
      legalNameAr: null,
      logoUrl: null,
      currency: 'AED',
      country: 'AE',
      timezone: 'Asia/Dubai',
      vatRegistered: true,
      trn: null,
      defaultLocale: 'en',
    })
    expect(result.data?.version).toBeGreaterThanOrEqual(1)
  })

  it('saves names and a TRN typed with Arabic digits, spaces and dashes (stored as 15 digits)', async () => {
    const owner = await newUser()
    const businessId = await setupBusiness(handler, owner.token, WORKSHOP)
    const { data: before } = await profileOf(owner.token, businessId)
    const result = await updateProfile(owner.token, businessId, {
      version: before!.version,
      legalName: '  Nour Carpentry ',
      legalNameAr: 'ورشة نور',
      vatRegistered: true,
      trn: '١٠٠-٢٣٤٥ ٦٧٨٩ ٠١٢٣',
    })
    expect(result.error).toBeUndefined()
    expect(result.data?.profile).toMatchObject({
      legalName: 'Nour Carpentry',
      legalNameAr: 'ورشة نور',
      vatRegistered: true,
      trn: '100234567890123',
    })
    expect(result.data?.turnedOn).toEqual([])
    expect(result.data?.turnedOff).toEqual([])
    const [row] = await admin<{ trn: string; legal_name_ar: string }[]>`
      select trn, legal_name_ar from app.businesses where id = ${businessId}`
    expect(row).toEqual({ trn: '100234567890123', legal_name_ar: 'ورشة نور' })
    // Audited with the caller and the request id (the x-request-id of the response).
    const [audit] = await admin<{ actor_user_id: string; request_id: string }[]>`
      select actor_user_id, request_id from app.audit_log
       where business_id = ${businessId} and entity = 'businesses' and action = 'update'
       order by created_at desc limit 1`
    expect(audit?.actor_user_id).toBe(owner.user.id)
    expect(audit?.request_id).toBe(result.headers.get('x-request-id'))
  })

  it('needs a valid TRN exactly when VAT registered', async () => {
    const owner = await newUser()
    const businessId = await setupBusiness(handler, owner.token, WORKSHOP)
    const { data: profile } = await profileOf(owner.token, businessId)
    const base = { version: profile!.version, legalName: 'W', legalNameAr: null }
    for (const input of [
      { ...base, vatRegistered: true, trn: null },
      { ...base, vatRegistered: true, trn: '  ' },
      { ...base, vatRegistered: true, trn: '10023456789012' }, // 14 digits
      { ...base, vatRegistered: true, trn: '1002345678901234' }, // 16 digits
      { ...base, vatRegistered: true, trn: '10023456789012a' },
      { ...base, vatRegistered: false, trn: '100234567890123' },
      { ...base, vatRegistered: false, trn: null, legalName: 'Bad\u0000Name' },
      { ...base, vatRegistered: false, trn: null, legalNameAr: 'x'.repeat(101) },
    ]) {
      expect(
        appCode(await updateProfile(owner.token, businessId, input)),
        JSON.stringify(input),
      ).toBe('validation')
    }
    const { data: after } = await profileOf(owner.token, businessId)
    expect(after?.version).toBe(profile?.version)
  })

  it('switching VAT off turns off VAT Center (hidden, not deleted) and clears the TRN; on again brings it back', async () => {
    const owner = await newUser()
    const businessId = await setupBusiness(handler, owner.token, WORKSHOP)
    let { data: profile } = await profileOf(owner.token, businessId)
    const on = await updateProfile(owner.token, businessId, {
      version: profile!.version,
      legalName: 'W',
      legalNameAr: null,
      vatRegistered: true,
      trn: '100234567890123',
    })
    expect(on.error).toBeUndefined()
    const off = await updateProfile(owner.token, businessId, {
      version: on.data!.profile.version,
      legalName: 'W',
      legalNameAr: null,
      vatRegistered: false,
      trn: null,
    })
    expect(off.error).toBeUndefined()
    expect(off.data?.turnedOff).toEqual(['vat_center'])
    expect(off.data?.profile).toMatchObject({ vatRegistered: false, trn: null })
    expect(await moduleRow(businessId, 'vat_center')).toBe(false)
    const context = await query<BusinessContextDto>(handler, 'business.context', {
      token: owner.token,
      businessId,
    })
    expect(context.data?.capabilities.vat_registered).toBe(false)

    profile = off.data!.profile
    const again = await updateProfile(owner.token, businessId, {
      version: profile.version,
      legalName: 'W',
      legalNameAr: null,
      vatRegistered: true,
      trn: '100234567890123',
    })
    expect(again.data?.turnedOn).toEqual(['vat_center'])
    expect(await moduleRow(businessId, 'vat_center')).toBe(true)
  })

  it('refuses a stale version (CONFLICT) and changes nothing', async () => {
    const owner = await newUser()
    const businessId = await setupBusiness(handler, owner.token, WORKSHOP, { name: 'Before' })
    const { data: profile } = await profileOf(owner.token, businessId)
    const input = {
      version: profile!.version,
      legalName: 'First',
      legalNameAr: null,
      vatRegistered: false,
      trn: null,
    }
    expect((await updateProfile(owner.token, businessId, input)).error).toBeUndefined()
    const stale = await updateProfile(owner.token, businessId, { ...input, legalName: 'Second' })
    expect(appCode(stale)).toBe('conflict')
    expect((await profileOf(owner.token, businessId)).data?.legalName).toBe('First')
  })

  it('sets the business language', async () => {
    const owner = await newUser()
    const businessId = await setupBusiness(handler, owner.token, WORKSHOP)
    const result = await mutate<BusinessProfileDto>(handler, 'business.setDefaultLocale', {
      token: owner.token,
      businessId,
      input: { defaultLocale: 'ar' },
    })
    expect(result.data?.defaultLocale).toBe('ar')
    const bad = await mutate(handler, 'business.setDefaultLocale', {
      token: owner.token,
      businessId,
      input: { defaultLocale: 'fr' },
    })
    expect(appCode(bad)).toBe('validation')
  })

  it('follows the role templates: view for owner/admin/manager/accountant, edit for owner/admin only', async () => {
    const { owner, businessId, members } = await workshopWithTeam()
    const expectations: [string, { token: string }, boolean, boolean][] = [
      ['owner', owner, true, true],
      ['admin', members.admin, true, true],
      ['manager', members.manager, true, false],
      ['accountant', members.accountant, true, false],
      ['sales', members.sales, false, false],
      ['supervisor', members.supervisor, false, false],
      ['employee', members.employee, false, false],
    ]
    for (const [name, { token }, canView, canEdit] of expectations) {
      const view = await profileOf(token, businessId)
      expect(view.error?.data.appCode, `${name} view`).toBe(canView ? undefined : 'forbidden')
      const version = (await profileOf(owner.token, businessId)).data!.version
      const edit = await updateProfile(token, businessId, {
        version,
        legalName: `By ${name}`,
        legalNameAr: null,
        vatRegistered: false,
        trn: null,
      })
      expect(edit.error?.data.appCode, `${name} edit`).toBe(canEdit ? undefined : 'forbidden')
      for (const path of ['business.setDefaultLocale', 'business.logoUploadUrl']) {
        const input =
          path === 'business.setDefaultLocale'
            ? { defaultLocale: 'en' }
            : { contentType: 'image/png' }
        const write = await mutate(handler, path, { token, businessId, input })
        expect(write.error?.data.appCode, `${name} ${path}`).toBe(canEdit ? undefined : 'forbidden')
      }
    }
  })

  it('never shows or changes another business (cross-tenant)', async () => {
    const a = await newUser()
    const b = await newUser()
    const bizA = await setupBusiness(handler, a.token, WORKSHOP, { name: 'A' })
    const bizB = await setupBusiness(handler, b.token, WORKSHOP, { name: 'B' })
    expect(appCode(await profileOf(a.token, bizB))).toBe('forbidden')
    const { data: profileB } = await profileOf(b.token, bizB)
    const attack = await updateProfile(a.token, bizB, {
      version: profileB!.version,
      legalName: 'Hacked',
      legalNameAr: null,
      vatRegistered: false,
      trn: null,
    })
    expect(appCode(attack)).toBe('forbidden')
    expect((await profileOf(b.token, bizB)).data?.legalName).toBe('B')
    expect((await profileOf(a.token, bizA)).data?.legalName).toBe('A')
  })
})

describe('business.customization / business.customize', () => {
  function customize(token: string, businessId: string, item: object, enabled: boolean) {
    return mutate<CustomizeDto>(handler, 'business.customize', {
      token,
      businessId,
      input: { item, enabled },
    })
  }

  it('lists the switchable modules (planned ones as planned) and the capabilities', async () => {
    const owner = await newUser()
    const businessId = await setupBusiness(handler, owner.token, WORKSHOP)
    const result = await query<CustomizationDto>(handler, 'business.customization', {
      token: owner.token,
      businessId,
    })
    expect(result.error).toBeUndefined()
    const ids = result.data!.modules.map((m) => m.id)
    expect(ids).not.toContain('dashboard')
    expect(ids).not.toContain('settings')
    expect(result.data!.modules.find((m) => m.id === 'employees')).toEqual({
      id: 'employees',
      kind: 'optional',
      availability: 'planned',
      enabled: true,
    })
    expect(result.data!.capabilities).toMatchObject({
      has_team: true,
      multi_location: true,
      vat_registered: true,
    })
    expect(result.data!.teamInUse).toBe(false)
    expect(result.data!.locationsInUse).toBe(false)
  })

  it('turning the team off turns off what needs it; the team screens then answer CAPABILITY_DISABLED', async () => {
    const owner = await newUser()
    const businessId = await setupBusiness(handler, owner.token, WORKSHOP)
    const result = await customize(
      owner.token,
      businessId,
      { kind: 'capability', key: 'has_team' },
      false,
    )
    expect(result.error).toBeUndefined()
    expect(result.data?.turnedOff).toEqual([
      { kind: 'module', id: 'employees' },
      { kind: 'module', id: 'attendance' },
      { kind: 'module', id: 'payroll' },
      { kind: 'module', id: 'petty_cash' },
    ])
    expect(result.data?.customization.capabilities.has_team).toBe(false)
    expect(await moduleRow(businessId, 'payroll')).toBe(false)
    const [capability] = await admin<{ enabled: boolean; source: string }[]>`
      select enabled, source from app.business_capabilities
       where business_id = ${businessId} and key = 'has_team'`
    expect(capability).toEqual({ enabled: false, source: 'user' })
    for (const path of ['member.list', 'invitation.list', 'role.list']) {
      const denied = await query(handler, path, { token: owner.token, businessId })
      expect(appCode(denied), path).toBe('capability_disabled')
    }
    // On again: its anchor module comes back.
    const back = await customize(
      owner.token,
      businessId,
      { kind: 'capability', key: 'has_team' },
      true,
    )
    expect(back.data?.turnedOn).toEqual([{ kind: 'module', id: 'employees' }])
    expect(
      (await query(handler, 'member.list', { token: owner.token, businessId })).error,
    ).toBeUndefined()
  })

  it('refuses to turn the team off while it has other members or pending invitations', async () => {
    const owner = await newUser()
    const businessId = await setupBusiness(handler, owner.token, WORKSHOP)
    const member = await newUser()
    const memberId = await join(db, owner.user, businessId, member.user, 'employee')
    const item = { kind: 'capability', key: 'has_team' }
    expect(appCode(await customize(owner.token, businessId, item, false))).toBe('team_in_use')
    const customization = await query<CustomizationDto>(handler, 'business.customization', {
      token: owner.token,
      businessId,
    })
    expect(customization.data?.teamInUse).toBe(true)
    const removed = await mutate(handler, 'member.remove', {
      token: owner.token,
      businessId,
      input: { memberId },
    })
    expect(removed.error).toBeUndefined()
    expect((await customize(owner.token, businessId, item, false)).error).toBeUndefined()
  })

  it('refuses to turn multi-location off while there is more than one location', async () => {
    const owner = await newUser()
    const businessId = await setupBusiness(handler, owner.token, WORKSHOP)
    const second = await mutate<LocationDto>(handler, 'location.create', {
      token: owner.token,
      businessId,
      input: { id: newId(), name: 'Second branch' },
    })
    expect(second.error).toBeUndefined()
    const item = { kind: 'capability', key: 'multi_location' }
    expect(appCode(await customize(owner.token, businessId, item, false))).toBe('locations_in_use')
    await mutate(handler, 'location.remove', {
      token: owner.token,
      businessId,
      input: { id: second.data!.id },
    })
    expect((await customize(owner.token, businessId, item, false)).error).toBeUndefined()
    const denied = await query(handler, 'location.list', { token: owner.token, businessId })
    expect(appCode(denied)).toBe('capability_disabled')
  })

  it('applies dependency rules and keeps rows (disabling hides, never deletes)', async () => {
    const owner = await newUser()
    const businessId = await setupBusiness(handler, owner.token, WORKSHOP)
    const off = await customize(owner.token, businessId, { kind: 'module', id: 'customers' }, false)
    expect(off.error).toBeUndefined()
    expect(off.data?.turnedOff).toEqual([
      { kind: 'module', id: 'orders' },
      { kind: 'module', id: 'quotations' },
      { kind: 'module', id: 'invoices' },
    ])
    expect(await moduleRow(businessId, 'customers')).toBe(false)
    expect(await moduleRow(businessId, 'quotations')).toBe(false)
    const on = await customize(owner.token, businessId, { kind: 'module', id: 'quotations' }, true)
    expect(on.data?.turnedOn).toEqual([{ kind: 'module', id: 'customers' }])
    expect(await moduleRow(businessId, 'customers')).toBe(true)
  })

  it('refuses Dashboard, Settings, VAT, unknown items and a module that needs VAT while VAT is off', async () => {
    const owner = await newUser()
    const businessId = await setupBusiness(handler, owner.token, BAKER)
    for (const [item, enabled] of [
      [{ kind: 'module', id: 'settings' }, false],
      [{ kind: 'module', id: 'dashboard' }, false],
      [{ kind: 'module', id: 'nope' }, true],
      [{ kind: 'capability', key: 'nope' }, true],
      [{ kind: 'capability', key: 'vat_registered' }, true],
      [{ kind: 'module', id: 'vat_center' }, true],
    ] as const) {
      const result = await customize(owner.token, businessId, item, enabled)
      expect(appCode(result), JSON.stringify(item)).toBe('validation')
    }
  })

  it('is for settings.modules.manage only (owner and admin)', async () => {
    const { owner, businessId, members } = await workshopWithTeam()
    const item = { kind: 'capability', key: 'uses_machines' }
    for (const template of ['manager', 'accountant', 'sales', 'supervisor', 'employee'] as const) {
      const { token } = members[template]
      expect(appCode(await query(handler, 'business.customization', { token, businessId }))).toBe(
        'forbidden',
      )
      expect(appCode(await customize(token, businessId, item, false)), template).toBe('forbidden')
    }
    expect((await customize(members.admin.token, businessId, item, false)).error).toBeUndefined()
    expect((await customize(owner.token, businessId, item, true)).error).toBeUndefined()
  })

  it('cannot switch another business', async () => {
    const a = await newUser()
    const b = await newUser()
    await setupBusiness(handler, a.token, WORKSHOP)
    const bizB = await setupBusiness(handler, b.token, WORKSHOP)
    const attack = await customize(a.token, bizB, { kind: 'capability', key: 'keeps_stock' }, false)
    expect(appCode(attack)).toBe('forbidden')
    expect(await moduleRow(bizB, 'inventory')).toBe(true)
  })
})

describe('location.*', () => {
  it('is refused for a single-location business (CAPABILITY_DISABLED)', async () => {
    const owner = await newUser()
    const businessId = await setupBusiness(handler, owner.token, BAKER)
    expect(appCode(await query(handler, 'location.list', { token: owner.token, businessId }))).toBe(
      'capability_disabled',
    )
    const create = await mutate(handler, 'location.create', {
      token: owner.token,
      businessId,
      input: { id: newId(), name: 'Kitchen 2' },
    })
    expect(appCode(create)).toBe('capability_disabled')
    const [row] = await admin<{ n: number }[]>`
      select count(*)::int as n from app.locations where business_id = ${businessId}`
    expect(row?.n).toBe(1)
  })

  it('creates (idempotently), renames, moves the default and removes locations', async () => {
    const owner = await newUser()
    const businessId = await setupBusiness(handler, owner.token, WORKSHOP)
    const call = <T>(path: string, input?: unknown) =>
      input === undefined
        ? query<T>(handler, path, { token: owner.token, businessId })
        : mutate<T>(handler, path, { token: owner.token, businessId, input })

    const [main] = (await call<LocationDto[]>('location.list')).data!
    expect(main?.isDefault).toBe(true)

    const id = newId()
    const created = await call<LocationDto>('location.create', { id, name: ' Marina ' })
    expect(created.data).toMatchObject({ id, name: 'Marina', isDefault: false })
    const retried = await call<LocationDto>('location.create', { id, name: 'Marina' })
    expect(retried.data?.id).toBe(id)
    expect(appCode(await call('location.create', { id, name: 'Other' }))).toBe('conflict')

    const renamed = await call<LocationDto>('location.rename', {
      id,
      name: 'Dubai Marina',
      version: created.data!.version,
    })
    expect(renamed.data?.name).toBe('Dubai Marina')
    const stale = await call('location.rename', { id, name: 'X', version: created.data!.version })
    expect(appCode(stale)).toBe('conflict')

    const moved = await call<LocationDto[]>('location.setDefault', { id })
    expect(moved.data?.map((l) => [l.id, l.isDefault])).toEqual([
      [id, true],
      [main!.id, false],
    ])
    expect(appCode(await call('location.remove', { id }))).toBe('default_location')
    expect((await call('location.remove', { id: main!.id })).data).toEqual({ ok: true })
    expect((await call<LocationDto[]>('location.list')).data?.map((l) => l.id)).toEqual([id])
    const [row] = await admin<{ deleted: boolean }[]>`
      select deleted_at is not null as deleted from app.locations where id = ${main!.id}`
    expect(row?.deleted).toBe(true)
    expect(appCode(await call('location.remove', { id: main!.id }))).toBe('not_found')
    expect(appCode(await call('location.remove', { id: newId() }))).toBe('not_found')
  })

  it('is for settings.locations.manage (owner, admin, manager)', async () => {
    const { owner, businessId, members } = await workshopWithTeam()
    const allowed = new Set(['admin', 'manager'])
    for (const [template, { token }] of Object.entries(members)) {
      const list = await query(handler, 'location.list', { token, businessId })
      expect(list.error?.data.appCode, template).toBe(
        allowed.has(template) ? undefined : 'forbidden',
      )
    }
    expect(
      (await query(handler, 'location.list', { token: owner.token, businessId })).error,
    ).toBeUndefined()
  })

  it('cannot touch another business’s locations', async () => {
    const a = await newUser()
    const b = await newUser()
    const bizA = await setupBusiness(handler, a.token, WORKSHOP)
    const bizB = await setupBusiness(handler, b.token, WORKSHOP)
    const [locationB] = (
      await query<LocationDto[]>(handler, 'location.list', { token: b.token, businessId: bizB })
    ).data!
    // In A's context B's location does not exist; with B's id the caller is not a member.
    const rename = await mutate(handler, 'location.rename', {
      token: a.token,
      businessId: bizA,
      input: { id: locationB!.id, name: 'Hacked', version: locationB!.version },
    })
    expect(appCode(rename)).toBe('not_found')
    expect(
      appCode(
        await mutate(handler, 'location.setDefault', {
          token: a.token,
          businessId: bizB,
          input: { id: locationB!.id },
        }),
      ),
    ).toBe('forbidden')
    const [row] = await admin<{ name: string }[]>`
      select name from app.locations where id = ${locationB!.id}`
    expect(row?.name).not.toBe('Hacked')
  })
})

import type {
  BusinessProfileDto,
  InvitationDto,
  LocationDto,
  LogoUploadUrlDto,
  RoleDto,
} from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import { QUESTION_SET_VERSION } from '@bizcost/modules'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { appRouter } from '../../src'
import { mintToken, mutate, query, type CallResult, type TestUser } from '../helpers'
import { join, setupBusiness, WORKSHOP } from '../settings'
import {
  callProcedure,
  createTenant,
  openApi,
  PNG,
  proceduresOf,
  uploadTo,
  type Api,
  type Person,
  type ProcedureType,
  type Tenant,
} from './fixture'

// Audit coverage (ROADMAP.md M1 definition of done: "every write of business data is in audit_log
// with actor and request_id"; DATA_MODEL.md §1.6). For EVERY mutation of appRouter, walked from the
// router, one representative successful call in a real business, then: its audit_log rows carry the
// request's x-request-id, the caller as actor_user_id and the business the write belongs to — at least
// one row, unless AUDIT says why the mutation writes no business data. Queries are read as well: they
// write no audited row (a GET skips the Origin check, so a query must not change business data).
//
// The two documented exceptions (D-103) are exercised below, not assumed: account-level `profiles`
// writes are not audited (the profile `me` creates, a language or name saved by an account with no
// business, the business opened last; profiles are account rows, D-050), and `me`, the one query that
// writes business rows, copies the caller's own verified email to their memberships when it changed
// (D-083): exactly one audited update per membership, of the email alone, by the caller.
//
// A mutation added without an AUDIT entry fails the first test.

interface Done {
  result: CallResult
  actor: TestUser
  /** The business the audit rows belong to. */
  businessId: string
}

interface AuditProbe {
  /** Why the call writes no audit row; absent: at least one row is expected. */
  noAudit?: string
  run: () => Promise<Done>
}

let api: Api
let tenant: Tenant

beforeAll(async () => {
  api = openApi()
  tenant = await createTenant(api, 'Audit')
}, 60_000)

afterAll(async () => {
  await api.close()
})

function call<T>(
  person: Person,
  path: string,
  type: ProcedureType,
  input?: unknown,
  businessId: string | undefined = tenant.id,
) {
  return callProcedure<T>(api.handler, { path, type }, person.token, { businessId, input })
}

async function ok<T>(pending: Promise<CallResult<T>>): Promise<T> {
  const result = await pending
  expect(result.error, result.raw).toBeUndefined()
  return result.data as T
}

/** A new account that is an active member of the tenant with the business's `template` role. */
async function newMember(template: 'employee' | 'admin' = 'employee') {
  const person = await api.newPerson()
  const memberId = await join(api.db, tenant.owner.user, tenant.id, person.user, template)
  return { person, memberId }
}

async function newLocation(): Promise<LocationDto> {
  return ok(call(tenant.owner, 'location.create', 'mutation', { id: newId(), name: newId() }))
}

async function newInvitation(email = `audit-${newId()}@test.bizcost.local`) {
  return ok(
    call<InvitationDto>(tenant.owner, 'invitation.create', 'mutation', {
      id: newId(),
      email,
      roleId: tenant.roles.employee.id,
      locale: 'en',
    }),
  )
}

async function uploadedLogo(): Promise<string> {
  const upload = await ok(
    call<LogoUploadUrlDto>(tenant.owner, 'business.logoUploadUrl', 'mutation', {
      contentType: 'image/png',
    }),
  )
  expect((await uploadTo(upload.uploadUrl, PNG, 'image/png')).ok).toBe(true)
  return upload.path
}

async function asOwner(path: string, input?: unknown): Promise<Done> {
  return {
    result: await call(tenant.owner, path, 'mutation', input),
    actor: tenant.owner.user,
    businessId: tenant.id,
  }
}

const AUDIT: Record<string, AuditProbe> = {
  'account.updateProfile': {
    run: async () => {
      // A new name is copied to the caller's memberships (D-065): those rows are audited.
      const { person } = await newMember()
      const result = await call(person, 'account.updateProfile', 'mutation', {
        displayName: `Renamed ${newId().slice(-6)}`,
      })
      return { result, actor: person.user, businessId: tenant.id }
    },
  },
  'account.setLastBusiness': {
    noAudit:
      'writes only profiles.last_business_id, the account’s own preference outside any business; ' +
      'profiles are account rows, not business data, and have no audit trigger (D-050)',
    run: async () => ({
      result: await call(tenant.admin, 'account.setLastBusiness', 'mutation', {
        businessId: tenant.id,
      }),
      actor: tenant.admin.user,
      businessId: tenant.id,
    }),
  },
  'account.delete': {
    run: async () => {
      const { person } = await newMember()
      const result = await call(person, 'account.delete', 'mutation')
      return { result, actor: person.user, businessId: tenant.id }
    },
  },
  'business.createFromSetup': {
    run: async () => {
      const person = await api.newPerson()
      const businessId = newId()
      const result = await call(
        person,
        'business.createFromSetup',
        'mutation',
        {
          businessId,
          legalName: 'Audit New Business',
          locale: 'en',
          questionSetVersion: QUESTION_SET_VERSION,
          answers: WORKSHOP,
          adjustments: { modules: [], capabilities: [] },
        },
        undefined,
      )
      return { result, actor: person.user, businessId }
    },
  },
  'business.updateProfile': {
    run: async () => {
      const profile = await ok(call<BusinessProfileDto>(tenant.owner, 'business.profile', 'query'))
      return asOwner('business.updateProfile', {
        version: profile.version,
        legalName: profile.legalName,
        legalNameAr: `اسم ${newId().slice(-6)}`,
        vatRegistered: profile.vatRegistered,
        trn: profile.trn,
      })
    },
  },
  'business.setDefaultLocale': {
    run: async () => {
      const profile = await ok(call<BusinessProfileDto>(tenant.owner, 'business.profile', 'query'))
      return asOwner('business.setDefaultLocale', {
        defaultLocale: profile.defaultLocale === 'en' ? 'ar' : 'en',
      })
    },
  },
  'business.logoUploadUrl': {
    run: () => asOwner('business.logoUploadUrl', { contentType: 'image/png' }),
  },
  'business.setLogo': {
    run: async () => asOwner('business.setLogo', { path: await uploadedLogo() }),
  },
  'business.removeLogo': {
    run: async () => {
      await ok(call(tenant.owner, 'business.setLogo', 'mutation', { path: await uploadedLogo() }))
      return asOwner('business.removeLogo')
    },
  },
  'business.customize': {
    run: async () => {
      const customization = await ok(
        call<{ capabilities: Record<string, boolean> }>(
          tenant.owner,
          'business.customization',
          'query',
        ),
      )
      return asOwner('business.customize', {
        item: { kind: 'capability', key: 'uses_machines' },
        enabled: !customization.capabilities.uses_machines,
      })
    },
  },
  'location.create': {
    run: () => asOwner('location.create', { id: newId(), name: `Audit ${newId().slice(-6)}` }),
  },
  'location.rename': {
    run: async () => {
      const location = await newLocation()
      return asOwner('location.rename', {
        id: location.id,
        name: `Renamed ${newId().slice(-6)}`,
        version: location.version,
      })
    },
  },
  'location.setDefault': {
    run: async () => asOwner('location.setDefault', { id: (await newLocation()).id }),
  },
  'location.remove': {
    run: async () => asOwner('location.remove', { id: (await newLocation()).id }),
  },
  'member.changeRole': {
    run: async () => {
      const { memberId } = await newMember()
      return asOwner('member.changeRole', { memberId, roleId: tenant.roles.sales.id })
    },
  },
  'member.remove': {
    run: async () => asOwner('member.remove', { memberId: (await newMember()).memberId }),
  },
  'member.leave': {
    run: async () => {
      const { person } = await newMember()
      return {
        result: await call(person, 'member.leave', 'mutation'),
        actor: person.user,
        businessId: tenant.id,
      }
    },
  },
  'member.transferOwnership': {
    run: async () => {
      // In a business of its own, so the tenant keeps its owner.
      const owner = await api.newPerson()
      const businessId = await setupBusiness(api.handler, owner.token, WORKSHOP)
      const heir = await api.newPerson()
      const memberId = await join(api.db, owner.user, businessId, heir.user, 'admin')
      const result = await call(
        owner,
        'member.transferOwnership',
        'mutation',
        { memberId },
        businessId,
      )
      return { result, actor: owner.user, businessId }
    },
  },
  'invitation.create': {
    run: () =>
      asOwner('invitation.create', {
        id: newId(),
        email: `audit-${newId()}@test.bizcost.local`,
        roleId: tenant.roles.employee.id,
        locale: 'en',
      }),
  },
  'invitation.resend': {
    run: async () => asOwner('invitation.resend', { id: (await newInvitation()).id }),
  },
  'invitation.revoke': {
    run: async () => asOwner('invitation.revoke', { id: (await newInvitation()).id }),
  },
  'invitation.accept': {
    run: async () => {
      const person = await api.newPerson()
      await newInvitation(person.user.email)
      const result = await call(
        person,
        'invitation.accept',
        'mutation',
        { token: api.emails.tokenFor(person.user.email) },
        undefined,
      )
      return { result, actor: person.user, businessId: tenant.id }
    },
  },
  'role.updatePermissions': {
    run: async () => {
      const roles = await ok(call<RoleDto[]>(tenant.owner, 'role.list', 'query'))
      const sales = roles.find((role) => role.templateKey === 'sales')
      if (!sales) throw new Error('no sales role')
      const keys = new Set(sales.permissionKeys)
      if (keys.has('settings.business.view')) keys.delete('settings.business.view')
      else keys.add('settings.business.view')
      return asOwner('role.updatePermissions', {
        id: sales.id,
        version: sales.version,
        permissionKeys: [...keys],
      })
    },
  },
}

const PROCEDURES = proceduresOf(appRouter)
const MUTATIONS = PROCEDURES.filter((p) => p.type === 'mutation').map((p) => p.path)
const QUERIES = PROCEDURES.filter((p) => p.type === 'query')

async function auditRows(requestId: string) {
  return api.admin<{ business_id: string; actor_user_id: string | null; entity: string }[]>`
    select business_id, actor_user_id, entity from app.audit_log
     where request_id = ${requestId} order by id`
}

describe('audit coverage', () => {
  it('has one probe per mutation of appRouter', () => {
    expect(Object.keys(AUDIT).sort()).toEqual(MUTATIONS)
  })

  it.each(MUTATIONS)(
    '%s: its writes are audited with the caller and the request id',
    async (path) => {
      const probe = AUDIT[path]
      if (!probe) throw new Error(`${path} has no audit probe`)
      const { result, actor, businessId } = await probe.run()
      expect(result.error, result.raw).toBeUndefined()
      const requestId = result.headers.get('x-request-id') ?? ''
      expect(requestId).toMatch(/^[0-9a-f-]{36}$/)
      const rows = await auditRows(requestId)
      if (probe.noAudit) {
        expect(rows, probe.noAudit).toEqual([])
        return
      }
      expect(rows.length, 'at least one audit row').toBeGreaterThan(0)
      for (const row of rows) {
        expect(row, row.entity).toMatchObject({ actor_user_id: actor.id, business_id: businessId })
      }
    },
  )

  it.each(QUERIES.map((p) => [p.path, p] as const))(
    '%s (a query) writes no audited row',
    async (_path, procedure) => {
      const input =
        procedure.path === 'invitation.preview' ? { token: tenant.invitationToken } : undefined
      const result = await callProcedure(api.handler, procedure, tenant.owner.token, {
        businessId: procedure.base === 'business' ? tenant.id : undefined,
        input,
      })
      expect(result.error, result.raw).toBeUndefined()
      expect(await auditRows(result.headers.get('x-request-id') ?? '')).toEqual([])
    },
  )
})

describe('the documented exceptions (D-103), exercised', () => {
  interface AuditChange {
    business_id: string
    actor_user_id: string | null
    entity: string
    entity_id: string
    action: string
    changes: { before?: Record<string, unknown>; after?: Record<string, unknown> }
  }

  async function auditChanges(result: CallResult) {
    return api.admin<AuditChange[]>`
      select business_id, actor_user_id, entity, entity_id, action, changes from app.audit_log
       where request_id = ${result.headers.get('x-request-id') ?? ''} order by id`
  }

  /** Kept by app.touch_row() on every update. */
  const TOUCH_COLUMNS: ReadonlySet<string> = new Set(['updated_at', 'updated_by', 'version'])

  /** The columns an update changed (before vs after). */
  function changedColumns(change: AuditChange['changes']): string[] {
    const before = change.before ?? {}
    const after = change.after ?? {}
    return Object.keys({ ...before, ...after })
      .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
      .sort()
  }

  it('`me` after the account’s email changed: one audited update per membership, of the email alone, by the caller; then none', async () => {
    const person = await api.newPerson()
    const tenantMemberId = await join(api.db, tenant.owner.user, tenant.id, person.user, 'employee')
    const ownBusinessId = await setupBusiness(api.handler, person.token, WORKSHOP)

    // The member's confirmed email change: their next token carries the new address.
    const moved = { ...person.user, email: `moved-${newId()}@test.bizcost.local` }
    await api.admin`update auth.users set email = ${moved.email} where id = ${person.user.id}`
    const token = await mintToken(moved)
    const first = await query(api.handler, 'me', { token })
    expect(first.error, first.raw).toBeUndefined()

    const rows = await auditChanges(first)
    expect(rows.map((row) => row.business_id).sort()).toEqual([tenant.id, ownBusinessId].sort())
    for (const row of rows) {
      expect(row).toMatchObject({
        actor_user_id: person.user.id,
        entity: 'business_members',
        action: 'update',
      })
      // Only the token's own verified email is written (a cross-site GET can set nothing else).
      const changed = changedColumns(row.changes)
      expect(changed).toContain('email')
      expect(changed.filter((column) => !TOUCH_COLUMNS.has(column))).toEqual(['email'])
      expect(row.changes.after?.email).toBe(moved.email)
      expect(row.changes.after?.user_id).toBe(person.user.id)
    }
    expect(rows.map((row) => row.entity_id)).toContain(tenantMemberId)

    const again = await query(api.handler, 'me', { token })
    expect(again.error, again.raw).toBeUndefined()
    expect(await auditChanges(again), 'a second `me` writes nothing').toEqual([])
  })

  it('account-level profile writes are not audited: the profile `me` creates, a language, a name without a business', async () => {
    const person = await api.newPerson()
    // First `me`: the profile is created (an account row), no business row is written.
    const first = await query(api.handler, 'me', { token: person.token })
    expect(first.error, first.raw).toBeUndefined()
    expect(await auditChanges(first)).toEqual([])
    // A name saved by an account with no business: only profiles changes.
    const named = await mutate(api.handler, 'account.updateProfile', {
      token: person.token,
      input: { displayName: `Solo ${newId().slice(-6)}` },
    })
    expect(named.error, named.raw).toBeUndefined()
    expect(await auditChanges(named)).toEqual([])

    // A member's language (the language switch): profiles only, even with memberships.
    const { person: member } = await newMember()
    const language = await mutate(api.handler, 'account.updateProfile', {
      token: member.token,
      input: { locale: 'ar' },
    })
    expect(language.error, language.raw).toBeUndefined()
    expect(await auditChanges(language)).toEqual([])
  })
})

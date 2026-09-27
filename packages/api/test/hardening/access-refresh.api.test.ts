import type { BusinessContextDto, MeDto, RoleDto } from '@bizcost/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { appRouter } from '../../src'
import { batch, query } from '../helpers'
import { join } from '../settings'
import {
  callProcedure,
  createTenant,
  leaksOf,
  openApi,
  proceduresOf,
  type Api,
  type Person,
  type Tenant,
} from './fixture'

// The API side of two M1 definition-of-done points (ROADMAP.md; ARCHITECTURE.md §Data fetching):
//   - "Stale me/permissions refresh after FORBIDDEN": when a member's access changes, their next
//     request — also the refused one — sends the new x-permissions-version, and business.context has
//     the new permissions under the same version; a removed member gets FORBIDDEN without a version
//     and `me` no longer lists the business.
//   - "No cache leak between businesses": one account that is an Admin in two businesses, served by
//     one API instance (its per-request memo and its signed-URL cache), requests alternating between
//     the businesses and batches of every business query: each answer holds its own business's data
//     only, and `me` gives each membership its own logo.
// The browser side (the page refetching after FORBIDDEN without a reload, two tabs on two
// businesses) is Playwright's (tests/e2e).

let api: Api
let A: Tenant
let B: Tenant
let both: Person

beforeAll(async () => {
  api = openApi()
  A = await createTenant(api, 'A')
  B = await createTenant(api, 'B')
  both = await api.newPerson()
  await join(api.db, A.owner.user, A.id, both.user, 'admin')
  await join(api.db, B.owner.user, B.id, both.user, 'admin')
}, 120_000)

afterAll(async () => {
  await api.close()
})

function context(person: Person, businessId: string) {
  return query<BusinessContextDto>(api.handler, 'business.context', {
    token: person.token,
    businessId,
  })
}

function version(result: { headers: Headers }): number {
  return Number(result.headers.get('x-permissions-version'))
}

describe('stale permissions: the next request tells', () => {
  it('a role edit: the refused call already carries the new version, and the context agrees', async () => {
    const manager = await api.newPerson()
    await join(api.db, A.owner.user, A.id, manager.user, 'manager')
    const bystander = await api.newPerson()
    await join(api.db, A.owner.user, A.id, bystander.user, 'employee')
    const before = await context(manager, A.id)
    const bystanderBefore = version(await context(bystander, A.id))
    expect(before.data?.permissions.keys).toContain('settings.business.view')
    expect(
      (await query(api.handler, 'business.profile', { token: manager.token, businessId: A.id }))
        .error,
    ).toBeUndefined()

    // The owner takes "see the business profile" away from the Manager role.
    const roles = await query<RoleDto[]>(api.handler, 'role.list', {
      token: A.owner.token,
      businessId: A.id,
    })
    const role = roles.data?.find((r) => r.templateKey === 'manager')
    if (!role) throw new Error('no manager role')
    const edited = await callProcedure(
      api.handler,
      { path: 'role.updatePermissions', type: 'mutation' },
      A.owner.token,
      {
        businessId: A.id,
        input: {
          id: role.id,
          version: role.version,
          permissionKeys: role.permissionKeys.filter((key) => key !== 'settings.business.view'),
        },
      },
    )
    expect(edited.error, edited.raw).toBeUndefined()

    const refused = await query(api.handler, 'business.profile', {
      token: manager.token,
      businessId: A.id,
    })
    expect(refused.error?.data.appCode).toBe('forbidden')
    expect(version(refused)).toBeGreaterThan(version(before))
    const after = await context(manager, A.id)
    expect(version(after)).toBe(version(refused))
    expect(after.data?.permissionsVersion).toBe(version(refused))
    expect(after.data?.permissions.keys).not.toContain('settings.business.view')
    // Members of other roles keep their version (nothing to refetch).
    expect(version(await context(bystander, A.id))).toBe(bystanderBefore)
  })

  it('a role change: the refused call carries the new version', async () => {
    const lead = await api.newPerson()
    const memberId = await join(api.db, A.owner.user, A.id, lead.user, 'manager')
    const before = version(await context(lead, A.id))
    const changed = await callProcedure(
      api.handler,
      { path: 'member.changeRole', type: 'mutation' },
      A.owner.token,
      { businessId: A.id, input: { memberId, roleId: A.roles.employee.id } },
    )
    expect(changed.error, changed.raw).toBeUndefined()
    const refused = await query(api.handler, 'member.list', {
      token: lead.token,
      businessId: A.id,
    })
    expect(refused.error?.data.appCode).toBe('forbidden')
    expect(version(refused)).toBe(before + 1)
    expect((await context(lead, A.id)).data?.roleTemplateKey).toBe('employee')
  })

  it('a removed member: FORBIDDEN without a version, and `me` drops the business', async () => {
    const leaver = await api.newPerson()
    const memberId = await join(api.db, A.owner.user, A.id, leaver.user, 'employee')
    expect((await context(leaver, A.id)).status).toBe(200)
    const removed = await callProcedure(
      api.handler,
      { path: 'member.remove', type: 'mutation' },
      A.owner.token,
      { businessId: A.id, input: { memberId } },
    )
    expect(removed.error, removed.raw).toBeUndefined()
    const refused = await context(leaver, A.id)
    expect(refused.error?.data.appCode).toBe('forbidden')
    expect(refused.headers.get('x-permissions-version')).toBeNull()
    const me = await query<MeDto>(api.handler, 'me', { token: leaver.token })
    expect(me.data?.memberships.map((m) => m.businessId)).not.toContain(A.id)
  })
})

describe('no cache leak between businesses (one API instance, one account in two businesses)', () => {
  const QUERIES = proceduresOf(appRouter).filter((p) => p.base === 'business' && p.type === 'query')

  it('alternating requests: each answer holds only its own business', async () => {
    for (let round = 0; round < 2; round++) {
      for (const [own, other] of [
        [A, B],
        [B, A],
      ] as const) {
        for (const procedure of QUERIES) {
          const result = await callProcedure(api.handler, procedure, both.token, {
            businessId: own.id,
          })
          expect(result.error, `${procedure.path} in ${own.label}: ${result.raw}`).toBeUndefined()
          expect(leaksOf(result.raw, other), `${procedure.path} in ${own.label}`).toEqual([])
        }
      }
    }
  })

  it('a batch of every business query answers for the one business it names', async () => {
    for (const [own, other] of [
      [A, B],
      [B, A],
    ] as const) {
      const answer = await batch(
        api.handler,
        QUERIES.map((p) => p.path),
        { token: both.token, businessId: own.id },
      )
      expect(answer.status).toBe(200)
      expect(answer.results.every((r) => r.result !== undefined)).toBe(true)
      expect(leaksOf(JSON.stringify(answer.results), other)).toEqual([])
      expect(leaksOf(JSON.stringify(answer.results), own).length).toBeGreaterThan(0)
    }
  })

  it('the version header and the context follow the business named, not the one before', async () => {
    // Bump the account's version in A only.
    const [member] = await api.admin<{ id: string }[]>`
      select id from app.business_members where business_id = ${A.id} and user_id = ${both.user.id}`
    await api.admin`
      update app.business_members set permissions_version = permissions_version + 5
       where id = ${member?.id ?? ''}`
    const inA = await context(both, A.id)
    const inB = await context(both, B.id)
    const inAAgain = await context(both, A.id)
    expect(version(inA)).toBe(version(inAAgain))
    expect(version(inB)).not.toBe(version(inA))
    expect(inB.data?.permissionsVersion).toBe(version(inB))
  })

  it('an Admin of A who is an Employee of B has exactly the Employee’s access in B', async () => {
    const mixed = await api.newPerson()
    await join(api.db, A.owner.user, A.id, mixed.user, 'admin')
    await join(api.db, B.owner.user, B.id, mixed.user, 'employee')
    const codes = async (person: Person, businessId: string) => {
      const answer = await batch(
        api.handler,
        QUERIES.map((p) => p.path),
        { token: person.token, businessId },
      )
      return answer.results.map((r, i) => {
        const error = r.error as { data?: { appCode?: string } } | undefined
        return `${QUERIES[i]?.path}: ${error?.data?.appCode ?? 'ok'}`
      })
    }
    // In A first (Admin access loaded and memoized for A), then in B: B's Employee answers only.
    expect(await codes(mixed, A.id)).toEqual(await codes(A.admin, A.id))
    expect(await codes(mixed, B.id)).toEqual(await codes(B.employee, B.id))
    expect(await codes(mixed, B.id)).toContain('member.list: forbidden')
  })

  it('`me` gives each membership its own name and a logo URL of its own logo', async () => {
    const me = await query<MeDto>(api.handler, 'me', { token: both.token })
    for (const tenant of [A, B]) {
      const membership = me.data?.memberships.find((m) => m.businessId === tenant.id)
      expect(membership?.legalName).toBe(tenant.legalName)
      expect(membership?.legalNameAr).toBe(tenant.legalNameAr)
      const logo = new URL(membership?.logoUrl ?? 'http://missing')
      expect(logo.pathname.endsWith(`/business-files/${tenant.logoPath}`)).toBe(true)
    }
  })
})

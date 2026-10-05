import type {
  BusinessContextDto,
  InvitationDto,
  MemberDto,
  MemberPermissionsDto,
  RoleDto,
} from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import { PERMISSION_CATALOG, roleTemplateByKey } from '@bizcost/modules'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BAKER, CapturedEmails } from './settings'
import { codeOf, ok, PurchasingApi, type Person } from './purchasing'
import { handlerFor } from './helpers'

// A member's own access (M2 Step 7; deferred from M1 by D-084): member.permissions and
// member.updatePermissions. Changes to what a member's role grants, saved whole; the result must
// hold every key its keys need (costs, supplier prices and margins only together, D-144, D-187);
// nobody changes their own access, the owner's, or anything beyond their own; saving bumps the
// member's permissions version and revokes the invitations they could no longer send; the changes
// stay with the member when their role changes, and "beyond your own" counts them.

const api = new PurchasingApi()
const emails = new CapturedEmails()
const handler = handlerFor(api.db, undefined, {}, { emailSender: emails })

type Team = Awaited<ReturnType<typeof openTeam>>

async function openTeam() {
  const business = await api.business()
  const ownerMemberId = await memberIdOf(business.id, business.owner.user.id)
  const add = (template: 'admin' | 'manager' | 'accountant' | 'sales' | 'employee') =>
    api.member(business, template)
  return { ...business, ownerMemberId, add }
}

async function memberIdOf(businessId: string, userId: string): Promise<string> {
  const [row] = await api.admin<{ id: string }[]>`
    select id from app.business_members where business_id = ${businessId} and user_id = ${userId}`
  if (!row) throw new Error('no membership')
  return row.id
}

function call<T>(team: Team, person: Person, path: string, input?: unknown) {
  return api.call<T>(person, team.id, path, input, handler)
}

const read = async (team: Team, person: Person, memberId: string) =>
  ok(await call<MemberPermissionsDto>(team, person, 'member.permissions', { memberId }))

async function save(
  team: Team,
  person: Person,
  memberId: string,
  overrides: { key: string; effect: 'allow' | 'deny' }[],
) {
  const { version } = await read(team, team.owner, memberId)
  return call<MemberPermissionsDto>(team, person, 'member.updatePermissions', {
    memberId,
    version,
    overrides,
  })
}

const COSTS = ['data.cost.view', 'data.supplier_price.view', 'data.profit_margin.view']
const allow = (...keys: string[]) => keys.map((key) => ({ key, effect: 'allow' as const }))
const deny = (...keys: string[]) => keys.map((key) => ({ key, effect: 'deny' as const }))

let team: Team

beforeAll(async () => {
  team = await openTeam()
})

afterAll(() => api.close())

describe('member.permissions', () => {
  it("reads a member's role keys, their changes and what they may do now", async () => {
    const employee = await team.add('employee')
    const permissions = await read(team, team.owner, employee.memberId)
    const keys = [...roleTemplateByKey('employee')!.permissionKeys].sort()
    expect(permissions).toMatchObject({
      memberId: employee.memberId,
      roleTemplateKey: 'employee',
      isOwner: false,
      isYou: false,
      roleKeys: keys,
      overrides: [],
      effectiveKeys: keys,
      editable: true,
    })
    // The owner: every permission, no changes, not editable.
    const owner = await read(team, team.owner, team.ownerMemberId)
    expect(owner).toMatchObject({ isOwner: true, isYou: true, roleKeys: [], overrides: [] })
    expect(owner.editable).toBe(false)
    expect(owner.effectiveKeys).toEqual([...PERMISSION_CATALOG].sort())
    // Anyone else's membership, or a removed one: NOT_FOUND.
    expect(codeOf(await call(team, team.owner, 'member.permissions', { memberId: newId() }))).toBe(
      'not_found',
    )
  })

  it('needs a team, and the keys to see the team and change roles', async () => {
    const baker = await api.business(BAKER)
    const memberId = await memberIdOf(baker.id, baker.owner.user.id)
    for (const [path, input] of [
      ['member.permissions', { memberId }],
      ['member.updatePermissions', { memberId, version: 0, overrides: [] }],
    ] as const) {
      expect(codeOf(await api.call(baker.owner, baker.id, path, input, handler)), path).toBe(
        'capability_disabled',
      )
    }
    // A Manager sees the team but does not change roles; an employee neither.
    const manager = await team.add('manager')
    const employee = await team.add('employee')
    for (const person of [manager, employee]) {
      expect(
        codeOf(await call(team, person, 'member.permissions', { memberId: employee.memberId })),
      ).toBe('forbidden')
      expect(codeOf(await save(team, person, employee.memberId, []))).toBe('forbidden')
    }
  })
})

describe('member.updatePermissions', () => {
  it('gives one employee costs, supplier prices and margins as one switch, and takes them back', async () => {
    const employee = await team.add('employee')
    const context = async () =>
      ok(await call<BusinessContextDto>(team, employee, 'business.context'))
    expect((await context()).visibleCategories).toEqual([])
    const before = await read(team, team.owner, employee.memberId)

    const saved = ok(await save(team, team.owner, employee.memberId, allow(...COSTS)))
    expect(saved.overrides).toEqual(allow(...COSTS).sort((a, b) => a.key.localeCompare(b.key)))
    expect(saved.effectiveKeys).toEqual(expect.arrayContaining(COSTS))
    expect(saved.version).toBe(before.version + 1)
    expect([...(await context()).visibleCategories].sort()).toEqual([
      'cost',
      'profit_margin',
      'supplier_price',
    ])
    // The members list says who has changes of their own.
    const members = ok(await call<MemberDto[]>(team, team.owner, 'member.list'))
    expect(members.find((m) => m.id === employee.memberId)?.hasOverrides).toBe(true)
    expect(members.find((m) => m.id === team.ownerMemberId)?.hasOverrides).toBe(false)

    // Cleared: back to the role, costs hidden again.
    const cleared = ok(await save(team, team.owner, employee.memberId, []))
    expect(cleared.overrides).toEqual([])
    expect((await context()).visibleCategories).toEqual([])
    const again = ok(await call<MemberDto[]>(team, team.owner, 'member.list'))
    expect(again.find((m) => m.id === employee.memberId)?.hasOverrides).toBe(false)
  })

  it('refuses costs, supplier prices or margins apart (VALIDATION), given or taken away', async () => {
    const employee = await team.add('employee')
    for (const keys of [['data.cost.view'], ['data.cost.view', 'data.supplier_price.view']]) {
      expect(
        codeOf(await save(team, team.owner, employee.memberId, allow(...keys))),
        `${keys}`,
      ).toBe('validation')
    }
    const manager = await team.add('manager')
    expect(codeOf(await save(team, team.owner, manager.memberId, deny('data.cost.view')))).toBe(
      'validation',
    )
    // The three taken away while the manager keeps what needs supplier prices (approving expenses,
    // recording payments): those would grant nothing, so it is refused too (D-200).
    expect(codeOf(await save(team, team.owner, manager.memberId, deny(...COSTS)))).toBe(
      'validation',
    )
    // The costs switch off, as the page sends it (with what needs it): the manager sees no cost,
    // price or margin any more.
    ok(
      await save(
        team,
        team.owner,
        manager.memberId,
        deny(
          ...COSTS,
          'expenses.documents.approve',
          'expenses.payments.record',
          'purchases.payments.record',
          // M3 Step 3: profit reports need the costs switch (Q11).
          'reports.profit.view',
        ),
      ),
    )
    const context = ok(await call<BusinessContextDto>(team, manager, 'business.context'))
    expect(context.visibleCategories).toEqual([])
    // Nothing was stored by the refusals.
    expect((await read(team, team.owner, employee.memberId)).overrides).toEqual([])
  })

  it('keeps every key with what it needs, and drops changes the role already says', async () => {
    const sales = await team.add('sales')
    // Seeing what goes into products needs seeing materials (D-155).
    expect(
      codeOf(await save(team, team.owner, sales.memberId, allow('products.recipes.view'))),
    ).toBe('validation')
    const saved = ok(
      await save(
        team,
        team.owner,
        sales.memberId,
        // products.items.view: the role grants it; purchases.documents.post: the role lacks it.
        [
          ...allow('products.recipes.view', 'materials.items.view', 'products.items.view'),
          ...deny('purchases.documents.post'),
        ],
      ),
    )
    expect(saved.overrides).toEqual(allow('materials.items.view', 'products.recipes.view'))
    // Taking a key away needs its dependants taken away too.
    const manager = await team.add('manager')
    expect(
      codeOf(await save(team, team.owner, manager.memberId, deny('expenses.documents.view'))),
    ).toBe('validation')
  })

  it('refuses unknown keys, a key given twice, the owner, your own access and a stale version', async () => {
    const employee = await team.add('employee')
    expect(codeOf(await save(team, team.owner, employee.memberId, allow('orders.view')))).toBe(
      'validation',
    )
    expect(
      codeOf(
        await save(team, team.owner, employee.memberId, [
          ...allow('suppliers.items.view'),
          ...deny('suppliers.items.view'),
        ]),
      ),
    ).toBe('validation')
    const admin = await team.add('admin')
    expect(codeOf(await save(team, admin, team.ownerMemberId, []))).toBe('validation')
    expect(codeOf(await save(team, admin, admin.memberId, []))).toBe('forbidden')
    const { version } = await read(team, team.owner, employee.memberId)
    ok(await save(team, team.owner, employee.memberId, allow('suppliers.items.view')))
    expect(
      codeOf(
        await call(team, team.owner, 'member.updatePermissions', {
          memberId: employee.memberId,
          version,
          overrides: [],
        }),
      ),
    ).toBe('conflict')
  })

  it('never beyond your own access: a manager who may change roles', async () => {
    const manager = await team.add('manager')
    // The owner lets this manager change roles and manage the team.
    ok(
      await save(
        team,
        team.owner,
        manager.memberId,
        allow('settings.roles.manage', 'settings.members.manage'),
      ),
    )
    const admin = await team.add('admin')
    const employee = await team.add('employee')
    // The Admin can do more than the manager: read-only for them, and refused.
    expect((await read(team, manager, admin.memberId)).editable).toBe(false)
    expect(codeOf(await save(team, manager, admin.memberId, []))).toBe('forbidden')
    // A key the manager holds: fine. One they lack (closing the books): refused.
    ok(await save(team, manager, employee.memberId, allow('expenses.documents.post')))
    expect(
      codeOf(
        await save(team, manager, employee.memberId, [
          ...allow('expenses.documents.post'),
          ...allow('settings.books.close'),
        ]),
      ),
    ).toBe('forbidden')
    // What the owner gave beyond the manager makes the employee theirs to leave alone: no edit, no
    // role change, no removal (their own changes count, not only their role).
    ok(
      await save(
        team,
        team.owner,
        employee.memberId,
        allow('purchases.documents.view', 'settings.books.close'),
      ),
    )
    expect((await read(team, manager, employee.memberId)).editable).toBe(false)
    expect(codeOf(await save(team, manager, employee.memberId, []))).toBe('forbidden')
    const salesRole = ok(await call<RoleDto[]>(team, team.owner, 'role.list')).find(
      (r) => r.templateKey === 'sales',
    )!
    expect(
      codeOf(
        await call(team, manager, 'member.changeRole', {
          memberId: employee.memberId,
          roleId: salesRole.id,
        }),
      ),
    ).toBe('forbidden')
    expect(
      codeOf(await call(team, manager, 'member.remove', { memberId: employee.memberId })),
    ).toBe('forbidden')
    // The owner may: the changes stay with the member in the new role.
    ok(
      await call(team, team.owner, 'member.changeRole', {
        memberId: employee.memberId,
        roleId: salesRole.id,
      }),
    )
    const moved = await read(team, team.owner, employee.memberId)
    expect(moved.roleTemplateKey).toBe('sales')
    expect(moved.effectiveKeys).toContain('settings.books.close')
  })

  it('revokes the invitations a member can no longer send once a change takes the key away', async () => {
    const admin = await team.add('admin')
    const employeeRole = ok(await call<RoleDto[]>(team, team.owner, 'role.list')).find(
      (r) => r.templateKey === 'employee',
    )!
    const invitation = ok(
      await call<InvitationDto>(team, admin, 'invitation.create', {
        id: newId(),
        email: `invitee-${newId().slice(-8)}@test.bizcost.local`,
        roleId: employeeRole.id,
        locale: 'en',
      }),
    )
    expect(invitation.status).toBe('pending')
    ok(await save(team, team.owner, admin.memberId, deny('settings.members.manage')))
    const [row] = await api.admin<{ status: string }[]>`
      select status from app.business_invitations where id = ${invitation.id}`
    expect(row?.status).toBe('revoked')
    // The admin is refused what the key allowed on their next request.
    expect(codeOf(await call(team, admin, 'invitation.resend', { id: invitation.id }))).toBe(
      'forbidden',
    )
  })
})

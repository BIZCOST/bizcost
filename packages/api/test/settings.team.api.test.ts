import type {
  BusinessContextDto,
  InvitationDto,
  MeDto,
  MemberDto,
  RoleDto,
} from '@bizcost/contracts'
import type { Db } from '@bizcost/db'
import { newId } from '@bizcost/domain'
import { PERMISSION_CATALOG, type RoleTemplateKey } from '@bizcost/modules'
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
import {
  appCode,
  BAKER,
  CapturedEmails,
  join,
  setupBusiness,
  templateRoleId,
  WORKSHOP,
} from './settings'

// Settings → Team (members) and Roles through the real fetch handler (ROADMAP.md Step 6): the team
// capability gate, permissions per role template, "nobody grants beyond their own access", the owner
// rules, ownership transfer with a recent sign-in, a removed member refused on the next request, leaving,
// and pending invitations that follow their sender.

let db: Db
let admin: Admin
let handler: ReturnType<typeof handlerFor>
const users: TestUser[] = []
const emails = new CapturedEmails()

beforeAll(() => {
  db = connectApi()
  admin = connectAdmin()
  handler = handlerFor(db, undefined, { supabaseSecretKey: SECRET_KEY }, { emailSender: emails })
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

async function team() {
  const owner = await newUser()
  const businessId = await setupBusiness(handler, owner.token, WORKSHOP)
  const add = async (template: Exclude<RoleTemplateKey, 'owner'>) => {
    const person = await newUser()
    const memberId = await join(db, owner.user, businessId, person.user, template)
    return { ...person, memberId }
  }
  const ownerMemberId = await memberIdOf(businessId, owner.user.id)
  return { owner: { ...owner, memberId: ownerMemberId }, businessId, add }
}

async function memberIdOf(businessId: string, userId: string): Promise<string> {
  const [row] = await admin<{ id: string }[]>`
    select id from app.business_members where business_id = ${businessId} and user_id = ${userId}`
  if (!row) throw new Error('no membership')
  return row.id
}

async function memberRow(memberId: string) {
  const [row] = await admin<{ status: string; role_id: string; permissions_version: number }[]>`
    select status, role_id, permissions_version from app.business_members where id = ${memberId}`
  return row
}

function call<T = unknown>(token: string, businessId: string, path: string, input?: unknown) {
  return input === undefined
    ? query<T>(handler, path, { token, businessId })
    : mutate<T>(handler, path, { token, businessId, input })
}

describe('the team capability', () => {
  it('a solo business has no team, member or role procedures (CAPABILITY_DISABLED)', async () => {
    const owner = await newUser()
    const businessId = await setupBusiness(handler, owner.token, BAKER)
    const memberId = await memberIdOf(businessId, owner.user.id)
    for (const [path, input] of [
      ['member.list', undefined],
      ['member.changeRole', { memberId, roleId: newId() }],
      ['member.remove', { memberId: newId() }],
      ['member.transferOwnership', { memberId: newId() }],
      ['role.list', undefined],
      ['role.updatePermissions', { id: newId(), version: 1, permissionKeys: [] }],
      ['invitation.list', undefined],
      ['invitation.create', { id: newId(), email: 'a@b.test', roleId: newId(), locale: 'en' }],
      ['invitation.resend', { id: newId() }],
      ['invitation.revoke', { id: newId() }],
    ] as const) {
      expect(appCode(await call(owner.token, businessId, path, input)), path).toBe(
        'capability_disabled',
      )
    }
  })
})

describe('member.list', () => {
  it('lists members (owner first) with email, role and who is you; removed ones are left out', async () => {
    const { owner, businessId, add } = await team()
    const employee = await add('employee')
    const gone = await add('sales')
    await admin`update app.business_members set status = 'removed' where id = ${gone.memberId}`
    const result = await call<MemberDto[]>(owner.token, businessId, 'member.list')
    expect(result.error).toBeUndefined()
    expect(result.data?.map((m) => m.id)).toEqual([owner.memberId, employee.memberId])
    expect(result.data?.[0]).toMatchObject({
      isOwner: true,
      isYou: true,
      roleTemplateKey: 'owner',
      email: owner.user.email,
      kind: 'account',
      status: 'active',
    })
    expect(result.data?.[1]).toMatchObject({
      isOwner: false,
      isYou: false,
      roleTemplateKey: 'employee',
      email: employee.user.email,
    })
  })

  it('needs settings.members.view (owner, admin, manager, supervisor)', async () => {
    const { businessId, add } = await team()
    const allowed = new Set(['admin', 'manager', 'supervisor'])
    for (const template of [
      'admin',
      'manager',
      'accountant',
      'sales',
      'supervisor',
      'employee',
    ] as const) {
      const member = await add(template)
      const result = await call(member.token, businessId, 'member.list')
      expect(result.error?.data.appCode, template).toBe(
        allowed.has(template) ? undefined : 'forbidden',
      )
    }
  })
})

describe('member.changeRole', () => {
  it('changes the role, bumps permissions_version, and the member’s access changes on the next request', async () => {
    const { owner, businessId, add } = await team()
    const employee = await add('employee')
    const managerRole = await templateRoleId(db, owner.user, businessId, 'manager')
    // An employee cannot open the settings sections.
    expect(appCode(await call(employee.token, businessId, 'business.profile'))).toBe('forbidden')
    expect(appCode(await call(employee.token, businessId, 'member.list'))).toBe('forbidden')
    const before = await memberRow(employee.memberId)

    const result = await call<MemberDto>(owner.token, businessId, 'member.changeRole', {
      memberId: employee.memberId,
      roleId: managerRole,
    })
    expect(result.error).toBeUndefined()
    expect(result.data).toMatchObject({ roleId: managerRole, roleTemplateKey: 'manager' })
    const after = await memberRow(employee.memberId)
    expect(after?.permissions_version).toBe((before?.permissions_version ?? 0) + 1)

    const context = await call<BusinessContextDto>(employee.token, businessId, 'business.context')
    expect(context.data?.roleTemplateKey).toBe('manager')
    expect(context.headers.get('x-permissions-version')).toBe(String(after?.permissions_version))
    expect((await call(employee.token, businessId, 'business.profile')).error).toBeUndefined()
    expect((await call(employee.token, businessId, 'member.list')).error).toBeUndefined()
  })

  it('never makes or unmakes an owner, nor changes your own role', async () => {
    const { owner, businessId, add } = await team()
    const adminMember = await add('admin')
    const employee = await add('employee')
    const ownerRole = await templateRoleId(db, owner.user, businessId, 'owner')
    const salesRole = await templateRoleId(db, owner.user, businessId, 'sales')
    const change = (token: string, memberId: string, roleId: string) =>
      call(token, businessId, 'member.changeRole', { memberId, roleId })
    expect(appCode(await change(owner.token, employee.memberId, ownerRole))).toBe(
      'owner_transfer_required',
    )
    expect(appCode(await change(adminMember.token, owner.memberId, salesRole))).toBe(
      'owner_transfer_required',
    )
    expect(appCode(await change(owner.token, owner.memberId, salesRole))).toBe(
      'owner_transfer_required',
    )
    expect(appCode(await change(adminMember.token, adminMember.memberId, salesRole))).toBe(
      'forbidden',
    )
    expect(appCode(await change(owner.token, employee.memberId, newId()))).toBe('not_found')
    expect(appCode(await change(owner.token, newId(), salesRole))).toBe('not_found')
  })

  it('a member who manages the team cannot grant or take away more than their own access', async () => {
    const { owner, businessId, add } = await team()
    // The owner lets Managers manage the team.
    const managerRole = await templateRoleId(db, owner.user, businessId, 'manager')
    const roles = (await call<RoleDto[]>(owner.token, businessId, 'role.list')).data!
    const manager = roles.find((r) => r.id === managerRole)!
    const granted = await call(owner.token, businessId, 'role.updatePermissions', {
      id: managerRole,
      version: manager.version,
      permissionKeys: [...manager.permissionKeys, 'settings.members.manage'],
    })
    expect(granted.error).toBeUndefined()
    const lead = await add('manager')
    const employee = await add('employee')
    const adminMember = await add('admin')
    const adminRole = await templateRoleId(db, owner.user, businessId, 'admin')
    const salesRole = await templateRoleId(db, owner.user, businessId, 'sales')

    const change = (memberId: string, roleId: string) =>
      call(lead.token, businessId, 'member.changeRole', { memberId, roleId })
    expect(appCode(await change(employee.memberId, adminRole))).toBe('forbidden')
    expect(appCode(await change(adminMember.memberId, salesRole))).toBe('forbidden')
    expect(
      appCode(
        await call(lead.token, businessId, 'member.remove', { memberId: adminMember.memberId }),
      ),
    ).toBe('forbidden')
    expect((await change(employee.memberId, salesRole)).error).toBeUndefined()
    expect((await memberRow(adminMember.memberId))?.role_id).toBe(adminRole)
    expect(
      (await call(lead.token, businessId, 'member.remove', { memberId: employee.memberId })).error,
    ).toBeUndefined()
  })

  it('cannot move members of another business or give another business’s role', async () => {
    const a = await team()
    const b = await team()
    const memberB = await b.add('employee')
    const roleB = await templateRoleId(db, b.owner.user, b.businessId, 'admin')
    const employeeA = await a.add('employee')
    expect(
      appCode(
        await call(a.owner.token, a.businessId, 'member.changeRole', {
          memberId: memberB.memberId,
          roleId: await templateRoleId(db, a.owner.user, a.businessId, 'sales'),
        }),
      ),
    ).toBe('not_found')
    expect(
      appCode(
        await call(a.owner.token, a.businessId, 'member.changeRole', {
          memberId: employeeA.memberId,
          roleId: roleB,
        }),
      ),
    ).toBe('not_found')
    expect(
      appCode(
        await call(a.owner.token, b.businessId, 'member.remove', { memberId: memberB.memberId }),
      ),
    ).toBe('forbidden')
    expect((await memberRow(memberB.memberId))?.status).toBe('active')
  })

  it('is for settings.members.manage only (owner and admin)', async () => {
    const { owner, businessId, add } = await team()
    const target = await add('employee')
    const salesRole = await templateRoleId(db, owner.user, businessId, 'sales')
    for (const template of ['manager', 'accountant', 'sales', 'supervisor', 'employee'] as const) {
      const member = await add(template)
      const result = await call(member.token, businessId, 'member.changeRole', {
        memberId: target.memberId,
        roleId: salesRole,
      })
      expect(appCode(result), template).toBe('forbidden')
      const remove = await call(member.token, businessId, 'member.remove', {
        memberId: target.memberId,
      })
      expect(appCode(remove), template).toBe('forbidden')
    }
  })
})

describe('member.remove', () => {
  it('removes a member, who is refused on their next request', async () => {
    const { owner, businessId, add } = await team()
    const employee = await add('employee')
    expect((await call(employee.token, businessId, 'business.context')).error).toBeUndefined()
    const before = await memberRow(employee.memberId)
    const result = await call(owner.token, businessId, 'member.remove', {
      memberId: employee.memberId,
    })
    expect(result.data).toEqual({ ok: true })
    const after = await memberRow(employee.memberId)
    expect(after?.status).toBe('removed')
    expect(after?.permissions_version).toBe((before?.permissions_version ?? 0) + 1)
    expect(appCode(await call(employee.token, businessId, 'business.context'))).toBe('forbidden')
    const me = await query<MeDto>(handler, 'me', { token: employee.token })
    expect(me.data?.memberships.map((m) => m.businessId)).not.toContain(businessId)
    // Removing again: no such member any more.
    expect(
      appCode(
        await call(owner.token, businessId, 'member.remove', { memberId: employee.memberId }),
      ),
    ).toBe('not_found')
  })

  it('never removes the owner; a member may leave', async () => {
    const { owner, businessId, add } = await team()
    const adminMember = await add('admin')
    expect(
      appCode(
        await call(adminMember.token, businessId, 'member.remove', { memberId: owner.memberId }),
      ),
    ).toBe('owner_transfer_required')
    expect(
      appCode(await call(owner.token, businessId, 'member.remove', { memberId: owner.memberId })),
    ).toBe('owner_transfer_required')
    expect(
      (
        await call(adminMember.token, businessId, 'member.remove', {
          memberId: adminMember.memberId,
        })
      ).error,
    ).toBeUndefined()
    expect(appCode(await call(adminMember.token, businessId, 'business.context'))).toBe('forbidden')
  })
})

describe('member.leave', () => {
  it('any member but the owner leaves, is refused next, and their invitations stop working', async () => {
    const { owner, businessId, add } = await team()
    const employee = await add('employee')
    const adminMember = await add('admin')
    const employeeRole = await templateRoleId(db, owner.user, businessId, 'employee')

    // No permission is needed to leave.
    expect(
      (await mutate(handler, 'member.leave', { token: employee.token, businessId })).error,
    ).toBeUndefined()
    expect(appCode(await call(employee.token, businessId, 'business.context'))).toBe('forbidden')
    expect((await memberRow(employee.memberId))?.status).toBe('removed')

    const sent = await call<InvitationDto>(adminMember.token, businessId, 'invitation.create', {
      id: newId(),
      email: `left-${newId()}@test.bizcost.local`,
      roleId: employeeRole,
      locale: 'en',
    })
    expect(sent.error).toBeUndefined()
    expect(
      (await mutate(handler, 'member.leave', { token: adminMember.token, businessId })).error,
    ).toBeUndefined()
    const [invitation] = await admin<{ status: string }[]>`
      select status from app.business_invitations where id = ${sent.data!.id}`
    expect(invitation?.status).toBe('revoked')

    // The owner transfers ownership first.
    expect(appCode(await mutate(handler, 'member.leave', { token: owner.token, businessId }))).toBe(
      'owner_transfer_required',
    )
  })
})

describe('member.transferOwnership', () => {
  it('makes the member the owner and the old owner an Admin, in one step', async () => {
    const { owner, businessId, add } = await team()
    const next = await add('manager')
    const result = await call(owner.token, businessId, 'member.transferOwnership', {
      memberId: next.memberId,
    })
    expect(result.error).toBeUndefined()
    const ctxNew = await call<BusinessContextDto>(next.token, businessId, 'business.context')
    expect(ctxNew.data?.roleTemplateKey).toBe('owner')
    const ctxOld = await call<BusinessContextDto>(owner.token, businessId, 'business.context')
    expect(ctxOld.data?.roleTemplateKey).toBe('admin')
    const [owners] = await admin<{ n: number }[]>`
      select count(*)::int as n from app.business_members m
        join app.roles r on r.business_id = m.business_id and r.id = m.role_id
       where m.business_id = ${businessId} and r.template_key = 'owner' and m.status = 'active'`
    expect(owners?.n).toBe(1)
    // The old owner can no longer transfer; the new one can give it back.
    expect(
      appCode(
        await call(owner.token, businessId, 'member.transferOwnership', {
          memberId: next.memberId,
        }),
      ),
    ).toBe('forbidden')
    expect(
      (await call(next.token, businessId, 'member.transferOwnership', { memberId: owner.memberId }))
        .error,
    ).toBeUndefined()
  })

  it('needs a recent sign-in (REAUTH_REQUIRED) and changes nothing without it', async () => {
    const { owner, businessId, add } = await team()
    const next = await add('admin')
    const stale = await mintToken(owner.user, { signedInAt: Math.floor(Date.now() / 1000) - 3600 })
    const result = await call(stale, businessId, 'member.transferOwnership', {
      memberId: next.memberId,
    })
    expect(appCode(result)).toBe('reauth_required')
    expect(result.status).toBe(403)
    const ctx = await call<BusinessContextDto>(next.token, businessId, 'business.context')
    expect(ctx.data?.roleTemplateKey).toBe('admin')
  })

  it('is for the owner only, to an active member other than themselves', async () => {
    const { owner, businessId, add } = await team()
    const adminMember = await add('admin')
    const other = await add('employee')
    expect(
      appCode(
        await call(adminMember.token, businessId, 'member.transferOwnership', {
          memberId: other.memberId,
        }),
      ),
    ).toBe('forbidden')
    expect(
      appCode(
        await call(owner.token, businessId, 'member.transferOwnership', {
          memberId: owner.memberId,
        }),
      ),
    ).toBe('validation')
    await admin`update app.business_members set status = 'suspended' where id = ${other.memberId}`
    expect(
      appCode(
        await call(owner.token, businessId, 'member.transferOwnership', {
          memberId: other.memberId,
        }),
      ),
    ).toBe('validation')
    expect(
      appCode(
        await call(owner.token, businessId, 'member.transferOwnership', { memberId: newId() }),
      ),
    ).toBe('not_found')
    const b = await team()
    const outsider = await b.add('admin')
    expect(
      appCode(
        await call(owner.token, businessId, 'member.transferOwnership', {
          memberId: outsider.memberId,
        }),
      ),
    ).toBe('not_found')
  })
})

describe('role.list / role.updatePermissions', () => {
  it('lists the template roles: Owner first and read-only, Admin with every permission', async () => {
    const { owner, businessId, add } = await team()
    await add('employee')
    const result = await call<RoleDto[]>(owner.token, businessId, 'role.list')
    expect(result.data?.map((r) => r.templateKey)).toEqual([
      'owner',
      'admin',
      'manager',
      'accountant',
      'sales',
      'supervisor',
      'employee',
    ])
    const [ownerRole, adminRole] = result.data!
    expect(ownerRole).toMatchObject({ isOwner: true, permissionKeys: [], memberCount: 1 })
    expect(adminRole?.permissionKeys).toEqual([...PERMISSION_CATALOG].sort())
    expect(result.data?.find((r) => r.templateKey === 'employee')?.memberCount).toBe(1)
  })

  it('role.list needs settings.members.view or settings.roles.manage', async () => {
    const { businessId, add } = await team()
    for (const [template, allowed] of [
      ['supervisor', true],
      ['manager', true],
      ['accountant', false],
      ['employee', false],
    ] as const) {
      const member = await add(template)
      expect(
        (await call(member.token, businessId, 'role.list')).error?.data.appCode,
        template,
      ).toBe(allowed ? undefined : 'forbidden')
    }
  })

  it('saves a role’s permissions; its members get them on their next request', async () => {
    const { owner, businessId, add } = await team()
    const employee = await add('employee')
    const roleId = await templateRoleId(db, owner.user, businessId, 'employee')
    const role = (await call<RoleDto[]>(owner.token, businessId, 'role.list')).data!.find(
      (r) => r.id === roleId,
    )!
    const before = await memberRow(employee.memberId)
    const saved = await call<RoleDto>(owner.token, businessId, 'role.updatePermissions', {
      id: roleId,
      version: role.version,
      permissionKeys: ['dashboard.home.view', 'settings.business.view', 'settings.business.view'],
    })
    expect(saved.error).toBeUndefined()
    expect(saved.data?.permissionKeys).toEqual(['dashboard.home.view', 'settings.business.view'])
    expect(saved.data!.version).toBeGreaterThan(role.version)
    expect((await memberRow(employee.memberId))?.permissions_version).toBe(
      (before?.permissions_version ?? 0) + 1,
    )
    expect((await call(employee.token, businessId, 'business.profile')).error).toBeUndefined()

    // Taking it away again (the soft-deleted row comes back on a later grant).
    const removed = await call<RoleDto>(owner.token, businessId, 'role.updatePermissions', {
      id: roleId,
      version: saved.data!.version,
      permissionKeys: ['dashboard.home.view'],
    })
    expect(removed.data?.permissionKeys).toEqual(['dashboard.home.view'])
    expect(appCode(await call(employee.token, businessId, 'business.profile'))).toBe('forbidden')
    const regranted = await call<RoleDto>(owner.token, businessId, 'role.updatePermissions', {
      id: roleId,
      version: removed.data!.version,
      permissionKeys: ['dashboard.home.view', 'settings.business.view'],
    })
    expect(regranted.data?.permissionKeys).toEqual([
      'dashboard.home.view',
      'settings.business.view',
    ])
    // A stale version is refused.
    const stale = await call(owner.token, businessId, 'role.updatePermissions', {
      id: roleId,
      version: saved.data!.version,
      permissionKeys: [],
    })
    expect(appCode(stale)).toBe('conflict')
  })

  it('refuses unknown keys, the Owner role, and granting what the caller does not hold', async () => {
    const { owner, businessId, add } = await team()
    const roles = (await call<RoleDto[]>(owner.token, businessId, 'role.list')).data!
    const ownerRole = roles.find((r) => r.isOwner)!
    const manager = roles.find((r) => r.templateKey === 'manager')!
    const supervisor = roles.find((r) => r.templateKey === 'supervisor')!
    const update = (token: string, role: RoleDto, keys: string[]) =>
      call<RoleDto>(token, businessId, 'role.updatePermissions', {
        id: role.id,
        version: role.version,
        permissionKeys: keys,
      })
    expect(appCode(await update(owner.token, supervisor, ['orders.view']))).toBe('validation')
    expect(appCode(await update(owner.token, ownerRole, []))).toBe('validation')

    // The owner lets Managers manage roles; a manager may pass on only what they hold.
    const granted = await update(owner.token, manager, [
      ...manager.permissionKeys,
      'settings.roles.manage',
    ])
    expect(granted.error).toBeUndefined()
    const lead = await add('manager')
    expect(
      appCode(
        await update(lead.token, supervisor, [...supervisor.permissionKeys, 'data.payroll.view']),
      ),
    ).toBe('forbidden')
    expect(
      appCode(
        await update(lead.token, supervisor, [
          ...supervisor.permissionKeys,
          'settings.modules.manage',
        ]),
      ),
    ).toBe('forbidden')
    const ok = await update(lead.token, supervisor, [
      ...supervisor.permissionKeys,
      'data.cost.view',
    ])
    expect(ok.error).toBeUndefined()
    // Nor raise their own role.
    const self = (await call<RoleDto[]>(lead.token, businessId, 'role.list')).data!.find(
      (r) => r.id === manager.id,
    )!
    expect(
      appCode(await update(lead.token, self, [...self.permissionKeys, 'settings.business.edit'])),
    ).toBe('forbidden')
  })

  it('a role is edited only by someone who holds all it grants; changing needs seeing', async () => {
    const { owner, businessId, add } = await team()
    const roles = (await call<RoleDto[]>(owner.token, businessId, 'role.list')).data!
    const manager = roles.find((r) => r.templateKey === 'manager')!
    const accountant = roles.find((r) => r.templateKey === 'accountant')!
    const employee = roles.find((r) => r.templateKey === 'employee')!
    const update = (token: string, role: RoleDto, keys: string[]) =>
      call<RoleDto>(token, businessId, 'role.updatePermissions', {
        id: role.id,
        version: role.version,
        permissionKeys: keys,
      })
    // Edit or manage without the matching "see" permission: VALIDATION (the editor switches both).
    expect(
      appCode(
        await update(owner.token, employee, [
          ...employee.permissionKeys,
          'settings.members.manage',
        ]),
      ),
    ).toBe('validation')
    expect(
      appCode(
        await update(owner.token, employee, [...employee.permissionKeys, 'settings.business.edit']),
      ),
    ).toBe('validation')

    await update(owner.token, manager, [...manager.permissionKeys, 'settings.roles.manage'])
    const lead = await add('manager')
    // The Accountant role sees payroll, which Managers do not: a Manager cannot edit it at all, not
    // even to take away something they hold themselves.
    expect(
      appCode(
        await update(
          lead.token,
          accountant,
          accountant.permissionKeys.filter((key) => key !== 'data.cost.view'),
        ),
      ),
    ).toBe('forbidden')
    // A role within their own access is fine.
    expect((await update(lead.token, employee, [])).error).toBeUndefined()
  })

  it('taking away the right to invite revokes the pending invitations sent with it', async () => {
    const { owner, businessId, add } = await team()
    const adminMember = await add('admin')
    const employeeRole = await templateRoleId(db, owner.user, businessId, 'employee')
    const email = `pending-${newId()}@test.bizcost.local`
    const sent = await call<InvitationDto>(adminMember.token, businessId, 'invitation.create', {
      id: newId(),
      email,
      roleId: employeeRole,
      locale: 'en',
    })
    expect(sent.data?.invitedBy).toBeTruthy()
    const adminRole = (await call<RoleDto[]>(owner.token, businessId, 'role.list')).data!.find(
      (r) => r.templateKey === 'admin',
    )!
    const saved = await call(owner.token, businessId, 'role.updatePermissions', {
      id: adminRole.id,
      version: adminRole.version,
      permissionKeys: adminRole.permissionKeys.filter((key) => key !== 'settings.members.manage'),
    })
    expect(saved.error).toBeUndefined()
    const list = await call<InvitationDto[]>(owner.token, businessId, 'invitation.list')
    expect(list.data?.map((i) => i.email)).not.toContain(email)
    const invitee = await createUser({ locale: 'en' }, { email })
    users.push(invitee)
    const accepted = await mutate(handler, 'invitation.accept', {
      token: await mintToken(invitee),
      input: { token: emails.tokenFor(email) },
    })
    expect(appCode(accepted)).toBe('invitation_invalid')
  })

  it('is for settings.roles.manage, in this business only', async () => {
    const { owner, businessId, add } = await team()
    const roles = (await call<RoleDto[]>(owner.token, businessId, 'role.list')).data!
    const sales = roles.find((r) => r.templateKey === 'sales')!
    for (const template of ['manager', 'accountant', 'supervisor', 'employee'] as const) {
      const member = await add(template)
      const result = await call(member.token, businessId, 'role.updatePermissions', {
        id: sales.id,
        version: sales.version,
        permissionKeys: [],
      })
      expect(appCode(result), template).toBe('forbidden')
    }
    const b = await team()
    const result = await call(b.owner.token, b.businessId, 'role.updatePermissions', {
      id: sales.id,
      version: sales.version,
      permissionKeys: [],
    })
    expect(appCode(result)).toBe('not_found')
  })
})

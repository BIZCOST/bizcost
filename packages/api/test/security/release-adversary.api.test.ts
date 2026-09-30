import type {
  BusinessContextDto,
  CostCategoryDto,
  MemberPermissionsDto,
  RoleDto,
} from '@bizcost/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ExpenseScope, ExpensesApi } from '../expenses'
import { codeOf, ok, type Person } from '../purchasing'
import { WORKSHOP } from '../settings'

// Security review of M2 Step 7 (the Costing Core's release): what the adversary found still open.
// Each test states the behaviour the rules ask for; a failing test is a finding.
//
// 1. "No access beyond your own" (D-084, D-196): a member whose own changes give them more than a
//    manager who may change roles is left alone by that manager (member.updatePermissions,
//    member.changeRole and member.remove refuse it: "their own changes count, not only their role").
//    role.updatePermissions still counts the role's keys only, so the same manager takes the owner's
//    grant away from that member by editing their role: a key the role no longer holds leaves the
//    member's extra key without the key it needs, and it grants nothing any more (withNeededKeys).
//    Once it grants nothing, "beyond your own" (which counts only keys that work) no longer sees it,
//    and the manager may remove the member (or move them to another role).
// 2. "For which month?" (D-194): a month is YYYY-MM with a year from 0000, but Postgres has no year 0,
//    so a filter or a default month in year 0 is a server error (INTERNAL) instead of VALIDATION.

let api: ExpensesApi

beforeAll(() => {
  api = new ExpensesApi()
})

afterAll(async () => {
  await api.close()
})

type Member = Person & { memberId: string }

const allow = (...keys: string[]) => keys.map((key) => ({ key, effect: 'allow' as const }))

async function permissionsOf(scope: ExpenseScope, memberId: string) {
  return ok(await scope.run<MemberPermissionsDto>('member.permissions', { memberId }))
}

async function saveAsOwner(
  scope: ExpenseScope,
  member: Member,
  overrides: { key: string; effect: 'allow' }[],
) {
  const { version } = await permissionsOf(scope, member.memberId)
  return ok(
    await scope.run<MemberPermissionsDto>('member.updatePermissions', {
      memberId: member.memberId,
      version,
      overrides,
    }),
  )
}

/**
 * A business of its own with a manager the owner lets change roles and manage the team (as
 * member-permissions does), and an employee the owner lets set whether expenses need approval: a key
 * the manager does not hold. It needs expenses.documents.view, which the Employee role grants.
 */
async function teamWithSpecialEmployee() {
  const scope = await ExpenseScope.open(api, WORKSHOP)
  const manager = await api.member(scope, 'manager')
  const employee = await api.member(scope, 'employee')
  await saveAsOwner(scope, manager, allow('settings.roles.manage', 'settings.members.manage'))
  await saveAsOwner(scope, employee, allow('expenses.approval.manage'))
  expect((await permissionsOf(scope, employee.memberId)).effectiveKeys).toContain(
    'expenses.approval.manage',
  )
  const employeeRole = ok(await scope.run<RoleDto[]>('role.list')).find(
    (role) => role.templateKey === 'employee',
  )!
  /** The manager takes away, from the Employee role, only keys they hold themselves. */
  const stripEmployeeRole = () =>
    scope.as<RoleDto>(manager, 'role.updatePermissions', {
      id: employeeRole.id,
      version: employeeRole.version,
      permissionKeys: employeeRole.permissionKeys.filter(
        (key) => key !== 'expenses.documents.view' && key !== 'expenses.documents.manage',
      ),
    })
  return { scope, manager, employee, stripEmployeeRole }
}

describe('a member with more access than the caller is left alone (D-196)', () => {
  it("a manager who may change roles cannot take the owner's grant away through the member's role", async () => {
    const { scope, manager, employee, stripEmployeeRole } = await teamWithSpecialEmployee()
    // The member-level rules hold: the manager may not change the employee's own access.
    const read = ok(
      await scope.as<MemberPermissionsDto>(manager, 'member.permissions', {
        memberId: employee.memberId,
      }),
    )
    expect(read.editable).toBe(false)
    expect(
      codeOf(
        await scope.as(manager, 'member.updatePermissions', {
          memberId: employee.memberId,
          version: read.version,
          overrides: [],
        }),
      ),
    ).toBe('forbidden')

    // The same manager edits the Employee role: it grants nothing beyond the manager, and they take
    // away only keys they hold (expenses.documents.view and .manage). Expected: FORBIDDEN, as for
    // member.changeRole (a role with a member whose access is beyond the caller's is left alone, "it
    // may hold people with more access").
    expect(codeOf(await stripEmployeeRole()), 'role.updatePermissions by the manager').toBe(
      'forbidden',
    )
    // What the owner gave the employee still works.
    const context = ok(await scope.as<BusinessContextDto>(employee, 'business.context'))
    expect(context.permissions.keys).toContain('expenses.approval.manage')
  })

  it('a manager cannot remove that member by first making their extra key count for nothing', async () => {
    const { scope, manager, employee, stripEmployeeRole } = await teamWithSpecialEmployee()
    // Refused while the owner's grant works (member-permissions covers this).
    expect(codeOf(await scope.as(manager, 'member.remove', { memberId: employee.memberId }))).toBe(
      'forbidden',
    )
    // Step 1: the role edit leaves expenses.approval.manage without the key it needs.
    await stripEmployeeRole()
    // Step 2: the removal the rules refuse now goes through. Expected: still FORBIDDEN.
    expect(
      codeOf(await scope.as(manager, 'member.remove', { memberId: employee.memberId })),
      'member.remove after the role edit',
    ).toBe('forbidden')
  })

  it('a manager cannot bring back, through a role, a key of a member that they do not hold', async () => {
    const { scope, manager, employee } = await teamWithSpecialEmployee()
    // The owner takes expenses away from the Employee role: the employee's approval key, which needs
    // expenses.documents.view, grants nothing any more.
    const roles = () => scope.run<RoleDto[]>('role.list')
    const employeeRole = ok(await roles()).find((role) => role.templateKey === 'employee')!
    const without = employeeRole.permissionKeys.filter(
      (key) => key !== 'expenses.documents.view' && key !== 'expenses.documents.manage',
    )
    const stripped = ok(
      await scope.run<RoleDto>('role.updatePermissions', {
        id: employeeRole.id,
        version: employeeRole.version,
        permissionKeys: without,
      }),
    )
    expect((await permissionsOf(scope, employee.memberId)).effectiveKeys).not.toContain(
      'expenses.approval.manage',
    )
    // The manager gives the Employee role expenses back (keys they hold). The employee then holds
    // expenses.approval.manage again, a key the manager does not hold. Expected: FORBIDDEN (after the
    // change, no member of the role may do more than the caller, as member.updatePermissions asks).
    const result = await scope.as<RoleDto>(manager, 'role.updatePermissions', {
      id: stripped.id,
      version: stripped.version,
      permissionKeys: [...without, 'expenses.documents.view', 'expenses.documents.manage'],
    })
    expect(codeOf(result), 'role.updatePermissions by the manager').toBe('forbidden')
    expect((await permissionsOf(scope, employee.memberId)).effectiveKeys).not.toContain(
      'expenses.approval.manage',
    )
  })
})

describe('"For which month?" never fails on the server (D-194)', () => {
  let shop: ExpenseScope
  let electricity: CostCategoryDto
  let rent: CostCategoryDto

  beforeAll(async () => {
    shop = await ExpenseScope.open(api, WORKSHOP)
    const categories = await shop.categories()
    electricity = categories.find((c) => c.name === 'Electricity')!
    rent = categories.find((c) => c.name === 'Rent')!
  }, 60_000)

  it('a month filter in year 0 is VALIDATION, not INTERNAL', async () => {
    const result = await shop.run('expense.list', { periodMonth: '0000-01' })
    expect(codeOf(result)).toBe('validation')
  })

  it('a bill of year 1 whose month falls in year 0 is refused (VALIDATION), not a server error', async () => {
    // Left out, the month of an electricity bill is the month before the bill's: December of year 0,
    // which Postgres refuses.
    const byDefault = await shop.run(
      'expense.create',
      shop.expenseInput(electricity.id, '0001-01-15', { vatRate: '0' }),
    )
    expect(codeOf(byDefault), 'the default month').not.toBe('internal')
    // Said by the person: within 12 months before the bill's month, the range the API checks.
    const said = await shop.run(
      'expense.create',
      shop.expenseInput(rent.id, '0001-06-15', { vatRate: '0', periodMonth: '0000-12' }),
    )
    expect(codeOf(said), 'the month said').not.toBe('internal')
  })
})

import { sensitive, withMeta, zDecimal } from '@bizcost/contracts'
import {
  businessCapabilities,
  businesses,
  businessMembers,
  businessModules,
  locations,
  memberPermissionOverrides,
  withTenantTx,
  type Db,
} from '@bizcost/db'
import { newId, SENSITIVITY_CATEGORIES, type SensitivityCategory } from '@bizcost/domain'
import { PERMISSION_CATALOG, ROLE_TEMPLATE_KEYS, type RoleTemplateKey } from '@bizcost/modules'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  appRouter,
  assertQueryable,
  authedProcedure,
  businessProcedure,
  requireModule,
  requirePermission,
  router,
} from '../src'
import {
  addMember,
  batch,
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
  tenant,
  type Admin,
  type TestUser,
} from './helpers'

// Business-scoped procedures through the real fetch handler: membership check, business.context per
// role template, module and permission gates, redaction and FORBIDDEN on hidden-field queries.
// Tokens are minted with the local stack's real signing key (mintToken): verified exactly like
// password sign-ins, which session.api.test.ts covers, without using up the sign-in rate limit.

const ok = z.object({ ok: z.boolean() })

const lineDto = z.object({
  qty: zDecimal,
  unitCost: sensitive(zDecimal, 'cost'),
  supplierPrice: sensitive(zDecimal, 'supplier_price'),
})
const itemDto = z.object({
  name: z.string(),
  price: zDecimal,
  cost: sensitive(zDecimal, 'cost'),
  margin: sensitive(zDecimal, 'profit_margin'),
  lines: z.array(lineDto),
  staff: z.object({
    name: z.string(),
    salary: sensitive(zDecimal, 'payroll'),
    phone: sensitive(z.string(), 'employee_pii'),
  }),
})
const item = {
  name: 'Latte',
  price: '18',
  cost: '6.5',
  margin: '0.6389',
  lines: [{ qty: '0.02', unitCost: '120', supplierPrice: '110' }],
  staff: { name: 'Sara', salary: '4200', phone: '+971500000001' },
}

// The schema paths and the values of each category in `item`.
const PATHS_OF: Record<SensitivityCategory, string[]> = {
  cost: ['cost', 'lines.*.unitCost'],
  profit_margin: ['margin'],
  supplier_price: ['lines.*.supplierPrice'],
  payroll: ['staff.salary'],
  employee_pii: ['staff.phone'],
}
const VALUES_OF: Record<SensitivityCategory, string[]> = {
  cost: ['6.5', '120'],
  profit_margin: ['0.6389'],
  supplier_price: ['110'],
  payroll: ['4200'],
  employee_pii: ['+971500000001'],
}

// Oracle, written out by hand: the categories each starter role template may see (PRODUCT.md §8).
const VISIBLE_TO: Record<RoleTemplateKey, SensitivityCategory[]> = {
  owner: [...SENSITIVITY_CATEGORIES],
  admin: [...SENSITIVITY_CATEGORIES],
  manager: ['cost', 'profit_margin', 'supplier_price'],
  accountant: ['cost', 'profit_margin', 'supplier_price', 'payroll'],
  sales: [],
  supervisor: [],
  employee: [],
}

const SORTABLE: Record<'name' | 'cost' | 'margin', SensitivityCategory | undefined> = {
  name: undefined,
  cost: 'cost',
  margin: 'profit_margin',
}

// Test-only procedures (never part of appRouter).
const testRouter = router({
  ...appRouter._def.record,
  test: router({
    item: businessProcedure
      .output(withMeta(itemDto))
      .query(() => ({ data: item, meta: { redacted: [] } })),
    itemWithoutEnvelope: businessProcedure.output(itemDto).query(() => item),
    itemOutsideBusiness: authedProcedure
      .output(withMeta(itemDto))
      .query(() => ({ data: item, meta: { redacted: [] } })),
    manageMembers: businessProcedure
      .use(requirePermission('settings.members.manage'))
      .output(ok)
      .query(() => ({ ok: true })),
    settings: businessProcedure
      .use(requireModule('settings'))
      .output(ok)
      .query(() => ({ ok: true })),
    materials: businessProcedure
      .use(requireModule('materials'))
      .output(ok)
      .query(() => ({ ok: true })),
    inventory: businessProcedure
      .use(requireModule('inventory'))
      .output(ok)
      .query(() => ({ ok: true })),
    sorted: businessProcedure
      .input(z.object({ sortBy: z.enum(['name', 'cost', 'margin']) }))
      .output(ok)
      .query(({ ctx, input }) => {
        assertQueryable(ctx, [{ name: input.sortBy, category: SORTABLE[input.sortBy] }])
        return { ok: true }
      }),
    secondDefaultLocation: businessProcedure.output(ok).mutation(async ({ ctx }) => {
      await ctx.tx(async (tx) => {
        for (const name of ['One', 'Two']) {
          await tx
            .insert(locations)
            .values({ id: newId(), businessId: ctx.businessId, name, isDefault: true })
        }
      })
      return { ok: true }
    }),
    requestId: businessProcedure
      .output(z.object({ requestId: z.string() }))
      .mutation(async ({ ctx }) => {
        await ctx.tx((tx) =>
          tx.insert(locations).values({ id: newId(), businessId: ctx.businessId, name: 'Audited' }),
        )
        return { requestId: ctx.requestId }
      }),
  }),
})

interface ContextResult {
  roleTemplateKey: string | null
  permissions: { all: boolean; keys: string[] }
  locationScope: { all: true } | { all: false; ids: string[] }
  visibleCategories: string[]
  modules: { id: string; nav: { id: string }[]; quickActions: unknown[] }[]
  terminologyProfile: string
  capabilities: Record<string, boolean>
  permissionsVersion: number
}

type Who = 'owner' | 'staff' | 'manager' | 'outsider' | 'leaver'

let admin: Admin
let db: Db
let handler: ReturnType<typeof handlerFor>
const users = {} as Record<Who, TestUser>
const tokens = {} as Record<Who, string>
const extraUsers: TestUser[] = []
let businessId: string
let outsiderBusinessId: string
let branchId: string
let staffMemberId: string
let leaverMemberId: string

beforeAll(async () => {
  admin = connectAdmin()
  db = connectApi()
  handler = handlerFor(db, testRouter)
  const who: Who[] = ['owner', 'staff', 'manager', 'outsider', 'leaver']
  const created = await Promise.all(who.map(() => createUser()))
  who.forEach((key, index) => (users[key] = created[index] as TestUser))
  const { owner, staff, manager, outsider, leaver } = users
  businessId = (await createBusiness(db, owner, 'Context Cafe')).id
  outsiderBusinessId = (await createBusiness(db, outsider, 'Other Shop')).id
  branchId = newId()
  await withTenantTx(db, tenant(owner.id, businessId), (tx) =>
    tx.insert(locations).values({ id: branchId, businessId, name: 'Branch', isDefault: true }),
  )
  staffMemberId = (
    await addMember(db, owner, businessId, staff, { template: 'employee', locationIds: [branchId] })
  ).memberId
  // A manager who may not see costs: margin must disappear with them, supplier prices stay.
  await addMember(db, owner, businessId, manager, {
    template: 'manager',
    overrides: [{ key: 'data.cost.view', effect: 'deny' }],
  })
  leaverMemberId = (await addMember(db, owner, businessId, leaver, { template: 'employee' }))
    .memberId
  for (const key of who) tokens[key] = await mintToken(users[key])
})

afterAll(async () => {
  await Promise.all([...Object.values(users), ...extraUsers].map(deleteUser))
  await admin.end()
  await db.$client.end()
})

function as(who: Who, business = businessId) {
  return { token: tokens[who], businessId: business }
}

async function setModule(moduleKey: string, enabled: boolean) {
  await withTenantTx(db, tenant(users.owner.id, businessId), (tx) =>
    tx.insert(businessModules).values({ id: newId(), businessId, moduleKey, enabled }),
  )
}

describe('business membership', () => {
  it('rejects a business the caller is not a member of, exactly like one that does not exist', async () => {
    const notMember = await query(handler, 'business.context', as('outsider'))
    const missing = await query(handler, 'business.context', as('outsider', newId()))
    expect(notMember.status).toBe(403)
    expect(notMember.error?.data).toMatchObject({
      appCode: 'forbidden',
      i18nKey: 'errors.forbidden',
    })
    expect(missing.status).toBe(notMember.status)
    expect(missing.error?.message).toBe(notMember.error?.message)
    expect(missing.error?.data.appCode).toBe(notMember.error?.data.appCode)
  })

  it('works in both directions: each owner opens only their own business', async () => {
    expect(
      (await query(handler, 'business.context', as('outsider', outsiderBusinessId))).status,
    ).toBe(200)
    const intruder = await query(handler, 'business.context', as('owner', outsiderBusinessId))
    expect(intruder.error?.data.appCode).toBe('forbidden')
  })

  it('requires x-business-id', async () => {
    const result = await query(handler, 'business.context', { token: tokens.owner })
    expect(result.error?.data.appCode).toBe('validation')
  })

  it('requires a session', async () => {
    const result = await query(handler, 'business.context', { businessId })
    expect(result.error?.data.appCode).toBe('unauthorized')
  })
})

describe('business.context', () => {
  it('gives the owner every permission, every category and all locations', async () => {
    const result = await query<ContextResult>(handler, 'business.context', as('owner'))
    expect(result.status).toBe(200)
    expect(result.headers.get('x-permissions-version')).toBe('1')
    expect(result.data).toEqual({
      roleTemplateKey: 'owner',
      permissions: { all: true, keys: [...PERMISSION_CATALOG].sort() },
      locationScope: { all: true },
      visibleCategories: [...SENSITIVITY_CATEGORIES],
      modules: [
        {
          id: 'dashboard',
          nav: [
            {
              id: 'dashboard',
              labelKey: 'nav.dashboard',
              path: '',
              icon: 'layout-dashboard',
              group: 'main',
            },
          ],
          quickActions: [],
        },
        {
          id: 'settings',
          nav: [
            {
              id: 'settings',
              labelKey: 'nav.settings',
              path: 'settings',
              icon: 'settings',
              group: 'system',
            },
          ],
          quickActions: [],
        },
      ],
      terminologyProfile: 'general',
      capabilities: {
        has_team: false,
        multi_location: false,
        keeps_stock: false,
        uses_machines: false,
        sells_via_pos: false,
        jobs_and_tasks: false,
        vat_registered: false,
      },
      permissionsVersion: 1,
    })
  })

  it('gives an employee the template keys only, no categories and their locations', async () => {
    const result = await query<ContextResult>(handler, 'business.context', as('staff'))
    expect(result.data).toMatchObject({
      roleTemplateKey: 'employee',
      permissions: { all: false, keys: ['dashboard.home.view'] },
      locationScope: { all: false, ids: [branchId] },
      visibleCategories: [],
    })
    expect(result.data?.modules.map((m) => [m.id, m.nav.map((n) => n.id)])).toEqual([
      ['dashboard', ['dashboard']],
      ['settings', ['settings']],
    ])
  })

  it('applies deny overrides and the cost → margin grouping rule', async () => {
    const result = await query<ContextResult>(handler, 'business.context', as('manager'))
    expect(result.data?.roleTemplateKey).toBe('manager')
    expect(result.data?.permissions.keys).not.toContain('data.cost.view')
    expect(result.data?.permissions.keys).toContain('data.profit_margin.view')
    expect(result.data?.visibleCategories).toEqual(['supplier_price'])
  })

  it('derives vat_registered from the business and reads stored capabilities', async () => {
    await withTenantTx(db, tenant(users.owner.id, businessId), async (tx) => {
      await tx.update(businesses).set({ vatRegistered: true }).where(eq(businesses.id, businessId))
      // A stored capability row, as Smart Setup will write it.
      await tx.insert(businessCapabilities).values({
        id: newId(),
        businessId,
        key: 'has_team',
        enabled: true,
        source: 'setup',
      })
    })
    const result = await query<ContextResult>(handler, 'business.context', as('staff'))
    expect(result.data?.capabilities).toMatchObject({ vat_registered: true, has_team: true })
  })

  it('shows released modules only, even when planned modules are on', async () => {
    // Materials (core) is on without a row; Orders (optional) is switched on by its row.
    await setModule('orders', true)
    const result = await query<ContextResult>(handler, 'business.context', as('owner'))
    expect(result.data?.modules.map((m) => m.id)).toEqual(['dashboard', 'settings'])
  })

  it('answers a batch with one membership check and one x-permissions-version', async () => {
    const result = await batch(handler, ['me', 'business.context'], as('staff'))
    expect(result.status).toBe(200)
    expect(result.results).toHaveLength(2)
    expect(result.results.every((r) => r.result !== undefined)).toBe(true)
    expect(result.headers.get('x-permissions-version')).toBe('1')
  })
})

describe('module and permission gates', () => {
  it('requirePermission: FORBIDDEN without the key, allowed with it or as owner', async () => {
    expect((await query(handler, 'test.manageMembers', as('staff'))).error?.data.appCode).toBe(
      'forbidden',
    )
    expect((await query(handler, 'test.manageMembers', as('owner'))).data).toEqual({ ok: true })
  })

  it('requirePermission: an allow override grants the key', async () => {
    await withTenantTx(db, tenant(users.owner.id, businessId), (tx) =>
      tx.insert(memberPermissionOverrides).values({
        id: newId(),
        businessId,
        memberId: staffMemberId,
        permissionKey: 'settings.members.manage',
        effect: 'allow',
      }),
    )
    expect((await query(handler, 'test.manageMembers', as('staff'))).data).toEqual({ ok: true })
  })

  it('requireModule: Dashboard and Settings pass, even with a row that switches them off', async () => {
    await setModule('settings', false)
    expect((await query(handler, 'test.settings', as('staff'))).data).toEqual({ ok: true })
  })

  it('requireModule: MODULE_DISABLED for planned modules, on by default (core) or by a row', async () => {
    await setModule('inventory', true)
    for (const path of ['test.materials', 'test.inventory']) {
      const result = await query(handler, path, as('owner'))
      expect(result.status, path).toBe(403)
      expect(result.error?.data, path).toMatchObject({
        appCode: 'module_disabled',
        i18nKey: 'errors.module_disabled',
      })
    }
  })
})

describe('redaction', () => {
  it('shows the owner everything', async () => {
    const result = await query(handler, 'test.item', as('owner'))
    expect(result.data).toEqual({ data: item, meta: { redacted: [] } })
  })

  it('removes every sensitive field for an employee and lists the paths', async () => {
    const result = await query(handler, 'test.item', as('staff'))
    expect(result.data).toEqual({
      data: { name: 'Latte', price: '18', lines: [{ qty: '0.02' }], staff: { name: 'Sara' } },
      meta: {
        redacted: [
          'cost',
          'lines.*.supplierPrice',
          'lines.*.unitCost',
          'margin',
          'staff.phone',
          'staff.salary',
        ],
      },
    })
    expect(JSON.stringify(result.data)).not.toMatch(/6\.5|0\.6389|120|110|4200|\+971/)
  })

  it('hides the margin together with a denied cost, keeps supplier prices', async () => {
    const result = await query<{ data: typeof item; meta: { redacted: string[] } }>(
      handler,
      'test.item',
      as('manager'),
    )
    expect(result.data?.meta.redacted).toEqual([
      'cost',
      'lines.*.unitCost',
      'margin',
      'staff.phone',
      'staff.salary',
    ])
    expect(result.data?.data.lines).toEqual([{ qty: '0.02', supplierPrice: '110' }])
    expect(result.data?.data).not.toHaveProperty('margin')
  })

  it('refuses sensitive output without the envelope or outside a business', async () => {
    const bare = await query(handler, 'test.itemWithoutEnvelope', as('owner'))
    expect(bare.error?.data.appCode).toBe('internal')
    expect(bare.raw).not.toMatch(/6\.5|4200/)
    const outside = await query(handler, 'test.itemOutsideBusiness', { token: tokens.owner })
    expect(outside.error?.data.appCode).toBe('internal')
    expect(outside.raw).not.toMatch(/6\.5|4200/)
  })
})

describe('redaction for every role template', () => {
  const templateTokens = new Map<RoleTemplateKey, string>()

  beforeAll(async () => {
    templateTokens.set('owner', tokens.owner)
    for (const key of ROLE_TEMPLATE_KEYS.filter((k) => k !== 'owner')) {
      const user = await createUser()
      extraUsers.push(user)
      await addMember(db, users.owner, businessId, user, { template: key })
      templateTokens.set(key, await mintToken(user))
    }
  })

  it.each(ROLE_TEMPLATE_KEYS)('%s receives exactly the categories of its template', async (key) => {
    const token = templateTokens.get(key) ?? ''
    const visible = new Set(VISIBLE_TO[key])
    const result = await query<{ meta: { redacted: string[] } }>(handler, 'test.item', {
      token,
      businessId,
    })
    expect(result.status).toBe(200)
    const hidden = SENSITIVITY_CATEGORIES.filter((c) => !visible.has(c))
    expect(result.data?.meta.redacted).toEqual(hidden.flatMap((c) => PATHS_OF[c]).sort())
    for (const category of SENSITIVITY_CATEGORIES) {
      for (const value of VALUES_OF[category]) {
        expect(result.raw.includes(value), `${key}: ${category}`).toBe(visible.has(category))
      }
    }
    const context = await query<ContextResult>(handler, 'business.context', { token, businessId })
    expect(context.data?.visibleCategories).toEqual(VISIBLE_TO[key])
  })
})

describe('assertQueryable', () => {
  it('lets anyone sort by a plain field', async () => {
    const result = await query(handler, 'test.sorted', {
      ...as('staff'),
      input: { sortBy: 'name' },
    })
    expect(result.data).toEqual({ ok: true })
  })

  it('is FORBIDDEN to sort by a hidden field', async () => {
    const byCost = await query(handler, 'test.sorted', {
      ...as('staff'),
      input: { sortBy: 'cost' },
    })
    expect(byCost.error?.data.appCode).toBe('forbidden')
    const byMargin = await query(handler, 'test.sorted', {
      ...as('manager'),
      input: { sortBy: 'margin' },
    })
    expect(byMargin.error?.data.appCode).toBe('forbidden')
  })

  it('lets the owner sort by cost', async () => {
    const result = await query(handler, 'test.sorted', {
      ...as('owner'),
      input: { sortBy: 'cost' },
    })
    expect(result.data).toEqual({ ok: true })
  })
})

describe('writes', () => {
  it('maps a unique violation to CONFLICT without SQL text', async () => {
    const result = await mutate(handler, 'test.secondDefaultLocation', {
      ...as('owner'),
      headers: { origin: ORIGIN },
    })
    expect(result.status).toBe(409)
    expect(result.error?.data).toMatchObject({ appCode: 'conflict', i18nKey: 'errors.conflict' })
    expect(result.raw).not.toMatch(/locations_one_default_key|duplicate key/)
  })

  it('records the request id on the audit rows of the write', async () => {
    const result = await mutate<{ requestId: string }>(handler, 'test.requestId', as('owner'))
    const requestId = result.data?.requestId
    expect(result.headers.get('x-request-id')).toBe(requestId)
    const rows = await admin<{ actor_user_id: string }[]>`
      select actor_user_id from app.audit_log where request_id = ${requestId ?? ''}`
    expect(rows).toEqual([{ actor_user_id: users.owner.id }])
  })
})

describe('membership changes', () => {
  it('rejects a removed member on their next request, with the same token', async () => {
    expect((await query(handler, 'business.context', as('leaver'))).status).toBe(200)
    await withTenantTx(db, tenant(users.owner.id, businessId), (tx) =>
      tx
        .update(businessMembers)
        .set({ status: 'removed' })
        .where(eq(businessMembers.id, leaverMemberId)),
    )
    const after = await query(handler, 'business.context', as('leaver'))
    expect(after.status).toBe(403)
    expect(after.error?.data.appCode).toBe('forbidden')
    const me = await query<{ memberships: unknown[] }>(handler, 'me', { token: tokens.leaver })
    expect(me.data?.memberships).toEqual([])
  })
})

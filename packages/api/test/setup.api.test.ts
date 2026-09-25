import type { CreateFromSetupInput, MeDto, ProfileDto } from '@bizcost/contracts'
import type { Db } from '@bizcost/db'
import { newId } from '@bizcost/domain'
import {
  QUESTION_SET_VERSION,
  ROLE_TEMPLATES,
  STORED_CAPABILITY_KEYS,
  type SetupAnswers,
} from '@bizcost/modules'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
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
  type Admin,
  type CallResult,
  type TestUser,
} from './helpers'

// Smart Setup's confirm step (business.createFromSetup) and account.setLastBusiness through the real
// fetch handler, with the database checked as postgres (docs/PRODUCT.md §6, ROADMAP.md Step 5).

let db: Db
let admin: Admin
let handler: ReturnType<typeof handlerFor>
const users: TestUser[] = []

beforeAll(() => {
  db = connectApi()
  admin = connectAdmin()
  handler = handlerFor(db)
})

afterAll(async () => {
  for (const user of users) await deleteUser(user)
  await admin.end()
  await db.$client.end()
})

async function newUser(locale: 'en' | 'ar' = 'en') {
  const user = await createUser({ locale })
  users.push(user)
  return { user, token: await mintToken(user) }
}

const BAKER: SetupAnswers = {
  what_you_do: ['food_drinks'],
  workplace: 'home',
  team: 'alone',
  work_setup: ['none'],
  sales_channels: ['messages'],
  vat: 'no',
}
const DESIGNER: SetupAnswers = {
  what_you_do: ['services'],
  workplace: 'home',
  team: 'alone',
  work_setup: ['none'],
  sales_channels: ['messages', 'quotes', 'invoice_later'],
  vat: 'no',
}
const WORKSHOP: SetupAnswers = {
  what_you_do: ['make_products'],
  how_you_make: ['custom_jobs'],
  workplace: 'workshop',
  branches: true,
  team: 'team',
  team_tracking: ['hours', 'salaries', 'staff_cash'],
  work_setup: ['stock', 'machines', 'vehicles'],
  sales_channels: ['messages', 'quotes'],
  vat: 'yes',
}

function setupInput(patch: Partial<CreateFromSetupInput> = {}): CreateFromSetupInput {
  return {
    businessId: newId(),
    legalName: "  Sara's Sweets  ",
    locale: 'en',
    questionSetVersion: QUESTION_SET_VERSION,
    answers: BAKER as CreateFromSetupInput['answers'],
    adjustments: { modules: [], capabilities: [] },
    ...patch,
  }
}

function createFromSetup(token: string, input: unknown) {
  return mutate<{ businessId: string }>(handler, 'business.createFromSetup', { token, input })
}

function appCode(result: CallResult) {
  return result.error?.data.appCode
}

async function businessRow(id: string) {
  const [row] = await admin<
    {
      legal_name: string
      business_type: string | null
      terminology_profile: string
      vat_registered: boolean
      default_locale: string
      setup_completed_at: Date | null
    }[]
  >`select legal_name, business_type, terminology_profile, vat_registered, default_locale,
           setup_completed_at
      from app.businesses where id = ${id}`
  return row
}

async function capabilityRows(id: string) {
  return admin<{ key: string; enabled: boolean; source: string }[]>`
    select key, enabled, source from app.business_capabilities
     where business_id = ${id} order by key`
}

async function moduleRows(id: string) {
  const rows = await admin<{ module_key: string; enabled: boolean }[]>`
    select module_key, enabled from app.business_modules where business_id = ${id}`
  return Object.fromEntries(rows.map((r) => [r.module_key, r.enabled]))
}

async function countBusinesses(id: string) {
  const [row] = await admin<{ n: number }[]>`
    select count(*)::int as n from app.businesses where id = ${id}`
  return row?.n ?? 0
}

describe('business.createFromSetup', () => {
  it('creates the business with its whole setup in one go (home baker, Arabic)', async () => {
    const { user, token } = await newUser('ar')
    const input = setupInput({ locale: 'ar' })
    const result = await createFromSetup(token, input)
    expect(result.error).toBeUndefined()
    const id = input.businessId
    expect(result.data).toEqual({ businessId: id })

    expect(await businessRow(id)).toMatchObject({
      legal_name: "Sara's Sweets",
      business_type: 'food',
      terminology_profile: 'food',
      vat_registered: false,
      default_locale: 'ar',
    })
    expect((await businessRow(id))?.setup_completed_at).toBeInstanceOf(Date)

    const [answers] = await admin<{ question_set_version: number; answers: unknown }[]>`
      select question_set_version, answers from app.setup_answers where business_id = ${id}`
    expect(answers).toEqual({ question_set_version: 1, answers: BAKER })

    expect(await capabilityRows(id)).toEqual(
      [...STORED_CAPABILITY_KEYS].sort().map((key) => ({ key, enabled: false, source: 'setup' })),
    )
    // D-059: only the optional module that is on gets a row (no core module is off for a baker).
    expect(await moduleRows(id)).toEqual({ orders: true })

    const places = await admin<{ name: string; is_default: boolean }[]>`
      select name, is_default from app.locations where business_id = ${id}`
    expect(places).toEqual([{ name: 'المنزل', is_default: true }])

    const [profile] = await admin<{ last_business_id: string | null }[]>`
      select last_business_id from app.profiles where id = ${user.id}`
    expect(profile?.last_business_id).toBe(id)

    // Every write is audited with the caller and this request's id.
    const audit = await admin<{ entity: string; actor_user_id: string; request_id: string }[]>`
      select entity, actor_user_id, request_id from app.audit_log where business_id = ${id}`
    expect(new Set(audit.map((a) => a.entity))).toEqual(
      new Set([
        'businesses',
        'roles',
        'business_members',
        'setup_answers',
        'business_capabilities',
        'business_modules',
        'locations',
        'role_permissions',
      ]),
    )
    for (const row of audit) {
      expect(row.actor_user_id).toBe(user.id)
      expect(row.request_id).toBe(result.headers.get('x-request-id'))
    }
  })

  it('copies the seven role templates with their permissions, named in the user language', async () => {
    const { user, token } = await newUser('en')
    const input = setupInput()
    await createFromSetup(token, input)
    const id = input.businessId

    const roleRows = await admin<{ id: string; name: string; template_key: string | null }[]>`
      select id, name, template_key from app.roles where business_id = ${id}`
    expect(roleRows.map((r) => r.template_key).sort()).toEqual(
      ROLE_TEMPLATES.map((t) => t.key).sort(),
    )
    expect(Object.fromEntries(roleRows.map((r) => [r.template_key, r.name]))).toEqual({
      owner: 'Owner',
      admin: 'Admin',
      manager: 'Manager',
      accountant: 'Accountant',
      sales: 'Sales',
      supervisor: 'Supervisor',
      employee: 'Employee',
    })
    const grants = await admin<{ template_key: string; permission_key: string }[]>`
      select r.template_key, rp.permission_key
        from app.role_permissions rp join app.roles r on r.id = rp.role_id
       where rp.business_id = ${id}`
    for (const template of ROLE_TEMPLATES) {
      const keys = grants
        .filter((g) => g.template_key === template.key)
        .map((g) => g.permission_key)
      expect(keys.sort(), template.key).toEqual([...template.permissionKeys].sort())
    }

    const [member] = await admin<{ template_key: string; status: string; display_name: string }[]>`
      select r.template_key, m.status, m.display_name
        from app.business_members m join app.roles r on r.id = m.role_id
       where m.business_id = ${id} and m.user_id = ${user.id}`
    expect(member).toEqual({
      template_key: 'owner',
      status: 'active',
      display_name: user.email.split('@')[0],
    })
  })

  it('shows up in me and business.context (capabilities, wording, released modules)', async () => {
    const { token } = await newUser()
    const input = setupInput({ legalName: 'Oak & Iron', answers: WORKSHOP as never })
    await createFromSetup(token, input)
    const id = input.businessId

    const me = await query<MeDto>(handler, 'me', { token })
    expect(me.data?.profile.lastBusinessId).toBe(id)
    expect(me.data?.memberships).toEqual([
      { businessId: id, legalName: 'Oak & Iron', roleTemplateKey: 'owner', status: 'active' },
    ])

    const context = await query<{
      terminologyProfile: string
      capabilities: Record<string, boolean>
      modules: { id: string }[]
    }>(handler, 'business.context', { token, businessId: id })
    expect(context.data?.terminologyProfile).toBe('workshop')
    expect(context.data?.capabilities).toEqual({
      has_team: true,
      multi_location: true,
      keeps_stock: true,
      uses_machines: true,
      sells_via_pos: false,
      jobs_and_tasks: true,
      vat_registered: true,
    })
    // Planned modules are saved but stay hidden: only Dashboard and Settings are released.
    expect(context.data?.modules.map((m) => m.id)).toEqual(['dashboard', 'settings'])
    expect(await moduleRows(id)).toMatchObject({ orders: true, vat_center: true, equipment: true })

    const [place] = await admin<{ name: string }[]>`
      select name from app.locations where business_id = ${id}`
    expect(place?.name).toBe('Main workshop')
  })

  it('recomputes the recommendation and ignores anything the client adds to it', async () => {
    const { token } = await newUser()
    const input = setupInput({ answers: DESIGNER as never })
    const forged = {
      ...input,
      businessType: 'factory',
      terminologyProfile: 'factory',
      capabilities: { has_team: true },
      modules: ['employees', 'vat_center'],
      recommendation: { modules: [{ id: 'payroll' }] },
      vatRegistered: true,
    }
    const result = await createFromSetup(token, forged)
    expect(result.error).toBeUndefined()
    const id = input.businessId
    expect(await businessRow(id)).toMatchObject({
      business_type: 'services',
      terminology_profile: 'general',
      vat_registered: false,
    })
    expect(await moduleRows(id)).toEqual({
      materials: false,
      purchases: false,
      quotations: true,
      invoices: true,
    })
    expect((await capabilityRows(id)).every((c) => !c.enabled)).toBe(true)
  })

  it('applies review adjustments with their dependencies and marks changed capabilities', async () => {
    const { token } = await newUser()
    const input = setupInput({
      answers: DESIGNER as never,
      adjustments: {
        // Turning Usage & Waste on needs Stock, Materials, Purchases and the stock capability;
        // turning Customers off takes Quotations and Invoices with it.
        modules: [
          { id: 'usage_waste', enabled: true },
          { id: 'customers', enabled: false },
        ],
        capabilities: [{ key: 'multi_location', enabled: true }],
      },
    })
    const result = await createFromSetup(token, input)
    expect(result.error).toBeUndefined()
    const id = input.businessId
    expect(await moduleRows(id)).toEqual({ customers: false, inventory: true, usage_waste: true })
    const caps = Object.fromEntries((await capabilityRows(id)).map((c) => [c.key, c]))
    expect(caps.keeps_stock).toEqual({ key: 'keeps_stock', enabled: true, source: 'user' })
    expect(caps.multi_location).toEqual({ key: 'multi_location', enabled: true, source: 'user' })
    expect(caps.has_team).toEqual({ key: 'has_team', enabled: false, source: 'setup' })
    const [place] = await admin<{ name: string }[]>`
      select name from app.locations where business_id = ${id}`
    expect(place?.name).toBe('Main branch')
  })

  it('refuses invalid answers and adjustments with VALIDATION, writing nothing', async () => {
    const { token } = await newUser()
    const cases: [string, Partial<CreateFromSetupInput>][] = [
      ['a hidden question', { answers: { ...BAKER, branches: true } as never }],
      ['a hidden option', { answers: { ...BAKER, sales_channels: ['walk_in'] } as never }],
      ['a missing answer', { answers: { ...BAKER, vat: undefined } as never }],
      ['an unknown question', { answers: { ...BAKER, goals: 'profit' } as never }],
      [
        'an exclusive option with another',
        { answers: { ...BAKER, work_setup: ['none', 'stock'] } as never },
      ],
      ['another question set', { questionSetVersion: 2 }],
      [
        'switching Dashboard off',
        { adjustments: { modules: [{ id: 'dashboard', enabled: false }], capabilities: [] } },
      ],
      [
        'switching Settings off',
        { adjustments: { modules: [{ id: 'settings', enabled: false }], capabilities: [] } },
      ],
      [
        'an unknown module',
        { adjustments: { modules: [{ id: 'crm', enabled: true }], capabilities: [] } },
      ],
      [
        'an unknown capability',
        { adjustments: { modules: [], capabilities: [{ key: 'works_alone', enabled: true }] } },
      ],
      [
        'the same module twice',
        {
          adjustments: {
            modules: [
              { id: 'orders', enabled: true },
              { id: 'orders', enabled: false },
            ],
            capabilities: [],
          },
        },
      ],
      [
        'VAT Center without VAT (VAT never changes as a side effect)',
        { adjustments: { modules: [{ id: 'vat_center', enabled: true }], capabilities: [] } },
      ],
      ['an empty name', { legalName: '   ' }],
      ['a name over 100 characters', { legalName: 'x'.repeat(101) }],
    ]
    for (const [label, patch] of cases) {
      const input = setupInput(patch)
      const result = await createFromSetup(token, input)
      expect(appCode(result), label).toBe('validation')
      expect(result.status, label).toBe(400)
      expect(await countBusinesses(input.businessId), label).toBe(0)
    }
  })

  it('is idempotent on businessId: the same payload gives the same business, another is CONFLICT', async () => {
    const { user, token } = await newUser()
    const input = setupInput({ answers: DESIGNER as never })
    const first = await createFromSetup(token, input)
    // Reordered multi answers and adjustments are the same payload.
    const again = await createFromSetup(token, {
      ...input,
      answers: { ...DESIGNER, sales_channels: ['invoice_later', 'messages', 'quotes'] },
    })
    expect(first.data).toEqual({ businessId: input.businessId })
    expect(again.data).toEqual({ businessId: input.businessId })
    expect(await countBusinesses(input.businessId)).toBe(1)
    const [roleCount] = await admin<{ n: number }[]>`
      select count(*)::int as n from app.roles where business_id = ${input.businessId}`
    expect(roleCount?.n).toBe(7)

    const changed = await createFromSetup(token, { ...input, legalName: 'Another name' })
    expect(appCode(changed)).toBe('conflict')
    expect(changed.status).toBe(409)
    const [row] = await admin<{ legal_name: string }[]>`
      select legal_name from app.businesses where id = ${input.businessId}`
    expect(row?.legal_name).toBe("Sara's Sweets")

    // Another user reusing the id cannot see or take over the business.
    const other = await newUser()
    const stolen = await createFromSetup(other.token, input)
    expect(appCode(stolen)).toBe('conflict')
    const [owner] = await admin<{ n: number }[]>`
      select count(*)::int as n from app.business_members
       where business_id = ${input.businessId} and user_id = ${other.user.id}`
    expect(owner?.n).toBe(0)
    expect(user.id).not.toBe(other.user.id)
  })

  it('handles two identical requests at once: both get the business', async () => {
    const { token } = await newUser()
    const input = setupInput()
    const results = await Promise.all([
      createFromSetup(token, input),
      createFromSetup(token, input),
    ])
    for (const result of results) expect(result.data).toEqual({ businessId: input.businessId })
    expect(await countBusinesses(input.businessId)).toBe(1)
  })

  it('allows at most 10 new businesses per user a day (rate_limited, nothing written)', async () => {
    const { user, token } = await newUser()
    for (let i = 0; i < 10; i++) await createBusiness(db, user, `Business ${i}`)
    const input = setupInput()
    const result = await createFromSetup(token, input)
    expect(appCode(result)).toBe('rate_limited')
    expect(result.status).toBe(429)
    expect(await countBusinesses(input.businessId)).toBe(0)
    // Another user is not affected.
    const other = await newUser()
    expect((await createFromSetup(other.token, setupInput())).error).toBeUndefined()
  })

  it('keeps the new business private to its owner', async () => {
    const owner = await newUser()
    const outsider = await newUser()
    const input = setupInput()
    await createFromSetup(owner.token, input)
    const id = input.businessId

    const context = await query(handler, 'business.context', {
      token: outsider.token,
      businessId: id,
    })
    expect(appCode(context)).toBe('forbidden')
    const me = await query<MeDto>(handler, 'me', { token: outsider.token })
    expect(me.data?.memberships).toEqual([])
    const last = await mutate(handler, 'account.setLastBusiness', {
      token: outsider.token,
      input: { businessId: id },
    })
    expect(appCode(last)).toBe('forbidden')
  })

  it('needs a signed-in caller', async () => {
    const result = await mutate(handler, 'business.createFromSetup', {
      input: setupInput(),
      headers: { origin: ORIGIN },
    })
    expect(appCode(result)).toBe('unauthorized')
  })
})

describe('account.setLastBusiness', () => {
  it('remembers a business the caller is an active member of', async () => {
    const { user, token } = await newUser()
    const first = setupInput()
    const second = setupInput({ legalName: 'Second' })
    await createFromSetup(token, first)
    await createFromSetup(token, second)

    const result = await mutate<ProfileDto>(handler, 'account.setLastBusiness', {
      token,
      input: { businessId: first.businessId },
    })
    expect(result.data?.lastBusinessId).toBe(first.businessId)
    const [profile] = await admin<{ last_business_id: string | null }[]>`
      select last_business_id from app.profiles where id = ${user.id}`
    expect(profile?.last_business_id).toBe(first.businessId)
  })

  it('answers FORBIDDEN for a business that does not exist', async () => {
    const { token } = await newUser()
    const result = await mutate(handler, 'account.setLastBusiness', {
      token,
      input: { businessId: newId() },
    })
    expect(appCode(result)).toBe('forbidden')
  })
})

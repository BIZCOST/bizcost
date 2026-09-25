import { createI18n, terminologyKey } from '@bizcost/i18n'
import { describe, expect, it } from 'vitest'
import { STORED_CAPABILITY_KEYS, type StoredCapabilityKey } from '../capabilities'
import { MODULES, type ModuleId } from '../manifests'
import type { SetupAnswers } from './answers'
import { REASON_VARIANTS, recommend, type Recommendation } from './recommend'
import { normalizeAnswers } from './walk'

// The persona table and edge cases of docs/PRODUCT.md §6.11 (G6), plus rule details.

interface Expected {
  questions: number
  type: Recommendation['businessType']
  profile: Recommendation['terminologyProfile']
  capabilities: StoredCapabilityKey[]
  vat: boolean | null
  /** Optional modules that are on. */
  optional: ModuleId[]
  /** Core modules that are off. */
  coreOff: ModuleId[]
  /** Every reason that is not `default`, as module → variant (all others must be `default`). */
  reasons: Partial<Record<ModuleId, string>>
  offNotes?: Partial<Record<ModuleId, string>>
  jobsReason?: 'custom_jobs' | 'services' | null
  location: [kind: Recommendation['defaultLocationKind'], en: string, ar: string]
}

const en = createI18n({ locale: 'en' })
const ar = createI18n({ locale: 'ar' })

function check(answers: SetupAnswers, x: Expected) {
  const { shown, complete } = normalizeAnswers(answers)
  expect(complete, 'answers are a complete walk').toBe(true)
  expect(shown).toHaveLength(x.questions)

  const rec = recommend(answers)
  expect([rec.businessType, rec.terminologyProfile]).toEqual([x.type, x.profile])
  expect(STORED_CAPABILITY_KEYS.filter((k) => rec.capabilities[k])).toEqual(x.capabilities)
  expect(rec.vatRegistered).toBe(x.vat)

  const on = new Set(rec.modules.map((m) => m.id))
  const kind = (id: ModuleId) => MODULES.find((m) => m.id === id)!.kind
  expect(MODULES.filter((m) => m.kind === 'optional' && on.has(m.id)).map((m) => m.id)).toEqual(
    x.optional,
  )
  expect(MODULES.filter((m) => m.kind === 'core' && !on.has(m.id)).map((m) => m.id)).toEqual(
    x.coreOff,
  )

  for (const { id, reason } of rec.modules) {
    if (id === 'dashboard' || id === 'settings') {
      expect(reason).toBe('setup.reason.always')
      continue
    }
    const variant = x.reasons[id] ?? 'default'
    expect(reason, `${id} (${kind(id)})`).toBe(`setup.reason.${id}.${variant}`)
  }
  for (const id of Object.keys(x.reasons)) expect(on.has(id as ModuleId), id).toBe(true)

  expect(Object.fromEntries(rec.offNotes.map((n) => [n.id, n.reason]))).toEqual(
    Object.fromEntries(
      Object.entries(x.offNotes ?? {}).map(([id, v]) => [id, `setup.note.${id}.${v}`]),
    ),
  )
  if (x.jobsReason !== undefined) {
    expect(rec.jobsReason).toBe(x.jobsReason && `setup.jobs.reason.${x.jobsReason}`)
  }
  const [kindOf, enName, arName] = x.location
  expect(rec.defaultLocationKind).toBe(kindOf)
  expect(en.t(rec.defaultLocationNameKey)).toBe(enName)
  expect(ar.t(rec.defaultLocationNameKey)).toBe(arName)
  return rec
}

describe('recommend(): personas (PRODUCT.md §6.11)', () => {
  it('1. home baker, alone', () => {
    check(
      {
        what_you_do: ['food_drinks'],
        workplace: 'home',
        team: 'alone',
        work_setup: ['none'],
        sales_channels: ['messages'],
        vat: 'no',
      },
      {
        questions: 6,
        type: 'food',
        profile: 'food',
        capabilities: [],
        vat: false,
        optional: ['orders'],
        coreOff: [],
        reasons: {
          orders: 'messages',
          materials: 'food',
          running_costs: 'home',
          cost_engine: 'solo',
          sales: 'with_orders',
          payments: 'orders',
        },
        location: ['home', 'Home', 'المنزل'],
      },
    )
  })

  it('2. coffee shop with a POS and staff', () => {
    check(
      {
        what_you_do: ['food_drinks'],
        workplace: 'shop',
        branches: false,
        team: 'team',
        team_tracking: ['hours', 'salaries', 'staff_cash'],
        work_setup: ['stock'],
        sales_channels: ['walk_in', 'online'],
        pos: true,
        vat: 'yes',
      },
      {
        questions: 9,
        type: 'food',
        profile: 'food',
        capabilities: ['has_team', 'keeps_stock', 'sells_via_pos'],
        vat: true,
        optional: [
          'inventory',
          'usage_waste',
          'employees',
          'attendance',
          'payroll',
          'petty_cash',
          'vat_center',
        ],
        coreOff: ['customers', 'payments'],
        reasons: { materials: 'food', sales: 'pos_apps' },
        offNotes: { invoices: 'pos_off' },
        location: ['shop', 'Shop', 'المحل'],
      },
    )
  })

  it('3. 3D printing maker with one helper', () => {
    check(
      {
        what_you_do: ['make_products'],
        how_you_make: ['catalog', 'custom_jobs'],
        workplace: 'home',
        team: 'team',
        team_tracking: ['cost_only'],
        work_setup: ['stock', 'machines'],
        sales_channels: ['messages', 'online'],
        vat: 'no',
      },
      {
        questions: 8,
        type: 'maker',
        profile: 'maker',
        capabilities: ['has_team', 'keeps_stock', 'uses_machines', 'jobs_and_tasks'],
        vat: false,
        optional: ['orders', 'inventory', 'usage_waste', 'employees', 'equipment'],
        coreOff: [],
        reasons: {
          orders: 'messages',
          usage_waste: 'make',
          materials: 'make',
          running_costs: 'home',
          cost_engine: 'jobs',
          payments: 'deposits',
          sales: 'apps',
        },
        jobsReason: 'custom_jobs',
        location: ['home', 'Home', 'المنزل'],
      },
    )
  })

  it('4. fit-out / decor project company', () => {
    check(
      {
        what_you_do: ['projects'],
        workplace: 'customer_sites',
        branches: false,
        team: 'team',
        team_tracking: ['hours', 'salaries', 'staff_cash'],
        work_setup: ['materials', 'vehicles'],
        vat: 'yes',
      },
      {
        questions: 7,
        type: 'projects',
        profile: 'projects',
        capabilities: ['has_team'],
        vat: true,
        optional: [
          'quotations',
          'invoices',
          'employees',
          'attendance',
          'payroll',
          'vehicles',
          'projects',
          'petty_cash',
          'vat_center',
        ],
        coreOff: [],
        reasons: {
          quotations: 'projects',
          invoices: 'projects',
          products: 'projects',
          materials: 'uses',
          suppliers: 'projects',
          payments: 'projects',
          sales: 'invoices',
          reports: 'projects',
        },
        jobsReason: null,
        location: ['site', 'Main base', 'المقر الرئيسي'],
      },
    )
  })

  it('5. freelance designer (services only)', () => {
    check(
      {
        what_you_do: ['services'],
        workplace: 'home',
        team: 'alone',
        work_setup: ['none'],
        sales_channels: ['messages', 'quotes', 'invoice_later'],
        vat: 'no',
      },
      {
        questions: 6,
        type: 'services',
        profile: 'general',
        capabilities: [],
        vat: false,
        optional: ['quotations', 'invoices'],
        coreOff: ['materials', 'purchases'],
        reasons: {
          quotations: 'quotes',
          invoices: 'quotes',
          products: 'services',
          suppliers: 'no_purchases',
          running_costs: 'home',
          cost_engine: 'solo',
          sales: 'invoices',
        },
        jobsReason: 'services',
        location: ['home', 'Home', 'المنزل'],
      },
    )
  })

  it('6. retail shop with stock', () => {
    check(
      {
        what_you_do: ['sell_products'],
        workplace: 'shop',
        branches: false,
        team: 'team',
        team_tracking: ['salaries', 'staff_cash'],
        work_setup: ['stock', 'vehicles'],
        sales_channels: ['walk_in', 'messages'],
        pos: true,
        vat: 'yes',
      },
      {
        questions: 9,
        type: 'retail',
        profile: 'general',
        capabilities: ['has_team', 'keeps_stock', 'sells_via_pos'],
        vat: true,
        optional: [
          'inventory',
          'usage_waste',
          'employees',
          'payroll',
          'vehicles',
          'petty_cash',
          'vat_center',
        ],
        coreOff: ['customers', 'payments'],
        reasons: { usage_waste: 'resell', materials: 'resell', sales: 'pos' },
        offNotes: { orders: 'outside_pos', invoices: 'pos_off' },
        location: ['shop', 'Shop', 'المحل'],
      },
    )
  })

  it('7. small factory (cleaning products)', () => {
    const rec = check(
      {
        what_you_do: ['make_products'],
        how_you_make: ['batches'],
        workplace: 'factory',
        branches: false,
        team: 'team',
        team_tracking: ['hours', 'salaries'],
        work_setup: ['stock', 'machines', 'vehicles'],
        sales_channels: ['messages', 'quotes', 'invoice_later'],
        vat: 'yes',
      },
      {
        questions: 9,
        type: 'factory',
        profile: 'factory',
        capabilities: ['has_team', 'keeps_stock', 'uses_machines'],
        vat: true,
        optional: [
          'orders',
          'quotations',
          'invoices',
          'inventory',
          'usage_waste',
          'employees',
          'attendance',
          'payroll',
          'equipment',
          'vehicles',
          'vat_center',
        ],
        coreOff: [],
        reasons: {
          orders: 'invoice_later',
          quotations: 'quotes',
          invoices: 'vat',
          usage_waste: 'make',
          materials: 'make',
          sales: 'with_orders',
          payments: 'orders',
        },
        jobsReason: null,
        location: ['workshop', 'Factory', 'المصنع'],
      },
    )
    const materials = terminologyKey('modules.materials.name', rec.terminologyProfile)
    expect(en.t(materials)).toBe('Raw materials')
    expect(ar.t(materials)).toBe('المواد الخام')
  })

  it('8. workshop with many jobs (carpentry)', () => {
    check(
      {
        what_you_do: ['make_products'],
        how_you_make: ['custom_jobs'],
        workplace: 'workshop',
        branches: false,
        team: 'team',
        team_tracking: ['hours', 'salaries', 'staff_cash'],
        work_setup: ['stock', 'machines', 'vehicles'],
        sales_channels: ['messages', 'quotes'],
        vat: 'yes',
      },
      {
        questions: 9,
        type: 'workshop',
        profile: 'workshop',
        capabilities: ['has_team', 'keeps_stock', 'uses_machines', 'jobs_and_tasks'],
        vat: true,
        optional: [
          'orders',
          'quotations',
          'invoices',
          'inventory',
          'usage_waste',
          'employees',
          'attendance',
          'payroll',
          'equipment',
          'vehicles',
          'petty_cash',
          'vat_center',
        ],
        coreOff: [],
        reasons: {
          orders: 'custom_jobs',
          quotations: 'quotes',
          invoices: 'vat',
          usage_waste: 'make',
          products: 'custom',
          materials: 'make',
          cost_engine: 'jobs',
          payments: 'deposits',
          sales: 'with_orders',
        },
        jobsReason: 'custom_jobs',
        location: ['workshop', 'Workshop', 'الورشة'],
      },
    )
  })
})

describe('recommend(): edge cases (PRODUCT.md §6.11)', () => {
  it('metal factory: custom jobs and batches, two sites', () => {
    const rec = recommend({
      what_you_do: ['make_products'],
      how_you_make: ['custom_jobs', 'batches'],
      workplace: 'factory',
      branches: true,
      team: 'team',
      team_tracking: ['hours', 'salaries', 'staff_cash'],
      work_setup: ['stock', 'machines', 'vehicles'],
      sales_channels: ['invoice_later', 'quotes'],
      vat: 'yes',
    })
    expect(rec.businessType).toBe('factory')
    expect(STORED_CAPABILITY_KEYS.filter((k) => rec.capabilities[k])).toEqual([
      'has_team',
      'multi_location',
      'keeps_stock',
      'uses_machines',
      'jobs_and_tasks',
    ])
    const reason = (id: ModuleId) => rec.modules.find((m) => m.id === id)?.reason
    expect(reason('orders')).toBe('setup.reason.orders.invoice_later')
    expect(reason('payments')).toBe('setup.reason.payments.deposits')
    expect(en.t(rec.defaultLocationNameKey)).toBe('Main factory')
    expect(ar.t(rec.defaultLocationNameKey)).toBe('المصنع الرئيسي')
  })

  it('project company that also designs: projects, no jobs, no Orders', () => {
    const answers: SetupAnswers = {
      what_you_do: ['services', 'projects'],
      workplace: 'office',
      branches: false,
      team: 'team',
      team_tracking: ['hours'],
      work_setup: ['materials', 'vehicles'],
      sales_channels: ['messages', 'quotes'],
      vat: 'yes',
    }
    expect(normalizeAnswers(answers).shown).toHaveLength(8)
    const rec = recommend(answers)
    expect(rec.businessType).toBe('projects')
    expect(rec.capabilities.jobs_and_tasks).toBe(false)
    expect(rec.modules.map((m) => m.id)).not.toContain('orders')
  })

  it('coffee shop that also takes DMs: Orders stays off, with a note', () => {
    const rec = recommend({
      what_you_do: ['food_drinks'],
      workplace: 'shop',
      branches: false,
      team: 'team',
      team_tracking: ['hours', 'salaries', 'staff_cash'],
      work_setup: ['stock'],
      sales_channels: ['walk_in', 'messages', 'online'],
      pos: true,
      vat: 'yes',
    })
    expect(rec.modules.map((m) => m.id)).not.toContain('orders')
    expect(rec.offNotes).toContainEqual({ id: 'orders', reason: 'setup.note.orders.outside_pos' })
  })

  it('garage (a services workshop): cost of each job', () => {
    const answers: SetupAnswers = {
      what_you_do: ['services'],
      workplace: 'workshop',
      branches: false,
      team: 'team',
      team_tracking: ['hours'],
      work_setup: ['materials', 'machines'],
      sales_channels: ['quotes'],
      vat: 'yes',
    }
    expect(normalizeAnswers(answers).shown).toHaveLength(8)
    const rec = recommend(answers)
    expect([rec.businessType, rec.terminologyProfile]).toEqual(['workshop', 'workshop'])
    expect(rec.capabilities.jobs_and_tasks).toBe(true)
    const ids = rec.modules.map((m) => m.id)
    expect(ids).not.toContain('orders')
    expect(ids).toEqual(expect.arrayContaining(['quotations', 'invoices', 'equipment']))
    expect(rec.modules.find((m) => m.id === 'invoices')?.reason).toBe('setup.reason.invoices.vat')
    expect(rec.jobsReason).toBe('setup.jobs.reason.services')
  })

  it('maximum questions: 10, and "Not sure" VAT', () => {
    const answers: SetupAnswers = {
      what_you_do: ['make_products'],
      how_you_make: ['catalog'],
      workplace: 'shop',
      branches: true,
      team: 'team',
      team_tracking: ['cost_only'],
      work_setup: ['stock'],
      sales_channels: ['walk_in', 'messages'],
      pos: false,
      vat: 'not_sure',
    }
    expect(normalizeAnswers(answers).shown).toHaveLength(10)
    const rec = recommend(answers)
    expect(rec.businessType).toBe('maker')
    expect(rec.capabilities.multi_location).toBe(true)
    expect(rec.vatRegistered).toBeNull()
    expect(rec.modules.map((m) => m.id)).not.toContain('vat_center')
    expect(rec.modules.find((m) => m.id === 'orders')?.reason).toBe('setup.reason.orders.messages')
    expect(en.t(rec.defaultLocationNameKey)).toBe('Main shop')
    expect(ar.t(rec.defaultLocationNameKey)).toBe('المحل الرئيسي')
  })

  it('minimum questions: 5 (projects only, at home, alone)', () => {
    const answers: SetupAnswers = {
      what_you_do: ['projects'],
      workplace: 'home',
      team: 'alone',
      work_setup: ['none'],
      vat: 'no',
    }
    expect(normalizeAnswers(answers).shown).toHaveLength(5)
    const rec = recommend(answers)
    const ids = rec.modules.map((m) => m.id)
    expect(rec.businessType).toBe('projects')
    expect(ids).not.toContain('materials')
    expect(ids).not.toContain('purchases')
    expect(ids).toEqual(expect.arrayContaining(['quotations', 'invoices', 'projects']))
    expect(rec.modules.find((m) => m.id === 'suppliers')?.reason).toBe(
      'setup.reason.suppliers.no_purchases',
    )
  })
})

describe('recommend(): rules', () => {
  const base: SetupAnswers = {
    what_you_do: ['sell_products'],
    workplace: 'shop',
    branches: false,
    team: 'alone',
    work_setup: ['none'],
    sales_channels: ['walk_in'],
    pos: false,
    vat: 'no',
  }

  it('gives a shop without a POS Orders, with a way out to daily totals', () => {
    const rec = recommend(base)
    expect(rec.modules.find((m) => m.id === 'orders')?.reason).toBe(
      'setup.reason.orders.shop_no_pos',
    )
  })

  it('never turns Orders on for online sales alone', () => {
    const rec = recommend({
      ...base,
      workplace: 'office',
      sales_channels: ['online'],
      pos: undefined,
    })
    expect(rec.modules.map((m) => m.id)).not.toContain('orders')
  })

  it('turns Invoices on for a VAT-registered business with Orders, and never needs VAT for it', () => {
    const rec = recommend({ ...base, vat: 'yes' })
    expect(rec.modules.find((m) => m.id === 'invoices')?.reason).toBe('setup.reason.invoices.vat')
    const plain = recommend({ ...base, sales_channels: ['invoice_later'] })
    expect(plain.modules.find((m) => m.id === 'invoices')?.reason).toBe(
      'setup.reason.invoices.default',
    )
    expect(plain.vatRegistered).toBe(false)
  })

  it('ignores answers to hidden questions', () => {
    expect(recommend({ ...base, workplace: 'home', pos: true })).toEqual(
      recommend({ ...base, workplace: 'home', branches: undefined, pos: undefined }),
    )
  })

  it('is total: missing answers still give a recommendation (a missing workplace counts as home)', () => {
    const rec = recommend({})
    expect(rec.businessType).toBe('other')
    expect(rec.defaultLocationKind).toBe('home')
    expect(rec.modules.map((m) => m.id)).toContain('dashboard')
  })

  it('lists a reason variant for every module but Dashboard and Settings', () => {
    for (const m of MODULES) {
      const variants = REASON_VARIANTS[m.id]
      if (m.id === 'dashboard' || m.id === 'settings') expect(variants).toEqual([])
      else expect(variants.length, m.id).toBeGreaterThan(0)
    }
  })
})

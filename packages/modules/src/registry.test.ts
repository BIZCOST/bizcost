// Integrity of the code registries: manifests, permission catalog, role templates, capabilities.
import {
  isPermissionKey,
  OWNER_TEMPLATE_KEY,
  SENSITIVITY_PERMISSION_KEYS,
  SENSITIVITY_REQUIRES,
  sensitivityPermissionKey,
  type SensitivityCategory,
} from '@bizcost/domain'
import { hasMessage, LOCALES } from '@bizcost/i18n'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { CAPABILITIES, CAPABILITY_KEYS, isCapabilityKey } from './capabilities'
import {
  ALWAYS_ENABLED_MODULE_IDS,
  MODULE_IDS,
  MODULES,
  type ModuleId,
  type ModuleManifest,
} from './manifests'
import { keysMissingNeeds, PERMISSION_CATALOG, type PermissionKey } from './permissions'
import { ROLE_TEMPLATE_KEYS, ROLE_TEMPLATES } from './role-templates'

const byId = new Map(MODULES.map((m) => [m.id, m]))
const catalog = new Set<string>(PERMISSION_CATALOG)

describe('module manifests', () => {
  it('cover every module of PRODUCT.md §7, once, in MODULE_IDS order', () => {
    expect(MODULES.map((m) => m.id)).toEqual(MODULE_IDS)
    expect(new Set(MODULE_IDS).size).toBe(MODULE_IDS.length)
    expect(MODULE_IDS).toHaveLength(27)
  })

  it('use snake_case ids and never the reserved "data" prefix of visibility keys', () => {
    for (const id of MODULE_IDS) {
      expect(id).toMatch(/^[a-z][a-z0-9_]*$/)
      expect(id).not.toBe('data')
    }
  })

  it('release Dashboard and Settings (M1) and the Costing Core together (M2 Step 7)', () => {
    const released = MODULES.filter((m) => m.availability === 'released').map((m) => m.id)
    expect(released).toEqual([
      'dashboard',
      'settings',
      'products',
      'materials',
      'suppliers',
      'purchases',
      'expenses',
      'running_costs',
      'files',
      'cost_engine',
    ])
  })

  it('give planned modules no permission keys, nav or quick actions until their build starts (no stubs)', () => {
    // A module gets its keys and nav when its build starts and stays planned (hidden) until it is
    // released (D-124, D-125). M3 Step 2 builds Sales and Step 3 Reports (released with Release A,
    // Step 6).
    const started = MODULES.filter(
      (m) => m.availability === 'planned' && (m.permissionKeys.length > 0 || m.nav.length > 0),
    )
    expect(started.map((m) => m.id)).toEqual(['sales', 'reports'])
    for (const m of started) {
      expect(m.permissionKeys.length, m.id).toBeGreaterThan(0)
      expect(m.nav.length, m.id).toBeGreaterThan(0)
    }
    for (const m of MODULES.filter((x) => x.availability === 'planned' && !started.includes(x))) {
      expect(m.permissionKeys, m.id).toEqual([])
      expect(m.nav, m.id).toEqual([])
      expect(m.quickActions, m.id).toEqual([])
      expect(m.sensitiveFields, m.id).toEqual([])
    }
  })

  it('give every released module at least one nav entry, but Files (its receipts show in the records they belong to)', () => {
    for (const m of MODULES.filter((x) => x.availability === 'released' && x.id !== 'files')) {
      expect(m.nav.length, m.id).toBeGreaterThan(0)
    }
    expect(byId.get('files')).toMatchObject({ nav: [], quickActions: [], permissionKeys: [] })
  })

  it('have a positive phase, and released modules belong to phases 1 and 2', () => {
    for (const m of MODULES) {
      expect(Number.isInteger(m.phase) && m.phase >= 1, m.id).toBe(true)
      if (m.availability === 'released') expect(m.phase, m.id).toBeLessThanOrEqual(2)
    }
  })

  it('give each main nav entry at most one claim to the phone tab bar, 1 first, never Settings', () => {
    // A page reached by two keys (Sales: see every sale, or enter sales) has one entry per key, each
    // with the same claim: it is one place in the tab bar.
    const claims = [
      ...new Map(
        MODULES.flatMap((m) =>
          m.nav.flatMap((entry) =>
            'tab' in entry && entry.tab !== undefined
              ? [[`${entry.id} ${entry.tab}`, [entry.id, entry.tab] as const] as const]
              : [],
          ),
        ),
      ).values(),
    ]
    // M2 Step 7: Home, then Product costs, Products, Expenses, Purchases, Materials; an owner's phone
    // gets Home, Products, +, Product costs and More, and an employee's Home, Products, +,
    // Expenses and More (the tabs keep the nav's order). M3 Step 2 (D-233): Sales claims the place
    // after Home (Q14: Home | Sales | + | Costs | More), the others keep their order, so a business
    // without Sales keeps its tabs.
    expect(claims).toEqual([
      ['dashboard', 1],
      ['products', 4],
      ['materials', 7],
      ['purchases', 6],
      ['expenses', 5],
      ['product_costs', 3],
      ['sales', 2],
    ])
    for (const m of MODULES) {
      const ranks = new Set(m.nav.flatMap((entry) => ('tab' in entry ? [entry.tab] : [])))
      expect(ranks.size, m.id).toBeLessThanOrEqual(1)
    }
    const ranks = claims.map(([, rank]) => rank)
    expect(new Set(ranks).size).toBe(ranks.length)
    for (const m of MODULES) {
      for (const entry of m.nav) {
        if ('tab' in entry && entry.tab !== undefined) {
          expect(entry.group, entry.id).toBe('main')
          expect(Number.isInteger(entry.tab) && entry.tab >= 1, entry.id).toBe(true)
        }
      }
    }
  })

  it('offer "+" for a new product or service, purchase, expense and sale, and Today\'s sales, each with the key to enter it', () => {
    const actions = MODULES.flatMap((m) =>
      m.quickActions.map((a) => [m.id, a.id, a.path, a.permission ?? null]),
    )
    expect(actions).toEqual([
      ['products', 'new_product', 'products/new', 'products.items.manage'],
      ['purchases', 'new_purchase', 'purchases/new', 'purchases.documents.manage'],
      ['expenses', 'new_expense', 'expenses/new', 'expenses.documents.manage'],
      // M3 Step 2 (planned: shown only under the dev-only preview until Release A).
      ['sales', 'today_sales', 'sales/today', 'sales.documents.manage'],
      ['sales', 'new_sale', 'sales/new', 'sales.documents.manage'],
    ])
  })

  it('reference existing modules as deps, without self-deps or cycles', () => {
    const state = new Map<ModuleId, 'visiting' | 'done'>()
    const visit = (id: ModuleId, path: ModuleId[]) => {
      if (state.get(id) === 'done') return
      expect(state.get(id), `cycle: ${[...path, id].join(' → ')}`).not.toBe('visiting')
      state.set(id, 'visiting')
      for (const dep of byId.get(id)?.deps ?? []) {
        expect(byId.has(dep), `${id} → ${dep}`).toBe(true)
        expect(dep, `${id} depends on itself`).not.toBe(id)
        visit(dep, [...path, id])
      }
      state.set(id, 'done')
    }
    for (const id of MODULE_IDS) visit(id, [])
    for (const m of MODULES) expect(new Set(m.deps).size, m.id).toBe(m.deps.length)
  })

  it('never depend on a module that ships later or is not released yet', () => {
    for (const m of MODULES) {
      for (const dep of m.deps) {
        const d = byId.get(dep)
        expect(d && d.phase <= m.phase, `${m.id} (phase ${m.phase}) → ${dep}`).toBe(true)
        if (m.availability === 'released')
          expect(d?.availability, `${m.id} → ${dep}`).toBe('released')
      }
    }
  })

  it('require only registered capabilities, including those of their deps', () => {
    for (const m of MODULES) {
      for (const key of m.requiresCapabilities)
        expect(isCapabilityKey(key), `${m.id}: ${key}`).toBe(true)
      for (const dep of m.deps) {
        for (const key of byId.get(dep)?.requiresCapabilities ?? []) {
          expect(m.requiresCapabilities, `${m.id} needs ${key} like its dep ${dep}`).toContain(key)
        }
      }
    }
  })

  it('declare module permission keys that are well-formed and start with the module id', () => {
    for (const m of MODULES) {
      for (const key of m.permissionKeys) {
        expect(isPermissionKey(key), key).toBe(true)
        expect(key.startsWith(`${m.id}.`), `${m.id}: ${key}`).toBe(true)
      }
    }
  })

  it('use nav/quick-action permissions from the module itself, and unique ids', () => {
    const ids = new Map<string, string>()
    const manifests: readonly ModuleManifest[] = MODULES
    for (const m of manifests) {
      for (const entry of [...m.nav, ...m.quickActions]) {
        // One page shared by modules (Amounts owed, D-166) repeats its entry exactly, but for the
        // permission; buildModuleNav lists it once.
        const shape = JSON.stringify([
          entry.labelKey,
          entry.path,
          entry.icon,
          'group' in entry ? entry.group : null,
        ])
        const seen = ids.get(entry.id)
        expect(seen === undefined || seen === shape, `duplicate nav id ${entry.id}`).toBe(true)
        ids.set(entry.id, shape)
        expect(entry.labelKey).toMatch(/^nav\.[a-z][a-z0-9_.]*$/)
        // Shipped with the module's build: the label in both languages (a common `nav.*` key).
        for (const locale of LOCALES) {
          expect(hasMessage(locale, `common.${entry.labelKey}`), entry.labelKey).toBe(true)
        }
        expect(entry.icon).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
        expect(entry.path).toMatch(/^(?:[a-z0-9-]+(?:\/[a-z0-9-]+)*)?$/)
        if (entry.permission !== undefined) {
          expect(m.permissionKeys, entry.id).toContain(entry.permission)
        }
      }
    }
  })

  it('list only sensitivity categories that exist', () => {
    for (const m of MODULES) {
      for (const c of m.sensitiveFields)
        expect(c in SENSITIVITY_REQUIRES, `${m.id}: ${c}`).toBe(true)
    }
  })

  it('put Settings after the sections (group system), and every other entry in main', () => {
    const groups = MODULES.flatMap((m) => m.nav.map((entry) => [entry.id, entry.group]))
    expect(groups).toEqual([
      ['dashboard', 'main'],
      ['settings', 'system'],
      ['products', 'main'],
      ['materials', 'main'],
      ['suppliers', 'main'],
      ['purchases', 'main'],
      ['payables', 'main'],
      ['expenses', 'main'],
      ['payables', 'main'],
      ['running_costs', 'main'],
      ['product_costs', 'main'],
      // Sales (M3 Step 2): one page, reached with "see every sale" or with "enter sales".
      ['sales', 'main'],
      ['sales', 'main'],
      // Reports (M3 Step 3): Real profit.
      ['real_profit', 'main'],
    ])
  })

  it('keep the always-enabled modules released and core', () => {
    expect(ALWAYS_ENABLED_MODULE_IDS).toEqual(['dashboard', 'settings'])
    for (const id of ALWAYS_ENABLED_MODULE_IDS) {
      expect(byId.get(id)?.availability, id).toBe('released')
      expect(byId.get(id)?.kind, id).toBe('core')
    }
  })
})

describe('permission catalog', () => {
  it('holds the keys of dashboard, settings, products, materials, suppliers, purchases, expenses, running costs, the cost engine, sales and reports, and one data key per sensitivity category', () => {
    expect([...PERMISSION_CATALOG].sort()).toEqual(
      [
        'dashboard.home.view',
        'settings.business.view',
        'settings.business.edit',
        'settings.locations.manage',
        'settings.members.view',
        'settings.members.manage',
        'settings.roles.manage',
        'settings.modules.manage',
        'products.items.view',
        'products.items.manage',
        'products.recipes.view',
        'products.recipes.manage',
        'materials.items.view',
        'materials.items.manage',
        'suppliers.items.view',
        'suppliers.items.manage',
        'purchases.documents.view',
        'purchases.documents.manage',
        'purchases.documents.post',
        'purchases.documents.reverse',
        'settings.books.close',
        'purchases.payments.view',
        'purchases.payments.record',
        'expenses.documents.view',
        'expenses.documents.manage',
        'expenses.documents.approve',
        'expenses.documents.post',
        'expenses.documents.reverse',
        'expenses.payments.view',
        'expenses.payments.record',
        'expenses.approval.manage',
        'running_costs.items.view',
        'running_costs.items.manage',
        'cost_engine.product_costs.view',
        'cost_engine.settings.manage',
        'sales.documents.view',
        'sales.documents.manage',
        'sales.documents.post',
        'sales.documents.reverse',
        'sales.channels.manage',
        'reports.sales.view',
        'reports.profit.view',
        'data.cost.view',
        'data.profit_margin.view',
        'data.supplier_price.view',
        'data.payroll.view',
        'data.employee_pii.view',
      ].sort(),
    )
  })

  it('has unique, well-formed keys', () => {
    expect(catalog.size).toBe(PERMISSION_CATALOG.length)
    for (const key of PERMISSION_CATALOG) expect(isPermissionKey(key), key).toBe(true)
  })

  it('contains every module key and every data-visibility key from domain', () => {
    for (const m of MODULES) for (const key of m.permissionKeys) expect(catalog.has(key)).toBe(true)
    for (const key of SENSITIVITY_PERMISSION_KEYS) expect(catalog.has(key)).toBe(true)
  })

  it('types keys as a literal union (typos fail typecheck)', () => {
    expectTypeOf<'dashboard.home.view'>().toExtend<PermissionKey>()
    expectTypeOf<'data.payroll.view'>().toExtend<PermissionKey>()
    expectTypeOf<'dashboard.home.edit'>().not.toExtend<PermissionKey>()
    expectTypeOf<string>().not.toExtend<PermissionKey>()
  })
})

describe('role templates', () => {
  const template = (key: string) => ROLE_TEMPLATES.find((t) => t.key === key)
  const keysOf = (key: string) => [...(template(key)?.permissionKeys ?? [])].sort()

  it("are the owner's list, once each", () => {
    expect(ROLE_TEMPLATES.map((t) => t.key)).toEqual(ROLE_TEMPLATE_KEYS)
    expect(ROLE_TEMPLATE_KEYS).toEqual([
      'owner',
      'admin',
      'manager',
      'accountant',
      'sales',
      'supervisor',
      'employee',
    ])
    expect(ROLE_TEMPLATE_KEYS[0]).toBe(OWNER_TEMPLATE_KEY)
  })

  it('give only the owner implicit ALL, with no rows', () => {
    for (const t of ROLE_TEMPLATES) {
      expect(t.allPermissions, t.key).toBe(t.key === OWNER_TEMPLATE_KEY)
    }
    expect(template(OWNER_TEMPLATE_KEY)?.permissionKeys).toEqual([])
  })

  it('reference only catalog keys, without duplicates', () => {
    for (const t of ROLE_TEMPLATES) {
      for (const key of t.permissionKeys) expect(catalog.has(key), `${t.key}: ${key}`).toBe(true)
      expect(new Set(t.permissionKeys).size, t.key).toBe(t.permissionKeys.length)
    }
  })

  it('let every template open the dashboard', () => {
    for (const t of ROLE_TEMPLATES.filter((x) => !x.allPermissions)) {
      expect(t.permissionKeys, t.key).toContain('dashboard.home.view')
    }
  })

  it('never grant a data key without the data keys it depends on (grouping rule)', () => {
    for (const t of ROLE_TEMPLATES) {
      const granted = new Set<string>(t.permissionKeys)
      for (const [category, requires] of Object.entries(SENSITIVITY_REQUIRES)) {
        if (!granted.has(sensitivityPermissionKey(category as SensitivityCategory))) continue
        for (const r of requires) {
          expect(granted.has(sensitivityPermissionKey(r)), `${t.key}: ${category} needs ${r}`).toBe(
            true,
          )
        }
      }
    }
  })

  it('match the documented sets', () => {
    expect(keysOf('admin')).toEqual([...PERMISSION_CATALOG].sort())
    expect(keysOf('manager')).toEqual(
      [
        'dashboard.home.view',
        'settings.business.view',
        'settings.members.view',
        'settings.locations.manage',
        'products.items.view',
        'products.items.manage',
        'products.recipes.view',
        'products.recipes.manage',
        'materials.items.view',
        'materials.items.manage',
        'suppliers.items.view',
        'suppliers.items.manage',
        'purchases.documents.view',
        'purchases.documents.manage',
        'purchases.documents.post',
        'purchases.documents.reverse',
        'purchases.payments.view',
        'purchases.payments.record',
        'expenses.documents.view',
        'expenses.documents.manage',
        'expenses.documents.approve',
        'expenses.documents.post',
        'expenses.documents.reverse',
        'expenses.payments.view',
        'expenses.payments.record',
        'running_costs.items.view',
        'running_costs.items.manage',
        'cost_engine.product_costs.view',
        'cost_engine.settings.manage',
        'sales.documents.view',
        'sales.documents.manage',
        'sales.documents.post',
        'sales.documents.reverse',
        'sales.channels.manage',
        'reports.sales.view',
        'reports.profit.view',
        'data.cost.view',
        'data.profit_margin.view',
        'data.supplier_price.view',
      ].sort(),
    )
    expect(keysOf('accountant')).toEqual(
      [
        'dashboard.home.view',
        'settings.business.view',
        'products.items.view',
        'products.recipes.view',
        'materials.items.view',
        'suppliers.items.view',
        'purchases.documents.view',
        'expenses.documents.view',
        'running_costs.items.view',
        'cost_engine.product_costs.view',
        'sales.documents.view',
        'reports.sales.view',
        'reports.profit.view',
        'data.cost.view',
        'data.profit_margin.view',
        'data.supplier_price.view',
        'data.payroll.view',
      ].sort(),
    )
    // M3 Step 2, the plan's Q10 table: Sales and Supervisor see every sale, enter and finalize; Step 3:
    // they see Real profit's sales figures, never its profit.
    expect(keysOf('sales')).toEqual(
      [
        'dashboard.home.view',
        'products.items.view',
        'sales.documents.view',
        'sales.documents.manage',
        'sales.documents.post',
        'reports.sales.view',
      ].sort(),
    )
    expect(keysOf('supervisor')).toEqual(
      [
        'dashboard.home.view',
        'settings.members.view',
        'products.items.view',
        'products.recipes.view',
        'materials.items.view',
        'sales.documents.view',
        'sales.documents.manage',
        'sales.documents.post',
        'reports.sales.view',
      ].sort(),
    )
    // The owner's answers of 2026-09-29 (D-179, D-180): what goes into each product (quantities) and
    // the materials it names, and entering expenses to send them for approval; nothing sensitive.
    // M3 Step 2 (Q10): entering and finalizing sales, their own only (no "see every sale").
    expect(keysOf('employee')).toEqual(
      [
        'dashboard.home.view',
        'products.items.view',
        'products.recipes.view',
        'materials.items.view',
        'expenses.documents.view',
        'expenses.documents.manage',
        'sales.documents.manage',
        'sales.documents.post',
      ].sort(),
    )
    expect(keysMissingNeeds(keysOf('employee'))).toEqual([])
    for (const key of ['admin', 'manager', 'accountant', 'supervisor', 'sales']) {
      expect(keysMissingNeeds(keysOf(key)), key).toEqual([])
    }
  })
})

describe('capability registry', () => {
  it('lists the stored capabilities and the derived vat_registered', () => {
    expect(CAPABILITIES).toEqual([
      { key: 'has_team', source: 'stored', default: false },
      { key: 'multi_location', source: 'stored', default: false },
      { key: 'keeps_stock', source: 'stored', default: false },
      { key: 'uses_machines', source: 'stored', default: false },
      { key: 'sells_via_pos', source: 'stored', default: false },
      { key: 'jobs_and_tasks', source: 'stored', default: false },
      { key: 'vat_registered', source: 'derived', default: false },
    ])
  })

  it('has unique snake_case keys', () => {
    expect(new Set(CAPABILITY_KEYS).size).toBe(CAPABILITY_KEYS.length)
    for (const key of CAPABILITY_KEYS) expect(key).toMatch(/^[a-z][a-z0-9_]*$/)
  })
})

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

  it('release Dashboard and Settings (M1), the Costing Core (M2 Step 7) and Release A (M3 Step 6)', () => {
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
      // Release A: Sales & Profit, half-way through M3 (Q1); Quotations and Invoices wait for Release B.
      'sales',
      'orders',
      'customers',
      'payments',
      'reports',
    ])
  })

  it('give planned modules no permission keys, nav or quick actions until their build starts (no stubs)', () => {
    // A module gets its keys and nav when its build starts and stays planned (hidden) until it is
    // released (D-124, D-125). Quotations' build started in M3 Step 7 (released with Release B).
    expect(byId.get('quotations')).toMatchObject({
      availability: 'planned',
      permissionKeys: [
        'quotations.documents.view',
        'quotations.documents.manage',
        'quotations.documents.decide',
      ],
      quickActions: [],
      sensitiveFields: [],
    })
    for (const m of MODULES.filter((x) => x.availability === 'planned' && x.id !== 'quotations')) {
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

  it('have a positive phase, and released modules belong to phases 1 to 3', () => {
    for (const m of MODULES) {
      expect(Number.isInteger(m.phase) && m.phase >= 1, m.id).toBe(true)
      if (m.availability === 'released') expect(m.phase, m.id).toBeLessThanOrEqual(3)
    }
  })

  it('give each section at most one claim to the phone tab bar, 1 first, never Settings', () => {
    // A page reached by two keys (Sales: see every sale, or enter sales) has one entry per key, each
    // with the same claim and rank: it is one place in the tab bar.
    const claims = [
      ...new Map(
        MODULES.flatMap((m) =>
          m.nav.flatMap((entry) =>
            'tab' in entry && entry.tab !== undefined
              ? [
                  [
                    `${entry.id} ${entry.tab}`,
                    [entry.id, entry.tab, 'tabRank' in entry ? entry.tabRank : 0] as const,
                  ] as const,
                ]
              : [],
          ),
        ),
      ).values(),
    ]
    // Release A (M3 Step 6, Q14): Home, then the Sales place (Orders for a business with Orders on,
    // else Sales), Product costs ("Costs"), Expenses, Products, Purchases, Materials: an owner's phone
    // gets Home | Sales | + | Costs | More (Products under "More"), an employee's Home | Sales | + |
    // Expenses | More (D-184 kept).
    expect(claims).toEqual([
      ['dashboard', 1, 0],
      ['products', 5, 0],
      ['materials', 7, 0],
      ['purchases', 6, 0],
      ['expenses', 4, 0],
      ['product_costs', 3, 0],
      ['sales', 2, 1],
      ['orders', 2, 0],
    ])
    for (const m of MODULES) {
      const claimed = new Set(
        m.nav.flatMap((entry) =>
          'tab' in entry ? [`${entry.tab} ${'tabRank' in entry ? entry.tabRank : 0}`] : [],
        ),
      )
      expect(claimed.size, m.id).toBeLessThanOrEqual(1)
    }
    // Places are shared only by entries of different ranks, so a place always has one holder.
    const places = claims.map(([, place, rank]) => `${place} ${rank}`)
    expect(new Set(places).size).toBe(places.length)
    for (const m of MODULES) {
      for (const entry of m.nav) {
        if ('tab' in entry && entry.tab !== undefined) {
          expect(entry.group, entry.id).not.toBe('system')
          expect(Number.isInteger(entry.tab) && entry.tab >= 1, entry.id).toBe(true)
        }
      }
    }
  })

  it('offer "+" for a new product or service, purchase, expense, sale, order and customer, and Today\'s sales, each with the keys to enter it', () => {
    const actions = MODULES.flatMap((m) =>
      m.quickActions.map((a) => [
        m.id,
        a.id,
        a.path,
        a.permission ?? null,
        ...('alsoNeeds' in a ? a.alsoNeeds : []),
      ]),
    )
    expect(actions).toEqual([
      ['products', 'new_product', 'products/new', 'products.items.manage'],
      ['purchases', 'new_purchase', 'purchases/new', 'purchases.documents.manage'],
      ['expenses', 'new_expense', 'expenses/new', 'expenses.documents.manage'],
      // Release A (M3 Step 6).
      ['sales', 'today_sales', 'sales/today', 'sales.documents.manage'],
      ['sales', 'new_sale', 'sales/new', 'sales.documents.manage'],
      ['orders', 'new_order', 'orders/new', 'orders.documents.manage'],
      // It opens Customers, so it is for those who see customers as well as add them.
      [
        'customers',
        'new_customer',
        'customers/new',
        'customers.items.manage',
        'customers.items.view',
      ],
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
        const also: readonly string[] = ('alsoNeeds' in entry && entry.alsoNeeds) || []
        for (const key of also) expect(m.permissionKeys, entry.id).toContain(key)
      }
    }
  })

  it('list only sensitivity categories that exist', () => {
    for (const m of MODULES) {
      for (const c of m.sensitiveFields)
        expect(c in SENSITIVITY_REQUIRES, `${m.id}: ${c}`).toBe(true)
    }
  })

  it('put Settings after the sections (group system), Sales & Profit in its groups, and every other entry in main', () => {
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
      // Release A (M3 Step 6): the "Sales" group holds Sales (one page, reached with "see every sale"
      // or with "enter sales"), Orders (likewise), Customers and What customers owe; "Reports" holds
      // Real profit.
      ['sales', 'sales'],
      ['sales', 'sales'],
      ['orders', 'sales'],
      ['orders', 'sales'],
      ['customers', 'sales'],
      ['receivables', 'sales'],
      ['real_profit', 'reports'],
      // M3 Step 7: Quotations joins the "Sales" group (shown once released, Release B).
      ['quotations', 'sales'],
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
        'sales.imports.manage',
        'reports.sales.view',
        'reports.profit.view',
        'customers.items.view',
        'customers.items.manage',
        'payments.customers.view',
        'payments.customers.record',
        'orders.documents.view',
        'orders.documents.manage',
        'orders.documents.deliver',
        'orders.documents.reverse',
        // M3 Step 7: Quotations, and Settings → Documents.
        'quotations.documents.view',
        'quotations.documents.manage',
        'quotations.documents.decide',
        'settings.documents.manage',
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
        'sales.imports.manage',
        'reports.sales.view',
        'reports.profit.view',
        // M3 Step 5 (Q10): customers, every order (enter, deliver, undo), customer payments.
        'customers.items.view',
        'customers.items.manage',
        'orders.documents.view',
        'orders.documents.manage',
        'orders.documents.deliver',
        'orders.documents.reverse',
        'payments.customers.view',
        'payments.customers.record',
        // M3 Step 7 (Q10): see, prepare and record the answer of quotations.
        'quotations.documents.view',
        'quotations.documents.manage',
        'quotations.documents.decide',
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
        // M3 Step 5 (Q10): sees customers and every order, sees and records customer payments.
        'customers.items.view',
        'orders.documents.view',
        'payments.customers.view',
        'payments.customers.record',
        // M3 Step 7 (Q10): sees quotations.
        'quotations.documents.view',
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
        // M3 Step 5 (Q10): see and add customers, every order (enter, deliver), customer payments.
        'customers.items.view',
        'customers.items.manage',
        'orders.documents.view',
        'orders.documents.manage',
        'orders.documents.deliver',
        'payments.customers.view',
        'payments.customers.record',
        // M3 Step 7 (Q10): see, prepare and record the answer of quotations.
        'quotations.documents.view',
        'quotations.documents.manage',
        'quotations.documents.decide',
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
        // M3 Step 5 (Q10): see and add customers, every order (enter, deliver); no payments.
        'customers.items.view',
        'customers.items.manage',
        'orders.documents.view',
        'orders.documents.manage',
        'orders.documents.deliver',
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
        // M3 Step 5 (Q10): add customers (picked by name and the phone's last 4 digits), enter and
        // deliver their own orders.
        'customers.items.manage',
        'orders.documents.manage',
        'orders.documents.deliver',
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

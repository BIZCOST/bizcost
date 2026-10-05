import type {
  BooksDto,
  BusinessContextDto,
  CostCategoryDto,
  CustomizationDto,
  CustomizeDto,
  ExpenseDto,
  LocationDto,
  MaterialDto,
  ProductDto,
  PurchaseDto,
} from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import {
  ALWAYS_ENABLED_MODULE_IDS,
  MODULES as MANIFESTS,
  roleTemplateByKey,
  withPreviewModules,
  type CapabilityKey,
  type ModuleId,
  type ModuleManifest,
  type RoleTemplateKey,
} from '@bizcost/modules'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { appRouter } from '../../src'
import type { CallResult } from '../helpers'
import { BAKER, join, setupBusiness, WORKSHOP } from '../settings'
import {
  callProcedure,
  createTenant,
  openApi,
  PREVIEW_MODULES,
  proceduresOf,
  tenantDigest,
  type Api,
  type Person,
  type ProcedureInfo,
  type Tenant,
} from './fixture'
import { updateFieldsOf } from '../sales'
import { inputLeaves, inputSchemaOf } from './schema'

// What a business has switched off is refused by the API, not only hidden by the screens (ROADMAP.md
// M2 Step 8 and definition of done: "Only the released M2 modules appear; capabilities hide VAT
// fields, location pickers, approvals and stock quantities where they don't apply").
//
//   - Modules: MODULE_GATES says, for EVERY business procedure of appRouter, which modules it needs
//     (any of the groups, each with all its modules on). Each released module that can be switched
//     off is switched off through business.customize (with what it takes along), then every business
//     procedure is called: MODULE_DISABLED exactly when its gate is closed. The gates run before the
//     input is read, so the calls send an input no schema accepts (VALIDATION when the gate is open,
//     nothing is written); the gates inside handlers (a receipt's record, an item bought ready to
//     sell) are called with real inputs. business.context lists exactly the released modules that
//     are on, with the entries each member's keys reach; a planned module never shows.
//   - Capabilities: CAPABILITY_GATES says which business procedures need a capability; in a business
//     run alone, with one location and no VAT, exactly those are CAPABILITY_DISABLED. Every input
//     field about VAT, locations, who paid, approval or the owner's time is found by walking the
//     input schemas and must be in HIDDEN_FIELDS: refused where its capability says it does not apply
//     (nothing written), accepted where it does.

/**
 * The registry the suites' API serves: the manifests with the modules being built previewed (D-125;
 * Sales since M3 Step 2), as a local server has them.
 */
const MODULES = withPreviewModules(PREVIEW_MODULES, MANIFESTS)

/** Any of the groups, each with every module on; [] = no module gate. */
type Gate = readonly (readonly ModuleId[])[]

const NONE: Gate = []
const PRODUCTS: Gate = [['products']]
const MATERIALS: Gate = [['materials']]
const SUPPLIERS: Gate = [['suppliers']]
const PURCHASES: Gate = [['purchases']]
const EXPENSES: Gate = [['expenses']]
const RUNNING_COSTS: Gate = [['running_costs']]
const PURCHASES_OR_EXPENSES: Gate = [['purchases'], ['expenses']]
const EXPENSES_OR_RUNNING_COSTS: Gate = [['expenses'], ['running_costs']]
const EXPENSES_AND_RUNNING_COSTS: Gate = [['expenses', 'running_costs']]
const RECIPES: Gate = [['products', 'materials']]
const RECEIPTS: Gate = [
  ['files', 'purchases'],
  ['files', 'expenses'],
]
const SALES: Gate = [['sales']]
/** The books-closed date: purchases, expenses and sales obey it (D-227, D-236). */
const BOOKS: Gate = [['purchases'], ['expenses'], ['sales']]

const MODULE_GATES: Record<string, Gate> = {
  'attachment.add': RECEIPTS,
  'attachment.list': RECEIPTS,
  'attachment.remove': RECEIPTS,
  'attachment.uploadUrl': RECEIPTS,
  'books.close': BOOKS,
  'books.get': BOOKS,
  'business.context': NONE,
  'business.customization': NONE,
  'business.customize': NONE,
  'business.logoUploadUrl': NONE,
  'business.profile': NONE,
  'business.removeLogo': NONE,
  'business.setDefaultLocale': NONE,
  'business.setLogo': NONE,
  'business.updateProfile': NONE,
  'channel.archive': SALES,
  'channel.create': SALES,
  'channel.list': SALES,
  'channel.unarchive': SALES,
  'channel.update': SALES,
  'costCategory.archive': EXPENSES_OR_RUNNING_COSTS,
  'costCategory.create': EXPENSES_OR_RUNNING_COSTS,
  'costCategory.list': EXPENSES_OR_RUNNING_COSTS,
  'costCategory.unarchive': EXPENSES_OR_RUNNING_COSTS,
  'costCategory.update': EXPENSES_OR_RUNNING_COSTS,
  'dashboard.cards': NONE,
  'dashboard.checklist': NONE,
  'expense.approve': EXPENSES,
  'expense.correct': EXPENSES,
  'expense.create': EXPENSES,
  'expense.discard': EXPENSES,
  'expense.get': EXPENSES,
  'expense.getMine': EXPENSES,
  'expense.list': EXPENSES,
  'expense.mine': EXPENSES,
  'expense.payableChannels': [['expenses', 'sales']],
  'expense.payableRunningCosts': EXPENSES_AND_RUNNING_COSTS,
  'expense.payers': EXPENSES,
  'expense.post': EXPENSES,
  'expense.reject': EXPENSES,
  'expense.reverse': EXPENSES,
  'expense.settings': EXPENSES,
  'expense.submit': EXPENSES,
  'expense.update': EXPENSES,
  'expense.updateSettings': EXPENSES,
  'expensePayment.list': EXPENSES,
  'expensePayment.record': EXPENSES,
  'expensePayment.reverse': EXPENSES,
  'invitation.create': NONE,
  'invitation.list': NONE,
  'invitation.resend': NONE,
  'invitation.revoke': NONE,
  'location.create': NONE,
  'location.list': NONE,
  'location.remove': NONE,
  'location.rename': NONE,
  'location.setDefault': NONE,
  'material.archive': MATERIALS,
  'material.costs': MATERIALS,
  'material.create': MATERIALS,
  'material.get': MATERIALS,
  'material.list': MATERIALS,
  // Added from a purchase line: who enters purchases, with Materials on (the owner's request R2).
  'material.quickCreate': [['purchases', 'materials']],
  'material.unarchive': MATERIALS,
  'material.update': MATERIALS,
  'member.changeRole': NONE,
  'member.leave': NONE,
  'member.list': NONE,
  // "Branches they work in": only while Sales is served (the module used per branch, Q12).
  'member.locations': SALES,
  'member.permissions': NONE,
  'member.remove': NONE,
  'member.transferOwnership': NONE,
  'member.updateLocations': SALES,
  'member.updatePermissions': NONE,
  'payable.list': PURCHASES_OR_EXPENSES,
  'payable.mine': PURCHASES_OR_EXPENSES,
  'product.archive': PRODUCTS,
  'product.costs': RECIPES,
  'product.create': PRODUCTS,
  'product.get': PRODUCTS,
  'product.list': PRODUCTS,
  'product.unarchive': PRODUCTS,
  'product.update': PRODUCTS,
  'productCost.get': [['cost_engine', 'products']],
  'profit.summary': [['reports']],
  'productCost.list': [['cost_engine', 'products']],
  'productCost.settings': [['cost_engine']],
  'productCost.updateSettings': [['cost_engine']],
  'purchase.correct': PURCHASES,
  'purchase.create': PURCHASES,
  'purchase.discard': PURCHASES,
  'purchase.get': PURCHASES,
  'purchase.list': PURCHASES,
  'purchase.payers': PURCHASES,
  'purchase.post': PURCHASES,
  'purchase.reverse': PURCHASES,
  'purchase.update': PURCHASES,
  'purchasePayment.list': PURCHASES,
  'purchasePayment.record': PURCHASES,
  'purchasePayment.reverse': PURCHASES,
  'purchaseReturn.create': PURCHASES,
  'purchaseReturn.discard': PURCHASES,
  'purchaseReturn.get': PURCHASES,
  'purchaseReturn.list': PURCHASES,
  'purchaseReturn.post': PURCHASES,
  'purchaseReturn.reverse': PURCHASES,
  'purchaseReturn.update': PURCHASES,
  'recipe.get': RECIPES,
  'recipe.save': RECIPES,
  'role.list': NONE,
  'role.updatePermissions': NONE,
  'runningCost.create': RUNNING_COSTS,
  'runningCost.get': RUNNING_COSTS,
  'runningCost.list': RUNNING_COSTS,
  'runningCost.remove': RUNNING_COSTS,
  'runningCost.update': RUNNING_COSTS,
  // Sales depends on Products & Services: Customize turns it off with them (the handlers also check
  // Products & Services before they read an item line's product).
  'sale.correct': SALES,
  'sale.create': SALES,
  'sale.daySheet': [['sales', 'products']],
  'sale.discard': SALES,
  'sale.fillDeliveryCost': SALES,
  'sale.get': SALES,
  'sale.list': SALES,
  'sale.post': SALES,
  'sale.reverse': SALES,
  'sale.update': SALES,
  'supplier.archive': SUPPLIERS,
  'supplier.create': SUPPLIERS,
  'supplier.get': SUPPLIERS,
  'supplier.list': SUPPLIERS,
  'supplier.unarchive': SUPPLIERS,
  'supplier.update': SUPPLIERS,
}

/**
 * The capability a business procedure needs (requireCapability); absent: none. `member.leave` needs
 * none on purpose: everyone can leave a business (the owner is refused for another reason).
 */
const CAPABILITY_GATES: Record<string, CapabilityKey> = {
  'expense.updateSettings': 'has_team',
  'invitation.create': 'has_team',
  'invitation.list': 'has_team',
  'invitation.resend': 'has_team',
  'invitation.revoke': 'has_team',
  'location.create': 'multi_location',
  'location.list': 'multi_location',
  'location.remove': 'multi_location',
  'location.rename': 'multi_location',
  'location.setDefault': 'multi_location',
  'member.changeRole': 'has_team',
  'member.list': 'has_team',
  'member.locations': 'has_team',
  'member.permissions': 'has_team',
  'member.remove': 'has_team',
  'member.transferOwnership': 'has_team',
  'member.updateLocations': 'has_team',
  'member.updatePermissions': 'has_team',
  'role.list': 'has_team',
  'role.updatePermissions': 'has_team',
}

const PROCEDURES = proceduresOf(appRouter)
const BUSINESS = PROCEDURES.filter((p) => p.base === 'business')

/** Released modules a business can switch off (Dashboard and Settings are always on). */
const SWITCHABLE = MODULES.filter(
  (m) => m.availability === 'released' && !ALWAYS_ENABLED_MODULE_IDS.includes(m.id),
).map((m) => m.id)
const RELEASED = new Set<string>(
  MODULES.filter((m) => m.availability === 'released').map((m) => m.id),
)

function gateOpen(gate: Gate, enabled: ReadonlySet<string>): boolean {
  return gate.length === 0 || gate.some((group) => group.every((id) => enabled.has(id)))
}

/** An input no schema of the router accepts (VALIDATION once the gates let it through). */
const NO_INPUT_ACCEPTS = 'not an input'

let api: Api
let tenant: Tenant

function as<T>(person: Person, businessId: string, path: string, input?: unknown) {
  const procedure = PROCEDURES.find((p) => p.path === path)
  if (!procedure) throw new Error(`no procedure ${path}`)
  return callProcedure<T>(api.handler, procedure, person.token, { businessId, input })
}

function ok<T>(result: CallResult<T>, what = ''): T {
  expect(result.error, `${what} ${result.raw}`).toBeUndefined()
  return result.data as T
}

/** The gate probe of a procedure: an unreadable input (none for a procedure without one). */
function gateCall(person: Person, businessId: string, procedure: ProcedureInfo) {
  return callProcedure(api.handler, procedure, person.token, {
    businessId,
    input: procedure.takesInput ? NO_INPUT_ACCEPTS : undefined,
  })
}

beforeAll(async () => {
  api = openApi()
  tenant = await createTenant(api, 'Gates')
}, 120_000)

afterAll(async () => {
  await api.close()
})

describe('the gates cover every business procedure', () => {
  it('MODULE_GATES has one entry per business procedure, naming released modules only', () => {
    expect(Object.keys(MODULE_GATES).sort()).toEqual(BUSINESS.map((p) => p.path))
    for (const [path, gate] of Object.entries(MODULE_GATES)) {
      for (const id of gate.flat()) expect(RELEASED.has(id), `${path}: ${id}`).toBe(true)
    }
  })

  it('CAPABILITY_GATES names business procedures only', () => {
    const paths = new Set(BUSINESS.map((p) => p.path))
    for (const path of Object.keys(CAPABILITY_GATES)) expect(paths.has(path), path).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------------------------------------

async function customization(): Promise<CustomizationDto> {
  return ok(await as<CustomizationDto>(tenant.owner, tenant.id, 'business.customization'))
}

async function enabledModules(): Promise<Set<string>> {
  const state = await customization()
  return new Set([
    ...ALWAYS_ENABLED_MODULE_IDS,
    ...state.modules.filter((m) => m.enabled && m.availability === 'released').map((m) => m.id),
  ])
}

async function switchModule(id: ModuleId, enabled: boolean): Promise<void> {
  ok(
    await as<CustomizeDto>(tenant.owner, tenant.id, 'business.customize', {
      item: { kind: 'module', id },
      enabled,
    }),
    `customize ${id} ${enabled}`,
  )
}

/** Turns `off` off (and what goes with them), returning what is then on. */
async function turnOff(off: readonly ModuleId[]): Promise<Set<string>> {
  for (const id of off) {
    if ((await enabledModules()).has(id)) await switchModule(id, false)
  }
  const enabled = await enabledModules()
  for (const id of off) expect(enabled.has(id), `${id} is off`).toBe(false)
  return enabled
}

async function allOn(): Promise<void> {
  for (const id of SWITCHABLE) {
    if (!(await enabledModules()).has(id)) await switchModule(id, true)
  }
  expect([...(await enabledModules())].sort()).toEqual([...RELEASED].sort())
}

/** Every business procedure as the owner: the ones whose gate is closed say MODULE_DISABLED. */
async function expectGates(enabled: ReadonlySet<string>, what: string) {
  const wrong: string[] = []
  for (const procedure of BUSINESS) {
    const result = await gateCall(tenant.owner, tenant.id, procedure)
    const code = result.error?.data.appCode ?? 'ok'
    const closed = !gateOpen(MODULE_GATES[procedure.path] ?? NONE, enabled)
    if ((code === 'module_disabled') !== closed) {
      wrong.push(`${procedure.path}: ${code}, gate ${closed ? 'closed' : 'open'}`)
    }
    // An open gate passes the input to its schema: nothing past it runs (no write).
    if (!closed && procedure.takesInput) expect(code, procedure.path).toBe('validation')
  }
  expect(wrong, what).toEqual([])
}

/** The nav paths and actions a member with `template`'s keys may use among the modules on. */
function expectedNav(template: RoleTemplateKey, enabled: ReadonlySet<string>) {
  const role = roleTemplateByKey(template)
  const can = (entry: { readonly permission?: string }) =>
    entry.permission === undefined ||
    Boolean(role?.allPermissions) ||
    (role?.permissionKeys as readonly string[] | undefined)?.includes(entry.permission) === true
  const active: readonly ModuleManifest[] = MODULES.filter(
    (m) => m.availability === 'released' && enabled.has(m.id),
  )
  return {
    modules: active.map((m) => m.id).sort(),
    paths: [...new Set(active.flatMap((m) => m.nav.filter(can).map((e) => e.path)))].sort(),
    actions: active.flatMap((m) => m.quickActions.filter(can).map((a) => a.id)).sort(),
  }
}

async function expectContext(enabled: ReadonlySet<string>, what: string) {
  const members: [RoleTemplateKey, Person][] = [
    ['owner', tenant.owner],
    ['admin', tenant.admin],
    ['employee', tenant.employee],
  ]
  for (const [template, person] of members) {
    const context = ok(await as<BusinessContextDto>(person, tenant.id, 'business.context'))
    const expected = expectedNav(template, enabled)
    expect(context.modules.map((m) => m.id).sort(), `${what} ${template}`).toEqual(expected.modules)
    expect(
      [...new Set(context.modules.flatMap((m) => m.nav.map((e) => e.path)))].sort(),
      `${what} ${template} nav`,
    ).toEqual(expected.paths)
    expect(
      context.modules.flatMap((m) => m.quickActions.map((a) => a.id)).sort(),
      `${what} ${template} "+"`,
    ).toEqual(expected.actions)
  }
}

describe('a module switched off is refused by every procedure that needs it (MODULE_DISABLED)', () => {
  it('everything on: no procedure says MODULE_DISABLED, and context lists every released module', async () => {
    await allOn()
    const enabled = await enabledModules()
    await expectGates(enabled, 'all on')
    await expectContext(enabled, 'all on')
  })

  const SCENARIOS: (readonly ModuleId[])[] = [
    ...SWITCHABLE.map((id) => [id]),
    ['purchases', 'expenses'],
    ['expenses', 'running_costs'],
    ['products', 'materials'],
    SWITCHABLE,
  ]

  it.each(SCENARIOS.map((off) => [off.join(' + '), off] as const))(
    '%s off',
    async (_label, off) => {
      const enabled = await turnOff(off)
      try {
        await expectGates(enabled, `${off.join('+')} off`)
        await expectContext(enabled, `${off.join('+')} off`)
      } finally {
        await allOn()
      }
    },
    120_000,
  )

  it('the gates inside handlers: a receipt follows its record’s module, an item bought ready to sell needs Materials', async () => {
    const receiptOf = (entity: 'purchase' | 'expense') => ({
      entity,
      entityId: entity === 'purchase' ? tenant.purchase.id : tenant.expense.id,
    })
    const before = await tenantDigest(api.admin, tenant)
    for (const [off, entity, attachmentId] of [
      ['purchases', 'purchase', tenant.attachment.id],
      ['expenses', 'expense', tenant.expenseAttachment.id],
    ] as const) {
      const enabled = await turnOff([off])
      try {
        // Receipts stay open through the other module, so only the record's own gate refuses.
        expect(gateOpen(RECEIPTS, enabled)).toBe(true)
        const record = receiptOf(entity)
        const calls: [string, unknown][] = [
          ['attachment.list', record],
          ['attachment.uploadUrl', { ...record, contentType: 'image/png' }],
          [
            'attachment.add',
            { ...record, path: `${tenant.id}/${entity}/${newId()}.png`, fileName: 'x.png' },
          ],
          ['attachment.remove', { id: attachmentId }],
        ]
        for (const [path, input] of calls) {
          const result = await as(tenant.owner, tenant.id, path, input)
          expect(result.error?.data.appCode, `${off} off: ${path} ${result.raw}`).toBe(
            'module_disabled',
          )
        }
      } finally {
        await allOn()
      }
    }
    const enabled = await turnOff(['materials'])
    try {
      expect(enabled.has('products')).toBe(true)
      const resale = await as(tenant.owner, tenant.id, 'product.create', {
        id: newId(),
        name: `Resale ${newId()}`,
        type: 'product',
        unit: 'piece',
        resale: { materialId: newId() },
      })
      expect(resale.error?.data.appCode, resale.raw).toBe('module_disabled')
    } finally {
      await allOn()
    }
    // Nothing was written but the switches (business_modules and their audit rows).
    const after = await tenantDigest(api.admin, tenant)
    const changed = Object.keys(after).filter((key) => after[key] !== before[key])
    expect(changed.filter((key) => !['business_modules', 'audit_log'].includes(key))).toEqual([])
  })

  it('a planned module is never listed, even with a row that turns it on', async () => {
    const planned = MODULES.find((m) => m.availability === 'planned')
    if (!planned) return
    await api.admin`
      insert into app.business_modules (id, business_id, module_key, enabled, created_by)
      values (${newId()}, ${tenant.id}, ${planned.id}, true, ${tenant.owner.user.id})`
    try {
      for (const person of [tenant.owner, tenant.admin, tenant.employee]) {
        const context = ok(await as<BusinessContextDto>(person, tenant.id, 'business.context'))
        expect(context.modules.map((m) => m.id)).not.toContain(planned.id)
      }
    } finally {
      await api.admin`
        update app.business_modules set enabled = false
         where business_id = ${tenant.id} and module_key = ${planned.id}`
    }
  })
})

// ---------------------------------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------------------------------

interface Business {
  id: string
  owner: Person
  today: string
  defaultLocationId: string
  material: MaterialDto
  category: CostCategoryDto
}

async function business(answers: typeof WORKSHOP): Promise<Business> {
  const owner = await api.newPerson()
  const id = await setupBusiness(api.handler, owner.token, answers, { name: `Gates ${newId()}` })
  const { today } = ok(await as<BooksDto>(owner, id, 'books.get'))
  const material = ok(
    await as<MaterialDto>(owner, id, 'material.create', {
      id: newId(),
      name: `Milk ${newId()}`,
      unit: 'l',
    }),
  )
  const category = ok(
    await as<CostCategoryDto>(owner, id, 'costCategory.create', {
      id: newId(),
      name: `Rent ${newId()}`,
    }),
  )
  const [location] = await api.admin<{ id: string }[]>`
    select id from app.locations where business_id = ${id} and is_default and deleted_at is null`
  return { id, owner, today, defaultLocationId: location?.id ?? '', material, category }
}

let alone: Business
let shop: Business
let shopBranch: LocationDto

/** What the capability says and where the field is refused: off (most) or on (the owner's time). */
interface HiddenField {
  capability: CapabilityKey
  /** Refused where the capability is `refusedWhen` (default: off). */
  refusedWhen?: 'off' | 'on'
  /** The call with the field set to what only a business with/without the capability sees. */
  input: (b: Business) => Promise<{ path: string; input: unknown }>
}

function purchaseInput(b: Business, extra: object = {}, line: object = {}) {
  return {
    id: newId(),
    businessDate: b.today,
    documentType: 'tax_invoice',
    paymentMethod: 'cash',
    lines: [
      {
        kind: 'material',
        id: newId(),
        materialId: b.material.id,
        qty: '2',
        unit: 'l',
        unitPrice: '3',
        ...line,
      },
    ],
    ...extra,
  }
}

function expenseInput(b: Business, extra: object = {}) {
  return {
    id: newId(),
    categoryId: b.category.id,
    businessDate: b.today,
    documentType: 'tax_invoice',
    paymentMethod: 'cash',
    amount: '10',
    ...extra,
  }
}

async function payer(b: Business): Promise<string> {
  const [row] = await api.admin<{ id: string }[]>`
    select id from app.business_members where business_id = ${b.id} and user_id = ${b.owner.user.id}`
  return row?.id ?? ''
}

/** Another location: the branch where there are branches, else one that does not exist. */
const otherLocation = (b: Business) => (b === shop ? shopBranch.id : newId())

const create = (path: string, input: unknown) => Promise.resolve({ path, input })

/** A draft saved without the field, then the whole draft with it. */
async function purchaseUpdate(b: Business, extra: object, line: object = {}) {
  const draft = ok(
    await as<{ data: PurchaseDto }>(b.owner, b.id, 'purchase.create', purchaseInput(b)),
  ).data
  const fields = purchaseInput(b, extra, line)
  return { path: 'purchase.update', input: { ...fields, id: draft.id, version: draft.version } }
}

async function expenseUpdate(b: Business, extra: object) {
  const draft = ok(
    await as<{ data: ExpenseDto }>(b.owner, b.id, 'expense.create', expenseInput(b)),
  ).data
  const fields = expenseInput(b, extra)
  return { path: 'expense.update', input: { ...fields, id: draft.id, version: draft.version } }
}

async function productUpdate(b: Business, extra: object) {
  const product = ok(
    await as<ProductDto>(b.owner, b.id, 'product.create', {
      id: newId(),
      name: `Cake ${newId()}`,
      type: 'product',
      unit: 'piece',
    }),
  )
  return {
    path: 'product.update',
    input: {
      id: product.id,
      version: product.version,
      name: product.name,
      type: 'product',
      unit: 'piece',
      locationIds: [],
      ...extra,
    },
  }
}

const newProduct = (extra: object) => ({
  id: newId(),
  name: `Cake ${newId()}`,
  type: 'product',
  unit: 'piece',
  ...extra,
})

/** Every input field about VAT, locations, who paid, approval and the owner's time: "path field". */
const HIDDEN_FIELDS: Record<string, HiddenField | { notHidden: string }> = {
  'business.updateProfile vatRegistered': {
    notHidden: 'the VAT switch itself: the business profile turns vat_registered on and off',
  },
  'expense.updateSettings approval': {
    capability: 'has_team',
    input: () => Promise.resolve({ path: 'expense.updateSettings', input: { approval: true } }),
  },
  'productCost.updateSettings ownerHourlyRate': {
    capability: 'has_team',
    refusedWhen: 'on',
    input: () => create('productCost.updateSettings', { ownerHourlyRate: '40' }),
  },
  'product.create ownerMinutes': {
    capability: 'has_team',
    refusedWhen: 'on',
    input: () => create('product.create', newProduct({ ownerMinutes: '5' })),
  },
  'product.update ownerMinutes': {
    capability: 'has_team',
    refusedWhen: 'on',
    input: (b) => productUpdate(b, { ownerMinutes: '5' }),
  },
  'product.create vatCategory': {
    capability: 'vat_registered',
    input: () => create('product.create', newProduct({ vatCategory: 'zero_rated' })),
  },
  'product.update vatCategory': {
    capability: 'vat_registered',
    input: (b) => productUpdate(b, { vatCategory: 'exempt' }),
  },
  'product.create priceIncludesVat': {
    capability: 'vat_registered',
    input: () => create('product.create', newProduct({ priceIncludesVat: true })),
  },
  'product.update priceIncludesVat': {
    capability: 'vat_registered',
    input: (b) => productUpdate(b, { priceIncludesVat: true }),
  },
  'product.create locationIds.*': {
    capability: 'multi_location',
    input: (b) => create('product.create', newProduct({ locationIds: [otherLocation(b)] })),
  },
  'product.update locationIds.*': {
    capability: 'multi_location',
    input: (b) => productUpdate(b, { locationIds: [otherLocation(b)] }),
  },
  'purchase.create lines.*.vatRate': {
    capability: 'vat_registered',
    input: (b) => create('purchase.create', purchaseInput(b, {}, { vatRate: '5' })),
  },
  'purchase.update lines.*.vatRate': {
    capability: 'vat_registered',
    input: (b) => purchaseUpdate(b, {}, { vatRate: '5' }),
  },
  'purchase.create pricesIncludeVat': {
    capability: 'vat_registered',
    input: (b) => create('purchase.create', purchaseInput(b, { pricesIncludeVat: true })),
  },
  'purchase.update pricesIncludeVat': {
    capability: 'vat_registered',
    input: (b) => purchaseUpdate(b, { pricesIncludeVat: true }),
  },
  'purchase.create vatNotReclaimable': {
    capability: 'vat_registered',
    input: (b) => create('purchase.create', purchaseInput(b, { vatNotReclaimable: true })),
  },
  'purchase.update vatNotReclaimable': {
    capability: 'vat_registered',
    input: (b) => purchaseUpdate(b, { vatNotReclaimable: true }),
  },
  'purchase.create locationId': {
    capability: 'multi_location',
    input: (b) => create('purchase.create', purchaseInput(b, { locationId: otherLocation(b) })),
  },
  'purchase.update locationId': {
    capability: 'multi_location',
    input: (b) => purchaseUpdate(b, { locationId: otherLocation(b) }),
  },
  'purchase.create paymentMethod': {
    capability: 'has_team',
    input: async (b) =>
      create(
        'purchase.create',
        purchaseInput(b, { paymentMethod: 'paid_by_member', paidByMemberId: await payer(b) }),
      ),
  },
  'purchase.create paidByMemberId': {
    notHidden: 'goes with paymentMethod paid_by_member (VALIDATION otherwise), refused with it',
  },
  'purchase.update paymentMethod': {
    capability: 'has_team',
    input: async (b) =>
      purchaseUpdate(b, { paymentMethod: 'paid_by_member', paidByMemberId: await payer(b) }),
  },
  'purchase.update paidByMemberId': {
    notHidden: 'goes with paymentMethod paid_by_member (VALIDATION otherwise), refused with it',
  },
  'expense.create vatRate': {
    capability: 'vat_registered',
    input: (b) => create('expense.create', expenseInput(b, { vatRate: '5' })),
  },
  'expense.update vatRate': {
    capability: 'vat_registered',
    input: (b) => expenseUpdate(b, { vatRate: '5' }),
  },
  'expense.create pricesIncludeVat': {
    capability: 'vat_registered',
    input: (b) => create('expense.create', expenseInput(b, { pricesIncludeVat: true })),
  },
  'expense.update pricesIncludeVat': {
    capability: 'vat_registered',
    input: (b) => expenseUpdate(b, { pricesIncludeVat: true }),
  },
  'expense.create vatNotReclaimable': {
    capability: 'vat_registered',
    input: (b) => create('expense.create', expenseInput(b, { vatNotReclaimable: true })),
  },
  'expense.update vatNotReclaimable': {
    capability: 'vat_registered',
    input: (b) => expenseUpdate(b, { vatNotReclaimable: true }),
  },
  'expense.create locationId': {
    capability: 'multi_location',
    input: (b) => create('expense.create', expenseInput(b, { locationId: otherLocation(b) })),
  },
  'expense.update locationId': {
    capability: 'multi_location',
    input: (b) => expenseUpdate(b, { locationId: otherLocation(b) }),
  },
  'expense.create paymentMethod': {
    capability: 'has_team',
    input: async (b) =>
      create(
        'expense.create',
        expenseInput(b, { paymentMethod: 'paid_by_member', paidByMemberId: await payer(b) }),
      ),
  },
  'expense.create paidByMemberId': {
    notHidden: 'goes with paymentMethod paid_by_member (VALIDATION otherwise), refused with it',
  },
  'expense.update paymentMethod': {
    capability: 'has_team',
    input: async (b) =>
      expenseUpdate(b, { paymentMethod: 'paid_by_member', paidByMemberId: await payer(b) }),
  },
  'expense.update paidByMemberId': {
    notHidden: 'goes with paymentMethod paid_by_member (VALIDATION otherwise), refused with it',
  },
  // Sales (M3 Step 2): a branch only with branches; a delivery priced with its VAT only with VAT.
  'sale.create locationId': {
    capability: 'multi_location',
    input: (b) => create('sale.create', saleInput(b, { locationId: otherLocation(b) })),
  },
  'sale.update locationId': {
    capability: 'multi_location',
    input: (b) => saleUpdate(b, { locationId: otherLocation(b) }),
  },
  'sale.create lines.*.amountIncludesVat': {
    capability: 'vat_registered',
    input: (b) => create('sale.create', saleInput(b, deliveryWithVat())),
  },
  'sale.update lines.*.amountIncludesVat': {
    capability: 'vat_registered',
    input: (b) => saleUpdate(b, deliveryWithVat()),
  },
  'member.updateLocations locationIds.*': {
    capability: 'multi_location',
    input: async (b) => {
      const person = await api.newPerson()
      const memberId = await join(api.db, b.owner.user, b.id, person.user, 'employee')
      const read = await as<{ version: number }>(b.owner, b.id, 'member.locations', { memberId })
      return {
        path: 'member.updateLocations',
        input: { memberId, version: read.data?.version ?? 0, locationIds: [otherLocation(b)] },
      }
    },
  },
}

/** A draft sale without lines (its only channel; the business's own default location). */
function saleInput(b: Business, extra: object = {}) {
  return { id: newId(), source: 'single', businessDate: b.today, lines: [], ...extra }
}

/** A delivery charged with its VAT. */
const deliveryWithVat = () => ({
  deliveryNeeded: true,
  lines: [{ kind: 'delivery', id: newId(), amount: '5', amountIncludesVat: true }],
})

/** A draft sale saved without the field, then the whole draft with it. */
async function saleUpdate(b: Business, extra: object) {
  const draft = ok(
    await as<{ data: { id: string; version: number } }>(b.owner, b.id, 'sale.create', saleInput(b)),
  ).data
  const fields = updateFieldsOf(saleInput(b, extra))
  return { path: 'sale.update', input: { ...fields, id: draft.id, version: draft.version } }
}

/** Field names about what a capability turns on or off. */
const CAPABILITY_FIELD = /vat|location|paidBy|paymentMethod|approval|ownerMinutes|ownerHourlyRate/i

describe('a capability that does not apply is refused by the API (CAPABILITY_DISABLED)', () => {
  beforeAll(async () => {
    alone = await business(BAKER)
    shop = await business(WORKSHOP)
    shopBranch = ok(
      await as<LocationDto>(shop.owner, shop.id, 'location.create', {
        id: newId(),
        name: `Branch ${newId()}`,
      }),
    )
  }, 60_000)

  it('the businesses: one run alone with one location and no VAT, one with all three', async () => {
    const capabilities = async (b: Business) =>
      ok(await as<BusinessContextDto>(b.owner, b.id, 'business.context')).capabilities
    expect(await capabilities(alone)).toMatchObject({
      has_team: false,
      multi_location: false,
      vat_registered: false,
    })
    expect(await capabilities(shop)).toMatchObject({
      has_team: true,
      multi_location: true,
      vat_registered: true,
    })
  })

  it('in a business run alone with one location: exactly the procedures CAPABILITY_GATES names are refused', async () => {
    const wrong: string[] = []
    for (const procedure of BUSINESS) {
      const result = await gateCall(alone.owner, alone.id, procedure)
      const code = result.error?.data.appCode ?? 'ok'
      const gated = CAPABILITY_GATES[procedure.path] !== undefined
      if ((code === 'capability_disabled') !== gated) wrong.push(`${procedure.path}: ${code}`)
    }
    expect(wrong).toEqual([])
  })

  it('with every capability on, none of them is refused for its capability', async () => {
    for (const procedure of BUSINESS.filter((p) => CAPABILITY_GATES[p.path])) {
      const result = await gateCall(shop.owner, shop.id, procedure)
      expect(result.error?.data.appCode, procedure.path).not.toBe('capability_disabled')
    }
  })

  it('every field a capability hides is classified', () => {
    const found = BUSINESS.filter((p) => p.type === 'mutation').flatMap((procedure) => {
      const schema = inputSchemaOf(appRouter, procedure.path)
      return (schema ? inputLeaves(schema) : [])
        .filter((leaf) => CAPABILITY_FIELD.test(leaf.name))
        .map((leaf) => `${procedure.path} ${leaf.path}`)
    })
    expect(found.sort()).toEqual(Object.keys(HIDDEN_FIELDS).sort())
  })

  const PROBES = Object.entries(HIDDEN_FIELDS).flatMap(([key, field]) =>
    'notHidden' in field ? [] : [[key, field] as const],
  )

  it.each(PROBES)(
    '%s: refused where it does not apply, nothing written; taken where it does',
    async (_key, field) => {
      const refusedWhenOn = field.refusedWhen === 'on'
      const [refusedIn, takenIn] = refusedWhenOn ? [shop, alone] : [alone, shop]
      const refused = await field.input(refusedIn)
      const digestOf = (b: Business) => api.admin<{ h: string }[]>`
      select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) as h
        from app.audit_log t where t.business_id = ${b.id}`
      const [before] = await digestOf(refusedIn)
      const result = await as(refusedIn.owner, refusedIn.id, refused.path, refused.input)
      expect(result.error?.data.appCode, result.raw).toBe('capability_disabled')
      const [after] = await digestOf(refusedIn)
      expect(after?.h, 'nothing written').toBe(before?.h)

      const taken = await field.input(takenIn)
      const accepted = await as(takenIn.owner, takenIn.id, taken.path, taken.input)
      expect(accepted.error, accepted.raw).toBeUndefined()
    },
  )

  it('approvals need a team: sending an expense for approval in a business run alone is APPROVAL_OFF', async () => {
    const draft = ok(
      await as<{ data: ExpenseDto }>(alone.owner, alone.id, 'expense.create', expenseInput(alone)),
    ).data
    const sent = await as(alone.owner, alone.id, 'expense.submit', {
      id: draft.id,
      version: draft.version,
    })
    expect(sent.error?.data.appCode, sent.raw).toBe('approval_off')
    const settings = ok(
      await as<{ approval: boolean; hasTeam: boolean }>(alone.owner, alone.id, 'expense.settings'),
    )
    expect(settings).toMatchObject({ hasTeam: false })
  })

  it('the default location is what a business with one location sends: taken', async () => {
    for (const [path, input] of [
      ['purchase.create', purchaseInput(alone, { locationId: alone.defaultLocationId })],
      ['expense.create', expenseInput(alone, { locationId: alone.defaultLocationId })],
    ] as const) {
      const result = await as(alone.owner, alone.id, path, input)
      expect(result.error, `${path}: ${result.raw}`).toBeUndefined()
    }
  })
})

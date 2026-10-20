import { randomBytes } from 'node:crypto'
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
import { compareDecimal, newId, type AttachmentEntity } from '@bizcost/domain'
import {
  ALWAYS_ENABLED_MODULE_IDS,
  MODULES as MANIFESTS,
  roleTemplateByKey,
  type CapabilityKey,
  type ModuleId,
  type ModuleManifest,
  type RoleTemplateKey,
} from '@bizcost/modules'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { appRouter } from '../../src'
import { pdfFullText } from '../../src/documents/pdf/text-layer'
import type { CallResult } from '../helpers'
import { BAKER, join, setupBusiness, WORKSHOP } from '../settings'
import {
  callProcedure,
  createTenant,
  openApi,
  proceduresOf,
  tenantDigest,
  type Api,
  type Person,
  type ProcedureInfo,
  type Tenant,
} from './fixture'
import { updateFieldsOf } from '../sales'
import { inputLeaves, inputSchemaOf, optionsOf } from './schema'

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
 * The registry the suites' API serves: the manifests as released code has them (Quotations and
 * Invoices released with Release B, M3 Step 9; nothing is previewed).
 */
const MODULES: readonly ModuleManifest[] = MANIFESTS

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
  // An order's files (M3 Step 5: the customer's LPO).
  ['files', 'orders'],
  // A quotation's files and its lines' pictures (M3 Step 7).
  ['files', 'quotations'],
  // An invoice's files and its lines' pictures (M3 Step 8).
  ['files', 'invoices'],
]
const QUOTATIONS: Gate = [['quotations']]
/** Settings → Documents (M3 Step 7): wherever documents print (statements too, Release B). */
const DOCUMENTS: Gate = [['quotations'], ['invoices'], ['customers', 'payments']]
/**
 * Invoices and credit notes (M3 Step 8). Invoices needs Sales (Release B review): Customize turns it
 * off with Sales, so Sales off closes these too (the 'sales' scenarios below).
 */
const INVOICES: Gate = [['invoices']]
/** A customer's statement (M3 Step 8, Q27): Customers and Payments, Invoices or not (Release B, B10). */
const STATEMENTS: Gate = [['customers', 'payments']]
const CUSTOMERS: Gate = [['customers']]
const ORDERS: Gate = [['orders']]
const PAYMENTS: Gate = [['payments']]
const SALES: Gate = [['sales']]
const SALES_AND_PRODUCTS: Gate = [['sales', 'products']]
/**
 * The books-closed date: purchases, expenses, sales and orders obey it (D-227, D-236, Release A);
 * reading it also serves who sees what customers pay (their payments obey it too).
 */
const BOOKS: Gate = [['purchases'], ['expenses'], ['sales'], ['orders']]
const BOOKS_READ: Gate = [...BOOKS, ['payments']]

const MODULE_GATES: Record<string, Gate> = {
  'attachment.add': RECEIPTS,
  'attachment.list': RECEIPTS,
  'attachment.remove': RECEIPTS,
  'attachment.uploadUrl': RECEIPTS,
  'books.close': BOOKS,
  'books.get': BOOKS_READ,
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
  // A channel's statements (M3 Step 4).
  'channelStatement.create': SALES,
  'channelStatement.discard': SALES,
  'channelStatement.get': SALES,
  'channelStatement.list': SALES,
  'channelStatement.post': SALES,
  'channelStatement.reverse': SALES,
  'channelStatement.update': SALES,
  'costCategory.archive': EXPENSES_OR_RUNNING_COSTS,
  'costCategory.create': EXPENSES_OR_RUNNING_COSTS,
  'costCategory.list': EXPENSES_OR_RUNNING_COSTS,
  'costCategory.unarchive': EXPENSES_OR_RUNNING_COSTS,
  'costCategory.update': EXPENSES_OR_RUNNING_COSTS,
  // Credit notes (M3 Step 8).
  'creditNote.create': INVOICES,
  'creditNote.discard': INVOICES,
  'creditNote.get': INVOICES,
  'creditNote.history': INVOICES,
  'creditNote.issue': INVOICES,
  'creditNote.list': INVOICES,
  'creditNote.pdf': INVOICES,
  'creditNote.update': INVOICES,
  // Customers and customer payments (M3 Step 5).
  'customer.archive': CUSTOMERS,
  'customer.create': CUSTOMERS,
  'customer.get': CUSTOMERS,
  'customer.list': CUSTOMERS,
  'customer.pick': CUSTOMERS,
  'customer.similar': CUSTOMERS,
  'customer.statement': STATEMENTS,
  'customer.statementPdf': STATEMENTS,
  'customer.unarchive': CUSTOMERS,
  'customer.update': CUSTOMERS,
  'customerPayment.list': PAYMENTS,
  'customerPayment.record': PAYMENTS,
  'customerPayment.recordMany': PAYMENTS,
  'customerPayment.reverse': PAYMENTS,
  'dashboard.cards': NONE,
  'dashboard.checklist': NONE,
  // Settings → Documents (M3 Step 7).
  'document.imageUploadUrl': DOCUMENTS,
  'document.removeImage': DOCUMENTS,
  'document.setImage': DOCUMENTS,
  'document.settings': DOCUMENTS,
  'document.updateSettings': DOCUMENTS,
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
  // The layouts of files imported (M3 Step 4).
  'importProfile.list': SALES,
  'importProfile.remove': SALES,
  'invitation.create': NONE,
  'invitation.list': NONE,
  'invitation.resend': NONE,
  'invitation.revoke': NONE,
  // Invoices (M3 Step 8; from a quotation, an order or a sale: their own module, checked inside).
  'invoice.copyToQuotation': INVOICES,
  'invoice.create': INVOICES,
  'invoice.depositsWithoutInvoice': INVOICES,
  'invoice.discard': INVOICES,
  'invoice.fromOrder': INVOICES,
  'invoice.fromQuotation': INVOICES,
  'invoice.fromSale': INVOICES,
  'invoice.get': INVOICES,
  'invoice.history': INVOICES,
  'invoice.issue': INVOICES,
  'invoice.list': INVOICES,
  'invoice.pdf': INVOICES,
  'invoice.update': INVOICES,
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
  // "Branches they work in": with a team and branches, whatever modules are on (Q12; the plan's
  // Step 6; M3 Step 6 review: a limit narrows team changes too, so wherever one applies it shows).
  'member.locations': NONE,
  'member.permissions': NONE,
  'member.remove': NONE,
  'member.transferOwnership': NONE,
  'member.updateLocations': NONE,
  'member.updatePermissions': NONE,
  // Orders (M3 Step 5).
  'order.cancel': ORDERS,
  'order.create': ORDERS,
  'order.deliver': ORDERS,
  'order.get': ORDERS,
  'order.list': ORDERS,
  'order.undoDelivery': ORDERS,
  'order.update': ORDERS,
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
  // Quotations (M3 Step 7, Release B): making an order of one also needs Orders (in the handler).
  'quotation.accept': QUOTATIONS,
  'quotation.copy': QUOTATIONS,
  'quotation.create': QUOTATIONS,
  'quotation.decline': QUOTATIONS,
  'quotation.discard': QUOTATIONS,
  'quotation.get': QUOTATIONS,
  'quotation.history': QUOTATIONS,
  'quotation.list': QUOTATIONS,
  'quotation.pdf': QUOTATIONS,
  'quotation.revise': QUOTATIONS,
  'quotation.send': QUOTATIONS,
  'quotation.toOrder': QUOTATIONS,
  'quotation.update': QUOTATIONS,
  'receivable.list': PAYMENTS,
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
  'sale.refund': SALES,
  'sale.reverse': SALES,
  'sale.update': SALES,
  // Importing sales from a file (M3 Step 4): the names are matched to products.
  'saleImport.addRows': SALES_AND_PRODUCTS,
  'saleImport.create': SALES_AND_PRODUCTS,
  'saleImport.discard': SALES_AND_PRODUCTS,
  'saleImport.get': SALES_AND_PRODUCTS,
  'saleImport.list': SALES_AND_PRODUCTS,
  'saleImport.match': SALES_AND_PRODUCTS,
  'saleImport.post': SALES_AND_PRODUCTS,
  'saleImport.reverse': SALES_AND_PRODUCTS,
  'saleImport.setOverlap': SALES_AND_PRODUCTS,
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
  const holds = (key: string) =>
    Boolean(role?.allPermissions) ||
    (role?.permissionKeys as readonly string[] | undefined)?.includes(key) === true
  const can = (entry: { readonly permission?: string; readonly alsoNeeds?: readonly string[] }) =>
    (entry.permission === undefined || holds(entry.permission)) &&
    (entry.alsoNeeds ?? []).every(holds)
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
    // Orders and Invoices go with Sales (a delivery and an issued invoice are sales): nothing then
    // obeys the books-closed date but what customers pay, so only reading it stays open.
    ['purchases', 'expenses', 'sales'],
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
    // Smart Setup may have written its row already (Inventory for a workshop): kept as it was.
    const [before] = await api.admin<{ enabled: boolean }[]>`
      select enabled from app.business_modules
       where business_id = ${tenant.id} and module_key = ${planned.id}`
    await api.admin`
      insert into app.business_modules (id, business_id, module_key, enabled, created_by)
      values (${newId()}, ${tenant.id}, ${planned.id}, true, ${tenant.owner.user.id})
      on conflict (business_id, module_key) do update set enabled = true`
    try {
      for (const person of [tenant.owner, tenant.admin, tenant.employee]) {
        const context = ok(await as<BusinessContextDto>(person, tenant.id, 'business.context'))
        expect(context.modules.map((m) => m.id)).not.toContain(planned.id)
      }
    } finally {
      await api.admin`
        update app.business_modules set enabled = ${before?.enabled ?? false}
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
  'saleImport.create locationId': {
    capability: 'multi_location',
    input: async (b) => importCreate(b, { locationId: otherLocation(b) }),
  },
  'saleImport.create amountsIncludeVat': {
    capability: 'vat_registered',
    input: async (b) => importCreate(b, { amountsIncludeVat: true }),
  },
  'sale.create lines.*.amountIncludesVat': {
    capability: 'vat_registered',
    input: (b) => create('sale.create', saleInput(b, deliveryWithVat())),
  },
  'sale.update lines.*.amountIncludesVat': {
    capability: 'vat_registered',
    input: (b) => saleUpdate(b, deliveryWithVat()),
  },
  // Orders (M3 Step 5): a branch only with branches; a delivery priced with its VAT only with VAT.
  'order.create locationId': {
    capability: 'multi_location',
    input: (b) => create('order.create', orderInput(b, { locationId: otherLocation(b) })),
  },
  'order.update locationId': {
    capability: 'multi_location',
    input: (b) => orderUpdate(b, { locationId: otherLocation(b) }),
  },
  'order.create lines.*.amountIncludesVat': {
    capability: 'vat_registered',
    input: (b) => create('order.create', orderInput(b, deliveryWithVat())),
  },
  // A typed item (M3 Step 7, Q21: carried from a quotation): its VAT as typed.
  'order.create lines.*.priceIncludesVat': {
    capability: 'vat_registered',
    input: (b) => create('order.create', orderInput(b, typedLine({ priceIncludesVat: true }))),
  },
  'order.update lines.*.priceIncludesVat': {
    capability: 'vat_registered',
    input: (b) => orderUpdate(b, typedLine({ priceIncludesVat: true })),
  },
  'order.create lines.*.vatCategory': {
    capability: 'vat_registered',
    input: (b) => create('order.create', orderInput(b, typedLine({ vatCategory: 'zero_rated' }))),
  },
  'order.update lines.*.vatCategory': {
    capability: 'vat_registered',
    input: (b) => orderUpdate(b, typedLine({ vatCategory: 'exempt' })),
  },
  // Quotations (M3 Step 7): the location, and a typed line's VAT as typed.
  'quotation.create locationId': {
    capability: 'multi_location',
    input: async (b) =>
      create('quotation.create', await quotationInput(b, { locationId: otherLocation(b) })),
  },
  'quotation.update locationId': {
    capability: 'multi_location',
    input: (b) => quotationUpdate(b, { locationId: otherLocation(b) }),
  },
  'quotation.create lines.*.priceIncludesVat': {
    capability: 'vat_registered',
    input: async (b) =>
      create(
        'quotation.create',
        await quotationInput(b, quotationTyped({ priceIncludesVat: true })),
      ),
  },
  'quotation.update lines.*.priceIncludesVat': {
    capability: 'vat_registered',
    input: (b) => quotationUpdate(b, quotationTyped({ priceIncludesVat: true })),
  },
  'quotation.create lines.*.vatCategory': {
    capability: 'vat_registered',
    input: async (b) =>
      create(
        'quotation.create',
        await quotationInput(b, quotationTyped({ vatCategory: 'zero_rated' })),
      ),
  },
  'quotation.update lines.*.vatCategory': {
    capability: 'vat_registered',
    input: (b) => quotationUpdate(b, quotationTyped({ vatCategory: 'exempt' })),
  },
  'order.update lines.*.amountIncludesVat': {
    capability: 'vat_registered',
    input: (b) => orderUpdate(b, deliveryWithVat()),
  },
  // Invoices (M3 Step 8): the location, and a typed line's VAT as typed.
  'invoice.create locationId': {
    capability: 'multi_location',
    input: async (b) =>
      create('invoice.create', await invoiceInput(b, { locationId: otherLocation(b) })),
  },
  'invoice.update locationId': {
    capability: 'multi_location',
    input: (b) => invoiceUpdate(b, { locationId: otherLocation(b) }),
  },
  'invoice.create lines.*.priceIncludesVat': {
    capability: 'vat_registered',
    input: async (b) =>
      create('invoice.create', await invoiceInput(b, quotationTyped({ priceIncludesVat: true }))),
  },
  'invoice.update lines.*.priceIncludesVat': {
    capability: 'vat_registered',
    input: (b) => invoiceUpdate(b, quotationTyped({ priceIncludesVat: true })),
  },
  'invoice.create lines.*.vatCategory': {
    capability: 'vat_registered',
    input: async (b) =>
      create(
        'invoice.create',
        await invoiceInput(b, quotationTyped({ vatCategory: 'zero_rated' })),
      ),
  },
  'invoice.update lines.*.vatCategory': {
    capability: 'vat_registered',
    input: (b) => invoiceUpdate(b, quotationTyped({ vatCategory: 'exempt' })),
  },
  // What a query reads by (M3 Step 10): a branch only with branches.
  'sale.list locationId': {
    notHidden:
      'a filter: with one location every sale is at it, and a member limited to branches sees only ' +
      'theirs whatever it names (Q12; the branch limits below)',
  },
  'sale.daySheet locationId': {
    capability: 'multi_location',
    input: async (b) => ({
      path: 'sale.daySheet',
      input: {
        businessDate: b.today,
        channelId: await firstChannel(b),
        locationId: otherLocation(b),
      },
    }),
  },
  'profit.summary groupBy=branch': {
    capability: 'multi_location',
    input: (b) => create('profit.summary', { from: b.today, to: b.today, groupBy: 'branch' }),
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

/** A pending order without lines (M3 Step 5; its only channel, the default location). */
function orderInput(b: Business, extra: object = {}) {
  return { id: newId(), businessDate: b.today, lines: [], ...extra }
}

/** An order saved without the field, then the whole order with it. */
async function orderUpdate(b: Business, extra: object) {
  const order = ok(
    await as<{ data: { id: string; version: number } }>(
      b.owner,
      b.id,
      'order.create',
      orderInput(b),
    ),
  ).data
  const fields = orderInput(b, extra)
  return {
    path: 'order.update',
    input: { ...fields, id: order.id, version: order.version },
  }
}

/** A typed item of an order (M3 Step 7, Q21). */
const typedLine = (extra: object) => ({
  lines: [
    { kind: 'typed', id: newId(), description: 'Site visit', qty: '1', unitPrice: '5', ...extra },
  ],
})

/** A quotation's typed line (M3 Step 7). */
const quotationTyped = (extra: object) => ({
  lines: [
    { id: newId(), productId: null, description: 'Site visit', qty: '1', unitPrice: '5', ...extra },
  ],
})

/** Each business's customer, with `module` turned on (the baker has them off). */
const documentCustomers = new Map<string, string>()

async function documentCustomer(b: Business, module: 'quotations' | 'invoices') {
  const state = ok(await as<CustomizationDto>(b.owner, b.id, 'business.customization'))
  if (!state.modules.find((m) => m.id === module)?.enabled) {
    ok(
      await as<CustomizeDto>(b.owner, b.id, 'business.customize', {
        item: { kind: 'module', id: module },
        enabled: true,
      }),
    )
  }
  let customerId = documentCustomers.get(b.id)
  if (!customerId) {
    customerId = ok(
      await as<{ id: string }>(b.owner, b.id, 'customer.create', { id: newId(), name: 'Noor' }),
    ).id
    documentCustomers.set(b.id, customerId)
  }
  return customerId
}

async function quotationInput(b: Business, extra: object = {}) {
  const customerId = await documentCustomer(b, 'quotations')
  return { id: newId(), customerId, businessDate: b.today, lines: [], ...extra }
}

/** A draft invoice without lines (M3 Step 8; the default location). */
async function invoiceInput(b: Business, extra: object = {}) {
  const customerId = await documentCustomer(b, 'invoices')
  return { id: newId(), customerId, lines: [], ...extra }
}

/** An invoice saved without the field, then the whole draft with it. */
async function invoiceUpdate(b: Business, extra: object) {
  const fields = await invoiceInput(b)
  const invoice = ok(
    await as<{ id: string; version: number }>(b.owner, b.id, 'invoice.create', fields),
  )
  return {
    path: 'invoice.update',
    input: { ...fields, ...extra, id: invoice.id, version: invoice.version },
  }
}

/** A quotation saved without the field, then the whole quotation with it. */
async function quotationUpdate(b: Business, extra: object) {
  const fields = await quotationInput(b)
  const quotation = ok(
    await as<{ id: string; version: number }>(b.owner, b.id, 'quotation.create', fields),
  )
  return {
    path: 'quotation.update',
    input: { ...fields, ...extra, id: quotation.id, version: quotation.version },
  }
}

/** A file of one day's sales to import (M3 Step 4): another file (its hash) each time. */
async function importCreate(b: Business, extra: object) {
  const channels = ok(
    await as<{ data: { items: { id: string }[] } }>(b.owner, b.id, 'channel.list', {}),
  ).data.items
  return {
    path: 'saleImport.create',
    input: {
      id: newId(),
      channelId: channels[0]!.id,
      fileName: 'sales.csv',
      fileHash: randomBytes(32).toString('hex'),
      fingerprint: randomBytes(32).toString('hex'),
      shape: 'summary',
      periodFrom: b.today,
      periodTo: b.today,
      mapping: { headerRow: 0, columns: { name: 0, total: 1 }, headers: {}, dateOrder: 'dmy' },
      amountsIncludeVat: false,
      rowsRead: 1,
      rowsLeftOut: 0,
      rowCount: 1,
      ...extra,
    },
  }
}

/** Field names about what a capability turns on or off. */
const CAPABILITY_FIELD = /vat|location|paidBy|paymentMethod|approval|ownerMinutes|ownerHourlyRate/i
/** Options of a query's field about one (M3 Step 10: Real profit by branch). */
const CAPABILITY_OPTION = /branch|location/i

/** The business's first sales channel. */
async function firstChannel(b: Business): Promise<string> {
  const channels = ok(
    await as<{ data: { items: { id: string }[] } }>(b.owner, b.id, 'channel.list', {}),
  ).data.items
  return channels[0]!.id
}

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

  it('every field a capability hides is classified, in what is entered and in what is read', () => {
    const found = BUSINESS.flatMap((procedure) => {
      const schema = inputSchemaOf(appRouter, procedure.path)
      return (schema ? inputLeaves(schema) : []).flatMap((leaf) => {
        if (CAPABILITY_FIELD.test(leaf.name)) return [`${procedure.path} ${leaf.path}`]
        // A query's options (By branch): each one about a capability is classified on its own.
        return procedure.type === 'query'
          ? (optionsOf(leaf.schema) ?? [])
              .filter((option) => CAPABILITY_OPTION.test(option))
              .map((option) => `${procedure.path} ${leaf.path}=${option}`)
          : []
      })
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

// ---------------------------------------------------------------------------------------------------
// Branch limits (Q12; M3 Step 10)
// ---------------------------------------------------------------------------------------------------
//
// "A member limited to branches sees and enters sales, orders, imports and reports only for those
// branches; products, customers and costs stay business-wide" (Q12 A; D-236, D-273, D-296, D-320).
// For EVERY business procedure, BRANCH_LIMITS says why it is business-wide, or how a member limited
// to the default location is kept from the other branch, where the fixture's sale, imports, orders,
// payments, quotations, invoices, credit notes and their files are. The member is an Admin (every
// key), so only the branch refuses:
//   - `refused`: a record of the other branch is NOT_FOUND (as if it did not exist), entering at it
//     FORBIDDEN; nothing is written;
//   - `lists`: served, with nothing of the other branch (its records' ids and words) where the owner's
//     same answer has them; `check` holds what an aggregate must (nothing sold at their branch).
// A procedure added without an entry fails the first test.

interface BranchCall {
  input: unknown
  code: 'not_found' | 'forbidden'
}

interface BranchLimit {
  /** Business-wide: why the branch does not limit it. */
  wide?: string
  /** Calls that name the other branch or one of its records: each refused with its code. */
  refused?: (t: Tenant) => BranchCall[]
  /** An input whose answer shows the owner the other branch's records, and the member none. */
  lists?: (t: Tenant) => unknown
  /** What else holds of the member's answer to `lists` (and of the owner's, the control). */
  check?: (mine: unknown, owners: unknown, t: Tenant) => void | Promise<void>
  /** Proven by its own case below (it needs another kind of business). */
  below?: string
}

const COSTS_WIDE = 'products, materials and costs stay business-wide (Q12)'
const SETTINGS_WIDE = 'the business, its settings and its letterhead: one for every branch'
const TEAM_WIDE =
  'the team: a limited member changes no one beyond their branches (D-236, sales-visibility.api)'
const CUSTOMERS_WIDE = 'customers stay business-wide (Q12)'

/** Routers whose every procedure is business-wide. */
const WIDE_ROUTERS: Record<string, string> = {
  books: 'the books-closed date is the business’s',
  business: SETTINGS_WIDE,
  location: 'the business’s branches themselves (Settings → Branches)',
  member: TEAM_WIDE,
  invitation: TEAM_WIDE,
  role: TEAM_WIDE,
  material: COSTS_WIDE,
  product: COSTS_WIDE,
  recipe: COSTS_WIDE,
  productCost: COSTS_WIDE,
  supplier: 'suppliers, purchases and what is owed to them are costs: business-wide (Q12)',
  purchase: 'purchases are costs: business-wide (Q12)',
  purchaseReturn: 'purchases are costs: business-wide (Q12)',
  purchasePayment: 'purchases are costs: business-wide (Q12)',
  payable: 'what the business owes is costs: business-wide (Q12)',
  costCategory: 'expenses and running costs are costs: business-wide (Q12)',
  expense: 'expenses are costs: business-wide (Q12)',
  expensePayment: 'expenses are costs: business-wide (Q12)',
  runningCost: 'running costs are costs: business-wide (Q12)',
  channel: 'a sales channel sells in every branch',
  channelStatement:
    'a channel’s statement is its fees for a period, every branch’s: costs, business-wide (Q12)',
  importProfile: 'the layouts of files imported serve every branch',
  document: SETTINGS_WIDE,
}

/** The other branch's records and files the fixture made: what the member may never be shown. */
function branchMarkers(t: Tenant): string[] {
  return [
    t.sale.id,
    t.sale.notes ?? t.sale.id,
    t.saleImport.id,
    t.draftImport.id,
    t.order.id,
    t.order.notes ?? t.order.id,
    t.deliveredOrder.id,
    t.refund.id,
    t.payLaterSale.id,
    t.orderPayment.id,
    t.salePayment.id,
    t.invoicePayment.id,
    t.quotation.id,
    t.quotation.site ?? t.quotation.id,
    t.sentQuotation.id,
    t.acceptedQuotation.id,
    t.invoice.id,
    t.invoice.notes ?? t.invoice.id,
    t.draftInvoice.id,
    t.creditNote.id,
    t.creditNote.reasonText,
    t.draftCreditNote.id,
    t.linePicture.id,
    t.orderFile.id,
    t.signedCopy.id,
    t.invoiceFile.id,
    t.invoiceLinePicture.id,
  ]
}

/** A record of each kind a file of an order, a quotation or an invoice belongs to (other branch). */
function branchRecordOf(t: Tenant): [AttachmentEntity, string][] {
  return [
    ['order', t.order.id],
    ['quotation', t.quotation.id],
    ['quotation_line', t.quotation.lines[0]!.id],
    ['invoice', t.invoice.id],
    ['invoice_line', t.draftInvoice.lines[0]!.id],
  ]
}

const notFound = (input: unknown): BranchCall => ({ input, code: 'not_found' })
const forbidden = (input: unknown): BranchCall => ({ input, code: 'forbidden' })

/** A draft sale at the other branch (the fixture's draft of Today's sales is at the default one). */
let branchDraft: { id: string; version: number }
/**
 * The member's own drafts at their branch (the default location): moving one to the other branch is
 * entering at it (FORBIDDEN).
 */
const ownDrafts = {} as Record<
  'sale' | 'order' | 'quotation' | 'invoice',
  { id: string; version: number }
>
let branchToday: string

function monthSoFar(t: Tenant) {
  return { from: `${t.sale.businessDate.slice(0, 7)}-01`, to: t.sale.businessDate }
}

const BRANCH_LIMITS: Record<string, BranchLimit> = {
  // Files of an order, a quotation and an invoice follow their record (purchases' and expenses'
  // receipts are costs: business-wide).
  'attachment.add': {
    refused: (t) =>
      branchRecordOf(t).map(([entity, entityId]) =>
        notFound({ entity, entityId, path: `${t.id}/${entity}/${newId()}.png`, fileName: 'x.png' }),
      ),
  },
  'attachment.list': {
    refused: (t) => branchRecordOf(t).map(([entity, entityId]) => notFound({ entity, entityId })),
  },
  'attachment.remove': {
    refused: (t) =>
      [t.orderFile, t.signedCopy, t.linePicture, t.invoiceFile, t.invoiceLinePicture].map((f) =>
        notFound({ id: f.id }),
      ),
  },
  'attachment.uploadUrl': {
    refused: (t) =>
      branchRecordOf(t).map(([entity, entityId]) =>
        notFound({ entity, entityId, contentType: 'image/png' }),
      ),
  },
  'creditNote.create': {
    refused: (t) => [
      notFound({
        id: newId(),
        invoiceId: t.invoice.id,
        eventDate: branchToday,
        reason: 'price_changed',
        reasonText: 'Price agreed again',
        by: 'amount',
        lines: [{ invoiceLineId: t.invoice.lines[1]!.id, amount: '1' }],
      }),
    ],
  },
  'creditNote.discard': {
    refused: (t) => [notFound({ id: t.draftCreditNote.id, version: t.draftCreditNote.version })],
  },
  'creditNote.get': { refused: (t) => [notFound({ id: t.creditNote.id })] },
  'creditNote.history': { refused: (t) => [notFound({ id: t.creditNote.id })] },
  'creditNote.issue': {
    refused: (t) => [notFound({ id: t.draftCreditNote.id, version: t.draftCreditNote.version })],
  },
  'creditNote.list': { lists: () => ({}) },
  'creditNote.pdf': { refused: (t) => [notFound({ id: t.creditNote.id })] },
  'creditNote.update': {
    refused: (t) => [
      notFound({
        id: t.draftCreditNote.id,
        version: t.draftCreditNote.version,
        eventDate: branchToday,
        reason: 'goods_returned',
        reasonText: 'Returned',
        by: 'quantity',
        lines: [{ invoiceLineId: t.invoice.lines[0]!.id, qty: '1' }],
      }),
    ],
  },
  'customer.archive': { wide: CUSTOMERS_WIDE },
  'customer.create': { wide: CUSTOMERS_WIDE },
  'customer.get': { wide: CUSTOMERS_WIDE },
  'customer.list': { wide: CUSTOMERS_WIDE },
  'customer.pick': { wide: CUSTOMERS_WIDE },
  'customer.similar': { wide: CUSTOMERS_WIDE },
  'customer.unarchive': { wide: CUSTOMERS_WIDE },
  'customer.update': { wide: CUSTOMERS_WIDE },
  // A customer's statement: their documents and payments of the member's branches only.
  'customer.statement': {
    lists: (t) => ({ customerId: t.customer.id, ...monthSoFar(t) }),
    check: (mine, owners) => {
      expect((owners as { entries: unknown[] }).entries.length).toBeGreaterThan(0)
      expect((mine as { entries: unknown[] }).entries).toEqual([])
    },
  },
  'customer.statementPdf': {
    lists: (t) => ({ customerId: t.customer.id, ...monthSoFar(t) }),
    check: async (mine, owners, t) => {
      const text = (answer: unknown) =>
        pdfFullText(new Uint8Array(Buffer.from((answer as { base64: string }).base64, 'base64')))
      const number = t.invoice.number ?? ''
      expect(number).not.toBe('')
      expect(await text(owners)).toContain(number)
      expect(await text(mine)).not.toContain(number)
    },
  },
  'customerPayment.list': {
    refused: (t) => [
      notFound({ orderId: t.order.id }),
      notFound({ saleId: t.payLaterSale.id }),
      notFound({ invoiceId: t.invoice.id }),
    ],
    lists: (t) => ({ customerId: t.customer.id }),
  },
  'customerPayment.record': {
    refused: (t) =>
      [{ orderId: t.order.id }, { saleId: t.payLaterSale.id }, { invoiceId: t.invoice.id }].map(
        (on) =>
          notFound({ id: newId(), ...on, businessDate: branchToday, method: 'cash', amount: '1' }),
      ),
  },
  'customerPayment.recordMany': {
    refused: (t) =>
      [{ invoiceId: t.invoice.id }, { orderId: t.order.id }, { saleId: t.payLaterSale.id }].map(
        (document) =>
          notFound({
            customerId: t.customer.id,
            businessDate: branchToday,
            method: 'cash',
            amount: '1',
            documents: [{ id: newId(), ...document }],
          }),
      ),
  },
  'customerPayment.reverse': {
    refused: (t) =>
      [t.orderPayment, t.salePayment, t.invoicePayment].map((p) => notFound({ id: p.id })),
  },
  // The cards: their branches' sales, orders and what their customers owe.
  'dashboard.cards': {
    lists: () => undefined,
    check: (mine, owners) => {
      interface Cards {
        data: {
          sales: { value: string } | null
          recentOrders: unknown[] | null
          customersOwe: { owed: string } | null
          topProducts: { byQuantity: unknown[] } | null
        }
      }
      const theirs = (mine as Cards).data
      const all = (owners as Cards).data
      expect(compareDecimal(all.sales?.value ?? '0', '0')).toBe(1)
      expect(theirs.sales?.value ?? '0').toBe('0')
      expect(all.recentOrders?.length).toBeGreaterThan(0)
      // Their own order at their branch only.
      expect((theirs.recentOrders ?? []).map((o) => (o as { id: string }).id)).toEqual([
        ownDrafts.order.id,
      ])
      expect(compareDecimal(all.customersOwe?.owed ?? '0', '0')).toBe(1)
      expect(theirs.customersOwe?.owed ?? '0').toBe('0')
      expect(theirs.topProducts?.byQuantity ?? []).toEqual([])
    },
  },
  'dashboard.checklist': {
    wide:
      'the getting-started steps follow the business’s data (done or not), as for an Employee ' +
      'who sees only their own sales (PRODUCT §10)',
  },
  'invoice.copyToQuotation': { refused: (t) => [notFound({ id: t.invoice.id, newId: newId() })] },
  'invoice.create': {
    refused: (t) => [
      forbidden({ id: newId(), customerId: t.customer.id, locationId: t.branch.id, lines: [] }),
    ],
  },
  'invoice.depositsWithoutInvoice': {
    below: 'deposits without a tax invoice are a VAT-registered business’s: the case below',
  },
  'invoice.discard': {
    refused: (t) => [notFound({ id: t.draftInvoice.id, version: t.draftInvoice.version })],
  },
  'invoice.fromOrder': { refused: (t) => [notFound({ orderId: t.order.id, newId: newId() })] },
  'invoice.fromQuotation': {
    refused: (t) => [notFound({ id: t.acceptedQuotation.id, newId: newId() })],
  },
  'invoice.fromSale': {
    refused: (t) => [notFound({ saleId: t.payLaterSale.id, newId: newId() })],
  },
  'invoice.get': { refused: (t) => [notFound({ id: t.invoice.id })] },
  'invoice.history': { refused: (t) => [notFound({ id: t.invoice.id })] },
  'invoice.issue': {
    refused: (t) => [notFound({ id: t.draftInvoice.id, version: t.draftInvoice.version })],
  },
  'invoice.list': { lists: () => ({}) },
  'invoice.pdf': { refused: (t) => [notFound({ id: t.invoice.id })] },
  'invoice.update': {
    refused: (t) => [
      notFound({
        id: t.draftInvoice.id,
        version: t.draftInvoice.version,
        customerId: t.customer.id,
        lines: [],
      }),
      forbidden({
        ...ownDrafts.invoice,
        customerId: t.customer.id,
        locationId: t.branch.id,
        lines: [],
      }),
    ],
  },
  'order.cancel': {
    refused: (t) => [notFound({ id: t.order.id, version: t.order.version, reason: 'No longer' })],
  },
  'order.create': {
    refused: (t) => [
      forbidden({
        id: newId(),
        customerId: t.customer.id,
        businessDate: branchToday,
        locationId: t.branch.id,
        lines: [],
      }),
    ],
  },
  'order.deliver': { refused: (t) => [notFound({ id: t.order.id, version: t.order.version })] },
  'order.get': { refused: (t) => [notFound({ id: t.order.id })] },
  'order.list': { lists: () => ({}) },
  'order.undoDelivery': { refused: (t) => [notFound({ id: t.deliveredOrder.id })] },
  'order.update': {
    refused: (t) => [
      notFound({ id: t.order.id, version: t.order.version, businessDate: branchToday, lines: [] }),
      forbidden({
        ...ownDrafts.order,
        customerId: t.customer.id,
        businessDate: branchToday,
        locationId: t.branch.id,
        lines: [],
      }),
    ],
  },
  // Reports: their branches' sales only (and no business-level line).
  'profit.summary': {
    lists: (t) => ({ ...monthSoFar(t), groupBy: 'product' }),
    check: (mine, owners) => {
      interface Summary {
        data: { groups: unknown[]; businessLevel: boolean; total: { sales: string } }
      }
      expect((owners as Summary).data.groups.length).toBeGreaterThan(0)
      expect((mine as Summary).data.groups).toEqual([])
      expect((mine as Summary).data.businessLevel).toBe(false)
      expect((mine as Summary).data.total.sales).toBe('0')
    },
  },
  'quotation.accept': {
    refused: (t) => [notFound({ id: t.sentQuotation.id, version: t.sentQuotation.version })],
  },
  'quotation.copy': { refused: (t) => [notFound({ id: t.quotation.id, newId: newId() })] },
  'quotation.create': {
    refused: (t) => [
      forbidden({
        id: newId(),
        customerId: t.customer.id,
        businessDate: branchToday,
        locationId: t.branch.id,
        lines: [],
      }),
    ],
  },
  'quotation.decline': {
    refused: (t) => [notFound({ id: t.sentQuotation.id, version: t.sentQuotation.version })],
  },
  'quotation.discard': {
    refused: (t) => [notFound({ id: t.quotation.id, version: t.quotation.version })],
  },
  'quotation.get': { refused: (t) => [notFound({ id: t.quotation.id })] },
  'quotation.history': { refused: (t) => [notFound({ id: t.quotation.id })] },
  'quotation.list': { lists: () => ({}) },
  'quotation.pdf': { refused: (t) => [notFound({ id: t.quotation.id })] },
  'quotation.revise': { refused: (t) => [notFound({ id: t.sentQuotation.id, newId: newId() })] },
  'quotation.send': {
    refused: (t) => [notFound({ id: t.quotation.id, version: t.quotation.version })],
  },
  'quotation.toOrder': {
    refused: (t) => [notFound({ id: t.acceptedQuotation.id, orderId: newId() })],
  },
  'quotation.update': {
    refused: (t) => [
      notFound({
        id: t.quotation.id,
        version: t.quotation.version,
        customerId: t.customer.id,
        businessDate: branchToday,
        lines: [],
      }),
      forbidden({
        ...ownDrafts.quotation,
        customerId: t.customer.id,
        businessDate: branchToday,
        locationId: t.branch.id,
        lines: [],
      }),
    ],
  },
  'receivable.list': { lists: () => ({}) },
  'sale.correct': { refused: (t) => [notFound({ id: t.sale.id, newId: newId() })] },
  'sale.create': {
    refused: (t) => [
      forbidden({
        id: newId(),
        source: 'single',
        businessDate: branchToday,
        locationId: t.branch.id,
        lines: [],
      }),
    ],
  },
  'sale.daySheet': {
    refused: (t) => [
      forbidden({ businessDate: branchToday, channelId: t.channel.id, locationId: t.branch.id }),
    ],
  },
  'sale.discard': { refused: () => [notFound({ ...branchDraft })] },
  'sale.fillDeliveryCost': { refused: (t) => [notFound({ id: t.sale.id, deliveryCost: '1' })] },
  'sale.get': { refused: (t) => [notFound({ id: t.sale.id })] },
  'sale.list': { lists: () => ({}) },
  'sale.post': { refused: () => [notFound({ ...branchDraft })] },
  'sale.refund': {
    refused: (t) => [
      notFound({
        id: newId(),
        saleId: t.sale.id,
        by: 'amount',
        businessDate: branchToday,
        lines: [{ lineId: t.sale.lines[0]!.id, amount: '1' }],
      }),
      notFound({
        id: newId(),
        orderId: t.deliveredOrder.id,
        by: 'amount',
        businessDate: branchToday,
        lines: [{ lineId: t.refund.lines[0]?.refundOfLineId ?? newId(), amount: '1' }],
      }),
    ],
  },
  'sale.reverse': { refused: (t) => [notFound({ id: t.sale.id })] },
  'sale.update': {
    refused: (t) => [
      notFound({
        ...updateFieldsOf({ source: 'single', businessDate: branchToday, lines: [] }),
        ...branchDraft,
      }),
      forbidden({
        ...updateFieldsOf({
          source: 'single',
          businessDate: branchToday,
          locationId: t.branch.id,
          channelId: t.channel.id,
          lines: [],
        }),
        ...ownDrafts.sale,
      }),
    ],
  },
  'saleImport.addRows': {
    refused: (t) => [
      notFound({
        id: t.draftImport.id,
        rows: [
          {
            position: 1,
            businessDate: branchToday,
            name: t.product.name,
            qty: '1',
            amount: '1',
            refunds: '0',
            fileRows: 1,
          },
        ],
      }),
    ],
  },
  'saleImport.create': {
    refused: (t) => [
      forbidden({
        id: newId(),
        channelId: t.channel.id,
        locationId: t.branch.id,
        fileName: 'sales.csv',
        fileHash: randomBytes(32).toString('hex'),
        fingerprint: randomBytes(32).toString('hex'),
        shape: 'summary',
        periodFrom: branchToday,
        periodTo: branchToday,
        mapping: { headerRow: 0, columns: { name: 0, total: 1 }, headers: {}, dateOrder: 'dmy' },
        amountsIncludeVat: false,
        rowsRead: 1,
        rowsLeftOut: 0,
        rowCount: 1,
      }),
    ],
  },
  'saleImport.discard': {
    refused: (t) => [notFound({ id: t.draftImport.id, version: t.draftImport.version })],
  },
  'saleImport.get': { refused: (t) => [notFound({ id: t.saleImport.id })] },
  'saleImport.list': { lists: () => ({}) },
  'saleImport.match': {
    refused: (t) => [
      notFound({
        id: t.draftImport.id,
        answers: [{ name: t.product.name, target: 'product', productId: t.product.id }],
      }),
    ],
  },
  'saleImport.post': {
    refused: (t) => [notFound({ id: t.draftImport.id, version: t.draftImport.version })],
  },
  'saleImport.reverse': { refused: (t) => [notFound({ id: t.saleImport.id })] },
  'saleImport.setOverlap': {
    refused: (t) => [
      notFound({ id: t.draftImport.id, version: t.draftImport.version, overlap: 'skip' }),
    ],
  },
}

function branchLimitOf(path: string): BranchLimit | undefined {
  const wide = WIDE_ROUTERS[path.split('.')[0] ?? '']
  return BRANCH_LIMITS[path] ?? (wide ? { wide } : undefined)
}

/** A member of `b` (an Admin: every key) limited to `locationId`. */
async function limitedTo(b: { id: string; owner: Person }, locationId: string): Promise<Person> {
  const person = await api.newPerson()
  const memberId = await join(api.db, b.owner.user, b.id, person.user, 'admin')
  const scope = ok(await as<{ version: number }>(b.owner, b.id, 'member.locations', { memberId }))
  ok(
    await as(b.owner, b.id, 'member.updateLocations', {
      memberId,
      version: scope.version,
      locationIds: [locationId],
    }),
  )
  return person
}

describe('a member limited to a branch sees and enters only that branch’s sales, orders, quotations, invoices, payments and reports (Q12)', () => {
  let limited: Person
  let before: Record<string, string>

  beforeAll(async () => {
    await allOn()
    branchToday = tenant.sale.businessDate
    const draft = ok(
      await as<{ data: { id: string; version: number } }>(tenant.owner, tenant.id, 'sale.create', {
        id: newId(),
        source: 'single',
        businessDate: branchToday,
        locationId: tenant.branch.id,
        channelId: tenant.channel.id,
        lines: [],
      }),
    ).data
    branchDraft = { id: draft.id, version: draft.version }
    limited = await limitedTo(tenant, tenant.defaultLocationId)
    // Their own drafts at their branch.
    const draftOf = async (path: string, input: object) => {
      const made = ok(
        await as<{ id: string; version: number; data?: { id: string; version: number } }>(
          limited,
          tenant.id,
          path,
          { id: newId(), ...input },
        ),
      )
      const record = made.data ?? made
      return { id: record.id, version: record.version }
    }
    ownDrafts.sale = await draftOf('sale.create', {
      source: 'single',
      businessDate: branchToday,
      channelId: tenant.channel.id,
      lines: [],
    })
    ownDrafts.order = await draftOf('order.create', {
      customerId: tenant.customer.id,
      businessDate: branchToday,
      channelId: tenant.channel.id,
      lines: [],
    })
    ownDrafts.quotation = await draftOf('quotation.create', {
      customerId: tenant.customer.id,
      businessDate: branchToday,
      lines: [],
    })
    ownDrafts.invoice = await draftOf('invoice.create', {
      customerId: tenant.customer.id,
      lines: [],
    })
    before = await tenantDigest(api.admin, tenant)
  }, 120_000)

  it('BRANCH_LIMITS classifies every business procedure; a router business-wide as a whole has no entry of its own', () => {
    const missing = BUSINESS.map((p) => p.path).filter((path) => !branchLimitOf(path))
    expect(missing, 'add the procedure to BRANCH_LIMITS').toEqual([])
    const paths = new Set(BUSINESS.map((p) => p.path))
    expect(Object.keys(BRANCH_LIMITS).filter((path) => !paths.has(path))).toEqual([])
    for (const path of Object.keys(BRANCH_LIMITS)) {
      expect(WIDE_ROUTERS[path.split('.')[0] ?? ''], path).toBeUndefined()
    }
    for (const [path, limit] of Object.entries(BRANCH_LIMITS)) {
      const kinds = [limit.wide, limit.below, limit.refused ?? limit.lists].filter(Boolean)
      expect(kinds.length, `${path}: wide, below, or refused and lists`).toBe(1)
    }
  })

  it('the member works at the default location only; the fixture’s records are at the other branch', async () => {
    const context = ok(await as<BusinessContextDto>(limited, tenant.id, 'business.context'))
    expect(context.locationScope).toEqual({ all: false, ids: [tenant.defaultLocationId] })
    for (const located of [tenant.sale, tenant.order, tenant.quotation, tenant.invoice]) {
      expect(located.locationId).toBe(tenant.branch.id)
    }
  })

  const REFUSED = BUSINESS.filter((p) => BRANCH_LIMITS[p.path]?.refused)
  const LISTS = BUSINESS.filter((p) => BRANCH_LIMITS[p.path]?.lists)

  it.each(REFUSED.map((p) => [p.path, p] as const))(
    '%s: a record of the other branch is NOT_FOUND, entering at it FORBIDDEN',
    async (_path, procedure) => {
      const calls = BRANCH_LIMITS[procedure.path]!.refused!(tenant)
      expect(calls.length).toBeGreaterThan(0)
      for (const { input, code } of calls) {
        const result = await callProcedure(api.handler, procedure, limited.token, {
          businessId: tenant.id,
          input,
        })
        const what = `${procedure.path} ${JSON.stringify(input)}`
        expect(result.error?.data.appCode, `${what}: ${result.raw}`).toBe(code)
        const sent = JSON.stringify(input)
        const shown = branchMarkers(tenant).filter(
          (m) => !sent.includes(m) && result.raw.includes(m),
        )
        expect(shown, what).toEqual([])
        // The control: the same query is served to the owner.
        if (procedure.type === 'query') {
          const owners = await callProcedure(api.handler, procedure, tenant.owner.token, {
            businessId: tenant.id,
            input,
          })
          expect(owners.error, `${what} as the owner: ${owners.raw}`).toBeUndefined()
        }
      }
    },
  )

  it('nothing was written by the refused calls', async () => {
    expect(await tenantDigest(api.admin, tenant)).toEqual(before)
  })

  it.each(LISTS.map((p) => [p.path, p] as const))(
    '%s: served with nothing of the other branch, which the owner’s answer has',
    async (_path, procedure) => {
      const limit = BRANCH_LIMITS[procedure.path]!
      const input = limit.lists!(tenant)
      const call = (person: Person) =>
        callProcedure(api.handler, procedure, person.token, { businessId: tenant.id, input })
      const mine = await call(limited)
      const owners = await call(tenant.owner)
      expect(mine.error, mine.raw).toBeUndefined()
      expect(owners.error, owners.raw).toBeUndefined()
      const markers = branchMarkers(tenant)
      expect(markers.filter((m) => mine.raw.includes(m))).toEqual([])
      if (limit.check) await limit.check(mine.data, owners.data, tenant)
      else expect(markers.filter((m) => owners.raw.includes(m)).length).toBeGreaterThan(0)
    },
  )

  it('deposits without a tax invoice: only the member’s branches’ (a VAT-registered business)', async () => {
    const vat = await business(WORKSHOP)
    const branch = ok(
      await as<LocationDto>(vat.owner, vat.id, 'location.create', {
        id: newId(),
        name: `Marina ${newId()}`,
      }),
    )
    const customer = ok(
      await as<{ id: string }>(vat.owner, vat.id, 'customer.create', { id: newId(), name: 'Noor' }),
    )
    const order = ok(
      await as<{ data: { id: string } }>(vat.owner, vat.id, 'order.create', {
        id: newId(),
        customerId: customer.id,
        businessDate: vat.today,
        locationId: branch.id,
        lines: [
          { kind: 'typed', id: newId(), description: 'Wardrobe', qty: '1', unitPrice: '500' },
        ],
        payment: { id: newId(), method: 'bank_transfer', amount: '100' },
      }),
    ).data
    const person = await limitedTo(vat, vat.defaultLocationId)
    const owners = await as(vat.owner, vat.id, 'invoice.depositsWithoutInvoice')
    expect(owners.error, owners.raw).toBeUndefined()
    expect(owners.raw).toContain(order.id)
    const theirs = await as(person, vat.id, 'invoice.depositsWithoutInvoice')
    expect(theirs.error, theirs.raw).toBeUndefined()
    expect(theirs.raw).not.toContain(order.id)
  })
})

// ---------------------------------------------------------------------------------------------------
// Own records (Q10, D-181, D-214, D-273; M3 Step 10)
// ---------------------------------------------------------------------------------------------------
//
// The Employee (no "see every sale" nor "see every order", no quotations, invoices or payments)
// works only on what they entered. Every call above that names one of the owner's records (the
// fixture's sale, import, orders, quotations, invoices, credit notes, payments and files) is refused
// them, NOT_FOUND or FORBIDDEN, with nothing of it, and nothing written; every list above shows them
// none of it.

describe('the Employee acts on no one else’s sale, order, quotation, invoice, payment or file', () => {
  let before: Record<string, string>

  beforeAll(async () => {
    await allOn()
    before = await tenantDigest(api.admin, tenant)
  })

  const REFUSED = BUSINESS.filter((p) => BRANCH_LIMITS[p.path]?.refused)
  const LISTS = BUSINESS.filter((p) => BRANCH_LIMITS[p.path]?.lists)

  it.each(REFUSED.map((p) => [p.path, p] as const))(
    '%s with the owner’s records: refused, with nothing of them',
    async (_path, procedure) => {
      // Entering at a branch is theirs to do (they are not limited): only the owner's records count.
      const calls = BRANCH_LIMITS[procedure.path]!.refused!(tenant).filter(
        (call) => call.code === 'not_found',
      )
      for (const { input } of calls) {
        const result = await callProcedure(api.handler, procedure, tenant.employee.token, {
          businessId: tenant.id,
          input,
        })
        const what = `${procedure.path} ${JSON.stringify(input)}`
        expect(['not_found', 'forbidden'], `${what}: ${result.raw}`).toContain(
          result.error?.data.appCode,
        )
        const sent = JSON.stringify(input)
        const shown = branchMarkers(tenant).filter(
          (m) => !sent.includes(m) && result.raw.includes(m),
        )
        expect(shown, what).toEqual([])
      }
    },
  )

  it('nothing was written by the refused calls', async () => {
    expect(await tenantDigest(api.admin, tenant)).toEqual(before)
  })

  it.each(LISTS.map((p) => [p.path, p] as const))(
    '%s: nothing of the owner’s records (served or refused)',
    async (_path, procedure) => {
      const input = BRANCH_LIMITS[procedure.path]!.lists!(tenant)
      const result = await callProcedure(api.handler, procedure, tenant.employee.token, {
        businessId: tenant.id,
        input,
      })
      if (result.error) expect(result.error.data.appCode, result.raw).toBe('forbidden')
      expect(branchMarkers(tenant).filter((m) => result.raw.includes(m))).toEqual([])
    },
  )
})

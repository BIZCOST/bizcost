import {
  isWithMeta,
  withMeta,
  type AttachmentUploadUrlDto,
  type BooksDto,
  type CostCategoryDto,
  type ExpenseDto,
  type MaterialDto,
  type ProductCostBreakdownDto,
  type ProductCostSettingsDto,
  type ProductDto,
  type PurchaseDto,
  type PurchaseReturnDto,
  type RunningCostDto,
  type SupplierDto,
} from '@bizcost/contracts'
import { newId, SENSITIVITY_CATEGORIES, type SensitivityCategory } from '@bizcost/domain'
import {
  ROLE_TEMPLATE_KEYS,
  roleTemplateByKey,
  type PermissionKey,
  type RoleTemplateKey,
} from '@bizcost/modules'
import type { AnyRouter } from '@trpc/server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { appRouter, businessProcedure, router } from '../../src'
import { sensitivePaths, type SensitivePath } from '../../src/redact'
import { item, itemDto, VALUES_OF, VISIBLE_TO } from '../oracle'
import { join, setupBusiness, WORKSHOP } from '../settings'
import {
  callProcedure,
  openApi,
  PNG,
  proceduresOf,
  uploadTo,
  type Api,
  type Person,
} from './fixture'

// Redaction oracle over EVERY procedure whose output has sensitivity tags (ROADMAP.md Step 9; M1
// definition of done: "the Employee (staff) role template receives no field tagged sensitive"). The
// router is walked: each procedure with sensitive() fields in its output must have an entry in
// ORACLE, and is called by a member holding each of the 7 role templates as Smart Setup copied them
// into a real business. What each template may see is the hand-written VISIBLE_TO (test/oracle.ts):
// `meta.redacted` must list exactly the paths of the hidden categories, and the response must carry
// a category's values exactly when the template may see it. A template without the procedure's
// permission gets FORBIDDEN, with none of the values.
//
// M2 Step 3 brings the first production procedures with sensitive fields: the material cost view
// (average cost: `cost`; last purchase price: `supplier_price`), purchases, supplier returns and
// credit notes (what was paid to a supplier: `supplier_price`) and their receipts (the download URL:
// `supplier_price`). Their values are distinctive numbers of the fixture below. The test procedure
// `test.item` (a value in every category, nested in objects and arrays) stays. The first test fails
// the day a production procedure gets a sensitive field without an ORACLE entry, and the day an
// ORACLE entry no longer has one.

interface OracleEntry {
  /** The permission the procedure needs; templates without it get FORBIDDEN (none: every member). */
  permission?: PermissionKey
  /**
   * Input of the call, or a function preparing a fresh one for each call (as the owner, or as the
   * member of `template` where only one's own record may be changed, D-184).
   */
  input?: unknown
  prepare?: (template: RoleTemplateKey) => Promise<unknown>
  /** The values the call returns in each category (each must be in the answer when visible). */
  valuesOf: Partial<Record<SensitivityCategory, readonly string[]>>
}

// The fixture's numbers: two purchases of a material (3 L at 41.17, then 1 L at 52.39) and a credit
// note of 7.77 on the first, so its 90-day average is (123.51 − 7.77 + 52.39) ÷ 4 = 42.0325 a litre
// (`cost`; material.costs runs first, before the cases below post more) and its last price 52.39
// (`supplier_price`); credit notes of 7.77; receipts' signed URLs.
const UNIT_PRICE = '41.17'
const LINE_TOTAL = '123.51'
const LAST_PRICE = '52.39'
const AVERAGE = '42.0325'
const CREDIT = '7.77'
const SIGNED_URL = '/object/sign/'
// Recipes (M2 Step 4): beans bought once, 1 kg at 57.13 (no other case buys them), so 18 g cost
// 18 × 57.13 ÷ 1 000 = 1.02834 and a gram 0.05713 (`cost`), whatever the purchase cases post.
const BEANS_PRICE = '57.13'
const RECIPE_COST = '1.02834'
const PER_GRAM = '0.05713'
// What is owed (the owner's requests of 2026-09-29): cream bought on credit, 2 L at 45.67 = 91.34,
// with a payment of 3.21, so 88.13 is still owed. Each payment case buys its own.
const CREAM_PRICE = '45.67'
const OWED_TOTAL = '91.34'
const PAID = '3.21'
const OWED_LEFT = '88.13'
// Expenses (M2 Step 5): 63.47 before VAT at 5 % is 3.17 of VAT, 66.64 in all (`supplier_price`);
// one bought on credit has a payment of 4.32, so 62.32 is still owed. A running cost of 7 321.09 a
// week is 31 724.723333333333 a month (`cost`).
const EXPENSE_NET = '63.47'
const EXPENSE_TOTAL = '66.64'
const EXPENSE_PAID = '4.32'
const EXPENSE_LEFT = '62.32'
const RUNNING = '7321.09'
const RUNNING_MONTHLY = '31724.723333333333'
const EXPENSE = { supplier_price: [EXPENSE_NET, EXPENSE_TOTAL] }
// A member's own records (D-181): each non-owner member paid one expense from their own money, with
// an amount only they may read through the procedures of their own records.
const OWN_AMOUNT: Record<Exclude<RoleTemplateKey, 'owner'>, string> = {
  admin: '71.13',
  manager: '72.23',
  accountant: '73.33',
  sales: '74.43',
  supervisor: '75.53',
  employee: '76.63',
}
/** An expense of the owner's that members who may correct it correct (D-184): never theirs to read. */
const CORRECTED_AMOUNT = '97.19'
/**
 * The amounts of the owner's purchases and expenses that cannot be read inside a timestamp (more
 * than 59, so never "…:41.17…" seconds): expense.getMine returns timestamps.
 */
const OWNERS_AMOUNTS = [LINE_TOTAL, OWED_TOTAL, OWED_LEFT, EXPENSE_NET, EXPENSE_TOTAL, EXPENSE_LEFT]

let api: Api
let businessId: string
const members = new Map<RoleTemplateKey, Person>()
const memberIds = new Map<Exclude<RoleTemplateKey, 'owner'>, string>()
let material: MaterialDto
let supplier: SupplierDto
let purchase: PurchaseDto
let credit: PurchaseReturnDto
let today: string
let beans: MaterialDto
let latte: ProductDto
let cream: MaterialDto
let owed: PurchaseDto
let category: CostCategoryDto
let spent: ExpenseDto
let owedExpense: ExpenseDto
let running: RunningCostDto
const ownExpenses = new Map<RoleTemplateKey, string>()
let costed: ProductDto

// Product costs (M2 Step 6): a product of 18 g of the beans (1.02834 of materials) sold at 99.99,
// with the owner's estimate of 48 271.37 of purchases a month (`supplier_price`). Its running-cost
// share, total and margin move as the running-cost cases below add running costs, so the values
// are what the owner reads just before each call.
const PRODUCT_PRICE = '99.99'
const ESTIMATE = '48271.37'
const costedValues = {
  cost: [] as string[],
  profit_margin: [] as string[],
  supplier_price: [ESTIMATE],
}
const settingsValues = { cost: [] as string[], supplier_price: [ESTIMATE] }

/** Reads the costed product's numbers as the owner (costedValues); its search input for the list. */
async function readCosted() {
  const { data } = await asOwner<ProductCostBreakdownDto>('productCost.get', 'query', {
    productId: costed.id,
  })
  expect(data.cost.complete, JSON.stringify(data.cost)).toBe(true)
  costedValues.cost = [data.cost.materials!, data.cost.total!, data.cost.runningCosts.share!]
  costedValues.profit_margin = [data.margin.amount!, data.margin.percent!]
  return { productId: costed.id, search: costed.name }
}

/** Reads the settings as the owner (settingsValues): the monthly running costs and the rate. */
async function readSettings() {
  const { data } = await asOwner<ProductCostSettingsDto>('productCost.settings', 'query')
  expect(data.rate.state).toBe('ready')
  settingsValues.cost = [data.rate.monthlyRunningCosts!, data.rate.rate!]
}

/** Calls a procedure as the owner (fixture set-up). */
async function asOwner<T>(path: string, type: 'query' | 'mutation', input?: unknown): Promise<T> {
  const owner = members.get('owner')!
  const result = await callProcedure<T>(api.handler, { path, type }, owner.token, {
    businessId,
    input,
  })
  expect(result.error, `${path}: ${result.raw}`).toBeUndefined()
  return result.data as T
}

function draftInput() {
  return {
    id: newId(),
    supplierId: supplier.id,
    businessDate: today,
    documentType: 'no_invoice',
    paymentMethod: 'cash',
    lines: [
      {
        kind: 'material',
        id: newId(),
        materialId: material.id,
        qty: '3',
        unit: 'l',
        unitPrice: UNIT_PRICE,
      },
    ],
  }
}

async function newDraft(): Promise<PurchaseDto> {
  return (await asOwner<{ data: PurchaseDto }>('purchase.create', 'mutation', draftInput())).data
}

async function newPosted(): Promise<PurchaseDto> {
  const draft = await newDraft()
  return (
    await asOwner<{ data: PurchaseDto }>('purchase.post', 'mutation', {
      id: draft.id,
      version: draft.version,
    })
  ).data
}

function creditInput() {
  return {
    id: newId(),
    purchaseId: purchase.id,
    kind: 'credit_note',
    businessDate: today,
    lines: [{ id: newId(), purchaseLineId: purchase.lines[0]?.id, amount: CREDIT }],
  }
}

async function newCredit(): Promise<PurchaseReturnDto> {
  return (
    await asOwner<{ data: PurchaseReturnDto }>('purchaseReturn.create', 'mutation', creditInput())
  ).data
}

/** A posted purchase of cream bought on credit (nothing paid yet). */
async function newOwed(): Promise<PurchaseDto> {
  const draft = (
    await asOwner<{ data: PurchaseDto }>('purchase.create', 'mutation', {
      ...draftInput(),
      paymentMethod: 'supplier_credit',
      lines: [
        {
          kind: 'material',
          id: newId(),
          materialId: cream.id,
          qty: '2',
          unit: 'l',
          unitPrice: CREAM_PRICE,
        },
      ],
    })
  ).data
  return (
    await asOwner<{ data: PurchaseDto }>('purchase.post', 'mutation', {
      id: draft.id,
      version: draft.version,
    })
  ).data
}

function paymentInput(purchaseId: string) {
  return { id: newId(), purchaseId, businessDate: today, method: 'cash', amount: PAID }
}

async function uploaded(): Promise<string> {
  const upload = await asOwner<AttachmentUploadUrlDto>('attachment.uploadUrl', 'mutation', {
    entity: 'purchase',
    entityId: purchase.id,
    contentType: 'image/png',
  })
  expect((await uploadTo(upload.uploadUrl, PNG, 'image/png')).ok).toBe(true)
  return upload.path
}

const PRICE = { supplier_price: [UNIT_PRICE, LINE_TOTAL] }

/** A product with the beans' recipe input (18 g), made for a recipe.save call. */
async function newRecipeInput() {
  const product = await asOwner<ProductDto>('product.create', 'mutation', {
    id: newId(),
    name: `Oracle latte ${newId().slice(-8)}`,
    type: 'product',
    unit: 'piece',
  })
  return {
    productId: product.id,
    version: 0,
    lines: [{ id: newId(), materialId: beans.id, qty: '18', unit: 'g' }],
  }
}

function expenseInput(extra: object = {}) {
  return {
    id: newId(),
    categoryId: category.id,
    businessDate: today,
    documentType: 'tax_invoice',
    paymentMethod: 'cash',
    amount: EXPENSE_NET,
    vatRate: '5',
    ...extra,
  }
}

async function newExpenseDraft(extra: object = {}): Promise<ExpenseDto> {
  return (await asOwner<{ data: ExpenseDto }>('expense.create', 'mutation', expenseInput(extra)))
    .data
}

/**
 * A draft the member of `template` entered themselves when they may enter expenses (a member who may
 * not see supplier prices changes only their own, D-184), else the owner's.
 */
async function newOwnExpenseDraft(
  template: RoleTemplateKey,
): Promise<{ id: string; version: number }> {
  if (template === 'owner' || !holds(template, 'expenses.documents.manage')) {
    return newExpenseDraft()
  }
  const result = await callProcedure<{ data: ExpenseDto }>(
    api.handler,
    { path: 'expense.create', type: 'mutation' },
    members.get(template)!.token,
    { businessId, input: expenseInput() },
  )
  expect(result.error, result.raw).toBeUndefined()
  // A member who may not see supplier prices gets it back without its amounts: its id and version.
  return { id: result.data!.data.id, version: result.data!.data.version }
}

async function newExpensePosted(extra: object = {}): Promise<ExpenseDto> {
  const draft = await newExpenseDraft(extra)
  return (
    await asOwner<{ data: ExpenseDto }>('expense.post', 'mutation', {
      id: draft.id,
      version: draft.version,
    })
  ).data
}

async function newExpenseSubmitted(): Promise<ExpenseDto> {
  const draft = await newExpenseDraft()
  return (
    await asOwner<{ data: ExpenseDto }>('expense.submit', 'mutation', {
      id: draft.id,
      version: draft.version,
    })
  ).data
}

/** A posted expense bought on credit from the supplier (nothing paid yet). */
function newOwedExpense(): Promise<ExpenseDto> {
  return newExpensePosted({ supplierId: supplier.id, paymentMethod: 'supplier_credit' })
}

function expensePaymentInput(expenseId: string) {
  return { id: newId(), expenseId, businessDate: today, method: 'cash', amount: EXPENSE_PAID }
}

function runningInput(extra: object = {}) {
  return {
    id: newId(),
    name: 'Oracle rent',
    categoryId: category.id,
    amount: RUNNING,
    frequency: 'weekly',
    startsOn: today,
    ...extra,
  }
}

/** Production procedures with sensitive output (M2 Step 3). */
const PRODUCTION_ORACLE: Record<string, OracleEntry> = {
  'material.costs': {
    permission: 'materials.items.view',
    prepare: () => Promise.resolve({ ids: [material.id] }),
    valuesOf: { cost: [AVERAGE], supplier_price: [LAST_PRICE] },
  },
  'purchase.list': {
    permission: 'purchases.documents.view',
    valuesOf: { supplier_price: [LINE_TOTAL] },
  },
  'purchase.get': {
    permission: 'purchases.documents.view',
    prepare: () => Promise.resolve({ id: purchase.id }),
    valuesOf: PRICE,
  },
  'purchase.create': {
    permission: 'purchases.documents.manage',
    prepare: () => Promise.resolve(draftInput()),
    valuesOf: PRICE,
  },
  'purchase.update': {
    permission: 'purchases.documents.manage',
    prepare: async () => {
      const draft = await newDraft()
      return { ...draftInput(), id: draft.id, version: draft.version }
    },
    valuesOf: PRICE,
  },
  'purchase.post': {
    permission: 'purchases.documents.post',
    prepare: async () => {
      const draft = await newDraft()
      return { id: draft.id, version: draft.version }
    },
    valuesOf: PRICE,
  },
  'purchase.reverse': {
    permission: 'purchases.documents.reverse',
    prepare: async () => ({ id: (await newPosted()).id }),
    valuesOf: PRICE,
  },
  'purchase.correct': {
    permission: 'purchases.documents.reverse',
    prepare: async () => ({ id: (await newPosted()).id, newId: newId() }),
    valuesOf: PRICE,
  },
  'purchaseReturn.list': {
    permission: 'purchases.documents.view',
    prepare: () => Promise.resolve({ purchaseId: purchase.id }),
    valuesOf: { supplier_price: [CREDIT] },
  },
  'purchaseReturn.get': {
    permission: 'purchases.documents.view',
    prepare: () => Promise.resolve({ id: credit.id }),
    valuesOf: { supplier_price: [CREDIT] },
  },
  'purchaseReturn.create': {
    permission: 'purchases.documents.manage',
    prepare: () => Promise.resolve(creditInput()),
    valuesOf: { supplier_price: [CREDIT] },
  },
  'purchaseReturn.update': {
    permission: 'purchases.documents.manage',
    prepare: async () => {
      const draft = await newCredit()
      const { lines, businessDate } = creditInput()
      return { id: draft.id, version: draft.version, businessDate, lines }
    },
    valuesOf: { supplier_price: [CREDIT] },
  },
  'purchaseReturn.post': {
    permission: 'purchases.documents.post',
    prepare: async () => {
      const draft = await newCredit()
      return { id: draft.id, version: draft.version }
    },
    valuesOf: { supplier_price: [CREDIT] },
  },
  'purchaseReturn.reverse': {
    permission: 'purchases.documents.reverse',
    prepare: async () => {
      const draft = await newCredit()
      await asOwner('purchaseReturn.post', 'mutation', { id: draft.id, version: draft.version })
      return { id: draft.id }
    },
    valuesOf: { supplier_price: [CREDIT] },
  },
  'attachment.list': {
    permission: 'purchases.documents.view',
    prepare: () => Promise.resolve({ entity: 'purchase', entityId: purchase.id }),
    valuesOf: { supplier_price: [SIGNED_URL] },
  },
  'recipe.get': {
    permission: 'products.recipes.view',
    prepare: () => Promise.resolve({ productId: latte.id }),
    valuesOf: { cost: [RECIPE_COST, PER_GRAM] },
  },
  'recipe.save': {
    permission: 'products.recipes.manage',
    prepare: newRecipeInput,
    valuesOf: { cost: [RECIPE_COST, PER_GRAM] },
  },
  'product.costs': {
    permission: 'products.recipes.view',
    prepare: () => Promise.resolve({ ids: [latte.id] }),
    valuesOf: { cost: [RECIPE_COST] },
  },
  'productCost.list': {
    permission: 'cost_engine.product_costs.view',
    prepare: async () => ({ search: (await readCosted()).search }),
    valuesOf: costedValues,
  },
  'productCost.get': {
    permission: 'cost_engine.product_costs.view',
    prepare: async () => ({ productId: (await readCosted()).productId }),
    valuesOf: costedValues,
  },
  'productCost.settings': {
    permission: 'cost_engine.settings.manage',
    prepare: async () => {
      await readSettings()
      return undefined
    },
    valuesOf: settingsValues,
  },
  'productCost.updateSettings': {
    permission: 'cost_engine.settings.manage',
    prepare: async () => {
      await readSettings()
      return { estimatedMonthlyPurchases: ESTIMATE }
    },
    valuesOf: settingsValues,
  },
  'payable.list': {
    permission: 'purchases.payments.view',
    input: { party: 'supplier' },
    valuesOf: { supplier_price: [OWED_TOTAL, OWED_LEFT] },
  },
  'purchasePayment.list': {
    permission: 'purchases.payments.view',
    prepare: () => Promise.resolve({ purchaseId: owed.id }),
    valuesOf: { supplier_price: [OWED_TOTAL, PAID, OWED_LEFT] },
  },
  'purchasePayment.record': {
    permission: 'purchases.payments.record',
    prepare: async () => paymentInput((await newOwed()).id),
    valuesOf: { supplier_price: [OWED_TOTAL, PAID, OWED_LEFT] },
  },
  'purchasePayment.reverse': {
    permission: 'purchases.payments.record',
    prepare: async () => {
      const input = paymentInput((await newOwed()).id)
      await asOwner('purchasePayment.record', 'mutation', input)
      return { id: input.id }
    },
    valuesOf: { supplier_price: [OWED_TOTAL, PAID] },
  },
  'expense.list': {
    permission: 'expenses.documents.view',
    valuesOf: { supplier_price: [EXPENSE_TOTAL] },
  },
  'expense.get': {
    permission: 'expenses.documents.view',
    prepare: () => Promise.resolve({ id: spent.id }),
    valuesOf: EXPENSE,
  },
  'expense.create': {
    permission: 'expenses.documents.manage',
    prepare: () => Promise.resolve(expenseInput()),
    valuesOf: EXPENSE,
  },
  'expense.update': {
    permission: 'expenses.documents.manage',
    prepare: async (template) => {
      const draft = await newOwnExpenseDraft(template)
      return { ...expenseInput(), id: draft.id, version: draft.version }
    },
    valuesOf: EXPENSE,
  },
  'expense.submit': {
    permission: 'expenses.documents.manage',
    prepare: async (template) => {
      const draft = await newOwnExpenseDraft(template)
      return { id: draft.id, version: draft.version }
    },
    valuesOf: EXPENSE,
  },
  'expense.approve': {
    permission: 'expenses.documents.approve',
    prepare: async () => {
      const sent = await newExpenseSubmitted()
      return { id: sent.id, version: sent.version }
    },
    valuesOf: EXPENSE,
  },
  'expense.reject': {
    permission: 'expenses.documents.approve',
    prepare: async () => {
      const sent = await newExpenseSubmitted()
      return { id: sent.id, version: sent.version, reason: 'Not ours' }
    },
    valuesOf: EXPENSE,
  },
  'expense.post': {
    permission: 'expenses.documents.post',
    prepare: async () => {
      const draft = await newExpenseDraft()
      return { id: draft.id, version: draft.version }
    },
    valuesOf: EXPENSE,
  },
  'expense.reverse': {
    permission: 'expenses.documents.reverse',
    prepare: async () => ({ id: (await newExpensePosted()).id }),
    valuesOf: EXPENSE,
  },
  'expense.correct': {
    permission: 'expenses.documents.reverse',
    prepare: async () => ({ id: (await newExpensePosted()).id, newId: newId() }),
    valuesOf: EXPENSE,
  },
  'expensePayment.list': {
    permission: 'expenses.payments.view',
    prepare: () => Promise.resolve({ expenseId: owedExpense.id }),
    valuesOf: { supplier_price: [EXPENSE_TOTAL, EXPENSE_PAID, EXPENSE_LEFT] },
  },
  'expensePayment.record': {
    permission: 'expenses.payments.record',
    prepare: async () => expensePaymentInput((await newOwedExpense()).id),
    valuesOf: { supplier_price: [EXPENSE_TOTAL, EXPENSE_PAID, EXPENSE_LEFT] },
  },
  'expensePayment.reverse': {
    permission: 'expenses.payments.record',
    prepare: async () => {
      const input = expensePaymentInput((await newOwedExpense()).id)
      await asOwner('expensePayment.record', 'mutation', input)
      return { id: input.id }
    },
    valuesOf: { supplier_price: [EXPENSE_TOTAL, EXPENSE_PAID] },
  },
  'runningCost.list': {
    permission: 'running_costs.items.view',
    valuesOf: { cost: [RUNNING, RUNNING_MONTHLY] },
  },
  'runningCost.get': {
    permission: 'running_costs.items.view',
    prepare: () => Promise.resolve({ id: running.id }),
    valuesOf: { cost: [RUNNING, RUNNING_MONTHLY] },
  },
  'runningCost.create': {
    permission: 'running_costs.items.manage',
    prepare: () => Promise.resolve(runningInput()),
    valuesOf: { cost: [RUNNING, RUNNING_MONTHLY] },
  },
  'runningCost.update': {
    permission: 'running_costs.items.manage',
    prepare: async () => {
      const created = (
        await asOwner<{ data: RunningCostDto }>('runningCost.create', 'mutation', runningInput())
      ).data
      return { ...runningInput(), id: created.id, version: created.version }
    },
    valuesOf: { cost: [RUNNING, RUNNING_MONTHLY] },
  },
  'attachment.add': {
    permission: 'purchases.documents.manage',
    prepare: async () => ({
      entity: 'purchase',
      entityId: purchase.id,
      path: await uploaded(),
      fileName: 'receipt.png',
    }),
    valuesOf: { supplier_price: [SIGNED_URL] },
  },
}

/** The Step 2 test procedure, served beside appRouter (never part of it). */
const TEST_ORACLE: Record<string, OracleEntry> = {
  'test.item': { valuesOf: VALUES_OF },
}

const oracleRouter = router({
  ...appRouter._def.record,
  test: router({
    item: businessProcedure
      .output(withMeta(itemDto))
      .query(() => ({ data: item, meta: { redacted: [] } })),
  }),
})

/** Sensitive paths of every procedure of `r` that has any (paths relative to the envelope's data). */
function sensitiveProcedures(r: AnyRouter): Map<string, readonly SensitivePath[]> {
  const found = new Map<string, readonly SensitivePath[]>()
  for (const [path, procedure] of Object.entries(
    r._def.procedures as Record<string, { _def: { output?: unknown } }>,
  )) {
    const output = procedure._def.output as z.core.$ZodType
    const data = isWithMeta(output) ? (output as z.ZodObject).shape.data : output
    const paths = sensitivePaths(data as z.core.$ZodType)
    if (paths.length > 0) found.set(path, paths)
  }
  return found
}

/** Whether a member of the template holds the permission (the owner holds every one). */
function holds(template: RoleTemplateKey, permission: PermissionKey | undefined): boolean {
  const t = roleTemplateByKey(template)
  if (!t) throw new Error(`no template ${template}`)
  return permission === undefined || t.allPermissions || t.permissionKeys.includes(permission)
}

describe('the oracle covers every procedure with sensitive output', () => {
  it('production: exactly the procedures in PRODUCTION_ORACLE have sensitive fields', () => {
    expect(
      [...sensitiveProcedures(appRouter).keys()].sort(),
      'a procedure outputs sensitive() fields: add it to PRODUCTION_ORACLE with its values',
    ).toEqual(Object.keys(PRODUCTION_ORACLE).sort())
  })

  it('the oracle router: every sensitive procedure has an entry, and every category a value', () => {
    const sensitive = sensitiveProcedures(oracleRouter)
    expect([...sensitive.keys()].sort()).toEqual(
      Object.keys({ ...PRODUCTION_ORACLE, ...TEST_ORACLE }).sort(),
    )
    // test.item holds every category, so every template's view is checked.
    expect(new Set(sensitive.get('test.item')?.map((p) => p.category))).toEqual(
      new Set(SENSITIVITY_CATEGORIES),
    )
    // Each entry names values for exactly the categories its procedure outputs.
    for (const [path, entry] of Object.entries(PRODUCTION_ORACLE)) {
      expect(Object.keys(entry.valuesOf).sort(), path).toEqual(
        [...new Set(sensitive.get(path)?.map((p) => p.category))].sort(),
      )
    }
  })
})

beforeAll(async () => {
  api = openApi(oracleRouter)
  const owner = await api.newPerson()
  businessId = await setupBusiness(api.handler, owner.token, WORKSHOP, { name: 'Oracle Workshop' })
  members.set('owner', owner)
  for (const template of ROLE_TEMPLATE_KEYS.filter((key) => key !== 'owner')) {
    const person = await api.newPerson()
    // The business's own template role, as Smart Setup copied it (an accepted invitation's way).
    memberIds.set(template, await join(api.db, owner.user, businessId, person.user, template))
    members.set(template, person)
  }
  today = (await asOwner<BooksDto>('books.get', 'query')).today
  material = await asOwner<MaterialDto>('material.create', 'mutation', {
    id: newId(),
    name: 'Oracle milk',
    unit: 'l',
  })
  supplier = await asOwner<SupplierDto>('supplier.create', 'mutation', {
    id: newId(),
    name: 'Oracle dairy',
  })
  purchase = await newPosted()
  const second = (
    await asOwner<{ data: PurchaseDto }>('purchase.create', 'mutation', {
      ...draftInput(),
      lines: [
        {
          kind: 'material',
          id: newId(),
          materialId: material.id,
          qty: '1',
          unit: 'l',
          unitPrice: LAST_PRICE,
        },
      ],
    })
  ).data
  await asOwner('purchase.post', 'mutation', { id: second.id, version: second.version })
  const draft = await newCredit()
  credit = (
    await asOwner<{ data: PurchaseReturnDto }>('purchaseReturn.post', 'mutation', {
      id: draft.id,
      version: draft.version,
    })
  ).data
  await asOwner('attachment.add', 'mutation', {
    entity: 'purchase',
    entityId: purchase.id,
    path: await uploaded(),
    fileName: 'receipt.png',
  })
  beans = await asOwner<MaterialDto>('material.create', 'mutation', {
    id: newId(),
    name: 'Oracle beans',
    unit: 'kg',
  })
  const beansBought = (
    await asOwner<{ data: PurchaseDto }>('purchase.create', 'mutation', {
      ...draftInput(),
      lines: [
        {
          kind: 'material',
          id: newId(),
          materialId: beans.id,
          qty: '1',
          unit: 'kg',
          unitPrice: BEANS_PRICE,
        },
      ],
    })
  ).data
  await asOwner('purchase.post', 'mutation', { id: beansBought.id, version: beansBought.version })
  const recipe = await newRecipeInput()
  await asOwner('recipe.save', 'mutation', recipe)
  latte = await asOwner<ProductDto>('product.get', 'query', { id: recipe.productId })
  costed = await asOwner<ProductDto>('product.create', 'mutation', {
    id: newId(),
    name: `Oracle costed ${newId().slice(-8)}`,
    type: 'product',
    unit: 'piece',
    defaultPrice: PRODUCT_PRICE,
  })
  await asOwner('recipe.save', 'mutation', {
    ...recipe,
    productId: costed.id,
    lines: [{ ...recipe.lines[0], id: newId() }],
  })
  await asOwner('productCost.updateSettings', 'mutation', { estimatedMonthlyPurchases: ESTIMATE })
  cream = await asOwner<MaterialDto>('material.create', 'mutation', {
    id: newId(),
    name: 'Oracle cream',
    unit: 'l',
  })
  owed = await newOwed()
  await asOwner('purchasePayment.record', 'mutation', paymentInput(owed.id))
  // Expenses need approval here, so a submitted expense can be approved or rejected.
  await asOwner('expense.updateSettings', 'mutation', { approval: true })
  category = await asOwner<CostCategoryDto>('costCategory.create', 'mutation', {
    id: newId(),
    name: 'Oracle cleaning',
  })
  spent = await newExpensePosted()
  owedExpense = await newOwedExpense()
  await asOwner('expensePayment.record', 'mutation', expensePaymentInput(owedExpense.id))
  running = (
    await asOwner<{ data: RunningCostDto }>('runningCost.create', 'mutation', runningInput())
  ).data
  // Each member's own record (D-181): an expense the owner entered, paid by the member from their own
  // money, final and owed to them, with an amount no one else has.
  for (const [template, memberId] of memberIds) {
    const own = await newExpensePosted({
      amount: OWN_AMOUNT[template],
      vatRate: '0',
      paymentMethod: 'paid_by_member',
      paidByMemberId: memberId,
    })
    ownExpenses.set(template, own.id)
  }
}, 90_000)

afterAll(async () => {
  await api.close()
})

// ---------------------------------------------------------------------------------------------------
// A member's own records (the owner's answers of 2026-09-29, A4; D-181)
// ---------------------------------------------------------------------------------------------------
//
// Procedures that return the caller's OWN amounts without sensitivity tags (their outputs are not
// redacted, so the oracle above does not see them): "My expenses" (expense.mine, expense.getMine)
// and "Owed to me" (payable.mine). Each is held to "your own amounts only": called by a member holding
// each template, the answer carries that member's own amount (when the template may use the
// procedure; FORBIDDEN otherwise, with nothing) and never another member's, nor any amount of the
// owner's purchases and expenses. A new procedure named like them (`.mine`, `.getMine`) fails the
// first test until it is classified here.

interface OwnEntry {
  /** The permission the procedure needs; templates without it get FORBIDDEN (none: every member). */
  permission?: PermissionKey
  /** The input for a member (their own record's id where it takes one). */
  input: (template: RoleTemplateKey) => unknown
}

const OWN_ORACLE: Record<string, OwnEntry> = {
  'expense.mine': { permission: 'expenses.documents.view', input: () => ({ limit: 100 }) },
  'expense.getMine': {
    permission: 'expenses.documents.view',
    input: (template) => ({ id: ownExpenses.get(template) ?? spent.id }),
  },
  'payable.mine': { input: () => ({ limit: 100 }) },
}

/**
 * The amounts that are not `template`'s own: the owner's and every other member's. The owner entered
 * every record of the fixture, so they are all the owner's own (and the owner sees every amount).
 * These cases run before the oracle above, whose calls add records of the members' own.
 */
function othersAmounts(template: RoleTemplateKey): string[] {
  if (template === 'owner') return []
  const members = Object.entries(OWN_AMOUNT)
    .filter(([key]) => key !== template)
    .map(([, amount]) => amount)
  return [...members, ...OWNERS_AMOUNTS]
}

describe('the procedures of a member’s own records return only their own amounts (D-181)', () => {
  it('every procedure of own records is classified, and none outputs a sensitive() field', () => {
    const own = Object.keys(appRouter._def.procedures).filter((path) =>
      /\.(?:mine|getMine)$/.test(path),
    )
    expect(own.sort(), 'a procedure of own records: add it to OWN_ORACLE').toEqual(
      Object.keys(OWN_ORACLE).sort(),
    )
    const sensitive = sensitiveProcedures(appRouter)
    for (const path of own) expect(sensitive.has(path), path).toBe(false)
  })

  const OWN_CASES = Object.keys(OWN_ORACLE).flatMap((path) =>
    ROLE_TEMPLATE_KEYS.map((template) => [path, template] as const),
  )

  it.each(OWN_CASES)('%s as %s: their own amount, never anyone else’s', async (path, template) => {
    const entry = OWN_ORACLE[path]
    const person = members.get(template)
    const procedure = proceduresOf(oracleRouter).find((p) => p.path === path)
    if (!entry || !person || !procedure) throw new Error(`no fixture for ${path} as ${template}`)
    const result = await callProcedure(api.handler, procedure, person.token, {
      businessId,
      input: entry.input(template),
    })
    for (const value of othersAmounts(template)) {
      expect(result.raw.includes(value), `someone else’s ${value}`).toBe(false)
    }
    if (!holds(template, entry.permission)) {
      expect(result.error?.data.appCode, result.raw).toBe('forbidden')
      return
    }
    expect(result.error, result.raw).toBeUndefined()
    if (template !== 'owner') {
      expect(result.raw.includes(OWN_AMOUNT[template]), 'their own amount').toBe(true)
    }
  })

  it('a copy made by correcting the owner’s expense is not the corrector’s own (D-184)', async () => {
    let corrections = 0
    for (const template of ROLE_TEMPLATE_KEYS.filter((key) => key !== 'owner')) {
      const person = members.get(template)!
      const original = await newExpensePosted({ amount: CORRECTED_AMOUNT, vatRate: '0' })
      const copyId = newId()
      const corrected = await callProcedure(
        api.handler,
        { path: 'expense.correct', type: 'mutation' },
        person.token,
        { businessId, input: { id: original.id, newId: copyId } },
      )
      if (!holds(template, 'expenses.documents.reverse')) {
        expect(corrected.error?.data.appCode, corrected.raw).toBe('forbidden')
        continue
      }
      // A member who may correct sees supplier prices (the API refuses the others, D-184).
      expect(corrected.error, corrected.raw).toBeUndefined()
      corrections += 1
      const one = await callProcedure(
        api.handler,
        { path: 'expense.getMine', type: 'query' },
        person.token,
        { businessId, input: { id: copyId } },
      )
      expect(one.error?.data.appCode, `${template}: ${one.raw}`).toBe('not_found')
      expect(one.raw.includes(CORRECTED_AMOUNT), `${template}: ${one.raw}`).toBe(false)
      const list = await callProcedure(
        api.handler,
        { path: 'expense.mine', type: 'query' },
        person.token,
        { businessId, input: { limit: 100 } },
      )
      expect(list.error, list.raw).toBeUndefined()
      expect(list.raw.includes(copyId), `${template}: ${list.raw}`).toBe(false)
      expect(list.raw.includes(CORRECTED_AMOUNT), `${template}: ${list.raw}`).toBe(false)
    }
    // Admin and Manager corrected one each.
    expect(corrections).toBe(2)
  })

  it('expense.getMine of anyone else’s expense is NOT_FOUND, with nothing of it', async () => {
    for (const template of ROLE_TEMPLATE_KEYS.filter((key) => key !== 'owner')) {
      const person = members.get(template)!
      const others = [
        spent.id,
        ...[...ownExpenses].filter(([key]) => key !== template).map(([, id]) => id),
      ]
      for (const id of others) {
        const result = await callProcedure(
          api.handler,
          { path: 'expense.getMine', type: 'query' },
          person.token,
          { businessId, input: { id } },
        )
        expect(['not_found', 'forbidden'], `${template}: ${result.raw}`).toContain(
          result.error?.data.appCode,
        )
        for (const value of othersAmounts(template)) {
          expect(result.raw.includes(value), `${template} ${value}`).toBe(false)
        }
      }
    }
  })
})

const ORACLE = { ...PRODUCTION_ORACLE, ...TEST_ORACLE }
const CASES = Object.keys(ORACLE).flatMap((path) =>
  ROLE_TEMPLATE_KEYS.map((template) => [path, template] as const),
)

describe('each role template receives exactly the categories it may see', () => {
  it.each(CASES)('%s as %s', async (path, template) => {
    const entry = ORACLE[path]
    const person = members.get(template)
    const paths = sensitiveProcedures(oracleRouter).get(path) ?? []
    const procedure = proceduresOf(oracleRouter).find((p) => p.path === path)
    if (!entry || !person || !procedure) throw new Error(`no fixture for ${path} as ${template}`)
    const visible = new Set(VISIBLE_TO[template])
    const input = entry.prepare ? await entry.prepare(template) : entry.input

    const result = await callProcedure<{ meta: { redacted: string[] } }>(
      api.handler,
      procedure,
      person.token,
      { businessId, input },
    )
    const values = Object.values(entry.valuesOf).flat()
    if (!holds(template, entry.permission)) {
      // Not theirs to call: refused before anything is read, with nothing sensitive.
      expect(result.error?.data.appCode, result.raw).toBe('forbidden')
      for (const value of values) expect(result.raw.includes(value), value).toBe(false)
      return
    }
    expect(result.error, result.raw).toBeUndefined()
    const hidden = paths.filter((p) => !visible.has(p.category)).map((p) => p.path)
    expect(result.data?.meta.redacted).toEqual([...hidden].sort())
    for (const category of SENSITIVITY_CATEGORIES) {
      for (const value of entry.valuesOf[category] ?? []) {
        expect(result.raw.includes(value), `${category} ${value}`).toBe(visible.has(category))
      }
    }

    // The client is told the same categories (business.context), so it locks the same fields.
    const context = await callProcedure<{ visibleCategories: string[] }>(
      api.handler,
      { path: 'business.context', type: 'query' },
      person.token,
      { businessId },
    )
    expect(context.data?.visibleCategories).toEqual(VISIBLE_TO[template])
  })
})

describe('the Dashboard cost steps count costs only for the templates that see them (D-193)', () => {
  it.each(ROLE_TEMPLATE_KEYS)('%s', async (template) => {
    const person = members.get(template)
    if (!person) throw new Error(`no ${template}`)
    const result = await callProcedure<{ costSteps: { id: string; remaining: number | null }[] }>(
      api.handler,
      { path: 'dashboard.checklist', type: 'query' },
      person.token,
      { businessId },
    )
    expect(result.error, result.raw).toBeUndefined()
    const ids = result.data?.costSteps.map((step) => step.id) ?? []
    const seesCosts = VISIBLE_TO[template].includes('cost')
    for (const id of ['product_costs', 'owner_time']) {
      if (!seesCosts) expect(ids, `${template} ${id}`).not.toContain(id)
    }
    if (ids.includes('product_costs')) expect(seesCosts, template).toBe(true)
  })
})

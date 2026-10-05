import {
  isWithMeta,
  withMeta,
  type AppErrorCode,
  type AttachmentUploadUrlDto,
  type BooksDto,
  type CostCategoryDto,
  type DashboardCardsDto,
  type ExpenseDto,
  type MaterialDto,
  type ProductCostBreakdownDto,
  type ProductCostSettingsDto,
  type ProductDto,
  type ProfitSummaryDto,
  type PurchaseDto,
  type PurchaseReturnDto,
  type RunningCostDto,
  type SaleDto,
  type SalesChannelDto,
  type SupplierDto,
} from '@bizcost/contracts'
import {
  addMonths,
  daysIn,
  monthOf,
  newId,
  SENSITIVITY_CATEGORIES,
  type SensitivityCategory,
} from '@bizcost/domain'
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
import { updateFieldsOf } from '../sales'
import { inputLeaves, inputSchemaOf, optionsOf } from './schema'

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

// Member overrides (M2 Step 7, D-084): a member's own changes to their role's access change what they
// see exactly as a role would. Three members hold a template changed by overrides, as Settings → Team
// saves them (member.updatePermissions, which keeps every key with what it needs), and are held to
// the same oracle as the templates, with what they may see written out by hand below:
//   - a Supervisor allowed "Product costs" (no costs: the list, its sorts and filters, redacted);
//   - a Manager with "See costs, supplier prices and margins" off, as the page sends it (with the
//     keys that need it: approving expenses, recording payments);
//   - an Employee with it on.

interface OverridePersona {
  template: RoleTemplateKey
  overrides: { key: PermissionKey; effect: 'allow' | 'deny' }[]
  visible: SensitivityCategory[]
}

const COSTS_SWITCH: PermissionKey[] = [
  'data.cost.view',
  'data.supplier_price.view',
  'data.profit_margin.view',
]

const OVERRIDE_PERSONAS = {
  'supervisor+product_costs': {
    template: 'supervisor',
    overrides: [{ key: 'cost_engine.product_costs.view', effect: 'allow' }],
    visible: [],
  },
  'manager-costs': {
    template: 'manager',
    overrides: [
      ...COSTS_SWITCH,
      'expenses.documents.approve',
      'expenses.payments.record',
      'purchases.payments.record',
      // M3 Step 3: profit reports need the costs switch (Q11, D-190): the switch takes them along.
      'reports.profit.view',
    ].map((key) => ({ key: key as PermissionKey, effect: 'deny' as const })),
    visible: [],
  },
  'employee+costs': {
    template: 'employee',
    overrides: COSTS_SWITCH.map((key) => ({ key, effect: 'allow' as const })),
    visible: ['cost', 'profit_margin', 'supplier_price'],
  },
} as const satisfies Record<string, OverridePersona>

type OverrideKey = keyof typeof OVERRIDE_PERSONAS
/** A role template as Smart Setup copied it, or a member's template changed by their overrides. */
type Persona = RoleTemplateKey | OverrideKey
const OVERRIDE_KEYS = Object.keys(OVERRIDE_PERSONAS) as OverrideKey[]
const PERSONAS: Persona[] = [...ROLE_TEMPLATE_KEYS, ...OVERRIDE_KEYS]

function isOverride(persona: Persona): persona is OverrideKey {
  return Object.hasOwn(OVERRIDE_PERSONAS, persona)
}

/** The categories a persona may see (hand-written: VISIBLE_TO, OVERRIDE_PERSONAS). */
function visibleTo(persona: Persona): SensitivityCategory[] {
  return isOverride(persona)
    ? [...OVERRIDE_PERSONAS[persona].visible]
    : [...VISIBLE_TO[persona as RoleTemplateKey]]
}

interface OracleEntry {
  /** The permission the procedure needs; templates without it get FORBIDDEN (none: every member). */
  permission?: PermissionKey
  /**
   * Input of the call, or a function preparing a fresh one for each call (as the owner, or as the
   * member of `persona` where only one's own record may be changed, D-184).
   */
  input?: unknown
  prepare?: (persona: Persona) => Promise<unknown>
  /** The values the call returns in each category (each must be in the answer when visible). */
  valuesOf: Partial<Record<SensitivityCategory, readonly string[]>>
  /**
   * The call needs this category visible as well as its permission: what it writes or checks shows
   * it (a credit note's amounts, a correction's copy, what is owed). FORBIDDEN otherwise, before
   * anything is read, with nothing sensitive.
   */
  needsVisible?: SensitivityCategory
  /** A member who holds the permission but not this key is refused this way, with nothing. */
  alsoNeeds?: { key: PermissionKey; refusal: AppErrorCode }
  /**
   * The call is refused this way for every member who holds the permission (and sees what
   * needsVisible says), with nothing sensitive (the owner's hourly rate in a business with a team,
   * D-119): its output is the output of another entry, checked there.
   */
  refusedWith?: AppErrorCode
  /**
   * The service withholds the values from a member without this key even where they see the
   * category (aggregates of hidden values are withheld, not only redacted: real profit needs "See
   * profit reports", Q11, D-190): its values are then absent, its paths redacted as the category says.
   */
  withheldWithout?: PermissionKey
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
const OWN_AMOUNT: Record<Exclude<Persona, 'owner'>, string> = {
  admin: '71.13',
  manager: '72.23',
  accountant: '73.33',
  sales: '74.43',
  supervisor: '75.53',
  employee: '76.63',
  'supervisor+product_costs': '77.73',
  'manager-costs': '78.83',
  'employee+costs': '79.93',
}
/** An expense of the owner's that members who may correct it correct (D-184): never theirs to read. */
const CORRECTED_AMOUNT = '97.19'
/**
 * The amounts of the owner's purchases and expenses that cannot be read inside a timestamp (more
 * than 59, so never "…:41.17…" seconds): expense.getMine returns timestamps.
 */
const OWNERS_AMOUNTS = [
  LINE_TOTAL,
  OWED_TOTAL,
  OWED_LEFT,
  EXPENSE_NET,
  EXPENSE_TOTAL,
  EXPENSE_LEFT,
  '611.29',
]

let api: Api
let businessId: string
const members = new Map<Persona, Person>()
const memberIds = new Map<Exclude<Persona, 'owner'>, string>()
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
/** The running costs' category (an expense in one that has a running cost says what it pays, D-216). */
let rentCategory: CostCategoryDto
let spent: ExpenseDto
let owedExpense: ExpenseDto
let running: RunningCostDto
const ownExpenses = new Map<Persona, string>()
let costed: ProductDto
let channel: SalesChannelDto
let sold: SaleDto

// Sales (M3 Step 2): a channel of its own with a commission of 17.25 % (`cost`), and the costed
// product sold in it, 1 at its price: its cost frozen at posting is the beans' 18 g, 1.02834
// (`cost`). A member who does not see every sale reads and changes their own sales only (D-181):
// their cases use a sale they entered, with the same lines (the same cost). No case types a delivery
// cost (one's own is read untagged in `ownDeliveryCost`, D-181; sales-visibility.api.test.ts), but
// sale.fillDeliveryCost fills 11.47 once.
const FEE_PERCENT = '17.25'
const FILLED_DELIVERY = '11.47'

// Product costs (M2 Step 6; D-202): a product of 18 g of the beans (1.02834 of materials) sold at
// 99.99, its share of the running costs waiting for sales; the business's costs of last month: a
// rent of 8 123.47 a month since the month before and a bill of 611.29 for last month, 8 734.76 in
// all (`cost`, shown only with running costs and expenses); the beans' last purchase price
// (`supplier_price`) in the breakdown. The owner's hourly rate, 47.83, is kept while the business has
// a team (written in the database: the settings refuse it with a team, D-119).
const PRODUCT_PRICE = '99.99'
const POOL_RENT = '8123.47'
const POOL_BILL = '611.29'
const POOL_TOTAL = '8734.76'
const HOURLY_RATE = '47.83'
const costedValues = { cost: [] as string[], profit_margin: [] as string[] }
const breakdownValues = {
  cost: [] as string[],
  profit_margin: [] as string[],
  supplier_price: [BEANS_PRICE],
}
const settingsValues = { cost: [HOURLY_RATE] }
// Real profit (M3 Step 3): last month's report (only the sale of its 1st: materials 1.02834, the
// month's costs 8 734.76, and its profit), and the Dashboard's cards (read as the owner right before
// each call: the cases add sales today).
const profitValues = { cost: [] as string[], profit_margin: [] as string[] }
const cardValues = { cost: [] as string[], profit_margin: [] as string[] }

/** Last month's report as the owner (profitValues); its input. */
async function readProfit() {
  const lastMonth = addMonths(monthOf(today), -1)
  const input = {
    from: `${lastMonth}-01`,
    to: `${lastMonth}-${String(daysIn(lastMonth)).padStart(2, '0')}`,
    groupBy: 'product',
  }
  const { data } = await asOwner<ProfitSummaryDto>('profit.summary', 'query', input)
  expect(data.total).toMatchObject({ materials: RECIPE_COST, monthCosts: POOL_TOTAL })
  profitValues.cost = [data.total.materials!, data.total.monthCosts!]
  profitValues.profit_margin = [data.total.profit!]
  return input
}

/** The cards as the owner (cardValues). */
async function readCards() {
  const { data } = await asOwner<DashboardCardsDto>('dashboard.cards', 'query')
  expect(data.moneyWent, JSON.stringify(data)).not.toBeNull()
  cardValues.cost = [data.moneyWent!.materials!, data.moneyWent!.runningCosts!]
  cardValues.profit_margin = [data.moneyWent!.profit!]
  return undefined
}

/** Reads the costed product's numbers as the owner (costedValues); its search input for the list. */
async function readCosted() {
  const { data } = await asOwner<ProductCostBreakdownDto>('productCost.get', 'query', {
    productId: costed.id,
  })
  expect(data.cost.complete, JSON.stringify(data.cost)).toBe(true)
  expect(data.monthCosts.total).toBe(POOL_TOTAL)
  costedValues.cost = [data.cost.materials!, data.cost.total!, POOL_RENT, POOL_BILL, POOL_TOTAL]
  costedValues.profit_margin = [data.margin.amount!, data.margin.percent!]
  breakdownValues.cost = costedValues.cost
  breakdownValues.profit_margin = costedValues.profit_margin
  return { productId: costed.id, search: costed.name }
}

/** Reads the settings as the owner: the hourly rate kept with the team. */
async function readSettings() {
  const { data } = await asOwner<ProductCostSettingsDto>('productCost.settings', 'query')
  expect(data).toEqual({ ownerHourlyRate: HOURLY_RATE, hasTeam: true, currency: 'AED' })
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

/** A member who enters purchases without seeing supplier prices changes only their own (D-200). */
function changesOnlyOwn(persona: Persona): boolean {
  return (
    persona !== 'owner' &&
    holds(persona, 'purchases.documents.manage') &&
    !visibleTo(persona).includes('supplier_price')
  )
}

/** A purchase draft `persona` may change: their own where they change only theirs, else the owner's. */
async function newOwnDraft(persona: Persona): Promise<{ id: string; version: number }> {
  if (!changesOnlyOwn(persona)) return newDraft()
  const result = await callProcedure<{ data: PurchaseDto }>(
    api.handler,
    { path: 'purchase.create', type: 'mutation' },
    members.get(persona)!.token,
    { businessId, input: draftInput() },
  )
  expect(result.error, result.raw).toBeUndefined()
  return { id: result.data!.data.id, version: result.data!.data.version }
}

/** A member who manages running costs without seeing costs changes only their own (D-210). */
function changesOnlyOwnRunning(persona: Persona): boolean {
  return (
    persona !== 'owner' &&
    holds(persona, 'running_costs.items.manage') &&
    !visibleTo(persona).includes('cost')
  )
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

async function uploaded(entityId = purchase.id, person = members.get('owner')!): Promise<string> {
  const result = await callProcedure<AttachmentUploadUrlDto>(
    api.handler,
    { path: 'attachment.uploadUrl', type: 'mutation' },
    person.token,
    { businessId, input: { entity: 'purchase', entityId, contentType: 'image/png' } },
  )
  expect(result.error, result.raw).toBeUndefined()
  const upload = result.data!
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
 * A draft the member of `persona` entered themselves when they may enter expenses (a member who may
 * not see supplier prices changes only their own, D-184), else the owner's.
 */
async function newOwnExpenseDraft(persona: Persona): Promise<{ id: string; version: number }> {
  if (persona === 'owner' || !holds(persona, 'expenses.documents.manage')) {
    return newExpenseDraft()
  }
  const result = await callProcedure<{ data: ExpenseDto }>(
    api.handler,
    { path: 'expense.create', type: 'mutation' },
    members.get(persona)!.token,
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
    categoryId: rentCategory.id,
    amount: RUNNING,
    frequency: 'weekly',
    startsOn: today,
    ...extra,
  }
}

function channelInput() {
  return {
    id: newId(),
    name: `Oracle channel ${newId().slice(-8)}`,
    kind: 'delivery_app',
    feePercent: FEE_PERCENT,
  }
}

async function newChannel(): Promise<SalesChannelDto> {
  return (await asOwner<{ data: SalesChannelDto }>('channel.create', 'mutation', channelInput()))
    .data
}

/** One of the costed product at its price, in the oracle's channel, today. */
function saleInput(extra: object = {}) {
  return {
    id: newId(),
    source: 'single',
    businessDate: today,
    channelId: channel.id,
    lines: [
      { kind: 'item', id: newId(), productId: costed.id, qty: '1', unitPrice: PRODUCT_PRICE },
    ],
    ...extra,
  }
}

/** A member who does not see every sale changes and finalizes only their own (D-181, D-214). */
function salesOnlyOwn(persona: Persona): boolean {
  return persona !== 'owner' && !holds(persona, 'sales.documents.view')
}

/** A draft sale entered by `persona` when they may enter sales (their own), else by the owner. */
async function ownSaleDraft(persona: Persona, extra: object = {}): Promise<SaleDto> {
  if (persona === 'owner' || !holds(persona, 'sales.documents.manage')) {
    return (await asOwner<{ data: SaleDto }>('sale.create', 'mutation', saleInput(extra))).data
  }
  const result = await callProcedure<{ data: SaleDto }>(
    api.handler,
    { path: 'sale.create', type: 'mutation' },
    members.get(persona)!.token,
    { businessId, input: saleInput(extra) },
  )
  expect(result.error, result.raw).toBeUndefined()
  return result.data!.data
}

/** A finalized sale of the owner's. */
async function newPostedSale(extra: object = {}): Promise<SaleDto> {
  const draft = await ownSaleDraft('owner', extra)
  return (
    await asOwner<{ data: SaleDto }>('sale.post', 'mutation', {
      id: draft.id,
      version: draft.version,
    })
  ).data
}

/**
 * A finalized sale `persona` may read: their own where they see only theirs, else the owner's (the
 * fixture's, or a new one with `extra`).
 */
async function readableSale(persona: Persona, extra?: object): Promise<string> {
  if (!salesOnlyOwn(persona)) return extra ? (await newPostedSale(extra)).id : sold.id
  const draft = await ownSaleDraft(persona, extra)
  const result = await callProcedure<{ data: SaleDto }>(
    api.handler,
    { path: 'sale.post', type: 'mutation' },
    members.get(persona)!.token,
    { businessId, input: { id: draft.id, version: draft.version } },
  )
  expect(result.error, result.raw).toBeUndefined()
  return draft.id
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
  // Without supplier prices, only one's own draft (D-200).
  'purchase.update': {
    permission: 'purchases.documents.manage',
    prepare: async (persona) => {
      const draft = await newOwnDraft(persona)
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
  // The copy carries the prices, and is the corrector's own draft to save whole (D-184, D-200).
  'purchase.correct': {
    permission: 'purchases.documents.reverse',
    prepare: async () => ({ id: (await newPosted()).id, newId: newId() }),
    valuesOf: PRICE,
    needsVisible: 'supplier_price',
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
  // A credit note's amounts are checked against the purchase's (D-142).
  'purchaseReturn.create': {
    permission: 'purchases.documents.manage',
    prepare: () => Promise.resolve(creditInput()),
    valuesOf: { supplier_price: [CREDIT] },
    needsVisible: 'supplier_price',
  },
  'purchaseReturn.update': {
    permission: 'purchases.documents.manage',
    prepare: async () => {
      const draft = await newCredit()
      const { lines, businessDate } = creditInput()
      return { id: draft.id, version: draft.version, businessDate, lines }
    },
    valuesOf: { supplier_price: [CREDIT] },
    needsVisible: 'supplier_price',
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
    valuesOf: breakdownValues,
  },
  'profit.summary': {
    permission: 'reports.sales.view',
    prepare: readProfit,
    valuesOf: profitValues,
    withheldWithout: 'reports.profit.view',
  },
  'dashboard.cards': {
    permission: 'dashboard.home.view',
    prepare: readCards,
    valuesOf: cardValues,
    withheldWithout: 'reports.profit.view',
  },
  'productCost.settings': {
    permission: 'cost_engine.settings.manage',
    prepare: async () => {
      await readSettings()
      return undefined
    },
    valuesOf: settingsValues,
  },
  // The owner's hourly rate only without a team (D-119, D-202): refused here, where every
  // template's member needs the team; its output is productCost.settings's, checked above.
  'productCost.updateSettings': {
    permission: 'cost_engine.settings.manage',
    prepare: async () => {
      await readSettings()
      return { ownerHourlyRate: HOURLY_RATE }
    },
    valuesOf: settingsValues,
    needsVisible: 'cost',
    refusedWith: 'capability_disabled',
  },
  // What is still owed is a filter on amounts.
  'payable.list': {
    permission: 'purchases.payments.view',
    input: { party: 'supplier' },
    valuesOf: { supplier_price: [OWED_TOTAL, OWED_LEFT] },
    needsVisible: 'supplier_price',
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
    needsVisible: 'supplier_price',
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
  // What was sent is what is approved (D-175).
  'expense.approve': {
    permission: 'expenses.documents.approve',
    prepare: async () => {
      const sent = await newExpenseSubmitted()
      return { id: sent.id, version: sent.version }
    },
    valuesOf: EXPENSE,
    needsVisible: 'supplier_price',
  },
  'expense.reject': {
    permission: 'expenses.documents.approve',
    prepare: async () => {
      const sent = await newExpenseSubmitted()
      return { id: sent.id, version: sent.version, reason: 'Not ours' }
    },
    valuesOf: EXPENSE,
    needsVisible: 'supplier_price',
  },
  // Approval is on here: a draft is finalized only by a member who may also approve it (D-175).
  'expense.post': {
    permission: 'expenses.documents.post',
    prepare: async () => {
      const draft = await newExpenseDraft()
      return { id: draft.id, version: draft.version }
    },
    valuesOf: EXPENSE,
    alsoNeeds: { key: 'expenses.documents.approve', refusal: 'approval_required' },
  },
  'expense.reverse': {
    permission: 'expenses.documents.reverse',
    prepare: async () => ({ id: (await newExpensePosted()).id }),
    valuesOf: EXPENSE,
  },
  // The copy carries the amounts (D-184).
  'expense.correct': {
    permission: 'expenses.documents.reverse',
    prepare: async () => ({ id: (await newExpensePosted()).id, newId: newId() }),
    valuesOf: EXPENSE,
    needsVisible: 'supplier_price',
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
    needsVisible: 'supplier_price',
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
  // Without costs, only to one's own running cost (D-210).
  'runningCost.update': {
    permission: 'running_costs.items.manage',
    prepare: async (persona) => {
      const input = runningInput()
      if (!changesOnlyOwnRunning(persona)) {
        const created = (
          await asOwner<{ data: RunningCostDto }>('runningCost.create', 'mutation', input)
        ).data
        return { ...runningInput(), id: created.id, version: created.version }
      }
      const result = await callProcedure<{ data: RunningCostDto }>(
        api.handler,
        { path: 'runningCost.create', type: 'mutation' },
        members.get(persona)!.token,
        { businessId, input },
      )
      expect(result.error, result.raw).toBeUndefined()
      return { ...runningInput(), id: input.id, version: result.data!.data.version }
    },
    valuesOf: { cost: [RUNNING, RUNNING_MONTHLY] },
  },
  // Sales (M3 Step 2): every template holds a sales key (list and read); a channel's commission % is
  // written only by a member who sees it (D-187).
  'channel.list': { valuesOf: { cost: [FEE_PERCENT] } },
  'channel.create': {
    permission: 'sales.channels.manage',
    prepare: () => Promise.resolve(channelInput()),
    valuesOf: { cost: [FEE_PERCENT] },
    needsVisible: 'cost',
  },
  'channel.update': {
    permission: 'sales.channels.manage',
    prepare: async () => {
      const created = await newChannel()
      return {
        id: created.id,
        version: created.version,
        name: created.name,
        kind: created.kind,
        feePercent: FEE_PERCENT,
      }
    },
    valuesOf: { cost: [FEE_PERCENT] },
    needsVisible: 'cost',
  },
  'channel.archive': {
    permission: 'sales.channels.manage',
    prepare: async () => ({ id: (await newChannel()).id }),
    valuesOf: { cost: [FEE_PERCENT] },
  },
  'channel.unarchive': {
    permission: 'sales.channels.manage',
    prepare: async () => {
      const created = await newChannel()
      await asOwner('channel.archive', 'mutation', { id: created.id })
      return { id: created.id }
    },
    valuesOf: { cost: [FEE_PERCENT] },
  },
  'sale.get': {
    prepare: async (persona) => ({ id: await readableSale(persona) }),
    valuesOf: { cost: [RECIPE_COST] },
  },
  // A draft has no cost yet.
  'sale.create': {
    permission: 'sales.documents.manage',
    prepare: () => Promise.resolve(saleInput()),
    valuesOf: { cost: [] },
  },
  'sale.update': {
    permission: 'sales.documents.manage',
    prepare: async (persona) => {
      const draft = await ownSaleDraft(persona)
      const fields = updateFieldsOf(saleInput())
      return { ...fields, id: draft.id, version: draft.version }
    },
    valuesOf: { cost: [] },
  },
  'sale.post': {
    permission: 'sales.documents.post',
    prepare: async (persona) => {
      const draft = await ownSaleDraft(persona)
      return { id: draft.id, version: draft.version }
    },
    valuesOf: { cost: [RECIPE_COST] },
  },
  'sale.reverse': {
    permission: 'sales.documents.reverse',
    prepare: async () => ({ id: (await newPostedSale()).id }),
    valuesOf: { cost: [RECIPE_COST] },
  },
  // The copy is a draft: no cost (its delivery cost only for a member who sees costs, D-231).
  'sale.correct': {
    permission: 'sales.documents.reverse',
    prepare: async () => ({ id: (await newPostedSale()).id, newId: newId() }),
    valuesOf: { cost: [] },
  },
  // A sale the member may read: their own where they see only theirs.
  'sale.fillDeliveryCost': {
    permission: 'sales.documents.manage',
    prepare: async (persona) => ({
      id: await readableSale(persona, { deliveryNeeded: true }),
      deliveryCost: FILLED_DELIVERY,
    }),
    valuesOf: { cost: [FILLED_DELIVERY, RECIPE_COST] },
    needsVisible: 'cost',
  },
  // The caller's own sheet of the day: each member who enters sales finalizes one first.
  'sale.daySheet': {
    permission: 'sales.documents.manage',
    prepare: async (persona) => {
      if (holds(persona, 'sales.documents.manage') && holds(persona, 'sales.documents.post')) {
        const draft = await ownSaleDraft(persona, { source: 'day_sheet' })
        const result = await callProcedure(
          api.handler,
          { path: 'sale.post', type: 'mutation' },
          members.get(persona)!.token,
          { businessId, input: { id: draft.id, version: draft.version } },
        )
        expect(result.error, result.raw).toBeUndefined()
      }
      return { businessDate: today, channelId: channel.id }
    },
    valuesOf: { cost: [RECIPE_COST] },
  },
  // Without supplier prices, only to one's own draft (D-184, D-200).
  'attachment.add': {
    permission: 'purchases.documents.manage',
    prepare: async (persona) => {
      const own = changesOnlyOwn(persona)
      const entityId = own ? (await newOwnDraft(persona)).id : purchase.id
      return {
        entity: 'purchase',
        entityId,
        path: await uploaded(entityId, members.get(own ? persona : 'owner')),
        fileName: 'receipt.png',
      }
    },
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

/**
 * Whether a member of the persona holds the permission (the owner holds every one): the template's
 * keys with the persona's overrides, written out by hand (not resolved by the engine under test).
 */
function holds(persona: Persona, permission: PermissionKey | undefined): boolean {
  if (permission === undefined) return true
  const override = isOverride(persona) ? OVERRIDE_PERSONAS[persona] : undefined
  const t = roleTemplateByKey(override?.template ?? persona)
  if (!t) throw new Error(`no template ${persona}`)
  const effect = override?.overrides.find((o) => o.key === permission)?.effect
  if (effect) return effect === 'allow'
  return t.allPermissions || t.permissionKeys.includes(permission)
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
  // The members whose access their own overrides change, saved as Settings → Team saves them.
  for (const key of OVERRIDE_KEYS) {
    const { template, overrides } = OVERRIDE_PERSONAS[key]
    const person = await api.newPerson()
    const memberId = await join(api.db, owner.user, businessId, person.user, template)
    const { version } = await asOwner<{ version: number }>('member.permissions', 'query', {
      memberId,
    })
    await asOwner('member.updatePermissions', 'mutation', { memberId, version, overrides })
    memberIds.set(key, memberId)
    members.set(key, person)
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
  rentCategory = await asOwner<CostCategoryDto>('costCategory.create', 'mutation', {
    id: newId(),
    name: 'Oracle rent costs',
  })
  spent = await newExpensePosted()
  owedExpense = await newOwedExpense()
  await asOwner('expensePayment.record', 'mutation', expensePaymentInput(owedExpense.id))
  channel = await newChannel()
  sold = await newPostedSale()
  running = (
    await asOwner<{ data: RunningCostDto }>('runningCost.create', 'mutation', runningInput())
  ).data
  // Last month's costs (D-202): a rent since the month before, in a category of its own, and a bill
  // for last month. The owner's hourly rate, kept with the team.
  const lastMonth = addMonths(monthOf(today), -1)
  const premises = await asOwner<CostCategoryDto>('costCategory.create', 'mutation', {
    id: newId(),
    name: 'Oracle premises',
  })
  await asOwner('runningCost.create', 'mutation', {
    ...runningInput(),
    categoryId: premises.id,
    amount: POOL_RENT,
    frequency: 'monthly',
    startsOn: `${addMonths(lastMonth, -1)}-01`,
  })
  await newExpensePosted({ amount: POOL_BILL, periodMonth: lastMonth })
  // M3 Step 3: the costed product sold on the 1st of last month too, so the running month carries
  // last month's rate (Q6): its whole costs, 8 734.76, ÷ its item sales, 99.99 (Product costs show
  // them, and real profit reads them).
  await newPostedSale({ businessDate: `${lastMonth}-01` })
  await api.admin`update app.businesses set owner_hourly_rate = ${HOURLY_RATE} where id = ${businessId}`
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
// each template (or a template changed by their overrides), the answer carries that member's own
// amount (when they may use the procedure; FORBIDDEN otherwise, with nothing) and never another
// member's, nor any amount of the owner's purchases and expenses. A new procedure named like them
// (`.mine`, `.getMine`) fails the first test until it is classified here.

interface OwnEntry {
  /** The permission the procedure needs; members without it get FORBIDDEN (none: every member). */
  permission?: PermissionKey
  /** The input for a member (their own record's id where it takes one). */
  input: (persona: Persona) => unknown
}

const OWN_ORACLE: Record<string, OwnEntry> = {
  'expense.mine': { permission: 'expenses.documents.view', input: () => ({ limit: 100 }) },
  'expense.getMine': {
    permission: 'expenses.documents.view',
    input: (persona) => ({ id: ownExpenses.get(persona) ?? spent.id }),
  },
  'payable.mine': { input: () => ({ limit: 100 }) },
}

/**
 * The amounts that are not `persona`'s own: the owner's and every other member's. The owner entered
 * every record of the fixture, so they are all the owner's own (and the owner sees every amount).
 * These cases run before the oracle above, whose calls add records of the members' own.
 */
function othersAmounts(persona: Persona): string[] {
  if (persona === 'owner') return []
  const members = Object.entries(OWN_AMOUNT)
    .filter(([key]) => key !== persona)
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
    PERSONAS.map((persona) => [path, persona] as const),
  )

  it.each(OWN_CASES)('%s as %s: their own amount, never anyone else’s', async (path, persona) => {
    const entry = OWN_ORACLE[path]
    const person = members.get(persona)
    const procedure = proceduresOf(oracleRouter).find((p) => p.path === path)
    if (!entry || !person || !procedure) throw new Error(`no fixture for ${path} as ${persona}`)
    const result = await callProcedure(api.handler, procedure, person.token, {
      businessId,
      input: entry.input(persona),
    })
    for (const value of othersAmounts(persona)) {
      expect(result.raw.includes(value), `someone else’s ${value}`).toBe(false)
    }
    if (!holds(persona, entry.permission)) {
      expect(result.error?.data.appCode, result.raw).toBe('forbidden')
      return
    }
    expect(result.error, result.raw).toBeUndefined()
    if (persona !== 'owner') {
      expect(result.raw.includes(OWN_AMOUNT[persona]), 'their own amount').toBe(true)
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
    for (const persona of PERSONAS.filter((key) => key !== 'owner')) {
      const person = members.get(persona)!
      const others = [
        spent.id,
        ...[...ownExpenses].filter(([key]) => key !== persona).map(([, id]) => id),
      ]
      for (const id of others) {
        const result = await callProcedure(
          api.handler,
          { path: 'expense.getMine', type: 'query' },
          person.token,
          { businessId, input: { id } },
        )
        expect(['not_found', 'forbidden'], `${persona}: ${result.raw}`).toContain(
          result.error?.data.appCode,
        )
        for (const value of othersAmounts(persona)) {
          expect(result.raw.includes(value), `${persona} ${value}`).toBe(false)
        }
      }
    }
  })
})

const ORACLE = { ...PRODUCTION_ORACLE, ...TEST_ORACLE }
const CASES = Object.keys(ORACLE).flatMap((path) =>
  PERSONAS.map((persona) => [path, persona] as const),
)

describe('each role template, and each changed by overrides, receives exactly the categories it may see', () => {
  it('the members with overrides see what OVERRIDE_PERSONAS says (as saved)', async () => {
    for (const key of OVERRIDE_KEYS) {
      const context = await callProcedure<{ visibleCategories: string[] }>(
        api.handler,
        { path: 'business.context', type: 'query' },
        members.get(key)!.token,
        { businessId },
      )
      expect(context.data?.visibleCategories, key).toEqual(visibleTo(key))
      const { overrides } = await asOwner<{ overrides: { key: string; effect: string }[] }>(
        'member.permissions',
        'query',
        { memberId: memberIds.get(key) },
      )
      expect(
        [...overrides].sort((a, b) => a.key.localeCompare(b.key)),
        key,
      ).toEqual([...OVERRIDE_PERSONAS[key].overrides].sort((a, b) => a.key.localeCompare(b.key)))
    }
  })

  it.each(CASES)('%s as %s', async (path, persona) => {
    const entry = ORACLE[path]
    const person = members.get(persona)
    const paths = sensitiveProcedures(oracleRouter).get(path) ?? []
    const procedure = proceduresOf(oracleRouter).find((p) => p.path === path)
    if (!entry || !person || !procedure) throw new Error(`no fixture for ${path} as ${persona}`)
    const visible = new Set(visibleTo(persona))
    const input = entry.prepare ? await entry.prepare(persona) : entry.input

    const result = await callProcedure<{ meta: { redacted: string[] } }>(
      api.handler,
      procedure,
      person.token,
      { businessId, input },
    )
    const values = Object.values(entry.valuesOf).flat()
    const refusedWith = !holds(persona, entry.permission)
      ? 'forbidden'
      : entry.needsVisible && !visible.has(entry.needsVisible)
        ? 'forbidden'
        : entry.alsoNeeds && !holds(persona, entry.alsoNeeds.key)
          ? entry.alsoNeeds.refusal
          : entry.refusedWith
    if (refusedWith) {
      // Refused before anything is read, with nothing sensitive.
      expect(result.error?.data.appCode, result.raw).toBe(refusedWith)
      for (const value of values) expect(result.raw.includes(value), value).toBe(false)
      return
    }
    expect(result.error, result.raw).toBeUndefined()
    const hidden = paths.filter((p) => !visible.has(p.category)).map((p) => p.path)
    expect(result.data?.meta.redacted).toEqual([...hidden].sort())
    const withheld = entry.withheldWithout !== undefined && !holds(persona, entry.withheldWithout)
    for (const category of SENSITIVITY_CATEGORIES) {
      for (const value of entry.valuesOf[category] ?? []) {
        expect(result.raw.includes(value), `${category} ${value}`).toBe(
          visible.has(category) && !withheld,
        )
      }
    }

    // The client is told the same categories (business.context), so it locks the same fields.
    const context = await callProcedure<{ visibleCategories: string[] }>(
      api.handler,
      { path: 'business.context', type: 'query' },
      person.token,
      { businessId },
    )
    expect(context.data?.visibleCategories).toEqual(visibleTo(persona))
  })
})

// The owner's minutes frozen on a sale (D-119: a `cost`). This business has a team, so its sales
// freeze none; a sale finalized before the business took on a team keeps them. Each persona reads a
// sale of theirs to which such minutes are written as that posting wrote them (past the guard of posted
// rows, as a test may): they come back only with the costs switch (D-236).
describe('the owner’s minutes a sale froze before the team are a `cost` (D-119, D-236)', () => {
  // More than 59: never inside a timestamp's seconds.
  const MINUTES = '83.47'

  it.each(PERSONAS)('sale.get as %s: the minutes only with the costs switch', async (persona) => {
    const id = await readableSale(persona, {})
    await api.admin.begin(async (sql) => {
      await sql`set local session_replication_role = replica`
      await sql`
        update app.sale_lines set time_minutes = ${MINUTES}
         where business_id = ${businessId} and sale_id = ${id} and kind = 'item'`
    })
    const result = await callProcedure<{ meta: { redacted: string[] } }>(
      api.handler,
      { path: 'sale.get', type: 'query' },
      members.get(persona)!.token,
      { businessId, input: { id } },
    )
    expect(result.error, result.raw).toBeUndefined()
    const seesCosts = visibleTo(persona).includes('cost')
    expect(result.raw.includes(MINUTES), result.raw).toBe(seesCosts)
    expect(result.data?.meta.redacted.some((p) => p.endsWith('lines.*.timeMinutes'))).toBe(
      !seesCosts,
    )
  })
})

describe('the Dashboard cost steps count costs only for the members who see them (D-193)', () => {
  it.each(PERSONAS)('%s', async (persona) => {
    const person = members.get(persona)
    if (!person) throw new Error(`no ${persona}`)
    const result = await callProcedure<{ costSteps: { id: string; remaining: number | null }[] }>(
      api.handler,
      { path: 'dashboard.checklist', type: 'query' },
      person.token,
      { businessId },
    )
    expect(result.error, result.raw).toBeUndefined()
    const ids = result.data?.costSteps.map((step) => step.id) ?? []
    const seesCosts = visibleTo(persona).includes('cost')
    for (const id of ['product_costs', 'owner_time']) {
      if (!seesCosts) expect(ids, `${persona} ${id}`).not.toContain(id)
    }
    if (ids.includes('product_costs')) expect(seesCosts, persona).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------------
// Querying on what a member may not see (ROADMAP.md M2 definition of done: "filtering, sorting,
// searching or exporting on them returns FORBIDDEN"; ARCHITECTURE.md §Permissions, Redaction)
// ---------------------------------------------------------------------------------------------------
//
// Every field of every business query's input is walked: a field that only names records, pages,
// states, kinds or days is in PLAIN_QUERY_FIELDS with why querying on it shows nothing hidden; every
// other field must sort or filter by value, and each of its options is classified in QUERY_OPTIONS
// by the category it orders or filters on. Each option is then called by every member: FORBIDDEN
// (with nothing sensitive) for a member who may not see its category, served for one who may. A
// search finds names, references and descriptions, never an amount. There is nothing to export.
// The lists that by nature filter on amounts (what is still owed) are `needsVisible` above.

const PLAIN_QUERY_FIELDS: Record<string, string> = {
  id: 'names a record; its own procedure decides what of it is shown',
  ids: 'names records; their own procedure decides what of them is shown',
  productId: 'names a record',
  purchaseId: 'names a record',
  expenseId: 'names a record',
  memberId: 'names a record',
  categoryId: 'names a record (a filter on the category)',
  supplierId: 'names a record (a filter on the supplier)',
  entityId: 'names a record',
  cursor: 'positions a page; each list refuses a cursor it did not make for the same query',
  limit: 'the size of a page',
  search: 'names, references and descriptions only, never an amount (proven below)',
  status: 'a record’s state',
  state: 'a running cost’s state as of today',
  kind: 'a return or a credit note',
  type: 'a product or a service',
  enteredBy: 'who entered an expense',
  entity: 'which kind of record a receipt belongs to',
  party: 'what is owed to suppliers or to members (the list itself needs supplier prices)',
  from: 'a business day',
  to: 'a business day',
  businessDate: 'a business day',
  periodFrom: 'a business day',
  source: 'how a sale came in (Today’s sales or One sale)',
  channelId: 'names a record (a filter on the sales channel)',
  locationId: 'names a record (a filter on the branch)',
  periodMonth: 'the month an expense is for',
  order: 'the direction of a sort the member may use',
  groupBy: 'how Real profit groups its sales: by time, product, channel or branch, never a value',
}

/** Each option of a field that sorts or filters by value: the category it orders on, or none. */
const QUERY_OPTIONS: Record<string, SensitivityCategory | 'none'> = {
  'productCost.list sort=name': 'none',
  'productCost.list sort=price': 'none',
  'productCost.list sort=cost': 'cost',
  'productCost.list sort=margin': 'profit_margin',
  'productCost.list sort=margin_percent': 'profit_margin',
  'productCost.list filter=incomplete': 'cost',
  'productCost.list filter=loss': 'profit_margin',
  // Real profit (M3 Step 3): sorted or shown by profit only for a member who sees it (Q11).
  'profit.summary sort=key': 'none',
  'profit.summary sort=sales': 'none',
  'profit.summary sort=profit': 'profit_margin',
  'profit.summary sort=margin_percent': 'profit_margin',
  'profit.summary show=all': 'none',
  'profit.summary show=loss': 'profit_margin',
  'profit.summary show=low_margin': 'profit_margin',
  'profit.summary show=incomplete': 'cost',
}

const BUSINESS_QUERIES = proceduresOf(appRouter).filter(
  (p) => p.base === 'business' && p.type === 'query',
)

function queryLeaves(path: string) {
  const schema = inputSchemaOf(appRouter, path)
  return schema ? inputLeaves(schema) : []
}

/** The items of a list's answer (`data.items` or, in an envelope, `data.data.items`). */
function itemsOf(data: unknown): unknown[] {
  const value = data as { items?: unknown[]; data?: { items?: unknown[] } } | undefined
  const items = value?.items ?? value?.data?.items
  if (!Array.isArray(items)) throw new Error(`not a list: ${JSON.stringify(data).slice(0, 200)}`)
  return items
}

describe('filtering, sorting, searching or exporting on hidden values is FORBIDDEN', () => {
  it('every field of every business query is classified, and nothing exports', () => {
    const unclassified: string[] = []
    const options: string[] = []
    for (const { path } of BUSINESS_QUERIES) {
      for (const leaf of queryLeaves(path)) {
        if (PLAIN_QUERY_FIELDS[leaf.name]) continue
        const values = optionsOf(leaf.schema)
        if (!values) unclassified.push(`${path} ${leaf.path}`)
        else options.push(...values.map((value) => `${path} ${leaf.path}=${value}`))
      }
    }
    expect(unclassified, 'add the field to PLAIN_QUERY_FIELDS or QUERY_OPTIONS').toEqual([])
    expect(options.sort()).toEqual(Object.keys(QUERY_OPTIONS).sort())
    expect(proceduresOf(appRouter).filter((p) => /export|csv|download/i.test(p.path))).toEqual([])
  })

  const OPTION_CASES = Object.keys(QUERY_OPTIONS).flatMap((key) =>
    PERSONAS.map((persona) => [key, persona] as const),
  )

  it.each(OPTION_CASES)('%s as %s', async (key, persona) => {
    const [path = '', assignment = ''] = key.split(' ')
    const [field = '', value = ''] = assignment.split('=')
    const category = QUERY_OPTIONS[key]
    const entry = ORACLE[path]
    const procedure = proceduresOf(oracleRouter).find((p) => p.path === path)
    if (!entry || !procedure || !category) throw new Error(`${path}: add it to the oracle first`)
    // Real profit's options on last month's report by product; the lists' on the costed product.
    const base =
      path === 'profit.summary' ? await readProfit() : { search: (await readCosted()).search }
    const result = await callProcedure(api.handler, procedure, members.get(persona)!.token, {
      businessId,
      input: { ...base, [field]: value },
    })
    const values = Object.values(entry.valuesOf).flat()
    const mayQuery = category === 'none' || visibleTo(persona).includes(category)
    if (!holds(persona, entry.permission) || !mayQuery) {
      expect(result.error?.data.appCode, result.raw).toBe('forbidden')
      for (const hidden of values) expect(result.raw.includes(hidden), hidden).toBe(false)
      return
    }
    expect(result.error, result.raw).toBeUndefined()
    // Sorted, the product is listed (filtered, it is neither incomplete nor sold at a loss).
    if (field === 'sort') expect(result.raw).toContain(costed.id)
  })

  it('a search finds names, references and descriptions, never an amount', async () => {
    const searchable = BUSINESS_QUERIES.filter((p) =>
      queryLeaves(p.path).some((leaf) => leaf.name === 'search'),
    )
    expect(searchable.map((p) => p.path)).toEqual(
      expect.arrayContaining(['purchase.list', 'expense.list', 'productCost.list']),
    )
    const amounts = [
      UNIT_PRICE,
      LINE_TOTAL,
      LAST_PRICE,
      CREAM_PRICE,
      OWED_TOTAL,
      BEANS_PRICE,
      EXPENSE_NET,
      EXPENSE_TOTAL,
      RUNNING,
      PRODUCT_PRICE,
      POOL_RENT,
      POOL_BILL,
    ]
    for (const procedure of searchable) {
      const owner = members.get('owner')!
      const search = (text: string) =>
        callProcedure(api.handler, procedure, owner.token, { businessId, input: { search: text } })
      // Control: the search works (every name of the fixture starts with "Oracle").
      const found = await search('Oracle')
      expect(found.error, found.raw).toBeUndefined()
      expect(itemsOf(found.data).length, procedure.path).toBeGreaterThan(0)
      for (const amount of amounts) {
        const result = await search(amount)
        expect(result.error, result.raw).toBeUndefined()
        expect(itemsOf(result.data), `${procedure.path} "${amount}"`).toEqual([])
      }
    }
  })
})

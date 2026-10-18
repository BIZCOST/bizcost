import { randomBytes } from 'node:crypto'
import type {
  DocumentSettingsDto,
  QuotationDto,
  CustomerDto,
  OrderDto,
  BusinessProfileDto,
  ChannelStatementDto,
  CostCategoryDto,
  ExpenseDto,
  LocationDto,
  MaterialDto,
  MemberPermissionsDto,
  ProductDto,
  PurchaseDto,
  PurchaseReturnDto,
  RecipeDto,
  RoleDto,
  RunningCostDto,
  SaleDto,
  SaleImportDto,
  SalesChannelDto,
  SupplierDto,
} from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import { QUESTION_SET_VERSION } from '@bizcost/modules'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { appRouter } from '../../src'
import { handlerFor, mutate, SECRET_KEY, type CallResult } from '../helpers'
import { CostScope, ProductCostsApi, tag } from '../product-costs'
import { codeOf, line, ok, purchaseInput } from '../purchasing'
import { BAKER, CapturedEmails, WORKSHOP } from '../settings'
import { businessDigest, proceduresOf } from './fixture'
import { updateFieldsOf } from '../sales'
import {
  decimalsIn,
  inputLeaves,
  inputSchemaOf,
  isDecimalLeaf,
  mapAtPaths,
  spell,
  type Digits,
} from './schema'

// What a client sends, as the API reads it (ROADMAP.md M2 Step 8 and definition of done), for EVERY
// mutation of appRouter, walked from its input schema:
//   - Digits: every mutation with a quantity or price field (a decimal field, test/hardening/schema.ts)
//     is called with valid inputs written in ASCII, Arabic-Indic (with ٫) and Eastern Arabic-Indic
//     digits in every such field: each is accepted and gives the same numbers back. (The contract test
//     in src/contract.test.ts holds every decimal field to it field by field, with no JSON numbers.)
//   - Idempotent creates: every mutation whose input names the new row by a client id is called twice
//     with the same input (the same answer, and nothing written the second time: rows, audit log,
//     Storage), at the same time twice (one row), and once more with another payload under that id
//     (CONFLICT, nothing written).
//   - Versions: every mutation that takes the `version` it read is refused with CONFLICT for any other
//     version (nothing written), and served with the right one.
//   - Ids of existing rows: every mutation that takes only an id (and its version or a reason) answers
//     NOT_FOUND for an id no row has: none of them makes a row.

class InputsApi extends ProductCostsApi {
  readonly emails = new CapturedEmails()
  override readonly handler = handlerFor(
    this.db,
    undefined,
    // Quotations is previewed (M3 Step 7, planned until Release B, D-125).
    { supabaseSecretKey: SECRET_KEY, previewModules: ['quotations'] },
    { emailSender: this.emails },
  )
}

const api = new InputsApi()
const MUTATIONS = proceduresOf(appRouter).filter((p) => p.type === 'mutation')

let shop: CostScope
let alone: CostScope
let today: string
let supplier: SupplierDto
let category: CostCategoryDto
/** The running costs' own category (an expense in one with a running cost says what it pays, D-216). */
let rentCategory: CostCategoryDto
/** Bought once, for recipes (its average does not move in these tests). */
let beans: MaterialDto
/** Sold by the sales of these tests (M3 Step 2), in the channel Smart Setup gave the shop. */
let latte: ProductDto
let channelId: string

type Where = 'shop' | 'alone'
const scopeOf = (where: Where = 'shop') => (where === 'alone' ? alone : shop)

beforeAll(async () => {
  shop = await CostScope.open(api, WORKSHOP)
  alone = await CostScope.open(api, BAKER)
  today = await shop.today()
  supplier = await shop.supplier()
  category = await shop.category()
  rentCategory = await shop.category()
  beans = await shop.newMaterial({ name: `Beans ${tag()}`, unit: 'kg' })
  await shop.buy(purchaseInput(today, [line(beans.id, '2', '48.5', { unit: 'kg' })]))
  ok(await shop.run('expense.updateSettings', { approval: true }))
  latte = await shop.product({ name: `Latte ${tag()}`, defaultPrice: '18' })
  channelId = ok(await shop.run<{ data: { items: SalesChannelDto[] } }>('channel.list')).data
    .items[0]!.id
}, 60_000)

afterAll(() => api.close())

// ---------------------------------------------------------------------------------------------------
// Inputs of the shop
// ---------------------------------------------------------------------------------------------------

function materialInput(extra: object = {}) {
  const bag = newId()
  return {
    id: newId(),
    name: `Flour ${tag()}`,
    unit: 'kg',
    packs: [
      { id: bag, name: 'bag', qty: '2.5', ofUnit: 'kg' },
      { id: newId(), name: 'sack', qty: '12', ofPackId: bag },
    ],
    crossFactors: [{ id: newId(), unit: 'l', qty: '1.25', ofUnit: 'kg' }],
    ...extra,
  }
}

function fullPurchase(extra: object = {}) {
  const milk = { kind: 'material', id: newId(), materialId: beans.id, unit: 'kg' }
  return purchaseInput(
    today,
    [
      { ...milk, qty: '2.5', unitPrice: '12.25', discount: { percent: '10' }, vatRate: '5' },
      { ...milk, id: newId(), qty: '1', unitPrice: '7.5', discount: { amount: '0.5' } },
      { kind: 'delivery', id: newId(), amount: '3.5', vatRate: '5' },
    ],
    { documentType: 'tax_invoice', supplierId: supplier.id, discount: { amount: '1.5' }, ...extra },
  )
}

async function postedPurchase(extra: object = {}): Promise<PurchaseDto> {
  return shop.buy(purchaseInput(today, [line(beans.id, '4', '10', { unit: 'kg' })], extra))
}

const onCredit = () => postedPurchase({ supplierId: supplier.id, paymentMethod: 'supplier_credit' })

function expenseInput(extra: object = {}) {
  return shop.expenseInput(category.id, today, {
    amount: '105.5',
    vatRate: '5',
    pricesIncludeVat: true,
    ...extra,
  })
}

const owedExpense = () =>
  shop.spend(expenseInput({ supplierId: supplier.id, paymentMethod: 'supplier_credit' }))

function runningCostInput(extra: object = {}) {
  return {
    id: newId(),
    name: `Rent ${tag()}`,
    categoryId: rentCategory.id,
    amount: '1200.5',
    frequency: 'quarterly',
    startsOn: today,
    ...extra,
  }
}

const productInput = (extra: object = {}) => ({
  id: newId(),
  name: `Latte ${tag()}`,
  type: 'product',
  unit: 'piece',
  defaultPrice: '18.75',
  ...extra,
})

const fieldsOf = (product: ProductDto) => ({
  id: product.id,
  version: product.version,
  name: product.name,
  type: product.type,
  unit: product.unit,
  locationIds: [],
})

async function creditDraft(extra: object = {}): Promise<PurchaseReturnDto> {
  const purchase = await postedPurchase()
  return shop.returnDraft({
    id: newId(),
    purchaseId: purchase.id,
    kind: 'credit_note',
    businessDate: today,
    lines: [{ id: newId(), purchaseLineId: purchase.lines[0]!.id, amount: '1.25' }],
    ...extra,
  })
}

async function returnInput(kind: 'return' | 'credit_note', change: object = {}) {
  const purchase = await postedPurchase()
  const lineId = purchase.lines[0]!.id
  return {
    id: newId(),
    purchaseId: purchase.id,
    kind,
    businessDate: today,
    lines: [
      kind === 'return'
        ? { id: newId(), purchaseLineId: lineId, qty: '0.5' }
        : { id: newId(), purchaseLineId: lineId, amount: '1.25' },
    ],
    ...change,
  }
}

/** A sale with every decimal field (delivery charged, and what it cost). */
function saleInput(extra: object = {}) {
  return {
    id: newId(),
    source: 'single',
    businessDate: today,
    channelId,
    deliveryNeeded: true,
    deliveryCost: '4.75',
    lines: [
      {
        kind: 'item',
        id: newId(),
        productId: latte.id,
        qty: '2.5',
        unitPrice: '12.25',
        discount: { percent: '10' },
      },
      {
        kind: 'item',
        id: newId(),
        productId: latte.id,
        qty: '1',
        unitPrice: '7.5',
        discount: { amount: '0.5' },
      },
      { kind: 'delivery', id: newId(), amount: '3.5' },
    ],
    ...extra,
  }
}

/** The fields of a sale's update (no id or source). */
function saleFields(extra: object = {}) {
  return updateFieldsOf(saleInput(extra))
}

async function saleDraft(extra: object = {}): Promise<SaleDto> {
  return ok(await shop.run<{ data: SaleDto }>('sale.create', saleInput(extra))).data
}

async function postedSale(extra: object = {}): Promise<SaleDto> {
  const draft = await saleDraft(extra)
  return ok(
    await shop.run<{ data: SaleDto }>('sale.post', { id: draft.id, version: draft.version }),
  ).data
}

async function newChannel(): Promise<SalesChannelDto> {
  return ok(
    await shop.run<{ data: SalesChannelDto }>('channel.create', {
      id: newId(),
      name: `Channel ${tag()}`,
      kind: 'delivery_app',
    }),
  ).data
}

/** An import of a one-day summary (M3 Step 4): another file (its hash) each time. */
function importInput(extra: object = {}) {
  return {
    id: newId(),
    channelId,
    fileName: `sales ${tag()}.csv`,
    fileHash: randomBytes(32).toString('hex'),
    fingerprint: randomBytes(32).toString('hex'),
    shape: 'summary',
    periodFrom: today,
    periodTo: today,
    mapping: {
      headerRow: 0,
      columns: { name: 0, total: 1 },
      headers: { name: 'Item', total: 'Total' },
      dateOrder: 'dmy',
    },
    amountsIncludeVat: false,
    rowsRead: 1,
    rowsLeftOut: 0,
    errors: [],
    feesTotal: '12.5',
    rowCount: 1,
    ...extra,
  }
}

/** A staged row of the latte (matched by its name). */
const importRow = (extra: object = {}) => ({
  position: 0,
  businessDate: today,
  name: latte.name,
  code: null,
  qty: '2.5',
  amount: '45.75',
  refunds: '0.5',
  fileRows: 1,
  ...extra,
})

/** A draft import with its one row sent. */
async function importDraft(): Promise<SaleImportDto> {
  const created = ok(
    await shop.run<{ data: SaleImportDto }>('saleImport.create', importInput()),
  ).data
  ok(await shop.run('saleImport.addRows', { id: created.id, rows: [importRow()] }))
  return ok(await shop.run<{ data: SaleImportDto }>('saleImport.get', { id: created.id })).data
}

/** A channel statement's input (a draft), in its own channel unless given. */
function statementInput(channel: string, extra: object = {}) {
  return {
    id: newId(),
    channelId: channel,
    periodFrom: today,
    periodTo: today,
    sales: '1000.5',
    commission: '150.25',
    paymentFees: '10.5',
    otherFees: '2.25',
    ads: '3',
    refundsCharged: '1.5',
    payout: '832.99',
    notes: null,
    ...extra,
  }
}

async function statementDraft(): Promise<ChannelStatementDto> {
  const channel = await newChannel()
  return ok(
    await shop.run<{ data: ChannelStatementDto }>(
      'channelStatement.create',
      statementInput(channel.id),
    ),
  ).data
}

/** A customer of the shop (M3 Step 5). */
async function newCustomer(): Promise<CustomerDto> {
  return ok(await shop.run<CustomerDto>('customer.create', { id: newId(), name: `Ahmed ${tag()}` }))
}

/** An order of the latte with every decimal field (M3 Step 5): its discounts, delivery and deposit. */
function orderInput(customerId: string, extra: object = {}) {
  return {
    id: newId(),
    customerId,
    businessDate: today,
    channelId,
    discount: { amount: '1.25' },
    deliveryNeeded: true,
    deliveryCost: '4.75',
    lines: [
      {
        kind: 'item',
        id: newId(),
        productId: latte.id,
        qty: '2.5',
        unitPrice: '12.25',
        discount: { percent: '10' },
      },
      { kind: 'delivery', id: newId(), amount: '3.5' },
    ],
    ...extra,
  }
}

async function newOrder(deliver = false): Promise<OrderDto> {
  const created = ok(
    await shop.run<{ data: OrderDto }>('order.create', orderInput((await newCustomer()).id)),
  ).data
  if (!deliver) return created
  return ok(
    await shop.run<{ data: OrderDto }>('order.deliver', {
      id: created.id,
      version: created.version,
    }),
  ).data
}

/** The fields of an order's update (no id). */
function orderFields(customerId: string, extra: object = {}): Record<string, unknown> {
  const fields: Record<string, unknown> = orderInput(customerId, extra)
  delete fields.id
  return fields
}

/** A quotation with every decimal field (M3 Step 7): discounts, "Round the total", stages. */
function quotationInput(customerId: string, extra: object = {}) {
  return {
    id: newId(),
    customerId,
    businessDate: today,
    discount: { amount: '1.25' },
    roundTo: '50.5',
    lines: [
      {
        id: newId(),
        productId: latte.id,
        qty: '2.5',
        unitPrice: '12.25',
        discount: { percent: '10' },
      },
      { id: newId(), productId: null, description: 'Fitting', qty: '1.5', unitPrice: '9.75' },
    ],
    stages: [
      { due: 'Upon signing', percent: '62.5' },
      { due: 'On delivery', percent: '37.5' },
    ],
    ...extra,
  }
}

async function newQuotation(sent = false): Promise<QuotationDto> {
  const created = ok(
    await shop.run<QuotationDto>('quotation.create', quotationInput((await newCustomer()).id)),
  )
  if (!sent) return created
  return ok(
    await shop.run<QuotationDto>('quotation.send', { id: created.id, version: created.version }),
  )
}

/** The fields of a quotation's update (no id). */
function quotationFields(customerId: string, extra: object = {}): Record<string, unknown> {
  const fields: Record<string, unknown> = quotationInput(customerId, extra)
  delete fields.id
  return fields
}

/** The import the last digits case made (its rows are read back through it). */
let lastImportId = ''

// ---------------------------------------------------------------------------------------------------
// Digits
// ---------------------------------------------------------------------------------------------------

interface Variant {
  where?: Where
  /** A fresh valid input with every decimal field set (ASCII digits). */
  input: () => Promise<unknown>
  /** Where the numbers are read back when the answer does not carry them all. */
  readBack?: (data: unknown) => Promise<unknown>
}

/** The owner's minutes are read back from what products cost (the product's own answer omits them). */
const minutesOf = async (data: unknown) =>
  ok(await alone.run('product.costs', { ids: [(data as ProductDto).id] }))

const DIGITS: Record<string, Variant[]> = {
  'material.create': [{ input: async () => materialInput() }],
  'material.quickCreate': [{ input: async () => materialInput() }],
  'material.update': [
    {
      input: async () => {
        const material = await shop.material()
        return { ...materialInput(), id: material.id, version: material.version }
      },
    },
  ],
  'product.create': [
    { input: async () => productInput() },
    {
      input: async () =>
        productInput({
          resale: {
            materialId: newId(),
            packs: [{ id: newId(), name: 'case', qty: '24', ofUnit: 'piece' }],
            crossFactors: [{ id: newId(), unit: 'kg', qty: '0.35', ofUnit: 'piece' }],
          },
        }),
    },
    {
      where: 'alone',
      input: async () => productInput({ ownerMinutes: '7.5' }),
      readBack: minutesOf,
    },
  ],
  'product.update': [
    {
      input: async () => ({ ...fieldsOf(await shop.product()), defaultPrice: '21.25' }),
    },
    {
      where: 'alone',
      input: async () => ({ ...fieldsOf(await alone.product()), ownerMinutes: '12.5' }),
      readBack: minutesOf,
    },
  ],
  'recipe.save': [
    {
      input: async () => ({
        productId: (await shop.product()).id,
        version: 0,
        yieldQty: '2.5',
        lines: [{ id: newId(), materialId: beans.id, qty: '18.5', unit: 'g' }],
      }),
    },
  ],
  'purchase.create': [{ input: async () => fullPurchase() }],
  'purchase.update': [
    {
      input: async () => {
        const draft = await shop.draft(
          purchaseInput(today, [line(beans.id, '1', '1', { unit: 'kg' })]),
        )
        return { ...fullPurchase(), id: draft.id, version: draft.version }
      },
    },
  ],
  'purchaseReturn.create': [
    { input: () => returnInput('return') },
    { input: () => returnInput('credit_note') },
    { input: () => returnInput('credit_note', { lines: [], splitAmount: '2.5' }) },
  ],
  'purchaseReturn.update': [
    {
      input: async () => {
        const draft = await creditDraft()
        return {
          id: draft.id,
          version: draft.version,
          businessDate: today,
          lines: [],
          splitAmount: '3.75',
        }
      },
    },
  ],
  'purchasePayment.record': [
    {
      input: async () => ({
        id: newId(),
        purchaseId: (await onCredit()).id,
        businessDate: today,
        method: 'cash',
        amount: '12.5',
      }),
    },
  ],
  'expense.create': [{ input: async () => expenseInput() }],
  'expense.update': [
    {
      input: async () => {
        const draft = await shop.expenseDraft(expenseInput({ amount: '1' }))
        return { ...expenseInput(), id: draft.id, version: draft.version }
      },
    },
  ],
  'expensePayment.record': [
    {
      input: async () => ({
        id: newId(),
        expenseId: (await owedExpense()).id,
        businessDate: today,
        method: 'card',
        amount: '20.5',
      }),
    },
  ],
  'runningCost.create': [{ input: async () => runningCostInput() }],
  'runningCost.update': [
    {
      input: async () => {
        const cost = await shop.runningCost(runningCostInput({ amount: '1' }))
        return { ...runningCostInput(), id: cost.id, version: cost.version }
      },
    },
  ],
  'productCost.updateSettings': [
    { where: 'alone', input: async () => ({ ownerHourlyRate: '45.5' }) },
  ],
  'channel.create': [
    {
      input: async () => ({
        id: newId(),
        name: `Talabat ${tag()}`,
        kind: 'delivery_app',
        feePercent: '17.5',
      }),
    },
  ],
  'channel.update': [
    {
      input: async () => {
        const channel = await newChannel()
        return {
          id: channel.id,
          version: channel.version,
          name: channel.name,
          kind: channel.kind,
          feePercent: '12.75',
        }
      },
    },
  ],
  'sale.create': [{ input: async () => saleInput() }],
  // Orders, customer payments and refunds (M3 Step 5).
  'order.create': [
    {
      input: async () =>
        orderInput((await newCustomer()).id, {
          payment: { id: newId(), method: 'cash', amount: '5.5' },
        }),
    },
  ],
  'order.update': [
    {
      input: async () => {
        const order = await newOrder()
        return { ...orderFields(order.customerId ?? ''), id: order.id, version: order.version }
      },
    },
  ],
  'customerPayment.record': [
    {
      input: async () => ({
        id: newId(),
        orderId: (await newOrder()).id,
        businessDate: today,
        method: 'cash',
        amount: '7.25',
      }),
    },
  ],
  // Quotations (M3 Step 7), and the letterhead's phones on the business profile.
  'business.updateProfile': [
    {
      input: async () => {
        const profile = ok(await shop.run<BusinessProfileDto>('business.profile'))
        return {
          version: profile.version,
          legalName: profile.legalName,
          legalNameAr: profile.legalNameAr,
          vatRegistered: profile.vatRegistered,
          trn: profile.vatRegistered ? (profile.trn ?? '100123456700003') : null,
          letterhead: { phone: '0501234567', phone2: '04 555 0142' },
        }
      },
    },
  ],
  'quotation.create': [{ input: async () => quotationInput((await newCustomer()).id) }],
  'quotation.update': [
    {
      input: async () => {
        const quotation = await newQuotation()
        return {
          ...quotationFields(quotation.customerId),
          id: quotation.id,
          version: quotation.version,
        }
      },
    },
  ],
  'customerPayment.recordMany': [
    {
      input: async () => {
        const order = await newOrder()
        return {
          customerId: order.customerId,
          businessDate: today,
          method: 'card',
          amount: '6.75',
          documents: [{ id: newId(), orderId: order.id }],
        }
      },
    },
  ],
  'sale.refund': [
    {
      input: async () => {
        const order = await newOrder(true)
        const sale = ok(await shop.run<{ data: SaleDto }>('sale.get', { id: order.saleId })).data
        return {
          id: newId(),
          orderId: order.id,
          by: 'quantity',
          lines: [{ lineId: sale.lines[0]?.id, qty: '1.5' }],
        }
      },
    },
    {
      input: async () => {
        const sale = await postedSale()
        return {
          id: newId(),
          saleId: sale.id,
          by: 'amount',
          lines: [{ lineId: sale.lines[0]?.id, amount: '2.25' }],
        }
      },
    },
  ],
  'sale.update': [
    {
      input: async () => {
        const draft = await saleDraft({ deliveryCost: '1', lines: [] })
        return { ...saleFields(), id: draft.id, version: draft.version }
      },
    },
  ],
  'sale.fillDeliveryCost': [
    {
      input: async () => ({
        id: (await postedSale({ deliveryCost: undefined })).id,
        deliveryCost: '6.25',
      }),
    },
  ],
  'saleImport.create': [{ input: async () => importInput() }],
  'saleImport.addRows': [
    {
      input: async () => {
        lastImportId = ok(
          await shop.run<{ data: SaleImportDto }>('saleImport.create', importInput()),
        ).data.id
        return { id: lastImportId, rows: [importRow()] }
      },
      readBack: async () =>
        ok(await shop.run<{ data: SaleImportDto }>('saleImport.get', { id: lastImportId })).data
          .names,
    },
  ],
  'channelStatement.create': [{ input: async () => statementInput(channelId) }],
  'channelStatement.update': [
    {
      input: async () => {
        const draft = await statementDraft()
        const fields: Record<string, unknown> = statementInput(draft.channelId, {
          commission: '99.75',
        })
        delete fields.channelId
        return { ...fields, id: draft.id, version: draft.version }
      },
    },
  ],
  // A phone number is not a quantity, but it is typed with the same keyboard.
  'supplier.create': [
    { input: async () => ({ id: newId(), name: `Dairy ${tag()}`, phone: '0501234567' }) },
  ],
  'supplier.update': [
    {
      input: async () => {
        const created = await shop.supplier()
        return { id: created.id, version: created.version, name: created.name, phone: '0509876543' }
      },
    },
  ],
  'customer.create': [
    { input: async () => ({ id: newId(), name: `Ahmed ${tag()}`, phone: '0501234567' }) },
  ],
  'customer.update': [
    {
      input: async () => {
        const created = await newCustomer()
        return { id: created.id, version: created.version, name: created.name, phone: '0509876543' }
      },
    },
  ],
}

function decimalPaths(path: string): string[] {
  const schema = inputSchemaOf(appRouter, path)
  return (schema ? inputLeaves(schema) : [])
    .filter((l) => isDecimalLeaf(l.schema))
    .map((l) => l.path)
}

const WITH_DECIMALS = MUTATIONS.filter((p) => decimalPaths(p.path).length > 0).map((p) => p.path)

describe('every quantity and price is read the same in ASCII, Arabic-Indic and Eastern Arabic-Indic digits', () => {
  it('every mutation with a decimal field has inputs here, and no query has one', () => {
    expect(Object.keys(DIGITS).sort()).toEqual(WITH_DECIMALS)
    const queries = proceduresOf(appRouter).filter((p) => p.type === 'query')
    expect(queries.filter((p) => decimalPaths(p.path).length > 0).map((p) => p.path)).toEqual([])
  })

  it.each(WITH_DECIMALS)('%s', async (path) => {
    const paths = decimalPaths(path)
    for (const variant of DIGITS[path] ?? []) {
      const scope = scopeOf(variant.where)
      const answers = {} as Record<Digits, Record<string, string>>
      for (const digits of ['ascii', 'arabic', 'eastern'] as const) {
        const input = await variant.input()
        const spelled = mapAtPaths(input, paths, (value) =>
          typeof value === 'string' ? spell(value, digits) : value,
        )
        if (digits !== 'ascii') {
          expect(JSON.stringify(spelled), 'every number respelled').not.toMatch(
            new RegExp(`"(?:${paths.map((p) => p.split('.').at(-1)).join('|')})":"[0-9]`),
          )
        }
        const result = await scope.run(path, spelled)
        expect(result.error, `${digits}: ${result.raw}`).toBeUndefined()
        answers[digits] = decimalsIn(
          variant.readBack ? await variant.readBack(result.data) : result.data,
        )
      }
      expect(Object.keys(answers.ascii).length, path).toBeGreaterThan(0)
      expect(answers.arabic, `${path} arabic`).toEqual(answers.ascii)
      expect(answers.eastern, `${path} eastern`).toEqual(answers.ascii)
    }
  })
})

// ---------------------------------------------------------------------------------------------------
// Idempotent creates
// ---------------------------------------------------------------------------------------------------

interface Create {
  where?: Where
  input: () => Promise<Record<string, unknown>>
  /** The same id with another payload. */
  other: (input: Record<string, unknown>) => Promise<Record<string, unknown>>
}

const renamed = async (input: Record<string, unknown>) => ({ ...input, name: `Other ${tag()}` })

const CREATES: Record<string, Create> = {
  'location.create': {
    input: async () => ({ id: newId(), name: `Branch ${tag()}` }),
    other: renamed,
  },
  'invitation.create': {
    input: async () => {
      const roles = ok(await shop.run<RoleDto[]>('role.list'))
      return {
        id: newId(),
        email: `idem-${tag()}@test.bizcost.local`,
        roleId: roles.find((r) => r.templateKey === 'employee')!.id,
        locale: 'en',
      }
    },
    other: async (input) => ({ ...input, email: `other-${tag()}@test.bizcost.local` }),
  },
  'material.create': { input: async () => materialInput(), other: renamed },
  'material.quickCreate': { input: async () => materialInput(), other: renamed },
  'product.create': { input: async () => productInput(), other: renamed },
  'supplier.create': {
    input: async () => ({ id: newId(), name: `Dairy ${tag()}` }),
    other: renamed,
  },
  'costCategory.create': {
    input: async () => ({ id: newId(), name: `Category ${tag()}` }),
    other: renamed,
  },
  'purchase.create': {
    input: async () => fullPurchase(),
    other: async (input) => ({ ...input, reference: `Other ${tag()}` }),
  },
  'purchaseReturn.create': {
    input: () => returnInput('return'),
    other: async (input) => ({ ...input, reference: `Other ${tag()}` }),
  },
  'purchasePayment.record': {
    input: async () => ({
      id: newId(),
      purchaseId: (await onCredit()).id,
      businessDate: today,
      method: 'cash',
      amount: '5',
    }),
    other: async (input) => ({ ...input, amount: '6' }),
  },
  'purchase.correct': {
    input: async () => ({ id: (await postedPurchase()).id, newId: newId() }),
    other: async (input) => ({ ...input, id: (await postedPurchase()).id }),
  },
  'expense.create': {
    input: async () => expenseInput(),
    other: async (input) => ({ ...input, amount: '99' }),
  },
  'expensePayment.record': {
    input: async () => ({
      id: newId(),
      expenseId: (await owedExpense()).id,
      businessDate: today,
      method: 'cash',
      amount: '5',
    }),
    other: async (input) => ({ ...input, amount: '6' }),
  },
  'expense.correct': {
    input: async () => ({ id: (await shop.spend(expenseInput())).id, newId: newId() }),
    other: async (input) => ({ ...input, id: (await shop.spend(expenseInput())).id }),
  },
  'runningCost.create': {
    input: async () => runningCostInput(),
    other: async (input) => ({ ...input, amount: '999' }),
  },
  'channel.create': {
    input: async () => ({ id: newId(), name: `Channel ${tag()}`, kind: 'other' }),
    other: renamed,
  },
  'sale.create': {
    input: async () => saleInput(),
    other: async (input) => ({ ...input, notes: `Other ${tag()}` }),
  },
  'sale.correct': {
    input: async () => ({ id: (await postedSale()).id, newId: newId() }),
    other: async (input) => ({ ...input, id: (await postedSale()).id }),
  },
  // M3 Step 5.
  'customer.create': {
    input: async () => ({ id: newId(), name: `Ahmed ${tag()}`, phone: '050 111 2222' }),
    other: async (input) => ({ ...input, phone: '050 333 4444' }),
  },
  'order.create': {
    input: async () =>
      orderInput((await newCustomer()).id, {
        payment: { id: newId(), method: 'cash', amount: '5' },
      }),
    other: async (input) => ({ ...input, notes: `Other ${tag()}` }),
  },
  'customerPayment.record': {
    input: async () => ({
      id: newId(),
      orderId: (await newOrder()).id,
      businessDate: today,
      method: 'cash',
      amount: '5',
    }),
    other: async (input) => ({ ...input, amount: '6' }),
  },
  'sale.refund': {
    input: async () => {
      const sale = await postedSale()
      return {
        id: newId(),
        saleId: sale.id,
        by: 'amount',
        lines: [{ lineId: sale.lines[0]?.id, amount: '1' }],
      }
    },
    other: async (input) => ({ ...input, notes: `Other ${tag()}` }),
  },
  // Quotations (M3 Step 7): a quotation, a revision and a copy name their new revision.
  'quotation.create': {
    input: async () => quotationInput((await newCustomer()).id),
    other: async (input) => ({ ...input, notes: `Other ${tag()}` }),
  },
  'quotation.revise': {
    input: async () => ({ id: (await newQuotation(true)).id, newId: newId() }),
    other: async (input) => ({ ...input, id: (await newQuotation(true)).id }),
  },
  'quotation.copy': {
    input: async () => ({ id: (await newQuotation()).id, newId: newId() }),
    other: async (input) => ({ ...input, customerId: (await newCustomer()).id }),
  },
  'saleImport.create': {
    input: async () => importInput(),
    other: async (input) => ({ ...input, fileName: `other ${tag()}.csv` }),
  },
  'channelStatement.create': {
    input: async () => statementInput(channelId),
    other: async (input) => ({ ...input, commission: '1' }),
  },
}

/** Not a create although its input names a row: why. */
const NOT_CREATES: Record<string, string> = {
  'account.setLastBusiness': 'names a business the caller already belongs to (FORBIDDEN otherwise)',
  'business.createFromSetup':
    'idempotent on businessId, proven below in its own business (setup.api.test.ts has the rest)',
  'sale.fillDeliveryCost':
    'fills a finalized sale’s missing delivery cost once (DOCUMENT_POSTED after), never makes a row',
  'saleImport.addRows':
    'adds a draft import’s rows by their position (a position sent again adds nothing), never a draft',
  'saleImport.match':
    'saves the answers for a draft import’s names (an alias a name or code; a new product by its own client id)',
  'saleImport.reverse':
    'reverses a finalized import or one of its days (idempotent), never makes a row of its own',
  'quotation.toOrder':
    'makes the order of an accepted quotation once: a repeat returns the order made whatever orderId it sends (an orderId another order has is CONFLICT), proven in quotations.api.test.ts',
}

function topLevelKeys(path: string): Set<string> {
  const schema = inputSchemaOf(appRouter, path)
  return new Set((schema ? inputLeaves(schema) : []).map((l) => l.path.split('.')[0] ?? ''))
}

/**
 * Takes only an id (and its version, a reason, or what an expense pays, optional: D-216): an
 * operation on a row that exists.
 */
const BY_ID = MUTATIONS.filter((p) => {
  const keys = [...topLevelKeys(p.path)]
  return keys.includes('id') && keys.every((k) => ['id', 'version', 'reason', 'pays'].includes(k))
}).map((p) => p.path)

describe('idempotent creates replay safely', () => {
  it('every mutation that names its new row by a client id is here', () => {
    const naming = MUTATIONS.filter((p) => {
      const keys = topLevelKeys(p.path)
      return (
        ['id', 'businessId', 'newId'].some((k) => keys.has(k)) &&
        !keys.has('version') &&
        !BY_ID.includes(p.path)
      )
    }).map((p) => p.path)
    expect(naming.sort()).toEqual(Object.keys({ ...CREATES, ...NOT_CREATES }).sort())
  })

  it.each(Object.keys(CREATES))('%s', async (path) => {
    const create = CREATES[path]!
    const scope = scopeOf(create.where)
    const input = await create.input()
    const otherInput = await create.other(input)
    const sent = api.emails.sent.length
    const first = ok(await scope.run(path, input))
    const written = await businessDigest(api.admin, scope.id)

    // The same request again: the same answer, nothing written (not even an audit row).
    expect(ok(await scope.run(path, input)), 'replay').toEqual(first)
    expect(await businessDigest(api.admin, scope.id), 'replay writes nothing').toEqual(written)
    // Another payload under that id: CONFLICT, nothing written.
    const other = await scope.run(path, otherInput)
    expect(codeOf(other), other.raw).toBe('conflict')
    expect(await businessDigest(api.admin, scope.id), 'conflict writes nothing').toEqual(written)
    // An invitation is sent once.
    if (path === 'invitation.create') expect(api.emails.sent.length).toBe(sent + 1)

    // Twice at the same time: both served, the same row.
    const again = await create.input()
    const [a, b] = await Promise.all([scope.run(path, again), scope.run(path, again)])
    expect(a.error, a.raw).toBeUndefined()
    expect(b.error, b.raw).toBeUndefined()
    expect(b.data).toEqual(a.data)
  })

  it('business.createFromSetup: the same business again, another payload under its id is CONFLICT', async () => {
    const owner = await api.person()
    const input = {
      businessId: newId(),
      legalName: `Idempotent ${tag()}`,
      locale: 'en',
      questionSetVersion: QUESTION_SET_VERSION,
      answers: WORKSHOP,
      adjustments: { modules: [], capabilities: [] },
    }
    const call = (body: object) =>
      mutate(api.handler, 'business.createFromSetup', { token: owner.token, input: body })
    const first = ok(await call(input))
    const written = await businessDigest(api.admin, input.businessId)
    expect(ok(await call(input))).toEqual(first)
    expect(await businessDigest(api.admin, input.businessId)).toEqual(written)
    expect(codeOf(await call({ ...input, legalName: `Other ${tag()}` }))).toBe('conflict')
    expect(await businessDigest(api.admin, input.businessId)).toEqual(written)
  })

  it('every mutation that takes only an id names a row that exists: NOT_FOUND for any other', async () => {
    expect(BY_ID).toEqual(
      expect.arrayContaining(['purchase.post', 'expense.reverse', 'material.archive']),
    )
    for (const path of BY_ID) {
      const keys = topLevelKeys(path)
      const input = {
        id: newId(),
        ...(keys.has('version') ? { version: 1 } : {}),
        ...(keys.has('reason') ? { reason: 'Why' } : {}),
      }
      const result = await shop.run(path, input)
      expect(codeOf(result), `${path}: ${result.raw}`).toBe('not_found')
    }
  })
})

// ---------------------------------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------------------------------

/** A valid input at the version the record has now. */
type Versioned = () => Promise<Record<string, unknown> & { version: number }>

async function newMember() {
  const member = await api.member(shop, 'employee')
  const { version } = ok(
    await shop.run<MemberPermissionsDto>('member.permissions', { memberId: member.memberId }),
  )
  return { memberId: member.memberId, version }
}

async function expenseDraft() {
  return shop.expenseDraft(expenseInput())
}

async function submitted(): Promise<ExpenseDto> {
  const draft = await expenseDraft()
  return ok(
    await shop.run<{ data: ExpenseDto }>('expense.submit', {
      id: draft.id,
      version: draft.version,
    }),
  ).data
}

async function purchaseDraft() {
  return shop.draft(purchaseInput(today, [line(beans.id, '1', '3', { unit: 'kg' })]))
}

async function returnDraft() {
  const purchase = await postedPurchase()
  return shop.returnDraft({
    id: newId(),
    purchaseId: purchase.id,
    kind: 'return',
    businessDate: today,
    lines: [{ id: newId(), purchaseLineId: purchase.lines[0]!.id, qty: '1' }],
  })
}

const VERSIONED: Record<string, Versioned> = {
  'business.updateProfile': async () => {
    const profile = ok(await shop.run<BusinessProfileDto>('business.profile'))
    return {
      version: profile.version,
      legalName: profile.legalName,
      legalNameAr: `اسم ${tag()}`,
      vatRegistered: profile.vatRegistered,
      trn: profile.trn ?? (profile.vatRegistered ? '100123456700003' : null),
    }
  },
  'costCategory.update': async () => {
    const created = await shop.category()
    return { id: created.id, version: created.version, name: `Renamed ${tag()}` }
  },
  'location.rename': async () => {
    const created = ok(
      await shop.run<LocationDto>('location.create', { id: newId(), name: `Branch ${tag()}` }),
    )
    return { id: created.id, version: created.version, name: `Renamed ${tag()}` }
  },
  'material.update': async () => {
    const material = await shop.material()
    return { ...materialInput(), id: material.id, version: material.version }
  },
  'member.updatePermissions': async () => ({
    ...(await newMember()),
    overrides: [{ key: 'suppliers.items.view', effect: 'allow' }],
  }),
  'product.update': async () => ({ ...fieldsOf(await shop.product()), defaultPrice: '9' }),
  'role.updatePermissions': async () => {
    const roles = ok(await shop.run<RoleDto[]>('role.list'))
    const sales = roles.find((r) => r.templateKey === 'sales')!
    const keys = new Set(sales.permissionKeys)
    if (keys.has('settings.business.view')) keys.delete('settings.business.view')
    else keys.add('settings.business.view')
    return { id: sales.id, version: sales.version, permissionKeys: [...keys] }
  },
  'recipe.save': async () => {
    const product = await shop.product()
    const saved: RecipeDto = await shop.recipe(product.id, [
      { id: newId(), materialId: beans.id, qty: '10', unit: 'g' },
    ])
    return {
      productId: product.id,
      version: saved.version,
      lines: [{ id: newId(), materialId: beans.id, qty: '12', unit: 'g' }],
    }
  },
  'supplier.update': async () => {
    const created = await shop.supplier()
    return { id: created.id, version: created.version, name: `Renamed ${tag()}` }
  },
  'runningCost.update': async () => {
    const cost: RunningCostDto = await shop.runningCost(runningCostInput())
    return { ...runningCostInput({ amount: '7' }), id: cost.id, version: cost.version }
  },
  'runningCost.remove': async () => {
    const cost = await shop.runningCost(runningCostInput())
    return { id: cost.id, version: cost.version }
  },
  'purchase.update': async () => {
    const draft = await purchaseDraft()
    return { ...fullPurchase(), id: draft.id, version: draft.version }
  },
  'purchase.discard': async () => {
    const draft = await purchaseDraft()
    return { id: draft.id, version: draft.version }
  },
  'purchase.post': async () => {
    const draft = await purchaseDraft()
    return { id: draft.id, version: draft.version }
  },
  'purchaseReturn.update': async () => {
    const draft = await returnDraft()
    return {
      id: draft.id,
      version: draft.version,
      businessDate: today,
      lines: draft.lines.map((l) => ({ id: l.id, purchaseLineId: l.purchaseLineId, qty: '0.5' })),
    }
  },
  'purchaseReturn.discard': async () => {
    const draft = await returnDraft()
    return { id: draft.id, version: draft.version }
  },
  'purchaseReturn.post': async () => {
    const draft = await returnDraft()
    return { id: draft.id, version: draft.version }
  },
  'expense.update': async () => {
    const draft = await expenseDraft()
    return { ...expenseInput({ amount: '7' }), id: draft.id, version: draft.version }
  },
  'expense.discard': async () => {
    const draft = await expenseDraft()
    return { id: draft.id, version: draft.version }
  },
  'expense.submit': async () => {
    const draft = await expenseDraft()
    return { id: draft.id, version: draft.version }
  },
  'expense.post': async () => {
    const draft = await expenseDraft()
    return { id: draft.id, version: draft.version }
  },
  'expense.approve': async () => {
    const sent = await submitted()
    return { id: sent.id, version: sent.version }
  },
  'expense.reject': async () => {
    const sent = await submitted()
    return { id: sent.id, version: sent.version, reason: 'Not ours' }
  },
  'channel.update': async () => {
    const channel = await newChannel()
    return { id: channel.id, version: channel.version, name: `Renamed ${tag()}`, kind: 'other' }
  },
  'sale.update': async () => {
    const draft = await saleDraft()
    return { ...saleFields({ notes: 'Changed' }), id: draft.id, version: draft.version }
  },
  'sale.discard': async () => {
    const draft = await saleDraft()
    return { id: draft.id, version: draft.version }
  },
  'sale.post': async () => {
    const draft = await saleDraft()
    return { id: draft.id, version: draft.version }
  },
  'saleImport.setOverlap': async () => {
    const draft = await importDraft()
    return { id: draft.id, version: draft.version, overlap: 'replace' }
  },
  'saleImport.discard': async () => {
    const draft = await importDraft()
    return { id: draft.id, version: draft.version }
  },
  'saleImport.post': async () => {
    const draft = await importDraft()
    return { id: draft.id, version: draft.version }
  },
  'channelStatement.update': async () => {
    const draft = await statementDraft()
    const fields: Record<string, unknown> = statementInput(draft.channelId, { ads: '4' })
    delete fields.channelId
    return { ...fields, id: draft.id, version: draft.version }
  },
  'channelStatement.discard': async () => {
    const draft = await statementDraft()
    return { id: draft.id, version: draft.version }
  },
  'channelStatement.post': async () => {
    const draft = await statementDraft()
    return { id: draft.id, version: draft.version }
  },
  // M3 Step 5.
  'customer.update': async () => {
    const customer = await newCustomer()
    return { id: customer.id, version: customer.version, name: `Renamed ${tag()}` }
  },
  'order.update': async () => {
    const order = await newOrder()
    return {
      ...orderFields(order.customerId ?? '', { notes: 'Changed' }),
      id: order.id,
      version: order.version,
    }
  },
  'order.cancel': async () => {
    const order = await newOrder()
    return { id: order.id, version: order.version }
  },
  'order.deliver': async () => {
    const order = await newOrder()
    return { id: order.id, version: order.version }
  },
  // Quotations and Settings → Documents (M3 Step 7).
  'quotation.update': async () => {
    const quotation = await newQuotation()
    return {
      ...quotationFields(quotation.customerId, { notes: 'Changed' }),
      id: quotation.id,
      version: quotation.version,
    }
  },
  'quotation.discard': async () => {
    const quotation = await newQuotation()
    return { id: quotation.id, version: quotation.version }
  },
  'quotation.send': async () => {
    const quotation = await newQuotation()
    return { id: quotation.id, version: quotation.version }
  },
  'quotation.accept': async () => {
    const quotation = await newQuotation(true)
    return { id: quotation.id, version: quotation.version }
  },
  'quotation.decline': async () => {
    const quotation = await newQuotation(true)
    return { id: quotation.id, version: quotation.version }
  },
  'document.updateSettings': async () => {
    const current = ok(await shop.run<DocumentSettingsDto>('document.settings'))
    return {
      version: current.version,
      series: [],
      footer: `Bank ${tag()}`,
      quotationTerms: null,
      quotationValidDays: 14,
      accent: 'teal',
      watermark: true,
      wholeAmounts: false,
      signatory: null,
    }
  },
  'member.updateLocations': async () => {
    const member = await api.member(shop, 'employee')
    const { version } = ok(
      await shop.run<{ version: number }>('member.locations', { memberId: member.memberId }),
    )
    return { memberId: member.memberId, version, locationIds: [] }
  },
}

const WITH_VERSION = MUTATIONS.filter((p) => topLevelKeys(p.path).has('version')).map((p) => p.path)

describe('a version other than the one read is CONFLICT', () => {
  it('every mutation that takes a version is here', () => {
    expect(Object.keys(VERSIONED).sort()).toEqual(WITH_VERSION)
  })

  it.each(WITH_VERSION)('%s', async (path) => {
    const input = await VERSIONED[path]!()
    const before = await businessDigest(api.admin, shop.id)
    const others = [input.version + 1, ...(input.version > 1 ? [input.version - 1] : [])]
    for (const version of others) {
      const result: CallResult = await shop.run(path, { ...input, version })
      expect(codeOf(result), `version ${version} of ${input.version}: ${result.raw}`).toBe(
        'conflict',
      )
    }
    expect(await businessDigest(api.admin, shop.id), 'nothing written').toEqual(before)
    const served = await shop.run(path, input)
    expect(served.error, served.raw).toBeUndefined()
  })
})

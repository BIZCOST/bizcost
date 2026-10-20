import { randomBytes } from 'node:crypto'
import type {
  CreditNoteDto,
  DocumentImageUploadUrlDto,
  InvoiceDto,
  QuotationDto,
  CustomerDto,
  CustomerPaymentDto,
  DocumentPaymentsDto,
  OrderDto,
  ChannelStatementDto,
  ImportProfileDto,
  ImportProfileListDto,
  SaleImportDto,
  AttachmentDto,
  AttachmentUploadUrlDto,
  BooksDto,
  BusinessProfileDto,
  CostCategoryDto,
  ExpenseDto,
  ExpensePaymentsDto,
  InvitationDto,
  LocationDto,
  LogoUploadUrlDto,
  MaterialDto,
  MemberDto,
  ProductDto,
  PurchaseDto,
  PurchasePaymentDto,
  PurchasePaymentsDto,
  PurchaseReturnDto,
  RecipeDto,
  RoleDto,
  RunningCostDto,
  SaleDto,
  SalesChannelDto,
  SupplierDto,
} from '@bizcost/contracts'
import type { Db } from '@bizcost/db'
import { newId } from '@bizcost/domain'
import type { RoleTemplateKey } from '@bizcost/modules'
import type { AnyRouter } from '@trpc/server'
import { expect } from 'vitest'
import { middlewareMarkers } from '../../src/trpc'
import {
  connectAdmin,
  connectApi,
  createUser,
  deleteUser,
  handlerFor,
  mintToken,
  mutate,
  query,
  SECRET_KEY,
  type Admin,
  type CallResult,
  type TestUser,
} from '../helpers'
import { CapturedEmails, join, setupBusiness, WORKSHOP } from '../settings'

// Fixture of the Step 9 hardening suites (ROADMAP.md Step 9): two businesses, each with its owner, a
// second user (Admin) and an Employee, made through the real API the way the web makes them (Smart
// Setup with every capability on, so every procedure is reachable), with a branch, a pending
// invitation, a saved logo and an issued upload. Also: how a procedure is classified (public, authed,
// business; query or mutation) straight from the router, the strings that identify a business's data
// in a response, and a digest of everything a business has in the database and in Storage.
//
// The Costing Core is released (M2 Step 7), so the suites run the API as deployed, without the
// dev-only preview (D-125). Each business also has a supplier, a posted purchase with a receipt
// attached, a draft purchase, a posted return and a draft return (M2 Step 3), a recipe for its product
// (a line in the material's carton) and an item bought ready to sell with its material (M2 Step 4),
// and a purchase bought on credit with a payment recorded on it (the owner's requests of 2026-09-29).
// M2 Step 5: expenses need approval in each business; each has a category of its own, an expense
// bought on credit with a receipt and a payment, a draft expense, one sent for approval, and a
// running cost. M2 Step 6: the Cost Engine is previewed too (product costs and their settings).
//
// M3 (released with Release A, Step 6, so the suites run the API as deployed again): each business
// also has a sales channel of its own (with a commission %), a finalized sale with delivery charged and
// its cost, and a draft of Today's sales (Step 2); Reports' profit.summary and the Dashboard's cards
// read the same sale (Step 3); a customer, a pending order with its deposit and its LPO, a delivered
// order refunded by amount (with the money given back), and a One sale "they'll pay later" partly paid
// (Step 5).
//
// M3 Step 7: Quotations is planned until Release B, so the suites run with the dev-only preview of
// Quotations (D-125) and attack its procedures like the others. Each business also has the letterhead's
// contact lines, a signature image (Settings → Documents), a draft quotation (a product line and a
// typed line with its area, details, note and picture) and a sent one.
//
// M3 Step 8: Invoices is planned until Release B too, so it is previewed with Quotations. Each business
// also has an issued (plain) invoice of the customer (a product line and a typed one, its LPO and a
// payment on it), a draft invoice, an issued credit note of the invoice and a draft credit note.

export type Handler = ReturnType<typeof handlerFor>

export interface Person {
  user: TestUser
  token: string
}

export interface Api {
  db: Db
  admin: Admin
  handler: Handler
  emails: CapturedEmails
  newPerson: (metadata?: Record<string, unknown>) => Promise<Person>
  close: () => Promise<void>
}

/** The API as deployed (secret key for Storage, emails kept instead of sent), and its test users. */
export function openApi(router?: AnyRouter): Api {
  const db = connectApi()
  const admin = connectAdmin()
  const emails = new CapturedEmails()
  const handler = handlerFor(
    db,
    router,
    { supabaseSecretKey: SECRET_KEY, previewModules: ['quotations', 'invoices'] },
    { emailSender: emails },
  )
  const users: TestUser[] = []
  return {
    db,
    admin,
    handler,
    emails,
    newPerson: async (metadata = { locale: 'en' }) => {
      const user = await createUser(metadata)
      users.push(user)
      return { user, token: await mintToken(user) }
    },
    close: async () => {
      for (const user of users) await deleteUser(user)
      await admin.end()
      await db.$client.end()
    },
  }
}

// ---------------------------------------------------------------------------------------------------
// Procedures, as the router defines them
// ---------------------------------------------------------------------------------------------------

export type Base = 'public' | 'authed' | 'business'
export type ProcedureType = 'query' | 'mutation'

export interface ProcedureInfo {
  path: string
  /** From the middlewares: businessScoped → business, authed → authed, neither → public. */
  base: Base
  type: ProcedureType
  takesInput: boolean
}

interface ProcedureDef {
  type: string
  inputs: unknown[]
  middlewares: unknown[]
}

export function proceduresOf(router: AnyRouter): ProcedureInfo[] {
  return Object.entries(router._def.procedures as Record<string, { _def: ProcedureDef }>)
    .map(([path, procedure]) => {
      const def = procedure._def
      const base: Base = def.middlewares.includes(middlewareMarkers.businessScoped)
        ? 'business'
        : def.middlewares.includes(middlewareMarkers.authed)
          ? 'authed'
          : 'public'
      if (def.type !== 'query' && def.type !== 'mutation') {
        throw new Error(`${path}: ${def.type} procedures are not covered by the hardening suites`)
      }
      const type: ProcedureType = def.type
      return { path, base, type, takesInput: def.inputs.length > 0 }
    })
    .sort((a, b) => a.path.localeCompare(b.path))
}

export interface CallAs {
  businessId?: string
  input?: unknown
  headers?: Record<string, string>
}

/** Calls a procedure as `token` over HTTP: GET for a query, POST for a mutation (Bearer: no Origin). */
export function callProcedure<T = unknown>(
  handler: Handler,
  procedure: Pick<ProcedureInfo, 'path' | 'type'>,
  token: string | undefined,
  options: CallAs = {},
): Promise<CallResult<T>> {
  const call = procedure.type === 'query' ? query<T> : mutate<T>
  return call(handler, procedure.path, {
    ...(token ? { token } : {}),
    ...(options.businessId ? { businessId: options.businessId } : {}),
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.input !== undefined ? { input: options.input } : {}),
  })
}

// ---------------------------------------------------------------------------------------------------
// A business with a team
// ---------------------------------------------------------------------------------------------------

/** A valid 1×1 PNG. */
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

export interface Tenant {
  id: string
  label: string
  legalName: string
  legalNameAr: string
  owner: Person
  admin: Person
  employee: Person
  ownerMemberId: string
  adminMemberId: string
  employeeMemberId: string
  roles: Record<RoleTemplateKey, RoleDto>
  defaultLocationId: string
  branch: LocationDto
  invitation: InvitationDto
  /** The raw token of the pending invitation's link. */
  invitationToken: string
  /** The saved logo's object path. */
  logoPath: string
  /** An upload URL issued (registered, still open) but not used. */
  openUpload: LogoUploadUrlDto
  /** A material with two packs (1 carton = 12 bottles, 1 bottle = 1 l). */
  material: MaterialDto
  /** A product sold at the branch only. */
  product: ProductDto
  supplier: SupplierDto
  /** A posted purchase of the material from the supplier, with a receipt attached. */
  purchase: PurchaseDto
  /** A draft purchase. */
  draftPurchase: PurchaseDto
  /** A posted return of part of the purchase. */
  purchaseReturn: PurchaseReturnDto
  /** A draft credit note on the purchase. */
  draftReturn: PurchaseReturnDto
  /** The receipt attached to the purchase. */
  attachment: AttachmentDto
  /** The product's recipe: half a carton of the material. */
  recipe: RecipeDto
  /** A product bought ready to sell (its material made with it, bought in cases of 6). */
  resaleProduct: ProductDto
  /** A posted purchase bought on credit from the supplier, partly paid. */
  creditPurchase: PurchaseDto
  /** The payment recorded on it. */
  payment: PurchasePaymentDto
  /** A category of its own (besides the starter ones every business has). */
  category: CostCategoryDto
  /**
   * The running cost's category, apart from the expenses' (an expense in a category that has a
   * running cost says what it pays before it is final, D-216).
   */
  runningCategory: CostCategoryDto
  /** A posted expense bought on credit from the supplier, with a receipt and a payment. */
  expense: ExpenseDto
  /** Its receipt. */
  expenseAttachment: AttachmentDto
  /** The payment recorded on it. */
  expensePayment: PurchasePaymentDto
  /** A draft expense. */
  draftExpense: ExpenseDto
  /** An expense sent for approval. */
  submittedExpense: ExpenseDto
  /** A running cost. */
  runningCost: RunningCostDto
  /** A sales channel of its own (a delivery app with a commission %). */
  channel: SalesChannelDto
  /** A finalized sale of the product in the channel, with delivery charged and its cost. */
  sale: SaleDto
  /** A draft of Today's sales in the channel. */
  draftSale: SaleDto
  /**
   * A finalized import of the product in the channel at the branch (M3 Step 4), its fee column the
   * channel's statement for today.
   */
  saleImport: SaleImportDto
  /** The statement made from its fee column. */
  statement: ChannelStatementDto
  /** A draft import with its row sent (another file). */
  draftImport: SaleImportDto
  /** The layout its file was imported with. */
  importProfile: ImportProfileDto
  /** A customer of its own (M3 Step 5). */
  customer: CustomerDto
  /** A pending order of the customer (with an LPO reference), its deposit recorded. */
  order: OrderDto
  /** The deposit recorded with it. */
  orderPayment: CustomerPaymentDto
  /** A delivered order (its sale posted), refunded 5 by amount with the money given back. */
  deliveredOrder: OrderDto
  /** The refund of the delivered order's sale. */
  refund: SaleDto
  /** A One sale of the customer "they'll pay later", finalized, partly paid. */
  payLaterSale: SaleDto
  /** The payment recorded on it. */
  salePayment: CustomerPaymentDto
  /** M3 Step 7: a draft quotation of the customer (a product line, a typed line with a picture). */
  quotation: QuotationDto
  /** The picture of its typed line. */
  linePicture: AttachmentDto
  /** A sent quotation of the customer (its revision 1). */
  sentQuotation: QuotationDto
  /** A quotation of the customer the customer accepted (no order made of it). */
  acceptedQuotation: QuotationDto
  /** The signature image of Settings → Documents (its object path). */
  signaturePath: string
  /** M3 Step 8: an issued invoice of the customer (a product line, a typed line, its LPO). */
  invoice: InvoiceDto
  /** A payment recorded on it. */
  invoicePayment: CustomerPaymentDto
  /** A draft invoice of the customer (typed line). */
  draftInvoice: InvoiceDto
  /** An issued credit note of the invoice (by amount on its typed line). */
  creditNote: CreditNoteDto
  /** A draft credit note of the invoice. */
  draftCreditNote: CreditNoteDto
}

function ok<T>(result: CallResult<T>, what: string): T {
  expect(result.error, `${what}: ${result.raw}`).toBeUndefined()
  return result.data as T
}

/** Uploads bytes to a signed upload URL, as the browser does. */
export async function uploadTo(
  url: string,
  bytes: Buffer,
  contentType: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': contentType, ...headers },
    body: new Uint8Array(bytes),
    signal: AbortSignal.timeout(10_000),
  })
  await response.arrayBuffer()
  return response
}

export async function createTenant(api: Api, label: string): Promise<Tenant> {
  const tag = newId().slice(-12)
  const legalName = `Hardening ${label} ${tag}`
  const legalNameAr = `مؤسسة ${label} ${tag}`
  const [owner, admin, employee] = await Promise.all([
    api.newPerson(),
    api.newPerson(),
    api.newPerson(),
  ])
  const id = await setupBusiness(api.handler, owner.token, WORKSHOP, { name: legalName })
  const as = (path: string, type: ProcedureType, input?: unknown) =>
    callProcedure(api.handler, { path, type }, owner.token, { businessId: id, input })

  const adminMemberId = await join(api.db, owner.user, id, admin.user, 'admin')
  const employeeMemberId = await join(api.db, owner.user, id, employee.user, 'employee')
  const members = ok(await as('member.list', 'query'), 'member.list') as MemberDto[]
  const ownerMemberId = members.find((m) => m.isOwner)?.id ?? ''
  const roleList = ok(await as('role.list', 'query'), 'role.list') as RoleDto[]
  const roles = Object.fromEntries(
    roleList.flatMap((role) => (role.templateKey ? [[role.templateKey, role]] : [])),
  ) as Record<RoleTemplateKey, RoleDto>

  const profile = ok(await as('business.profile', 'query'), 'profile') as BusinessProfileDto
  ok(
    await as('business.updateProfile', 'mutation', {
      version: profile.version,
      legalName,
      legalNameAr,
      vatRegistered: false,
      trn: null,
    }),
    'updateProfile',
  )

  const branch = ok(
    await as('location.create', 'mutation', { id: newId(), name: `Branch ${label} ${tag}` }),
    'location.create',
  ) as LocationDto
  const locations = ok(await as('location.list', 'query'), 'location.list') as LocationDto[]
  const defaultLocationId = locations.find((l) => l.isDefault)?.id ?? ''

  const inviteeEmail = `invitee-${label.toLowerCase()}-${tag}@test.bizcost.local`
  const invitation = ok(
    await as('invitation.create', 'mutation', {
      id: newId(),
      email: inviteeEmail,
      roleId: roles.employee.id,
      locale: 'en',
    }),
    'invitation.create',
  ) as InvitationDto
  const invitationToken = api.emails.tokenFor(inviteeEmail)

  const upload = ok(
    await as('business.logoUploadUrl', 'mutation', { contentType: 'image/png' }),
    'logoUploadUrl',
  ) as LogoUploadUrlDto
  expect((await uploadTo(upload.uploadUrl, PNG, 'image/png')).ok).toBe(true)
  ok(await as('business.setLogo', 'mutation', { path: upload.path }), 'setLogo')
  const openUpload = ok(
    await as('business.logoUploadUrl', 'mutation', { contentType: 'image/png' }),
    'logoUploadUrl',
  ) as LogoUploadUrlDto

  const bottle = newId()
  const material = ok(
    await as('material.create', 'mutation', {
      id: newId(),
      name: `Milk ${label} ${tag}`,
      unit: 'l',
      packs: [
        { id: bottle, name: `bottle ${tag}`, qty: '1', ofUnit: 'l' },
        { id: newId(), name: `carton ${tag}`, qty: '12', ofPackId: bottle },
      ],
    }),
    'material.create',
  ) as MaterialDto
  const product = ok(
    await as('product.create', 'mutation', {
      id: newId(),
      name: `Latte ${label} ${tag}`,
      type: 'product',
      unit: 'piece',
      defaultPrice: '15.5',
      locationIds: [branch.id],
    }),
    'product.create',
  ) as ProductDto

  const { today } = ok(await as('books.get', 'query'), 'books.get') as BooksDto
  const supplier = ok(
    await as('supplier.create', 'mutation', { id: newId(), name: `Dairy ${label} ${tag}` }),
    'supplier.create',
  ) as SupplierDto
  const purchaseLine = {
    kind: 'material',
    id: newId(),
    materialId: material.id,
    qty: '12',
    unit: 'l',
    unitPrice: '6.5',
  }
  const draft = (
    ok(
      await as('purchase.create', 'mutation', {
        id: newId(),
        supplierId: supplier.id,
        businessDate: today,
        documentType: 'no_invoice',
        paymentMethod: 'cash',
        reference: `REF-${label}-${tag}`,
        lines: [purchaseLine],
      }),
      'purchase.create',
    ) as { data: PurchaseDto }
  ).data
  const posted = (
    ok(
      await as('purchase.post', 'mutation', { id: draft.id, version: draft.version }),
      'purchase.post',
    ) as { data: PurchaseDto }
  ).data
  const draftPurchase = (
    ok(
      await as('purchase.create', 'mutation', {
        id: newId(),
        businessDate: today,
        documentType: 'no_invoice',
        paymentMethod: 'cash',
        lines: [{ ...purchaseLine, id: newId() }],
      }),
      'purchase.create',
    ) as { data: PurchaseDto }
  ).data
  const returnDraft = (
    ok(
      await as('purchaseReturn.create', 'mutation', {
        id: newId(),
        purchaseId: posted.id,
        kind: 'return',
        businessDate: today,
        lines: [{ id: newId(), purchaseLineId: posted.lines[0]?.id, qty: '1' }],
      }),
      'purchaseReturn.create',
    ) as { data: PurchaseReturnDto }
  ).data
  const purchaseReturn = (
    ok(
      await as('purchaseReturn.post', 'mutation', {
        id: returnDraft.id,
        version: returnDraft.version,
      }),
      'purchaseReturn.post',
    ) as { data: PurchaseReturnDto }
  ).data
  const draftReturn = (
    ok(
      await as('purchaseReturn.create', 'mutation', {
        id: newId(),
        purchaseId: posted.id,
        kind: 'credit_note',
        businessDate: today,
        lines: [{ id: newId(), purchaseLineId: posted.lines[0]?.id, amount: '1' }],
      }),
      'purchaseReturn.create',
    ) as { data: PurchaseReturnDto }
  ).data
  const receiptUpload = ok(
    await as('attachment.uploadUrl', 'mutation', {
      entity: 'purchase',
      entityId: posted.id,
      contentType: 'image/png',
    }),
    'attachment.uploadUrl',
  ) as AttachmentUploadUrlDto
  expect((await uploadTo(receiptUpload.uploadUrl, PNG, 'image/png')).ok).toBe(true)
  const attachment = (
    ok(
      await as('attachment.add', 'mutation', {
        entity: 'purchase',
        entityId: posted.id,
        path: receiptUpload.path,
        fileName: `receipt-${label}-${tag}.png`,
      }),
      'attachment.add',
    ) as { data: AttachmentDto }
  ).data
  const purchase = (
    ok(await as('purchase.get', 'query', { id: posted.id }), 'purchase.get') as {
      data: PurchaseDto
    }
  ).data
  const recipe = (
    ok(
      await as('recipe.save', 'mutation', {
        productId: product.id,
        version: 0,
        lines: [
          { id: newId(), materialId: material.id, qty: '0.5', packId: material.packs[1]?.id },
        ],
      }),
      'recipe.save',
    ) as { data: RecipeDto }
  ).data
  const resaleProduct = ok(
    await as('product.create', 'mutation', {
      id: newId(),
      name: `Juice ${label} ${tag}`,
      type: 'product',
      unit: 'piece',
      resale: {
        materialId: newId(),
        packs: [{ id: newId(), name: `case ${tag}`, qty: '6', ofUnit: 'piece' }],
      },
    }),
    'product.create (bought ready to sell)',
  ) as ProductDto
  const creditDraft = (
    ok(
      await as('purchase.create', 'mutation', {
        id: newId(),
        supplierId: supplier.id,
        businessDate: today,
        documentType: 'no_invoice',
        paymentMethod: 'supplier_credit',
        reference: `CREDIT-${label}-${tag}`,
        lines: [{ ...purchaseLine, id: newId() }],
      }),
      'purchase.create (on credit)',
    ) as { data: PurchaseDto }
  ).data
  const creditPurchase = (
    ok(
      await as('purchase.post', 'mutation', { id: creditDraft.id, version: creditDraft.version }),
      'purchase.post (on credit)',
    ) as { data: PurchaseDto }
  ).data
  const paymentId = newId()
  const paid = (
    ok(
      await as('purchasePayment.record', 'mutation', {
        id: paymentId,
        purchaseId: creditPurchase.id,
        businessDate: today,
        method: 'bank_transfer',
        amount: '10',
        note: `Paid ${label} ${tag}`,
      }),
      'purchasePayment.record',
    ) as PurchasePaymentsDto
  ).data
  const payment = paid.payments.find((p) => p.id === paymentId)!

  ok(await as('expense.updateSettings', 'mutation', { approval: true }), 'expense.updateSettings')
  const category = ok(
    await as('costCategory.create', 'mutation', { id: newId(), name: `Cleaning ${label} ${tag}` }),
    'costCategory.create',
  ) as CostCategoryDto
  const expenseInput = (extra: object) => ({
    id: newId(),
    categoryId: category.id,
    businessDate: today,
    documentType: 'tax_invoice',
    paymentMethod: 'cash',
    amount: '100',
    vatRate: '0',
    ...extra,
  })
  const expenseDraft = async (extra: object) =>
    (
      ok(await as('expense.create', 'mutation', expenseInput(extra)), 'expense.create') as {
        data: ExpenseDto
      }
    ).data
  const creditExpense = await expenseDraft({
    supplierId: supplier.id,
    paymentMethod: 'supplier_credit',
    reference: `BILL-${label}-${tag}`,
  })
  ok(
    await as('expense.post', 'mutation', { id: creditExpense.id, version: creditExpense.version }),
    'expense.post',
  )
  const billUpload = ok(
    await as('attachment.uploadUrl', 'mutation', {
      entity: 'expense',
      entityId: creditExpense.id,
      contentType: 'image/png',
    }),
    'attachment.uploadUrl (expense)',
  ) as AttachmentUploadUrlDto
  expect((await uploadTo(billUpload.uploadUrl, PNG, 'image/png')).ok).toBe(true)
  const expenseAttachment = (
    ok(
      await as('attachment.add', 'mutation', {
        entity: 'expense',
        entityId: creditExpense.id,
        path: billUpload.path,
        fileName: `bill-${label}-${tag}.png`,
      }),
      'attachment.add (expense)',
    ) as { data: AttachmentDto }
  ).data
  const expensePaymentId = newId()
  const expensePaid = (
    ok(
      await as('expensePayment.record', 'mutation', {
        id: expensePaymentId,
        expenseId: creditExpense.id,
        businessDate: today,
        method: 'cash',
        amount: '5',
        note: `Bill paid ${label} ${tag}`,
      }),
      'expensePayment.record',
    ) as ExpensePaymentsDto
  ).data
  const expensePayment = expensePaid.payments.find((p) => p.id === expensePaymentId)!
  const expense = (
    ok(await as('expense.get', 'query', { id: creditExpense.id }), 'expense.get') as {
      data: ExpenseDto
    }
  ).data
  const draftExpense = await expenseDraft({ description: `Draft ${label} ${tag}` })
  const toSubmit = await expenseDraft({})
  const submittedExpense = (
    ok(
      await as('expense.submit', 'mutation', { id: toSubmit.id, version: toSubmit.version }),
      'expense.submit',
    ) as { data: ExpenseDto }
  ).data
  const runningCategory = ok(
    await as('costCategory.create', 'mutation', { id: newId(), name: `Rent ${label} ${tag}` }),
    'costCategory.create (rent)',
  ) as CostCategoryDto
  const runningCost = (
    ok(
      await as('runningCost.create', 'mutation', {
        id: newId(),
        name: `Shop rent ${label} ${tag}`,
        categoryId: runningCategory.id,
        amount: '15000',
        startsOn: today,
      }),
      'runningCost.create',
    ) as { data: RunningCostDto }
  ).data

  const channel = (
    ok(
      await as('channel.create', 'mutation', {
        id: newId(),
        name: `Talabat ${label} ${tag}`,
        kind: 'delivery_app',
        feePercent: '18',
      }),
      'channel.create',
    ) as { data: SalesChannelDto }
  ).data
  const saleDraft = (
    ok(
      await as('sale.create', 'mutation', {
        id: newId(),
        source: 'single',
        businessDate: today,
        locationId: branch.id,
        channelId: channel.id,
        deliveryNeeded: true,
        deliveryArea: `Area ${label} ${tag}`,
        deliveryCost: '7',
        notes: `Sale ${label} ${tag}`,
        lines: [
          { kind: 'item', id: newId(), productId: product.id, qty: '2', unitPrice: '15.5' },
          { kind: 'delivery', id: newId(), amount: '10' },
        ],
      }),
      'sale.create',
    ) as { data: SaleDto }
  ).data
  const sale = (
    ok(
      await as('sale.post', 'mutation', { id: saleDraft.id, version: saleDraft.version }),
      'sale.post',
    ) as { data: SaleDto }
  ).data
  const draftSale = (
    ok(
      await as('sale.create', 'mutation', {
        id: newId(),
        source: 'day_sheet',
        businessDate: today,
        channelId: channel.id,
        lines: [{ kind: 'item', id: newId(), productId: product.id, qty: '3', unitPrice: '15.5' }],
      }),
      'sale.create (day sheet)',
    ) as { data: SaleDto }
  ).data

  // An import (M3 Step 4): a file of today's sales of the product at the branch, with a fee column.
  const importInput = (fileName: string) => ({
    id: newId(),
    channelId: channel.id,
    locationId: branch.id,
    fileName,
    fileHash: randomBytes(32).toString('hex'),
    fingerprint: randomBytes(32).toString('hex'),
    shape: 'lines',
    periodFrom: today,
    periodTo: today,
    mapping: {
      headerRow: 0,
      columns: { date: 0, name: 1, code: 2, qty: 3, total: 4, fee: 5 },
      headers: { date: 'Date', name: 'Item', code: 'SKU', qty: 'Qty', total: 'Total', fee: 'Fee' },
      dateOrder: 'dmy',
    },
    amountsIncludeVat: false,
    rowsRead: 2,
    rowsLeftOut: 0,
    errors: [],
    feesTotal: '4.5',
    rowCount: 1,
  })
  const importRows = (importId: string) => ({
    id: importId,
    rows: [
      {
        position: 0,
        businessDate: today,
        name: product.name,
        code: `SKU-${label}-${tag}`,
        qty: '2',
        amount: '31',
        refunds: '0',
        fileRows: 2,
      },
    ],
  })
  const importDraft = (
    ok(
      await as('saleImport.create', 'mutation', importInput(`talabat-${label}-${tag}.csv`)),
      'saleImport.create',
    ) as { data: SaleImportDto }
  ).data
  ok(await as('saleImport.addRows', 'mutation', importRows(importDraft.id)), 'saleImport.addRows')
  const saleImport = (
    ok(
      await as('saleImport.post', 'mutation', { id: importDraft.id, version: importDraft.version }),
      'saleImport.post',
    ) as { data: SaleImportDto }
  ).data
  const statement = (
    ok(
      await as('channelStatement.get', 'query', { id: saleImport.statementId }),
      'channelStatement.get',
    ) as { data: ChannelStatementDto }
  ).data
  const draftCreated = (
    ok(
      await as('saleImport.create', 'mutation', importInput(`draft-${label}-${tag}.csv`)),
      'saleImport.create (draft)',
    ) as { data: SaleImportDto }
  ).data
  ok(await as('saleImport.addRows', 'mutation', importRows(draftCreated.id)), 'addRows (draft)')
  const draftImport = (
    ok(await as('saleImport.get', 'query', { id: draftCreated.id }), 'saleImport.get') as {
      data: SaleImportDto
    }
  ).data
  const importProfile = (
    ok(await as('importProfile.list', 'query'), 'importProfile.list') as ImportProfileListDto
  ).items[0]!

  // M3 Step 5: a customer, a pending order with its deposit, a delivered order refunded by amount,
  // and a One sale "they'll pay later" partly paid.
  const customer = ok(
    await as('customer.create', 'mutation', {
      id: newId(),
      name: `Customer ${label} ${tag}`,
      kind: 'business',
      phone: `050 ${tag
        .slice(-7)
        .replace(/[^0-9]/g, '1')
        .padStart(7, '7')}`,
      email: `buyer-${label.toLowerCase()}-${tag}@test.bizcost.local`,
      tradeLicenceNo: `TL-${label}-${tag}`,
      notes: `Customer notes ${label} ${tag}`,
    }),
    'customer.create',
  ) as CustomerDto
  const orderPaymentId = newId()
  const order = (
    ok(
      await as('order.create', 'mutation', {
        id: newId(),
        customerId: customer.id,
        customerRef: `LPO-${label}-${tag}`,
        businessDate: today,
        dueDate: today,
        locationId: branch.id,
        channelId: channel.id,
        deliveryNeeded: true,
        deliveryArea: `Order area ${label} ${tag}`,
        deliveryCost: '6',
        notes: `Order ${label} ${tag}`,
        lines: [
          { kind: 'item', id: newId(), productId: product.id, qty: '2', unitPrice: '15.5' },
          { kind: 'delivery', id: newId(), amount: '10' },
        ],
        payment: { id: orderPaymentId, method: 'bank_transfer', amount: '20' },
      }),
      'order.create',
    ) as { data: OrderDto }
  ).data
  const orderPayment = (
    ok(
      await as('customerPayment.list', 'query', { orderId: order.id }),
      'customerPayment.list',
    ) as { items: CustomerPaymentDto[] }
  ).items.find((p) => p.id === orderPaymentId)!
  const toDeliver = (
    ok(
      await as('order.create', 'mutation', {
        id: newId(),
        customerId: customer.id,
        businessDate: today,
        locationId: branch.id,
        channelId: channel.id,
        lines: [{ kind: 'item', id: newId(), productId: product.id, qty: '1', unitPrice: '15.5' }],
      }),
      'order.create (to deliver)',
    ) as { data: OrderDto }
  ).data
  const delivered = (
    ok(
      await as('order.deliver', 'mutation', { id: toDeliver.id, version: toDeliver.version }),
      'order.deliver',
    ) as { data: OrderDto }
  ).data
  ok(
    await as('customerPayment.record', 'mutation', {
      id: newId(),
      orderId: delivered.id,
      businessDate: today,
      method: 'cash',
      amount: '15.5',
    }),
    'customerPayment.record (order paid)',
  )
  const deliveredSale = (
    ok(await as('sale.get', 'query', { id: delivered.saleId }), 'sale.get (order)') as {
      data: SaleDto
    }
  ).data
  const refund = (
    ok(
      await as('sale.refund', 'mutation', {
        id: newId(),
        orderId: delivered.id,
        by: 'amount',
        businessDate: today,
        lines: [{ lineId: deliveredSale.lines[0]?.id, amount: '5' }],
        notes: `Refund ${label} ${tag}`,
        payment: { id: newId(), method: 'cash', amount: '5' },
      }),
      'sale.refund',
    ) as { data: SaleDto }
  ).data
  const deliveredOrder = (
    ok(await as('order.get', 'query', { id: delivered.id }), 'order.get') as { data: OrderDto }
  ).data
  const payLaterDraft = (
    ok(
      await as('sale.create', 'mutation', {
        id: newId(),
        source: 'single',
        businessDate: today,
        locationId: branch.id,
        channelId: channel.id,
        customerId: customer.id,
        payLater: true,
        notes: `Pay later ${label} ${tag}`,
        lines: [{ kind: 'item', id: newId(), productId: product.id, qty: '4', unitPrice: '15.5' }],
      }),
      'sale.create (pay later)',
    ) as { data: SaleDto }
  ).data
  ok(
    await as('sale.post', 'mutation', { id: payLaterDraft.id, version: payLaterDraft.version }),
    'sale.post (pay later)',
  )
  const salePaymentId = newId()
  const salePaid = ok(
    await as('customerPayment.record', 'mutation', {
      id: salePaymentId,
      saleId: payLaterDraft.id,
      businessDate: today,
      method: 'card',
      amount: '12',
      note: `Sale paid ${label} ${tag}`,
    }),
    'customerPayment.record (sale)',
  ) as DocumentPaymentsDto
  const salePayment = salePaid.items.find((p) => p.id === salePaymentId)!
  const payLaterSale = (
    ok(await as('sale.get', 'query', { id: payLaterDraft.id }), 'sale.get (pay later)') as {
      data: SaleDto
    }
  ).data

  // M3 Step 7: the letterhead's contact lines, a signature, a draft quotation with a picture on a
  // line, and a sent one.
  const profileNow = ok(await as('business.profile', 'query'), 'profile') as BusinessProfileDto
  ok(
    await as('business.updateProfile', 'mutation', {
      version: profileNow.version,
      legalName,
      legalNameAr,
      vatRegistered: false,
      trn: null,
      letterhead: {
        phone: '04 555 0142',
        email: `office-${label.toLowerCase()}-${tag}@test.bizcost.local`,
        addressLine: `Warehouse ${label} ${tag}`,
        emirate: 'dubai',
        tradeLicenceNo: `DED-${label}-${tag}`,
      },
    }),
    'updateProfile (letterhead)',
  )
  const signatureUpload = ok(
    await as('document.imageUploadUrl', 'mutation', {
      kind: 'signature',
      contentType: 'image/png',
    }),
    'document.imageUploadUrl',
  ) as DocumentImageUploadUrlDto
  expect((await uploadTo(signatureUpload.uploadUrl, PNG, 'image/png')).ok).toBe(true)
  ok(
    await as('document.setImage', 'mutation', { kind: 'signature', path: signatureUpload.path }),
    'document.setImage',
  )
  const quotationDraft = ok(
    await as('quotation.create', 'mutation', {
      id: newId(),
      customerId: customer.id,
      businessDate: today,
      locationId: branch.id,
      customerRef: `ENQ-${label}-${tag}`,
      site: `Villa ${label} ${tag}`,
      notes: `Quote notes ${label} ${tag}`,
      lines: [
        { id: newId(), productId: product.id, qty: '2', unitPrice: '15.5' },
        {
          id: newId(),
          productId: null,
          area: `MAJLIS ${tag}`,
          description: `Cladding ${label} ${tag}`,
          details: `Oak veneer ${label} ${tag}`,
          note: `Marble extra ${label} ${tag}`,
          qty: '3.5',
          unit: 'm2',
          unitPrice: '650',
        },
      ],
      stages: [{ due: `On signing ${tag}`, percent: '100' }],
    }),
    'quotation.create',
  ) as QuotationDto
  const pictureUpload = ok(
    await as('attachment.uploadUrl', 'mutation', {
      entity: 'quotation_line',
      entityId: quotationDraft.lines[1]!.id,
      contentType: 'image/png',
    }),
    'attachment.uploadUrl (picture)',
  ) as AttachmentUploadUrlDto
  expect((await uploadTo(pictureUpload.uploadUrl, PNG, 'image/png')).ok).toBe(true)
  const linePicture = (
    ok(
      await as('attachment.add', 'mutation', {
        entity: 'quotation_line',
        entityId: quotationDraft.lines[1]!.id,
        path: pictureUpload.path,
        fileName: `picture-${label}-${tag}.png`,
      }),
      'attachment.add (picture)',
    ) as { data: AttachmentDto }
  ).data
  const quotation = ok(
    await as('quotation.get', 'query', { id: quotationDraft.id }),
    'quotation.get',
  ) as QuotationDto
  const toSend = ok(
    await as('quotation.create', 'mutation', {
      id: newId(),
      customerId: customer.id,
      businessDate: today,
      locationId: branch.id,
      lines: [{ id: newId(), productId: product.id, qty: '1', unitPrice: '15.5' }],
    }),
    'quotation.create (to send)',
  ) as QuotationDto
  const sentQuotation = ok(
    await as('quotation.send', 'mutation', { id: toSend.id, version: toSend.version }),
    'quotation.send',
  ) as QuotationDto
  const toAccept = ok(
    await as('quotation.create', 'mutation', {
      id: newId(),
      customerId: customer.id,
      businessDate: today,
      locationId: branch.id,
      lines: [{ id: newId(), productId: product.id, qty: '1', unitPrice: '15.5' }],
    }),
    'quotation.create (to accept)',
  ) as QuotationDto
  const sentToAccept = ok(
    await as('quotation.send', 'mutation', { id: toAccept.id, version: toAccept.version }),
    'quotation.send (to accept)',
  ) as QuotationDto
  const acceptedQuotation = ok(
    await as('quotation.accept', 'mutation', {
      id: sentToAccept.id,
      version: sentToAccept.version,
    }),
    'quotation.accept',
  ) as QuotationDto

  // M3 Step 8: an issued invoice with a payment, a draft invoice, an issued and a draft credit note.
  const invoiceDraft = ok(
    await as('invoice.create', 'mutation', {
      id: newId(),
      customerId: customer.id,
      locationId: branch.id,
      channelId: channel.id,
      lpoReference: `LPO-INV-${label}-${tag}`,
      countedElsewhere: false,
      notes: `Invoice note ${label} ${tag}`,
      lines: [
        { id: newId(), productId: product.id, qty: '2', unitPrice: '20' },
        {
          id: newId(),
          productId: null,
          description: `Fitting ${label} ${tag}`,
          qty: '1',
          unitPrice: '30',
        },
      ],
    }),
    'invoice.create',
  ) as InvoiceDto
  const invoice = ok(
    await as('invoice.issue', 'mutation', { id: invoiceDraft.id, version: invoiceDraft.version }),
    'invoice.issue',
  ) as InvoiceDto
  const invoicePayments = ok(
    await as('customerPayment.record', 'mutation', {
      id: newId(),
      invoiceId: invoice.id,
      businessDate: today,
      method: 'bank_transfer',
      amount: '10',
      note: `Invoice payment ${label} ${tag}`,
    }),
    'customerPayment.record (invoice)',
  ) as DocumentPaymentsDto
  const draftInvoice = ok(
    await as('invoice.create', 'mutation', {
      id: newId(),
      customerId: customer.id,
      locationId: branch.id,
      lines: [
        {
          id: newId(),
          productId: null,
          description: `Draft work ${label} ${tag}`,
          qty: '1',
          unitPrice: '12',
        },
      ],
    }),
    'invoice.create (draft)',
  ) as InvoiceDto
  const creditNoteDraft = ok(
    await as('creditNote.create', 'mutation', {
      id: newId(),
      invoiceId: invoice.id,
      eventDate: today,
      reason: 'price_changed',
      reasonText: `Credit ${label} ${tag}`,
      by: 'amount',
      lines: [{ invoiceLineId: invoice.lines[1]!.id, amount: '5' }],
    }),
    'creditNote.create',
  ) as CreditNoteDto
  const creditNote = ok(
    await as('creditNote.issue', 'mutation', {
      id: creditNoteDraft.id,
      version: creditNoteDraft.version,
    }),
    'creditNote.issue',
  ) as CreditNoteDto
  const draftCreditNote = ok(
    await as('creditNote.create', 'mutation', {
      id: newId(),
      invoiceId: invoice.id,
      eventDate: today,
      reason: 'goods_returned',
      reasonText: `Return ${label} ${tag}`,
      by: 'quantity',
      lines: [{ invoiceLineId: invoice.lines[0]!.id, qty: '1' }],
    }),
    'creditNote.create (draft)',
  ) as CreditNoteDto

  return {
    id,
    label,
    legalName,
    legalNameAr,
    owner,
    admin,
    employee,
    ownerMemberId,
    adminMemberId,
    employeeMemberId,
    roles,
    defaultLocationId,
    branch,
    invitation,
    invitationToken,
    logoPath: upload.path,
    openUpload,
    material,
    product,
    supplier,
    purchase,
    draftPurchase,
    purchaseReturn,
    draftReturn,
    attachment,
    recipe,
    resaleProduct,
    creditPurchase,
    payment,
    category,
    runningCategory,
    expense,
    expenseAttachment,
    expensePayment,
    draftExpense,
    submittedExpense,
    runningCost,
    channel,
    sale,
    draftSale,
    saleImport,
    statement,
    draftImport,
    importProfile,
    customer,
    order,
    orderPayment,
    deliveredOrder,
    refund,
    payLaterSale,
    salePayment,
    quotation,
    linePicture,
    sentQuotation,
    acceptedQuotation,
    signaturePath: signatureUpload.path,
    invoice,
    invoicePayment: invoicePayments.items[0]!,
    draftInvoice,
    creditNote,
    draftCreditNote,
  }
}

/** A valid input for a business query that needs one, naming the tenant's own rows. */
export function queryInputOf(path: string, tenant: Tenant): unknown {
  if (path === 'material.get') return { id: tenant.material.id }
  if (path === 'product.get') return { id: tenant.product.id }
  if (path === 'supplier.get') return { id: tenant.supplier.id }
  if (path === 'purchase.get') return { id: tenant.purchase.id }
  if (path === 'purchaseReturn.get') return { id: tenant.purchaseReturn.id }
  if (path === 'attachment.list') return { entity: 'purchase', entityId: tenant.purchase.id }
  if (path === 'material.costs') return { ids: [tenant.material.id] }
  if (path === 'recipe.get') return { productId: tenant.product.id }
  if (path === 'product.costs') return { ids: [tenant.product.id, tenant.resaleProduct.id] }
  if (path === 'payable.list') return { party: 'supplier' }
  if (path === 'purchasePayment.list') return { purchaseId: tenant.creditPurchase.id }
  if (path === 'expense.get') return { id: tenant.expense.id }
  if (path === 'expense.getMine') return { id: tenant.expense.id }
  if (path === 'expensePayment.list') return { expenseId: tenant.expense.id }
  if (path === 'runningCost.get') return { id: tenant.runningCost.id }
  if (path === 'expense.payableRunningCosts') {
    return { categoryId: tenant.category.id, periodMonth: tenant.expense.periodMonth }
  }
  if (path === 'productCost.get') return { productId: tenant.product.id }
  if (path === 'member.permissions') return { memberId: tenant.employeeMemberId }
  if (path === 'member.locations') return { memberId: tenant.employeeMemberId }
  if (path === 'sale.get') return { id: tenant.sale.id }
  if (path === 'saleImport.get') return { id: tenant.saleImport.id }
  if (path === 'channelStatement.list') return { channelId: tenant.channel.id }
  if (path === 'channelStatement.get') return { id: tenant.statement.id }
  if (path === 'profit.summary') {
    return { from: `${tenant.sale.businessDate.slice(0, 7)}-01`, to: tenant.sale.businessDate }
  }
  if (path === 'sale.daySheet') {
    return { businessDate: tenant.sale.businessDate, channelId: tenant.channel.id }
  }
  if (path === 'customer.get') return { id: tenant.customer.id }
  if (path === 'customer.similar') return { name: tenant.customer.name }
  if (path === 'order.get') return { id: tenant.order.id }
  if (path === 'customerPayment.list') return { orderId: tenant.order.id }
  if (path === 'quotation.get') return { id: tenant.quotation.id }
  if (path === 'quotation.history') return { id: tenant.quotation.id }
  if (path === 'invoice.get') return { id: tenant.invoice.id }
  if (path === 'invoice.history') return { id: tenant.invoice.id }
  if (path === 'creditNote.get') return { id: tenant.creditNote.id }
  if (path === 'creditNote.history') return { id: tenant.creditNote.id }
  if (path === 'customer.statement') {
    return {
      customerId: tenant.customer.id,
      from: `${tenant.invoice.issueDate!.slice(0, 7)}-01`,
      to: tenant.invoice.issueDate,
    }
  }
  return undefined
}

/**
 * Strings that identify the tenant's data: names, emails, ids of its rows and users, object paths.
 * None of them may appear in a response to someone who is not a member.
 */
export function markersOf(tenant: Tenant): string[] {
  return [
    tenant.id,
    tenant.legalName,
    tenant.legalNameAr,
    tenant.branch.name,
    tenant.branch.id,
    tenant.defaultLocationId,
    tenant.invitation.id,
    tenant.invitation.email,
    tenant.invitationToken,
    tenant.logoPath,
    tenant.openUpload.path,
    tenant.ownerMemberId,
    tenant.adminMemberId,
    tenant.employeeMemberId,
    tenant.material.id,
    tenant.material.name,
    ...tenant.material.packs.flatMap((pack) => [pack.id, pack.name]),
    tenant.product.id,
    tenant.product.name,
    tenant.supplier.id,
    tenant.supplier.name,
    tenant.purchase.id,
    tenant.purchase.reference ?? tenant.purchase.id,
    ...tenant.purchase.lines.map((l) => l.id),
    tenant.draftPurchase.id,
    tenant.purchaseReturn.id,
    tenant.draftReturn.id,
    tenant.attachment.id,
    tenant.attachment.fileName,
    ...tenant.recipe.lines.map((l) => l.id),
    tenant.resaleProduct.id,
    tenant.resaleProduct.name,
    tenant.resaleProduct.resaleMaterialId ?? tenant.resaleProduct.id,
    tenant.creditPurchase.id,
    tenant.creditPurchase.reference ?? tenant.creditPurchase.id,
    tenant.payment.id,
    tenant.payment.note ?? tenant.payment.id,
    tenant.category.id,
    tenant.category.name,
    tenant.expense.id,
    tenant.expense.reference ?? tenant.expense.id,
    tenant.expenseAttachment.id,
    tenant.expenseAttachment.fileName,
    tenant.expensePayment.id,
    tenant.expensePayment.note ?? tenant.expensePayment.id,
    tenant.draftExpense.id,
    tenant.draftExpense.description ?? tenant.draftExpense.id,
    tenant.submittedExpense.id,
    tenant.runningCost.id,
    tenant.runningCost.name,
    tenant.channel.id,
    tenant.channel.name,
    tenant.sale.id,
    ...tenant.sale.lines.map((l) => l.id),
    tenant.sale.deliveryArea ?? tenant.sale.id,
    tenant.sale.notes ?? tenant.sale.id,
    tenant.draftSale.id,
    tenant.saleImport.id,
    tenant.saleImport.fileName,
    tenant.statement.id,
    tenant.draftImport.id,
    tenant.draftImport.fileName,
    tenant.importProfile.id,
    tenant.customer.id,
    tenant.customer.name,
    tenant.customer.phone ?? tenant.customer.id,
    tenant.customer.email ?? tenant.customer.id,
    tenant.customer.tradeLicenceNo ?? tenant.customer.id,
    tenant.customer.notes ?? tenant.customer.id,
    tenant.order.id,
    tenant.order.customerRef ?? tenant.order.id,
    tenant.order.deliveryArea ?? tenant.order.id,
    tenant.order.notes ?? tenant.order.id,
    ...tenant.order.lines.map((l) => l.id),
    tenant.orderPayment.id,
    tenant.deliveredOrder.id,
    tenant.deliveredOrder.saleId ?? tenant.deliveredOrder.id,
    tenant.refund.id,
    tenant.refund.notes ?? tenant.refund.id,
    tenant.payLaterSale.id,
    tenant.payLaterSale.notes ?? tenant.payLaterSale.id,
    tenant.salePayment.id,
    tenant.salePayment.note ?? tenant.salePayment.id,
    tenant.quotation.id,
    tenant.quotation.customerRef ?? tenant.quotation.id,
    tenant.quotation.site ?? tenant.quotation.id,
    tenant.quotation.notes ?? tenant.quotation.id,
    ...tenant.quotation.lines.flatMap((l) => [
      l.id,
      l.area ?? l.id,
      l.details ?? l.id,
      l.note ?? l.id,
    ]),
    ...tenant.quotation.stages.map((s) => s.id),
    tenant.linePicture.id,
    tenant.linePicture.fileName,
    tenant.sentQuotation.id,
    tenant.acceptedQuotation.id,
    tenant.signaturePath,
    tenant.invoice.id,
    tenant.invoice.lpoReference ?? tenant.invoice.id,
    tenant.invoice.notes ?? tenant.invoice.id,
    ...tenant.invoice.lines.flatMap((l) => [l.id, l.description]),
    tenant.invoicePayment.id,
    tenant.invoicePayment.note ?? tenant.invoicePayment.id,
    tenant.draftInvoice.id,
    ...tenant.draftInvoice.lines.flatMap((l) => [l.id, l.description]),
    tenant.creditNote.id,
    tenant.creditNote.reasonText,
    tenant.draftCreditNote.id,
    tenant.draftCreditNote.reasonText,
    ...Object.values(tenant.roles).map((role) => role.id),
    ...[tenant.owner, tenant.admin, tenant.employee].flatMap(({ user }) => [
      user.id,
      user.email,
      user.email.split('@')[0] ?? user.email,
    ]),
  ]
}

/** The tenant's markers found in `raw`, except those the request itself sent. */
export function leaksOf(raw: string, tenant: Tenant, sent: unknown = undefined): string[] {
  const echoed = sent === undefined ? '' : JSON.stringify(sent)
  const lowered = raw.toLowerCase()
  return markersOf(tenant).filter(
    (marker) => lowered.includes(marker.toLowerCase()) && !echoed.includes(marker),
  )
}

/**
 * A digest of the tenant's state: every row of every app table with its business_id (audit_log
 * included, so a write by anyone shows), its businesses row, its users' profiles and its Storage
 * objects. Read as postgres (BYPASSRLS).
 */
export async function tenantDigest(admin: Admin, tenant: Tenant): Promise<Record<string, string>> {
  const digest = await businessDigest(admin, tenant.id)
  const userIds = [tenant.owner, tenant.admin, tenant.employee].map(({ user }) => user.id)
  const [profiles] = await admin<{ h: string }[]>`
    select md5(coalesce(string_agg(to_jsonb(p)::text, '|' order by p.id), '')) as h
      from app.profiles p where p.id = any(${userIds}::uuid[])`
  digest.profiles = profiles?.h ?? ''
  return digest
}

/** As tenantDigest, for any business: its rows (audit_log included), its row, its Storage objects. */
export async function businessDigest(
  admin: Admin,
  businessId: string,
): Promise<Record<string, string>> {
  const tables = await admin<{ table_name: string }[]>`
    select table_name from information_schema.columns
     where table_schema = 'app' and column_name = 'business_id'
     order by table_name`
  const digest: Record<string, string> = {}
  for (const { table_name } of tables) {
    const [row] = await admin.unsafe<{ h: string }[]>(
      `select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) as h
         from app."${table_name.replaceAll('"', '""')}" t where t.business_id = $1`,
      [businessId],
    )
    digest[table_name] = row?.h ?? ''
  }
  const [business] = await admin<{ h: string }[]>`
    select md5(to_jsonb(b)::text) as h from app.businesses b where b.id = ${businessId}`
  digest.businesses = business?.h ?? ''
  const [objects] = await admin<{ h: string }[]>`
    select md5(coalesce(string_agg(
             concat_ws(':', o.name, o.metadata::text, o.updated_at::text, o.owner_id), '|'
             order by o.name), '')) as h
      from storage.objects o
     where o.bucket_id = 'business-files' and o.name like ${`${businessId}/%`}`
  digest.storage = objects?.h ?? ''
  return digest
}

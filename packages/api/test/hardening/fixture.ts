import type {
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
  const handler = handlerFor(db, router, { supabaseSecretKey: SECRET_KEY }, { emailSender: emails })
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
  const runningCost = (
    ok(
      await as('runningCost.create', 'mutation', {
        id: newId(),
        name: `Shop rent ${label} ${tag}`,
        categoryId: category.id,
        amount: '15000',
        startsOn: today,
      }),
      'runningCost.create',
    ) as { data: RunningCostDto }
  ).data

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
    expense,
    expenseAttachment,
    expensePayment,
    draftExpense,
    submittedExpense,
    runningCost,
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
  if (path === 'productCost.get') return { productId: tenant.product.id }
  if (path === 'member.permissions') return { memberId: tenant.employeeMemberId }
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
  const tables = await admin<{ table_name: string }[]>`
    select table_name from information_schema.columns
     where table_schema = 'app' and column_name = 'business_id'
     order by table_name`
  const digest: Record<string, string> = {}
  for (const { table_name } of tables) {
    const [row] = await admin.unsafe<{ h: string }[]>(
      `select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) as h
         from app."${table_name.replaceAll('"', '""')}" t where t.business_id = $1`,
      [tenant.id],
    )
    digest[table_name] = row?.h ?? ''
  }
  const [business] = await admin<{ h: string }[]>`
    select md5(to_jsonb(b)::text) as h from app.businesses b where b.id = ${tenant.id}`
  digest.businesses = business?.h ?? ''
  const userIds = [tenant.owner, tenant.admin, tenant.employee].map(({ user }) => user.id)
  const [profiles] = await admin<{ h: string }[]>`
    select md5(coalesce(string_agg(to_jsonb(p)::text, '|' order by p.id), '')) as h
      from app.profiles p where p.id = any(${userIds}::uuid[])`
  digest.profiles = profiles?.h ?? ''
  const [objects] = await admin<{ h: string }[]>`
    select md5(coalesce(string_agg(
             concat_ws(':', o.name, o.metadata::text, o.updated_at::text, o.owner_id), '|'
             order by o.name), '')) as h
      from storage.objects o
     where o.bucket_id = 'business-files' and o.name like ${`${tenant.id}/%`}`
  digest.storage = objects?.h ?? ''
  return digest
}

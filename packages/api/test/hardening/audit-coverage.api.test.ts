import type {
  AttachmentUploadUrlDto,
  BusinessProfileDto,
  CostCategoryDto,
  ExpenseDto,
  InvitationDto,
  LocationDto,
  LogoUploadUrlDto,
  MaterialDto,
  ProductDto,
  PurchaseDto,
  PurchaseReturnDto,
  RecipeResultDto,
  RoleDto,
  RunningCostDto,
  SaleDto,
  SalesChannelDto,
  SupplierDto,
} from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import { QUESTION_SET_VERSION } from '@bizcost/modules'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { appRouter } from '../../src'
import { mintToken, mutate, query, type CallResult, type TestUser } from '../helpers'
import { BAKER, join, setupBusiness, WORKSHOP } from '../settings'
import {
  callProcedure,
  createTenant,
  openApi,
  PNG,
  proceduresOf,
  queryInputOf,
  uploadTo,
  type Api,
  type Person,
  type ProcedureType,
  type Tenant,
} from './fixture'
import { updateFieldsOf } from '../sales'

// Audit coverage (ROADMAP.md M1 definition of done: "every write of business data is in audit_log
// with actor and request_id"; DATA_MODEL.md §1.6). For EVERY mutation of appRouter, walked from the
// router, one representative successful call in a real business, then: its audit_log rows carry the
// request's x-request-id, the caller as actor_user_id and the business the write belongs to — at least
// one row, unless AUDIT says why the mutation writes no business data. Queries are read as well: they
// write no audited row (a GET skips the Origin check, so a query must not change business data).
//
// The two documented exceptions (D-103) are exercised below, not assumed: account-level `profiles`
// writes are not audited (the profile `me` creates, a language or name saved by an account with no
// business, the business opened last; profiles are account rows, D-050), and `me`, the one query that
// writes business rows, copies the caller's own verified email to their memberships when it changed
// (D-083): exactly one audited update per membership, of the email alone, by the caller.
//
// A mutation added without an AUDIT entry fails the first test.

interface Done {
  result: CallResult
  actor: TestUser
  /** The business the audit rows belong to. */
  businessId: string
}

interface AuditProbe {
  /** Why the call writes no audit row; absent: at least one row is expected. */
  noAudit?: string
  run: () => Promise<Done>
}

let api: Api
let tenant: Tenant

beforeAll(async () => {
  api = openApi()
  tenant = await createTenant(api, 'Audit')
}, 60_000)

afterAll(async () => {
  await api.close()
})

function call<T>(
  person: Person,
  path: string,
  type: ProcedureType,
  input?: unknown,
  businessId: string | undefined = tenant.id,
) {
  return callProcedure<T>(api.handler, { path, type }, person.token, { businessId, input })
}

async function ok<T>(pending: Promise<CallResult<T>>): Promise<T> {
  const result = await pending
  expect(result.error, result.raw).toBeUndefined()
  return result.data as T
}

/** A new account that is an active member of the tenant with the business's `template` role. */
async function newMember(template: 'employee' | 'admin' = 'employee') {
  const person = await api.newPerson()
  const memberId = await join(api.db, tenant.owner.user, tenant.id, person.user, template)
  return { person, memberId }
}

async function newLocation(): Promise<LocationDto> {
  return ok(call(tenant.owner, 'location.create', 'mutation', { id: newId(), name: newId() }))
}

async function newInvitation(email = `audit-${newId()}@test.bizcost.local`) {
  return ok(
    call<InvitationDto>(tenant.owner, 'invitation.create', 'mutation', {
      id: newId(),
      email,
      roleId: tenant.roles.employee.id,
      locale: 'en',
    }),
  )
}

async function newMaterial(): Promise<MaterialDto> {
  const bag = newId()
  return ok(
    call<MaterialDto>(tenant.owner, 'material.create', 'mutation', {
      id: newId(),
      name: `Beans ${newId()}`,
      unit: 'kg',
      packs: [{ id: bag, name: 'bag', qty: '1', ofUnit: 'kg' }],
    }),
  )
}

async function newProduct(): Promise<ProductDto> {
  return ok(
    call<ProductDto>(tenant.owner, 'product.create', 'mutation', {
      id: newId(),
      name: `Mocha ${newId()}`,
      type: 'product',
      unit: 'piece',
    }),
  )
}

async function uploadedLogo(): Promise<string> {
  const upload = await ok(
    call<LogoUploadUrlDto>(tenant.owner, 'business.logoUploadUrl', 'mutation', {
      contentType: 'image/png',
    }),
  )
  expect((await uploadTo(upload.uploadUrl, PNG, 'image/png')).ok).toBe(true)
  return upload.path
}

async function newSupplier(): Promise<SupplierDto> {
  return ok(
    call<SupplierDto>(tenant.owner, 'supplier.create', 'mutation', {
      id: newId(),
      name: `Supplier ${newId()}`,
    }),
  )
}

async function purchaseDraftInput() {
  return {
    id: newId(),
    businessDate: tenant.purchase.businessDate,
    documentType: 'no_invoice',
    paymentMethod: 'cash',
    supplierId: tenant.supplier.id,
    lines: [
      {
        kind: 'material',
        id: newId(),
        materialId: tenant.material.id,
        qty: '2',
        unit: 'l',
        unitPrice: '6',
      },
    ],
  }
}

async function newPurchaseDraft(): Promise<PurchaseDto> {
  const result = await ok(
    call<{ data: PurchaseDto }>(tenant.owner, 'purchase.create', 'mutation', {
      ...(await purchaseDraftInput()),
    }),
  )
  return result.data
}

async function newPostedPurchase(): Promise<PurchaseDto> {
  const draft = await newPurchaseDraft()
  const result = await ok(
    call<{ data: PurchaseDto }>(tenant.owner, 'purchase.post', 'mutation', {
      id: draft.id,
      version: draft.version,
    }),
  )
  return result.data
}

function returnDraftInput() {
  return {
    id: newId(),
    purchaseId: tenant.purchase.id,
    kind: 'return',
    businessDate: tenant.purchase.businessDate,
    lines: [{ id: newId(), purchaseLineId: tenant.purchase.lines[0]?.id, qty: '1' }],
  }
}

async function newReturnDraft(): Promise<PurchaseReturnDto> {
  const result = await ok(
    call<{ data: PurchaseReturnDto }>(
      tenant.owner,
      'purchaseReturn.create',
      'mutation',
      returnDraftInput(),
    ),
  )
  return result.data
}

async function uploadedReceipt(): Promise<string> {
  const upload = await ok(
    call<AttachmentUploadUrlDto>(tenant.owner, 'attachment.uploadUrl', 'mutation', {
      entity: 'purchase',
      entityId: tenant.purchase.id,
      contentType: 'image/png',
    }),
  )
  expect((await uploadTo(upload.uploadUrl, PNG, 'image/png')).ok).toBe(true)
  return upload.path
}

async function newCategory(): Promise<CostCategoryDto> {
  return ok(
    call<CostCategoryDto>(tenant.owner, 'costCategory.create', 'mutation', {
      id: newId(),
      name: `Category ${newId()}`,
    }),
  )
}

function expenseInput(extra: object = {}) {
  return {
    id: newId(),
    categoryId: tenant.category.id,
    businessDate: tenant.expense.businessDate,
    documentType: 'tax_invoice',
    paymentMethod: 'cash',
    amount: '20',
    vatRate: '0',
    ...extra,
  }
}

async function newExpenseDraft(extra: object = {}): Promise<ExpenseDto> {
  return (
    await ok(
      call<{ data: ExpenseDto }>(tenant.owner, 'expense.create', 'mutation', expenseInput(extra)),
    )
  ).data
}

async function newPostedExpense(extra: object = {}): Promise<ExpenseDto> {
  const draft = await newExpenseDraft(extra)
  return (
    await ok(
      call<{ data: ExpenseDto }>(tenant.owner, 'expense.post', 'mutation', {
        id: draft.id,
        version: draft.version,
      }),
    )
  ).data
}

/** Approval on (the fixture turns it on; a probe may have turned it off since). */
async function approvalOn() {
  await ok(call(tenant.owner, 'expense.updateSettings', 'mutation', { approval: true }))
}

async function newSubmittedExpense(): Promise<ExpenseDto> {
  await approvalOn()
  const draft = await newExpenseDraft()
  return (
    await ok(
      call<{ data: ExpenseDto }>(tenant.owner, 'expense.submit', 'mutation', {
        id: draft.id,
        version: draft.version,
      }),
    )
  ).data
}

function runningCostInput(extra: object = {}) {
  return {
    id: newId(),
    name: `Rent ${newId().slice(-6)}`,
    categoryId: tenant.runningCategory.id,
    amount: '1000',
    startsOn: tenant.expense.businessDate,
    ...extra,
  }
}

async function newRunningCost(): Promise<RunningCostDto> {
  return (
    await ok(
      call<{ data: RunningCostDto }>(
        tenant.owner,
        'runningCost.create',
        'mutation',
        runningCostInput(),
      ),
    )
  ).data
}

/** A sale of the tenant's product in its channel, today (a draft; delivery without its cost). */
function saleInput(extra: object = {}) {
  return {
    id: newId(),
    source: 'single',
    businessDate: tenant.sale.businessDate,
    channelId: tenant.channel.id,
    deliveryNeeded: true,
    lines: [
      { kind: 'item', id: newId(), productId: tenant.product.id, qty: '1', unitPrice: '15.5' },
    ],
    ...extra,
  }
}

async function newSale(post = false): Promise<SaleDto> {
  const draft = (
    await ok(call<{ data: SaleDto }>(tenant.owner, 'sale.create', 'mutation', saleInput()))
  ).data
  if (!post) return draft
  return (
    await ok(
      call<{ data: SaleDto }>(tenant.owner, 'sale.post', 'mutation', {
        id: draft.id,
        version: draft.version,
      }),
    )
  ).data
}

async function newChannel(): Promise<SalesChannelDto> {
  return (
    await ok(
      call<{ data: SalesChannelDto }>(tenant.owner, 'channel.create', 'mutation', {
        id: newId(),
        name: `Channel ${newId()}`,
        kind: 'marketplace',
      }),
    )
  ).data
}

async function asOwner(path: string, input?: unknown): Promise<Done> {
  return {
    result: await call(tenant.owner, path, 'mutation', input),
    actor: tenant.owner.user,
    businessId: tenant.id,
  }
}

const AUDIT: Record<string, AuditProbe> = {
  'account.updateProfile': {
    run: async () => {
      // A new name is copied to the caller's memberships (D-065): those rows are audited.
      const { person } = await newMember()
      const result = await call(person, 'account.updateProfile', 'mutation', {
        displayName: `Renamed ${newId().slice(-6)}`,
      })
      return { result, actor: person.user, businessId: tenant.id }
    },
  },
  'account.setLastBusiness': {
    noAudit:
      'writes only profiles.last_business_id, the account’s own preference outside any business; ' +
      'profiles are account rows, not business data, and have no audit trigger (D-050)',
    run: async () => ({
      result: await call(tenant.admin, 'account.setLastBusiness', 'mutation', {
        businessId: tenant.id,
      }),
      actor: tenant.admin.user,
      businessId: tenant.id,
    }),
  },
  'account.delete': {
    run: async () => {
      const { person } = await newMember()
      const result = await call(person, 'account.delete', 'mutation')
      return { result, actor: person.user, businessId: tenant.id }
    },
  },
  'business.createFromSetup': {
    run: async () => {
      const person = await api.newPerson()
      const businessId = newId()
      const result = await call(
        person,
        'business.createFromSetup',
        'mutation',
        {
          businessId,
          legalName: 'Audit New Business',
          locale: 'en',
          questionSetVersion: QUESTION_SET_VERSION,
          answers: WORKSHOP,
          adjustments: { modules: [], capabilities: [] },
        },
        undefined,
      )
      return { result, actor: person.user, businessId }
    },
  },
  'business.updateProfile': {
    run: async () => {
      const profile = await ok(call<BusinessProfileDto>(tenant.owner, 'business.profile', 'query'))
      return asOwner('business.updateProfile', {
        version: profile.version,
        legalName: profile.legalName,
        legalNameAr: `اسم ${newId().slice(-6)}`,
        vatRegistered: profile.vatRegistered,
        trn: profile.trn,
      })
    },
  },
  'business.setDefaultLocale': {
    run: async () => {
      const profile = await ok(call<BusinessProfileDto>(tenant.owner, 'business.profile', 'query'))
      return asOwner('business.setDefaultLocale', {
        defaultLocale: profile.defaultLocale === 'en' ? 'ar' : 'en',
      })
    },
  },
  'business.logoUploadUrl': {
    run: () => asOwner('business.logoUploadUrl', { contentType: 'image/png' }),
  },
  'business.setLogo': {
    run: async () => asOwner('business.setLogo', { path: await uploadedLogo() }),
  },
  'business.removeLogo': {
    run: async () => {
      await ok(call(tenant.owner, 'business.setLogo', 'mutation', { path: await uploadedLogo() }))
      return asOwner('business.removeLogo')
    },
  },
  'business.customize': {
    run: async () => {
      const customization = await ok(
        call<{ capabilities: Record<string, boolean> }>(
          tenant.owner,
          'business.customization',
          'query',
        ),
      )
      return asOwner('business.customize', {
        item: { kind: 'capability', key: 'uses_machines' },
        enabled: !customization.capabilities.uses_machines,
      })
    },
  },
  'location.create': {
    run: () => asOwner('location.create', { id: newId(), name: `Audit ${newId().slice(-6)}` }),
  },
  'location.rename': {
    run: async () => {
      const location = await newLocation()
      return asOwner('location.rename', {
        id: location.id,
        name: `Renamed ${newId().slice(-6)}`,
        version: location.version,
      })
    },
  },
  'location.setDefault': {
    run: async () => asOwner('location.setDefault', { id: (await newLocation()).id }),
  },
  'location.remove': {
    run: async () => asOwner('location.remove', { id: (await newLocation()).id }),
  },
  'member.changeRole': {
    run: async () => {
      const { memberId } = await newMember()
      return asOwner('member.changeRole', { memberId, roleId: tenant.roles.sales.id })
    },
  },
  'member.remove': {
    run: async () => asOwner('member.remove', { memberId: (await newMember()).memberId }),
  },
  'member.leave': {
    run: async () => {
      const { person } = await newMember()
      return {
        result: await call(person, 'member.leave', 'mutation'),
        actor: person.user,
        businessId: tenant.id,
      }
    },
  },
  // A member's own access (M2 Step 7): the override rows and the member's new permissions version.
  'member.updatePermissions': {
    run: async () => {
      const { memberId } = await newMember()
      const read = await ok(
        call<{ version: number }>(tenant.owner, 'member.permissions', 'query', { memberId }),
      )
      return asOwner('member.updatePermissions', {
        memberId,
        version: read.version,
        overrides: [{ key: 'suppliers.items.view', effect: 'allow' }],
      })
    },
  },
  'member.transferOwnership': {
    run: async () => {
      // In a business of its own, so the tenant keeps its owner.
      const owner = await api.newPerson()
      const businessId = await setupBusiness(api.handler, owner.token, WORKSHOP)
      const heir = await api.newPerson()
      const memberId = await join(api.db, owner.user, businessId, heir.user, 'admin')
      const result = await call(
        owner,
        'member.transferOwnership',
        'mutation',
        { memberId },
        businessId,
      )
      return { result, actor: owner.user, businessId }
    },
  },
  'invitation.create': {
    run: () =>
      asOwner('invitation.create', {
        id: newId(),
        email: `audit-${newId()}@test.bizcost.local`,
        roleId: tenant.roles.employee.id,
        locale: 'en',
      }),
  },
  'invitation.resend': {
    run: async () => asOwner('invitation.resend', { id: (await newInvitation()).id }),
  },
  'invitation.revoke': {
    run: async () => asOwner('invitation.revoke', { id: (await newInvitation()).id }),
  },
  'invitation.accept': {
    run: async () => {
      const person = await api.newPerson()
      await newInvitation(person.user.email)
      const result = await call(
        person,
        'invitation.accept',
        'mutation',
        { token: api.emails.tokenFor(person.user.email) },
        undefined,
      )
      return { result, actor: person.user, businessId: tenant.id }
    },
  },
  'role.updatePermissions': {
    run: async () => {
      const roles = await ok(call<RoleDto[]>(tenant.owner, 'role.list', 'query'))
      const sales = roles.find((role) => role.templateKey === 'sales')
      if (!sales) throw new Error('no sales role')
      const keys = new Set(sales.permissionKeys)
      if (keys.has('settings.business.view')) keys.delete('settings.business.view')
      else keys.add('settings.business.view')
      return asOwner('role.updatePermissions', {
        id: sales.id,
        version: sales.version,
        permissionKeys: [...keys],
      })
    },
  },
  // Materials and Products & Services: every write is audited (materials, material_units,
  // products_services, product_locations).
  'material.create': {
    run: () =>
      asOwner('material.create', {
        id: newId(),
        name: `Sugar ${newId()}`,
        unit: 'kg',
        packs: [{ id: newId(), name: 'sack', qty: '50', ofUnit: 'kg' }],
      }),
  },
  'material.quickCreate': {
    run: async () => ({
      result: await call(tenant.admin, 'material.quickCreate', 'mutation', {
        id: newId(),
        name: 'Straws ' + newId(),
        unit: 'piece',
        packs: [{ id: newId(), name: 'box', qty: '100', ofUnit: 'piece' }],
      }),
      actor: tenant.admin.user,
      businessId: tenant.id,
    }),
  },
  'material.update': {
    run: async () => {
      const material = await newMaterial()
      return asOwner('material.update', {
        id: material.id,
        version: material.version,
        name: material.name,
        unit: 'g',
        packs: [{ id: newId(), name: 'box', qty: '250', ofUnit: 'g' }],
      })
    },
  },
  'material.archive': {
    run: async () => asOwner('material.archive', { id: (await newMaterial()).id }),
  },
  'material.unarchive': {
    run: async () => {
      const material = await newMaterial()
      await ok(call(tenant.owner, 'material.archive', 'mutation', { id: material.id }))
      return asOwner('material.unarchive', { id: material.id })
    },
  },
  'product.create': {
    run: () =>
      asOwner('product.create', {
        id: newId(),
        name: `Tea ${newId()}`,
        type: 'product',
        unit: 'piece',
        defaultPrice: '12',
        locationIds: [tenant.branch.id],
      }),
  },
  'product.update': {
    run: async () => {
      const product = await newProduct()
      return asOwner('product.update', {
        id: product.id,
        version: product.version,
        name: product.name,
        type: 'product',
        unit: 'piece',
        defaultPrice: '18.25',
        locationIds: [tenant.defaultLocationId],
      })
    },
  },
  'product.archive': {
    run: async () => asOwner('product.archive', { id: (await newProduct()).id }),
  },
  'product.unarchive': {
    run: async () => {
      const product = await newProduct()
      await ok(call(tenant.owner, 'product.archive', 'mutation', { id: product.id }))
      return asOwner('product.unarchive', { id: product.id })
    },
  },
  // Suppliers, purchases, returns and credit notes, receipts and the books-closed date (M2 Step 3):
  // every write is audited, a posting's too (stock_movements, material_costs, stock_balances,
  // purchases and their lines).
  'supplier.create': {
    run: () => asOwner('supplier.create', { id: newId(), name: `Supplier ${newId()}` }),
  },
  'supplier.update': {
    run: async () => {
      const supplier = await newSupplier()
      return asOwner('supplier.update', {
        id: supplier.id,
        version: supplier.version,
        name: `${supplier.name} LLC`,
        phone: '+971 4 000 0000',
      })
    },
  },
  'supplier.archive': {
    run: async () => asOwner('supplier.archive', { id: (await newSupplier()).id }),
  },
  'supplier.unarchive': {
    run: async () => {
      const supplier = await newSupplier()
      await ok(call(tenant.owner, 'supplier.archive', 'mutation', { id: supplier.id }))
      return asOwner('supplier.unarchive', { id: supplier.id })
    },
  },
  'purchase.create': {
    run: async () => asOwner('purchase.create', await purchaseDraftInput()),
  },
  'purchase.update': {
    run: async () => {
      const draft = await newPurchaseDraft()
      return asOwner('purchase.update', {
        ...(await purchaseDraftInput()),
        id: draft.id,
        version: draft.version,
        reference: 'Changed',
      })
    },
  },
  'purchase.discard': {
    run: async () => {
      const draft = await newPurchaseDraft()
      return asOwner('purchase.discard', { id: draft.id, version: draft.version })
    },
  },
  'purchase.post': {
    run: async () => {
      const draft = await newPurchaseDraft()
      return asOwner('purchase.post', { id: draft.id, version: draft.version })
    },
  },
  'purchase.reverse': {
    run: async () => asOwner('purchase.reverse', { id: (await newPostedPurchase()).id }),
  },
  'purchase.correct': {
    run: async () =>
      asOwner('purchase.correct', { id: (await newPostedPurchase()).id, newId: newId() }),
  },
  'purchaseReturn.create': {
    run: async () => asOwner('purchaseReturn.create', returnDraftInput()),
  },
  'purchaseReturn.update': {
    run: async () => {
      const draft = await newReturnDraft()
      return asOwner('purchaseReturn.update', {
        id: draft.id,
        version: draft.version,
        businessDate: draft.businessDate,
        reference: 'RN-2',
        lines: [{ id: newId(), purchaseLineId: tenant.purchase.lines[0]?.id, qty: '0.5' }],
      })
    },
  },
  'purchaseReturn.discard': {
    run: async () => {
      const draft = await newReturnDraft()
      return asOwner('purchaseReturn.discard', { id: draft.id, version: draft.version })
    },
  },
  'purchaseReturn.post': {
    run: async () => {
      const draft = await newReturnDraft()
      return asOwner('purchaseReturn.post', { id: draft.id, version: draft.version })
    },
  },
  'purchaseReturn.reverse': {
    run: async () => {
      const draft = await newReturnDraft()
      await ok(
        call(tenant.owner, 'purchaseReturn.post', 'mutation', {
          id: draft.id,
          version: draft.version,
        }),
      )
      return asOwner('purchaseReturn.reverse', { id: draft.id })
    },
  },
  'attachment.uploadUrl': {
    run: () =>
      asOwner('attachment.uploadUrl', {
        entity: 'purchase',
        entityId: tenant.purchase.id,
        contentType: 'application/pdf',
      }),
  },
  'attachment.add': {
    run: async () =>
      asOwner('attachment.add', {
        entity: 'purchase',
        entityId: tenant.purchase.id,
        path: await uploadedReceipt(),
        fileName: 'receipt.png',
      }),
  },
  'attachment.remove': {
    run: async () => {
      const added = await ok(
        call<{ data: { id: string } }>(tenant.owner, 'attachment.add', 'mutation', {
          entity: 'purchase',
          entityId: tenant.purchase.id,
          path: await uploadedReceipt(),
          fileName: 'gone.png',
        }),
      )
      return asOwner('attachment.remove', { id: added.data.id })
    },
  },
  // Recipes (M2 Step 4): a recipe's first save writes its row and its lines (recipes, recipe_lines);
  // a later save, a line moved to another material, is exercised below.
  'recipe.save': {
    run: async () => {
      const [product, material] = [await newProduct(), await newMaterial()]
      return asOwner('recipe.save', {
        productId: product.id,
        version: 0,
        lines: [{ id: newId(), materialId: material.id, qty: '18', unit: 'g' }],
      })
    },
  },
  'purchasePayment.record': {
    run: () =>
      asOwner('purchasePayment.record', {
        id: newId(),
        purchaseId: tenant.creditPurchase.id,
        businessDate: tenant.creditPurchase.businessDate,
        method: 'card',
        amount: '1',
      }),
  },
  'purchasePayment.reverse': {
    run: async () => {
      const id = newId()
      await ok(
        call(tenant.owner, 'purchasePayment.record', 'mutation', {
          id,
          purchaseId: tenant.creditPurchase.id,
          businessDate: tenant.creditPurchase.businessDate,
          method: 'cash',
          amount: '1',
        }),
      )
      return asOwner('purchasePayment.reverse', { id })
    },
  },
  // Expenses, their categories and payments, and running costs (M2 Step 5).
  'costCategory.create': {
    run: () => asOwner('costCategory.create', { id: newId(), name: `Category ${newId()}` }),
  },
  'costCategory.update': {
    run: async () => {
      const category = await newCategory()
      return asOwner('costCategory.update', {
        id: category.id,
        version: category.version,
        name: `Renamed ${newId()}`,
      })
    },
  },
  'costCategory.archive': {
    run: async () => asOwner('costCategory.archive', { id: (await newCategory()).id }),
  },
  'costCategory.unarchive': {
    run: async () => {
      const category = await newCategory()
      await ok(call(tenant.owner, 'costCategory.archive', 'mutation', { id: category.id }))
      return asOwner('costCategory.unarchive', { id: category.id })
    },
  },
  'expense.create': { run: () => asOwner('expense.create', expenseInput()) },
  'expense.update': {
    run: async () => {
      const draft = await newExpenseDraft()
      return asOwner('expense.update', {
        ...expenseInput({ description: 'Changed' }),
        id: draft.id,
        version: draft.version,
      })
    },
  },
  'expense.discard': {
    run: async () => {
      const draft = await newExpenseDraft()
      return asOwner('expense.discard', { id: draft.id, version: draft.version })
    },
  },
  'expense.submit': {
    run: async () => {
      await approvalOn()
      const draft = await newExpenseDraft()
      return asOwner('expense.submit', { id: draft.id, version: draft.version })
    },
  },
  'expense.approve': {
    run: async () => {
      const sent = await newSubmittedExpense()
      return asOwner('expense.approve', { id: sent.id, version: sent.version })
    },
  },
  'expense.reject': {
    run: async () => {
      const sent = await newSubmittedExpense()
      return asOwner('expense.reject', { id: sent.id, version: sent.version, reason: 'Why' })
    },
  },
  'expense.post': {
    run: async () => {
      const draft = await newExpenseDraft()
      return asOwner('expense.post', { id: draft.id, version: draft.version })
    },
  },
  'expense.reverse': {
    run: async () => asOwner('expense.reverse', { id: (await newPostedExpense()).id }),
  },
  'expense.correct': {
    run: async () =>
      asOwner('expense.correct', { id: (await newPostedExpense()).id, newId: newId() }),
  },
  'expense.updateSettings': {
    run: async () => {
      await approvalOn()
      const done = await asOwner('expense.updateSettings', { approval: false })
      await approvalOn()
      return done
    },
  },
  'expensePayment.record': {
    run: async () => {
      const bill = await newPostedExpense({
        supplierId: tenant.supplier.id,
        paymentMethod: 'supplier_credit',
      })
      return asOwner('expensePayment.record', {
        id: newId(),
        expenseId: bill.id,
        businessDate: bill.businessDate,
        method: 'card',
        amount: '1',
      })
    },
  },
  'expensePayment.reverse': {
    run: async () => {
      const bill = await newPostedExpense({
        supplierId: tenant.supplier.id,
        paymentMethod: 'supplier_credit',
      })
      const id = newId()
      await ok(
        call(tenant.owner, 'expensePayment.record', 'mutation', {
          id,
          expenseId: bill.id,
          businessDate: bill.businessDate,
          method: 'cash',
          amount: '1',
        }),
      )
      return asOwner('expensePayment.reverse', { id })
    },
  },
  // Product costs (M2 Step 6): the settings are the business's row: the owner's hourly rate, only
  // without a team (D-119; the fixture has one, and running costs need no setting, D-202), so in a
  // business of its own, set up without a team.
  'productCost.updateSettings': {
    run: async () => {
      const owner = await api.newPerson()
      const businessId = await setupBusiness(api.handler, owner.token, BAKER)
      const result = await call(
        owner,
        'productCost.updateSettings',
        'mutation',
        { ownerHourlyRate: String((Date.now() % 1_000) + 1) },
        businessId,
      )
      return { result, actor: owner.user, businessId }
    },
  },
  'runningCost.create': { run: () => asOwner('runningCost.create', runningCostInput()) },
  'runningCost.update': {
    run: async () => {
      const cost = await newRunningCost()
      return asOwner('runningCost.update', {
        ...runningCostInput({ amount: '1200' }),
        id: cost.id,
        version: cost.version,
      })
    },
  },
  'runningCost.remove': {
    run: async () => {
      const cost = await newRunningCost()
      return asOwner('runningCost.remove', { id: cost.id, version: cost.version })
    },
  },
  // Sales (M3 Step 2, previewed: D-125).
  'channel.create': {
    run: () =>
      asOwner('channel.create', { id: newId(), name: `Noon ${newId()}`, kind: 'marketplace' }),
  },
  'channel.update': {
    run: async () => {
      const channel = await newChannel()
      return asOwner('channel.update', {
        id: channel.id,
        version: channel.version,
        name: `Renamed ${newId()}`,
        kind: 'delivery_app',
        feePercent: '12.5',
      })
    },
  },
  'channel.archive': {
    run: async () => asOwner('channel.archive', { id: (await newChannel()).id }),
  },
  'channel.unarchive': {
    run: async () => {
      const channel = await newChannel()
      await ok(call(tenant.owner, 'channel.archive', 'mutation', { id: channel.id }))
      return asOwner('channel.unarchive', { id: channel.id })
    },
  },
  'sale.create': { run: () => asOwner('sale.create', saleInput()) },
  'sale.update': {
    run: async () => {
      const draft = await newSale()
      const fields = updateFieldsOf(saleInput({ deliveryCost: '4' }))
      return asOwner('sale.update', { ...fields, id: draft.id, version: draft.version })
    },
  },
  'sale.discard': {
    run: async () => {
      const draft = await newSale()
      return asOwner('sale.discard', { id: draft.id, version: draft.version })
    },
  },
  'sale.post': {
    run: async () => {
      const draft = await newSale()
      return asOwner('sale.post', { id: draft.id, version: draft.version })
    },
  },
  'sale.reverse': { run: async () => asOwner('sale.reverse', { id: (await newSale(true)).id }) },
  'sale.correct': {
    run: async () => asOwner('sale.correct', { id: (await newSale(true)).id, newId: newId() }),
  },
  'sale.fillDeliveryCost': {
    run: async () =>
      asOwner('sale.fillDeliveryCost', { id: (await newSale(true)).id, deliveryCost: '6' }),
  },
  'member.updateLocations': {
    run: async () => {
      const { memberId } = await newMember()
      const { version } = await ok(
        call<{ version: number }>(tenant.owner, 'member.locations', 'query', { memberId }),
      )
      return asOwner('member.updateLocations', {
        memberId,
        version,
        locationIds: [tenant.branch.id],
      })
    },
  },
  'books.close': {
    run: async () => {
      // Yesterday: the purchases of the other probes (dated today) stay open.
      const yesterday = new Date(`${tenant.purchase.businessDate}T00:00:00Z`)
      yesterday.setUTCDate(yesterday.getUTCDate() - 1)
      return asOwner('books.close', { closedThrough: yesterday.toISOString().slice(0, 10) })
    },
  },
}

const PROCEDURES = proceduresOf(appRouter)
const MUTATIONS = PROCEDURES.filter((p) => p.type === 'mutation').map((p) => p.path)
const QUERIES = PROCEDURES.filter((p) => p.type === 'query')

async function auditRows(requestId: string) {
  return api.admin<{ business_id: string; actor_user_id: string | null; entity: string }[]>`
    select business_id, actor_user_id, entity from app.audit_log
     where request_id = ${requestId} order by id`
}

describe('audit coverage', () => {
  it('has one probe per mutation of appRouter', () => {
    expect(Object.keys(AUDIT).sort()).toEqual(MUTATIONS)
  })

  it.each(MUTATIONS)(
    '%s: its writes are audited with the caller and the request id',
    async (path) => {
      const probe = AUDIT[path]
      if (!probe) throw new Error(`${path} has no audit probe`)
      const { result, actor, businessId } = await probe.run()
      expect(result.error, result.raw).toBeUndefined()
      const requestId = result.headers.get('x-request-id') ?? ''
      expect(requestId).toMatch(/^[0-9a-f-]{36}$/)
      const rows = await auditRows(requestId)
      if (probe.noAudit) {
        expect(rows, probe.noAudit).toEqual([])
        return
      }
      expect(rows.length, 'at least one audit row').toBeGreaterThan(0)
      for (const row of rows) {
        expect(row, row.entity).toMatchObject({ actor_user_id: actor.id, business_id: businessId })
      }
    },
  )

  it.each(QUERIES.map((p) => [p.path, p] as const))(
    '%s (a query) writes no audited row',
    async (_path, procedure) => {
      const input =
        procedure.path === 'invitation.preview'
          ? { token: tenant.invitationToken }
          : queryInputOf(procedure.path, tenant)
      const result = await callProcedure(api.handler, procedure, tenant.owner.token, {
        businessId: procedure.base === 'business' ? tenant.id : undefined,
        input,
      })
      expect(result.error, result.raw).toBeUndefined()
      expect(await auditRows(result.headers.get('x-request-id') ?? '')).toEqual([])
    },
  )
})

describe('recipe.save, a line moved and a line taken out (M2 Step 4)', () => {
  it('audits the recipe’s new version and each line it changes, with the caller', async () => {
    const [product, beans, sugar, cup] = [
      await newProduct(),
      await newMaterial(),
      await newMaterial(),
      await newMaterial(),
    ]
    const moved = newId()
    const dropped = newId()
    const first = await ok(
      call<RecipeResultDto>(tenant.owner, 'recipe.save', 'mutation', {
        productId: product.id,
        version: 0,
        lines: [
          { id: moved, materialId: beans.id, qty: '18', unit: 'g' },
          { id: dropped, materialId: cup.id, qty: '1', unit: 'kg' },
        ],
      }),
    )
    const result = await call<RecipeResultDto>(tenant.owner, 'recipe.save', 'mutation', {
      productId: product.id,
      version: first.data.version,
      lines: [{ id: moved, materialId: sugar.id, qty: '5', unit: 'g' }],
    })
    expect(result.error, result.raw).toBeUndefined()
    const rows = await api.admin<
      {
        entity: string
        entity_id: string
        action: string
        actor_user_id: string
        business_id: string
      }[]
    >`
      select entity, entity_id, action, actor_user_id, business_id from app.audit_log
       where request_id = ${result.headers.get('x-request-id') ?? ''} order by id`
    for (const row of rows) {
      expect(row).toMatchObject({ actor_user_id: tenant.owner.user.id, business_id: tenant.id })
    }
    expect(rows.filter((r) => r.entity === 'recipes').map((r) => r.action)).toEqual(['update'])
    const lines = rows.filter((r) => r.entity === 'recipe_lines')
    expect(new Set(lines.map((r) => r.entity_id))).toEqual(new Set([moved, dropped]))
    expect(lines.every((r) => r.action === 'update')).toBe(true)
  })
})

describe('the documented exceptions (D-103), exercised', () => {
  interface AuditChange {
    business_id: string
    actor_user_id: string | null
    entity: string
    entity_id: string
    action: string
    changes: { before?: Record<string, unknown>; after?: Record<string, unknown> }
  }

  async function auditChanges(result: CallResult) {
    return api.admin<AuditChange[]>`
      select business_id, actor_user_id, entity, entity_id, action, changes from app.audit_log
       where request_id = ${result.headers.get('x-request-id') ?? ''} order by id`
  }

  /** Kept by app.touch_row() on every update. */
  const TOUCH_COLUMNS: ReadonlySet<string> = new Set(['updated_at', 'updated_by', 'version'])

  /** The columns an update changed (before vs after). */
  function changedColumns(change: AuditChange['changes']): string[] {
    const before = change.before ?? {}
    const after = change.after ?? {}
    return Object.keys({ ...before, ...after })
      .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
      .sort()
  }

  it('`me` after the account’s email changed: one audited update per membership, of the email alone, by the caller; then none', async () => {
    const person = await api.newPerson()
    const tenantMemberId = await join(api.db, tenant.owner.user, tenant.id, person.user, 'employee')
    const ownBusinessId = await setupBusiness(api.handler, person.token, WORKSHOP)

    // The member's confirmed email change: their next token carries the new address.
    const moved = { ...person.user, email: `moved-${newId()}@test.bizcost.local` }
    await api.admin`update auth.users set email = ${moved.email} where id = ${person.user.id}`
    const token = await mintToken(moved)
    const first = await query(api.handler, 'me', { token })
    expect(first.error, first.raw).toBeUndefined()

    const rows = await auditChanges(first)
    expect(rows.map((row) => row.business_id).sort()).toEqual([tenant.id, ownBusinessId].sort())
    for (const row of rows) {
      expect(row).toMatchObject({
        actor_user_id: person.user.id,
        entity: 'business_members',
        action: 'update',
      })
      // Only the token's own verified email is written (a cross-site GET can set nothing else).
      const changed = changedColumns(row.changes)
      expect(changed).toContain('email')
      expect(changed.filter((column) => !TOUCH_COLUMNS.has(column))).toEqual(['email'])
      expect(row.changes.after?.email).toBe(moved.email)
      expect(row.changes.after?.user_id).toBe(person.user.id)
    }
    expect(rows.map((row) => row.entity_id)).toContain(tenantMemberId)

    const again = await query(api.handler, 'me', { token })
    expect(again.error, again.raw).toBeUndefined()
    expect(await auditChanges(again), 'a second `me` writes nothing').toEqual([])
  })

  it('account-level profile writes are not audited: the profile `me` creates, a language, a name without a business', async () => {
    const person = await api.newPerson()
    // First `me`: the profile is created (an account row), no business row is written.
    const first = await query(api.handler, 'me', { token: person.token })
    expect(first.error, first.raw).toBeUndefined()
    expect(await auditChanges(first)).toEqual([])
    // A name saved by an account with no business: only profiles changes.
    const named = await mutate(api.handler, 'account.updateProfile', {
      token: person.token,
      input: { displayName: `Solo ${newId().slice(-6)}` },
    })
    expect(named.error, named.raw).toBeUndefined()
    expect(await auditChanges(named)).toEqual([])

    // A member's language (the language switch): profiles only, even with memberships.
    const { person: member } = await newMember()
    const language = await mutate(api.handler, 'account.updateProfile', {
      token: member.token,
      input: { locale: 'ar' },
    })
    expect(language.error, language.raw).toBeUndefined()
    expect(await auditChanges(language)).toEqual([])
  })
})

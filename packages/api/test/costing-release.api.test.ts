import type {
  AttachmentListDto,
  BooksDto,
  BusinessContextDto,
  CostStepDto,
  DashboardChecklistDto,
  ExpenseDto,
  MemberPermissionsDto,
  ProductDto,
  PurchasePayersDto,
  RoleDto,
} from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Envelope } from './expenses'
import { handlerFor } from './helpers'
import { CostScope, ProductCostsApi, tag } from './product-costs'
import { codeOf, line, ok, purchaseInput, type Person } from './purchasing'
import { BAKER, WORKSHOP } from './settings'

// The Costing Core's release (ROADMAP.md M2 Step 7): its modules served by released code, without
// the dev-only preview, still gated by the module being on and the member's keys; the Files module
// that receipts need; the VAT fields a business that is not VAT-registered never has; and the
// Dashboard's "Let's find the real cost of what you sell" (PRODUCT.md §10), its steps from real data,
// only those the member can act on.

const api = new ProductCostsApi()

afterAll(() => api.close())

const steps = async (scope: CostScope, person: Person = scope.owner): Promise<CostStepDto[]> =>
  ok(await scope.as<DashboardChecklistDto>(person, 'dashboard.checklist')).costSteps
const byId = (list: CostStepDto[]) => Object.fromEntries(list.map(({ id, ...rest }) => [id, rest]))

describe('released code serves the Costing Core, gated by module and permission', () => {
  it('every module of the Costing Core answers without the preview; a module turned off does not', async () => {
    const shop = await CostScope.open(api, WORKSHOP)
    const released = handlerFor(api.db)
    const reads: Record<string, string> = {
      products: 'product.list',
      materials: 'material.list',
      suppliers: 'supplier.list',
      purchases: 'purchase.list',
      expenses: 'expense.list',
      running_costs: 'runningCost.list',
      cost_engine: 'productCost.list',
    }
    for (const path of Object.values(reads)) {
      expect((await api.call(shop.owner, shop.id, path, undefined, released)).error, path).toBe(
        undefined,
      )
    }
    // A Sales member sees products only.
    const sales = await api.member(shop, 'sales')
    for (const [id, path] of Object.entries(reads)) {
      const result = await api.call(sales, shop.id, path, undefined, released)
      expect(codeOf(result) ?? 'ok', id).toBe(id === 'products' ? 'ok' : 'forbidden')
    }
    // Turned off: gone for everyone, the owner too.
    ok(
      await shop.run('business.customize', {
        item: { kind: 'module', id: 'running_costs' },
        enabled: false,
      }),
    )
    expect(codeOf(await shop.run('runningCost.list'))).toBe('module_disabled')
  })

  it('receipts need the Files module on: with it off, the attachments are refused and the record stays', async () => {
    const shop = await CostScope.open(api, WORKSHOP)
    const today = await shop.today()
    const milk = await shop.material()
    const purchase = await shop.draft(purchaseInput(today, [line(milk.id, '1', '5')]))
    const input = { entity: 'purchase', entityId: purchase.id }
    expect(ok(await shop.run<AttachmentListDto>('attachment.list', input)).data.items).toEqual([])
    const toggle = (enabled: boolean) =>
      shop.run('business.customize', { item: { kind: 'module', id: 'files' }, enabled })
    ok(await toggle(false))
    expect(codeOf(await shop.run('attachment.list', input))).toBe('module_disabled')
    expect(
      codeOf(await shop.run('attachment.uploadUrl', { ...input, contentType: 'image/png' })),
    ).toBe('module_disabled')
    ok(await shop.run('purchase.get', { id: purchase.id }))
    ok(await toggle(true))
    ok(await shop.run('attachment.list', input))
  })

  it('closing the books is a Settings key, used with Purchases or Expenses on (D-176, D-201)', async () => {
    const shop = await CostScope.open(api, WORKSHOP)
    const roles = ok(await shop.run<RoleDto[]>('role.list'))
    const admin = roles.find((r) => r.templateKey === 'admin')!
    expect(admin.permissionKeys).toContain('settings.books.close')
    expect(admin.permissionKeys).not.toContain('purchases.books.close')
    for (const role of roles.filter((r) => r.templateKey !== 'admin' && !r.isOwner)) {
      expect(role.permissionKeys, role.templateKey ?? role.name).not.toContain(
        'settings.books.close',
      )
    }
    // The key alone, given to one Sales member: they read the date and close the books.
    const sales = await api.member(shop, 'sales')
    const before = ok(
      await shop.run<MemberPermissionsDto>('member.permissions', { memberId: sales.memberId }),
    )
    ok(
      await shop.run('member.updatePermissions', {
        memberId: sales.memberId,
        version: before.version,
        overrides: [{ key: 'settings.books.close', effect: 'allow' }],
      }),
    )
    const today = await shop.today()
    expect(ok(await shop.as<BooksDto>(sales, 'books.get')).closedThrough).toBeNull()
    expect(
      ok(await shop.as<BooksDto>(sales, 'books.close', { closedThrough: today })).closedThrough,
    ).toBe(today)
    // The old Purchases key is gone from the catalog.
    const after = ok(
      await shop.run<MemberPermissionsDto>('member.permissions', { memberId: sales.memberId }),
    )
    expect(after.effectiveKeys).toContain('settings.books.close')
    const refused = await shop.run('member.updatePermissions', {
      memberId: sales.memberId,
      version: after.version,
      overrides: [{ key: 'purchases.books.close', effect: 'allow' }],
    })
    expect(codeOf(refused)).toBe('validation')
    // Purchases off, Expenses on: the expenses still obey the date, so it still opens.
    const toggle = (id: string, enabled: boolean) =>
      shop.run('business.customize', { item: { kind: 'module', id }, enabled })
    ok(await toggle('purchases', false))
    expect(
      ok(await shop.as<BooksDto>(sales, 'books.close', { closedThrough: null })),
    ).toMatchObject({ closedThrough: null })
    // Neither on: nothing obeys the date, so there is nothing to close.
    ok(await toggle('expenses', false))
    expect(codeOf(await shop.run('books.close', { closedThrough: today }))).toBe('module_disabled')
    expect(codeOf(await shop.as(sales, 'books.get'))).toBe('module_disabled')
  })
})

describe('VAT fields only for a VAT-registered business (PRODUCT.md §5)', () => {
  it('a product keeps the standard rate and a price without VAT; a stored one is kept, never changed', async () => {
    const baker = await CostScope.open(api, BAKER)
    for (const extra of [{ vatCategory: 'zero_rated' }, { priceIncludesVat: true }]) {
      expect(
        codeOf(
          await baker.run('product.create', {
            id: newId(),
            name: `Cake ${tag()}`,
            type: 'product',
            unit: 'piece',
            ...extra,
          }),
        ),
        JSON.stringify(extra),
      ).toBe('capability_disabled')
    }
    const cake = await baker.product({ name: `Cake ${tag()}` })
    expect(cake).toMatchObject({ vatCategory: 'standard', priceIncludesVat: false })
    const renamed = await baker.updateProduct(cake, { name: `${cake.name} (big)` })
    expect(
      codeOf(await baker.run('product.update', { ...updateOf(renamed), vatCategory: 'exempt' })),
    ).toBe('capability_disabled')
    // Saved while VAT-registered, kept as it is once the business is not.
    const shop = await CostScope.open(api, WORKSHOP)
    const zero = await shop.product({ vatCategory: 'zero_rated', priceIncludesVat: true })
    await shop.deregisterVat()
    const kept = await shop.updateProduct(zero, { defaultPrice: '12' })
    expect(kept).toMatchObject({ vatCategory: 'zero_rated', priceIncludesVat: true })
  })
})

describe('"Paid by a member" only with a team (D-200)', () => {
  it('a business run alone does not pick it for an expense or a purchase; a draft that has it keeps it', async () => {
    const baker = await CostScope.open(api, BAKER)
    const today = await baker.today()
    const [category] = await baker.categories()
    const me = ok(await baker.run<PurchasePayersDto>('purchase.payers')).items.find((p) => p.isMe)!
    const paid = { paymentMethod: 'paid_by_member', paidByMemberId: me.memberId }
    const expense = baker.expenseInput(category!.id, today, {
      vatRate: '0',
      documentType: 'no_invoice',
    })
    expect(codeOf(await baker.run('expense.create', { ...expense, ...paid }))).toBe(
      'capability_disabled',
    )
    const material = await baker.material()
    const purchase = purchaseInput(today, [line(material.id, '1', '2', { vatRate: '0' })])
    expect(codeOf(await baker.run('purchase.create', { ...purchase, ...paid }))).toBe(
      'capability_disabled',
    )
    // Saved with it while the business had a team (written here directly): saved again and
    // finalized as it is.
    const draft = await baker.expenseDraft(expense)
    await api.admin`
      update app.expenses set payment_method = 'paid_by_member', paid_by_member_id = ${me.memberId}
       where business_id = ${baker.id} and id = ${draft.id}`
    const read = ok(await baker.run<Envelope<ExpenseDto>>('expense.get', { id: draft.id })).data
    const saved = ok(
      await baker.run<Envelope<ExpenseDto>>('expense.update', {
        ...expense,
        ...paid,
        id: draft.id,
        version: read.version,
        amount: '120',
      }),
    ).data
    expect(saved).toMatchObject({ paymentMethod: 'paid_by_member', amount: '120' })
    expect((await baker.postExpense(saved)).status).toBe('posted')
  })
})

function updateOf(product: ProductDto) {
  const { id, version, name, description, type, unit, defaultPrice, vatCategory } = product
  return {
    id,
    version,
    name,
    description,
    type,
    unit,
    defaultPrice,
    vatCategory,
    priceIncludesVat: product.priceIncludesVat,
  }
}

describe('"Let\'s find the real cost of what you sell" (dashboard.checklist)', () => {
  let baker: CostScope
  let today: string

  beforeAll(async () => {
    baker = await CostScope.open(api, BAKER)
    today = await baker.today()
  }, 60_000)

  it('the home baker (no team) gets every step, each done as she adds what it asks for', async () => {
    expect(byId(await steps(baker))).toEqual({
      products: { done: false, missing: [], remaining: null },
      recipes: { done: false, missing: [], remaining: null },
      purchases: { done: false, missing: [], remaining: null },
      running_costs: { done: false, missing: ['runningCosts'], remaining: null },
      owner_time: { done: false, missing: ['hourlyRate', 'minutes'], remaining: null },
      product_costs: { done: false, missing: [], remaining: null },
    })
    // What she sells: a cake, made at home, without what goes into it yet.
    const cake = await baker.product({ name: `Cake ${tag()}`, defaultPrice: '60' })
    expect(byId(await steps(baker))).toMatchObject({
      products: { done: true },
      recipes: { done: false, remaining: 1 },
      purchases: { done: false, remaining: null },
      product_costs: { done: false, remaining: 1 },
    })
    // What goes into it: flour, never bought yet.
    const flour = await baker.newMaterial({ name: `Flour ${tag()}`, unit: 'kg' })
    await baker.recipe(cake.id, [{ id: newId(), materialId: flour.id, qty: '500', unit: 'g' }])
    expect(byId(await steps(baker))).toMatchObject({
      recipes: { done: true, remaining: 0 },
      purchases: { done: false, remaining: 1 },
    })
    // Its price: a purchase, final.
    await baker.buy(purchaseInput(today, [line(flour.id, '10', '4', { unit: 'kg', vatRate: '0' })]))
    expect(byId(await steps(baker))).toMatchObject({ purchases: { done: true, remaining: 0 } })
    // Running costs: entered, and nothing else to set (they reach products by their price, D-202).
    const categories = await baker.categories()
    await baker.runningCost({
      id: newId(),
      name: 'Gas',
      categoryId: categories[0]!.id,
      amount: '300',
      startsOn: today,
    })
    expect(byId(await steps(baker)).running_costs).toEqual({
      done: true,
      missing: [],
      remaining: null,
    })
    // Her time: the hourly rate, and her minutes on the cake.
    await baker.settings({ ownerHourlyRate: '40' })
    expect(byId(await steps(baker)).owner_time).toEqual({
      done: false,
      missing: ['minutes'],
      remaining: null,
    })
    await baker.updateProduct(cake, { ownerMinutes: '45' })
    expect(byId(await steps(baker))).toMatchObject({
      owner_time: { done: true, missing: [] },
      product_costs: { done: true, remaining: 0 },
    })
    // Every step done; the first checklist is unchanged.
    const all = ok(await baker.run<DashboardChecklistDto>('dashboard.checklist'))
    expect(all.costSteps.every((step) => step.done)).toBe(true)
    expect(all.items.map((item) => item.id)).toEqual(['profile'])
  })

  it('shows each role template of a business with a team only the steps it can act on', async () => {
    const shop = await CostScope.open(api, WORKSHOP)
    const expected = {
      owner: ['products', 'recipes', 'purchases', 'running_costs', 'product_costs'],
      admin: ['products', 'recipes', 'purchases', 'running_costs', 'product_costs'],
      manager: ['products', 'recipes', 'purchases', 'running_costs', 'product_costs'],
      accountant: ['product_costs'],
      sales: [],
      supervisor: [],
      employee: [],
    } as const
    for (const [template, ids] of Object.entries(expected)) {
      const person = template === 'owner' ? shop.owner : await api.member(shop, template as never)
      expect(
        (await steps(shop, person)).map((step) => step.id),
        template,
      ).toEqual(ids)
    }
  })

  it('follows the modules the business has on, and a member who may not see costs', async () => {
    const shop = await CostScope.open(api, WORKSHOP)
    for (const id of ['cost_engine', 'running_costs']) {
      ok(await shop.run('business.customize', { item: { kind: 'module', id }, enabled: false }))
    }
    expect((await steps(shop)).map((step) => step.id)).toEqual(['products', 'recipes', 'purchases'])
    // A manager whose costs were taken away keeps the steps that change things, not those about costs.
    ok(
      await shop.run('business.customize', {
        item: { kind: 'module', id: 'cost_engine' },
        enabled: true,
      }),
    )
    const manager = await api.member(shop, 'manager')
    const { version } = ok(
      await shop.run<{ version: number }>('member.permissions', { memberId: manager.memberId }),
    )
    ok(
      await shop.run('member.updatePermissions', {
        memberId: manager.memberId,
        version,
        // The costs switch off, with what needs supplier prices (approving, paying; D-200).
        overrides: [
          'data.cost.view',
          'data.supplier_price.view',
          'data.profit_margin.view',
          'expenses.documents.approve',
          'expenses.payments.record',
          'purchases.payments.record',
        ].map((key) => ({ key, effect: 'deny' })),
      }),
    )
    expect((await steps(shop, manager)).map((step) => step.id)).toEqual([
      'products',
      'recipes',
      'purchases',
    ])
    expect((await steps(shop)).map((step) => step.id)).toEqual([
      'products',
      'recipes',
      'purchases',
      'product_costs',
    ])
  })

  it('asks no recipe of a shop whose items are bought ready to sell', async () => {
    const shop = await CostScope.open(api, BAKER)
    ok(
      await shop.run('product.create', {
        id: newId(),
        name: `Soap ${tag()}`,
        type: 'product',
        unit: 'piece',
        resale: { materialId: newId(), packs: [] },
      }),
    )
    const ids = (await steps(shop)).map((step) => step.id)
    expect(ids).not.toContain('recipes')
    expect(byId(await steps(shop)).purchases).toEqual({
      done: false,
      missing: [],
      remaining: 1,
    })
  })

  it('a business that sells only services is asked for its running costs too: they reach every service by its price (D-202)', async () => {
    // The freelance designer: services only, alone, no materials.
    const designer = await CostScope.open(api, {
      what_you_do: ['services'],
      workplace: 'home',
      team: 'alone',
      work_setup: ['none'],
      sales_channels: ['messages', 'quotes'],
      vat: 'no',
    })
    const today = await designer.today()
    const servicesOnly = async () =>
      ok(await designer.run<BusinessContextDto>('business.context')).sellsOnlyServices
    expect(await servicesOnly()).toBe(true)
    expect((await steps(designer)).map((step) => step.id)).toEqual([
      'products',
      'running_costs',
      'owner_time',
      'product_costs',
    ])
    // A logo design, 3 hours of her time, and her running costs.
    const logo = await designer.product({
      name: `Logo design ${tag()}`,
      type: 'service',
      defaultPrice: '1500',
    })
    await designer.settings({ ownerHourlyRate: '150' })
    await designer.updateProduct(logo, { ownerMinutes: '180' })
    expect(byId(await steps(designer)).running_costs).toEqual({
      done: false,
      missing: ['runningCosts'],
      remaining: null,
    })
    const [category] = await designer.categories()
    await designer.runningCost({
      id: newId(),
      name: 'Software',
      categoryId: category!.id,
      amount: '300',
      startsOn: today,
    })
    // Its cost is her time until sales are recorded, then its share of the running costs by its
    // price: nothing is missing now (Materials off: no materials to ask for).
    const page = await designer.costList()
    expect(page.counts).toMatchObject({ incomplete: 0 })
    expect(page.items[0]?.cost).toMatchObject({
      runningCosts: { state: 'awaiting_sales' },
      total: '450',
      beforeRunningCosts: true,
      complete: true,
    })
    expect(byId(await steps(designer))).toEqual({
      products: { done: true, missing: [], remaining: null },
      running_costs: { done: true, missing: [], remaining: null },
      owner_time: { done: true, missing: [], remaining: null },
      product_costs: { done: true, missing: [], remaining: 0 },
    })
  })

  it('a service that uses no materials, in a business with Materials on, is complete and does not hold the checklist back (D-200, D-203)', async () => {
    const baker = await CostScope.open(api, BAKER)
    const lesson = await baker.product({
      name: `Baking lesson ${tag()}`,
      type: 'service',
      unit: 'h',
      defaultPrice: '100',
      ownerMinutes: '60',
    })
    await baker.settings({ ownerHourlyRate: '45' })
    // Its materials are optional: said on the page as a hint, never incomplete, not waited for.
    const page = await baker.costList({ search: lesson.name })
    expect(page.counts).toMatchObject({ incomplete: 0 })
    expect(page.items[0]?.cost).toMatchObject({ reasons: ['no_recipe'], complete: true })
    expect(byId(await steps(baker)).product_costs).toEqual({
      done: true,
      missing: [],
      remaining: 0,
    })
  })
})

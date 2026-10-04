import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import {
  auditScreen,
  callApi,
  createBusiness,
  createUser,
  deleteUser,
  nextInvitation,
  RAW_KEY,
  setLanguage,
  settle,
  signIn,
  useLanguage,
  type TestUser,
} from '../helpers'
import { baseURL } from '../stack'

// Smoke over every M2 screen and its key states (ROADMAP.md M2 Step 8 and the M2 definition of done:
// "every new screen works in AR and EN at 375, 768 and 1440 px"). A café with a team, branches and
// VAT (every capability on) holds what each screen shows: materials with packs, products with a
// recipe, a service and an item bought ready to sell, suppliers, purchases (final with a return and
// a credit note, owed to the supplier or to an employee, a draft), expenses (last month's final bill,
// one an employee sent for approval), running costs and product costs; a solo café without VAT holds
// the owner's time and the screens without VAT fields. The states: the materials and products lists,
// a new material, a material's packs, a new product, one bought ready to sell, a recipe; suppliers
// and a new supplier; the purchases list, the editor empty and filled (prices including VAT,
// delivery, a discount, and how it was paid asked for), a material added from its line and a name
// that looks like one already there, a final purchase, its return, credit note and reversal, a
// draft; amounts owed to suppliers and employees, and a payment; the expenses list, the editor with
// "For which month?", an expense waiting for approval and its rejection, a final one, an employee's
// own expenses and editor; running costs and one of them; product costs (with how they are worked
// out and the month's costs), a product's breakdown with and without the owner's time; Settings
// (costing, closing the books, expense approval, the Roles' sensitive switch, a member's own
// permissions, Customize BizCost); the Dashboard's checklist, "+" ("Add new") and the phone's "More".
// Also: the expense categories sheet; the employee's materials, products and a recipe (quantities,
// locked costs); a product whose material was last bought over 90 days ago (its average from that
// purchase, D-115); and a third café with nothing entered, every list empty.
//
// On each, in each language and at each width: <html lang dir> of the language, a visible h1, the
// page not wider than the screen and nothing drawn past its sides (a sheet's content included), no
// untranslated key or placeholder in the text, the title or the accessible names, no NaN or
// undefined, Arabic text in Arabic and none in English. Every problem of a run is reported at once
// (soft checks). With E2E_SHOTS_DIR set, each state leaves a screenshot there
// (`<locale>-<width>-<state>.png`).

test.describe.configure({ mode: 'serial' })

type Who = 'owner' | 'employee'

interface Context {
  page: Page
  width: number
  /** The English or the Arabic of a name, by the run's language. */
  L: (en: string, ar: string) => string
}

interface Screen {
  name: string
  who: Who
  path: () => string
  /** Only at these widths (default: all). */
  widths?: readonly number[]
  /** Opens the state (a sheet, a menu, a form filled in) once the page is ready. */
  open?: (context: Context) => Promise<void>
}

const LOCALES = ['en', 'ar'] as const
const WIDTHS = [
  { width: 375, height: 812 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
] as const

/** A café with a team, a second branch and VAT: every capability that shows a field is on. */
const CAFE_ANSWERS = {
  what_you_do: ['food_drinks'],
  workplace: 'shop',
  branches: true,
  team: 'team',
  team_tracking: ['hours', 'salaries', 'staff_cash'],
  work_setup: ['stock'],
  sales_channels: ['walk_in', 'online'],
  pos: true,
  vat: 'yes',
}

/** A café run by its owner alone, one branch, not VAT-registered (the owner's time counts). */
const SOLO_ANSWERS = {
  what_you_do: ['food_drinks'],
  workplace: 'shop',
  branches: false,
  team: 'alone',
  work_setup: ['stock'],
  sales_channels: ['walk_in'],
  pos: false,
  vat: 'no',
}

const users: TestUser[] = []
const contexts: BrowserContext[] = []
const pages = {} as Record<Who, Page>
const seed = {
  cafeId: '',
  soloId: '',
  emptyId: '',
  karakId: '',
  employeeMemberId: '',
  finalPurchase: '',
  cashPurchase: '',
  draftPurchase: '',
  submittedExpense: '',
  finalExpense: '',
  latteId: '',
  cookieId: '',
}

async function ok<T>(pending: Promise<{ data?: T; appCode?: string }>, what: string): Promise<T> {
  const result = await pending
  expect(result.appCode, what).toBeUndefined()
  return result.data as T
}

async function openAs(browser: Browser, user: TestUser, displayName: string): Promise<Page> {
  const context = await browser.newContext({ baseURL, locale: 'en-US' })
  contexts.push(context)
  await useLanguage(context, 'en')
  const page = await context.newPage()
  await signIn(page, user)
  await ok(callApi(page, 'account.updateProfile', { displayName }), 'updateProfile')
  return page
}

/** `day` moved by `days` (YYYY-MM-DD). */
function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/** The month (YYYY-MM) before `day`'s. */
function monthBefore(day: string): string {
  const [year, month] = day.split('-').map(Number) as [number, number]
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`
}

/**
 * Everything the screens show, entered through the API as the owner (and the employee for their own
 * expense): the screens' own specs enter the same through the screens.
 */
async function seedBusinesses(owner: Page, employee: Page, employeeUser: TestUser) {
  const cafeId = await createBusiness(owner, 'Smoke Café', CAFE_ANSWERS)
  const soloId = await createBusiness(owner, 'Smoke Corner', SOLO_ANSWERS)
  // A café with nothing entered yet: every list empty, and the cost checklist from its start.
  const emptyId = await createBusiness(owner, 'Smoke Kiosk', CAFE_ANSWERS)
  const on = { businessId: cafeId }
  const call = <T = unknown>(path: string, input: unknown, page = owner) =>
    ok(callApi<T>(page, path, input, on), path)
  const query = <T>(path: string, input: unknown = {}, page = owner) =>
    ok(callApi<T>(page, path, input, { ...on, query: true }), path)
  const { today } = await query<{ today: string }>('books.get')

  await call('location.create', { id: randomUUID(), name: 'Marina branch' })
  await call('expense.updateSettings', { approval: true })

  // The employee joins with the Employee template.
  const roles = await query<{ id: string; templateKey: string | null }[]>('role.list')
  await call('invitation.create', {
    id: randomUUID(),
    email: employeeUser.email,
    roleId: roles.find((role) => role.templateKey === 'employee')?.id,
    locale: 'en',
  })
  const { token } = await nextInvitation(employeeUser.email)
  await ok(callApi(employee, 'invitation.accept', { token }), 'invitation.accept')
  const members = await query<{ id: string; email: string | null }[]>('member.list')
  const employeeMemberId = members.find((member) => member.email === employeeUser.email)?.id ?? ''

  // Materials with their packs.
  const milk = randomUUID()
  const bottle = randomUUID()
  const carton = randomUUID()
  await call('material.create', {
    id: milk,
    name: 'Milk',
    unit: 'l',
    packs: [
      { id: bottle, name: 'bottle', qty: '1', ofUnit: 'l' },
      { id: carton, name: 'carton', qty: '12', ofPackId: bottle },
    ],
  })
  const beans = randomUUID()
  const bag = randomUUID()
  await call('material.create', {
    id: beans,
    name: 'Coffee beans',
    unit: 'kg',
    packs: [{ id: bag, name: 'bag', qty: '1', ofUnit: 'kg' }],
  })
  const cup = randomUUID()
  const sleeve = randomUUID()
  await call('material.create', {
    id: cup,
    name: 'Cup',
    unit: 'piece',
    packs: [{ id: sleeve, name: 'sleeve', qty: '50', ofUnit: 'piece' }],
  })
  const supplierId = randomUUID()
  await call('supplier.create', {
    id: supplierId,
    name: 'Al Ain Dairy',
    phone: '+971 4 123 4567',
    trn: '100123456789003',
  })

  // Purchases: final and owed to the supplier (with a return and a credit note), final in cash, paid
  // by the employee from their own money, and a draft.
  async function purchase(input: object, post = true): Promise<string> {
    const id = randomUUID()
    const draft = await call<{ data: { version: number } }>('purchase.create', {
      id,
      businessDate: today,
      documentType: 'tax_invoice',
      ...input,
    })
    if (post) await call('purchase.post', { id, version: draft.data.version })
    return id
  }
  const beansLine = randomUUID()
  const finalPurchase = await purchase({
    supplierId,
    reference: 'INV-2041',
    paymentMethod: 'supplier_credit',
    lines: [
      {
        kind: 'material',
        id: randomUUID(),
        materialId: milk,
        qty: '2',
        packId: carton,
        unitPrice: '72',
        vatRate: '5',
      },
      {
        kind: 'material',
        id: beansLine,
        materialId: beans,
        qty: '3',
        packId: bag,
        unitPrice: '65',
        vatRate: '5',
      },
      {
        kind: 'material',
        id: randomUUID(),
        materialId: cup,
        qty: '2',
        packId: sleeve,
        unitPrice: '12.5',
        vatRate: '5',
      },
    ],
  })
  for (const kind of ['return', 'credit_note'] as const) {
    const id = randomUUID()
    const draft = await call<{ data: { version: number } }>('purchaseReturn.create', {
      id,
      purchaseId: finalPurchase,
      kind,
      businessDate: today,
      ...(kind === 'return'
        ? { lines: [{ id: randomUUID(), purchaseLineId: beansLine, qty: '1' }] }
        : { splitAmount: '10' }),
    })
    await call('purchaseReturn.post', { id, version: draft.data.version })
  }
  const cashPurchase = await purchase({
    documentType: 'no_invoice',
    paymentMethod: 'cash',
    pricesIncludeVat: true,
    lines: [
      {
        kind: 'material',
        id: randomUUID(),
        materialId: milk,
        qty: '10',
        unit: 'l',
        unitPrice: '6.3',
        vatRate: '5',
      },
    ],
  })
  await purchase({
    paymentMethod: 'paid_by_member',
    paidByMemberId: employeeMemberId,
    lines: [
      {
        kind: 'material',
        id: randomUUID(),
        materialId: cup,
        qty: '1',
        packId: sleeve,
        unitPrice: '13',
        vatRate: '5',
      },
    ],
  })
  const draftPurchase = await purchase(
    {
      supplierId,
      paymentMethod: 'cash',
      lines: [
        {
          kind: 'material',
          id: randomUUID(),
          materialId: milk,
          qty: '1',
          packId: carton,
          unitPrice: '72',
          vatRate: '5',
        },
      ],
    },
    false,
  )

  // What the café sells: the latte with its recipe, a service, and water bought ready to sell.
  const latteId = randomUUID()
  await call('product.create', {
    id: latteId,
    name: 'Spanish Latte',
    type: 'product',
    unit: 'piece',
    defaultPrice: '18',
  })
  await call('recipe.save', {
    productId: latteId,
    version: 0,
    lines: [
      { id: randomUUID(), materialId: beans, qty: '18', unit: 'g' },
      { id: randomUUID(), materialId: milk, qty: '200', unit: 'ml' },
      { id: randomUUID(), materialId: cup, qty: '1', unit: 'piece' },
    ],
  })
  // Cardamom, last bought 100 days ago: its average is that purchase's (none in the last 90 days),
  // and the karak tea's cost says so (D-115).
  const cardamom = randomUUID()
  await call('material.create', { id: cardamom, name: 'Cardamom', unit: 'g', packs: [] })
  await purchase({
    businessDate: addDays(today, -100),
    documentType: 'no_invoice',
    paymentMethod: 'cash',
    lines: [
      {
        kind: 'material',
        id: randomUUID(),
        materialId: cardamom,
        qty: '500',
        unit: 'g',
        unitPrice: '0.09',
      },
    ],
  })
  const karakId = randomUUID()
  await call('product.create', {
    id: karakId,
    name: 'Karak tea',
    type: 'product',
    unit: 'piece',
    defaultPrice: '5',
  })
  await call('recipe.save', {
    productId: karakId,
    version: 0,
    lines: [
      { id: randomUUID(), materialId: cardamom, qty: '2', unit: 'g' },
      { id: randomUUID(), materialId: milk, qty: '150', unit: 'ml' },
    ],
  })
  await call('product.create', {
    id: randomUUID(),
    name: 'Latte art class',
    type: 'service',
    unit: 'h',
    defaultPrice: '150',
  })
  await call('product.create', {
    id: randomUUID(),
    name: 'Bottled water',
    type: 'product',
    unit: 'piece',
    defaultPrice: '3',
    resale: {
      materialId: randomUUID(),
      packs: [{ id: randomUUID(), name: 'carton', qty: '24', ofUnit: 'piece' }],
    },
  })

  // Running costs since last month, last month's electricity bill, and an expense the employee sent.
  const categories = new Map(
    (
      await query<{ items: { id: string; name: string }[] }>('costCategory.list', { limit: 100 })
    ).items.map((category) => [category.name, category.id]),
  )
  const lastMonth = monthBefore(today)
  const runningCostIds = new Map<string, string>()
  for (const [name, amount, category] of [
    ['Shop rent', '12000', 'Rent'],
    ['Staff salaries', '8000', 'Salaries'],
    ['Electricity', '3000', 'Electricity'],
  ] as const) {
    const id = randomUUID()
    runningCostIds.set(name, id)
    await call('runningCost.create', {
      id,
      name,
      categoryId: categories.get(category),
      amount,
      frequency: 'monthly',
      startsOn: `${lastMonth}-01`,
    })
  }
  const finalExpense = randomUUID()
  const bill = await call<{ data: { version: number } }>('expense.create', {
    id: finalExpense,
    categoryId: categories.get('Electricity'),
    businessDate: today,
    periodMonth: lastMonth,
    documentType: 'no_invoice',
    paymentMethod: 'cash',
    amount: '3150',
    description: 'DEWA bill',
  })
  // The electricity's own bill (D-216): it takes the place of its regular amount.
  await call('expense.post', {
    id: finalExpense,
    version: bill.data.version,
    pays: { kind: 'running_cost', runningCostId: runningCostIds.get('Electricity') },
  })
  const submittedExpense = randomUUID()
  const sent = await call<{ data: { version: number } }>(
    'expense.create',
    {
      id: submittedExpense,
      categoryId: categories.get('Maintenance'),
      businessDate: today,
      documentType: 'no_invoice',
      paymentMethod: 'cash',
      amount: '75',
      description: 'Grinder blades',
    },
    employee,
  )
  await call('expense.submit', { id: submittedExpense, version: sent.data.version }, employee)

  // The solo café: a cookie from its flour, and the owner's time (AED 60 an hour, 2 minutes).
  const solo = { businessId: soloId }
  const flour = randomUUID()
  await ok(
    callApi(owner, 'material.create', { id: flour, name: 'Flour', unit: 'kg', packs: [] }, solo),
    'flour',
  )
  const flourBuy = randomUUID()
  const flourDraft = await ok(
    callApi<{ data: { version: number } }>(
      owner,
      'purchase.create',
      {
        id: flourBuy,
        businessDate: today,
        documentType: 'no_invoice',
        paymentMethod: 'cash',
        lines: [
          {
            kind: 'material',
            id: randomUUID(),
            materialId: flour,
            qty: '10',
            unit: 'kg',
            unitPrice: '4.5',
          },
        ],
      },
      solo,
    ),
    'solo purchase',
  )
  await ok(
    callApi(owner, 'purchase.post', { id: flourBuy, version: flourDraft.data.version }, solo),
    'post',
  )
  const cookieId = randomUUID()
  await ok(
    callApi(
      owner,
      'product.create',
      {
        id: cookieId,
        name: 'Cookie',
        type: 'product',
        unit: 'piece',
        defaultPrice: '5',
        ownerMinutes: '2',
      },
      solo,
    ),
    'cookie',
  )
  await ok(
    callApi(
      owner,
      'recipe.save',
      {
        productId: cookieId,
        version: 0,
        lines: [{ id: randomUUID(), materialId: flour, qty: '100', unit: 'g' }],
      },
      solo,
    ),
    'cookie recipe',
  )
  await ok(callApi(owner, 'productCost.updateSettings', { ownerHourlyRate: '60' }, solo), 'rate')

  Object.assign(seed, {
    cafeId,
    soloId,
    emptyId,
    karakId,
    employeeMemberId,
    finalPurchase,
    cashPurchase,
    draftPurchase,
    submittedExpense,
    finalExpense,
    latteId,
    cookieId,
  })
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000)
  const ownerUser = await createUser('m2smoke-owner')
  const employeeUser = await createUser('m2smoke-employee')
  users.push(ownerUser, employeeUser)
  pages.owner = await openAs(browser, ownerUser, 'Layla Haddad')
  pages.employee = await openAs(browser, employeeUser, 'Omar Saleh')
  await seedBusinesses(pages.owner, pages.employee, employeeUser)
})

test.afterAll(async () => {
  for (const context of contexts) await context.close()
  for (const user of users) await deleteUser(user.id)
})

const cafe = (path = '') => `/b/${seed.cafeId}${path}`
const solo = (path = '') => `/b/${seed.soloId}${path}`
const empty = (path = '') => `/b/${seed.emptyId}${path}`

const mainNav = ({ page, L }: Context) =>
  page.getByRole('navigation', { name: L('Main', 'القائمة الرئيسية') })

/** The open dialog (a sheet, a side panel or a confirmation). */
const dialog = (page: Page) => page.getByRole('dialog').or(page.getByRole('alertdialog'))

/** Picks a purchase line's material: typed in its box, then picked from the list. */
async function typeMaterial({ page, L }: Context, name: string) {
  const line = page.getByRole('group', { name: L('Item 1', 'الصنف 1') })
  await line
    .getByRole('combobox', { name: L('Ingredient or supply', 'المكوّن أو المستلزم') })
    .fill(name)
  return line
}

const SCREENS: Screen[] = [
  // The Dashboard and the shell.
  { name: 'dashboard', who: 'owner', path: () => cafe() },
  {
    name: 'add-new',
    who: 'owner',
    path: () => cafe(),
    open: async (context) => {
      await mainNav(context)
        .getByRole('button', { name: context.L('Add new', 'إضافة جديد') })
        .click()
      await expect(context.page.getByRole('menuitem')).toHaveCount(3)
    },
  },
  {
    name: 'more',
    who: 'owner',
    widths: [375],
    path: () => cafe(),
    open: async (context) => {
      await mainNav(context)
        .getByRole('button', { name: context.L('More', 'المزيد') })
        .click()
      await expect(context.page.getByRole('menuitem').first()).toBeVisible()
    },
  },
  { name: 'employee-dashboard', who: 'employee', path: () => cafe() },
  { name: 'solo-dashboard', who: 'owner', path: () => solo() },

  // Materials and Products & Services.
  { name: 'materials', who: 'owner', path: () => cafe('/materials') },
  {
    name: 'material-new',
    who: 'owner',
    path: () => cafe('/materials'),
    open: async ({ page, L }) => {
      await page
        .getByRole('button', { name: L('Add ingredient or supply', 'أضف مكوّنًا أو مستلزمًا') })
        .first()
        .click()
      await dialog(page)
        .getByRole('button', { name: L('Add a pack', 'أضف عبوة') })
        .click()
    },
  },
  {
    name: 'material-packs',
    who: 'owner',
    path: () => cafe('/materials'),
    open: async ({ page }) => {
      await page.getByRole('main').getByText('Milk', { exact: true }).click()
      await expect(page.getByRole('dialog', { name: 'Milk' })).toBeVisible()
    },
  },
  { name: 'products', who: 'owner', path: () => cafe('/products') },
  {
    name: 'product-new',
    who: 'owner',
    path: () => cafe('/products/new'),
    open: async ({ page }) => {
      await expect(dialog(page)).toBeVisible()
    },
  },
  {
    name: 'product-ready-to-sell',
    who: 'owner',
    path: () => cafe('/products/new'),
    open: async ({ page, L }) => {
      await dialog(page)
        .getByRole('switch', { name: L('Bought ready to sell', 'تشتريه جاهزًا لتبيعه') })
        .click()
      await expect(
        dialog(page).getByText(L('Packs you buy it in', 'العبوات التي تشتريه بها')),
      ).toBeVisible()
    },
  },
  {
    name: 'recipe',
    who: 'owner',
    path: () => cafe('/products'),
    open: async ({ page, L }) => {
      await page
        .getByRole('main')
        .locator('li')
        .filter({ hasText: 'Spanish Latte' })
        .getByRole('button', { name: L('Recipe', 'الوصفة'), exact: true })
        .click()
      await expect(dialog(page).locator('[data-recipe-line]')).toHaveCount(3)
    },
  },
  // What an employee sees of them: quantities, never a cost (a lock instead).
  { name: 'employee-materials', who: 'employee', path: () => cafe('/materials') },
  { name: 'employee-products', who: 'employee', path: () => cafe('/products') },
  {
    name: 'employee-recipe',
    who: 'employee',
    path: () => cafe('/products'),
    open: async ({ page, L }) => {
      await page
        .getByRole('main')
        .locator('li')
        .filter({ hasText: 'Spanish Latte' })
        .getByRole('button', { name: L('Recipe', 'الوصفة'), exact: true })
        .click()
      await expect(dialog(page).locator('[data-recipe-line]')).toHaveCount(3)
      await expect(dialog(page).locator('[data-locked="cost"]').first()).toBeVisible()
    },
  },

  // Suppliers and Purchases.
  { name: 'suppliers', who: 'owner', path: () => cafe('/suppliers') },
  {
    name: 'supplier-new',
    who: 'owner',
    path: () => cafe('/suppliers'),
    open: async ({ page, L }) => {
      await page
        .getByRole('button', { name: L('Add supplier', 'أضف موردًا') })
        .first()
        .click()
      await expect(dialog(page)).toBeVisible()
    },
  },
  { name: 'purchases', who: 'owner', path: () => cafe('/purchases') },
  { name: 'purchase-editor', who: 'owner', path: () => cafe('/purchases/new') },
  {
    name: 'purchase-editor-filled',
    who: 'owner',
    path: () => cafe('/purchases/new'),
    open: async (context) => {
      const { page, L } = context
      await page
        .getByRole('combobox', { name: L('Supplier', 'المورد') })
        .selectOption({ label: 'Al Ain Dairy' })
      await page
        .getByRole('group', { name: L('VAT in the prices', 'الضريبة في الأسعار') })
        .getByText(L('Prices including VAT', 'الأسعار شاملة الضريبة'))
        .click()
      const line = await typeMaterial(context, 'Milk')
      await line.getByRole('option', { name: 'Milk', exact: true }).click()
      await line.getByRole('textbox', { name: L('Quantity', 'الكمية') }).fill('2')
      await line.getByRole('textbox', { name: /^(Price per|السعر لكل) / }).fill('75.6')
      await page
        .getByRole('button', {
          name: L('Add delivery on this invoice', 'أضف توصيلًا على هذه الفاتورة'),
        })
        .click()
      await page
        .getByRole('textbox', { name: L('Delivery amount incl. VAT', 'مبلغ التوصيل شامل الضريبة') })
        .fill('10.5')
      await page
        .getByRole('button', {
          name: L('Add a discount on the whole purchase', 'أضف خصمًا على المشتريات كلها'),
        })
        .click()
      await page
        .getByRole('textbox', {
          name: L('Discount on the whole purchase', 'خصم على المشتريات كلها'),
        })
        .fill('5')
      // How it was paid is required: saving without it says so.
      await page.getByRole('button', { name: L('Save draft', 'احفظ كمسودة') }).click()
      await expect(page.getByText(L('Choose how it was paid.', 'اختر طريقة الدفع.'))).toBeVisible()
    },
  },
  {
    name: 'purchase-quick-add',
    who: 'owner',
    path: () => cafe('/purchases/new'),
    open: async (context) => {
      const line = await typeMaterial(context, 'Oat drink')
      await line.locator('[data-add-option]').click()
      await expect(dialog(context.page)).toBeVisible()
    },
  },
  {
    name: 'purchase-similar-name',
    who: 'owner',
    path: () => cafe('/purchases/new'),
    open: async (context) => {
      const line = await typeMaterial(context, 'Fresh milk')
      await line.locator('[data-add-option]').click()
      await expect(dialog(context.page).locator('[data-similar]')).toBeVisible()
    },
  },
  { name: 'purchase', who: 'owner', path: () => cafe(`/purchases/${seed.finalPurchase}`) },
  {
    name: 'purchase-return',
    who: 'owner',
    path: () => cafe(`/purchases/${seed.finalPurchase}`),
    open: async ({ page, L }) => {
      await page.getByRole('button', { name: L('Return goods', 'إرجاع بضاعة') }).click()
      await expect(dialog(page)).toBeVisible()
    },
  },
  {
    name: 'purchase-credit-note',
    who: 'owner',
    path: () => cafe(`/purchases/${seed.finalPurchase}`),
    open: async ({ page, L }) => {
      await page.getByRole('button', { name: L('Credit note', 'إشعار تخفيض'), exact: true }).click()
      await expect(dialog(page)).toBeVisible()
    },
  },
  {
    name: 'purchase-reverse',
    who: 'owner',
    path: () => cafe(`/purchases/${seed.cashPurchase}`),
    open: async ({ page, L }) => {
      await page.getByRole('button', { name: L('Reverse', 'إبطال'), exact: true }).click()
      await expect(page.getByRole('alertdialog')).toBeVisible()
    },
  },
  { name: 'purchase-draft', who: 'owner', path: () => cafe(`/purchases/${seed.draftPurchase}`) },

  // Amounts owed.
  { name: 'payables-suppliers', who: 'owner', path: () => cafe('/payables') },
  { name: 'payables-employees', who: 'owner', path: () => cafe('/payables?to=employees') },
  {
    name: 'payment',
    who: 'owner',
    path: () => cafe('/payables'),
    open: async ({ page, L }) => {
      await page
        .getByRole('button', { name: L('Record a payment', 'سجّل دفعة') })
        .first()
        .click()
      await expect(dialog(page)).toBeVisible()
    },
  },
  { name: 'employee-owed-to-me', who: 'employee', path: () => cafe('/payables') },

  // Expenses and Running Costs.
  { name: 'expenses', who: 'owner', path: () => cafe('/expenses') },
  { name: 'expense-editor', who: 'owner', path: () => cafe('/expenses/new') },
  {
    name: 'expense-to-approve',
    who: 'owner',
    path: () => cafe(`/expenses/${seed.submittedExpense}`),
  },
  {
    name: 'expense-reject',
    who: 'owner',
    path: () => cafe(`/expenses/${seed.submittedExpense}`),
    open: async ({ page, L }) => {
      await page.getByRole('button', { name: L('Reject', 'ارفض'), exact: true }).click()
      await expect(page.getByRole('alertdialog')).toBeVisible()
    },
  },
  { name: 'expense-final', who: 'owner', path: () => cafe(`/expenses/${seed.finalExpense}`) },
  {
    name: 'categories',
    who: 'owner',
    path: () => cafe('/expenses'),
    open: async ({ page, L }) => {
      await page.getByRole('button', { name: L('Categories', 'الفئات'), exact: true }).click()
      await expect(page.getByRole('dialog', { name: L('Categories', 'الفئات') })).toBeVisible()
    },
  },
  { name: 'my-expenses', who: 'employee', path: () => cafe('/expenses') },
  { name: 'employee-expense-editor', who: 'employee', path: () => cafe('/expenses/new') },
  { name: 'running-costs', who: 'owner', path: () => cafe('/running-costs') },
  {
    name: 'running-cost',
    who: 'owner',
    path: () => cafe('/running-costs'),
    open: async ({ page }) => {
      await page.locator('[data-running-cost="Shop rent"]').first().click()
      await expect(dialog(page)).toBeVisible()
    },
  },

  // Product costs.
  {
    name: 'product-costs',
    who: 'owner',
    path: () => cafe('/product-costs'),
    open: async ({ page, L }) => {
      // On a phone, how costs are worked out folds to one line: opened, with the month's costs.
      const how = page.getByRole('button', { name: L('How?', 'كيف؟') })
      if (await how.isVisible()) await how.click()
      await expect(page.locator('[data-month-costs]')).toBeVisible()
    },
  },
  { name: 'product-cost', who: 'owner', path: () => cafe(`/product-costs/${seed.latteId}`) },
  {
    name: 'product-cost-last-purchase',
    who: 'owner',
    path: () => cafe(`/product-costs/${seed.karakId}`),
    open: async ({ page, L }) => {
      // The line's average says it is the last purchase's (the table at 1440 px, the list below).
      await expect(
        page
          .locator('[data-material-line="Cardamom"]:visible')
          .getByText(L('last purchase', 'آخر شراء'), { exact: true }),
      ).toBeVisible()
    },
  },
  { name: 'solo-product-cost', who: 'owner', path: () => solo(`/product-costs/${seed.cookieId}`) },

  // Settings.
  { name: 'settings', who: 'owner', path: () => cafe('/settings') },
  { name: 'settings-costing', who: 'owner', path: () => cafe('/settings/costing') },
  { name: 'solo-settings-costing', who: 'owner', path: () => solo('/settings/costing') },
  { name: 'settings-books', who: 'owner', path: () => cafe('/settings/books') },
  { name: 'settings-approval', who: 'owner', path: () => cafe('/settings/approval') },
  {
    name: 'settings-roles-sensitive',
    who: 'owner',
    path: () => cafe('/settings/roles'),
    open: async ({ page, L }) => {
      const role = page.locator('[data-role="employee"]')
      await role.getByRole('button', { name: L('Edit permissions', 'تعديل الصلاحيات') }).click()
      await role.locator('[data-sensitive-section]').scrollIntoViewIfNeeded()
    },
  },
  {
    name: 'settings-member-access',
    who: 'owner',
    path: () => cafe(`/settings/members/${seed.employeeMemberId}`),
  },
  { name: 'settings-customize', who: 'owner', path: () => cafe('/settings/modules') },

  // Where a capability is off: no VAT, no branch, no approval.
  { name: 'solo-purchase-editor', who: 'owner', path: () => solo('/purchases/new') },
  { name: 'solo-expense-editor', who: 'owner', path: () => solo('/expenses/new') },

  // Nothing entered yet: each list empty, and what to do first.
  { name: 'solo-suppliers-empty', who: 'owner', path: () => solo('/suppliers') },
  { name: 'empty-dashboard', who: 'owner', path: () => empty() },
  { name: 'empty-materials', who: 'owner', path: () => empty('/materials') },
  { name: 'empty-products', who: 'owner', path: () => empty('/products') },
  { name: 'empty-suppliers', who: 'owner', path: () => empty('/suppliers') },
  { name: 'empty-purchases', who: 'owner', path: () => empty('/purchases') },
  { name: 'empty-payables', who: 'owner', path: () => empty('/payables') },
  { name: 'empty-payables-employees', who: 'owner', path: () => empty('/payables?to=employees') },
  { name: 'empty-expenses', who: 'owner', path: () => empty('/expenses') },
  { name: 'empty-running-costs', who: 'owner', path: () => empty('/running-costs') },
  { name: 'empty-product-costs', who: 'owner', path: () => empty('/product-costs') },
]

/**
 * Screenshots into E2E_SHOTS_DIR (only when it is set): the whole page, with the phone's tab bar at
 * its end and without toasts; with a dialog or menu open, the screen as it is.
 */
async function shot(page: Page, name: string) {
  const dir = process.env.E2E_SHOTS_DIR
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  const open = await page
    .getByRole('dialog')
    .or(page.getByRole('alertdialog'))
    .or(page.getByRole('menu'))
    .count()
  // From the top: the shell's sticky bars stay at the top of the image.
  if (open === 0) await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({
    path: join(dir, `${name}.png`),
    fullPage: open === 0,
    style:
      open === 0
        ? 'nav.fixed.bottom-0 { position: static !important } [data-sonner-toaster] { display: none !important }'
        : '[data-sonner-toaster] { display: none !important }',
  })
}

for (const locale of LOCALES) {
  test.describe(locale === 'ar' ? 'Arabic (RTL)' : 'English (LTR)', () => {
    test.beforeAll(async () => {
      for (const page of Object.values(pages)) await setLanguage(page, locale)
    })

    for (const size of WIDTHS) {
      test(`every M2 screen at ${size.width} px`, async () => {
        test.setTimeout(600_000)
        for (const page of Object.values(pages)) await page.setViewportSize(size)
        const L = (en: string, ar: string) => (locale === 'ar' ? ar : en)
        for (const screen of SCREENS) {
          if (screen.widths && !screen.widths.includes(size.width)) continue
          await test.step(screen.name, async () => {
            const page = pages[screen.who]
            const path = screen.path()
            await page.goto(path)
            const what = `${screen.name} (${locale}, ${size.width} px)`
            await expect
              .soft(page.locator('h1:visible').first(), `${what}: a visible h1`)
              .toBeVisible()
            await settle(page)
            await screen.open?.({ page, width: size.width, L })
            await settle(page)
            // The screen itself, not a redirect or "Page not found".
            expect
              .soft(new URL(page.url()).pathname, `${what}: stayed on the screen`)
              .toBe(path.split('?')[0])
            const seen = await auditScreen(page)
            expect.soft(seen.lang, `${what}: lang`).toBe(locale)
            expect.soft(seen.dir, `${what}: dir`).toBe(locale === 'ar' ? 'rtl' : 'ltr')
            expect.soft(seen.sideways, `${what}: wider than the screen`).toBeLessThanOrEqual(0)
            expect.soft(seen.outside, `${what}: drawn past the screen's sides`).toEqual([])
            const text = seen.text.replace(/\S+@\S+/g, '')
            const names = seen.attributes.replace(/\S+@\S+/g, '')
            expect.soft(RAW_KEY.exec(text)?.[0], `${what}: an untranslated key`).toBeUndefined()
            expect
              .soft(RAW_KEY.exec(names)?.[0], `${what}: an untranslated key in a name`)
              .toBeUndefined()
            expect.soft(`${text}\n${names}`, `${what}: a placeholder`).not.toMatch(/\{\{|\}\}/)
            expect
              .soft(text, `${what}: a broken value`)
              .not.toMatch(/\bNaN\b|\bundefined\b|\[object Object\]/)
            if (locale === 'ar') {
              expect.soft(/[؀-ۿ]/.test(text), `${what}: Arabic text`).toBe(true)
            } else {
              const arabic = text.replaceAll('العربية', '').match(/[؀-ۿ]+/g)
              expect.soft(arabic, `${what}: Arabic in the English page`).toBeNull()
            }
            await shot(page, `${locale}-${size.width}-${screen.name}`)
          })
        }
      })
    }
  })
}

import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import {
  BAKER_ANSWERS,
  callApi,
  createBusiness,
  createUser,
  deleteUser,
  nextInvitation,
  RAW_KEY,
  setLanguage,
  signIn,
  useLanguage,
  withValue,
  WORKSHOP_ANSWERS,
  type TestUser,
} from '../helpers'
import { baseURL } from '../stack'

// Release A (ROADMAP.md M3 Step 6): Sales, Orders, Customers, Payments and Reports released, on the
// production build without the dev-only preview:
//   - the shell per role: the sidebar's "Sales" and "Reports" groups, "Add new" with Today's sales,
//     a new sale, a new order and a new customer (each only for who may enter it), and the phone's
//     Home | Sales | + | Costs | More (Orders in the Sales place for a business with Orders on,
//     Products under "More"); an employee keeps Expenses, an accountant gets four tabs and no "+",
//     and a salesperson Home | Orders | + | Products | More;
//   - Customize BizCost without "Soon" for the released modules (the planned ones keep it);
//   - "Let's calculate your first real profit" for an empty café, from nothing to "Your real profit is
//     ready" and Real profit itself.
// Arabic and English, phone and desktop. With E2E_SHOTS_DIR set, each step leaves a screenshot there.

test.describe.configure({ mode: 'serial' })

const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1440, height: 900 }

/** A café with a POS and a team, VAT-registered (food wording): Sales and Reports, no Orders. */
const CAFE_ANSWERS = {
  what_you_do: ['food_drinks'],
  workplace: 'shop',
  branches: false,
  team: 'team',
  team_tracking: ['hours', 'salaries', 'staff_cash'],
  work_setup: ['stock'],
  sales_channels: ['walk_in', 'online'],
  pos: true,
  vat: 'yes',
}

/** A café run by its owner alone, not VAT-registered (the owner's time counts, D-119). */
const SOLO_CAFE_ANSWERS = {
  what_you_do: ['food_drinks'],
  workplace: 'shop',
  branches: false,
  team: 'alone',
  work_setup: ['stock'],
  sales_channels: ['walk_in'],
  pos: true,
  vat: 'no',
}

const users: TestUser[] = []
const contexts: BrowserContext[] = []

let owner: Page
let employee: Page
let accountant: Page
let seller: Page
let cafeId: string
let workshopId: string
let bakerId: string
let soloId: string

async function openAs(browser: Browser, user: TestUser, displayName: string): Promise<Page> {
  const context = await browser.newContext({ baseURL, locale: 'en-US', viewport: DESKTOP })
  contexts.push(context)
  await useLanguage(context, 'en')
  const page = await context.newPage()
  await signIn(page, user)
  expect((await callApi(page, 'account.updateProfile', { displayName })).appCode).toBeUndefined()
  return page
}

async function ok<T>(pending: Promise<{ data?: T; appCode?: string }>, what: string): Promise<T> {
  const result = await pending
  expect(result.appCode, what).toBeUndefined()
  return result.data as T
}

async function joinTeam(businessId: string, member: Page, user: TestUser, templateKey: string) {
  const roles = await ok(
    callApi<{ id: string; templateKey: string | null }[]>(
      owner,
      'role.list',
      {},
      { businessId, query: true },
    ),
    'role.list',
  )
  const role = roles.find((r) => r.templateKey === templateKey)
  expect(role).toBeDefined()
  await ok(
    callApi(
      owner,
      'invitation.create',
      { id: randomUUID(), email: user.email, roleId: role!.id, locale: 'en' },
      { businessId },
    ),
    'invitation.create',
  )
  const { token } = await nextInvitation(user.email)
  await ok(callApi(member, 'invitation.accept', { token }), 'invitation.accept')
}

test.beforeAll(async ({ browser }) => {
  const ownerUser = await createUser('release-a-owner', { locale: 'en' })
  const employeeUser = await createUser('release-a-employee', { locale: 'en' })
  const accountantUser = await createUser('release-a-accountant', { locale: 'en' })
  const sellerUser = await createUser('release-a-seller', { locale: 'en' })
  users.push(ownerUser, employeeUser, accountantUser, sellerUser)
  owner = await openAs(browser, ownerUser, 'Layla Haddad')
  employee = await openAs(browser, employeeUser, 'Omar Saleh')
  accountant = await openAs(browser, accountantUser, 'Huda Nasser')
  seller = await openAs(browser, sellerUser, 'Rami Aziz')
  cafeId = await createBusiness(owner, 'Qahwa House', CAFE_ANSWERS)
  bakerId = await createBusiness(owner, 'Sweet Crumbs', BAKER_ANSWERS)
  soloId = await createBusiness(owner, 'Maha Coffee Corner', SOLO_CAFE_ANSWERS)
  workshopId = await createBusiness(owner, 'Cedar Joinery', WORKSHOP_ANSWERS)
  await joinTeam(cafeId, employee, employeeUser, 'employee')
  await joinTeam(cafeId, accountant, accountantUser, 'accountant')
  await joinTeam(workshopId, seller, sellerUser, 'sales')
})

test.afterAll(async () => {
  for (const context of contexts) await context.close()
  for (const user of users) await deleteUser(user.id)
})

/** A screenshot into E2E_SHOTS_DIR (only when it is set). */
async function shot(page: Page, name: string) {
  const dir = process.env.E2E_SHOTS_DIR
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(dir, `release-a-${name}.png`) })
}

/** The page is in `locale`, has no sideways scroll and shows no untranslated key. */
async function expectSound(page: Page, locale: 'en' | 'ar') {
  await expect(page.locator('html')).toHaveAttribute('lang', locale)
  await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr')
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
  expect(await page.locator('body').innerText()).not.toMatch(RAW_KEY)
}

const mainNav = (page: Page, name = 'Main') => page.getByRole('navigation', { name })
/** A class list holding `sr-only`: a group title kept for screen readers only (D-282). */
const SR_ONLY = /(^|\s)sr-only(\s|$)/

// ---------------------------------------------------------------------------------------------------
// The shell per role (D-189, Q14)
// ---------------------------------------------------------------------------------------------------

test('the café owner: Sales and Real profit in their groups, "Add new" with sales, Home | Sales | + | Costs | More', async () => {
  await owner.setViewportSize(DESKTOP)
  await owner.goto(`/b/${cafeId}`)
  const nav = mainNav(owner)
  await expect(nav.getByRole('link')).toHaveText([
    'Dashboard',
    'Products & Services',
    'Ingredients & supplies',
    'Suppliers',
    'Purchases',
    'Amounts owed',
    'Expenses',
    'Running Costs',
    'Product costs',
    'Sales',
    'Real profit',
    'Settings',
  ])
  // The groups have their titles: each list is named after it.
  await expect(nav.getByRole('list', { name: 'Sales' }).getByRole('link')).toHaveText(['Sales'])
  await expect(nav.getByRole('list', { name: 'Reports' }).getByRole('link')).toHaveText([
    'Real profit',
  ])
  // "Sales" alone under "Sales": the title is kept for screen readers only (D-282); Reports' shows.
  await expect(nav.locator('[data-nav-group="sales"] > p')).toHaveClass(SR_ONLY)
  await expect(nav.locator('[data-nav-group="reports"] > p')).not.toHaveClass(SR_ONLY)
  await nav.getByRole('button', { name: 'Add new' }).click()
  await expect(owner.getByRole('menuitem')).toHaveText([
    'New product or service',
    'New purchase',
    'New expense',
    "Today's sales",
    'New sale',
  ])
  await expectSound(owner, 'en')
  await shot(owner, 'en-1440-cafe-add-new')
  await owner.getByRole('menuitem', { name: "Today's sales" }).click()
  await expect(owner).toHaveURL(`/b/${cafeId}/sales/today`)
  await expect(nav.getByRole('link', { name: 'Sales', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  )

  // On a tablet's rail: a line between the groups, their titles kept for screen readers.
  await owner.setViewportSize({ width: 768, height: 1024 })
  await owner.goto(`/b/${cafeId}`)
  await expect(nav.getByRole('list', { name: 'Reports' })).toBeVisible()
  await nav.getByRole('button', { name: 'Add new' }).click()
  await expect(owner.getByRole('menuitem')).toHaveCount(5)
  await expectSound(owner, 'en')
  await shot(owner, 'en-768-cafe-rail')
  await owner.keyboard.press('Escape')

  // On a phone, in Arabic: Home | Sales | + | Costs | More; Products goes under "More".
  await setLanguage(owner, 'ar')
  await owner.setViewportSize(PHONE)
  await owner.goto(`/b/${cafeId}`)
  const bar = mainNav(owner, 'القائمة الرئيسية')
  await expect(bar.getByRole('listitem')).toHaveCount(5)
  await expect(bar.getByRole('link')).toHaveText(['الرئيسية', 'المبيعات', 'التكاليف'])
  await expect(bar.getByRole('listitem').nth(2).getByRole('button')).toHaveAccessibleName(
    'إضافة جديد',
  )
  await expectSound(owner, 'ar')
  await shot(owner, 'ar-390-cafe-tabs')
  await bar.getByRole('button', { name: 'إضافة جديد' }).click()
  await expect(owner.getByRole('menuitem')).toHaveText([
    'منتج أو خدمة جديدة',
    'مشتريات جديدة',
    'مصروف جديد',
    'مبيعات اليوم',
    'عملية بيع جديدة',
  ])
  await shot(owner, 'ar-390-cafe-add-new')
  await owner.keyboard.press('Escape')
  await bar.getByRole('button', { name: 'المزيد' }).click()
  await expect(owner.getByRole('menuitem')).toHaveText([
    'المنتجات والخدمات',
    'المكونات والمستلزمات',
    'الموردون',
    'المشتريات',
    'المستحقات',
    'المصروفات',
    'المصاريف التشغيلية',
    'الربح الحقيقي',
    'الإعدادات',
  ])
  await shot(owner, 'ar-390-cafe-more')
  await owner.getByRole('menuitem', { name: 'الربح الحقيقي' }).click()
  await expect(owner).toHaveURL(new RegExp(`/b/${cafeId}/reports/profit`))
  await expect(owner.getByRole('heading', { level: 1, name: 'الربح الحقيقي' })).toBeVisible()
  await bar.getByRole('link', { name: 'المبيعات' }).click()
  await expect(owner).toHaveURL(`/b/${cafeId}/sales`)
  await expect(bar.getByRole('link', { name: 'المبيعات' })).toHaveAttribute('aria-current', 'page')
  await setLanguage(owner, 'en')
  await owner.setViewportSize(DESKTOP)
})

test('the baker owner: the whole "Sales" group, "New order" and "New customer", and Orders in the Sales place', async () => {
  await owner.setViewportSize(DESKTOP)
  await owner.goto(`/b/${bakerId}`)
  const nav = mainNav(owner)
  // A group of four shows its title (D-282).
  await expect(nav.locator('[data-nav-group="sales"] > p')).not.toHaveClass(SR_ONLY)
  await expect(nav.getByRole('list', { name: 'Sales' }).getByRole('link')).toHaveText([
    'Sales',
    'Orders',
    'Customers',
    'What customers owe',
  ])
  await expect(nav.getByRole('list', { name: 'Reports' }).getByRole('link')).toHaveText([
    'Real profit',
  ])
  await nav.getByRole('button', { name: 'Add new' }).click()
  await expect(owner.getByRole('menuitem')).toHaveText([
    'New product or service',
    'New purchase',
    'New expense',
    "Today's sales",
    'New sale',
    'New order',
    'New customer',
  ])
  await expectSound(owner, 'en')
  await shot(owner, 'en-1440-baker-add-new')
  // "New customer" opens Customers with a new customer's form; closing it leaves the list.
  await owner.getByRole('menuitem', { name: 'New customer' }).click()
  await expect(owner).toHaveURL(`/b/${bakerId}/customers/new`)
  await expect(owner).toHaveTitle(/New customer/)
  const sheet = owner.getByRole('dialog', { name: 'New customer' })
  await expect(sheet).toBeVisible()
  await sheet.getByRole('textbox', { name: 'Name' }).fill('Fatima Ali')
  await sheet.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(sheet).toHaveCount(0)
  await expect(owner).toHaveURL(`/b/${bakerId}/customers`)
  await expect(owner.locator('[data-customer-row]')).toContainText(['Fatima Ali'])
  await expect(nav.getByRole('link', { name: 'Customers', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  )
  await nav.getByRole('button', { name: 'Add new' }).click()
  await owner.getByRole('menuitem', { name: 'New order' }).click()
  await expect(owner).toHaveURL(`/b/${bakerId}/orders/new`)

  // On a phone: Orders takes the Sales place (Q14); Sales stays under "More".
  await owner.setViewportSize(PHONE)
  await owner.goto(`/b/${bakerId}`)
  const bar = mainNav(owner)
  await expect(bar.getByRole('link')).toHaveText(['Dashboard', 'Orders', 'Costs'])
  await bar.getByRole('button', { name: 'More' }).click()
  await expect(owner.getByRole('menuitem')).toHaveText([
    'Products & Services',
    'Ingredients & supplies',
    'Suppliers',
    'Purchases',
    'Amounts owed',
    'Expenses',
    'Running Costs',
    'Sales',
    'Customers',
    'What customers owe',
    'Real profit',
    'Settings',
  ])
  await expectSound(owner, 'en')
  await shot(owner, 'en-390-baker-more')
  await owner.keyboard.press('Escape')
  await owner.setViewportSize(DESKTOP)
})

test('an employee: Home | Sales | + | Expenses, "+" for what they enter, no Reports', async () => {
  await employee.setViewportSize(PHONE)
  await employee.goto(`/b/${cafeId}`)
  const bar = mainNav(employee)
  await expect(bar.getByRole('link')).toHaveText(['Dashboard', 'Sales', 'Expenses'])
  await bar.getByRole('button', { name: 'Add new' }).click()
  await expect(employee.getByRole('menuitem')).toHaveText([
    'New expense',
    "Today's sales",
    'New sale',
  ])
  await expectSound(employee, 'en')
  await shot(employee, 'en-390-employee-add-new')
  await employee.getByRole('menuitem', { name: "Today's sales" }).click()
  await expect(employee).toHaveURL(`/b/${cafeId}/sales/today`)
  await bar.getByRole('button', { name: 'More' }).click()
  await expect(employee.getByRole('menuitem')).toHaveText([
    'Products & Services',
    'Ingredients & supplies',
    'Settings',
  ])
  await employee.keyboard.press('Escape')

  // A desktop: Sales in its group; no Real profit (no profit without the costs switch, Q11).
  await employee.setViewportSize(DESKTOP)
  await employee.goto(`/b/${cafeId}`)
  const nav = mainNav(employee)
  await expect(nav.getByRole('link')).toHaveText([
    'Dashboard',
    'Products & Services',
    'Ingredients & supplies',
    'Expenses',
    'Sales',
    'Settings',
  ])
  await expect(nav.getByRole('list', { name: 'Reports' })).toHaveCount(0)
  await employee.goto(`/b/${cafeId}/reports/profit`)
  await expect(employee.getByRole('heading', { name: "This page isn't open to you" })).toBeVisible()
})

test('an accountant: four tabs and no "+" (they enter nothing), in Arabic', async () => {
  await setLanguage(accountant, 'ar')
  await accountant.setViewportSize(PHONE)
  await accountant.goto(`/b/${cafeId}`)
  const bar = mainNav(accountant, 'القائمة الرئيسية')
  await expect(bar.getByRole('link')).toHaveText(['الرئيسية', 'المبيعات', 'التكاليف', 'المصروفات'])
  await expect(bar.getByRole('button', { name: 'إضافة جديد' })).toHaveCount(0)
  await expectSound(accountant, 'ar')
  await shot(accountant, 'ar-390-accountant-tabs')
  await accountant.setViewportSize(DESKTOP)
  await accountant.goto(`/b/${cafeId}`)
  const nav = mainNav(accountant, 'القائمة الرئيسية')
  await expect(nav.getByRole('button', { name: 'إضافة جديد' })).toHaveCount(0)
  await expect(nav.getByRole('list', { name: 'المبيعات' }).getByRole('link')).toHaveText([
    'المبيعات',
  ])
  await expect(nav.getByRole('list', { name: 'التقارير' }).getByRole('link')).toHaveText([
    'الربح الحقيقي',
  ])
  await expectSound(accountant, 'ar')
  await shot(accountant, 'ar-1440-accountant-sidebar')
  await setLanguage(accountant, 'en')
})

test('a salesperson of an orders business: Home | Orders | + | Products | More, "+" with orders, customers, quotations and invoices', async () => {
  // On a phone, in Arabic: Orders in the Sales place, Products after it (D-276).
  await setLanguage(seller, 'ar')
  await seller.setViewportSize(PHONE)
  await seller.goto(`/b/${workshopId}`)
  const bar = mainNav(seller, 'القائمة الرئيسية')
  await expect(bar.getByRole('listitem')).toHaveCount(5)
  await expect(bar.getByRole('link')).toHaveText(['الرئيسية', 'الطلبات', 'المنتجات'])
  await expect(bar.getByRole('listitem').nth(2).getByRole('button')).toHaveAccessibleName(
    'إضافة جديد',
  )
  await bar.getByRole('button', { name: 'إضافة جديد' }).click()
  // Release B (M3 Step 9): the workshop quotes and invoices too.
  await expect(seller.getByRole('menuitem')).toHaveText([
    'مبيعات اليوم',
    'عملية بيع جديدة',
    'طلب جديد',
    'عميل جديد',
    'عرض سعر جديد',
    'فاتورة جديدة',
  ])
  await expectSound(seller, 'ar')
  await shot(seller, 'ar-390-seller-add-new')
  await seller.getByRole('menuitem', { name: 'طلب جديد' }).click()
  await expect(seller).toHaveURL(`/b/${workshopId}/orders/new`)
  await expect(bar.getByRole('link', { name: 'الطلبات' })).toHaveAttribute('aria-current', 'page')
  await bar.getByRole('button', { name: 'المزيد' }).click()
  await expect(seller.getByRole('menuitem')).toHaveText([
    'المبيعات',
    'العملاء',
    'مستحقات العملاء',
    'عروض الأسعار',
    'الفواتير',
    'الربح الحقيقي',
    'الإعدادات',
  ])
  await shot(seller, 'ar-390-seller-more')
  await seller.keyboard.press('Escape')
  await setLanguage(seller, 'en')

  // On a desktop: the "Sales" group whole and Real profit (its sales figures: no costs switch).
  await seller.setViewportSize(DESKTOP)
  await seller.goto(`/b/${workshopId}`)
  const nav = mainNav(seller)
  await expect(nav.getByRole('list', { name: 'Sales' }).getByRole('link')).toHaveText([
    'Sales',
    'Orders',
    'Customers',
    'What customers owe',
    'Quotations',
    'Invoices',
  ])
  await expect(nav.getByRole('list', { name: 'Reports' }).getByRole('link')).toHaveText([
    'Real profit',
  ])
  await nav.getByRole('button', { name: 'Add new' }).click()
  await expect(seller.getByRole('menuitem')).toHaveText([
    "Today's sales",
    'New sale',
    'New order',
    'New customer',
    'New quotation',
    'New invoice',
  ])
  await expectSound(seller, 'en')
  await shot(seller, 'en-1440-seller-add-new')
  await seller.keyboard.press('Escape')
})

test('Customize BizCost: the released modules without "Soon", the planned ones with it', async () => {
  await owner.setViewportSize(DESKTOP)
  await owner.goto(`/b/${cafeId}/settings/modules`)
  await expect(owner.getByRole('heading', { level: 1 })).toHaveText('Customize BizCost')
  await expect(owner.locator('[data-item]').first()).toBeVisible()
  const show = owner.getByRole('main').getByRole('button', { name: 'Show', exact: true })
  while ((await show.count()) > 0) await show.first().click()
  for (const id of ['sales', 'customers', 'payments', 'reports', 'orders']) {
    await expect(owner.locator(`[data-item="${id}"]`), id).not.toContainText('Soon')
  }
  for (const id of ['inventory', 'employees', 'vat_center']) {
    await expect(owner.locator(`[data-item="${id}"]`), id).toContainText('Soon')
  }
  await expectSound(owner, 'en')
  await shot(owner, 'en-1440-customize')
})

// ---------------------------------------------------------------------------------------------------
// "Let's calculate your first real profit" (PRODUCT.md §10, D-193, D-244)
// ---------------------------------------------------------------------------------------------------

async function today(page: Page, businessId: string): Promise<string> {
  return (
    await ok(
      callApi<{ today: string }>(page, 'books.get', {}, { businessId, query: true }),
      'books.get',
    )
  ).today
}

test('an empty café, from nothing to its real profit', async () => {
  test.setTimeout(300_000)
  await owner.setViewportSize(DESKTOP)
  await owner.goto(`/b/${soloId}`)
  const card = owner.getByRole('region', { name: "Let's calculate your first real profit" })
  const stepOf = (id: string) => card.locator(`[data-cost-step="${id}"]`)
  await expect(card).toContainText('0 of 8 done')
  await expect(card.locator('[data-cost-step]')).toHaveCount(8)
  await expect(stepOf('products')).toHaveAttribute('data-next', 'true')
  await expect(stepOf('sales')).toContainText('Add or import your sales')
  await expect(stepOf('real_profit')).toContainText('See your real profit')
  await expectSound(owner, 'en')
  await shot(owner, 'en-1440-checklist-empty')

  // 1. What you sell: the step opens a new product's form.
  await card.getByRole('link', { name: 'Add what you sell' }).click()
  await expect(owner).toHaveURL(`/b/${soloId}/products/new`)
  const sheet = owner.getByRole('dialog', { name: 'New product or service' })
  await sheet.getByRole('textbox', { name: 'Name' }).fill('Spanish Latte')
  await sheet.getByRole('textbox', { name: 'Usual price' }).fill('18')
  await sheet.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(owner.getByText(withValue('', 'Spanish Latte', ' added.'))).toBeVisible()
  await mainNav(owner).getByRole('link', { name: 'Dashboard' }).click()
  await expect(card).toContainText('1 of 8 done')

  // 2–5. Its recipe, the milk's price, the rent and the owner's time (their own specs check their
  // screens), each through the API.
  const products = await ok(
    callApi<{ items: { id: string; version: number }[] }>(
      owner,
      'product.list',
      {},
      { businessId: soloId, query: true },
    ),
    'product.list',
  )
  const latte = products.items[0]!
  const milk = randomUUID()
  await ok(
    callApi(
      owner,
      'material.create',
      { id: milk, name: 'Milk', unit: 'ml', packs: [] },
      { businessId: soloId },
    ),
    'material.create',
  )
  await ok(
    callApi(
      owner,
      'recipe.save',
      {
        productId: latte.id,
        version: 0,
        lines: [{ id: randomUUID(), materialId: milk, qty: '200', unit: 'ml' }],
      },
      { businessId: soloId },
    ),
    'recipe.save',
  )
  const day = await today(owner, soloId)
  const purchaseId = randomUUID()
  const draft = await ok(
    callApi<{ data: { version: number } }>(
      owner,
      'purchase.create',
      {
        id: purchaseId,
        businessDate: day,
        documentType: 'no_invoice',
        paymentMethod: 'cash',
        lines: [
          {
            kind: 'material',
            id: randomUUID(),
            materialId: milk,
            qty: '1000',
            unit: 'ml',
            unitPrice: '0.006',
            vatRate: '0',
          },
        ],
      },
      { businessId: soloId },
    ),
    'purchase.create',
  )
  await ok(
    callApi(
      owner,
      'purchase.post',
      { id: purchaseId, version: draft.data.version },
      { businessId: soloId },
    ),
    'purchase.post',
  )
  const categories = await ok(
    callApi<{ items: { id: string; name: string }[] }>(
      owner,
      'costCategory.list',
      {},
      { businessId: soloId, query: true },
    ),
    'costCategory.list',
  )
  await ok(
    callApi(
      owner,
      'runningCost.create',
      {
        id: randomUUID(),
        name: 'Shop rent',
        categoryId: categories.items.find((c) => c.name === 'Rent')!.id,
        amount: '3000',
        frequency: 'monthly',
        startsOn: `${day.slice(0, 8)}01`,
      },
      { businessId: soloId },
    ),
    'runningCost.create',
  )
  await ok(
    callApi(owner, 'productCost.updateSettings', { ownerHourlyRate: '60' }, { businessId: soloId }),
    'rate',
  )
  await ok(
    callApi(
      owner,
      'product.update',
      {
        id: latte.id,
        version: latte.version,
        name: 'Spanish Latte',
        type: 'product',
        unit: 'piece',
        defaultPrice: '18',
        ownerMinutes: '3',
      },
      { businessId: soloId },
    ),
    'product.update',
  )
  await owner.reload()
  // Every cost is in: what is left is to record the sales.
  await expect(card).toContainText('6 of 8 done')
  await expect(stepOf('sales')).toHaveAttribute('data-next', 'true')
  await expect(
    stepOf('sales').getByRole('link', { name: 'Add or import your sales' }),
  ).toHaveAttribute('href', `/b/${soloId}/sales/today`)

  // In Arabic on a phone, two steps from the end.
  await setLanguage(owner, 'ar')
  await owner.setViewportSize(PHONE)
  await owner.reload()
  const arCard = owner.getByRole('region', { name: 'لنحسب ربحك الحقيقي الأول' })
  await expect(arCard).toContainText('تم 6 من 8')
  await expect(arCard.locator('[data-cost-step="sales"]')).toContainText('أضف مبيعاتك أو استوردها')
  await expectSound(owner, 'ar')
  await shot(owner, 'ar-390-checklist-sales-next')
  await setLanguage(owner, 'en')
  await owner.setViewportSize(DESKTOP)

  // 6. The day's sales: 10 lattes at 18.00, finalized (Today's sales has its own spec).
  const channels = await ok(
    callApi<{ data: { items: { id: string; kind: string }[] } }>(
      owner,
      'channel.list',
      {},
      { businessId: soloId, query: true },
    ),
    'channel.list',
  )
  const sale = await ok(
    callApi<{ data: { id: string; version: number } }>(
      owner,
      'sale.create',
      {
        id: randomUUID(),
        source: 'single',
        channelId: channels.data.items.find((c) => c.kind === 'shop')!.id,
        businessDate: day,
        lines: [
          { kind: 'item', id: randomUUID(), productId: latte.id, qty: '10', unitPrice: '18' },
        ],
      },
      { businessId: soloId },
    ),
    'sale.create',
  )
  await ok(
    callApi(
      owner,
      'sale.post',
      { id: sale.data.id, version: sale.data.version },
      { businessId: soloId },
    ),
    'sale.post',
  )

  // 7. Its whole cost is known: "Your real profit is ready", leading to Real profit.
  await owner.reload()
  await expect(card).toHaveCount(0)
  const ready = owner.getByRole('region', { name: 'Your real profit is ready' })
  await expect(ready).toBeVisible()
  await expectSound(owner, 'en')
  await shot(owner, 'en-1440-profit-ready')
  await ready.getByRole('link', { name: 'See your real profit' }).click()
  await expect(owner).toHaveURL(new RegExp(`/b/${soloId}/reports/profit`))
  await expect(owner.getByRole('heading', { level: 1, name: 'Real profit' })).toBeVisible()
  // 180.00 of sales; the milk at 0.006 a ml: 10 × 200 ml = 12.00; her time: 10 × 3 minutes at
  // 60.00 an hour = 30.00.
  await expect(owner.locator('[data-part="sales"]')).toContainText('AED 180.00')
  await expect(owner.locator('[data-part="materials"]')).toContainText('AED 12.00')
  await expect(owner.locator('[data-part="time"]')).toContainText('AED 30.00')
  await expectSound(owner, 'en')
  await shot(owner, 'en-1440-real-profit')

  // The same, in Arabic on a phone.
  await setLanguage(owner, 'ar')
  await owner.setViewportSize(PHONE)
  await owner.goto(`/b/${soloId}`)
  await expect(owner.getByRole('region', { name: 'ربحك الحقيقي جاهز' })).toBeVisible()
  await expectSound(owner, 'ar')
  await shot(owner, 'ar-390-profit-ready')
  await setLanguage(owner, 'en')
  await owner.setViewportSize(DESKTOP)
})

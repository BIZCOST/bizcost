import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import {
  callApi,
  createBusiness,
  createUser,
  deleteUser,
  nextInvitation,
  pngPicture,
  setLanguage,
  signIn,
  useLanguage,
  withValue,
  type TestUser,
} from '../helpers'
import { baseURL } from '../stack'

// The Costing Core's release (ROADMAP.md M2 Step 7; D-188–D-194), on the production build, without
// the dev-only preview:
//   - the shell per role: an owner's sidebar with every Costing Core section and "Add new" (a new
//     product or service, purchase or expense), and on a phone Home | Products | + | Costs | More
//     (Arabic); an employee's Home | Products | + | Expenses with only "New expense"; an
//     accountant without "+" (D-189);
//   - "Let's find the real cost of what you sell" for a new solo café, from nothing to "Your product
//     costs are ready", each step saying what is still missing (D-193);
//   - Roles: "See costs, supplier prices and margins" as one switch, and what the employee sees then
//     (D-190); a member's own permissions on their page, with "Added" and "Back to their role"
//     (D-191);
//   - the logo's crop (the owner's request of 2026-09-30, O-A): a wide logo and one with a lot of
//     white, saved as a square of 512 × 512 with the logo centred, and the saved logo adjusted again;
//   - "For which month?" (O-B, D-194): an electricity bill is for the month before its date, rent
//     for its own month, and the month shows on the expense and in the list.
// Arabic and English, phone and desktop. With E2E_SHOTS_DIR set, each step leaves a screenshot there
// (AR/EN at 390 and 1440 px).

test.describe.configure({ mode: 'serial' })

const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1440, height: 900 }

/** A café that is VAT-registered, with a team (food wording). */
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

const RAW_KEY =
  /\b(?:common|catalog|units|errors|nav|modules|purchasing|expenses|settings|setup|dashboard|costing)\.[a-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+/

const users: TestUser[] = []
const contexts: BrowserContext[] = []

let owner: Page
let employee: Page
let accountant: Page
let employeeUser: TestUser
let cafeId: string
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

async function joinBusiness(member: Page, user: TestUser, templateKey: string) {
  const roles = await ok(
    callApi<{ id: string; templateKey: string | null }[]>(
      owner,
      'role.list',
      {},
      { businessId: cafeId, query: true },
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
      { businessId: cafeId },
    ),
    'invitation.create',
  )
  const { token } = await nextInvitation(user.email)
  await ok(callApi(member, 'invitation.accept', { token }), 'invitation.accept')
}

test.beforeAll(async ({ browser }) => {
  const ownerUser = await createUser('release-owner', { locale: 'en' })
  employeeUser = await createUser('release-employee', { locale: 'en' })
  const accountantUser = await createUser('release-accountant', { locale: 'en' })
  users.push(ownerUser, employeeUser, accountantUser)
  owner = await openAs(browser, ownerUser, 'Layla Haddad')
  employee = await openAs(browser, employeeUser, 'Omar Saleh')
  accountant = await openAs(browser, accountantUser, 'Huda Nasser')
  cafeId = await createBusiness(owner, 'Qahwa House', CAFE_ANSWERS)
  soloId = await createBusiness(owner, 'Maha Coffee Corner', SOLO_CAFE_ANSWERS)
  await joinBusiness(employee, employeeUser, 'employee')
  await joinBusiness(accountant, accountantUser, 'accountant')
})

test.afterAll(async () => {
  for (const context of contexts) await context.close()
  for (const user of users) await deleteUser(user.id)
})

/** A screenshot into E2E_SHOTS_DIR (only when it is set), and the page's end when it is long. */
async function shot(page: Page, name: string) {
  const dir = process.env.E2E_SHOTS_DIR
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(dir, `${name}.png`) })
  const long = await page.evaluate(
    () => document.documentElement.scrollHeight > window.innerHeight + 40,
  )
  const dialog = await page.getByRole('dialog').or(page.getByRole('menu')).count()
  if (long && dialog === 0) {
    const y = await page.evaluate(() => window.scrollY)
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    await page.waitForTimeout(200)
    await page.screenshot({ path: join(dir, `${name}-end.png`) })
    await page.evaluate((top) => window.scrollTo(0, top), y)
  }
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

// ---------------------------------------------------------------------------------------------------
// The shell per role (D-189)
// ---------------------------------------------------------------------------------------------------

test('the owner: every Costing Core section, "Add new" on a desktop, Home | Products | + | Costs | More on a phone', async () => {
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
    'Settings',
  ])
  await nav.getByRole('button', { name: 'Add new' }).click()
  await expect(owner.getByRole('menuitem')).toHaveText([
    'New product or service',
    'New purchase',
    'New expense',
  ])
  await expectSound(owner, 'en')
  await shot(owner, 'en-1440-add-new')
  await owner.getByRole('menuitem', { name: 'New product or service' }).click()
  await expect(owner).toHaveURL(`/b/${cafeId}/products/new`)
  const sheet = owner.getByRole('dialog', { name: 'New product or service' })
  await expect(sheet).toBeVisible()
  await sheet.getByRole('button', { name: 'Close' }).first().click()
  await expect(sheet).toHaveCount(0)
  await expect(owner).toHaveURL(`/b/${cafeId}/products`)
  await nav.getByRole('button', { name: 'Add new' }).click()
  await owner.getByRole('menuitem', { name: 'New purchase' }).click()
  await expect(owner).toHaveURL(`/b/${cafeId}/purchases/new`)

  // On a tablet's rail: "+" with its name in a tooltip, the same actions.
  await owner.setViewportSize({ width: 768, height: 1024 })
  await owner.goto(`/b/${cafeId}`)
  const plus = nav.getByRole('button', { name: 'Add new' })
  await expect(plus).toHaveText('')
  await plus.click()
  await expect(owner.getByRole('menuitem')).toHaveCount(3)
  await expectSound(owner, 'en')
  await shot(owner, 'en-768-rail-add-new')
  await owner.keyboard.press('Escape')

  // On a phone, in Arabic: the tabs the claims give, "+" in the middle, the rest under "More".
  await setLanguage(owner, 'ar')
  await owner.setViewportSize(PHONE)
  await owner.goto(`/b/${cafeId}`)
  const bar = mainNav(owner, 'القائمة الرئيسية')
  await expect(bar.getByRole('listitem')).toHaveCount(5)
  await expect(bar.getByRole('link')).toHaveText(['الرئيسية', 'المنتجات', 'التكاليف'])
  await expect(bar.getByRole('link', { name: 'تكاليف المنتجات' })).toBeVisible()
  await expect(bar.getByRole('listitem').nth(2).getByRole('button')).toHaveAccessibleName(
    'إضافة جديد',
  )
  await expectSound(owner, 'ar')
  await shot(owner, 'ar-390-dashboard-tabs')
  await bar.getByRole('button', { name: 'إضافة جديد' }).click()
  await expect(owner.getByRole('menuitem')).toHaveText([
    'منتج أو خدمة جديدة',
    'مشتريات جديدة',
    'مصروف جديد',
  ])
  await shot(owner, 'ar-390-add-new')
  await owner.keyboard.press('Escape')
  await bar.getByRole('button', { name: 'المزيد' }).click()
  await expect(owner.getByRole('menuitem')).toHaveText([
    'المكونات والمستلزمات',
    'الموردون',
    'المشتريات',
    'المستحقات',
    'المصروفات',
    'المصاريف التشغيلية',
    'الإعدادات',
  ])
  await shot(owner, 'ar-390-more')
  await owner.getByRole('menuitem', { name: 'المصروفات' }).click()
  await expect(owner).toHaveURL(`/b/${cafeId}/expenses`)
  // The page is under "More": it is the tab marked.
  await expect(bar.getByRole('button', { name: 'المزيد' })).toBeVisible()
  await setLanguage(owner, 'en')
  await owner.setViewportSize(DESKTOP)
})

test('an employee: Home | Products | + | Expenses, and "+" straight to a new expense', async () => {
  await employee.setViewportSize(PHONE)
  await employee.goto(`/b/${cafeId}`)
  const bar = mainNav(employee)
  // One action: "+" is a link to it, named after it, not a menu of one (D-200).
  await expect(bar.getByRole('link')).toHaveText(['Dashboard', 'Products', '', 'Expenses'])
  await expect(bar.getByRole('button', { name: 'Add new' })).toHaveCount(0)
  await expect(bar.getByRole('listitem').nth(2).getByRole('link')).toHaveAccessibleName(
    'New expense',
  )
  await expectSound(employee, 'en')
  await shot(employee, 'en-390-employee-add-new')
  await bar.getByRole('link', { name: 'New expense' }).click()
  await expect(employee).toHaveURL(`/b/${cafeId}/expenses/new`)
  await expect(employee.getByRole('heading', { level: 1, name: 'New expense' })).toBeVisible()

  // A desktop: the same one action beside the sections. No "Product costs" (costs stay locked).
  await employee.setViewportSize(DESKTOP)
  await employee.goto(`/b/${cafeId}`)
  const nav = mainNav(employee)
  await expect(nav.getByRole('link')).toHaveText([
    'New expense',
    'Dashboard',
    'Products & Services',
    'Ingredients & supplies',
    'Expenses',
    'Settings',
  ])
  await expect(nav.getByRole('button', { name: 'Add new' })).toHaveCount(0)
  await nav.getByRole('link', { name: 'New expense' }).click()
  await expect(employee).toHaveURL(`/b/${cafeId}/expenses/new`)
  await employee.goto(`/b/${cafeId}`)
  // The employee has no cost steps: nothing about costs on their Dashboard.
  await expect(
    employee.getByRole('region', { name: "Let's find the real cost of what you sell" }),
  ).toHaveCount(0)
})

test('an accountant: four tabs and no "+" (they enter nothing), in Arabic', async () => {
  await setLanguage(accountant, 'ar')
  await accountant.setViewportSize(PHONE)
  await accountant.goto(`/b/${cafeId}`)
  const bar = mainNav(accountant, 'القائمة الرئيسية')
  await expect(bar.getByRole('link')).toHaveText(['الرئيسية', 'المنتجات', 'المصروفات', 'التكاليف'])
  await expect(bar.getByRole('button', { name: 'إضافة جديد' })).toHaveCount(0)
  await expectSound(accountant, 'ar')
  await shot(accountant, 'ar-390-accountant-tabs')
  await accountant.setViewportSize(DESKTOP)
  await accountant.goto(`/b/${cafeId}`)
  await expect(
    mainNav(accountant, 'القائمة الرئيسية').getByRole('button', { name: 'إضافة جديد' }),
  ).toHaveCount(0)
  await setLanguage(accountant, 'en')
})

// ---------------------------------------------------------------------------------------------------
// "Let's find the real cost of what you sell" (D-193)
// ---------------------------------------------------------------------------------------------------

async function today(page: Page, businessId: string): Promise<string> {
  return (
    await ok(
      callApi<{ today: string }>(page, 'books.get', {}, { businessId, query: true }),
      'books.get',
    )
  ).today
}

test('a new solo café, from nothing to "Your product costs are ready"', async () => {
  await owner.setViewportSize(DESKTOP)
  await owner.goto(`/b/${soloId}`)
  const card = owner.getByRole('region', { name: "Let's find the real cost of what you sell" })
  const stepOf = (id: string) => card.locator(`[data-cost-step="${id}"]`)
  await expect(card).toContainText('0 of 6 done')
  await expect(card.locator('[data-cost-step]')).toHaveCount(6)
  await expect(stepOf('products')).toHaveAttribute('data-next', 'true')
  await expect(stepOf('owner_time')).toContainText(
    'What an hour of your time is worth, and the minutes each product takes you.',
  )
  await expectSound(owner, 'en')
  await shot(owner, 'en-1440-costs-checklist-empty')

  // 1. What you sell: the step opens a new product's form.
  await card.getByRole('link', { name: 'Add what you sell' }).click()
  await expect(owner).toHaveURL(`/b/${soloId}/products/new`)
  const sheet = owner.getByRole('dialog', { name: 'New product or service' })
  await sheet.getByRole('textbox', { name: 'Name' }).fill('Spanish Latte')
  await sheet.getByRole('textbox', { name: 'Usual price' }).fill('18')
  await sheet.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(owner.getByText(withValue('', 'Spanish Latte', ' added.'))).toBeVisible()
  await expect(owner).toHaveURL(`/b/${soloId}/products`)
  await mainNav(owner).getByRole('link', { name: 'Dashboard' }).click()
  await expect(card).toContainText('1 of 6 done')
  await expect(stepOf('products')).toHaveAttribute('data-done', 'true')
  await expect(stepOf('recipes')).toHaveAttribute('data-next', 'true')
  await expect(stepOf('recipes')).toContainText('1 product you make has no recipe yet.')

  // 2. What goes into it (the API, as the recipe's own spec checks its screen).
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
  await owner.reload()
  await expect(card).toContainText('2 of 6 done')
  await expect(stepOf('purchases')).toContainText(
    '1 ingredient or supply you use has no price yet: enter a purchase of it.',
  )
  await expect(stepOf('purchases').getByRole('link')).toHaveAttribute(
    'href',
    `/b/${soloId}/purchases/new`,
  )

  // 3. Its purchase price.
  const purchaseId = randomUUID()
  const draft = await ok(
    callApi<{ data: { version: number } }>(
      owner,
      'purchase.create',
      {
        id: purchaseId,
        businessDate: await today(owner, soloId),
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
  await owner.reload()
  await expect(card).toContainText('3 of 6 done')
  await expect(stepOf('running_costs')).toHaveAttribute('data-next', 'true')
  await expect(stepOf('running_costs')).toContainText('Rent, electricity, salaries')

  // In Arabic on a phone, halfway.
  await setLanguage(owner, 'ar')
  await owner.setViewportSize(PHONE)
  await owner.reload()
  const arCard = owner.getByRole('region', { name: 'لنعرف التكلفة الحقيقية لما تبيعه' })
  await expect(arCard).toContainText('تم 3 من 6')
  await expect(arCard.locator('[data-cost-step="running_costs"]')).toContainText(
    'أضف مصاريفك التشغيلية',
  )
  await expectSound(owner, 'ar')
  await shot(owner, 'ar-390-costs-checklist')
  await setLanguage(owner, 'en')
  await owner.setViewportSize(DESKTOP)

  // 4. Running costs; then the estimate of monthly purchases (not 3 months of them yet).
  const categories = await ok(
    callApi<{ items: { id: string; name: string }[] }>(
      owner,
      'costCategory.list',
      {},
      { businessId: soloId, query: true },
    ),
    'costCategory.list',
  )
  const rent = categories.items.find((c) => c.name === 'Rent')!
  await ok(
    callApi(
      owner,
      'runningCost.create',
      {
        id: randomUUID(),
        name: 'Shop rent',
        categoryId: rent.id,
        amount: '3000',
        frequency: 'monthly',
        startsOn: `${(await today(owner, soloId)).slice(0, 8)}01`,
      },
      { businessId: soloId },
    ),
    'runningCost.create',
  )
  await owner.reload()
  await expect(stepOf('running_costs')).toContainText(
    'Add an estimate of what you buy in a month, until 3 months of purchases are in.',
  )
  await expect(stepOf('running_costs').getByRole('link')).toHaveAttribute(
    'href',
    `/b/${soloId}/settings/costing`,
  )
  await ok(
    callApi(
      owner,
      'productCost.updateSettings',
      { estimatedMonthlyPurchases: '6000' },
      { businessId: soloId },
    ),
    'estimate',
  )
  await owner.reload()
  // Running costs are done, and so is every product's cost: the owner's time is not counted until
  // its minutes are there, so nothing is missing from it.
  await expect(card).toContainText('5 of 6 done')
  await expect(stepOf('product_costs')).toHaveAttribute('data-done', 'true')

  // 5. The owner's time: the hourly rate, then the minutes on the product.
  await expect(stepOf('owner_time')).toHaveAttribute('data-next', 'true')
  await expect(stepOf('owner_time').getByRole('link')).toHaveAttribute(
    'href',
    `/b/${soloId}/settings/costing`,
  )
  await ok(
    callApi(owner, 'productCost.updateSettings', { ownerHourlyRate: '60' }, { businessId: soloId }),
    'rate',
  )
  await owner.reload()
  await expect(stepOf('owner_time')).toContainText('The minutes each product takes you.')
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

  // 6. Every cost complete: the card gives way to "Your product costs are ready".
  await owner.reload()
  await expect(card).toHaveCount(0)
  const ready = owner.getByRole('region', { name: 'Your product costs are ready' })
  await expect(ready).toBeVisible()
  await expect(ready.getByRole('link', { name: 'See product costs' })).toHaveAttribute(
    'href',
    `/b/${soloId}/product-costs`,
  )
  await shot(owner, 'en-1440-costs-ready')
  await ready.getByRole('button', { name: 'Hide' }).click()
  await expect(ready).toHaveCount(0)
  await owner.reload()
  await expect(ready).toHaveCount(0)
  await expect(card).toHaveCount(0)
})

// ---------------------------------------------------------------------------------------------------
// Roles and a member's own permissions (D-190, D-191)
// ---------------------------------------------------------------------------------------------------

async function visibleTo(page: Page): Promise<string[]> {
  const context = await ok(
    callApi<{ visibleCategories: string[] }>(
      page,
      'business.context',
      {},
      { businessId: cafeId, query: true },
    ),
    'business.context',
  )
  return [...context.visibleCategories].sort()
}

test('Roles: "See costs, supplier prices and margins" is one switch', async () => {
  await owner.setViewportSize(DESKTOP)
  await owner.goto(`/b/${cafeId}/settings/roles`)
  const role = owner.locator('[data-role="employee"]')
  await role.getByRole('button', { name: 'Edit permissions' }).click()
  const section = role.locator('[data-sensitive-section]')
  await expect(section.getByRole('switch')).toHaveCount(1)
  const costs = section.getByRole('switch', { name: 'See costs, supplier prices and margins' })
  await expect(costs).not.toBeChecked()
  // No switch for one of them alone.
  await expect(role.getByRole('switch', { name: 'See costs', exact: true })).toHaveCount(0)
  await expect(role.getByRole('switch', { name: 'See supplier prices' })).toHaveCount(0)
  await costs.click()
  await expect(costs).toBeChecked()
  await expectSound(owner, 'en')
  await section.scrollIntoViewIfNeeded()
  await shot(owner, 'en-1440-roles-sensitive')
  await role.getByRole('button', { name: 'Save permissions' }).click()
  await expect(owner.getByText(/^Permissions of .*Employee.* saved\.$/)).toBeVisible()
  expect(await visibleTo(employee)).toEqual(['cost', 'profit_margin', 'supplier_price'])

  // Off again, in Arabic on a phone.
  await setLanguage(owner, 'ar')
  await owner.setViewportSize(PHONE)
  await owner.goto(`/b/${cafeId}/settings/roles`)
  await role.getByRole('button', { name: 'تعديل الصلاحيات' }).click()
  const arSwitch = role
    .locator('[data-sensitive-section]')
    .getByRole('switch', { name: 'يرى التكاليف وأسعار الموردين وهوامش الربح' })
  await expect(arSwitch).toBeChecked()
  await arSwitch.click()
  await role.locator('[data-sensitive-section]').scrollIntoViewIfNeeded()
  await expectSound(owner, 'ar')
  await shot(owner, 'ar-390-roles-sensitive')
  await role.getByRole('button', { name: 'حفظ الصلاحيات' }).click()
  await expect(owner.getByText(/تم حفظ صلاحيات/)).toBeVisible()
  expect(await visibleTo(employee)).toEqual([])
  await setLanguage(owner, 'en')
  await owner.setViewportSize(DESKTOP)
})

test("a member's own permissions: costs for one employee, then back to their role", async () => {
  await owner.goto(`/b/${cafeId}/settings/members`)
  const row = owner.locator(`[data-member="${employeeUser.email}"]`)
  await row.getByRole('button', { name: /^Options for/ }).click()
  await owner.getByRole('menuitem', { name: 'Permissions' }).click()
  await expect(owner).toHaveURL(new RegExp(`/b/${cafeId}/settings/members/[0-9a-f-]{36}$`))
  await expect(owner.getByRole('heading', { level: 1 })).toHaveText(
    withValue('What ', 'Omar Saleh', ' can do'),
  )
  await expect(owner.getByText('Same as their role')).toBeVisible()
  const costs = owner.getByRole('switch', { name: 'See costs, supplier prices and margins' })
  await expect(costs).not.toBeChecked()
  await costs.click()
  await expect(owner.locator('[data-change="added"]')).toHaveCount(1)
  await expect(owner.getByText('1 change from their role')).toBeVisible()
  // Seeing product costs needs what goes into each product (already theirs): switched on alone.
  const productCosts = owner.getByRole('switch', { name: 'See product costs' })
  await productCosts.click()
  await expect(owner.getByText('2 changes from their role')).toBeVisible()
  await expectSound(owner, 'en')
  await shot(owner, 'en-1440-member-access')
  await owner.getByRole('button', { name: 'Save permissions' }).click()
  await expect(
    owner.getByText(withValue('', 'Omar Saleh', "'s permissions were saved.")),
  ).toBeVisible()
  expect(await visibleTo(employee)).toEqual(['cost', 'profit_margin', 'supplier_price'])
  // Their shell follows: Product costs is theirs now.
  await employee.setViewportSize(DESKTOP)
  await employee.goto(`/b/${cafeId}`)
  await expect(mainNav(employee).getByRole('link', { name: 'Product costs' })).toBeVisible()

  // The team list says who has their own.
  await owner.getByRole('link', { name: 'Team' }).first().click()
  await expect(row.getByText('Own permissions')).toBeVisible()

  // In Arabic on a phone: back to their role.
  await setLanguage(owner, 'ar')
  await owner.setViewportSize(PHONE)
  await owner.reload()
  await row.getByRole('button', { name: /^خيارات/ }).click()
  await owner.getByRole('menuitem', { name: 'الصلاحيات' }).click()
  await expect(owner.getByText('تغييران عن دوره')).toBeVisible()
  await expectSound(owner, 'ar')
  await shot(owner, 'ar-390-member-access')
  await owner.getByRole('button', { name: 'العودة إلى صلاحيات دوره' }).click()
  await expect(owner.getByText('مثل دوره تمامًا')).toBeVisible()
  await owner.getByRole('button', { name: 'حفظ الصلاحيات' }).click()
  await expect(owner.getByText(/تم حفظ صلاحيات/)).toBeVisible()
  expect(await visibleTo(employee)).toEqual([])
  await owner.getByRole('link', { name: 'الفريق' }).first().click()
  await expect(row.getByText('صلاحيات خاصة')).toHaveCount(0)
  await setLanguage(owner, 'en')
  await owner.setViewportSize(DESKTOP)
})

// ---------------------------------------------------------------------------------------------------
// The logo's square crop (O-A)
// ---------------------------------------------------------------------------------------------------

const BLUE = [29, 78, 216, 255] as const
const WHITE = [255, 255, 255, 255] as const
const CLEAR = [0, 0, 0, 0] as const

/**
 * The saved logo (its `src`), read in the page: its size and the box of its blue pixels (the mark),
 * in its pixels.
 */
async function savedLogo(page: Page) {
  const logo = page.getByTestId('business-logo')
  await expect
    .poll(() => logo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
    .toBeGreaterThan(0)
  const src = (await logo.getAttribute('src')) ?? ''
  return page.evaluate(async (url) => {
    const blob = await (await fetch(url)).blob()
    const bitmap = await createImageBitmap(blob)
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')!
    context.drawImage(bitmap, 0, 0)
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height)
    let minX = bitmap.width
    let minY = bitmap.height
    let maxX = -1
    let maxY = -1
    for (let y = 0; y < bitmap.height; y++) {
      for (let x = 0; x < bitmap.width; x++) {
        const i = (y * bitmap.width + x) * 4
        const blue = data[i + 3]! > 128 && data[i + 2]! > 150 && data[i]! < 120
        if (!blue) continue
        minX = Math.min(minX, x)
        maxX = Math.max(maxX, x)
        minY = Math.min(minY, y)
        maxY = Math.max(maxY, y)
      }
    }
    return {
      type: blob.type,
      width: bitmap.width,
      height: bitmap.height,
      mark: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
    }
  }, src)
}

test('the logo: placed in its square before it is saved, centred, and adjusted again', async () => {
  await owner.setViewportSize(DESKTOP)
  await owner.goto(`/b/${cafeId}/settings/business`)
  const input = owner.locator('input[type=file]')

  // A wide logo (600 × 150, transparent around its mark): whole, across the square, centred.
  await input.setInputFiles({
    name: 'wide.png',
    mimeType: 'image/png',
    buffer: pngPicture(600, 150, (x, y) =>
      x >= 10 && x < 590 && y >= 40 && y < 110 ? BLUE : CLEAR,
    ),
  })
  const cropper = owner.getByRole('dialog', { name: 'Adjust your logo' })
  await expect(cropper).toBeVisible()
  await expect(cropper.locator('[data-logo-preview="sidebar"]')).toContainText('Qahwa House')
  await expect(cropper.locator('[data-logo-preview="header"]')).toBeVisible()
  await expectSound(owner, 'en')
  await shot(owner, 'en-1440-logo-crop-wide')
  await cropper.getByRole('button', { name: 'Save logo' }).click()
  await expect(owner.getByText('Logo saved.')).toBeVisible()
  await expect(cropper).toHaveCount(0)
  let saved = await savedLogo(owner)
  expect(saved.width).toBe(512)
  expect(saved.height).toBe(512)
  expect(['image/webp', 'image/png']).toContain(saved.type)
  // Its width across the square, its middle in the square's middle.
  expect(saved.mark.width).toBeGreaterThan(480)
  expect(Math.abs(saved.mark.x + saved.mark.width / 2 - 256)).toBeLessThan(4)
  expect(Math.abs(saved.mark.y + saved.mark.height / 2 - 256)).toBeLessThan(4)

  // A small mark on a lot of white, off-centre: fitted to the mark, centred.
  await input.setInputFiles({
    name: 'white.png',
    mimeType: 'image/png',
    buffer: pngPicture(400, 400, (x, y) =>
      x >= 40 && x < 100 && y >= 290 && y < 350 ? BLUE : WHITE,
    ),
  })
  await expect(cropper).toBeVisible()
  await shot(owner, 'en-1440-logo-crop-white')
  await cropper.getByRole('button', { name: 'Save logo' }).click()
  await expect(cropper).toHaveCount(0)
  await expect.poll(async () => (await savedLogo(owner)).mark.width).toBeGreaterThan(440)
  saved = await savedLogo(owner)
  expect(saved.width).toBe(512)
  expect(Math.abs(saved.mark.x + saved.mark.width / 2 - 256)).toBeLessThan(6)
  expect(Math.abs(saved.mark.y + saved.mark.height / 2 - 256)).toBeLessThan(6)

  // The saved logo, adjusted again (it opens from its own address): the whole logo, smaller.
  const before = await owner.getByTestId('business-logo').getAttribute('src')
  await owner.getByRole('button', { name: 'Adjust' }).click()
  await expect(cropper.locator('[data-logo-crop]')).toBeVisible()
  await expect(cropper.getByText("This picture couldn't be opened.")).toHaveCount(0)
  await cropper.getByRole('button', { name: 'Zoom out' }).click()
  await cropper.getByRole('button', { name: 'Whole logo' }).click()
  // A keyboard moves it too (still within the square).
  await cropper.locator('[data-logo-crop]').focus()
  await owner.keyboard.press('ArrowRight')
  await cropper.getByRole('button', { name: 'Save logo' }).click()
  await expect(cropper).toHaveCount(0)
  await expect.poll(() => owner.getByTestId('business-logo').getAttribute('src')).not.toBe(before)
  expect((await savedLogo(owner)).width).toBe(512)

  // In Arabic on a phone.
  await setLanguage(owner, 'ar')
  await owner.setViewportSize(PHONE)
  await owner.reload()
  await owner.getByRole('button', { name: 'ضبط' }).click()
  const arCropper = owner.getByRole('dialog', { name: 'اضبط شعارك' })
  await expect(arCropper.locator('[data-logo-crop]')).toBeVisible()
  await expectSound(owner, 'ar')
  await shot(owner, 'ar-390-logo-crop')
  await arCropper.getByRole('button', { name: 'إلغاء' }).click()
  await expect(arCropper).toHaveCount(0)
  // The logo fills its square in the header next to the name.
  await owner.goto(`/b/${cafeId}`)
  await shot(owner, 'ar-390-logo-header')
  await setLanguage(owner, 'en')
  await owner.setViewportSize(DESKTOP)
})

// ---------------------------------------------------------------------------------------------------
// "For which month?" (O-B, D-194)
// ---------------------------------------------------------------------------------------------------

/** `month` (YYYY-MM) moved by `count` months. */
function addMonths(month: string, count: number): string {
  const total = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + count
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`
}

function monthName(month: string, locale: 'en-US' | 'ar-AE'): string {
  return new Intl.DateTimeFormat(locale === 'ar-AE' ? 'ar-AE-u-nu-latn' : 'en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${month}-01T00:00:00Z`))
}

test('an electricity bill is for the month before its date; rent for its own month', async () => {
  const day = await today(owner, soloId)
  const thisMonth = day.slice(0, 7)
  const lastMonth = addMonths(thisMonth, -1)
  await owner.setViewportSize(DESKTOP)
  await owner.goto(`/b/${soloId}/expenses/new`)
  const category = owner.getByRole('combobox', { name: 'Category', exact: true })
  const month = owner.getByRole('combobox', { name: 'For which month?' })
  await expect(month).toHaveValue(thisMonth)
  await category.selectOption({ label: 'Electricity' })
  await expect(month).toHaveValue(lastMonth)
  await expect(owner.getByText(/Electricity.* bills usually come the month after/)).toBeVisible()
  await category.selectOption({ label: 'Rent' })
  await expect(month).toHaveValue(thisMonth)
  await category.selectOption({ label: 'Electricity' })
  await expect(month).toHaveValue(lastMonth)
  await owner.getByRole('textbox', { name: 'Amount' }).fill('450')
  await owner.getByRole('combobox', { name: 'How it was paid' }).selectOption({ label: 'Cash' })
  await expectSound(owner, 'en')
  await shot(owner, 'en-1440-expense-month')
  await owner.getByRole('button', { name: 'Finalize' }).click()
  await owner.getByRole('alertdialog').getByRole('button', { name: 'Finalize' }).click()
  await expect(owner.getByText('Expense finalized.')).toBeVisible()
  await expect(owner.locator(`[data-period-month="${lastMonth}"]`)).toHaveText(
    monthName(lastMonth, 'en-US'),
  )
  await expect(owner.getByText('For the month of')).toBeVisible()

  // The list says the month when it is not the bill's own, and filters by it.
  await owner.goto(`/b/${soloId}/expenses`)
  const row = owner.locator('[data-expense]').first()
  await expect(row).toContainText(`For ${monthName(lastMonth, 'en-US')}`)
  await owner.getByRole('combobox', { name: 'For which month' }).selectOption(lastMonth)
  await expect(owner).toHaveURL(new RegExp(`month=${lastMonth}`))
  await expect(owner.locator('[data-expense]')).toHaveCount(1)
  await owner.getByRole('combobox', { name: 'For which month' }).selectOption(thisMonth)
  await expect(owner.locator('[data-expense]')).toHaveCount(0)

  // A category can be marked "billed the month after".
  await owner.goto(`/b/${soloId}/expenses`)
  await owner.getByRole('button', { name: 'Categories' }).click()
  const categories = owner.getByRole('dialog', { name: 'Categories' })
  await expect(
    categories.locator('[data-category="Electricity"] [data-billed-next-month]'),
  ).toBeVisible()
  await categories.getByRole('button', { name: withValue('Edit ', 'Rent') }).click()
  await categories.getByRole('switch', { name: 'Its bills come the month after' }).click()
  await categories.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(owner.getByText('Category saved.')).toBeVisible()
  await expect(categories.locator('[data-category="Rent"] [data-billed-next-month]')).toBeVisible()
  await shot(owner, 'en-1440-categories-billed')
  await categories.getByRole('button', { name: 'Close' }).first().click()

  // In Arabic on a phone: rent is now billed the month after too.
  await setLanguage(owner, 'ar')
  await owner.setViewportSize(PHONE)
  await owner.goto(`/b/${soloId}/expenses/new`)
  const arMonth = owner.getByRole('combobox', { name: 'لأي شهر هذه الفاتورة؟' })
  // The business was set up in English: its categories have English names.
  await owner.getByRole('combobox', { name: 'الفئة', exact: true }).selectOption({ label: 'Rent' })
  await expect(arMonth).toHaveValue(lastMonth)
  await expectSound(owner, 'ar')
  await arMonth.scrollIntoViewIfNeeded()
  await shot(owner, 'ar-390-expense-month')
  await setLanguage(owner, 'en')
  await owner.setViewportSize(DESKTOP)
})

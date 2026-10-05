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
  RAW_KEY,
  setLanguage,
  signIn,
  useLanguage,
  type TestUser,
} from '../helpers'
import { previewBaseURL } from '../stack'

// Real profit (ROADMAP.md M3 Step 3), on the dev-only preview (D-125, D-127: the `preview` project, a
// `next dev` server with BIZCOST_PREVIEW_MODULES=sales,reports). Sales and Reports stay `planned`
// until Release A.
//
//   - The owner of a café (team, no VAT, no branches): last month 4,000 lattes at 18.00 (200 ml of
//     milk at AED 6 a litre: 1.20 each) and 1,000 croissants at 8.00 without a recipe, 80,000 of
//     sales, and a rent of 20,000 a month: 20,000 ÷ 80,000 = 25 % (the plan's definition of done).
//     Today, 10 lattes. In English on a desktop: Real profit for last month by product (AED 55,200.00,
//     every part explained, the rate as a division, 90 % of sales complete and the croissant's missing
//     recipe), the latte's live share on Product costs ("AED 4.50 · 25% of its price (…)", "At …'s
//     rate until … ends"), and the Dashboard's cards. In Arabic on a phone: the cards, the chart
//     mirrored (the first day at the right) with its table for screen readers, "Let's calculate your
//     first real profit" with its two sales steps done, and Real profit by day.
//   - An Employee sees no profit: no cards, no Real profit in the menu, and its address "isn't open to
//     you" (English on a phone, Arabic on a desktop).
// With E2E_SHOTS_DIR set, each step leaves a screenshot there.

test.describe.configure({ mode: 'serial' })

const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1440, height: 900 }

/** A café with a team and stock, one location, not VAT-registered, selling to walk-in customers. */
const CAFE_ANSWERS = {
  what_you_do: ['food_drinks'],
  workplace: 'shop',
  branches: false,
  team: 'team',
  team_tracking: ['hours'],
  work_setup: ['stock'],
  sales_channels: ['walk_in'],
  pos: false,
  vat: 'no',
}

const users: TestUser[] = []
const contexts: BrowserContext[] = []

test.afterAll(async () => {
  for (const context of contexts) await context.close()
  for (const user of users) await deleteUser(user.id)
})

async function openAs(
  browser: Browser,
  user: TestUser,
  viewport: { width: number; height: number },
  locale: 'en' | 'ar',
  displayName: string,
): Promise<Page> {
  const context = await browser.newContext({
    baseURL: previewBaseURL,
    locale: locale === 'ar' ? 'ar-AE' : 'en-US',
    viewport,
  })
  contexts.push(context)
  // The development server's own badge and overlay are not part of the app (D-127).
  await context.addInitScript(() => {
    const sheet = new CSSStyleSheet()
    sheet.replaceSync('[data-nextjs-dev-overlay] { display: none !important; }')
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
  })
  await useLanguage(context, 'en')
  const page = await context.newPage()
  await signIn(page, user)
  expect((await callApi(page, 'account.updateProfile', { displayName })).appCode).toBeUndefined()
  if (locale === 'ar') await setLanguage(page, 'ar')
  return page
}

async function ok<T>(pending: Promise<{ data?: T; appCode?: string }>, what: string): Promise<T> {
  const result = await pending
  expect(result.appCode, what).toBeUndefined()
  return result.data as T
}

/** A screenshot into E2E_SHOTS_DIR (only when it is set): the whole page. */
async function shot(page: Page, name: string) {
  const dir = process.env.E2E_SHOTS_DIR
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true })
}

/** The page is in `locale`, fits its width and shows no untranslated key. */
async function expectSound(page: Page, locale: 'en' | 'ar') {
  await expect(page.locator('html')).toHaveAttribute('lang', locale)
  await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr')
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
  expect(await page.locator('body').innerText()).not.toMatch(RAW_KEY)
  expect(await page.title()).not.toMatch(RAW_KEY)
}

/** Switches the signed-in user's language and the page's size, then opens `path`. */
async function view(
  page: Page,
  path: string,
  locale: 'en' | 'ar',
  viewport: { width: number; height: number },
) {
  await setLanguage(page, locale)
  await page.setViewportSize(viewport)
  await page.goto(path)
}

async function todayOf(page: Page, businessId: string): Promise<string> {
  return (
    await ok(
      callApi<{ today: string }>(page, 'books.get', {}, { businessId, query: true }),
      'books.get',
    )
  ).today
}

/** The month before `day`'s (YYYY-MM). */
function monthBefore(day: string): string {
  const date = new Date(`${day.slice(0, 7)}-01T00:00:00Z`)
  date.setUTCMonth(date.getUTCMonth() - 1)
  return date.toISOString().slice(0, 7)
}

async function product(page: Page, businessId: string, name: string, price: string) {
  const id = randomUUID()
  await ok(
    callApi(
      page,
      'product.create',
      { id, name, type: 'product', unit: 'piece', defaultPrice: price },
      { businessId },
    ),
    `product.create ${name}`,
  )
  return id
}

/** A day sheet of `lines` on `businessDate`, finalized. */
async function daySheet(
  page: Page,
  businessId: string,
  businessDate: string,
  lines: { productId: string; qty: string; unitPrice: string }[],
) {
  const id = randomUUID()
  const created = await ok(
    callApi<{ data: { version: number } }>(
      page,
      'sale.create',
      {
        id,
        source: 'day_sheet',
        businessDate,
        lines: lines.map((line) => ({ kind: 'item', id: randomUUID(), ...line })),
      },
      { businessId },
    ),
    'sale.create',
  )
  await ok(
    callApi(page, 'sale.post', { id, version: created.data.version }, { businessId }),
    'sale.post',
  )
}

/** Invites `user` into the business with the role of `templateKey`; they accept it. */
async function joinBusiness(
  owner: Page,
  businessId: string,
  member: Page,
  user: TestUser,
  templateKey: string,
) {
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

/** A month's name as the English page writes it ("September 2026", or "September" alone). */
function monthName(month: string, withYear = true): string {
  return new Intl.DateTimeFormat('en-AE', {
    month: 'long',
    ...(withYear ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  }).format(new Date(`${month}-01T00:00:00Z`))
}

let businessId = ''
let owner: Page

test('the owner of a café sees its real profit, explained, in English on a desktop', async ({
  browser,
}) => {
  test.setTimeout(900_000)
  const user = await createUser('profit-owner', { locale: 'en' })
  users.push(user)
  owner = await openAs(browser, user, DESKTOP, 'en', 'Khalid')
  businessId = await createBusiness(owner, 'Corner Cafe', CAFE_ANSWERS)
  const today = await todayOf(owner, businessId)
  const last = monthBefore(today)
  // The café opened the month before: last month is a whole month with sales before it (Q6).
  const opened = monthBefore(`${last}-01`)

  // The latte's milk (200 ml at AED 6 a litre: 1.20 a cup), bought when it opened; the croissant
  // has no recipe yet.
  const latte = await product(owner, businessId, 'Spanish Latte', '18')
  const croissant = await product(owner, businessId, 'Croissant', '8')
  const milk = randomUUID()
  await ok(
    callApi(
      owner,
      'material.create',
      { id: milk, name: 'Milk', unit: 'l', packs: [] },
      { businessId },
    ),
    'material.create',
  )
  await ok(
    callApi(
      owner,
      'recipe.save',
      {
        productId: latte,
        version: 0,
        lines: [{ id: randomUUID(), materialId: milk, qty: '200', unit: 'ml' }],
      },
      { businessId },
    ),
    'recipe.save',
  )
  const purchase = randomUUID()
  const draft = await ok(
    callApi<{ data: { version: number } }>(
      owner,
      'purchase.create',
      {
        id: purchase,
        businessDate: `${opened}-01`,
        documentType: 'no_invoice',
        paymentMethod: 'cash',
        lines: [
          {
            kind: 'material',
            id: randomUUID(),
            materialId: milk,
            qty: '1000',
            unit: 'l',
            unitPrice: '6',
            vatRate: '0',
          },
        ],
      },
      { businessId },
    ),
    'purchase.create',
  )
  await ok(
    callApi(owner, 'purchase.post', { id: purchase, version: draft.data.version }, { businessId }),
    'purchase.post',
  )
  // Rent of AED 20,000 a month since it opened.
  const categories = await ok(
    callApi<{ items: { id: string; name: string }[] }>(
      owner,
      'costCategory.list',
      { limit: 100 },
      { businessId, query: true },
    ),
    'costCategory.list',
  )
  const rent = categories.items.find((category) => category.name === 'Rent')
  expect(rent).toBeDefined()
  await ok(
    callApi(
      owner,
      'runningCost.create',
      {
        id: randomUUID(),
        categoryId: rent!.id,
        startsOn: `${opened}-01`,
        name: 'Shop rent',
        amount: '20000',
        frequency: 'monthly',
      },
      { businessId },
    ),
    'runningCost.create',
  )
  // Its first sale when it opened; last month: 4,000 lattes and 1,000 croissants, 80,000 of sales;
  // today: 10 lattes.
  await daySheet(owner, businessId, `${opened}-01`, [
    { productId: latte, qty: '10', unitPrice: '18' },
  ])
  await daySheet(owner, businessId, `${last}-10`, [
    { productId: latte, qty: '4000', unitPrice: '18' },
    { productId: croissant, qty: '1000', unitPrice: '8' },
  ])
  await daySheet(owner, businessId, today, [{ productId: latte, qty: '10', unitPrice: '18' }])

  // Real profit is in the menu (the preview); last month by product.
  await owner.goto(`/b/${businessId}`)
  await owner
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Real profit' })
    .click()
  await expect(owner).toHaveURL(new RegExp(`/b/${businessId}/reports/profit`))
  await expect(owner.getByRole('heading', { level: 1, name: 'Real profit' })).toBeVisible()
  await owner.getByLabel('Period').selectOption('last_month')
  await expect(owner).toHaveURL(/period=last_month/)
  const summary = owner.locator('[data-profit-summary]')
  await expect(summary).toContainText('AED 55,200.00')
  await expect(summary).toContainText('69.0% of your sales')
  await expect(summary).toContainText('Not complete yet')
  // Every figure says how it was worked out.
  const part = (id: string) => owner.locator(`[data-part="${id}"]`)
  await expect(part('sales')).toContainText('AED 80,000.00')
  await expect(part('materials')).toContainText(
    'Ingredients & supplies (by your recipes, at your average cost)',
  )
  await expect(part('materials')).toContainText('AED 4,800.00')
  await expect(part('materials')).toContainText(
    'Waste and stock differences come with stock counts.',
  )
  await expect(part('running')).toContainText('AED 20,000.00')
  await expect(owner.locator(`[data-profit-month="${last}"]`)).toContainText(
    `${monthName(last)}: its costs AED 20,000.00 ÷ its sales AED 80,000.00 = 25% of each sale's price.`,
  )
  await expect(owner.locator('[data-completeness]')).toContainText(
    '90% of sales have complete costs.',
  )
  await expect(owner.locator('[data-missing="no_recipe"]')).toContainText(
    'No recipe yet: AED 8,000.00 of sales',
  )
  const rows = owner.locator('[data-profit-groups] [data-profit-group]')
  await expect(rows).toHaveCount(2)
  await expect(rows.first()).toContainText('Spanish Latte')
  await expect(rows.first()).toContainText('4,000 pieces')
  await expect(rows.nth(1)).toContainText('Not complete')
  // No branches: no "Branch" to group by.
  await expect(owner.locator('[data-group-by="branch"]')).toHaveCount(0)
  await expectSound(owner, 'en')
  await shot(owner, 'profit-en-1440-last-month')

  // Sorted by margin (the owner sees profit), and only what sold at a low margin: none.
  await owner.getByLabel('Sort by').selectOption('margin_percent_asc')
  await expect(owner).toHaveURL(/sort=margin_percent_asc/)
  await owner.getByLabel('Show').selectOption('low_margin')
  await expect(owner.getByRole('heading', { name: 'Nothing matches in these days' })).toBeVisible()

  // Product costs: the latte's share is live, at last month's rate until this month ends.
  await owner.goto(`/b/${businessId}/product-costs`)
  await owner.locator('[data-product-cost-row="Spanish Latte"]').first().click()
  await expect(owner.locator('[data-line="running"] [data-share]')).toHaveText(
    `AED 4.50 · 25% of its price (${monthName(last)})`,
  )
  await expect(owner.locator('[data-line="running"] [data-basis]')).toHaveText(
    `At ${monthName(last, false)}'s rate until ${monthName(today.slice(0, 7), false)} ends.`,
  )
  // Margins after running costs: 18.00 − 1.20 − 4.50 = 12.30.
  await expect(owner.locator('[data-line="margin"]')).toContainText('AED 12.30')
  await expect(owner.locator('[data-line="margin"]')).not.toContainText('before running costs')
  await expectSound(owner, 'en')
  await shot(owner, 'profit-en-1440-product-cost')

  // The Dashboard's cards: this month so far.
  await owner.goto(`/b/${businessId}`)
  const cards = owner.locator('[data-decision-cards]')
  await expect(cards.locator('[data-card="sales"]')).toContainText('AED 180.00')
  await expect(cards.locator('[data-card="sales"]')).toContainText('Last month: AED 80,000.00')
  await expect(cards.locator('[data-card="profit"]')).toBeVisible()
  // The month's running costs so far, said under the figure (D-250).
  await expect(cards.locator('[data-card="profit"] [data-costs-so-far]')).toContainText(
    /^Running costs so far: AED\s[\d,]+\.\d\d$/,
  )
  await expect(
    cards.locator('[data-card="money-went"] [data-money-part="materials"]'),
  ).toContainText('AED 12.00')
  await expect(
    cards.locator('[data-card="by-day"] svg[data-chart="sales-profit"][data-direction="ltr"]'),
  ).toBeVisible()
  await expect(cards.locator('[data-card="top-products"]')).toContainText('Spanish Latte')
  // A margin is said as one (D-250).
  await expect(cards.locator('[data-card="top-products"]')).toContainText(/Margin \d+%/)
  await expectSound(owner, 'en')
  await shot(owner, 'profit-en-1440-dashboard')
})

test('the same owner in Arabic on a phone: the cards, the chart mirrored, and Real profit by day', async () => {
  test.setTimeout(600_000)
  const today = await todayOf(owner, businessId)
  await view(owner, `/b/${businessId}`, 'ar', PHONE)
  const cards = owner.locator('[data-decision-cards]')
  await expect(cards.locator('[data-card="sales"]')).toContainText('المبيعات')
  await expect(cards.locator('[data-card="sales"]')).toContainText(/180\.00[\s‎‏]*د\.إ\./)
  // The chart: the first day at the right (mirrored), and every day in a table for screen readers.
  const chart = cards.locator('[data-card="by-day"]')
  await expect(
    chart.getByRole('heading', { name: 'المبيعات والربح الحقيقي حسب اليوم' }),
  ).toBeVisible()
  const svg = chart.locator('svg[data-chart="sales-profit"]')
  await expect(svg).toHaveAttribute('data-direction', 'rtl')
  const day = Number(today.slice(8, 10))
  await expect(chart.locator('table tbody tr')).toHaveCount(day)
  await expect(chart.locator('table caption')).toHaveText('أرقام كل يوم')
  const todayBar = svg.locator(`[data-day-bar="${today}"]`)
  const box = await svg.boundingBox()
  const bar = await todayBar.boundingBox()
  expect(box && bar).toBeTruthy()
  // Today is the last day so far: at the left end of the chart in Arabic (when it is not the 1st).
  if (day > 1) expect(bar!.x + bar!.width / 2).toBeLessThan(box!.x + box!.width / 2)
  // "Let's calculate your first real profit", with its sales steps done.
  const steps = owner.locator('[data-cost-checklist]')
  await expect(steps.getByRole('heading', { name: 'لنحسب ربحك الحقيقي الأول' })).toBeVisible()
  await expect(steps.locator('[data-cost-step="sales"][data-done]')).toBeVisible()
  await expect(steps.locator('[data-cost-step="real_profit"][data-done]')).toBeVisible()
  await expectSound(owner, 'ar')
  await shot(owner, 'profit-ar-390-dashboard')

  await owner.goto(`/b/${businessId}/reports/profit?by=day`)
  await expect(owner.getByRole('heading', { level: 1, name: 'الربح الحقيقي' })).toBeVisible()
  await expect(owner.locator(`[data-profit-group="${today}"]`)).toBeVisible()
  await expect(owner.locator('[data-part="running"]')).toContainText('المصاريف التشغيلية')
  await expect(owner.locator(`[data-profit-month="${today.slice(0, 7)}"]`)).toContainText(
    'حتى نهاية',
  )
  await expectSound(owner, 'ar')
  await shot(owner, 'profit-ar-390-by-day')
})

test('an employee sees no profit: no cards, no Real profit, its address not open to them', async ({
  browser,
}) => {
  test.setTimeout(600_000)
  const barista = await createUser('profit-employee', { locale: 'en' })
  users.push(barista)
  const page = await openAs(browser, barista, PHONE, 'en', 'Laila')
  await joinBusiness(owner, businessId, page, barista, 'employee')

  await page.goto(`/b/${businessId}`)
  await expect(page.getByRole('heading', { level: 1, name: 'Corner Cafe' })).toBeVisible()
  await expect(page.locator('[data-decision-cards]')).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Real profit' })).toHaveCount(0)
  await expectSound(page, 'en')
  await shot(page, 'profit-en-390-employee-dashboard')
  await page.goto(`/b/${businessId}/reports/profit`)
  await expect(page.getByRole('heading', { name: "This page isn't open to you" })).toBeVisible()
  await expect(page.locator('[data-profit-summary]')).toHaveCount(0)

  await view(page, `/b/${businessId}`, 'ar', DESKTOP)
  await expect(page.getByRole('navigation', { name: 'القائمة الرئيسية' })).toBeVisible()
  await expect(
    page
      .getByRole('navigation', { name: 'القائمة الرئيسية' })
      .getByRole('link', { name: 'الربح الحقيقي' }),
  ).toHaveCount(0)
  await expect(page.locator('[data-decision-cards]')).toHaveCount(0)
  await page.goto(`/b/${businessId}/reports/profit`)
  await expect(page.getByRole('heading', { name: 'هذه الصفحة غير متاحة لك' })).toBeVisible()
  await expectSound(page, 'ar')
  await shot(page, 'profit-ar-1440-employee')
})

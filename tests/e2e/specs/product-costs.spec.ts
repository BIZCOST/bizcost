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
  setLanguage,
  signIn,
  useLanguage,
  type TestUser,
} from '../helpers'
import { previewBaseURL } from '../stack'

// Product costs (ROADMAP.md M2 Step 6; D-115, D-116, D-119, D-178), on the development server with
// the dev-only preview (D-125; the `preview` project of playwright.config.ts).
//
// A café with a team (VAT-registered) sells the owner's Spanish Latte (its materials cost
// 3.002034632035 from real purchases), an espresso and a latte-art class (a service with no
// materials). Its running costs are AED 15,000 a month (rent 12,000 + electricity 3,000). In English
// on a desktop, the owner sees the running costs "not in your product costs yet", sets about AED
// 30,000 of materials a month in Settings (leaving out the VAT she gets back), and reads the rule,
// then why (every AED 1 of materials adds AED 0.50; running costs of AED 15,000 over AED 30,000); the
// latte costs 4.503051948053 (AED 4.50) and keeps 13.496948051947 (75.0%), sorted and shown by what
// needs a look in the table; its breakdown says each part in words and lists each material with its
// average and its last purchase cost; with its price including VAT, the margin is on AED 17.14. The
// service says it carries no running costs yet (a known limit until Phase 5), never 0. A catering
// tray in the thousands (AED 12,500) shows that no amount runs into another, at 375 and 1280 px in
// both languages (D-186). The same pages in Arabic and on a phone, where "How your costs are worked
// out" folds to one line. An employee (the template) has no Product costs; once the owner gives the
// role "see product costs", the employee sees names and prices with locks, and no sort by cost (the
// API refuses it). A home baker who works alone (Arabic, phone) sets her estimate (AED 2,000) and
// her hourly rate (AED 45), and 10 minutes on the cake: one slice of a cake that makes 12 costs
// 1.075 of materials + 0.295625 of running costs (550 ÷ 2,000) + 7.5 of her time = 8.870625, AED
// 6.13 kept from AED 15 (40.9%); a pie with none of her time says so on its row.

test.describe.configure({ mode: 'serial' })

const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1440, height: 900 }

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

const RAW_KEY =
  /\b(?:common|catalog|units|errors|nav|modules|purchasing|settings|costing)\.[a-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+/

const users: TestUser[] = []
const contexts: BrowserContext[] = []
let cafe: { page: Page; businessId: string; latteId: string } | undefined

test.afterAll(async () => {
  for (const context of contexts) await context.close()
  for (const user of users) await deleteUser(user.id)
})

async function open(
  browser: Browser,
  viewport: { width: number; height: number },
  locale: 'en' | 'ar',
  user?: TestUser,
): Promise<{ page: Page; user: TestUser }> {
  const who = user ?? (await createUser(`costs-${locale}`, { locale: 'en' }))
  if (!user) users.push(who)
  const context = await browser.newContext({
    baseURL: previewBaseURL,
    locale: locale === 'ar' ? 'ar-AE' : 'en-US',
    viewport,
  })
  contexts.push(context)
  // The development server's own badge and overlay are not part of the app.
  await context.addInitScript(() => {
    const sheet = new CSSStyleSheet()
    sheet.replaceSync('[data-nextjs-dev-overlay] { display: none !important; }')
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
  })
  await useLanguage(context, 'en')
  const page = await context.newPage()
  await signIn(page, who)
  if (locale === 'ar') await setLanguage(page, 'ar')
  return { page, user: who }
}

/** Screenshots into E2E_SHOTS_DIR (only when it is set), named costs-*. */
async function shot(page: Page, name: string) {
  const dir = process.env.E2E_SHOTS_DIR
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(dir, `costs-${name}.png`), fullPage: true })
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

/**
 * No amount runs out of its place or into another (D-186): each figure's amounts stay inside the
 * figure, and the figures of one card or summary never overlap.
 */
async function expectFiguresFit(page: Page) {
  const problems = await page.evaluate(() => {
    const found: string[] = []
    const inside = (inner: DOMRect, outer: DOMRect) =>
      inner.left >= outer.left - 1 && inner.right <= outer.right + 1
    const boxes = (root: Element, selector: string) =>
      [...root.querySelectorAll(selector)].map((el) => ({
        el,
        rect: el.getBoundingClientRect(),
      }))
    const groups = [
      ...document.querySelectorAll('[data-product-cost-row]'),
      ...document.querySelectorAll('section'),
    ]
    for (const group of groups) {
      const figures = boxes(group, ':scope [data-figure], :scope [data-summary]').filter(
        (f) => f.rect.width > 0,
      )
      for (const figure of figures) {
        for (const amount of figure.el.querySelectorAll('bdi')) {
          const rect = amount.getBoundingClientRect()
          if (rect.width > 0 && !inside(rect, figure.rect)) {
            found.push(
              `${amount.textContent} out of ${figure.el.getAttribute('data-figure') ?? figure.el.getAttribute('data-summary')}`,
            )
          }
        }
      }
      for (let i = 0; i < figures.length; i++) {
        for (let j = i + 1; j < figures.length; j++) {
          const a = figures[i]!.rect
          const b = figures[j]!.rect
          const overlap =
            Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
            Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1
          if (overlap && !figures[i]!.el.contains(figures[j]!.el)) {
            found.push(`${figures[i]!.el.textContent} over ${figures[j]!.el.textContent}`)
          }
        }
      }
    }
    return found
  })
  expect(problems).toEqual([])
}

/** `text`, allowing the marks Intl puts around Arabic amounts (RLM, LRM) and any kind of space. */
function loose(text: string): RegExp {
  return new RegExp(
    [...text]
      .map((char) => (/\s/.test(char) ? '\\s+' : char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('[\\u200e\\u200f]*'),
  )
}

async function ok<T>(pending: Promise<{ data?: T; appCode?: string }>, what: string): Promise<T> {
  const result = await pending
  expect(result.appCode, what).toBeUndefined()
  return result.data as T
}

async function material(
  page: Page,
  businessId: string,
  name: string,
  unit: string,
  packs: object[] = [],
): Promise<string> {
  const id = randomUUID()
  await ok(callApi(page, 'material.create', { id, name, unit, packs }, { businessId }), name)
  return id
}

async function today(page: Page, businessId: string): Promise<string> {
  return (
    await ok(
      callApi<{ today: string }>(page, 'books.get', {}, { businessId, query: true }),
      'books.get',
    )
  ).today
}

/** A final purchase with no VAT on it (a no-invoice receipt), dated today. */
async function buy(page: Page, businessId: string, lines: object[]) {
  const id = randomUUID()
  const draft = await ok(
    callApi<{ data: { version: number } }>(
      page,
      'purchase.create',
      {
        id,
        businessDate: await today(page, businessId),
        documentType: 'no_invoice',
        paymentMethod: 'cash',
        lines: lines.map((line) => ({ kind: 'material', id: randomUUID(), vatRate: '0', ...line })),
      },
      { businessId },
    ),
    'purchase.create',
  )
  await ok(
    callApi(page, 'purchase.post', { id, version: draft.data.version }, { businessId }),
    'purchase.post',
  )
}

async function product(page: Page, businessId: string, input: object): Promise<string> {
  const id = randomUUID()
  await ok(
    callApi(
      page,
      'product.create',
      { id, type: 'product', unit: 'piece', ...input },
      { businessId },
    ),
    'product.create',
  )
  return id
}

async function recipe(
  page: Page,
  businessId: string,
  productId: string,
  lines: { materialId: string; qty: string; unit: string }[],
  yieldQty?: string,
) {
  await ok(
    callApi(
      page,
      'recipe.save',
      {
        productId,
        version: 0,
        lines: lines.map((line) => ({ id: randomUUID(), ...line })),
        ...(yieldQty ? { yieldQty } : {}),
      },
      { businessId },
    ),
    'recipe.save',
  )
}

/** Running costs paid from the first of this month, in the business's first category. */
async function runningCosts(
  page: Page,
  businessId: string,
  costs: { name: string; amount: string; frequency: string }[],
) {
  const categories = await ok(
    callApi<{ items: { id: string }[] }>(
      page,
      'costCategory.list',
      {},
      { businessId, query: true },
    ),
    'costCategory.list',
  )
  const categoryId = categories.items[0]?.id
  if (!categoryId) throw new Error('no cost category')
  const startsOn = `${(await today(page, businessId)).slice(0, 8)}01`
  for (const cost of costs) {
    await ok(
      callApi(
        page,
        'runningCost.create',
        { id: randomUUID(), categoryId, startsOn, ...cost },
        { businessId },
      ),
      cost.name,
    )
  }
}

interface Breakdown {
  data: {
    cost: {
      materials: string | null
      runningCosts: { state: string; share: string | null }
      ownerTime: { state: string; minutes: string | null; amount: string | null }
      total: string | null
      complete: boolean
      reasons: string[]
    }
    margin: { amount: string | null; percent: string | null }
    price: { beforeVat: string | null }
    rate: { state: string; rate: string | null }
  }
}

async function breakdownOf(page: Page, businessId: string, productId: string) {
  return (
    await ok(
      callApi<Breakdown>(page, 'productCost.get', { productId }, { businessId, query: true }),
      'productCost.get',
    )
  ).data
}

test('English, desktop: a café sees what the Spanish Latte really costs and keeps', async ({
  browser,
}) => {
  test.setTimeout(600_000)
  const { page } = await open(browser, DESKTOP, 'en')
  const businessId = await createBusiness(page, 'Moon Café', CAFE_ANSWERS)
  const bag = randomUUID()
  const beans = await material(page, businessId, 'Coffee beans', 'kg', [
    { id: bag, name: 'bag', qty: '1', ofUnit: 'kg' },
  ])
  const bottle = randomUUID()
  const carton = randomUUID()
  const milk = await material(page, businessId, 'Milk', 'l', [
    { id: bottle, name: 'bottle', qty: '1', ofUnit: 'l' },
    { id: carton, name: 'carton', qty: '12', ofPackId: bottle },
  ])
  const can = randomUUID()
  const box = randomUUID()
  const condensed = await material(page, businessId, 'Condensed milk', 'l', [
    { id: can, name: 'can', qty: '385', ofUnit: 'ml' },
    { id: box, name: 'box', qty: '24', ofPackId: can },
  ])
  const sleeve = randomUUID()
  const cup = await material(page, businessId, 'Cup', 'piece', [
    { id: sleeve, name: 'sleeve', qty: '50', ofUnit: 'piece' },
  ])
  const lidBox = randomUUID()
  const lid = await material(page, businessId, 'Lid', 'piece', [
    { id: lidBox, name: 'box', qty: '100', ofUnit: 'piece' },
  ])
  const strawPack = randomUUID()
  const straw = await material(page, businessId, 'Straw', 'piece', [
    { id: strawPack, name: 'pack', qty: '200', ofUnit: 'piece' },
  ])
  // What the café paid (as in recipes.spec.ts), straws included: the latte's materials cost
  // 1.17 + 1.20 + 0.257034632035 + 0.25 + 0.09 + 0.035 = 3.002034632035.
  await buy(page, businessId, [
    { materialId: beans, qty: '2', packId: bag, unitPrice: '65' },
    { materialId: milk, qty: '1', packId: carton, unitPrice: '72' },
    { materialId: condensed, qty: '1', packId: box, unitPrice: '95' },
    { materialId: cup, qty: '2', packId: sleeve, unitPrice: '12.5' },
    { materialId: lid, qty: '1', packId: lidBox, unitPrice: '9' },
    { materialId: straw, qty: '1', packId: strawPack, unitPrice: '7' },
  ])
  const latteId = await product(page, businessId, { name: 'Spanish Latte', defaultPrice: '18' })
  await recipe(page, businessId, latteId, [
    { materialId: beans, qty: '18', unit: 'g' },
    { materialId: milk, qty: '200', unit: 'ml' },
    { materialId: condensed, qty: '25', unit: 'ml' },
    { materialId: cup, qty: '1', unit: 'piece' },
    { materialId: lid, qty: '1', unit: 'piece' },
    { materialId: straw, qty: '1', unit: 'piece' },
  ])
  // An espresso: 18 g of beans, a cup and a lid = 1.51 of materials, at AED 12.
  const espressoId = await product(page, businessId, { name: 'Espresso', defaultPrice: '12' })
  await recipe(page, businessId, espressoId, [
    { materialId: beans, qty: '18', unit: 'g' },
    { materialId: cup, qty: '1', unit: 'piece' },
    { materialId: lid, qty: '1', unit: 'piece' },
  ])
  // A service that uses no materials.
  await product(page, businessId, {
    name: 'Latte art class',
    type: 'service',
    unit: 'h',
    defaultPrice: '150',
  })
  // A catering tray in the thousands: 20 kg of beans (AED 1,300), sold at AED 12,500.
  const trayId = await product(page, businessId, { name: 'Catering tray', defaultPrice: '12500' })
  await recipe(page, businessId, trayId, [{ materialId: beans, qty: '20', unit: 'kg' }])
  await runningCosts(page, businessId, [
    { name: 'Rent', amount: '12000', frequency: 'monthly' },
    { name: 'Electricity', amount: '3000', frequency: 'monthly' },
  ])
  cafe = { page, businessId, latteId }

  // Products & Services leads to Product costs.
  await page.goto(`/b/${businessId}/products`)
  await page.getByRole('link', { name: 'See product costs' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Product costs')
  const nav = page.getByRole('navigation', { name: 'Main' })
  await expect(nav.getByRole('link', { name: 'Product costs' })).toHaveAttribute(
    'aria-current',
    'page',
  )
  // Running costs are not in the costs yet: the page says so, and how to add them.
  const how = page.getByRole('region', { name: 'How your costs are worked out' })
  await expect(how.locator('[data-how="running"]')).toContainText(
    "Your running costs (AED 15,000 a month) aren't in your product costs yet: BizCost needs to know about how much you buy in materials a month.",
  )
  await expect(how.locator('[data-how="materials"]')).toContainText('Materials: the average')
  const latteRow = page.locator('[data-product-cost-row="Spanish Latte"]')
  await expect(latteRow.locator('[data-figure="cost"]')).toContainText(/AED\s3\.00/)
  await expect(latteRow.locator('[data-figure="cost"]')).toContainText('incomplete')
  await expect(latteRow.locator('[data-reasons]')).toHaveText('Running costs not added yet')
  await expectSound(page, 'en')
  await shot(page, 'en-1440-costs-not-set')

  // Settings: about AED 30,000 of materials a month.
  await how.getByRole('link', { name: 'Set your monthly purchases' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('How costs are worked out')
  // A café with a team: no "Your time".
  await expect(page.getByRole('heading', { name: 'Your time' })).toHaveCount(0)
  const estimate = page.getByRole('textbox', {
    name: 'About how much do you buy in materials a month?',
  })
  // VAT-registered: the VAT she gets back is left out.
  await expect(estimate).toHaveAccessibleDescription(/Leave out the VAT you get back/)
  await estimate.fill('0')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Enter a number more than zero.')).toBeVisible()
  await estimate.fill('30,000')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Saved.')).toBeVisible()
  const now = page.locator('[data-rate-now]')
  // The rule first, then why (D-186).
  await expect(now.locator('[data-rule]')).toHaveText(
    'Every AED 1 you spend on materials adds AED 0.50 of running costs (50% of the materials).',
  )
  await expect(now.locator('[data-why]')).toHaveText(
    'Why: your running costs are AED 15,000 a month and you buy about AED 30,000 of materials a month.',
  )
  await expect(now).toContainText('BizCost uses your estimate until you have 3 full months')
  await expectSound(page, 'en')
  await shot(page, 'en-1440-settings')

  // The list: a table, the latte's full cost and margin (the API keeps them exact).
  await nav.getByRole('link', { name: 'Product costs' }).click()
  await expect(how.locator('[data-how="running"] [data-rule]')).toHaveText(
    'Every AED 1 you spend on materials adds AED 0.50 of running costs (50% of the materials).',
  )
  const table = page.getByRole('table', { name: 'Product costs' })
  await expect(table).toBeVisible()
  await expect(latteRow.locator('[data-figure="price"]')).toHaveText(/^AED\s18\.00$/)
  await expect(latteRow.locator('[data-figure="cost"]')).toHaveText(/^AED\s4\.50$/)
  await expect(latteRow.locator('[data-figure="margin"]')).toHaveText(/^AED\s13\.50$/)
  await expect(latteRow.locator('[data-figure="percent"]')).toHaveText('75.0%')
  // The service: no share of running costs yet, never 0.
  const classRow = page.locator('[data-product-cost-row="Latte art class"]')
  await expect(classRow.locator('[data-reasons]')).toContainText(
    'No share of running costs yet: it uses no materials',
  )
  await expect(classRow.locator('[data-figure="cost"]')).toHaveText('Not worked out yet')
  await expect(classRow.locator('[data-figure="margin"]')).toHaveText('—')
  const latte = await breakdownOf(page, businessId, latteId)
  expect(latte.cost).toMatchObject({
    materials: '3.002034632035',
    runningCosts: { state: 'applied', share: '1.501017316018' },
    total: '4.503051948053',
    complete: true,
    reasons: [],
  })
  expect(latte.margin).toEqual({ amount: '13.496948051947', percent: '74.983044733039' })
  expect(latte.rate).toMatchObject({ state: 'ready', rate: '0.5' })
  await expectSound(page, 'en')
  await shot(page, 'en-1440-product-costs')

  await expectFiguresFit(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await expectFiguresFit(page)
  await page.setViewportSize(DESKTOP)

  // Sorted by name, then by margin %, the lowest first (the service has none: last).
  const names = table.locator('tbody tr [dir="auto"]')
  await expect(names).toHaveText(['Catering tray', 'Espresso', 'Latte art class', 'Spanish Latte'])
  await table.getByRole('button', { name: 'Margin %' }).click()
  await expect(page).toHaveURL(/sort=margin_percent/)
  await expect(names).toHaveText(['Spanish Latte', 'Espresso', 'Catering tray', 'Latte art class'])
  await expect(table.getByRole('columnheader', { name: 'Margin %' })).toHaveAttribute(
    'aria-sort',
    'ascending',
  )
  await page.getByLabel('Sort by').selectOption({ label: 'Highest cost first' })
  await expect(names).toHaveText(['Catering tray', 'Spanish Latte', 'Espresso', 'Latte art class'])
  // What needs a look, with how many: one incomplete, nothing sold at a loss.
  await expect(page.locator('[data-attention]')).toContainText('Needs a look:')
  await expect(page.locator('[data-attention] button')).toHaveText(['Incomplete (1)'])
  const show = page.getByLabel('Show')
  await expect(show.locator('option')).toHaveText([
    'In use',
    'Incomplete (1)',
    'Sold at a loss (0)',
    'Archived',
    'All',
  ])
  await page.locator('[data-attention-item="incomplete"]').click()
  await expect(names).toHaveText(['Latte art class'])
  await expect(show).toHaveValue('incomplete')
  await show.selectOption('loss')
  await expect(page.getByText('Nothing here is sold at a loss.')).toBeVisible()
  await show.selectOption('active')
  await expect(names).toHaveCount(4)

  // The latte's breakdown, part by part, in words.
  await latteRow.getByRole('link').click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Spanish Latte')
  await expect(page.locator('[data-summary="cost"]')).toContainText(/Cost per piece\s*AED\s4\.50/)
  await expect(page.locator('[data-summary="margin"]')).toContainText(
    /Margin per piece\s*AED\s13\.50\s*75\.0% of the price/,
  )
  const lines = page.locator('[data-line]')
  await expect(page.locator('[data-line="materials"]')).toContainText(
    /Ingredients & supplies\s*AED\s3\.00/,
  )
  const running = page.locator('[data-line="running"]')
  await expect(running).toContainText(/Running costs\s*AED\s1\.50/)
  await expect(running.locator('[data-rate]')).toHaveText(
    'Every AED 1 you spend on materials adds AED 0.50 of running costs (50% of the materials).',
  )
  await expect(running.locator('[data-why]')).toHaveText(
    'Why: your running costs are AED 15,000 a month and you buy about AED 30,000 of materials a month.',
  )
  await expect(running.locator('[data-share]')).toHaveText(
    'Its materials cost AED 3.00, so AED 1.50 of running costs is added to it.',
  )
  // A team: no time line.
  await expect(page.locator('[data-line="time"]')).toHaveCount(0)
  await expect(page.locator('[data-line="total"]')).toContainText(/Cost per piece\s*AED\s4\.50/)
  await expect(page.locator('[data-line="margin"]')).toContainText(/AED\s13\.50\s*75\.0%/)
  await expect(lines).toHaveCount(5)
  // Each material: how much, its average, the line's cost and its last purchase cost.
  const beansLine = page.locator('[data-material-line="Coffee beans"]:visible')
  await expect(beansLine).toContainText('18 g')
  await expect(beansLine).toContainText(/AED\s65\.00\sper\skg/)
  await expect(beansLine).toContainText(/AED\s1\.17/)
  await expect(page.locator('[data-material-line]:visible')).toHaveCount(6)
  await expect(page.getByText('Average costs come from your purchases from')).toBeVisible()
  await expectSound(page, 'en')
  await shot(page, 'en-1440-latte-breakdown')

  // Its price includes VAT (edited from here): the margin is on AED 17.14.
  await page.getByRole('button', { name: 'Edit product' }).click()
  const sheet = page.getByRole('dialog')
  await sheet.getByRole('switch', { name: 'The price includes VAT' }).click()
  await sheet.getByRole('button', { name: 'Save changes' }).click()
  await expect(sheet).toHaveCount(0)
  await expect(page.locator('[data-at-price]')).toHaveText(
    /At your price of AED\s18\.00, which is AED\s17\.14 before VAT\./,
  )
  await expect(page.locator('[data-summary="margin"]')).toContainText(
    /AED\s12\.64\s*73\.7% of the price before VAT/,
  )
  await expect(page.locator('[data-line="price"]')).toContainText(/Price before VAT\s*AED\s17\.14/)
  const withVat = await breakdownOf(page, businessId, latteId)
  expect(withVat.price.beforeVat).toBe('17.142857142857')
  expect(withVat.margin).toEqual({ amount: '12.639805194804', percent: '73.732196969691' })
  await expectSound(page, 'en')
  await shot(page, 'en-1440-latte-breakdown-vat')

  // A phone: the list as cards, the breakdown stacked.
  await page.setViewportSize(PHONE)
  await expect(page.locator('[data-material-line="Coffee beans"]:visible')).toContainText('18 g')
  await expectSound(page, 'en')
  await shot(page, 'en-390-latte-breakdown')
  await page.goto(`/b/${businessId}/product-costs`)
  await expect(page.getByRole('table')).toHaveCount(0)
  const card = page.locator('[data-product-cost-row="Spanish Latte"]')
  await expect(card.locator('[data-figure="cost"]')).toContainText(/AED\s4\.50/)
  await expect(card.locator('[data-figure="price"]')).toContainText(/AED\s17\.14 before VAT/)
  await expect(card.locator('[data-figure="margin"]')).toContainText(/AED\s12\.64\s*73\.7%/)
  // On a phone, how costs are worked out folds to one line, a tap away.
  const folded = page.locator('[data-how-folded]')
  await expect(folded).toContainText('Running costs add 50% to the cost of materials.')
  await expectSound(page, 'en')
  await shot(page, 'en-390-product-costs')
  // Amounts in the thousands at 375 px: nothing runs into anything, in the list and the breakdown.
  await page.setViewportSize({ width: 375, height: 812 })
  await expect(
    page.locator('[data-product-cost-row="Catering tray"] [data-figure="price"]'),
  ).toContainText(/AED\s12,500\.00/)
  await expectFiguresFit(page)
  await expectSound(page, 'en')
  await page.locator('[data-product-cost-row="Catering tray"]').click()
  await expect(page.locator('[data-summary="margin"]')).toContainText(/AED\s10,550\.00/)
  await expectFiguresFit(page)
  await expectSound(page, 'en')
  await shot(page, 'en-375-tray-breakdown')
  await page.setViewportSize({ width: 1280, height: 900 })
  await expectFiguresFit(page)
  await shot(page, 'en-1280-tray-breakdown')
})

test('Arabic, phone and desktop: the café reads its product costs', async () => {
  test.setTimeout(600_000)
  if (!cafe) throw new Error('the first test makes the café')
  const { page, businessId, latteId } = cafe
  await setLanguage(page, 'ar')
  await page.setViewportSize(PHONE)
  await page.goto(`/b/${businessId}/product-costs`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('تكاليف المنتجات')
  // Folded to one line on a phone; "How?" opens it.
  await expect(page.locator('[data-how-folded]')).toContainText('المصاريف التشغيلية تضيف 50')
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-product-costs')
  await page.getByRole('button', { name: 'كيف؟' }).click()
  const how = page.getByRole('region', { name: 'كيف تُحسب تكاليفك' })
  await expect(how.locator('[data-how="running"] [data-rule]')).toContainText(
    loose('كل 1 د.إ. تصرفه على المواد يُضاف إليه 0.50 د.إ. من المصاريف التشغيلية'),
  )
  await expect(how.locator('[data-how="running"] [data-why]')).toContainText(
    loose('لأن مصاريفك التشغيلية 15,000 د.إ. في الشهر، وتشتري مواد بحوالي 30,000 د.إ. في الشهر.'),
  )
  await page.getByRole('button', { name: 'إخفاء التفاصيل' }).click()
  await expect(page.locator('[data-how-folded]')).toBeVisible()
  const card = page.locator('[data-product-cost-row="Spanish Latte"]')
  await expect(card.locator('[data-figure="cost"]')).toContainText('4.50')
  await expect(card.locator('[data-figure="margin"]')).toContainText('12.64')
  const classCard = page.locator('[data-product-cost-row="Latte art class"]')
  await expect(classCard.locator('[data-reasons]')).toContainText(
    'لا نصيب له من المصاريف التشغيلية بعد: لا يستخدم مواد',
  )
  await expectFiguresFit(page)
  await expectSound(page, 'ar')
  await page.setViewportSize({ width: 375, height: 812 })
  await expectFiguresFit(page)
  await expectSound(page, 'ar')
  await page.setViewportSize(PHONE)

  await card.click()
  await expect(page.locator('[data-summary="cost"]')).toContainText('التكلفة لكل قطعة')
  await expect(page.locator('[data-line="running"] [data-share]')).toContainText(
    loose('مواده تكلف 3.00 د.إ. لذلك يُضاف إليه 1.50 د.إ. من المصاريف التشغيلية.'),
  )
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-latte-breakdown')

  // The service's breakdown: no running costs until working time comes (never 0).
  await page.goto(`/b/${businessId}/product-costs`)
  await classCard.click()
  const running = page.locator('[data-line="running"]')
  await expect(running).toContainText('لم تُحسب بعد')
  await expect(running).toContainText('لا نصيب له من المصاريف التشغيلية بعد: لا يستخدم مواد')
  // A service may use no materials: none, never "not counted"; adding some is optional.
  await expect(page.locator('[data-line="materials"]')).toContainText('لا يستخدم مواد.')
  await expect(page.locator('[data-reason="no_recipe"]')).toContainText(
    'إن كان يستخدم مواد، أضفها لتُحسب تكلفتها.',
  )
  // Why, in words, with what is missing.
  await expect(page.locator('[data-reason="running_costs_need_materials"]')).toContainText(
    'سيأتي لاحقًا توزيعها حسب وقت العمل',
  )
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-service-breakdown')

  // The tray's breakdown in the thousands, at 375 and 1280 px.
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto(`/b/${businessId}/product-costs`)
  await page.locator('[data-product-cost-row="Catering tray"]').click()
  await expect(page.locator('[data-summary="margin"]')).toContainText('10,550.00')
  await expectFiguresFit(page)
  await expectSound(page, 'ar')
  await page.setViewportSize({ width: 1280, height: 900 })
  await expectFiguresFit(page)
  await expectSound(page, 'ar')

  await page.setViewportSize(DESKTOP)
  await page.goto(`/b/${businessId}/product-costs`)
  await expect(page.getByRole('table', { name: 'تكاليف المنتجات' })).toBeVisible()
  await expectFiguresFit(page)
  await expectSound(page, 'ar')
  await shot(page, 'ar-1440-product-costs')
  await page.goto(`/b/${businessId}/product-costs/${latteId}`)
  await expect(page.locator('[data-material-line="Coffee beans"]:visible')).toContainText('غرام')
  await expectSound(page, 'ar')
  await shot(page, 'ar-1440-latte-breakdown')
  await page.goto(`/b/${businessId}/settings/costing`)
  await expect(page.locator('[data-rate-now]')).toContainText('مصاريفك التشغيلية')
  await expectSound(page, 'ar')
  await shot(page, 'ar-1440-settings')
  await page.setViewportSize(PHONE)
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-settings')
})

test('an employee: no Product costs by the template; with the page, locks and no sort by cost', async ({
  browser,
}) => {
  test.setTimeout(600_000)
  if (!cafe) throw new Error('the first test makes the café')
  const { page: ownerPage, businessId, latteId } = cafe
  const roles = await ok(
    callApi<
      { id: string; templateKey: string | null; version: number; permissionKeys: string[] }[]
    >(ownerPage, 'role.list', {}, { businessId, query: true }),
    'role.list',
  )
  const employeeRole = roles.find((role) => role.templateKey === 'employee')
  if (!employeeRole) throw new Error('no Employee role')
  expect(employeeRole.permissionKeys).not.toContain('cost_engine.product_costs.view')
  const employee = await createUser('costs-employee')
  users.push(employee)
  await ok(
    callApi(
      ownerPage,
      'invitation.create',
      { id: randomUUID(), email: employee.email, roleId: employeeRole.id, locale: 'en' },
      { businessId },
    ),
    'invitation.create',
  )
  const { token } = await nextInvitation(employee.email)
  const { page } = await open(browser, PHONE, 'ar', employee)
  await ok(callApi(page, 'invitation.accept', { token }), 'invitation.accept')

  // The template: no Product costs anywhere, and the page is not open to them.
  await page.goto(`/b/${businessId}/products`)
  await expect(page.getByRole('link', { name: 'اعرض تكاليف المنتجات' })).toHaveCount(0)
  await page.goto(`/b/${businessId}/product-costs`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('هذه الصفحة غير متاحة لك')
  expect((await callApi(page, 'productCost.list', {}, { businessId, query: true })).appCode).toBe(
    'forbidden',
  )

  // The owner gives the role "see product costs" (as the Roles editor does).
  await ok(
    callApi(
      ownerPage,
      'role.updatePermissions',
      {
        id: employeeRole.id,
        version: employeeRole.version,
        permissionKeys: [...employeeRole.permissionKeys, 'cost_engine.product_costs.view'],
      },
      { businessId },
    ),
    'role.updatePermissions',
  )
  await page.goto(`/b/${businessId}/product-costs`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('تكاليف المنتجات')
  await expect(page.locator('[data-costs-hidden]')).toHaveText(
    'دورك لا يعرض التكاليف ولا هوامش الربح. يمكنك رؤية الأسماء والأسعار.',
  )
  // No way worked out is shown (it is made of costs), and no sort or filter on them.
  await expect(page.getByRole('region', { name: 'كيف تُحسب تكاليفك' })).toHaveCount(0)
  await expect(page.getByLabel('رتّب حسب').locator('option')).toHaveText([
    'الاسم، من أ إلى ي',
    'الاسم، من ي إلى أ',
    'الأعلى سعرًا أولًا',
    'الأقل سعرًا أولًا',
  ])
  await expect(page.getByLabel('اعرض').locator('option')).toHaveText([
    'قيد الاستخدام',
    'المؤرشفة',
    'الكل',
  ])
  await expect(page.locator('[data-attention]')).toHaveCount(0)
  const card = page.locator('[data-product-cost-row="Spanish Latte"]')
  await expect(card.locator('[data-figure="price"]')).toContainText('18.00')
  await expect(card.locator('[data-figure="cost"] [data-locked="cost"]')).toHaveCount(1)
  await expect(card.locator('[data-figure="margin"] [data-locked="profit_margin"]')).toHaveCount(1)
  await expect(card.locator('[data-reasons]')).toHaveCount(0)
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-employee-product-costs')
  // A link that asks for a sort by cost is read as the name order; the API refuses it outright.
  await page.goto(`/b/${businessId}/product-costs?sort=cost&filter=incomplete`)
  await expect(page.getByLabel('رتّب حسب')).toHaveValue('name:asc')
  for (const input of [{ sort: 'cost' }, { sort: 'margin_percent' }, { filter: 'incomplete' }]) {
    expect(
      (await callApi(page, 'productCost.list', input, { businessId, query: true })).appCode,
      JSON.stringify(input),
    ).toBe('forbidden')
  }

  // The breakdown: what goes into it, with locks in place of every cost.
  await page.goto(`/b/${businessId}/product-costs/${latteId}`)
  await expect(page.locator('[data-summary="cost"] [data-locked="cost"]')).toHaveCount(1)
  await expect(page.locator('[data-material-line="Coffee beans"]:visible')).toContainText('18 غرام')
  await expect(page.locator('[data-material-line]:visible [data-locked="cost"]')).not.toHaveCount(0)
  await expect(page.getByRole('main')).not.toContainText('4.50')
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-employee-breakdown')

  // English, desktop: the table, without a sort button on the hidden columns.
  await setLanguage(page, 'en')
  await page.setViewportSize(DESKTOP)
  await page.goto(`/b/${businessId}/product-costs`)
  const table = page.getByRole('table', { name: 'Product costs' })
  await expect(table.getByRole('button', { name: 'Price' })).toBeVisible()
  await expect(table.getByRole('button', { name: 'Cost per unit' })).toHaveCount(0)
  await expect(table.getByRole('button', { name: 'Margin %' })).toHaveCount(0)
  await expect(table.locator('[data-locked="cost"]')).toHaveCount(4)
  await expectSound(page, 'en')
  await shot(page, 'en-1440-employee-product-costs')
})

test('Arabic, phone: a home baker counts a slice of cake with her own time', async ({
  browser,
}) => {
  test.setTimeout(600_000)
  const { page } = await open(browser, PHONE, 'ar')
  const businessId = await createBusiness(page, "Sara's Kitchen", BAKER_ANSWERS)
  // A 10 kg sack of flour at 50, a tray of 30 eggs at 12, 1 kg of sugar at 4 and of butter at 32.
  const flour = await material(page, businessId, 'طحين', 'kg')
  const eggs = await material(page, businessId, 'بيض', 'piece')
  const sugar = await material(page, businessId, 'سكر', 'kg')
  const butter = await material(page, businessId, 'زبدة', 'kg')
  await buy(page, businessId, [
    { materialId: flour, qty: '10', unit: 'kg', unitPrice: '5' },
    { materialId: eggs, qty: '30', unit: 'piece', unitPrice: '0.4' },
    { materialId: sugar, qty: '1', unit: 'kg', unitPrice: '4' },
    { materialId: butter, qty: '1', unit: 'kg', unitPrice: '32' },
  ])
  const cakeId = await product(page, businessId, {
    name: 'قطعة كيك شوكولاتة',
    defaultPrice: '15',
  })
  // The whole cake: 12.90, and it makes 12 slices.
  await recipe(
    page,
    businessId,
    cakeId,
    [
      { materialId: flour, qty: '500', unit: 'g' },
      { materialId: eggs, qty: '4', unit: 'piece' },
      { materialId: sugar, qty: '200', unit: 'g' },
      { materialId: butter, qty: '250', unit: 'g' },
    ],
    '12',
  )
  // Rent 300 and electricity 150 a month, a licence of 1,200 a year: 550 a month.
  await runningCosts(page, businessId, [
    { name: 'إيجار', amount: '300', frequency: 'monthly' },
    { name: 'كهرباء', amount: '150', frequency: 'monthly' },
    { name: 'رخصة', amount: '1200', frequency: 'yearly' },
  ])

  // Settings: her estimate and her hourly rate, each saved on its own.
  await page.goto(`/b/${businessId}/settings/costing`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('طريقة حساب التكاليف')
  await page.getByRole('textbox', { name: 'كم تشتري من المواد تقريبًا في الشهر؟' }).fill('٢٠٠٠')
  await page.locator('[data-setting="estimate"]').getByRole('button', { name: 'حفظ' }).click()
  await expect(page.getByText('تم الحفظ.')).toBeVisible()
  await expect(page.locator('[data-rate-now] [data-why]')).toContainText(
    loose('لأن مصاريفك التشغيلية 550 د.إ. في الشهر، وتشتري مواد بحوالي 2,000 د.إ. في الشهر.'),
  )
  await expect(page.locator('[data-rate-now] [data-rule]')).toContainText('(أي 27.5')
  await expect(page.getByRole('heading', { name: 'وقتك' })).toBeVisible()
  await page.getByRole('textbox', { name: 'كم تساوي ساعة من وقتك؟' }).fill('45')
  await page.locator('[data-setting="hourlyRate"]').getByRole('button', { name: 'حفظ' }).click()
  await expect(page.getByText('تم الحفظ.').first()).toBeVisible()
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-baker-settings')

  // Her minutes on the cake, on its form.
  await page.goto(`/b/${businessId}/products`)
  const row = page.getByRole('main').locator('li').filter({ hasText: 'قطعة كيك شوكولاتة' })
  await row.getByRole('button').first().click()
  const sheet = page.getByRole('dialog')
  const minutes = sheet.getByRole('textbox', { name: 'وقتك لكل قطعة' })
  await expect(minutes).toHaveValue('')
  await minutes.fill('١٠')
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-baker-minutes')
  await sheet.getByRole('button', { name: 'احفظ التغييرات' }).click()
  await expect(sheet).toHaveCount(0)

  // A pie with none of her time.
  await product(page, businessId, { name: 'فطيرة', defaultPrice: '20' })

  // Product costs: the slice, with her time; the pie says her time is not added.
  await page.getByRole('link', { name: 'اعرض تكاليف المنتجات' }).click()
  await expect(page.locator('[data-how-folded]')).toContainText(
    loose('وقتك: 45.00 د.إ. في الساعة.'),
  )
  await page.getByRole('button', { name: 'كيف؟' }).click()
  const how = page.getByRole('region', { name: 'كيف تُحسب تكاليفك' })
  await expect(how.locator('[data-how="time"]')).toHaveText(loose('وقتك: 45.00 د.إ. في الساعة.'))
  await expect(how.locator('[data-how="no-time"]')).toContainText('منتج واحد لم يُضف له وقتك بعد')
  await expect(page.locator('[data-product-cost-row="فطيرة"] [data-reasons]')).toContainText(
    'لم يُضف وقتك',
  )
  const card = page.locator('[data-product-cost-row="قطعة كيك شوكولاتة"]')
  await expect(card.locator('[data-figure="cost"]')).toContainText('8.87')
  await expect(card.locator('[data-figure="margin"]')).toContainText('6.13')
  await expect(card.locator('[data-figure="margin"]')).toContainText('40.9')
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-baker-product-costs')
  await card.click()
  await expect(page.locator('[data-line="materials"]')).toContainText('1.08')
  await expect(page.locator('[data-line="materials"] [data-whole]')).toContainText(
    loose('الوصفة كاملة تكلف 12.90 د.إ. وتكفي 12 قطعة.'),
  )
  await expect(page.locator('[data-line="running"]')).toContainText('0.30')
  const time = page.locator('[data-line="time"]')
  await expect(time).toContainText('7.50')
  await expect(time).toContainText(loose('10 دقائق بأجر 45.00 د.إ. في الساعة.'))
  await expect(page.locator('[data-line="total"]')).toContainText('8.87')
  await expect(page.locator('[data-line="margin"]')).toContainText('6.13')
  const cake = await breakdownOf(page, businessId, cakeId)
  expect(cake.cost).toMatchObject({
    materials: '1.075',
    runningCosts: { state: 'applied', share: '0.295625' },
    ownerTime: { state: 'applied', minutes: '10', amount: '7.5' },
    total: '8.870625',
    complete: true,
  })
  expect(cake.rate).toMatchObject({ state: 'ready', rate: '0.275' })
  expect(cake.margin).toEqual({ amount: '6.129375', percent: '40.8625' })
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-baker-breakdown')

  // English, desktop.
  await setLanguage(page, 'en')
  await page.setViewportSize(DESKTOP)
  await page.reload()
  await expect(time).toContainText('10 minutes at AED 45.00 an hour.')
  await expect(page.locator('[data-line="materials"] [data-whole]')).toHaveText(
    /The whole recipe costs AED\s12\.90 and makes 12 pieces\./,
  )
  await expectSound(page, 'en')
  await shot(page, 'en-1440-baker-breakdown')
  await page.goto(`/b/${businessId}/product-costs`)
  await expectSound(page, 'en')
  await shot(page, 'en-1440-baker-product-costs')
})

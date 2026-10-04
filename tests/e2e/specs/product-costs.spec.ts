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
import { baseURL } from '../stack'

// Product costs (ROADMAP.md M2 Step 6; D-115, D-119, D-178, D-202, D-203), on the production build since
// the Costing Core was released (M2 Step 7, D-188).
//
// Running costs reach every product and service by its price (D-202, the owner's decision of
// 2026-09-30): the month's costs ÷ the month's sales. Sales arrive in Phase 3, so every share waits
// for them ("Worked out automatically once you record your sales"), which is never "incomplete",
// while the costs and margins say they are before running costs. Nothing is typed in for it: the
// estimate of monthly purchases is gone.
//
// A café with a team (VAT-registered) sells the owner's Spanish Latte (its materials cost
// 3.002034632035 from real purchases), an espresso, a latte-art class (a service with no materials),
// a catering tray in the thousands and a seasonal special without a price. In English on a desktop,
// the owner is first asked for her running costs; then, with rent, salaries and electricity from
// last month and two final bills for last month, "How your costs are worked out" says the rule with
// the owner's example (20,000 ÷ 80,000 = 25%: 400 carries 100, 18 carries 4.50) and shows last
// month's costs by category: the electricity bills (AED 3,150) in place of its regular AED 3,000,
// counted once (AED 23,600 in all, before VAT). The latte costs AED 3.00 before running costs and
// keeps AED 15.00 (83.3%); only the special (no price: "Add its price") needs a look, while the
// service (no materials added, a hint) is worked out once sales are recorded (D-203). Its breakdown
// says the share awaits sales, and its margin is never green. Settings →
// How costs are worked out has nothing to set for a café with a team: the rule and the way on. The
// same pages in Arabic and on a phone, where "How your costs are worked out" folds to one line. An
// employee (the template) has no Product costs; with the page, names and prices with locks; with
// costs too, but without running costs, last month's costs stay hidden (the API withholds them). A
// home baker who works alone (Arabic, phone) sets only her hourly rate (AED 45) and 10 minutes on the
// cake: one slice of a cake that makes 12 costs 1.075 of materials + 7.5 of her time = 8.575 (AED
// 8.58) before running costs, AED 6.43 kept from AED 15 (42.8%). A designer who sells only services
// is asked for her running costs on the Dashboard; her logo's share waits for sales like a product's,
// her yearly licence's bill counts a twelfth in each month of its year, and her Settings speak of
// services.

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

/** A freelance designer: services only, alone, not VAT-registered (as the demo's). */
const DESIGNER_ANSWERS = {
  what_you_do: ['services'],
  workplace: 'home',
  team: 'alone',
  work_setup: ['none'],
  sales_channels: ['messages', 'quotes', 'invoice_later'],
  vat: 'no',
}

const RAW_KEY =
  /\b(?:common|catalog|units|errors|nav|modules|purchasing|settings|costing|dashboard)\.[a-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+/

const RULE =
  'Your running costs and expenses (rent, salaries, bills…) are shared over everything you sell by its price: each thing you sell carries the same percentage of its price.'
const EXAMPLE =
  "For example, if a month's costs are AED 20,000 and its sales AED 80,000, that's 20,000 ÷ 80,000 = 25%: something priced AED 400.00 carries AED 100.00, and something priced AED 18.00 carries AED 4.50."
const AWAITING = 'Worked out automatically once you record your sales.'
const AWAITING_AR = 'تُحسب تلقائيًا بعد تسجيل مبيعاتك.'

const users: TestUser[] = []
const contexts: BrowserContext[] = []
let cafe: { page: Page; businessId: string; latteId: string; specialId: string } | undefined

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
    baseURL,
    locale: locale === 'ar' ? 'ar-AE' : 'en-US',
    viewport,
  })
  contexts.push(context)
  await useLanguage(context, 'en')
  const page = await context.newPage()
  await signIn(page, who)
  if (locale === 'ar') await setLanguage(page, 'ar')
  return { page, user: who }
}

/**
 * Screenshots into E2E_SHOTS_DIR (only when it is set), named costs-*: the whole page, with the
 * phone's tab bar at its end instead of over the middle of it, and without toasts.
 */
async function shot(page: Page, name: string) {
  const dir = process.env.E2E_SHOTS_DIR
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  // From the top: the sticky header stays at the top of the page.
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.waitForTimeout(400)
  await page.screenshot({
    path: join(dir, `costs-${name}.png`),
    fullPage: true,
    style:
      'nav.fixed.bottom-0 { position: static !important } [data-sonner-toaster] { display: none !important }',
  })
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

/** The month before `day`'s (YYYY-MM): the last full calendar month, as the page shows it. */
function monthBefore(day: string): string {
  const [year, month] = day.split('-').map(Number) as [number, number]
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`
}

/** A month (YYYY-MM) as the English pages write it ("September 2026"). */
function monthName(month: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${month}-01T00:00:00Z`))
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

/** The business's cost categories by name (named in its language: English here). */
async function categoriesOf(page: Page, businessId: string): Promise<Map<string, string>> {
  const categories = await ok(
    callApi<{ items: { id: string; name: string }[] }>(
      page,
      'costCategory.list',
      { limit: 100 },
      { businessId, query: true },
    ),
    'costCategory.list',
  )
  return new Map(categories.items.map((category) => [category.name, category.id]))
}

/** Running costs paid from the first day of last month, each in its category; their ids by name. */
async function runningCosts(
  page: Page,
  businessId: string,
  costs: { name: string; amount: string; frequency: string; category: string }[],
): Promise<Map<string, string>> {
  const categories = await categoriesOf(page, businessId)
  const startsOn = `${monthBefore(await today(page, businessId))}-01`
  const ids = new Map<string, string>()
  for (const { category, ...cost } of costs) {
    const categoryId = categories.get(category)
    if (!categoryId) throw new Error(`no category ${category}`)
    const id = randomUUID()
    ids.set(cost.name, id)
    await ok(
      callApi(page, 'runningCost.create', { id, categoryId, startsOn, ...cost }, { businessId }),
      cost.name,
    )
  }
  return ids
}

/**
 * A final expense for last month (a no-invoice receipt paid in cash, dated today). `pays`: the id of
 * the running cost whose bill it is (D-216: said when its category has one).
 */
async function lastMonthBill(
  page: Page,
  businessId: string,
  bill: { category: string; amount: string; description: string; pays?: string },
) {
  const categoryId = (await categoriesOf(page, businessId)).get(bill.category)
  if (!categoryId) throw new Error(`no category ${bill.category}`)
  const day = await today(page, businessId)
  const id = randomUUID()
  const draft = await ok(
    callApi<{ data: { version: number } }>(
      page,
      'expense.create',
      {
        id,
        categoryId,
        businessDate: day,
        periodMonth: monthBefore(day),
        documentType: 'no_invoice',
        paymentMethod: 'cash',
        amount: bill.amount,
        vatRate: '0',
        description: bill.description,
      },
      { businessId },
    ),
    'expense.create',
  )
  await ok(
    callApi(
      page,
      'expense.post',
      {
        id,
        version: draft.data.version,
        ...(bill.pays ? { pays: { kind: 'running_cost', runningCostId: bill.pays } } : {}),
      },
      { businessId },
    ),
    'expense.post',
  )
}

interface MonthCosts {
  state: string
  runningCostsEntered: boolean
  month: string
  amountsShown: boolean
  total: string | null
  categories:
    | {
        name: string
        amount: string
        lines: {
          kind: string
          name: string | null
          source: string
          amount: string
          regular: string | null
        }[]
      }[]
    | null
}

interface Breakdown {
  data: {
    cost: {
      materials: string | null
      runningCosts: { state: string }
      ownerTime: { state: string; minutes: string | null; amount: string | null }
      total: string | null
      beforeRunningCosts: boolean
      complete: boolean
      reasons: string[]
    }
    margin: { amount: string | null; percent: string | null }
    price: { beforeVat: string | null }
    monthCosts: MonthCosts
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

async function monthCostsOf(page: Page, businessId: string): Promise<MonthCosts> {
  return (
    await ok(
      callApi<{ data: { monthCosts: MonthCosts } }>(
        page,
        'productCost.list',
        {},
        { businessId, query: true },
      ),
      'productCost.list',
    )
  ).data.monthCosts
}

/** A decimal string's value, however many zeros it ends with ("23600.000000000000" → "23600"). */
function plain(value: string | null): string | null {
  return value === null ? null : value.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
}

test('English, desktop: a café sees what the Spanish Latte costs before running costs, and last month’s costs', async ({
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
  // A seasonal special without a price yet: its share cannot be worked out by its price.
  const specialId = await product(page, businessId, { name: 'Seasonal special' })
  await recipe(page, businessId, specialId, [{ materialId: beans, qty: '18', unit: 'g' }])
  cafe = { page, businessId, latteId, specialId }

  // Products & Services leads to Product costs.
  await page.goto(`/b/${businessId}/products`)
  await page.getByRole('link', { name: 'See product costs' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Product costs')
  const nav = page.getByRole('navigation', { name: 'Main' })
  await expect(nav.getByRole('link', { name: 'Product costs' })).toHaveAttribute(
    'aria-current',
    'page',
  )
  // The rule, the owner's example, and that it waits for sales; no running cost entered yet: the
  // page asks for them (they are what is shared), and no product is incomplete for it.
  const how = page.getByRole('region', { name: 'How your costs are worked out' })
  await expect(how.locator('[data-how="materials"]')).toContainText('Materials: the average')
  await expect(how.locator('[data-how="running"] [data-rule]')).toHaveText(RULE)
  await expect(how.locator('[data-how="running"] [data-example]')).toHaveText(EXAMPLE)
  await expect(how.locator('[data-how="running"] [data-awaiting]')).toHaveText(
    `${AWAITING} Until then, your costs and margins are before running costs.`,
  )
  const notEntered = how.locator('[data-how="not-entered"]')
  await expect(notEntered).toContainText(
    "Enter your running costs (rent, salaries…): they're what is shared over what you sell.",
  )
  await expect(notEntered.getByRole('link', { name: 'Add your running costs' })).toHaveAttribute(
    'href',
    `/b/${businessId}/running-costs`,
  )
  const month = monthBefore(await today(page, businessId))
  await expect(how.locator('[data-how="month"] [data-month-none]')).toHaveText(
    `Nothing counted for ${monthName(month)}: no running costs and no final expenses for that month.`,
  )
  const latteRow = page.locator('[data-product-cost-row="Spanish Latte"]')
  await expect(latteRow.locator('[data-figure="cost"]')).toHaveText(/^AED\s3\.00$/)
  await expect(latteRow.locator('[data-reasons]')).toHaveCount(0)
  await expectSound(page, 'en')
  await shot(page, 'en-1440-costs-not-entered')

  // Rent, salaries and electricity since the start of last month, and last month's bills: the
  // electricity's bill (3,150) takes the place of its regular 3,000; the repair counts as itself.
  const cafeCosts = await runningCosts(page, businessId, [
    { name: 'Shop rent', amount: '12000', frequency: 'monthly', category: 'Rent' },
    { name: 'Staff salaries', amount: '8000', frequency: 'monthly', category: 'Salaries' },
    { name: 'Electricity', amount: '3000', frequency: 'monthly', category: 'Electricity' },
  ])
  await lastMonthBill(page, businessId, {
    category: 'Electricity',
    amount: '3150',
    description: 'DEWA bill',
    pays: cafeCosts.get('Electricity'),
  })
  await lastMonthBill(page, businessId, {
    category: 'Maintenance',
    amount: '450',
    description: 'Coffee machine repair',
  })
  await page.reload()
  await expect(notEntered).toHaveCount(0)
  const costs = how.locator('[data-month-costs]')
  await expect(costs).toContainText(`Your business's costs in ${monthName(month)}`)
  await expect(costs).toContainText(/AED\s23,600\.00/)
  await expect(costs.locator('[data-month-category]')).toHaveCount(4)
  expect(
    await costs
      .locator('[data-month-category]')
      .evaluateAll((items) => items.map((item) => item.getAttribute('data-month-category'))),
  ).toEqual(['Rent', 'Salaries', 'Electricity', 'Maintenance'])
  // Each category, then what is inside it: its running cost (named unless it has the category's
  // name) and where its amount comes from (D-216).
  await expect(costs.locator('[data-month-category="Rent"]')).toHaveText(
    /^Rent\s*AED\s12,000\.00\s*Shop rent\s*Its regular amount$/,
  )
  await expect(costs.locator('[data-month-category="Electricity"]')).toHaveText(
    /^Electricity\s*AED\s3,150\.00\s*From its bills, in place of its regular AED\s3,000\.00$/,
  )
  await expect(costs.locator('[data-month-category="Maintenance"]')).toHaveText(
    /^Maintenance\s*AED\s450\.00\s*From its bills$/,
  )
  await expect(
    costs.locator('[data-month-category="Electricity"] [data-month-line="Electricity"]'),
  ).toHaveAttribute('data-source', 'bills')
  await expect(costs).toContainText('Each running cost counts once')
  // What it will be shared over, and that it is before the VAT the café gets back (D-203).
  await expect(costs.locator('[data-month-shared]')).toHaveText(
    `This is what will be shared over what you sold in ${monthName(month)} once your sales are recorded.`,
  )
  await expect(costs.locator('[data-month-note]')).toContainText(
    "Amounts are before VAT: VAT you get back isn't a cost.",
  )
  expect(await monthCostsOf(page, businessId)).toMatchObject({
    state: 'awaiting_sales',
    runningCostsEntered: true,
    month,
    amountsShown: true,
  })
  const pool = await monthCostsOf(page, businessId)
  expect(plain(pool.total)).toBe('23600')
  expect(
    pool.categories?.map((c) => [
      c.name,
      plain(c.amount),
      c.lines.map((l) => [l.kind, l.name, l.source, plain(l.amount), plain(l.regular)]),
    ]),
  ).toEqual([
    ['Rent', '12000', [['running_cost', 'Shop rent', 'regular', '12000', '12000']]],
    ['Salaries', '8000', [['running_cost', 'Staff salaries', 'regular', '8000', '8000']]],
    ['Electricity', '3150', [['running_cost', 'Electricity', 'bills', '3150', '3000']]],
    ['Maintenance', '450', [['extra', null, 'expenses', '450', null]]],
  ])

  // The list: a table, the latte's cost before running costs and its margin, said as such.
  const table = page.getByRole('table', { name: 'Product costs' })
  await expect(table).toBeVisible()
  await expect(page.locator('[data-before-running]')).toHaveText(
    'Costs and margins here are before running costs: those are added automatically once you record your sales.',
  )
  await expect(latteRow.locator('[data-figure="price"]')).toHaveText(/^AED\s18\.00$/)
  await expect(latteRow.locator('[data-figure="cost"]')).toHaveText(/^AED\s3\.00$/)
  await expect(latteRow.locator('[data-figure="margin"]')).toHaveText(/^AED\s15\.00$/)
  await expect(latteRow.locator('[data-figure="percent"]')).toHaveText('83.3%')
  // The service: no materials added (they are optional, a hint), and its only line is its share,
  // which waits for sales: worked out then, never 0 and never "incomplete" (D-203).
  const classRow = page.locator('[data-product-cost-row="Latte art class"]')
  await expect(classRow.locator('[data-reasons]')).toHaveText('No materials added (if it uses any)')
  await expect(classRow.locator('[data-figure="cost"]')).toHaveText(
    'Worked out once you record your sales',
  )
  await expect(classRow.locator('[data-figure="cost"]')).not.toContainText('incomplete')
  await expect(classRow.locator('[data-figure="margin"]')).toHaveText('—')
  // The margin columns say they are before running costs.
  await expect(table.locator('thead [data-column-note]')).toHaveText([
    'before running costs',
    'before running costs',
  ])
  // The special: no price, so its share cannot be worked out by it (said plainly).
  const specialRow = page.locator('[data-product-cost-row="Seasonal special"]')
  await expect(specialRow.locator('[data-reasons]')).toHaveText('Add its price')
  await expect(specialRow.locator('[data-figure="price"]')).toHaveText('No usual price')
  await expect(specialRow.locator('[data-figure="cost"]')).toHaveText(/^AED\s1\.17\s*incomplete$/)
  await expect(specialRow.locator('[data-figure="margin"]')).toHaveText('—')
  const latte = await breakdownOf(page, businessId, latteId)
  expect(latte.cost).toMatchObject({
    materials: '3.002034632035',
    runningCosts: { state: 'awaiting_sales' },
    total: '3.002034632035',
    beforeRunningCosts: true,
    complete: true,
    reasons: [],
  })
  expect(latte.margin).toEqual({ amount: '14.997965367965', percent: '83.322029822028' })
  const special = await breakdownOf(page, businessId, specialId)
  expect(special.cost).toMatchObject({
    runningCosts: { state: 'no_price' },
    beforeRunningCosts: true,
    complete: false,
    reasons: ['no_price'],
  })
  await expectSound(page, 'en')
  await shot(page, 'en-1440-product-costs')

  await expectFiguresFit(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await expectFiguresFit(page)
  await page.setViewportSize(DESKTOP)

  // Sorted by name, then by margin %, the lowest first (those without one: last), then by cost.
  const names = table.locator('tbody tr [dir="auto"]')
  await expect(names).toHaveText([
    'Catering tray',
    'Espresso',
    'Latte art class',
    'Seasonal special',
    'Spanish Latte',
  ])
  await table.getByRole('button', { name: 'Margin %' }).click()
  await expect(page).toHaveURL(/sort=margin_percent/)
  await expect(names).toHaveText([
    'Spanish Latte',
    'Espresso',
    'Catering tray',
    'Latte art class',
    'Seasonal special',
  ])
  await expect(table.getByRole('columnheader', { name: 'Margin %' })).toHaveAttribute(
    'aria-sort',
    'ascending',
  )
  await page.getByLabel('Sort by').selectOption({ label: 'Highest cost first' })
  await expect(names).toHaveText([
    'Catering tray',
    'Spanish Latte',
    'Espresso',
    'Seasonal special',
    'Latte art class',
  ])
  // What needs a look, with how many: the special only; waiting for sales is not one, nor a
  // service's optional materials (D-203).
  await expect(page.locator('[data-attention]')).toContainText('Needs a look:')
  await expect(page.locator('[data-attention] button')).toHaveText(['Incomplete (1)'])
  const show = page.getByLabel('Show')
  await expect(show.locator('option')).toHaveText([
    'In use',
    'Incomplete (1)',
    'Sold at a loss before running costs (0)',
    'Archived',
    'All',
  ])
  await page.locator('[data-attention-item="incomplete"]').click()
  await expect(names).toHaveText(['Seasonal special'])
  await expect(show).toHaveValue('incomplete')
  await show.selectOption('loss')
  await expect(page.getByText('Nothing here is sold at a loss.')).toBeVisible()
  await show.selectOption('active')
  await expect(names).toHaveCount(5)

  // The latte's breakdown, part by part, in words: before running costs, never green.
  await latteRow.getByRole('link').click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Spanish Latte')
  await expect(page.locator('[data-summary="cost"]')).toContainText(
    /Cost per piece before running costs\s*AED\s3\.00/,
  )
  const summaryMargin = page.locator('[data-summary="margin"]')
  await expect(summaryMargin).toContainText(
    /Margin per piece before running costs\s*AED\s15\.00\s*83\.3% of the price/,
  )
  await expect(summaryMargin.locator('[data-before-running]')).toHaveText(
    'Its share of running costs is added automatically once you record your sales.',
  )
  await expect(summaryMargin.locator('.text-success')).toHaveCount(0)
  await expect(page.locator('[data-summary="cost"]')).not.toContainText('incomplete')
  const lines = page.locator('[data-line]')
  await expect(page.locator('[data-line="materials"]')).toContainText(
    /Ingredients & supplies\s*AED\s3\.00/,
  )
  const running = page.locator('[data-line="running"]')
  await expect(running).toContainText(/Running costs\s*Not counted yet/)
  await expect(running.locator('[data-awaiting]')).toHaveText(AWAITING)
  await expect(running.locator('[data-rate]')).toHaveText(RULE)
  // A team: no time line.
  await expect(page.locator('[data-line="time"]')).toHaveCount(0)
  await expect(page.locator('[data-line="total"]')).toContainText(
    /Cost per piece before running costs\s*AED\s3\.00/,
  )
  await expect(page.locator('[data-line="margin"]')).toContainText(
    /Margin before running costs\s*AED\s15\.00\s*83\.3%/,
  )
  await expect(lines).toHaveCount(5)
  // Nothing is missing: waiting for sales is not something to add.
  await expect(page.locator('[data-reason]')).toHaveCount(0)
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
  await expect(summaryMargin).toContainText(/AED\s14\.14\s*82\.5% of the price before VAT/)
  await expect(page.locator('[data-line="price"]')).toContainText(/Price before VAT\s*AED\s17\.14/)
  const withVat = await breakdownOf(page, businessId, latteId)
  expect(withVat.price.beforeVat).toBe('17.142857142857')
  expect(withVat.margin.amount).toBe('14.140822510822')
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
  await expect(card.locator('[data-figure="cost"]')).toContainText(/AED\s3\.00/)
  await expect(card.locator('[data-figure="price"]')).toContainText(/AED\s17\.14 before VAT/)
  await expect(card.locator('[data-figure="margin"]')).toContainText(/AED\s14\.14\s*82\.5%/)
  await expect(page.locator('[data-before-running]')).toBeVisible()
  // On a phone, how costs are worked out folds to one line, a tap away.
  const folded = page.locator('[data-how-folded]')
  await expect(folded).toHaveText(
    /Running costs: worked out automatically once you record your sales\.\s*How\?/,
  )
  await expectSound(page, 'en')
  await shot(page, 'en-390-product-costs')
  await page.getByRole('button', { name: 'How?' }).click()
  await expect(how.locator('[data-month-costs]')).toContainText(/AED\s23,600\.00/)
  await expectSound(page, 'en')
  await shot(page, 'en-390-product-costs-how')
  // Amounts in the thousands at 375 px: nothing runs into anything, in the list and the breakdown.
  await page.setViewportSize({ width: 375, height: 812 })
  await expect(
    page.locator('[data-product-cost-row="Catering tray"] [data-figure="price"]'),
  ).toContainText(/AED\s12,500\.00/)
  await expectFiguresFit(page)
  await expectSound(page, 'en')
  await page.locator('[data-product-cost-row="Catering tray"]').click()
  await expect(page.locator('[data-summary="margin"]')).toContainText(/AED\s11,200\.00/)
  await expectFiguresFit(page)
  await expectSound(page, 'en')
  await shot(page, 'en-375-tray-breakdown')
  await page.setViewportSize({ width: 1280, height: 900 })
  await expectFiguresFit(page)
  await shot(page, 'en-1280-tray-breakdown')

  // Settings → How costs are worked out: a café with a team has nothing to set there (no estimate,
  // no hourly rate): the rule with the owner's example, and the way to what it is made of.
  await page.setViewportSize(DESKTOP)
  await page.goto(`/b/${businessId}/settings/costing`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('How costs are worked out')
  await expect(page.getByRole('heading', { name: 'Your time' })).toHaveCount(0)
  await expect(page.getByRole('textbox')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0)
  const example = page.locator('[data-rule-example]')
  await expect(example.locator('[data-rule]')).toHaveText(RULE)
  await expect(example.locator('[data-example]')).toHaveText(EXAMPLE)
  await expect(page.getByRole('link', { name: 'Go to Running Costs' })).toHaveAttribute(
    'href',
    `/b/${businessId}/running-costs`,
  )
  await expect(page.getByRole('link', { name: 'See product costs' })).toHaveAttribute(
    'href',
    `/b/${businessId}/product-costs`,
  )
  await expectSound(page, 'en')
  await shot(page, 'en-1440-settings')
})

test('Arabic, phone and desktop: the café reads its product costs', async () => {
  test.setTimeout(600_000)
  if (!cafe) throw new Error('the first test makes the café')
  const { page, businessId, latteId, specialId } = cafe
  await setLanguage(page, 'ar')
  await page.setViewportSize(PHONE)
  await page.goto(`/b/${businessId}/product-costs`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('تكاليف المنتجات')
  // Folded to one line on a phone; "How?" opens it.
  await expect(page.locator('[data-how-folded]')).toContainText(
    'المصاريف التشغيلية: تُحسب تلقائيًا بعد تسجيل مبيعاتك.',
  )
  await expect(page.locator('[data-before-running]')).toHaveText(
    'التكاليف وهوامش الربح هنا قبل المصاريف التشغيلية، وتُضاف إليها تلقائيًا بعد تسجيل مبيعاتك.',
  )
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-product-costs')
  await page.getByRole('button', { name: 'كيف؟' }).click()
  const how = page.getByRole('region', { name: 'كيف تُحسب تكاليفك' })
  await expect(how.locator('[data-how="running"] [data-rule]')).toHaveText(
    'تُوزَّع مصاريفك التشغيلية ومصروفاتك (الإيجار والرواتب والفواتير…) على كل ما تبيعه حسب سعره: يحمل كل ما تبيعه النسبة نفسها من سعره.',
  )
  await expect(how.locator('[data-how="running"] [data-example]')).toContainText(
    loose('مثال: إذا كانت مصاريف الشهر 20,000 د.إ. ومبيعاته 80,000 د.إ.'),
  )
  await expect(how.locator('[data-how="running"] [data-example]')).toContainText(
    loose('ما سعره 400.00 د.إ. يحمل 100.00 د.إ.، وما سعره 18.00 د.إ. يحمل 4.50 د.إ.'),
  )
  await expect(how.locator('[data-how="running"] [data-example]')).toContainText(
    loose('فالنسبة 20,000 ÷ 80,000 ='),
  )
  await expect(how.locator('[data-how="running"] [data-awaiting]')).toContainText(AWAITING_AR)
  const costs = how.locator('[data-month-costs]')
  await expect(costs).toContainText('تكاليف عملك في')
  await expect(costs).toContainText(loose('23,600.00 د.إ.'))
  await expect(costs.locator('[data-month-category="Electricity"]')).toContainText(
    loose('من الفواتير، بدل المبلغ المنتظم 3,000.00 د.إ.'),
  )
  await expect(costs.locator('[data-month-category="Rent"]')).toContainText('المبلغ المنتظم')
  await expect(costs.locator('[data-month-shared]')).toContainText('بعد تسجيل مبيعاتك')
  await expect(costs.locator('[data-month-note]')).toContainText(
    'المبالغ قبل الضريبة: الضريبة التي تستردّها ليست تكلفة.',
  )
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-product-costs-how')
  await page.getByRole('button', { name: 'إخفاء التفاصيل' }).click()
  await expect(page.locator('[data-how-folded]')).toBeVisible()
  const card = page.locator('[data-product-cost-row="Spanish Latte"]')
  await expect(card.locator('[data-figure="cost"]')).toContainText('3.00')
  await expect(card.locator('[data-figure="margin"]')).toContainText('14.14')
  const classCard = page.locator('[data-product-cost-row="Latte art class"]')
  await expect(classCard.locator('[data-reasons]')).toHaveText('لم تُضف مواد (إن كان يستخدم مواد)')
  await expect(
    page.locator('[data-product-cost-row="Seasonal special"] [data-reasons]'),
  ).toHaveText('أضف سعره')
  await expectFiguresFit(page)
  await expectSound(page, 'ar')
  await page.setViewportSize({ width: 375, height: 812 })
  await expectFiguresFit(page)
  await expectSound(page, 'ar')
  await page.setViewportSize(PHONE)

  await card.click()
  await expect(page.locator('[data-summary="cost"]')).toContainText(
    'التكلفة لكل قطعة قبل المصاريف التشغيلية',
  )
  await expect(page.locator('[data-summary="margin"]')).toContainText(
    'هامش الربح لكل قطعة قبل المصاريف التشغيلية',
  )
  await expect(page.locator('[data-line="running"] [data-awaiting]')).toHaveText(AWAITING_AR)
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-latte-breakdown')

  // The service's breakdown: its share waits for sales like a product's (never 0), and that is its
  // only line: worked out then, never "incomplete" (D-203).
  await page.goto(`/b/${businessId}/product-costs`)
  await classCard.click()
  const running = page.locator('[data-line="running"]')
  await expect(running).toContainText('لم تُحسب بعد')
  await expect(running.locator('[data-awaiting]')).toHaveText(AWAITING_AR)
  await expect(page.locator('[data-summary="cost"]')).toContainText('تُحسب بعد تسجيل مبيعاتك')
  await expect(page.locator('[data-summary="cost"]')).not.toContainText('غير مكتملة')
  await expect(page.locator('[data-summary="margin"] [data-before-running]')).toHaveText(
    'يُضاف إليها نصيبها من المصاريف التشغيلية تلقائيًا بعد تسجيل مبيعاتك.',
  )
  // A service may use no materials: none, never "not counted"; adding some is a hint, not missing.
  await expect(page.locator('[data-line="materials"]')).toContainText(
    'لم تُضف له مواد. إن كان يستخدم مواد، أضفها لتُحسب تكلفتها.',
  )
  await expect(page.locator('[data-reason]')).toHaveCount(0)
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-service-breakdown')

  // The special without a price: said plainly, with the way to add it.
  await page.goto(`/b/${businessId}/product-costs/${specialId}`)
  await expect(page.locator('[data-line="running"] [data-no-price]')).toHaveText(
    'ليس له سعر، فلا يمكن حساب نصيبه: أضف سعره.',
  )
  const noPrice = page.locator('[data-reason="no_price"]')
  await expect(noPrice).toContainText(
    'ليس له سعر، فلا يمكن حساب نصيبه من المصاريف التشغيلية: أضف سعره.',
  )
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-no-price-breakdown')
  await noPrice.getByRole('button', { name: 'أضف سعره' }).click()
  const sheet = page.getByRole('dialog')
  await expect(sheet.getByRole('textbox', { name: 'السعر المعتاد' })).toBeVisible()
  await sheet.getByRole('button', { name: 'إغلاق' }).first().click()
  await expect(sheet).toHaveCount(0)

  // The tray's breakdown in the thousands, at 375 and 1280 px.
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto(`/b/${businessId}/product-costs`)
  await page.locator('[data-product-cost-row="Catering tray"]').click()
  await expect(page.locator('[data-summary="margin"]')).toContainText('11,200.00')
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
  await expect(page.locator('[data-rule-example] [data-rule]')).toContainText('حسب سعره')
  await expect(page.getByRole('textbox')).toHaveCount(0)
  await expectSound(page, 'ar')
  await shot(page, 'ar-1440-settings')
  await page.setViewportSize(PHONE)
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-settings')
})

test('an employee: no Product costs by the template; with the page, locks; with costs, last month’s costs still hidden', async ({
  browser,
}) => {
  test.setTimeout(600_000)
  if (!cafe) throw new Error('the first test makes the café')
  const { page: ownerPage, businessId, latteId } = cafe
  const roles = async () =>
    await ok(
      callApi<
        { id: string; templateKey: string | null; version: number; permissionKeys: string[] }[]
      >(ownerPage, 'role.list', {}, { businessId, query: true }),
      'role.list',
    )
  const employeeRole = (await roles()).find((role) => role.templateKey === 'employee')
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
  await expect(page.locator('[data-before-running]')).toHaveCount(0)
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
  await expect(page.locator('[data-line="running"] [data-locked="cost"]')).toHaveCount(1)
  await expect(page.locator('[data-material-line="Coffee beans"]:visible')).toContainText('18 غرام')
  await expect(page.locator('[data-material-line]:visible [data-locked="cost"]')).not.toHaveCount(0)
  await expect(page.getByRole('main')).not.toContainText('3.00')
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
  await expect(table.locator('[data-locked="cost"]')).toHaveCount(5)
  await expectSound(page, 'en')
  await shot(page, 'en-1440-employee-product-costs')

  // Costs too ("See costs, supplier prices and margins"), but not running costs: the rule shows,
  // last month's costs stay hidden, and the API withholds them (D-202).
  const [current] = (await roles()).filter((role) => role.id === employeeRole.id)
  await ok(
    callApi(
      ownerPage,
      'role.updatePermissions',
      {
        id: employeeRole.id,
        version: current!.version,
        permissionKeys: [
          ...current!.permissionKeys,
          'data.cost.view',
          'data.supplier_price.view',
          'data.profit_margin.view',
        ],
      },
      { businessId },
    ),
    'role.updatePermissions',
  )
  expect(current!.permissionKeys).not.toContain('running_costs.items.view')
  await page.reload()
  const how = page.getByRole('region', { name: 'How your costs are worked out' })
  await expect(how.locator('[data-how="running"] [data-rule]')).toHaveText(RULE)
  const month = monthBefore(await today(page, businessId))
  await expect(how.locator('[data-month-hidden]')).toHaveText(
    `Your business's costs in ${monthName(month)} show only to those who can see running costs and expenses.`,
  )
  await expect(how.locator('[data-month-category]')).toHaveCount(0)
  await expect(page.getByRole('main')).not.toContainText('23,600')
  await expect(
    page.locator('[data-product-cost-row="Spanish Latte"] [data-figure="cost"]'),
  ).toHaveText(/^AED\s3\.00$/)
  expect(await monthCostsOf(page, businessId)).toMatchObject({
    state: 'awaiting_sales',
    amountsShown: false,
    total: null,
    categories: null,
  })
  await expectSound(page, 'en')
  await shot(page, 'en-1440-employee-costs-month-hidden')
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
  // Rent 300 and electricity 150 a month, a licence of 1,200 a year: 550 last month.
  await runningCosts(page, businessId, [
    { name: 'إيجار', amount: '300', frequency: 'monthly', category: 'Rent' },
    { name: 'كهرباء', amount: '150', frequency: 'monthly', category: 'Electricity' },
    { name: 'رخصة', amount: '1200', frequency: 'yearly', category: 'Licences' },
  ])

  // Settings: only her hourly rate (no estimate of her purchases), with the rule above it.
  await page.goto(`/b/${businessId}/settings/costing`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('طريقة حساب التكاليف')
  await expect(page.locator('[data-rule-example] [data-example]')).toContainText('مثال:')
  await expect(page.getByRole('textbox')).toHaveCount(1)
  await expect(page.getByRole('heading', { name: 'وقتك' })).toBeVisible()
  await page.getByRole('textbox', { name: 'كم تساوي ساعة من وقتك؟' }).fill('٤٥')
  await page.locator('[data-setting="hourlyRate"]').getByRole('button', { name: 'حفظ' }).click()
  await expect(page.getByText('تم الحفظ.')).toBeVisible()
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
  await expect(how.locator('[data-month-costs]')).toContainText(loose('550.00 د.إ.'))
  await expect(page.locator('[data-product-cost-row="فطيرة"] [data-reasons]')).toContainText(
    'لم يُضف وقتك',
  )
  const card = page.locator('[data-product-cost-row="قطعة كيك شوكولاتة"]')
  await expect(card.locator('[data-figure="cost"]')).toContainText('8.58')
  await expect(card.locator('[data-figure="margin"]')).toContainText('6.43')
  await expect(card.locator('[data-figure="margin"]')).toContainText('42.8')
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-baker-product-costs')
  await card.click()
  await expect(page.locator('[data-line="materials"]')).toContainText('1.08')
  await expect(page.locator('[data-line="materials"] [data-whole]')).toContainText(
    loose('الوصفة كاملة تكلف 12.90 د.إ. وتكفي 12 قطعة.'),
  )
  await expect(page.locator('[data-line="running"] [data-awaiting]')).toHaveText(AWAITING_AR)
  const time = page.locator('[data-line="time"]')
  await expect(time).toContainText('7.50')
  await expect(time).toContainText(loose('10 دقائق بأجر 45.00 د.إ. في الساعة.'))
  await expect(page.locator('[data-line="total"]')).toContainText(
    'التكلفة لكل قطعة قبل المصاريف التشغيلية',
  )
  await expect(page.locator('[data-line="total"]')).toContainText('8.58')
  await expect(page.locator('[data-line="margin"]')).toContainText('6.43')
  const cake = await breakdownOf(page, businessId, cakeId)
  expect(cake.cost).toMatchObject({
    materials: '1.075',
    runningCosts: { state: 'awaiting_sales' },
    ownerTime: { state: 'applied', minutes: '10', amount: '7.5' },
    total: '8.575',
    beforeRunningCosts: true,
    complete: true,
  })
  expect(plain(cake.monthCosts.total)).toBe('550')
  expect(cake.margin).toEqual({ amount: '6.425', percent: '42.833333333333' })
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-baker-breakdown')
  await page.setViewportSize(DESKTOP)
  await page.goto(`/b/${businessId}/product-costs`)
  await expect(page.locator('[data-month-costs]')).toContainText(loose('550.00 د.إ.'))
  await expectSound(page, 'ar')
  await shot(page, 'ar-1440-baker-product-costs')

  // English, desktop.
  await setLanguage(page, 'en')
  await page.goto(`/b/${businessId}/product-costs/${cakeId}`)
  await expect(time).toContainText('10 minutes at AED 45.00 an hour.')
  await expect(page.locator('[data-line="materials"] [data-whole]')).toHaveText(
    /The whole recipe costs AED\s12\.90 and makes 12 pieces\./,
  )
  await expectSound(page, 'en')
  await shot(page, 'en-1440-baker-breakdown')
  await page.goto(`/b/${businessId}/product-costs`)
  await expectSound(page, 'en')
  await shot(page, 'en-1440-baker-product-costs')
  await page.setViewportSize(PHONE)
  await expect(page.locator('[data-how-folded]')).toContainText('Your time: AED 45.00 an hour.')
  await expectSound(page, 'en')
  await shot(page, 'en-390-baker-product-costs')
})

test('a designer who sells only services: asked for running costs, and her logo’s share waits for sales', async ({
  browser,
}) => {
  test.setTimeout(600_000)
  const { page } = await open(browser, DESKTOP, 'en')
  const businessId = await createBusiness(page, 'Noura Design Studio', DESIGNER_ANSWERS)
  await ok(
    callApi(page, 'productCost.updateSettings', { ownerHourlyRate: '100' }, { businessId }),
    'hourly rate',
  )
  const logoId = await product(page, businessId, {
    name: 'Logo design',
    type: 'service',
    defaultPrice: '1500',
    ownerMinutes: '600',
  })
  await product(page, businessId, {
    name: 'Design consultation',
    type: 'service',
    unit: 'h',
    defaultPrice: '250',
    ownerMinutes: '60',
  })
  await product(page, businessId, {
    name: 'Custom illustration',
    type: 'service',
    ownerMinutes: '240',
  })

  // Her Dashboard asks for her running costs too: they reach services by their price (D-202).
  await page.goto(`/b/${businessId}`)
  const checklist = page.getByRole('region', { name: "Let's find the real cost of what you sell" })
  const step = checklist.locator('[data-cost-step="running_costs"]')
  await expect(step).toContainText(
    'Rent, electricity, salaries and other regular costs, so each service carries its share.',
  )
  await expect(step.getByRole('link')).toHaveAttribute('href', `/b/${businessId}/running-costs`)
  await expectSound(page, 'en')
  await shot(page, 'en-1440-designer-checklist')

  // Her software and internet since last month, and her trade licence of 1,200 a year from last
  // month. Last month's Adobe bill came to 275 (its price went up): it replaces the regular 260;
  // the licence's bill of 1,200 pays for its whole year, 100 a month (D-203): 275 + 389 + 100 = 764.
  const designerCosts = await runningCosts(page, businessId, [
    {
      name: 'Adobe Creative Cloud',
      amount: '260',
      frequency: 'monthly',
      category: 'Software subscriptions',
    },
    { name: 'Home internet', amount: '389', frequency: 'monthly', category: 'Internet' },
    { name: 'Freelance licence', amount: '1200', frequency: 'yearly', category: 'Licences' },
  ])
  await lastMonthBill(page, businessId, {
    category: 'Software subscriptions',
    amount: '275',
    description: 'Adobe Creative Cloud',
    pays: designerCosts.get('Adobe Creative Cloud'),
  })
  await lastMonthBill(page, businessId, {
    category: 'Licences',
    amount: '1200',
    description: 'Freelance licence renewal',
    pays: designerCosts.get('Freelance licence'),
  })
  const month = monthBefore(await today(page, businessId))
  const yearEnd = monthBefore(`${String(Number(month.slice(0, 4)) + 1)}${month.slice(4)}-01`)
  await page.reload()
  await expect(step).toHaveAttribute('data-done', 'true')

  await page.goto(`/b/${businessId}/product-costs`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Product costs')
  const how = page.getByRole('region', { name: 'How your costs are worked out' })
  await expect(how.locator('[data-how="running"] [data-rule]')).toHaveText(RULE)
  const costs = how.locator('[data-month-costs]')
  await expect(costs).toContainText(/AED\s764\.00/)
  await expect(costs.locator('[data-month-category="Software subscriptions"]')).toHaveText(
    /^Software subscriptions\s*AED\s275\.00\s*Adobe Creative Cloud\s*From its bills, in place of its regular AED\s260\.00$/,
  )
  await expect(costs.locator('[data-month-category="Licences"]')).toHaveText(
    loose(
      `LicencesAED 100.00Freelance licenceIts bills for the year from ${monthName(month)} to ${monthName(yearEnd)} (AED 1,200.00), spread over its 12 months, in place of its regular AED 100.00`,
    ),
  )
  // Not VAT-registered: nothing said about VAT.
  await expect(costs.locator('[data-month-note]')).not.toContainText('VAT')
  const logo = page.locator('[data-product-cost-row="Logo design"]')
  await expect(logo.locator('[data-figure="cost"]')).toHaveText(/^AED\s1,000\.00$/)
  await expect(logo.locator('[data-figure="margin"]')).toHaveText(/^AED\s500\.00$/)
  await expect(logo.locator('[data-reasons]')).toHaveCount(0)
  await expect(
    page.locator('[data-product-cost-row="Custom illustration"] [data-reasons]'),
  ).toHaveText('Add its price')
  await expect(page.locator('[data-attention] button')).toHaveText(['Incomplete (1)'])
  await expectSound(page, 'en')
  await shot(page, 'en-1440-designer-product-costs')

  await logo.getByRole('link').click()
  await expect(page.locator('[data-summary="cost"]')).toContainText(
    /Cost per piece before running costs\s*AED\s1,000\.00/,
  )
  await expect(page.locator('[data-line="running"] [data-awaiting]')).toHaveText(AWAITING)
  await expect(page.locator('[data-line="time"]')).toContainText('10 hours at AED 100.00 an hour.')
  const breakdown = await breakdownOf(page, businessId, logoId)
  expect(breakdown.cost).toMatchObject({
    runningCosts: { state: 'awaiting_sales' },
    total: '1000',
    beforeRunningCosts: true,
    complete: true,
    reasons: [],
  })
  await expectSound(page, 'en')
  await shot(page, 'en-1440-designer-logo-breakdown')
  // Settings → How costs are worked out speaks of her services, with her hourly rate (D-200).
  await page.goto(`/b/${businessId}/settings/costing`)
  await expect(
    page.getByRole('heading', { name: 'Running costs in your service costs' }),
  ).toBeVisible()
  await expect(page.getByText('Running costs need no setting:')).toBeVisible()
  await expect(page.getByRole('link', { name: 'See service costs' })).toHaveAttribute(
    'href',
    `/b/${businessId}/product-costs`,
  )
  await expect(page.getByRole('textbox')).toHaveCount(1)
  await expectSound(page, 'en')
  await shot(page, 'en-1440-designer-settings')
  await page.setViewportSize(PHONE)
  await page.goto(`/b/${businessId}/product-costs`)
  await expect(page.locator('[data-before-running]')).toBeVisible()
  await expectSound(page, 'en')
  await shot(page, 'en-390-designer-product-costs')

  // Arabic, on a phone.
  await setLanguage(page, 'ar')
  await page.setViewportSize(PHONE)
  await page.goto(`/b/${businessId}/product-costs`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('تكاليف المنتجات')
  await expect(page.locator('[data-how-folded]')).toContainText(
    'المصاريف التشغيلية: تُحسب تلقائيًا بعد تسجيل مبيعاتك.',
  )
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-designer-product-costs')
  await page.getByRole('button', { name: 'كيف؟' }).click()
  await expect(page.locator('[data-month-category="Software subscriptions"]')).toContainText(
    loose('من الفواتير، بدل المبلغ المنتظم 260.00 د.إ.'),
  )
  await expect(page.locator('[data-month-category="Licences"]')).toContainText('فواتير السنة من')
  await expect(page.locator('[data-month-category="Licences"]')).toContainText(
    'موزّعة على أشهرها الاثني عشر',
  )
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-designer-product-costs-how')
  await page.locator('[data-product-cost-row="Logo design"]').click()
  await expect(page.locator('[data-line="running"] [data-awaiting]')).toHaveText(AWAITING_AR)
  await expect(page.locator('[data-summary="margin"] [data-before-running]')).toHaveText(
    'يُضاف إليها نصيبها من المصاريف التشغيلية تلقائيًا بعد تسجيل مبيعاتك.',
  )
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-designer-logo-breakdown')
  await page.setViewportSize(DESKTOP)
  await page.goto(`/b/${businessId}/product-costs`)
  await expectSound(page, 'ar')
  await shot(page, 'ar-1440-designer-product-costs')
})

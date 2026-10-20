import { randomUUID } from 'node:crypto'
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test'
import {
  auditScreen,
  callApi,
  createUser,
  deleteUser,
  nextInvitation,
  onScreen,
  RAW_KEY,
  setLanguage,
  settle,
  signIn,
  useLanguage,
  type TestUser,
} from '../helpers'
import { baseURL } from '../stack'

// The M3 definition of done (docs/plans/m3-sales-profit.md §M3 definition of done), as the owner sees
// it on the screens, in English and Arabic: each test names the item it proves. What the screens show
// is worked out by the domain and the API, whose suites prove the rest of each item (the API, database
// and domain tests named in ROADMAP.md §M3 definition of done); the other M3 specs prove the screens'
// own flows (sales, orders, import, profit, quotations, invoices, money-back, release-sales,
// release-documents) and m3-smoke.spec.ts every screen at 375, 768 and 1440 px. Months are counted
// from the business's today, so every test holds on any day it runs ("last month" stands for the
// plan's September). Businesses, products, purchases and running costs are entered through the API;
// what an item is about is entered or read on the screens.

test.describe.configure({ mode: 'serial' })

const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1440, height: 900 }

type Locale = 'en' | 'ar'

const users: TestUser[] = []
const contexts: BrowserContext[] = []

test.afterAll(async () => {
  for (const context of contexts) await context.close()
  for (const user of users) await deleteUser(user.id)
})

async function open(
  browser: Browser,
  viewport: { width: number; height: number },
  locale: Locale,
  displayName: string,
): Promise<{ page: Page; user: TestUser }> {
  const user = await createUser(`m3done-${locale}`, { locale: 'en' })
  users.push(user)
  return { page: await openAs(browser, user, viewport, locale, displayName), user }
}

async function openAs(
  browser: Browser,
  user: TestUser,
  viewport: { width: number; height: number },
  locale: Locale,
  displayName: string,
): Promise<Page> {
  const context = await browser.newContext({
    baseURL,
    locale: locale === 'ar' ? 'ar-AE' : 'en-US',
    viewport,
    acceptDownloads: true,
  })
  contexts.push(context)
  await useLanguage(context, 'en')
  const page = await context.newPage()
  // Leaving a file read and not sent asks first (D-161): the import tests leave some on purpose.
  page.on('dialog', (dialog) => void dialog.accept())
  await signIn(page, user)
  await ok(callApi(page, 'account.updateProfile', { displayName }), 'updateProfile')
  if (locale === 'ar') await setLanguage(page, 'ar')
  return page
}

async function ok<T>(pending: Promise<{ data?: T; appCode?: string }>, what: string): Promise<T> {
  const result = await pending
  expect(result.appCode, what).toBeUndefined()
  return result.data as T
}

/** The page is in `locale`, fits its width and shows no untranslated key. */
async function expectSound(page: Page, locale: Locale) {
  const seen = await auditScreen(page)
  expect(seen.lang).toBe(locale)
  expect(seen.dir).toBe(locale === 'ar' ? 'rtl' : 'ltr')
  expect(seen.sideways).toBeLessThanOrEqual(0)
  expect(seen.outside).toEqual([])
  expect(seen.text).not.toMatch(RAW_KEY)
}

// ---------------------------------------------------------------------------------------------------
// Days, amounts and words as the pages write them
// ---------------------------------------------------------------------------------------------------

/** `day` moved by `days` (YYYY-MM-DD). */
function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/** The month (YYYY-MM) `months` after `month`'s (before, when negative). */
function addMonths(month: string, months: number): string {
  const date = new Date(`${month.slice(0, 7)}-01T00:00:00Z`)
  date.setUTCMonth(date.getUTCMonth() + months)
  return date.toISOString().slice(0, 7)
}

/** Day `n` of `month`. */
const dayOf = (month: string, n: number) => `${month}-${String(n).padStart(2, '0')}`

/** How many days `month` has. */
const daysIn = (month: string) => Number(addDays(`${addMonths(month, 1)}-01`, -1).slice(8, 10))

/** The last day of `month`. */
const lastOf = (month: string) => dayOf(month, daysIn(month))

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The marks a page puts around numbers and names (isolates, direction marks, no-break spaces). */
const MARKS = '[\\s\\u00a0\\u200e\\u200f\\u2066-\\u2069]*'

/** An amount as the page writes it: "AED 6.00" in English; in Arabic, its number and «د.إ.». */
function money(locale: Locale, value: string): RegExp {
  return locale === 'ar'
    ? new RegExp(`${escape(value)}${MARKS}د\\.إ\\.`)
    : new RegExp(`AED${MARKS}${escape(value)}`)
}

/** A negative amount as the English page writes it: "-AED 19.05". */
const less = (value: string) => new RegExp(`-AED${MARKS}${escape(value)}`)

/** A percentage as the page writes it ("25%", in Arabic with its direction marks). */
const percent = (value: string) => new RegExp(`${escape(value)}${MARKS}%`)

const intl = (locale: Locale) => (locale === 'ar' ? 'ar-AE-u-nu-latn' : 'en-AE')

/** A month's name ("September 2026", or "September" alone) in `locale`. */
function monthName(locale: Locale, month: string, withYear = true): string {
  return new Intl.DateTimeFormat(intl(locale), {
    month: 'long',
    ...(withYear ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  }).format(new Date(`${month.slice(0, 7)}-01T00:00:00Z`))
}

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩'

/** `value` written in Arabic-Indic digits, with the Arabic decimal and thousands separators. */
function arabic(value: string): string {
  return value
    .replace(/\d/g, (d) => ARABIC_DIGITS[Number(d)]!)
    .replace('.', '٫')
    .replace(/,/g, '٬')
}

/** Sums the amounts written in `locators` ("AED 1,234.50" each). */
async function sumOf(locators: Locator): Promise<string> {
  const texts = await locators.allInnerTexts()
  const cents = texts.reduce((sum, text) => {
    const number = /-?[\d,]+\.\d\d/.exec(text.replace(/[\u200e\u200f\u2066-\u2069]/g, ''))?.[0]
    if (!number) throw new Error(`no amount in "${text}"`)
    return sum + Math.round(Number(number.replace(/,/g, '')) * 100)
  }, 0)
  return `${Math.floor(cents / 100).toLocaleString('en-US')}.${String(cents % 100).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------------------------------
// Businesses and what they hold, through the API
// ---------------------------------------------------------------------------------------------------

/** The procedures of one business, as the page's user. */
function api(page: Page, businessId: string) {
  return {
    id: businessId,
    page,
    call: <T = unknown>(path: string, input: unknown) =>
      ok(callApi<T>(page, path, input, { businessId }), path),
    query: <T = unknown>(path: string, input: unknown = {}) =>
      ok(callApi<T>(page, path, input, { businessId, query: true }), path),
    raw: (path: string, input: unknown) => callApi(page, path, input, { businessId }),
  }
}

type Api = ReturnType<typeof api>

/** Creates a business through Smart Setup's confirm step in `locale` (its starter names' language). */
async function business(
  page: Page,
  legalName: string,
  answers: Record<string, unknown>,
  locale: Locale = 'en',
): Promise<Api> {
  const created = await ok(
    callApi<{ businessId: string }>(page, 'business.createFromSetup', {
      businessId: randomUUID(),
      legalName,
      locale,
      questionSetVersion: 1,
      answers,
      adjustments: { modules: [], capabilities: [] },
    }),
    'business.createFromSetup',
  )
  return api(page, created.businessId)
}

async function todayOf(b: Api): Promise<string> {
  return (await b.query<{ today: string }>('books.get')).today
}

async function channels(b: Api) {
  return (
    await b.query<{ data: { items: { id: string; kind: string; name: string }[] } }>(
      'channel.list',
      { status: 'active' },
    )
  ).data.items
}

/** The business's own first channel (its shop, or its messages). */
async function ownChannel(b: Api): Promise<string> {
  const all = await channels(b)
  return (all.find((channel) => channel.kind === 'shop') ?? all[0]!).id
}

async function deliveryApp(b: Api, name: string, feePercent: string): Promise<string> {
  const id = randomUUID()
  await b.call('channel.create', { id, name, kind: 'delivery_app', feePercent })
  return id
}

/** A finalized purchase without an invoice, paid in cash; its id. */
async function buy(b: Api, businessDate: string, lines: object[]): Promise<string> {
  const id = randomUUID()
  const draft = await b.call<{ data: { version: number } }>('purchase.create', {
    id,
    businessDate,
    documentType: 'no_invoice',
    paymentMethod: 'cash',
    lines: lines.map((line) => ({ kind: 'material', id: randomUUID(), vatRate: '0', ...line })),
  })
  await b.call('purchase.post', { id, version: draft.data.version })
  return id
}

async function material(b: Api, name: string, unit: string, packs: object[] = []) {
  const id = randomUUID()
  await b.call('material.create', { id, name, unit, packs })
  return id
}

async function product(b: Api, name: string, price: string, extra: object = {}) {
  const id = randomUUID()
  await b.call('product.create', {
    id,
    name,
    type: 'product',
    unit: 'piece',
    defaultPrice: price,
    ...extra,
  })
  return id
}

const service = (b: Api, name: string, price: string) =>
  product(b, name, price, { type: 'service' })

/** A product at `price` made of one piece of a material bought on `day` at `cost` a piece. */
async function madeOf(b: Api, name: string, price: string, cost: string, day: string) {
  const kit = await material(b, `${name} kit`, 'piece')
  await buy(b, day, [{ materialId: kit, qty: '5000', unit: 'piece', unitPrice: cost }])
  const id = await product(b, name, price)
  await b.call('recipe.save', {
    productId: id,
    version: 0,
    lines: [{ id: randomUUID(), materialId: kit, qty: '1', unit: 'piece' }],
  })
  return id
}

/**
 * The Spanish Latte of M2 (18 g of beans, 200 ml of milk, 25 ml of condensed milk, a cup, a lid and a
 * straw), bought on `day`: its materials cost 3.002034632035 a cup.
 */
async function spanishLatte(b: Api, name: string, day: string): Promise<string> {
  const bag = randomUUID()
  const bottle = randomUUID()
  const carton = randomUUID()
  const can = randomUUID()
  const box = randomUUID()
  const sleeve = randomUUID()
  const lidBox = randomUUID()
  const strawPack = randomUUID()
  const beans = await material(b, 'Coffee beans', 'kg', [
    { id: bag, name: 'bag', qty: '1', ofUnit: 'kg' },
  ])
  const milk = await material(b, 'Milk', 'l', [
    { id: bottle, name: 'bottle', qty: '1', ofUnit: 'l' },
    { id: carton, name: 'carton', qty: '12', ofPackId: bottle },
  ])
  const condensed = await material(b, 'Condensed milk', 'l', [
    { id: can, name: 'can', qty: '385', ofUnit: 'ml' },
    { id: box, name: 'box', qty: '24', ofPackId: can },
  ])
  const cup = await material(b, 'Cup', 'piece', [
    { id: sleeve, name: 'sleeve', qty: '50', ofUnit: 'piece' },
  ])
  const lid = await material(b, 'Lid', 'piece', [
    { id: lidBox, name: 'box', qty: '100', ofUnit: 'piece' },
  ])
  const straw = await material(b, 'Straw', 'piece', [
    { id: strawPack, name: 'pack', qty: '200', ofUnit: 'piece' },
  ])
  await buy(b, day, [
    { materialId: beans, qty: '2', packId: bag, unitPrice: '65' },
    { materialId: milk, qty: '1', packId: carton, unitPrice: '72' },
    { materialId: condensed, qty: '1', packId: box, unitPrice: '95' },
    { materialId: cup, qty: '2', packId: sleeve, unitPrice: '12.5' },
    { materialId: lid, qty: '1', packId: lidBox, unitPrice: '9' },
    { materialId: straw, qty: '1', packId: strawPack, unitPrice: '7' },
  ])
  const latte = await product(b, name, '18')
  await b.call('recipe.save', {
    productId: latte,
    version: 0,
    lines: [
      { id: randomUUID(), materialId: beans, qty: '18', unit: 'g' },
      { id: randomUUID(), materialId: milk, qty: '200', unit: 'ml' },
      { id: randomUUID(), materialId: condensed, qty: '25', unit: 'ml' },
      { id: randomUUID(), materialId: cup, qty: '1', unit: 'piece' },
      { id: randomUUID(), materialId: lid, qty: '1', unit: 'piece' },
      { id: randomUUID(), materialId: straw, qty: '1', unit: 'piece' },
    ],
  })
  return latte
}

/** A category of the business by its starter name ("Rent", "Other"…). */
async function category(b: Api, name: string): Promise<string> {
  const categories = await b.query<{ items: { id: string; name: string }[] }>('costCategory.list', {
    limit: 100,
  })
  // A business set up in Arabic names its starter categories in Arabic: any one will do there.
  const found = categories.items.find((c) => c.name === name) ?? categories.items[0]
  if (!found) throw new Error(`no category ${name}`)
  return found.id
}

/** A running cost of `amount` a month from `startsOn`. */
async function monthly(b: Api, name: string, amount: string, startsOn: string, kind = 'Rent') {
  await b.call('runningCost.create', {
    id: randomUUID(),
    name,
    categoryId: await category(b, kind),
    amount,
    frequency: 'monthly',
    startsOn,
  })
}

interface Sale {
  id: string
  version: number
  businessDate: string
  lines: { id: string; kind: string }[]
}

const item = (productId: string, qty: string, unitPrice: string, extra: object = {}) => ({
  kind: 'item',
  id: randomUUID(),
  productId,
  qty,
  unitPrice,
  ...extra,
})

/** A sale (One sale unless `source` says otherwise), finalized unless `post` is false. */
async function sell(b: Api, input: object, post = true): Promise<Sale> {
  const draft = (
    await b.call<{ data: Sale }>('sale.create', { id: randomUUID(), source: 'single', ...input })
  ).data
  if (!post) return draft
  return (await b.call<{ data: Sale }>('sale.post', { id: draft.id, version: draft.version })).data
}

/** Opens Reports → Real profit for `query` (period, by…). */
async function report(page: Page, b: Api, query: string) {
  await page.goto(`/b/${b.id}/reports/profit?${query}`)
  await expect(page.locator('[data-profit-summary]')).toBeVisible()
}

/** A group's row (a table from 1280 px, a card below it). */
const group = (page: Page, key: string) => page.locator(`[data-profit-group="${key}"]`)

/** One of a group's figures (on a card, its parts open). */
async function figure(page: Page, key: string, part: string): Promise<Locator> {
  const row = group(page, key)
  const summary = row.locator('summary')
  if ((await summary.count()) > 0 && !(await row.locator('details').getAttribute('open'))) {
    await summary.click()
  }
  return row.locator(`[data-figure="${part}"]`)
}

// ---------------------------------------------------------------------------------------------------
// The café's September, end to end
// ---------------------------------------------------------------------------------------------------

/** A café with a team, two branches and a delivery app, not VAT-registered. */
const CAFE_ANSWERS = {
  what_you_do: ['food_drinks'],
  workplace: 'shop',
  branches: true,
  team: 'team',
  team_tracking: ['hours'],
  work_setup: ['stock'],
  sales_channels: ['walk_in', 'online'],
  pos: false,
  vat: 'no',
}

interface Cafe {
  b: Api
  today: string
  last: string
  talabat: string
  marina: string
  platter: string
  latte: string
}

let moonCafe: Cafe

/**
 * The café's last full month: running costs of 20,000 a month; platters at 100.00 made of a kit bought
 * at 30.00 (materials 30 %), 700 dine-in at its first branch and 100 on Talabat (20 % commission) at
 * the Marina branch: item sales 80,000, materials 24,000; a first sale the month before (so last month
 * is a month of its own). Its Spanish Latte (3.002034632035 a cup) at 18.00.
 */
async function cafeMonth(page: Page): Promise<Cafe> {
  const b = await business(page, 'Moon Café', CAFE_ANSWERS)
  const today = await todayOf(b)
  const last = addMonths(today, -1)
  const before = addMonths(today, -2)
  const marina = randomUUID()
  await b.call('location.create', { id: marina, name: 'Marina branch' })
  const talabat = await deliveryApp(b, 'Talabat', '20')
  const shop = await ownChannel(b)
  await monthly(b, 'Shop rent', '20000', dayOf(addMonths(today, -3), 1))
  const platter = await madeOf(b, 'Mezze platter', '100', '30', dayOf(before, 1))
  const latte = await spanishLatte(b, 'Spanish Latte', dayOf(before, 1))
  await sell(b, {
    channelId: shop,
    businessDate: dayOf(before, 10),
    lines: [item(platter, '1', '100')],
  })
  await sell(b, {
    source: 'day_sheet',
    channelId: shop,
    businessDate: dayOf(last, 2),
    lines: [item(platter, '700', '100')],
  })
  await sell(b, {
    channelId: talabat,
    locationId: marina,
    businessDate: dayOf(last, 3),
    lines: [item(platter, '100', '100')],
  })
  return { b, today, last, talabat, marina, platter, latte }
}

test('DoD: the café’s last full month in English on a desktop: 25 %, Talabat’s fees counted once, real profit 34,200.00 on the Dashboard, in Reports by month, week, product, channel and branch, and on Product costs', async ({
  browser,
}) => {
  test.setTimeout(600_000)
  const { page } = await open(browser, DESKTOP, 'en', 'Khalid')
  moonCafe = await cafeMonth(page)
  const { b, last, today, talabat, marina, platter, latte } = moonCafe
  const month = monthName('en', last)

  // With only Talabat's commission of 20 %: fees 2,000, real profit 34,000.
  await report(page, b, 'period=last_month&by=channel')
  await expect(page.locator('[data-part="fees"]')).toContainText(money('en', '2,000.00'))
  await expect(page.locator('[data-summary="profit"]')).toContainText(money('en', '34,000.00'))
  await expect(await figure(page, talabat, 'fees')).toContainText(money('en', '2,000.00'))

  // Talabat's commission tax invoice of 1,800, entered as an expense marked "App fees of Talabat".
  await page.goto(`/b/${b.id}/expenses/new`)
  await page.getByRole('textbox', { name: 'Amount' }).fill('1800')
  await page
    .getByRole('combobox', { name: 'Category', exact: true })
    .selectOption({ label: 'Other' })
  await page.getByRole('combobox', { name: 'For which month?' }).selectOption(last)
  const fees = page.locator(`[data-pays-option="fees:${talabat}"]`)
  await expect(fees).toContainText('App fees of')
  await expect(fees).toContainText("It isn't added to your running costs.")
  await fees.click()
  await page.getByRole('combobox', { name: 'How it was paid' }).selectOption({ label: 'Cash' })
  await page.getByRole('button', { name: 'Finalize' }).click()
  await page
    .getByRole('alertdialog', { name: 'Finalize this expense?' })
    .getByRole('button', { name: 'Finalize' })
    .click()
  await expect(page.getByText('Expense finalized.')).toBeVisible()

  // The business: 80,000 − materials 24,000 − fees 1,800 − running costs 20,000 = 34,200 (42.75 %).
  // The fees count once, never also in running costs: the month's costs stay 20,000 at 25 %.
  await report(page, b, 'period=last_month&by=month')
  const summary = page.locator('[data-summary="profit"]')
  await expect(summary).toContainText(money('en', '34,200.00'))
  await expect(summary).toContainText(`${'42.8%'} of your sales`)
  await expect(page.locator('[data-part="sales"]')).toContainText(money('en', '80,000.00'))
  await expect(page.locator('[data-part="materials"]')).toContainText(money('en', '24,000.00'))
  await expect(page.locator('[data-part="fees"]')).toContainText(money('en', '1,800.00'))
  await expect(page.locator('[data-part="running"]')).toContainText(money('en', '20,000.00'))
  await expect(page.locator('[data-part="profit"]')).toContainText(money('en', '34,200.00'))
  const rate = page.locator(`[data-profit-month="${last}"]`)
  await expect(rate).toContainText(
    `${month}: its costs AED 20,000.00 ÷ its sales AED 80,000.00 = 25% of each sale's price.`,
  )
  // The shares of a finished month add up to its costs: nothing "not carried by sales".
  await expect(rate.locator('[data-not-carried]')).toHaveCount(0)
  await expect(await figure(page, last, 'profit')).toContainText(money('en', '34,200.00'))
  await expectSound(page, 'en')

  // The same 34,200.00 by week, product, channel and branch: the groups carry it all.
  await report(page, b, 'period=last_month&by=week')
  expect(await sumOf(page.locator('[data-profit-group] [data-figure="profit"]'))).toBe('34,200.00')
  await report(page, b, 'period=last_month&by=product')
  await expect(await figure(page, platter, 'profit')).toContainText(money('en', '34,200.00'))
  await report(page, b, 'period=last_month&by=channel')
  const shop = await ownChannel(b)
  // Dine-in carries no app fees.
  await expect(await figure(page, shop, 'fees')).toContainText(money('en', '0.00'))
  await expect(await figure(page, shop, 'profit')).toContainText(money('en', '31,500.00'))
  await expect(await figure(page, talabat, 'fees')).toContainText(money('en', '1,800.00'))
  await expect(await figure(page, talabat, 'profit')).toContainText(money('en', '2,700.00'))
  await report(page, b, 'period=last_month&by=branch')
  await expect(await figure(page, marina, 'profit')).toContainText(money('en', '2,700.00'))
  expect(await sumOf(page.locator('[data-profit-group] [data-figure="profit"]'))).toBe('34,200.00')
  await expect(page.locator('[data-branch-rate]')).toBeVisible()
  await expectSound(page, 'en')

  // The Dashboard: last month's real profit and sales.
  await page.goto(`/b/${b.id}`)
  const cards = onScreen(page.locator('[data-decision-cards]'))
  await expect(cards.locator('[data-card="profit"]')).toContainText(/Last month: AED\s34,200\.00/)
  await expect(cards.locator('[data-card="sales"]')).toContainText(/Last month: AED\s80,000\.00/)

  // Product costs: a platter carries 25 % of its price; the Spanish Latte 4.50, and at materials of
  // 3.002034632035 (shown 3.00) it earns 18.00 − 3.00 − 4.50 = 10.50 dine-in.
  await page.goto(`/b/${b.id}/product-costs/${platter}`)
  await expect(page.locator('[data-line="running"] [data-share]')).toHaveText(
    `AED 25.00 · 25% of its price (${monthName('en', last)})`,
  )
  await page.goto(`/b/${b.id}/product-costs/${latte}`)
  await expect(page.locator('[data-line="running"] [data-share]')).toHaveText(
    `AED 4.50 · 25% of its price (${monthName('en', last)})`,
  )
  await expect(page.locator('[data-line="running"] [data-basis]')).toHaveText(
    `At ${monthName('en', last, false)}'s rate until ${monthName('en', today, false)} ends.`,
  )
  await expect(page.locator('[data-line="materials"]')).toContainText(money('en', '3.00'))
  await expect(page.locator('[data-line="margin"]')).toContainText(money('en', '10.50'))
  await expectSound(page, 'en')
})

/**
 * The Spanish Latte's month: running costs of 20,000 a month; item sales of 80,000: catering at 1.00
 * dine-in (70,000) and, on Talabat (20 % commission), one latte with catering (10,000).
 */
async function latteMonth(page: Page) {
  const b = await business(page, 'مقهى ركن البن', CAFE_ANSWERS, 'ar')
  const today = await todayOf(b)
  const last = addMonths(today, -1)
  const before = addMonths(today, -2)
  const talabat = await deliveryApp(b, 'طلبات', '20')
  const shop = await ownChannel(b)
  await monthly(b, 'إيجار المحل', '20000', dayOf(addMonths(today, -3), 1))
  const latte = await spanishLatte(b, 'سبانش لاتيه', dayOf(before, 1))
  const catering = await service(b, 'تموين', '1')
  await sell(b, {
    channelId: shop,
    businessDate: dayOf(before, 5),
    lines: [item(catering, '1', '1')],
  })
  await sell(b, {
    channelId: shop,
    businessDate: dayOf(last, 4),
    lines: [item(catering, '70000', '1')],
  })
  await sell(b, {
    channelId: talabat,
    businessDate: dayOf(last, 5),
    lines: [item(latte, '1', '18'), item(catering, '9982', '1')],
  })
  return { b, today, last, talabat, latte }
}

test('DoD: the Spanish Latte on Talabat in Arabic on a phone: 3.60 by the commission, 3.24 and 7.26 once the month’s statement is posted (typed in Arabic-Indic digits), and the café’s 34,200.00', async ({
  browser,
}) => {
  test.setTimeout(600_000)
  const { page } = await open(browser, PHONE, 'ar', 'خالد')
  const { b, last, talabat, latte } = await latteMonth(page)

  // With only Talabat's commission of 20 %: the latte carries 3.60 of fees and 4.50 of running costs,
  // and earns 18.00 − 3.00 − 3.60 − 4.50 = 6.90.
  await report(page, b, 'period=last_month&by=product')
  await expect(await figure(page, latte, 'fees')).toContainText(money('ar', '3.60'))
  await expect(await figure(page, latte, 'running')).toContainText(money('ar', '4.50'))
  await expect(await figure(page, latte, 'materials')).toContainText(money('ar', '3.00'))
  await expect(group(page, latte)).toContainText(money('ar', '6.90'))
  await expectSound(page, 'ar')

  // Talabat's statement of the month, typed in Arabic-Indic digits: fees 1,800 on sales of 10,000.
  await page.goto(`/b/${b.id}/settings/channels`)
  await page.locator('[data-channel="طلبات"] [data-channel-statements]').click()
  await expect(page).toHaveURL(new RegExp(`/settings/channels/${talabat}$`))
  await page.locator('[data-statement-add]').first().click()
  const form = page.getByRole('dialog')
  await form.locator('[data-statement-field="from"]').fill(dayOf(last, 1))
  await form.locator('[data-statement-field="to"]').fill(lastOf(last))
  await form.locator('[data-statement-field="sales"]').fill(arabic('10,000'))
  await form.locator('[data-statement-field="commission"]').fill(arabic('1,800'))
  await expectSound(page, 'ar')
  await form.locator('[data-statement-finalize]').click()
  await expect(form).toBeHidden()
  await expect(page.locator('[data-statement="posted"]')).toHaveCount(1)
  await expect(page.locator('[data-statement="posted"] [data-statement-fees]')).toContainText(
    money('ar', '1,800.00'),
  )

  // 1,800 ÷ 10,000 = 18 %: the latte carries 3.24 and earns 7.26.
  await report(page, b, 'period=last_month&by=product')
  await expect(await figure(page, latte, 'fees')).toContainText(money('ar', '3.24'))
  await expect(group(page, latte)).toContainText(money('ar', '7.26'))
  await report(page, b, 'period=last_month&by=channel')
  await expect(await figure(page, talabat, 'fees')).toContainText(money('ar', '1,800.00'))
  await expect(await figure(page, await ownChannel(b), 'fees')).toContainText(money('ar', '0.00'))
  await expectSound(page, 'ar')

  // Its Product costs, in Arabic: 4.50 · 25 % of its price, 10.50 dine-in.
  await page.goto(`/b/${b.id}/product-costs/${latte}`)
  await expect(page.locator('[data-line="running"] [data-share]')).toContainText(
    money('ar', '4.50'),
  )
  await expect(page.locator('[data-line="running"] [data-share]')).toContainText(percent('25'))
  await expect(page.locator('[data-line="running"] [data-share]')).toContainText(
    monthName('ar', last),
  )
  await expect(page.locator('[data-line="margin"]')).toContainText(money('ar', '10.50'))
  await expectSound(page, 'ar')

  // The café of the test before, read by its owner in Arabic on a phone: 34,200.00 on the Dashboard,
  // by channel and by branch.
  const { b: cafe, talabat: moonTalabat, marina } = moonCafe
  const owner = cafe.page
  await setLanguage(owner, 'ar')
  await owner.setViewportSize(PHONE)
  await owner.goto(`/b/${cafe.id}`)
  await expect(onScreen(owner.locator('[data-card="profit"]'))).toContainText(
    money('ar', '34,200.00'),
  )
  await expectSound(owner, 'ar')
  await report(owner, cafe, 'period=last_month&by=channel')
  await expect(owner.locator('[data-summary="profit"]')).toContainText(money('ar', '34,200.00'))
  await expect(owner.locator('[data-summary="profit"]')).toContainText(percent('42.8'))
  await expect(await figure(owner, moonTalabat, 'fees')).toContainText(money('ar', '1,800.00'))
  await expect(group(owner, moonTalabat)).toContainText(money('ar', '2,700.00'))
  await report(owner, cafe, 'period=last_month&by=branch')
  await expect(group(owner, marina)).toContainText(money('ar', '2,700.00'))
  await expectSound(owner, 'ar')
})

// ---------------------------------------------------------------------------------------------------
// The running month and a first month
// ---------------------------------------------------------------------------------------------------

/** A business day as the page writes it (the browser's own date words). */
async function dateIn(page: Page, locale: Locale, day: string): Promise<string> {
  return page.evaluate(
    ([tag, value]) =>
      new Intl.DateTimeFormat(tag, { dateStyle: 'medium', timeZone: 'UTC' }).format(
        new Date(`${value}T00:00:00Z`),
      ),
    [intl(locale), day] as const,
  )
}

/** `total` × `days` ÷ `of`, in whole fils, rounded half up ("13,548.39"), as the page says it. */
function share(total: number, days: number, of: number): string {
  const cents = Math.floor((total * 100 * days * 2 + of) / (2 * of))
  return `${Math.floor(cents / 100).toLocaleString('en-US')}.${String(cents % 100).padStart(2, '0')}`
}

/** A café with a team, one location, not VAT-registered. */
const SHOP_ANSWERS = {
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

/** Switches modules off through Customize BizCost. */
async function switchOff(b: Api, ids: string[]) {
  for (const id of ids) {
    await b.call('business.customize', { item: { kind: 'module', id }, enabled: false })
  }
}

test('DoD: the running month at last month’s rate with its costs so far, a first month “from your first sale”, “before running costs” for 7 days, and “off”', async () => {
  test.setTimeout(600_000)
  // The café of the first test, this month: a latte today carries 4.50, at last month's rate until
  // this month ends; the business takes off its costs so far, not the whole month's.
  const { b: cafe, today, last, latte } = moonCafe
  const page = cafe.page
  await setLanguage(page, 'en')
  await page.setViewportSize(DESKTOP)
  const month = today.slice(0, 7)
  await sell(cafe, {
    channelId: await ownChannel(cafe),
    businessDate: today,
    lines: [item(latte, '1', '18')],
  })
  await report(page, cafe, 'period=this_month&by=product')
  const rate = page.locator(`[data-profit-month="${month}"]`)
  await expect(rate).toContainText(
    `${monthName('en', month)}: at ${monthName('en', last, false)}'s rate until ${monthName('en', month, false)} ends: AED 20,000.00 ÷ AED 80,000.00 = 25% of each sale's price.`,
  )
  await expect(await figure(page, latte, 'running')).toContainText(money('en', '4.50'))
  const soFar = share(20000, Number(today.slice(8, 10)), daysIn(month))
  await expect(rate).toContainText(
    `${monthName('en', month)}: your costs for these days, AED ${soFar}, come off your profit.`,
  )
  await expect(page.locator('[data-part="running"]')).toContainText(money('en', soFar))
  await page.goto(`/b/${cafe.id}`)
  await expect(onScreen(page.locator('[data-card="profit"] [data-costs-so-far]'))).toHaveText(
    `Running costs so far: AED\u00a0${soFar}`,
  )
  await expectSound(page, 'en')

  // A first month that is over: its first sale 15 days before its end, and the month's rent bill of
  // 200 a day: 15 days of it, 3,000, ÷ its 12,000 of sales = 25 %, "from your first sale".
  const first = await business(page, 'Corner Kiosk', SHOP_ANSWERS)
  const days = daysIn(last)
  const opened = dayOf(last, days - 14)
  const bill = randomUUID()
  const draft = await first.call<{ data: { version: number } }>('expense.create', {
    id: bill,
    categoryId: await category(first, 'Rent'),
    businessDate: opened,
    periodMonth: last,
    documentType: 'no_invoice',
    paymentMethod: 'cash',
    amount: String(days * 200),
    description: 'Kiosk rent',
  })
  await first.call('expense.post', { id: bill, version: draft.data.version })
  const catering = await service(first, 'Catering', '12000')
  await sell(first, {
    channelId: await ownChannel(first),
    businessDate: opened,
    lines: [item(catering, '1', '12000')],
  })
  await report(page, first, 'period=last_month&by=month')
  await expect(page.locator(`[data-profit-month="${last}"]`)).toContainText(
    `${monthName('en', last)}: from your first sale on ${await dateIn(page, 'en', opened)} to the end of the month: AED 3,000.00 ÷ AED 12,000.00 = 25% of each sale's price.`,
  )
  await expect(page.locator('[data-summary="profit"]')).toContainText(money('en', '9,000.00'))

  // A first sale today: fewer than 7 days of sales, so "before running costs", never 800 ÷ 1,000.
  const fresh = await business(page, 'New Kiosk', SHOP_ANSWERS)
  await monthly(fresh, 'Kiosk rent', '800', dayOf(month, 1))
  const tea = await service(fresh, 'Karak', '1000')
  await sell(fresh, {
    channelId: await ownChannel(fresh),
    businessDate: today,
    lines: [item(tea, '1', '1000')],
  })
  await report(page, fresh, 'period=this_month&by=month')
  await expect(page.locator(`[data-profit-month="${month}"]`)).toContainText(
    `${monthName('en', month)}: before running costs. The percentage shows on ${await dateIn(page, 'en', addDays(today, 6))}, once you have 7 days of sales.`,
  )
  await expect(page.locator('[data-profit-month]')).not.toContainText(/80%/)
  await setLanguage(page, 'ar')
  await page.setViewportSize(PHONE)
  await report(page, fresh, 'period=this_month&by=month')
  await expect(page.locator(`[data-profit-month="${month}"]`)).toContainText(
    'قبل المصاريف التشغيلية',
  )
  await expectSound(page, 'ar')

  // With Running Costs and Expenses off: "off", and no running costs are counted.
  await switchOff(fresh, ['running_costs', 'expenses'])
  await report(page, fresh, 'period=this_month&by=month')
  await expect(page.locator('[data-profit-month]')).toHaveText(
    'المصاريف التشغيلية والمصروفات متوقفة، فلا تُحسب مصاريف تشغيلية.',
  )
  await setLanguage(page, 'en')
  await page.setViewportSize(DESKTOP)
  await report(page, fresh, 'period=this_month&by=month')
  await expect(page.locator('[data-profit-month]')).toHaveText(
    'Running Costs and Expenses are off, so no running costs are counted.',
  )
  await expect(page.locator('[data-summary="profit"]')).toContainText(money('en', '1,000.00'))
  await expectSound(page, 'en')
})

// ---------------------------------------------------------------------------------------------------
// The cost of what was sold is frozen on its day
// ---------------------------------------------------------------------------------------------------

/** A sale line's cost of what was sold, on the sale's page. */
const lineCost = (page: Page, name: string) =>
  page.locator('[data-sale-line]').filter({ hasText: name }).locator('[data-line-cost]')

test('DoD: the cost of what was sold is frozen on its day, and a sale before any purchase says “no price yet” until the first purchase fills it once', async ({
  browser,
}) => {
  test.setTimeout(600_000)
  const { page } = await open(browser, DESKTOP, 'en', 'Huda')
  const b = await business(page, 'Frozen Cup Café', SHOP_ANSWERS)
  const today = await todayOf(b)
  const shop = await ownChannel(b)
  const soldOn = addDays(today, -3)
  const latte = await spanishLatte(b, 'Spanish Latte', addDays(today, -20))
  const purchases = await b.query<{ data: { items: { id: string }[] } }>('purchase.list', {})
  const priced = purchases.data.items[0]!.id
  const sale = await sell(b, {
    channelId: shop,
    businessDate: soldOn,
    lines: [item(latte, '1', '18')],
  })
  await page.goto(`/b/${b.id}/sales/${sale.id}`)
  await expect(lineCost(page, 'Spanish Latte')).toContainText(money('en', '3.00'))

  // A milk purchase today at twice the price: the latte costs more from now on (AED 3.60)…
  await page.goto(`/b/${b.id}/purchases/new`)
  const line = page.getByRole('group', { name: 'Item 1' })
  await line.getByRole('combobox', { name: 'Ingredient or supply' }).fill('Milk')
  await line.getByRole('option', { name: 'Milk', exact: true }).click()
  await line.getByRole('textbox', { name: 'Quantity' }).fill('1')
  await line.getByRole('textbox', { name: 'Price per carton' }).fill('144')
  await page.getByRole('combobox', { name: 'How it was paid' }).selectOption({ label: 'Cash' })
  await page.getByRole('button', { name: 'Finalize', exact: true }).click()
  await page
    .getByRole('alertdialog', { name: 'Finalize this purchase?' })
    .getByRole('button', { name: 'Finalize' })
    .click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Purchase of /)
  await page.goto(`/b/${b.id}/product-costs`)
  await expect(
    page.locator('[data-product-cost-row="Spanish Latte"] [data-figure="cost"]'),
  ).toContainText(money('en', '3.60'))
  // … a purchase dated before the sale's day but posted after it is not in it either…
  const milk = (
    await b.query<{ items: { id: string; name: string }[] }>('material.list', {})
  ).items.find((m) => m.name === 'Milk')!.id
  await buy(b, addDays(soldOn, -1), [{ materialId: milk, qty: '12', unit: 'l', unitPrice: '20' }])
  // … nor does reversing the purchase it was costed from change it: the sale keeps 3.00.
  await page.goto(`/b/${b.id}/purchases/${priced}`)
  await page.getByRole('button', { name: 'Reverse', exact: true }).click()
  await page
    .getByRole('alertdialog', { name: 'Reverse this purchase?' })
    .getByRole('button', { name: 'Reverse' })
    .click()
  await expect(page.getByText('Reversed', { exact: true }).first()).toBeVisible()
  await page.goto(`/b/${b.id}/sales/${sale.id}`)
  await expect(lineCost(page, 'Spanish Latte')).toContainText(money('en', '3.00'))
  await expect(page.getByRole('main')).not.toContainText(/\bstock\b/i)
  await expectSound(page, 'en')

  // A sale of 500 cookies before any flour is bought: finalized (never refused for stock), its cost
  // "no price yet" (never 0), and real profit "not complete".
  const flour = await material(b, 'Flour', 'kg')
  const cookie = await product(b, 'Cookie', '5')
  await b.call('recipe.save', {
    productId: cookie,
    version: 0,
    lines: [{ id: randomUUID(), materialId: flour, qty: '100', unit: 'g' }],
  })
  const early = await sell(b, {
    channelId: shop,
    businessDate: today,
    lines: [item(cookie, '500', '5')],
  })
  await page.goto(`/b/${b.id}/sales/${early.id}`)
  await expect(lineCost(page, 'Cookie')).toContainText('no price yet')
  await expect(lineCost(page, 'Cookie')).not.toContainText(money('en', '0.00'))
  await expect(page.locator('[data-cost-total]')).toContainText('not complete yet')
  await report(page, b, 'period=this_month&by=product')
  await expect(page.locator('[data-summary-incomplete]')).toBeVisible()
  await expect(page.locator('[data-missing="unpriced_materials"]')).toBeVisible()

  // The first purchase of flour (4.50 a kg) fills it once: 500 × 100 g × 0.0045 = 225.00.
  await buy(b, today, [{ materialId: flour, qty: '20', unit: 'kg', unitPrice: '4.5' }])
  await page.goto(`/b/${b.id}/sales/${early.id}`)
  await expect(lineCost(page, 'Cookie')).toContainText(money('en', '225.00'))
  await report(page, b, 'period=this_month&by=product')
  await expect(page.locator('[data-missing="unpriced_materials"]')).toHaveCount(0)
  // A second purchase at twice the price never changes it again.
  await buy(b, today, [{ materialId: flour, qty: '20', unit: 'kg', unitPrice: '9' }])
  await page.goto(`/b/${b.id}/sales/${early.id}`)
  await expect(lineCost(page, 'Cookie')).toContainText(money('en', '225.00'))
  await expectSound(page, 'en')
})

// ---------------------------------------------------------------------------------------------------
// Today's sales
// ---------------------------------------------------------------------------------------------------

/** A home baker: alone, one location, not VAT-registered (Orders on). */
const HOME_ANSWERS = {
  what_you_do: ['food_drinks'],
  workplace: 'home',
  team: 'alone',
  work_setup: ['none'],
  sales_channels: ['messages'],
  vat: 'no',
}

test('DoD: Today’s sales of a home business for a whole month, typed in Arabic-Indic digits on a phone: one sale on its last day that covers the month', async ({
  browser,
}) => {
  test.setTimeout(600_000)
  const { page } = await open(browser, PHONE, 'ar', 'مريم')
  const b = await business(page, 'كيك مريم', HOME_ANSWERS, 'ar')
  const today = await todayOf(b)
  const last = addMonths(today, -1)
  await product(b, 'كيكة شوكولاتة', '150')
  await product(b, 'كوكيز', '5')
  const [from, to] = [dayOf(last, 1), lastOf(last)]

  // The sheet for several days of last month: its days said, its choices behind «تغيير».
  await page.goto(`/b/${b.id}/sales/today?date=${to}&from=${from}`)
  await expect(page.getByRole('heading', { level: 1, name: 'مبيعات اليوم' })).toBeVisible()
  await page.getByRole('button', { name: 'تغيير', exact: true }).click()
  await expect(page.getByRole('radio', { name: 'عدة أيام', exact: true })).toBeChecked()
  await expect(page.getByLabel('من', { exact: true })).toHaveValue(from)
  await expect(page.getByLabel('إلى', { exact: true })).toHaveValue(to)
  await page.getByRole('textbox', { name: /^عدد .*كيكة شوكولاتة/ }).fill(arabic('12'))
  await page.getByRole('textbox', { name: /^عدد .*كوكيز/ }).fill(arabic('40'))
  // 12 × 150 + 40 × 5 = 2,000.00 (no VAT: not registered).
  await expect(page.locator('[data-running-total]')).toHaveText(money('ar', '2,000.00'))
  await expect(page.getByRole('main')).not.toContainText('الضريبة')
  await expectSound(page, 'ar')
  await page.getByRole('button', { name: 'اعتمد نهائيًا' }).click()
  const confirm = page.getByRole('alertdialog')
  const fromText = await dateIn(page, 'ar', from)
  const toText = await dateIn(page, 'ar', to)
  await expect(confirm).toContainText(`كعملية بيع واحدة في ${toText}`)
  await expect(confirm).toContainText(`تشمل ${fromText} – ${toText}`)
  await confirm.getByRole('button', { name: 'اعتمد نهائيًا' }).click()
  await expect(page.getByText('هذه المبيعات نهائية')).toBeVisible()

  // One sale, dated the month's last day, covering it all.
  const sales = await b.query<{
    items: { businessDate: string; periodFrom: string | null }[]
  }>('sale.list', {})
  expect(sales.items.map((s) => [s.businessDate, s.periodFrom])).toEqual([[to, from]])
  await page.getByRole('link', { name: 'اعرض المبيعات' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    `مبيعات ${fromText} – ${toText}`,
  )
  await expect(
    page.getByText(`الأيام المُدخلة معًا تُحسب كعملية بيع واحدة في ${toText}.`),
  ).toBeVisible()
  await expectSound(page, 'ar')
  await page.goto(`/b/${b.id}/sales`)
  await expect(page.locator('[data-sale-row]')).toHaveCount(1)
  await expect(page.locator('[data-day-total]').first()).toContainText(money('ar', '2,000.00'))
  await expectSound(page, 'ar')
})

// ---------------------------------------------------------------------------------------------------
// The home baker's order #1001
// ---------------------------------------------------------------------------------------------------

/** A number as a sentence holds it: isolated, so it reads "#1001" in Arabic too. */
const isolated = (value: string) => `\u2068${value}\u2069`

test('DoD: the home baker’s order #1001 in English on a desktop: delivered on the 14th, −5 of delivery, 35.10; refunded 20 by amount: 150, 32.40, 20.10, nothing owed; undone and delivered again on the 16th; a cancelled deposit is money back until given back', async ({
  browser,
}) => {
  test.setTimeout(600_000)
  const { page } = await open(browser, DESKTOP, 'en', 'Maryam')
  const b = await business(page, 'Maryam Bakes', HOME_ANSWERS)
  const today = await todayOf(b)
  const last = addMonths(today, -1)
  const before = addMonths(today, -2)
  // Her hourly rate 40, running costs of 1,000 a month, the cake (a kit at 32.40, her 60 minutes),
  // a first sale the month before and 3,850 of other item sales last month: 4,000 with the cake.
  await b.call('productCost.updateSettings', { ownerHourlyRate: '40' })
  await monthly(b, 'Kitchen rent', '1000', dayOf(addMonths(today, -3), 1))
  const kit = await material(b, 'Cake ingredients', 'piece')
  await buy(b, dayOf(before, 1), [{ materialId: kit, qty: '50', unit: 'piece', unitPrice: '32.4' }])
  const cake = await product(b, 'Chocolate cake', '150', { ownerMinutes: '60' })
  await b.call('recipe.save', {
    productId: cake,
    version: 0,
    lines: [{ id: randomUUID(), materialId: kit, qty: '1', unit: 'piece' }],
  })
  const other = await service(b, 'Baking class', '1')
  const channel = await ownChannel(b)
  await sell(b, {
    channelId: channel,
    businessDate: dayOf(before, 3),
    lines: [item(other, '1', '1')],
  })
  await sell(b, {
    channelId: channel,
    businessDate: dayOf(last, 20),
    lines: [item(other, '3850', '1')],
  })
  const fatima = (
    await b.call<{ id: string }>('customer.create', {
      id: randomUUID(),
      name: 'Fatima',
      phone: '050 123 4567',
    })
  ).id
  const cakeOrder = (payment?: string) =>
    b.call<{ data: { id: string; version: number; number: string } }>('order.create', {
      id: randomUUID(),
      customerId: fatima,
      businessDate: dayOf(last, 10),
      dueDate: dayOf(last, 14),
      deliveryNeeded: true,
      deliveryArea: 'Al Barsha',
      deliveryCost: '25',
      lines: [item(cake, '1', '150'), { kind: 'delivery', id: randomUUID(), amount: '20' }],
      ...(payment
        ? { payment: { id: randomUUID(), method: 'bank_transfer', amount: payment } }
        : {}),
    })

  // #1001: the cake at 150, delivery charged 20 (it cost her 25), a deposit of 50: still owed 120,
  // and no VAT anywhere.
  const order = (await cakeOrder('50')).data
  expect(order.number).toBe('#1001')
  await page.goto(`/b/${b.id}/orders/${order.id}`)
  await expect(
    page.getByRole('heading', { level: 1, name: `Order ${isolated('#1001')}` }),
  ).toBeVisible()
  await expect(page.locator('[data-owed="owed"]')).toContainText(money('en', '120.00'))
  await expect(page.getByRole('main')).not.toContainText('VAT')

  // Delivered on the 14th: a sale of 170 that day; the delivery margin −5; real profit 35.10.
  await page.getByRole('button', { name: 'Deliver', exact: true }).click()
  const deliver = page.getByRole('alertdialog', { name: `Deliver order ${isolated('#1001')}?` })
  await deliver.getByLabel('Delivered on').fill(dayOf(last, 14))
  await expect(deliver).toContainText(money('en', '170.00'))
  await deliver.getByRole('button', { name: 'Deliver', exact: true }).click()
  await expect(page.locator('[data-order-status="delivered"]')).toBeVisible()
  await expect(page.locator('[data-delivery-margin]')).toHaveText(
    'You pay AED 5.00 of the delivery.',
  )
  const part = (id: string) => page.locator(`[data-part="${id}"]`)
  await expect(part('sales')).toContainText(money('en', '170.00'))
  await expect(part('materials')).toContainText(money('en', '32.40'))
  await expect(part('delivery')).toContainText(money('en', '25.00'))
  await expect(part('running')).toContainText(money('en', '37.50'))
  await expect(part('time')).toContainText(money('en', '40.00'))
  await expect(page.locator('[data-order-profit]')).toHaveText(money('en', '35.10'))
  await expect(page.getByRole('main')).not.toContainText('VAT')
  await expectSound(page, 'en')
  await report(page, b, 'period=last_month&by=day')
  await expect(group(page, dayOf(last, 14))).toContainText(money('en', '170.00'))

  // Paid in full, then a refund of 20 by amount for a damaged cake on the 15th, given back in cash
  // (20 more of other sales keep the month's item sales at 4,000): last month's sales from it 150,
  // its materials still 32.40, its real profit 20.10, nothing owed.
  await b.call('customerPayment.record', {
    id: randomUUID(),
    orderId: order.id,
    businessDate: dayOf(last, 14),
    method: 'card',
    amount: '120',
  })
  await sell(b, {
    channelId: channel,
    businessDate: dayOf(last, 20),
    lines: [item(other, '20', '1')],
  })
  await page.goto(`/b/${b.id}/orders/${order.id}`)
  await page.getByRole('button', { name: 'Refund', exact: true }).click()
  const refund = page.getByRole('dialog', { name: 'Refund' })
  await refund.locator('label').filter({ hasText: 'A price cut' }).click()
  await refund.getByRole('textbox', { name: 'How much off Chocolate cake' }).fill('20')
  await refund.getByLabel('Refund date').fill(dayOf(last, 15))
  await expect(refund.locator('[data-refund-total]')).toContainText(money('en', '20.00'))
  const back = refund.locator('[data-give-back]')
  await expect(back.getByRole('switch', { name: 'Give the money back now' })).toBeChecked()
  await back.getByRole('combobox').selectOption({ label: 'Cash' })
  await refund.getByRole('textbox', { name: 'Reason' }).fill('The cake was damaged')
  await refund.getByRole('button', { name: 'Record refund' }).click()
  await expect(refund).toBeHidden()
  await expect(part('sales')).toContainText(money('en', '150.00'))
  await expect(part('materials')).toContainText(money('en', '32.40'))
  await expect(part('running')).toContainText(money('en', '32.50'))
  await expect(page.locator('[data-order-profit]')).toHaveText(money('en', '20.10'))
  await expect(page.locator('[data-owed="owed"]')).toContainText(money('en', '0.00'))
  await report(page, b, 'period=last_month&by=order')
  await expect(group(page, order.id)).toContainText(money('en', '150.00'))
  await expect(await figure(page, order.id, 'profit')).toContainText(money('en', '20.10'))
  await expectSound(page, 'en')

  // #1002 delivered on the 14th, then undone: the 170 leaves that day; delivered again on the 16th,
  // it counts there.
  const second = (await cakeOrder()).data
  await b.call('order.deliver', {
    id: second.id,
    version: second.version,
    businessDate: dayOf(last, 14),
  })
  await report(page, b, 'period=last_month&by=day')
  await expect(group(page, dayOf(last, 14))).toContainText(money('en', '340.00'))
  await page.goto(`/b/${b.id}/orders/${second.id}`)
  await page.getByRole('button', { name: 'Undo delivery' }).click()
  await page
    .getByRole('alertdialog', { name: `Undo the delivery of order ${isolated('#1002')}?` })
    .getByRole('button', { name: 'Undo delivery' })
    .click()
  await expect(page.locator('[data-order-status="pending"]')).toBeVisible()
  await report(page, b, 'period=last_month&by=day')
  await expect(group(page, dayOf(last, 14))).toContainText(money('en', '170.00'))
  await page.goto(`/b/${b.id}/orders/${second.id}`)
  await page.getByRole('button', { name: 'Deliver', exact: true }).click()
  const again = page.getByRole('alertdialog', { name: `Deliver order ${isolated('#1002')}?` })
  await again.getByLabel('Delivered on').fill(dayOf(last, 16))
  await again.getByRole('button', { name: 'Deliver', exact: true }).click()
  await expect(page.locator('[data-order-status="delivered"]')).toBeVisible()
  await report(page, b, 'period=last_month&by=day')
  await expect(group(page, dayOf(last, 16))).toContainText(money('en', '170.00'))
  await expect(group(page, dayOf(last, 14))).toContainText(money('en', '170.00'))

  // A cancelled order with a deposit of 50: "money back to the customer: 50" until it is given back.
  const third = (await cakeOrder('50')).data
  await page.goto(`/b/${b.id}/orders/${third.id}`)
  await page.getByRole('button', { name: 'Cancel order' }).click()
  const cancel = page.getByRole('alertdialog', { name: `Cancel order ${isolated(third.number)}?` })
  await expect(cancel).toContainText('The customer paid AED 50.00 on it')
  await cancel.getByRole('button', { name: 'Cancel order' }).click()
  await expect(page.locator('[data-order-status="cancelled"]')).toBeVisible()
  await expect(page.locator('[data-owed="overpaid"]')).toContainText(money('en', '50.00'))
  await expect(
    page.getByText(
      'A deposit on a cancelled order is money back to the customer until you record giving it back.',
    ),
  ).toBeVisible()
  await page.goto(`/b/${b.id}/receivables`)
  await expect(page.getByRole('main')).toContainText(/money back owed: AED\s50\.00/)
  await page.goto(`/b/${b.id}/orders/${third.id}`)
  await page.getByRole('button', { name: 'Give money back' }).click()
  const giveBack = page.getByRole('dialog', { name: 'Give money back' })
  await expect(giveBack.getByRole('textbox', { name: 'Amount' })).toHaveValue('50.00')
  await giveBack
    .getByRole('combobox', { name: 'How you gave it back' })
    .selectOption({ label: 'Cash' })
  await giveBack.getByRole('button', { name: 'Record money given back' }).click()
  await expect(giveBack).toBeHidden()
  await expect(page.locator('[data-owed="overpaid"]')).toHaveCount(0)
  await expect(page.locator('[data-deposit-given-back]')).toBeVisible()
  // No VAT field anywhere in the order editor (not registered).
  await page.goto(`/b/${b.id}/orders/new`)
  await expect(page.getByRole('heading', { level: 1, name: 'New order' })).toBeVisible()
  await expect(page.getByRole('main')).not.toContainText('VAT')
  await expectSound(page, 'en')
})

// ---------------------------------------------------------------------------------------------------
// Nothing counts twice
// ---------------------------------------------------------------------------------------------------

/** A fit-out / decor project company with a team and VAT (Quotations and Invoices on). */
const FITOUT_ANSWERS = {
  what_you_do: ['projects'],
  workplace: 'customer_sites',
  branches: false,
  team: 'team',
  team_tracking: ['hours'],
  work_setup: ['materials'],
  vat: 'yes',
}

/** A small factory with a team and VAT, invoicing companies on credit with their LPOs. */
const FACTORY_ANSWERS = {
  what_you_do: ['make_products'],
  how_you_make: ['batches'],
  workplace: 'factory',
  branches: false,
  team: 'team',
  team_tracking: ['hours', 'salaries'],
  work_setup: ['stock', 'machines'],
  sales_channels: ['messages', 'quotes', 'invoice_later'],
  vat: 'yes',
}

/** A freelance designer: services only, alone, not VAT-registered, invoices later. */
const DESIGNER_ANSWERS = {
  what_you_do: ['services'],
  workplace: 'home',
  team: 'alone',
  work_setup: ['none'],
  sales_channels: ['messages', 'quotes', 'invoice_later'],
  vat: 'no',
}

/** The business's TRN and address, as Settings → Business saves them (a tax invoice needs both). */
async function taxReady(b: Api, legalName: string) {
  const profile = await b.query<{ version: number }>('business.profile')
  await b.call('business.updateProfile', {
    version: profile.version,
    legalName,
    legalNameAr: null,
    vatRegistered: true,
    trn: '100345678900003',
    letterhead: {
      phone: '+971 4 555 0142',
      phone2: null,
      email: 'hello@done.example',
      addressLine: 'Warehouse 7, Al Quoz Industrial 3',
      city: 'Dubai',
      emirate: 'dubai',
      tradeLicenceNo: 'DED-884210',
      tradeLicenceAuthority: 'Dubai DET',
    },
  })
}

/** A business customer registered for VAT, with its TRN and address. */
async function buyer(b: Api, name: string, extra: object = {}): Promise<string> {
  return (
    await b.call<{ id: string }>('customer.create', {
      id: randomUUID(),
      name,
      kind: 'business',
      trn: '100555666700003',
      addressLine: 'Office 1402, Marina Plaza',
      city: 'Dubai Marina',
      emirate: 'dubai',
      ...extra,
    })
  ).id
}

const typed = (description: string, qty: string, unitPrice: string, extra: object = {}) => ({
  id: randomUUID(),
  productId: null,
  description,
  qty,
  unitPrice,
  ...extra,
})

interface Invoice {
  id: string
  version: number
  number: string | null
  lines: { id: string; net: string }[]
}

async function issue(b: Api, draft: { id: string; version: number }): Promise<Invoice> {
  return b.call<Invoice>('invoice.issue', { id: draft.id, version: draft.version })
}

/** The sales a period of Reports → Real profit counts (before VAT), or "No sales in these days". */
async function salesOf(page: Page, b: Api, period: string): Promise<string | null> {
  await page.goto(`/b/${b.id}/reports/profit?period=${period}&by=month`)
  const summary = page.locator('[data-profit-summary]')
  const none = page.getByRole('heading', { name: 'No sales in these days' })
  await expect(summary.or(none)).toBeVisible()
  if (await none.isVisible()) return null
  return (await summary.locator('[data-summary="sales"]').innerText()).replace(/\s+/g, ' ')
}

test('DoD: nothing counts twice: an order and its invoice, a sale and its invoice, an invoice already in the recorded sales, a deposit and its final invoice, a credit note in its own month', async ({
  browser,
}) => {
  test.setTimeout(600_000)
  const { page } = await open(browser, DESKTOP, 'en', 'Saeed')

  // The factory's order of 10,000 delivered on the 15th of last month and invoiced today: last
  // month's sales are 10,000, not 20,000, and the invoice adds nothing to this month.
  const factory = await business(page, 'Al Noor Metal Works', FACTORY_ANSWERS)
  await taxReady(factory, 'Al Noor Metal Works')
  const today = await todayOf(factory)
  const last = addMonths(today, -1)
  const gulf = await buyer(factory, 'Gulf Build Contracting LLC')
  const frame = await product(factory, 'Steel frame', '100')
  const order = (
    await factory.call<{ data: { id: string; version: number; number: string } }>('order.create', {
      id: randomUUID(),
      customerId: gulf,
      customerRef: 'LPO-2231',
      businessDate: dayOf(last, 10),
      channelId: await ownChannel(factory),
      lines: [item(frame, '100', '100')],
    })
  ).data
  await factory.call('order.deliver', {
    id: order.id,
    version: order.version,
    businessDate: dayOf(last, 15),
  })
  const orderInvoice = await issue(
    factory,
    await factory.call<Invoice>('invoice.fromOrder', { orderId: order.id, newId: randomUUID() }),
  )
  expect(await salesOf(page, factory, 'last_month')).toMatch(/AED 10,000\.00/)
  expect(await salesOf(page, factory, 'this_month')).toBeNull()
  await page.goto(`/b/${factory.id}/invoices/${orderInvoice.id}`)
  await expect(page.locator('[data-invoice-counting]')).toHaveText(
    `Its sale counted when order ${isolated(order.number)} was delivered on ${await dateIn(page, 'en', dayOf(last, 15))}.`,
  )
  // A credit note of 1,000 before VAT lowers the sales of its own month (this one), not last month's.
  const credit = await factory.call<{ id: string; version: number }>('creditNote.create', {
    id: randomUUID(),
    invoiceId: orderInvoice.id,
    eventDate: today,
    reason: 'goods_returned',
    reasonText: '10 frames returned',
    by: 'quantity',
    lines: [{ invoiceLineId: orderInvoice.lines[0]!.id, qty: '10' }],
  })
  await factory.call('creditNote.issue', { id: credit.id, version: credit.version })
  expect(await salesOf(page, factory, 'this_month')).toMatch(/-AED 1,000\.00|AED -1,000\.00/)
  expect(await salesOf(page, factory, 'last_month')).toMatch(/AED 10,000\.00/)
  await expectSound(page, 'en')

  // The designer's One sale of 2,000 "they'll pay later", invoiced from the sale: her month's sales
  // stay 2,000, and what she is owed moves to the invoice.
  const designer = await business(page, 'Noura Design Studio', DESIGNER_ANSWERS)
  const bloom = (
    await designer.call<{ id: string }>('customer.create', {
      id: randomUUID(),
      name: 'Bloom Florists LLC',
      kind: 'business',
    })
  ).id
  const logo = await service(designer, 'Brand identity', '2000')
  const sale = await sell(designer, {
    channelId: await ownChannel(designer),
    businessDate: today,
    customerId: bloom,
    payLater: true,
    lines: [item(logo, '1', '2000')],
  })
  await page.goto(`/b/${designer.id}/receivables`)
  await expect(page.locator('[data-owed-document="sale"]')).toContainText(money('en', '2,000.00'))
  const fromSale = await issue(
    designer,
    await designer.call<Invoice>('invoice.fromSale', { saleId: sale.id, newId: randomUUID() }),
  )
  expect(await salesOf(page, designer, 'this_month')).toMatch(/AED 2,000\.00/)
  await page.goto(`/b/${designer.id}/receivables`)
  await expect(page.locator('[data-owed-document="sale"]')).toHaveCount(0)
  await expect(page.locator('[data-owed-document="invoice"]')).toContainText(
    fromSale.number ?? 'INV-0001',
  )
  await expect(page.locator('[data-receivables-total]')).toContainText(money('en', '2,000.00'))
  // An invoice of work she had already recorded, answered "already in my recorded sales": adds 0.
  const recorded = await issue(
    designer,
    await designer.call<Invoice>('invoice.create', {
      id: randomUUID(),
      customerId: bloom,
      countedElsewhere: true,
      lines: [typed('Social media pack', '1', '1200')],
    }),
  )
  await page.goto(`/b/${designer.id}/invoices/${recorded.id}`)
  await expect(page.locator('[data-invoice-counting]')).toHaveText(
    "It's already in your recorded sales, so it isn't counted again.",
  )
  expect(await salesOf(page, designer, 'this_month')).toMatch(/AED 2,000\.00/)

  // The fit-out's deposit invoice of 25 % adds 0; the final invoice adds the whole work, 20,000.
  const fitout = await business(page, 'Modern Touch Interiors', FITOUT_ANSWERS)
  await taxReady(fitout, 'Modern Touch Interiors')
  const towers = await buyer(fitout, 'Gulf Towers LLC')
  const quote = await fitout.call<{ id: string; version: number }>('quotation.create', {
    id: randomUUID(),
    customerId: towers,
    businessDate: today,
    lines: [typed('Office fit-out', '1', '20000')],
  })
  const sent = await fitout.call<{ id: string; version: number }>('quotation.send', {
    id: quote.id,
    version: quote.version,
  })
  await fitout.call('quotation.accept', { id: sent.id, version: sent.version, note: null })
  const deposit = await issue(
    fitout,
    await fitout.call<Invoice>('invoice.fromQuotation', {
      id: quote.id,
      newId: randomUUID(),
      bills: 'part',
      part: { percent: '25' },
      isDeposit: true,
    }),
  )
  await page.goto(`/b/${fitout.id}/invoices/${deposit.id}`)
  await expect(page.locator('[data-invoice-counting]')).toHaveText(
    'A deposit: the final invoice counts the whole work.',
  )
  expect(await salesOf(page, fitout, 'this_month')).toBeNull()
  await issue(
    fitout,
    await fitout.call<Invoice>('invoice.fromQuotation', {
      id: quote.id,
      newId: randomUUID(),
      bills: 'rest',
    }),
  )
  expect(await salesOf(page, fitout, 'this_month')).toMatch(/AED 20,000\.00/)
  await expectSound(page, 'en')
})

// ---------------------------------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------------------------------

/** A café with a team and a POS, VAT-registered, one location. */
const POS_CAFE_ANSWERS = {
  what_you_do: ['food_drinks'],
  workplace: 'shop',
  branches: false,
  team: 'team',
  team_tracking: ['hours'],
  work_setup: ['stock'],
  sales_channels: ['walk_in'],
  pos: true,
  vat: 'yes',
}

/** A file to pick: UTF-8 with a byte-order mark (as spreadsheets save Arabic), or `bytes` as given. */
function csvFile(name: string, lines: readonly string[], bytes?: Buffer) {
  return {
    name,
    mimeType: 'text/csv',
    buffer: bytes ?? Buffer.from(`\uFEFF${lines.join('\r\n')}\r\n`, 'utf8'),
  }
}

/** `text` in Windows-1256 (Arabic Windows), byte for byte, as Excel saves a CSV there. */
function windows1256(text: string): Buffer {
  const decoder = new TextDecoder('windows-1256')
  const table = new Map<string, number>()
  for (let byte = 0x80; byte <= 0xff; byte++) table.set(decoder.decode(Uint8Array.of(byte)), byte)
  return Buffer.from(
    [...text].map((char) => {
      const code = char.charCodeAt(0)
      if (code < 0x80) return code
      const byte = table.get(char)
      if (byte === undefined) throw new Error(`"${char}" is not in Windows-1256`)
      return byte
    }),
  )
}

/** Picks a file on the import page (once the page answers: a file set before it hydrates is lost). */
async function pickFile(page: Page, file: ReturnType<typeof csvFile>) {
  await expect(page.locator('[data-pick-file], [data-file-name]').first()).toBeVisible()
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.locator('input[type=file]').first().setInputFiles(file)
    try {
      await expect(page.locator('[data-file-name]')).toHaveText(file.name, { timeout: 3000 })
      return
    } catch {
      await page.waitForTimeout(500)
    }
  }
  await expect(page.locator('[data-file-name]')).toHaveText(file.name)
}

/** A summary file of one day through the import's steps: its columns, its day, VAT included. */
async function importSummary(page: Page, b: Api, file: ReturnType<typeof csvFile>, day: string) {
  await page.goto(`/b/${b.id}/sales/import`)
  await pickFile(page, file)
  await page.locator('[data-next]').click()
  await expect(page.locator('[data-read-summary]')).toBeVisible()
  await page.locator('[data-next]').click()
  await expect(page.getByRole('radio', { name: 'One day' })).toBeChecked()
  await page.locator('[data-field=day]').fill(day)
  await page.locator('[data-next]').click()
  await page.getByRole('radio', { name: 'Yes, they include VAT' }).check()
  await page.locator('[data-send]').click()
  await expect(page).toHaveURL(new RegExp(`/b/${b.id}/sales/import/[0-9a-f-]{36}$`))
}

async function finalizeImport(page: Page) {
  await page.locator('[data-finalize]').click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Finalize' }).click()
  await expect(page.getByText('Imported', { exact: true }).first()).toBeVisible()
}

test('DoD: import: Arabic headers and Arabic-Indic digits with VAT give 120 lattes at 2,160.00, the answer remembered, a Windows-1256 file read the same, "Did you mean", overlapping days skipped or replaced, and the Today’s sales warnings', async ({
  browser,
}) => {
  test.setTimeout(600_000)
  const { page } = await open(browser, DESKTOP, 'en', 'Omar')
  const b = await business(page, 'Bean Corner Café', POS_CAFE_ANSWERS)
  const today = await todayOf(b)
  const latte = await product(b, 'Spanish Latte', '18')
  const shop = await ownChannel(b)
  const [first, second] = [addDays(today, -5), addDays(today, -4)]
  // The second day was also entered in Today's sales.
  await sell(b, {
    source: 'day_sheet',
    channelId: shop,
    businessDate: second,
    lines: [item(latte, '2', '18')],
  })

  // A Loyverse-style summary with Arabic headers and Arabic-Indic digits, amounts with VAT:
  // «لاتيه إسباني ١٢٠ ٢٬٢٦٨٫٠٠». The name is answered as the Spanish Latte.
  const header = 'الصنف,الكمية,إجمالي المبيعات'
  await importSummary(
    page,
    b,
    csvFile('loyverse-ar.csv', [header, `لاتيه إسباني,${arabic('120')},"${arabic('2,268.00')}"`]),
    first,
  )
  const arabicName = page.locator('[data-import-name="لاتيه إسباني"]')
  await expect(arabicName).toContainText('Not settled')
  await expect(page.locator('[data-finalize]')).toBeDisabled()
  await arabicName.locator('[data-pick-product]').selectOption({ label: 'Spanish Latte' })
  await expect(page.getByText('Every name is settled.')).toBeVisible()
  // 120 lattes at 18.00 before VAT: 2,160.00.
  await expect(page.locator('[data-figure=sales-before-vat]')).toContainText(
    money('en', '2,160.00'),
  )
  await expectSound(page, 'en')
  await finalizeImport(page)
  // Today's sales of that day says the file has its sales already.
  await page.goto(`/b/${b.id}/sales/today?date=${first}`)
  await expect(
    page.getByText(/^A file imported for .*Shop.* already has sales of these days/),
  ).toBeVisible()

  // The next day's file, saved by Excel in Windows-1256 (its digits ASCII), with a new size of the
  // latte: the Arabic name is remembered and reads the same; "Spanish Latte L" is offered as "Did
  // you mean Spanish Latte?"; the day's sales in Today's sales are said.
  const lines = [header, 'لاتيه إسباني,120,2268.00', 'Spanish Latte L,10,189.00']
  await importSummary(
    page,
    b,
    csvFile('loyverse-1256.csv', [], windows1256(`${lines.join('\r\n')}\r\n`)),
    second,
  )
  await expect(page.locator('[data-import-name="لاتيه إسباني"]')).toHaveCount(0)
  const large = page.locator('[data-import-name="Spanish Latte L"]')
  await expect(large).toContainText('Not settled')
  await expect(large).toContainText('Did you mean')
  await large.locator('[data-suggestion="Spanish Latte"]').click()
  await expect(page.getByText('Every name is settled.')).toBeVisible()
  // 2,268.00 + 189.00 with VAT = 2,340.00 before VAT.
  await expect(page.locator('[data-figure=sales-before-vat]')).toContainText(
    money('en', '2,340.00'),
  )
  await expect(page.locator(`[data-import-day="${second}"] [data-other-sales]`)).toBeVisible()
  await finalizeImport(page)

  // A third file for the same day: both names remembered, the day already imported, skipped by
  // default or replaced on request.
  await importSummary(
    page,
    b,
    csvFile('loyverse-again.csv', [header, 'Spanish Latte L,5,94.50']),
    second,
  )
  await expect(page.getByText('Every name is settled.')).toBeVisible()
  await expect(page.getByText('1 day is already imported from another file')).toBeVisible()
  await expect(page.locator('[data-overlap="skip"] input')).toBeChecked()
  await page.locator('[data-overlap="replace"]').click()
  await expect(page.locator('[data-overlap="replace"] input')).toBeChecked()
  await finalizeImport(page)
  // The day now counts this file instead: 90.00 before VAT, with the sheet's 36.00.
  await report(page, b, `period=custom&from=${second}&to=${second}&by=day`)
  await expect(page.locator('[data-summary="sales"]')).toContainText(money('en', '126.00'))
  await expectSound(page, 'en')
})

/** A maker at home selling online, alone, VAT-registered. */
const MAKER_ANSWERS = {
  what_you_do: ['make_products'],
  how_you_make: ['batches'],
  workplace: 'home',
  team: 'alone',
  work_setup: ['stock'],
  sales_channels: ['online'],
  vat: 'yes',
}

test('DoD: import: the maker’s line file with a fee column: profit per product after its fees, the fees become noon’s statement; the next file matched by item code; finalize waits for every name', async ({
  browser,
}) => {
  test.setTimeout(600_000)
  const { page } = await open(browser, DESKTOP, 'en', 'Aisha')
  const b = await business(page, 'Aisha Abayas', MAKER_ANSWERS)
  const today = await todayOf(b)
  const noon = randomUUID()
  await b.call('channel.create', { id: noon, name: 'noon', kind: 'marketplace' })
  const classic = await madeOf(b, 'Classic abaya', '200', '80', addDays(today, -30))
  await madeOf(b, 'Silk abaya', '350', '150', addDays(today, -30))
  const [first, second] = [addDays(today, -3), addDays(today, -2)]
  const day = (value: string) => `${value.slice(8, 10)}/${value.slice(5, 7)}/${value.slice(0, 4)}`

  // A noon-style line file: a row per order line, its SKU, the sales before VAT and noon's fee.
  await page.goto(`/b/${b.id}/sales/import`)
  await pickFile(
    page,
    csvFile('noon-orders.csv', [
      'Order date,SKU,Item,Quantity,Net sales,Commission',
      `${day(first)},AB-CL-M,Abaya - Classic Black M,3,600.00,90.00`,
      `${day(first)},AB-SK-L,Abaya - Silk Navy L,2,700.00,105.00`,
    ]),
  )
  await page.locator('[data-field=channel]').selectOption({ label: 'noon' })
  await page.locator('[data-next]').click()
  await expect(page.locator('[data-read-summary]')).toBeVisible()
  await page.locator('[data-send]').click()
  await expect(page).toHaveURL(new RegExp(`/b/${b.id}/sales/import/[0-9a-f-]{36}$`))
  // Finalize waits for every name.
  await expect(page.locator('[data-finalize]')).toBeDisabled()
  await page
    .locator('[data-import-name="Abaya - Classic Black M"] [data-pick-product]')
    .selectOption({ label: 'Classic abaya' })
  await expect(page.locator('[data-finalize]')).toBeDisabled()
  await page
    .locator('[data-import-name="Abaya - Silk Navy L"] [data-pick-product]')
    .selectOption({ label: 'Silk abaya' })
  await expect(page.getByText('Every name is settled.')).toBeVisible()
  await finalizeImport(page)

  // Its fees are noon's statement for the file's days: 195.00.
  await page.goto(`/b/${b.id}/settings/channels/${noon}`)
  await expect(page.locator('[data-statement="posted"]')).toHaveCount(1)
  await expect(page.locator('[data-statement="posted"] [data-statement-fees]')).toContainText(
    money('en', '195.00'),
  )
  // Profit per product after the fees: the classic abaya's 600 carries 90 of them.
  await report(page, b, `period=custom&from=${first}&to=${first}&by=product`)
  await expect(await figure(page, classic, 'fees')).toContainText(money('en', '90.00'))
  await expect(await figure(page, classic, 'materials')).toContainText(money('en', '240.00'))
  await expectSound(page, 'en')

  // The next day's file names the items otherwise: matched by their codes, nothing to settle.
  await page.goto(`/b/${b.id}/sales/import`)
  await pickFile(
    page,
    csvFile('noon-orders-2.csv', [
      'Order date,SKU,Item,Quantity,Net sales,Commission',
      `${day(second)},AB-CL-M,CLASSIC ABAYA BLK MEDIUM,1,200.00,30.00`,
    ]),
  )
  await page.locator('[data-field=channel]').selectOption({ label: 'noon' })
  await page.locator('[data-next]').click()
  await page.locator('[data-send]').click()
  await expect(page).toHaveURL(new RegExp(`/b/${b.id}/sales/import/[0-9a-f-]{36}$`))
  await expect(page.getByText('Every name is settled.')).toBeVisible()
  await expect(page.locator('[data-finalize]')).toBeEnabled()
  await expect(page.locator('[data-figure=sales-before-vat]')).toContainText(money('en', '200.00'))
  await finalizeImport(page)
})

// ---------------------------------------------------------------------------------------------------
// Materials no product uses
// ---------------------------------------------------------------------------------------------------

test('DoD: materials no product uses: the fit-out’s (20,000 + 4,000) ÷ 80,000 = 30 %, and “Needs a look” names the gypsum', async ({
  browser,
}) => {
  test.setTimeout(600_000)
  const { page } = await open(browser, PHONE, 'ar', 'عبدالله')
  const b = await business(page, 'Gypsum Works', FITOUT_ANSWERS)
  const today = await todayOf(b)
  const last = addMonths(today, -1)
  await monthly(b, 'Workshop rent', '20000', dayOf(addMonths(today, -3), 1))
  const gypsum = await material(b, 'Gypsum board', 'piece')
  await buy(b, dayOf(last, 6), [{ materialId: gypsum, qty: '400', unit: 'piece', unitPrice: '10' }])
  const works = await service(b, 'Fit-out works', '1')
  const channel = await ownChannel(b)
  await sell(b, {
    channelId: channel,
    businessDate: dayOf(addMonths(today, -2), 5),
    lines: [item(works, '1', '1')],
  })
  await sell(b, {
    channelId: channel,
    businessDate: dayOf(last, 9),
    lines: [item(works, '80000', '1')],
  })

  // The month's costs: the running costs and the gypsum bought for a job, 24,000 ÷ 80,000 = 30 %.
  await report(page, b, 'period=last_month&by=month')
  const rate = page.locator(`[data-profit-month="${last}"]`)
  await expect(rate).toContainText(money('ar', '24,000.00'))
  await expect(rate).toContainText(money('ar', '80,000.00'))
  await expect(rate).toContainText(percent('30'))
  await expect(page.locator('[data-part="running"]')).toContainText(money('ar', '24,000.00'))
  await expect(page.locator('[data-summary="profit"]')).toContainText(money('ar', '56,000.00'))
  await expectSound(page, 'ar')
  // "Needs a look" (this month's cards, with a sale today): bought, but used in nothing it sells.
  await sell(b, { channelId: channel, businessDate: today, lines: [item(works, '1000', '1')] })
  await page.goto(`/b/${b.id}`)
  const look = onScreen(page.locator('[data-needs-look="materialsInNoRecipe"]'))
  await expect(look).toContainText('Gypsum board')
  await expectSound(page, 'ar')
  await setLanguage(page, 'en')
  await page.reload()
  await expect(onScreen(page.locator('[data-needs-look="materialsInNoRecipe"]'))).toContainText(
    'Bought, but used in nothing you sell',
  )
})

// ---------------------------------------------------------------------------------------------------
// Document maths
// ---------------------------------------------------------------------------------------------------

/** A quotation's draft of `lines` for the business's customer; its editor opened. */
async function quotationEditor(page: Page, b: Api, customerId: string, lines: object[]) {
  const today = await todayOf(b)
  const draft = await b.call<{ id: string }>('quotation.create', {
    id: randomUUID(),
    customerId,
    businessDate: today,
    lines,
  })
  await page.goto(`/b/${b.id}/quotations/${draft.id}/edit`)
  await expect(page.locator('[data-quotation-line]').first()).toBeVisible()
  return draft.id
}

const total = (page: Page, key: string) => page.locator(`[data-total="${key}"]:visible`)

test('DoD: document maths on the quotation editor: 7 × 10.10 → VAT 3.54 and 74.24; “Round the total” 1,120.00 → 1,100.00, mixed rates 2,600.00 → 2,500.00, and 1,000.12 → 1,000.11 + 0.01', async ({
  browser,
}) => {
  test.setTimeout(600_000)
  const { page } = await open(browser, DESKTOP, 'en', 'Rana')
  const b = await business(page, 'Maths Interiors', FITOUT_ANSWERS)
  const customer = await buyer(b, 'Gulf Towers LLC')

  // 7 lines of 10.10 at 5 %: VAT once on 70.70, 3.54 (not 7 × 0.51 = 3.57); total 74.24.
  await quotationEditor(
    page,
    b,
    customer,
    Array.from({ length: 7 }, (_, n) => typed(`Shelf bracket ${n + 1}`, '1', '10.10')),
  )
  await expect(total(page, 'net')).toContainText(money('en', '70.70'))
  await expect(total(page, 'vat-standard-5')).toContainText(money('en', '3.54'))
  await expect(total(page, 'total')).toContainText(money('en', '74.24'))
  await expectSound(page, 'en')

  // "Round the total" 1,120.00 → 1,100.00: −19.05 before VAT, VAT 52.38.
  await quotationEditor(page, b, customer, [typed('Reception desk', '1', '1066.67')])
  await expect(total(page, 'total')).toContainText(money('en', '1,120.00'))
  const roundTo = page.locator('[data-round-total]').getByRole('textbox')
  await roundTo.fill('1100')
  await expect(page.locator('[data-rounding]')).toContainText(less('19.05'))
  await expect(total(page, 'vat-standard-5')).toContainText(money('en', '52.38'))
  await expect(total(page, 'total')).toContainText(money('en', '1,100.00'))

  // Mixed rates: 2,000 at 5 % and 500 zero-rated = 2,600.00 → 2,500.00: −96.15 before VAT over the
  // two rates (−76.92 and −19.23), VAT 96.15.
  await quotationEditor(page, b, customer, [
    typed('Joinery', '1', '2000'),
    typed('Export crate', '1', '500', { vatCategory: 'zero_rated' }),
  ])
  await expect(total(page, 'total')).toContainText(money('en', '2,600.00'))
  await page.locator('[data-round-total]').getByRole('textbox').fill('2500')
  await expect(page.locator('[data-rounding]')).toContainText(less('96.15'))
  await expect(total(page, 'vat-standard-5')).toContainText(money('en', '96.15'))
  await expect(total(page, 'total')).toContainText(money('en', '2,500.00'))

  // An unreachable 1,000.12 at 5 %: 1,000.11 and a rounding difference of 0.01, saved so.
  const draft = await quotationEditor(page, b, customer, [typed('Site visit', '1', '1000')])
  await page.locator('[data-round-total]').getByRole('textbox').fill('1000.12')
  await expect(page.locator('[data-rounding]')).toContainText(money('en', '0.01'))
  await expect(total(page, 'total')).toContainText(money('en', '1,000.11'))
  await expect(total(page, 'difference')).toContainText(money('en', '0.01'))
  await expect(total(page, 'payable')).toContainText(money('en', '1,000.12'))
  await page.getByRole('button', { name: 'Save changes' }).first().click()
  await expect(page).toHaveURL(new RegExp(`/quotations/${draft}$`))
  await expect(total(page, 'payable')).toContainText(money('en', '1,000.12'))
  await expectSound(page, 'en')
})

// ---------------------------------------------------------------------------------------------------
// The fit-out company's tax invoice
// ---------------------------------------------------------------------------------------------------

test('DoD: the fit-out company’s tax invoice INV-0001 from Q-0001 in Arabic on a desktop: 14,411.25, its PDF, CN-0001 of 1,890.00 and “still owed 12,521.25”, the 14-day warning', async ({
  browser,
}) => {
  test.setTimeout(600_000)
  const { page } = await open(browser, DESKTOP, 'ar', 'عبدالله')
  const b = await business(page, 'Modern Touch Interiors', FITOUT_ANSWERS, 'ar')
  await taxReady(b, 'Modern Touch Interiors')
  const today = await todayOf(b)
  const towers = await buyer(b, 'أبراج الخليج ذ.م.م')
  // Q-0001: gypsum partition 120 m² × 45.00, painting 300 m² × 18.00, labour 5 days × 650.00 less
  // 10 %; sent and accepted.
  const quote = await b.call<{ id: string; version: number; number: string }>('quotation.create', {
    id: randomUUID(),
    customerId: towers,
    businessDate: today,
    lines: [
      typed('قواطع جبس', '120', '45', { unit: 'm2' }),
      typed('دهان', '300', '18', { unit: 'm2' }),
      typed('أجور عمال (5 أيام)', '5', '650', { discount: { percent: '10' } }),
    ],
  })
  expect(quote.number).toBe('Q-0001')
  const sent = await b.call<{ id: string; version: number }>('quotation.send', {
    id: quote.id,
    version: quote.version,
  })
  await b.call('quotation.accept', { id: sent.id, version: sent.version, note: null })

  // Its invoice made from the quotation, then issued: INV-0001.
  await page.goto(`/b/${b.id}/quotations/${quote.id}`)
  await page.getByRole('button', { name: 'إنشاء فاتورة' }).click()
  const bill = page.getByRole('alertdialog')
  await expect(bill).toContainText(`فوترة عرض السعر ${isolated('Q-0001')}`)
  await bill.getByRole('button', { name: 'أنشئ المسودة' }).click()
  await expect(
    page.getByRole('heading', { level: 1, name: 'تعديل مسودة فاتورة ضريبية' }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'حفظ التغييرات' }).first().click()
  await expect(page.getByRole('heading', { level: 1, name: 'مسودة فاتورة ضريبية' })).toBeVisible()
  await page.getByRole('button', { name: 'إصدار', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'إصدار', exact: true }).click()
  await expect(page.getByText(`صدرت ${isolated('INV-0001')}.`)).toBeVisible()
  const pdf = page.getByRole('dialog')
  await expect(pdf.getByRole('button', { name: 'تنزيل PDF' })).toBeEnabled({ timeout: 60_000 })
  const download = page.waitForEvent('download')
  await pdf.getByRole('button', { name: 'تنزيل PDF' }).click()
  const bytes = await (await download).createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of bytes) chunks.push(chunk as Buffer)
  expect(Buffer.concat(chunks).subarray(0, 5).toString('latin1')).toBe('%PDF-')
  await page.keyboard.press('Escape')
  await expect(
    page.getByRole('heading', { level: 1, name: `فاتورة ضريبية ${isolated('INV-0001')}` }),
  ).toBeVisible()
  // 5,400.00 + 5,400.00 + 2,925.00 = 13,725.00 before VAT, VAT 686.25, total AED 14,411.25.
  await expect(total(page, 'net')).toContainText(money('ar', '13,725.00'))
  await expect(total(page, 'vat-standard-5')).toContainText(money('ar', '686.25'))
  await expect(total(page, 'total')).toContainText(money('ar', '14,411.25'))
  await expect(page.getByRole('main')).toContainText(money('ar', '2,925.00'))
  await expectSound(page, 'ar')

  // A credit note for 100 m² of the painting, its reason and event date; an event 15 days old says
  // the 14-day rule.
  await page.getByRole('button', { name: 'إشعار دائن' }).click()
  const sheet = page.getByRole('dialog')
  await sheet.locator('[data-credit-reason]').selectOption('price_changed')
  await sheet.locator('[data-credit-reason-text]').fill('لم يُدهن 100 م² من الجدران')
  await sheet.locator('[data-credit-event-date]').fill(addDays(today, -15))
  await expect(sheet.locator('[data-credit-late]')).toContainText(
    'الإشعار الدائن الضريبي مستحق خلال 14 يومًا',
  )
  await sheet.locator('[data-credit-event-date]').fill(today)
  await expect(sheet.locator('[data-credit-late]')).toHaveCount(0)
  await sheet.getByRole('textbox', { name: /ما يُسترد من.*دهان/ }).fill('100')
  await sheet.getByRole('button', { name: 'حفظ وإصدار…' }).click()
  const confirm = page.getByRole('alertdialog')
  // 100 × 18.00 = 1,800.00 + VAT 90.00.
  await expect(confirm).toContainText(money('ar', '1,890.00'))
  await confirm.getByRole('button', { name: 'إصدار الإشعار الدائن' }).click()
  await expect(page.getByText(`صدر ${isolated('CN-0001')}.`)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-credit-note="issued"]')).toContainText('CN-0001')
  await expect(page.getByRole('main')).toContainText(money('ar', '1,890.00'))
  // The invoice itself never changes: still owed 14,411.25 − 1,890.00 = 12,521.25.
  await expect(page.locator('[data-owed="owed"]')).toContainText(money('ar', '12,521.25'))
  await expect(total(page, 'total')).toContainText(money('ar', '14,411.25'))
  await expect(page.getByRole('link', { name: 'تعديل' })).toHaveCount(0)
  await expectSound(page, 'ar')
})

// ---------------------------------------------------------------------------------------------------
// Stages and deposits
// ---------------------------------------------------------------------------------------------------

/** A workshop with a team, branches, VAT, orders and quotations. */
const WORKSHOP_ANSWERS = {
  what_you_do: ['make_products'],
  how_you_make: ['custom_jobs'],
  workplace: 'workshop',
  branches: false,
  team: 'team',
  team_tracking: ['hours'],
  work_setup: ['stock'],
  sales_channels: ['messages', 'quotes'],
  vat: 'yes',
}

test('DoD: stages 3,150 / 4,200 / 3,150; the workshop’s deposit tax invoice paid by its deposit and its final invoice of 15,750.00 owed once; a plain Invoice and Credit Note without VAT or “tax”', async ({
  browser,
}) => {
  test.setTimeout(600_000)
  const { page } = await open(browser, DESKTOP, 'en', 'Rashed')

  // Stages 30 / 40 / 30 of a quotation of 10,000.00 + VAT: 3,150.00, 4,200.00 and the rest, 3,150.00.
  const fitout = await business(page, 'Stage Interiors', FITOUT_ANSWERS)
  await taxReady(fitout, 'Stage Interiors')
  const today = await todayOf(fitout)
  const towers = await buyer(fitout, 'Gulf Towers LLC')
  const quote = await fitout.call<{ id: string; version: number }>('quotation.create', {
    id: randomUUID(),
    customerId: towers,
    businessDate: today,
    lines: [typed('Reception fit-out', '1', '10000')],
    stages: [
      { label: null, due: 'On signing', percent: '30' },
      { label: null, due: 'On delivery', percent: '40' },
      { label: null, due: 'On handover', percent: '30' },
    ],
  })
  const sent = await fitout.call<{ id: string; version: number }>('quotation.send', {
    id: quote.id,
    version: quote.version,
  })
  await fitout.call('quotation.accept', { id: sent.id, version: sent.version, note: null })
  await page.goto(`/b/${fitout.id}/quotations/${quote.id}`)
  await page.getByRole('button', { name: 'Make an invoice' }).click()
  const bill = page.getByRole('alertdialog')
  await expect(
    bill.locator('label').filter({ has: page.locator('[data-bills="stage-0"]') }),
  ).toContainText(/30%\s·\sAED\s3,150\.00/)
  // Stages are billed in their order, each once.
  await expect(
    bill.locator('label').filter({ has: page.locator('[data-bills="stage-1"]') }),
  ).toContainText('Bill the stages in their order: Payment 1 first.')
  await expect(bill.locator('[data-bills="stage-2"]')).toBeDisabled()
  await bill.getByRole('button', { name: 'Cancel' }).click()
  const totals: string[] = []
  for (const stage of [0, 1, 2]) {
    const issued = await issue(
      fitout,
      await fitout.call<Invoice>('invoice.fromQuotation', {
        id: quote.id,
        newId: randomUUID(),
        stage,
      }),
    )
    await page.goto(`/b/${fitout.id}/invoices/${issued.id}`)
    totals.push((await total(page, 'total').innerText()).replace(/\s+/g, ' '))
  }
  expect(totals.map((t) => /[\d,]+\.\d\d/.exec(t)?.[0])).toEqual([
    '3,150.00',
    '4,200.00',
    '3,150.00',
  ])
  await page.goto(`/b/${fitout.id}/quotations/${quote.id}`)
  await expect(page.locator('[data-source-invoiced]')).toContainText(money('en', '10,500.00'))
  await expect(page.getByRole('button', { name: 'Make an invoice' })).toHaveCount(0)

  // The workshop's order of 20,000 + VAT = 21,000 with a deposit of 5,250 recorded on it: its deposit
  // tax invoice of 5,000 + 250 is paid by that deposit; the final invoice bills 20,000 − 5,000 =
  // 15,000 + VAT 750 = 15,750.00. VAT is charged 1,000 in all, once.
  const workshop = await business(page, 'Oak & Iron Joinery', WORKSHOP_ANSWERS)
  await taxReady(workshop, 'Oak & Iron Joinery')
  const noor = await buyer(workshop, 'Al Noor Developments')
  const kitchen = await product(workshop, 'Kitchen cabinets', '20000')
  const order = (
    await workshop.call<{ data: { id: string; version: number; number: string } }>('order.create', {
      id: randomUUID(),
      customerId: noor,
      businessDate: today,
      lines: [item(kitchen, '1', '20000')],
      payment: { id: randomUUID(), method: 'bank_transfer', amount: '5250' },
    })
  ).data
  await page.goto(`/b/${workshop.id}/invoices`)
  const deposits = page.locator('[data-deposits-without-invoice]')
  await expect(deposits.locator('[data-deposit-without-invoice]')).toContainText(
    `Order ${isolated(order.number)}`,
  )
  await expect(deposits.locator('[data-deposit-due="due"]')).toContainText(
    `tax invoice due by ${await dateIn(page, 'en', addDays(today, 14))}`,
  )
  await deposits.getByRole('button', { name: 'Make its deposit invoice' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Make the draft' }).click()
  await expect(
    page.getByRole('heading', { level: 1, name: 'Change draft Tax Invoice' }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Save changes' }).first().click()
  await page.getByRole('button', { name: 'Issue', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Issue', exact: true }).click()
  await expect(page.getByText(`${isolated('INV-0001')} is issued.`)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(total(page, 'net')).toContainText(money('en', '5,000.00'))
  await expect(total(page, 'vat-standard-5')).toContainText(money('en', '250.00'))
  await expect(total(page, 'total')).toContainText(money('en', '5,250.00'))
  await expect(page.locator('[data-invoice-state="paid"]')).toBeVisible()
  const delivered = await workshop.query<{ data: { version: number } }>('order.get', {
    id: order.id,
  })
  await workshop.call('order.deliver', { id: order.id, version: delivered.data.version })
  const final = await issue(
    workshop,
    await workshop.call<Invoice>('invoice.fromOrder', {
      orderId: order.id,
      newId: randomUUID(),
      bills: 'rest',
    }),
  )
  await page.goto(`/b/${workshop.id}/invoices/${final.id}`)
  await expect(total(page, 'net')).toContainText(money('en', '15,000.00'))
  await expect(total(page, 'vat-standard-5')).toContainText(money('en', '750.00'))
  await expect(total(page, 'total')).toContainText(money('en', '15,750.00'))
  // What customers owe: 15,750 once; the statement lists the invoices only.
  await page.goto(`/b/${workshop.id}/receivables`)
  await expect(page.locator('[data-receivables-total]')).toContainText(money('en', '15,750.00'))
  await expect(page.locator('[data-owed-document]')).toHaveCount(1)
  await page.goto(`/b/${workshop.id}/customers/${noor}/statement`)
  await expect(page.locator('[data-statement-entry="invoice"]:visible')).toHaveCount(2)
  await expect(page.locator('[data-statement-entry="order"]:visible')).toHaveCount(0)
  await expect(page.locator('[data-statement-sum="closing"]')).toContainText(
    money('en', '15,750.00'),
  )
  await expectSound(page, 'en')

  // Not registered for VAT: an "Invoice" and a "Credit Note", no VAT anywhere and no word "tax".
  const designer = await business(page, 'Plain Design Studio', DESIGNER_ANSWERS)
  const bloom = (
    await designer.call<{ id: string }>('customer.create', {
      id: randomUUID(),
      name: 'Bloom Florists LLC',
      kind: 'business',
    })
  ).id
  const plain = await issue(
    designer,
    await designer.call<Invoice>('invoice.create', {
      id: randomUUID(),
      customerId: bloom,
      countedElsewhere: false,
      lines: [typed('Logo design', '1', '1500')],
    }),
  )
  const note = await designer.call<{ id: string; version: number }>('creditNote.create', {
    id: randomUUID(),
    invoiceId: plain.id,
    eventDate: today,
    reason: 'price_changed',
    reasonText: 'One version dropped',
    by: 'amount',
    lines: [{ invoiceLineId: plain.lines[0]!.id, amount: '300' }],
  })
  await designer.call('creditNote.issue', { id: note.id, version: note.version })
  await page.goto(`/b/${designer.id}/invoices/${plain.id}`)
  await expect(
    page.getByRole('heading', { level: 1, name: `Invoice ${isolated('INV-0001')}` }),
  ).toBeVisible()
  await expect(page.locator('[data-credit-note="issued"]')).toContainText('Credit Note CN-0001')
  expect(await page.getByRole('main').innerText()).not.toMatch(/\bVAT\b|\btax\b/i)
  await expectSound(page, 'en')
})

// ---------------------------------------------------------------------------------------------------
// Gapless numbering
// ---------------------------------------------------------------------------------------------------

test('DoD: gapless numbering on the screens: a first number of 457, a discarded draft and a refused issue take none, closed books move the sale, credit notes their own series, quotations say their numbers skip', async ({
  browser,
}) => {
  test.setTimeout(600_000)
  const { page } = await open(browser, DESKTOP, 'en', 'Hamad')
  const b = await business(page, 'Series Interiors', FITOUT_ANSWERS)
  await taxReady(b, 'Series Interiors')
  const today = await todayOf(b)
  const towers = await buyer(b, 'Gulf Towers LLC')
  // A registered customer without an address yet: its invoice can't be issued.
  const noAddress = await buyer(b, 'Desert Rose LLC', {
    addressLine: null,
    city: null,
    emirate: null,
  })

  // Settings → Documents: the invoices continue from the old system's 457.
  await page.goto(`/b/${b.id}/settings/documents`)
  const series = page.getByRole('group', { name: 'Invoices' })
  await series.getByRole('textbox', { name: 'First number' }).fill('457')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Saved.').or(page.getByText(/saved/i)).first()).toBeVisible()
  await page.reload()
  await expect(page.getByRole('group', { name: 'Invoices' })).toContainText('INV-0457')

  const draftOf = (customerId: string, extra: object = {}) =>
    b.call<Invoice>('invoice.create', {
      id: randomUUID(),
      customerId,
      countedElsewhere: false,
      lines: [typed('Joinery works', '1', '1000')],
      ...extra,
    })
  // A draft discarded on its page: no number is lost.
  const discarded = await draftOf(towers)
  await page.goto(`/b/${b.id}/invoices/${discarded.id}`)
  await page.getByRole('button', { name: 'Discard', exact: true }).click()
  const discard = page.getByRole('alertdialog', { name: 'Discard this draft?' })
  await expect(discard).toContainText('It has no number yet, so no number is lost.')
  await discard.getByRole('button', { name: 'Discard draft' }).click()
  await expect(page.getByText('Draft discarded.')).toBeVisible()
  // A refused issue (the registered customer's address is missing) takes no number either.
  const refused = await draftOf(noAddress)
  await page.goto(`/b/${b.id}/invoices/${refused.id}`)
  await page.getByRole('button', { name: 'Issue', exact: true }).click()
  const blocked = page.getByRole('alertdialog')
  await expect(blocked.locator('[data-issue-missing="customer_address"]')).toBeVisible()
  await expect(blocked.getByRole('button', { name: 'Issue', exact: true })).toBeDisabled()
  await blocked.getByRole('button', { name: 'Cancel' }).click()
  // The next invoices are 457 and 458.
  const first = await issue(b, await draftOf(towers))
  expect(first.number).toBe('INV-0457')
  // One whose day of supply is in closed books is issued, its sale on the first open day.
  await b.call('books.close', { closedThrough: addDays(today, -1) })
  const moved = await issue(b, await draftOf(towers, { supplyDate: addDays(today, -3) }))
  expect(moved.number).toBe('INV-0458')
  await page.goto(`/b/${b.id}/invoices/${moved.id}`)
  await expect(
    page.getByRole('heading', { level: 1, name: `Tax Invoice ${isolated('INV-0458')}` }),
  ).toBeVisible()
  await expect(page.locator('[data-invoice-counting]')).toHaveText(
    `Its sale counts on ${await dateIn(page, 'en', today)}, the first open day (your books were closed).`,
  )
  // Credit notes have their own series.
  const credit = await b.call<{ id: string; version: number }>('creditNote.create', {
    id: randomUUID(),
    invoiceId: first.id,
    eventDate: today,
    reason: 'price_changed',
    reasonText: 'Price agreed again',
    by: 'amount',
    lines: [{ invoiceLineId: first.lines[0]!.id, amount: '100' }],
  })
  const issuedCredit = await b.call<{ number: string }>('creditNote.issue', {
    id: credit.id,
    version: credit.version,
  })
  expect(issuedCredit.number).toBe('CN-0001')
  await page.goto(`/b/${b.id}/invoices`)
  await expect(page.locator('[data-invoice-row]')).toHaveCount(3)
  await expect(page.locator('[data-invoice-row]').filter({ hasText: 'INV-0457' })).toHaveCount(1)
  await expect(page.locator('[data-invoice-row]').filter({ hasText: 'INV-0458' })).toHaveCount(1)
  // A quotation's number is taken when its draft is made: discarding it says it isn't used again.
  const quote = await b.call<{ id: string; number: string }>('quotation.create', {
    id: randomUUID(),
    customerId: towers,
    businessDate: today,
    lines: [typed('Wardrobe', '1', '4000')],
  })
  await page.goto(`/b/${b.id}/quotations/${quote.id}`)
  await page.getByRole('button', { name: 'Discard', exact: true }).click()
  await expect(page.getByRole('alertdialog')).toContainText("Its number isn't used again.")
  await expectSound(page, 'en')
})

/** A negative amount as the page writes it: "-AED 19.05"; in Arabic its number and «د.إ.». */
const lessIn = (locale: Locale, value: string) =>
  locale === 'ar' ? new RegExp(`-${MARKS}${escape(value)}${MARKS}د\\.إ\\.`) : less(value)

// The definition of done's figures are checked in Arabic and English (M3 Step 10 review, D-337): the
// items the English tests above check on a desktop (document maths, the frozen cost's "no price yet",
// the numbering from 457 with credit notes' own series, an invoiced order counted once) once more in
// Arabic on a phone, each figure as the Arabic page writes it.
test('DoD: in Arabic on a phone: document maths (3.54, −19.05, −96.15, 1,000.11 + 0.01), «لا سعر بعد» until the first purchase, invoices from 457 with credit notes of their own, an invoiced order counted once', async ({
  browser,
}) => {
  test.setTimeout(600_000)
  const { page } = await open(browser, PHONE, 'ar', 'رنا')
  const b = await business(page, 'Arabic Maths Interiors', FITOUT_ANSWERS, 'ar')
  await taxReady(b, 'Arabic Maths Interiors')
  const today = await todayOf(b)
  const towers = await buyer(b, 'أبراج الخليج ذ.م.م')

  // Document maths, on each saved quotation's page.
  const quoted = async (lines: object[], roundTo?: string) => {
    const quote = await b.call<{ id: string }>('quotation.create', {
      id: randomUUID(),
      customerId: towers,
      businessDate: today,
      lines,
      ...(roundTo ? { roundTo } : {}),
    })
    await page.goto(`/b/${b.id}/quotations/${quote.id}`)
    await expect(total(page, 'total')).toBeVisible()
  }
  await quoted(Array.from({ length: 7 }, (_, n) => typed(`حامل رف ${n + 1}`, '1', '10.10')))
  await expect(total(page, 'net')).toContainText(money('ar', '70.70'))
  await expect(total(page, 'vat-standard-5')).toContainText(money('ar', '3.54'))
  await expect(total(page, 'total')).toContainText(money('ar', '74.24'))
  await quoted([typed('مكتب استقبال', '1', '1066.67')], '1100')
  await expect(total(page, 'adjustment')).toContainText(lessIn('ar', '19.05'))
  await expect(total(page, 'vat-standard-5')).toContainText(money('ar', '52.38'))
  await expect(total(page, 'total')).toContainText(money('ar', '1,100.00'))
  await quoted(
    [
      typed('أعمال نجارة', '1', '2000'),
      typed('صندوق تصدير', '1', '500', { vatCategory: 'zero_rated' }),
    ],
    '2500',
  )
  await expect(total(page, 'adjustment')).toContainText(lessIn('ar', '96.15'))
  await expect(total(page, 'vat-standard-5')).toContainText(money('ar', '96.15'))
  await expect(total(page, 'total')).toContainText(money('ar', '2,500.00'))
  await quoted([typed('زيارة موقع', '1', '1000')], '1000.12')
  await expect(total(page, 'total')).toContainText(money('ar', '1,000.11'))
  await expect(total(page, 'difference')).toContainText(money('ar', '0.01'))
  await expect(total(page, 'payable')).toContainText(money('ar', '1,000.12'))
  await expectSound(page, 'ar')

  // A sale before any purchase of its material: «لا سعر بعد», never 0; the first purchase fills it.
  const gypsum = await material(b, 'جبس', 'kg')
  const board = await product(b, 'لوح جبس', '50')
  await b.call('recipe.save', {
    productId: board,
    version: 0,
    lines: [{ id: randomUUID(), materialId: gypsum, qty: '2', unit: 'kg' }],
  })
  const early = await sell(b, {
    channelId: await ownChannel(b),
    businessDate: today,
    lines: [item(board, '10', '50')],
  })
  await page.goto(`/b/${b.id}/sales/${early.id}`)
  await expect(lineCost(page, 'لوح جبس')).toContainText('لا سعر بعد')
  await expect(lineCost(page, 'لوح جبس')).not.toContainText(money('ar', '0.00'))
  await buy(b, today, [{ materialId: gypsum, qty: '100', unit: 'kg', unitPrice: '1.5' }])
  await page.reload()
  // 10 boards × 2 kg × 1.50 = 30.00, once.
  await expect(lineCost(page, 'لوح جبس')).toContainText(money('ar', '30.00'))
  await expectSound(page, 'ar')

  // Invoices continue from 457; credit notes have their own series.
  const settings = await b.query<{
    version: number
    footer: string | null
    quotationTerms: string | null
    quotationValidDays: number
    accent: string
    watermark: boolean
    wholeAmounts: boolean
    signatory: string | null
  }>('document.settings')
  await b.call('document.updateSettings', {
    version: settings.version,
    series: [{ series: 'invoice', prefix: 'INV-', padding: 4, firstNo: 457 }],
    footer: settings.footer,
    quotationTerms: settings.quotationTerms,
    quotationValidDays: settings.quotationValidDays,
    accent: settings.accent,
    watermark: settings.watermark,
    wholeAmounts: settings.wholeAmounts,
    signatory: settings.signatory,
  })
  const invoiced = async () =>
    issue(
      b,
      await b.call<Invoice>('invoice.create', {
        id: randomUUID(),
        customerId: towers,
        countedElsewhere: false,
        lines: [typed('أعمال نجارة', '1', '1000')],
      }),
    )
  const first = await invoiced()
  const second = await invoiced()
  expect([first.number, second.number]).toEqual(['INV-0457', 'INV-0458'])
  const credit = await b.call<{ id: string; version: number }>('creditNote.create', {
    id: randomUUID(),
    invoiceId: first.id,
    eventDate: today,
    reason: 'price_changed',
    reasonText: 'اتُّفق على السعر من جديد',
    by: 'amount',
    lines: [{ invoiceLineId: first.lines[0]!.id, amount: '100' }],
  })
  await b.call('creditNote.issue', { id: credit.id, version: credit.version })
  await page.goto(`/b/${b.id}/invoices`)
  for (const number of ['INV-0457', 'INV-0458']) {
    await expect(page.locator('[data-invoice-row]').filter({ hasText: number })).toHaveCount(1)
  }
  await page.goto(`/b/${b.id}/invoices/${first.id}`)
  await expect(page.getByRole('main')).toContainText('CN-0001')
  await expectSound(page, 'ar')

  // A factory's order of 10,000 delivered on the 15th of last month and invoiced today: last
  // month's sales are 10,000, not 20,000.
  const factory = await business(page, 'مصنع النور للمعادن', FACTORY_ANSWERS, 'ar')
  await taxReady(factory, 'Al Noor Metal Works')
  const last = addMonths(today, -1)
  const frame = await product(factory, 'إطار حديد', '100')
  const order = (
    await factory.call<{ data: { id: string; version: number } }>('order.create', {
      id: randomUUID(),
      customerId: await buyer(factory, 'الخليج للمقاولات ذ.م.م'),
      businessDate: dayOf(last, 10),
      channelId: await ownChannel(factory),
      lines: [item(frame, '100', '100')],
    })
  ).data
  await factory.call('order.deliver', {
    id: order.id,
    version: order.version,
    businessDate: dayOf(last, 15),
  })
  await issue(
    factory,
    await factory.call<Invoice>('invoice.fromOrder', { orderId: order.id, newId: randomUUID() }),
  )
  await report(page, factory, 'period=last_month&by=month')
  await expect(page.locator('[data-profit-summary] [data-summary="sales"]')).toContainText(
    money('ar', '10,000.00'),
  )
  await expectSound(page, 'ar')
})

// ---------------------------------------------------------------------------------------------------
// What customers owe, and statements
// ---------------------------------------------------------------------------------------------------

test('DoD: what customers owe and statements: 8,000 over three invoices oldest first leaves 2,500; the statement 0 / 10,500 / 8,000 / 2,500 and its PDF in Arabic; overpaying refused; the method never preselected', async ({
  browser,
}) => {
  test.setTimeout(600_000)
  const { page } = await open(browser, DESKTOP, 'en', 'Saeed')
  const b = await business(page, 'Owed Metal Works', FACTORY_ANSWERS)
  await taxReady(b, 'Owed Metal Works')
  const gulf = await buyer(b, 'Gulf Build Contracting LLC')
  // Invoices of 5,250, 3,150 and 2,100 (5,000, 3,000 and 2,000 + VAT), oldest first.
  for (const amount of ['5000', '3000', '2000']) {
    await issue(
      b,
      await b.call<Invoice>('invoice.create', {
        id: randomUUID(),
        customerId: gulf,
        countedElsewhere: false,
        lines: [typed('Steel works', '1', amount)],
      }),
    )
  }
  await page.goto(`/b/${b.id}/receivables`)
  await expect(page.locator('[data-receivables-total]')).toContainText(money('en', '10,500.00'))
  await page.getByRole('button', { name: 'Record a payment' }).click()
  const many = page.getByRole('dialog', { name: 'Record a payment' })
  const documents = many.locator('[data-pay-many-document]')
  await expect(documents).toHaveCount(3)
  const amount = many.getByRole('textbox', { name: 'Amount' })
  // More than they owe is refused.
  await amount.fill('10500.01')
  await expect(many.getByText("That's more than they owe on these.")).toBeVisible()
  await amount.fill('8000')
  await expect(documents.nth(0)).toContainText('Pays all of it: AED 5,250.00')
  await expect(documents.nth(1)).toContainText('Pays AED 2,750.00 of AED 3,150.00')
  await expect(documents.nth(2)).toContainText('Nothing goes to this one')
  // How they paid is required and never preselected.
  const method = many.getByRole('combobox', { name: 'How they paid' })
  await expect(method).toHaveValue('')
  await many.getByRole('button', { name: 'Record payment' }).click()
  await expect(many.getByText('Choose how it was paid.')).toBeVisible()
  await method.selectOption({ label: 'Bank transfer' })
  await expectSound(page, 'en')
  await many.getByRole('button', { name: 'Record payment' }).click()
  await expect(many).toBeHidden()
  await expect(page.locator('[data-receivables-total]')).toContainText(money('en', '2,500.00'))

  // The month's statement: opening 0, invoiced 10,500, paid 8,000, closing 2,500; its PDF in Arabic.
  await page.goto(`/b/${b.id}/customers/${gulf}/statement`)
  await expect(page.locator('[data-statement-sum="opening"]')).toContainText(money('en', '0.00'))
  await expect(page.locator('[data-statement-sum="invoiced"]')).toContainText(
    money('en', '10,500.00'),
  )
  await expect(page.locator('[data-statement-sum="paid"]')).toContainText(money('en', '8,000.00'))
  await expect(page.locator('[data-statement-sum="closing"]')).toContainText(
    money('en', '2,500.00'),
  )
  await setLanguage(page, 'ar')
  await page.reload()
  await expect(page.locator('[data-statement-sum="closing"]')).toContainText(
    money('ar', '2,500.00'),
  )
  await expectSound(page, 'ar')
  await page.getByRole('button', { name: 'PDF', exact: true }).click()
  const pdf = page.getByRole('dialog')
  await expect(pdf.getByRole('button', { name: 'تنزيل PDF' })).toBeEnabled({ timeout: 60_000 })
  const download = page.waitForEvent('download')
  await pdf.getByRole('button', { name: 'تنزيل PDF' }).click()
  const chunks: Buffer[] = []
  for await (const chunk of await (await download).createReadStream()) chunks.push(chunk as Buffer)
  expect(Buffer.concat(chunks).subarray(0, 5).toString('latin1')).toBe('%PDF-')
  await setLanguage(page, 'en')
})

// ---------------------------------------------------------------------------------------------------
// Who sees what
// ---------------------------------------------------------------------------------------------------

/** Invites `user` with the role of `templateKey`; they accept it. Their member id. */
async function joinTeam(b: Api, member: Page, user: TestUser, templateKey: string) {
  const roles = await b.query<{ id: string; templateKey: string | null }[]>('role.list')
  await b.call('invitation.create', {
    id: randomUUID(),
    email: user.email,
    roleId: roles.find((role) => role.templateKey === templateKey)?.id,
    locale: 'en',
  })
  const { token } = await nextInvitation(user.email)
  await ok(callApi(member, 'invitation.accept', { token }), 'invitation.accept')
  const members = await b.query<{ id: string; email: string | null }[]>('member.list')
  return members.find((m) => m.email === user.email)!.id
}

/** A new member of `b` with the role of `templateKey`, signed in on their own page. */
async function memberOf(
  browser: Browser,
  b: Api,
  templateKey: string,
  displayName: string,
  viewport = DESKTOP,
) {
  const user = await createUser(`m3done-${templateKey}`, { locale: 'en' })
  users.push(user)
  const page = await openAs(browser, user, viewport, 'en', displayName)
  const memberId = await joinTeam(b, page, user, templateKey)
  return { page, memberId, b: api(page, b.id) }
}

test('DoD: who sees what: the Employee, Supervisor, Sales, Accountant, a role without running costs and a member limited to one branch', async ({
  browser,
}) => {
  test.setTimeout(900_000)
  const { page: owner } = await open(browser, DESKTOP, 'en', 'Khalid')
  const b = await business(owner, 'Team Café', CAFE_ANSWERS)
  const today = await todayOf(b)
  const last = addMonths(today, -1)
  const marina = randomUUID()
  await b.call('location.create', { id: marina, name: 'Marina branch' })
  const shop = await ownChannel(b)
  await monthly(b, 'Shop rent', '20000', dayOf(addMonths(today, -3), 1))
  const latte = await madeOf(b, 'Spanish Latte', '18', '3', dayOf(addMonths(today, -2), 1))
  await sell(b, {
    channelId: shop,
    businessDate: dayOf(addMonths(today, -2), 3),
    lines: [item(latte, '1', '18')],
  })
  await sell(b, {
    source: 'day_sheet',
    channelId: shop,
    businessDate: dayOf(last, 5),
    lines: [item(latte, '1000', '18')],
  })
  // Today: the owner's sale at the first branch, another at the Marina branch.
  const ownersSale = await sell(b, {
    channelId: shop,
    businessDate: today,
    lines: [item(latte, '10', '18')],
  })
  await sell(b, {
    channelId: shop,
    locationId: marina,
    businessDate: today,
    lines: [item(latte, '5', '18')],
  })
  await b.call('customer.create', { id: randomUUID(), name: 'Fatima', phone: '050 123 4567' })

  // The Employee enters Today's sales and orders, sees only their own, and the delivery cost they
  // typed; never another cost, a fee, a profit or a business total. Their customer picker: names
  // and the phone's last 4 digits.
  const employee = await memberOf(browser, b, 'employee', 'Laila', PHONE)
  const ownSale = await sell(employee.b, {
    channelId: shop,
    businessDate: today,
    deliveryNeeded: true,
    deliveryArea: 'Al Barsha',
    deliveryCost: '15',
    lines: [item(latte, '2', '18'), { kind: 'delivery', id: randomUUID(), amount: '10' }],
  })
  const e = employee.page
  await e.goto(`/b/${b.id}/sales`)
  await expect(e.locator('[data-sale-row]')).toHaveCount(1)
  await expect(e.locator('[data-day-total]')).toHaveCount(0)
  await e.goto(`/b/${b.id}/sales/${ownSale.id}`)
  await expect(e.locator('[data-delivery-cost]')).toHaveText(money('en', '15.00'))
  await expect(e.locator('[data-locked="cost"]').first()).toBeVisible()
  await expect(e.locator('[data-line-profit]')).toHaveCount(0)
  await e.goto(`/b/${b.id}/sales/${ownersSale.id}`)
  await expect(e.getByRole('heading', { name: 'Sale not found' })).toBeVisible()
  await e.goto(`/b/${b.id}`)
  await expect(e.getByRole('heading', { level: 1, name: 'Team Café' })).toBeVisible()
  await expect(e.locator('[data-decision-cards]')).toHaveCount(0)
  await e.goto(`/b/${b.id}/reports/profit`)
  await expect(e.getByRole('heading', { name: "This page isn't open to you" })).toBeVisible()
  await e.goto(`/b/${b.id}/orders/new`)
  await e.getByRole('combobox', { name: 'Customer' }).fill('Fatima')
  await expect(e.getByRole('option', { name: /^Fatima · …4567$/ })).toBeVisible()
  await expect(e.getByRole('option', { name: /050 123 4567/ })).toHaveCount(0)
  await expectSound(e, 'en')

  // Supervisor and Sales see every sale and the sales totals, and no profit; the Accountant sees it.
  for (const [template, name] of [
    ['supervisor', 'Faisal'],
    ['sales', 'Rami'],
  ] as const) {
    const member = await memberOf(browser, b, template, name)
    const p = member.page
    await p.goto(`/b/${b.id}/sales`)
    // Today: the owner's 180.00 and 90.00 at both branches, and the Employee's 36.00 + 10.00.
    await expect(p.locator('[data-day-total]').first()).toContainText(money('en', '316.00'))
    await p.goto(`/b/${b.id}/sales/${ownSale.id}`)
    await expect(p.getByRole('heading', { level: 1 })).toHaveText(/^Sale of /)
    await p.goto(`/b/${b.id}`)
    await expect(p.locator('[data-card="profit"]')).toHaveCount(0)
    await p.goto(`/b/${b.id}/reports/profit?period=last_month`)
    await expect(p.locator('[data-summary="profit"]')).toHaveCount(0)
    await expect(p.locator('[data-part]')).toHaveCount(0)
    await expectSound(p, 'en')
  }
  const accountant = await memberOf(browser, b, 'accountant', 'Huda')
  await accountant.page.goto(`/b/${b.id}/reports/profit?period=last_month`)
  await expect(accountant.page.locator('[data-summary="profit"]')).toBeVisible()
  await expect(accountant.page.locator('[data-part="running"]')).toContainText(
    money('en', '20,000.00'),
  )

  // A custom role: profit reports and the costs switch, without running costs: the month's
  // running-cost total in Real profit, never its categories.
  const custom = await memberOf(browser, b, 'accountant', 'Nour')
  const access = await b.query<{ version: number }>('member.permissions', {
    memberId: custom.memberId,
  })
  await b.call('member.updatePermissions', {
    memberId: custom.memberId,
    version: access.version,
    overrides: [{ key: 'running_costs.items.view', effect: 'deny' }],
  })
  const c = custom.page
  await c.goto(`/b/${b.id}/reports/profit?period=last_month`)
  await expect(c.locator('[data-part="running"]')).toContainText(money('en', '20,000.00'))
  await expect(c.locator(`[data-profit-month="${last}"]`)).toContainText(money('en', '20,000.00'))
  await c.goto(`/b/${b.id}/product-costs`)
  await expect(c.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(c.locator('[data-month-category]')).toHaveCount(0)
  await expect(
    c.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Running Costs' }),
  ).toHaveCount(0)
  await expectSound(c, 'en')

  // A member limited to the Marina branch sees and enters only its sales.
  const limited = await memberOf(browser, b, 'supervisor', 'Yousef')
  const branches = await b.query<{ version: number }>('member.locations', {
    memberId: limited.memberId,
  })
  await b.call('member.updateLocations', {
    memberId: limited.memberId,
    version: branches.version,
    locationIds: [marina],
  })
  const l = limited.page
  await l.goto(`/b/${b.id}/sales`)
  await expect(l.locator('[data-sale-row]')).toHaveCount(1)
  // The Marina branch's 5 lattes (one branch: its name goes without saying).
  await expect(l.locator('[data-sale-row]')).toContainText(money('en', '90.00'))
  await l.goto(`/b/${b.id}/sales/${ownersSale.id}`)
  await expect(l.getByRole('heading', { name: 'Sale not found' })).toBeVisible()
  await l.goto(`/b/${b.id}/sales/new`)
  // Its One sale is at its only branch (nothing to pick); another branch is refused.
  await expect(l.getByRole('heading', { level: 1, name: 'One sale' })).toBeVisible()
  await expect(l.getByRole('combobox', { name: 'Branch' })).toHaveCount(0)
  await sell(limited.b, {
    channelId: shop,
    locationId: marina,
    businessDate: today,
    lines: [item(latte, '1', '18')],
  })
  expect(
    (
      await limited.b.raw('sale.create', {
        id: randomUUID(),
        source: 'single',
        channelId: shop,
        businessDate: today,
        lines: [item(latte, '1', '18')],
      })
    ).appCode,
  ).toBe('forbidden')
  await expectSound(l, 'en')
})

// ---------------------------------------------------------------------------------------------------
// Capabilities on the M3 screens
// ---------------------------------------------------------------------------------------------------

/** What a business's M3 screens offer: VAT, the branch, "Entered by", stock. */
/** Everything the page asked for has come (nothing loads any more). */
async function loaded(page: Page) {
  await page.waitForLoadState('networkidle')
  await settle(page)
}

async function m3Fields(page: Page, b: Api, saleId: string) {
  await page.goto(`/b/${b.id}/sales/new`)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await loaded(page)
  const sale = {
    branch: await page.getByRole('combobox', { name: 'Branch', exact: true }).count(),
    vat: await page.locator('[data-total="vat"]').count(),
  }
  await page.goto(`/b/${b.id}/sales/today`)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await loaded(page)
  const change = page.getByRole('button', { name: 'Change', exact: true })
  if (await change.isVisible()) await change.click()
  const today = {
    branch: await page.getByRole('combobox', { name: 'Branch', exact: true }).count(),
  }
  await page.goto(`/b/${b.id}/sales/${saleId}`)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await loaded(page)
  const view = {
    enteredBy: await page.getByText('Entered by', { exact: true }).count(),
    stock: await page
      .getByRole('main')
      .getByText(/\bstock\b/i)
      .count(),
  }
  await page.goto(`/b/${b.id}/invoices/new`)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await loaded(page)
  const invoice = {
    branch: await page.locator('[data-document-branch]').count(),
    lineVat: await page.getByRole('combobox', { name: 'VAT', exact: true }).count(),
  }
  await page.goto(`/b/${b.id}/reports/profit`)
  await expect(page.locator('[data-profit-controls]')).toBeVisible()
  await loaded(page)
  const report = { byBranch: await page.locator('[data-group-by="branch"]').count() }
  return { sale, today, view, invoice, report }
}

/** A workshop with a team, two branches and VAT; Quotations and Invoices on. */
const ALL_ON_ANSWERS = { ...WORKSHOP_ANSWERS, branches: true }

test('DoD: capabilities on the M3 screens: VAT fields only when VAT-registered, the branch picker and By branch only with branches, “Entered by” only with a team, no stock quantity', async ({
  browser,
}) => {
  test.setTimeout(600_000)
  const { page } = await open(browser, DESKTOP, 'en', 'Rashed')
  const all = await business(page, 'Falcon Workshop', ALL_ON_ANSWERS)
  await all.call('location.create', { id: randomUUID(), name: 'Deira branch' })
  const none = await business(page, 'Noura Designs', DESIGNER_ANSWERS)
  const sales: Record<string, string> = {}
  for (const b of [all, none]) {
    const today = await todayOf(b)
    const thing = await service(b, 'Design work', '500')
    sales[b.id] = (
      await sell(b, {
        channelId: await ownChannel(b),
        businessDate: today,
        lines: [item(thing, '1', '500')],
      })
    ).id
  }
  expect(await m3Fields(page, all, sales[all.id]!)).toEqual({
    sale: { branch: 1, vat: 1 },
    today: { branch: 1 },
    view: { enteredBy: 1, stock: 0 },
    invoice: { branch: 1, lineVat: 1 },
    report: { byBranch: 1 },
  })
  await expectSound(page, 'en')
  expect(await m3Fields(page, none, sales[none.id]!)).toEqual({
    sale: { branch: 0, vat: 0 },
    today: { branch: 0 },
    view: { enteredBy: 0, stock: 0 },
    invoice: { branch: 0, lineVat: 0 },
    report: { byBranch: 0 },
  })
  await expectSound(page, 'en')
})

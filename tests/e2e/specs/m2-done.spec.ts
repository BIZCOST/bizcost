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
  createBusiness,
  createUser,
  deleteUser,
  RAW_KEY,
  savedSetup,
  setLanguage,
  signIn,
  useLanguage,
  WORKSHOP_ANSWERS,
  type TestUser,
} from '../helpers'
import { baseURL } from '../stack'

// The M2 definition of done (ROADMAP.md §M2 definition of done), as the owner sees it on the screens,
// in English and Arabic. Each test names the line it proves; the API, database and domain suites
// prove the rest of each line (their files are named in ROADMAP.md Step 8).
//
//   - The owner's carton: 1 carton = 12 bottles × 1 L bought for AED 72 is AED 6.00 a litre, AED
//     0.0060 a ml (0.006 stored), and the 200 ml of a recipe cost AED 1.20.
//   - The owner's average: 50 L at AED 6, then 100 L at AED 7 → 6.666666666667 stored, AED 6.67
//     shown, and a product using 1 L costs AED 6.67; reversing the second brings it back to exactly 6,
//     shown at once on Product costs and Materials when reached through the app's own links (nothing
//     cached from before the reversal).
//   - The Spanish Latte (beans 18 g, milk 200 ml, condensed milk 25 ml, cup, lid, straw) from real
//     purchases: each line, its running costs "worked out automatically once you record your sales"
//     as a line of its own, and its total and margin before running costs.
//   - All of it typed in Arabic-Indic digits in Arabic (the material, the purchases, the recipe), and
//     every other quantity and price field in Arabic-Indic or Eastern Arabic-Indic digits (a return,
//     credit notes and a payment, whose purchase then says at once what is still owed).
//   - Capabilities hide VAT fields, branch pickers, approval and stock quantities where they don't
//     apply.
//   - Only the released modules appear: the navigation in both languages, planned modules that are
//     on never show and their addresses are "Page not found", a module switched off leaves the
//     navigation and its address says it is turned off.
// And what keeps the costs shown true: Product costs show at once what any screen changed (a
// purchase, a return, a recipe, a price, a material, a running cost, an expense and its reversal, a
// category, VAT registration in Business profile, the team in Customize BizCost), reached through
// the app's own links.

test.describe.configure({ mode: 'serial' })

const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1440, height: 900 }

type Locale = 'en' | 'ar'

/** A café with a team, one branch, not VAT-registered: no time line, no VAT in the prices. */
const CAFE_ANSWERS = {
  what_you_do: ['food_drinks'],
  workplace: 'shop',
  branches: false,
  team: 'team',
  team_tracking: ['hours'],
  work_setup: ['stock'],
  sales_channels: ['walk_in'],
  pos: true,
  vat: 'no',
}

/** A home baker: alone, one location, not VAT-registered. */
const BAKER_ANSWERS = {
  what_you_do: ['food_drinks'],
  workplace: 'home',
  team: 'alone',
  work_setup: ['none'],
  sales_channels: ['messages'],
  vat: 'no',
}

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
): Promise<Page> {
  const user = await createUser(`done-${locale}`, { locale: 'en' })
  users.push(user)
  const context = await browser.newContext({
    baseURL,
    locale: locale === 'ar' ? 'ar-AE' : 'en-US',
    viewport,
  })
  contexts.push(context)
  await useLanguage(context, 'en')
  const page = await context.newPage()
  await signIn(page, user)
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

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩'
const EASTERN_DIGITS = '۰۱۲۳۴۵۶۷۸۹'

/** `value` written in Arabic-Indic digits (and the Arabic decimal separator). */
function arabic(value: string): string {
  return value.replace(/\d/g, (d) => ARABIC_DIGITS[Number(d)]!).replace('.', '٫')
}

/** `value` written in Eastern Arabic-Indic digits (Persian and Urdu keyboards). */
function eastern(value: string): string {
  return value.replace(/\d/g, (d) => EASTERN_DIGITS[Number(d)]!)
}

/** An amount as the page writes it: "AED 6.00" in English; in Arabic, its number. */
function money(locale: Locale, value: string): RegExp {
  const number = value.replace(/[.]/g, '\\.')
  return locale === 'ar'
    ? new RegExp(`${number}[\\s\\u200e\\u200f]*د\\.إ\\.`)
    : new RegExp(`AED\\s${number}`)
}

async function today(page: Page, businessId: string): Promise<string> {
  return (
    await ok(
      callApi<{ today: string }>(page, 'books.get', {}, { businessId, query: true }),
      'books.get',
    )
  ).today
}

async function material(
  page: Page,
  businessId: string,
  name: string,
  unit: string,
  packs: object[] = [],
) {
  const id = randomUUID()
  await ok(callApi(page, 'material.create', { id, name, unit, packs }, { businessId }), name)
  return id
}

/** A final purchase without an invoice, paid in cash, dated today (through the API). */
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
    'post',
  )
}

/** What the API stores as a material's average (per its unit and per its base unit). */
async function averageOf(page: Page, businessId: string, materialId: string) {
  const costs = await ok(
    callApi<{ data: { items: { average: { perUnit: string; perBaseUnit: string } | null }[] } }>(
      page,
      'material.costs',
      { ids: [materialId] },
      { businessId, query: true },
    ),
    'material.costs',
  )
  return costs.data.items[0]?.average ?? null
}

/** What a product's materials cost for one unit sold, as stored (never rounded). */
async function materialsCostOf(page: Page, businessId: string, productId: string) {
  const product = await ok(
    callApi<{ data: { cost: { materials: string | null; total: string | null } } }>(
      page,
      'productCost.get',
      { productId },
      { businessId, query: true },
    ),
    'productCost.get',
  )
  return product.data.cost
}

/** A decimal string without the zeros it ends with ("6.000000000000" → "6"). */
function plain(value: string | null | undefined): string | null {
  if (value == null) return null
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value
}

interface Words {
  locale: Locale
  /** Numbers as typed: ASCII in English, Arabic-Indic digits in Arabic. */
  n: (value: string) => string
  L: (en: string, ar: string) => string
  milk: string
  freshMilk: string
  latte: string
  milkCup: string
  beans: string
  condensed: string
  cup: string
  lid: string
  straw: string
}

function words(locale: Locale): Words {
  const L = (en: string, ar: string) => (locale === 'ar' ? ar : en)
  return {
    locale,
    n: (value) => (locale === 'ar' ? arabic(value) : value),
    L,
    milk: L('Milk', 'حليب'),
    freshMilk: L('Fresh milk', 'حليب طازج'),
    latte: L('Spanish Latte', 'سبانش لاتيه'),
    milkCup: L('Milk by the litre', 'حليب باللتر'),
    beans: L('Coffee beans', 'حبوب القهوة'),
    condensed: L('Condensed milk', 'حليب مكثف'),
    cup: L('Cup', 'كوب'),
    lid: L('Lid', 'غطاء'),
    straw: L('Straw', 'مصاصة'),
  }
}

/** A purchase line's material: typed in its box, then picked from the list. */
async function pickMaterial(page: Page, w: Words, number: number, name: string): Promise<Locator> {
  const line = page.getByRole('group', { name: w.L(`Item ${number}`, `الصنف ${number}`) })
  await line
    .getByRole('combobox', { name: w.L('Ingredient or supply', 'المكوّن أو المستلزم') })
    .fill(name)
  await line.getByRole('option', { name, exact: true }).click()
  return line
}

/** Finalizes the purchase open in the editor, paid in cash; returns its address. */
async function finalizePurchase(page: Page, w: Words): Promise<string> {
  await page.getByRole('combobox', { name: w.L('How it was paid', 'طريقة الدفع') }).selectOption({
    label: w.L('Cash', 'نقدًا'),
  })
  await page.getByRole('button', { name: w.L('Finalize', 'اعتمد'), exact: true }).click()
  await page
    .getByRole('alertdialog', { name: w.L('Finalize this purchase?', 'اعتماد هذه المشتريات؟') })
    .getByRole('button', { name: w.L('Finalize', 'اعتمد') })
    .click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    w.locale === 'ar' ? /^مشتريات / : /^Purchase of /,
  )
  return new URL(page.url()).pathname
}

/** A material's row on the Materials page (by its exact name). */
function materialRow(page: Page, w: Words, name: string): Locator {
  return page
    .getByRole('list', { name: w.L('Ingredients & supplies', 'المكونات والمستلزمات') })
    .getByRole('listitem')
    .filter({ has: page.getByText(name, { exact: true }) })
}

/**
 * The owner's carton, the owner's average and the Spanish Latte, entered on the screens: the milk and
 * its packs in the Materials sheet, the purchases in the editor (the fresh milk added from its line),
 * the latte and its recipe in Products & Services, a reversal from the purchase.
 */
async function ownersExamples(page: Page, w: Words) {
  const { L, n, locale } = w
  const businessId = await createBusiness(page, L('Moon Café', 'مقهى القمر'), CAFE_ANSWERS)
  const base = `/b/${businessId}`
  // What else goes into the latte, bought through the API (the purchase editor is proven below).
  const bag = randomUUID()
  const beans = await material(page, businessId, w.beans, 'kg', [
    { id: bag, name: L('bag', 'كيس'), qty: '1', ofUnit: 'kg' },
  ])
  const can = randomUUID()
  const box = randomUUID()
  const condensed = await material(page, businessId, w.condensed, 'l', [
    { id: can, name: L('can', 'علبة'), qty: '385', ofUnit: 'ml' },
    { id: box, name: L('box', 'صندوق'), qty: '24', ofPackId: can },
  ])
  const sleeve = randomUUID()
  const cup = await material(page, businessId, w.cup, 'piece', [
    { id: sleeve, name: L('sleeve', 'رزمة'), qty: '50', ofUnit: 'piece' },
  ])
  const lidBox = randomUUID()
  const lid = await material(page, businessId, w.lid, 'piece', [
    { id: lidBox, name: L('box', 'كرتون'), qty: '100', ofUnit: 'piece' },
  ])
  const strawPack = randomUUID()
  const straw = await material(page, businessId, w.straw, 'piece', [
    { id: strawPack, name: L('pack', 'باكيت'), qty: '200', ofUnit: 'piece' },
  ])
  // 0.065 a gram, 95 ÷ 9,240 ml, 0.25 a cup, 0.09 a lid, 0.035 a straw.
  await buy(page, businessId, [
    { materialId: beans, qty: '2', packId: bag, unitPrice: '65' },
    { materialId: condensed, qty: '1', packId: box, unitPrice: '95' },
    { materialId: cup, qty: '2', packId: sleeve, unitPrice: '12.5' },
    { materialId: lid, qty: '1', packId: lidBox, unitPrice: '9' },
    { materialId: straw, qty: '1', packId: strawPack, unitPrice: '7' },
  ])

  // 1. The milk and its packs: 1 bottle = 1 L, 1 carton = 12 bottles.
  await page.goto(`${base}/materials`)
  await page
    .getByRole('button', { name: L('Add ingredient or supply', 'أضف مكوّنًا أو مستلزمًا') })
    .first()
    .click()
  const sheet = page.getByRole('dialog', {
    name: L('New ingredient or supply', 'مكوّن أو مستلزم جديد'),
  })
  await sheet.getByRole('textbox', { name: L('Name', 'الاسم') }).fill(w.milk)
  await sheet
    .getByRole('combobox', { name: L('Unit you use it in', 'الوحدة التي تستخدمه بها') })
    .selectOption('l')
  await sheet.getByRole('button', { name: L('Add a pack', 'أضف عبوة') }).click()
  const bottle = sheet.getByRole('group', { name: L('Pack 1', 'العبوة 1') })
  await bottle
    .getByRole('textbox', { name: L('Pack name', 'اسم العبوة') })
    .fill(L('bottle', 'زجاجة'))
  await bottle.getByRole('textbox', { name: L('How many', 'الكمية') }).fill(n('1'))
  await sheet.getByRole('button', { name: L('Add a pack', 'أضف عبوة') }).click()
  const carton = sheet.getByRole('group', { name: L('Pack 2', 'العبوة 2') })
  await carton
    .getByRole('textbox', { name: L('Pack name', 'اسم العبوة') })
    .fill(L('carton', 'كرتونة'))
  await carton.getByRole('textbox', { name: L('How many', 'الكمية') }).fill(n('12'))
  await carton
    .getByRole('combobox', { name: L('Of', 'من') })
    .selectOption({ label: L('bottle', 'زجاجة') })
  const chain = L('1 carton = 12 bottles = 12 L', '1 كرتونة = 12 زجاجة = 12 لتر')
  await expect(carton.getByText(chain, { exact: true })).toBeVisible()
  await sheet.getByRole('button', { name: L('Add', 'أضف'), exact: true }).click()
  await expect(sheet).toHaveCount(0)
  await expect(materialRow(page, w, w.milk)).toContainText(chain)
  await expect(materialRow(page, w, w.milk)).toContainText(L('No price yet', 'لا سعر بعد'))

  // 2. One carton for AED 72, typed in the purchase editor in the carton it was bought in.
  await page.goto(`${base}/purchases/new`)
  let line = await pickMaterial(page, w, 1, w.milk)
  await expect(line.getByRole('combobox', { name: L('Unit', 'الوحدة') })).toHaveValue(/^pack:/)
  await line.getByRole('textbox', { name: L('Quantity', 'الكمية') }).fill(n('1'))
  await line.getByRole('textbox', { name: L('Price per carton', 'السعر لكل كرتونة') }).fill(n('72'))
  await expect(line.locator('[data-qty-words]')).toContainText(L('= 12 L', '= 12 لتر'))
  // What it makes per litre, as it is typed.
  await expect(line.locator('[data-per-unit]')).toContainText(money(locale, '6.00'))
  await expect(line.locator('[data-line-total]')).toContainText(money(locale, '72.00'))
  await expectSound(page, locale)
  await finalizePurchase(page, w)

  // AED 6.00 a litre, AED 0.0060 a ml on the Materials page; 0.006 stored.
  await page.goto(`${base}/materials`)
  const milkRow = materialRow(page, w, w.milk)
  const average = milkRow.locator('[data-cost]').first()
  await expect(average).toContainText(L('Average cost:', 'متوسط التكلفة:'))
  await expect(average).toContainText(money(locale, '6.00'))
  await expect(average).toContainText(L('per L', 'لكل لتر'))
  await expect(average).toContainText(money(locale, '0.0060'))
  await expect(average).toContainText(L('per ml', 'لكل مل'))
  await expectSound(page, locale)
  const milkId = (
    await ok(
      callApi<{ items: { id: string; name: string }[] }>(
        page,
        'material.list',
        {},
        { businessId, query: true },
      ),
      'material.list',
    )
  ).items.find((item) => item.name === w.milk)!.id
  const carton72 = await averageOf(page, businessId, milkId)
  expect(plain(carton72?.perUnit)).toBe('6')
  expect(plain(carton72?.perBaseUnit)).toBe('0.006')

  // 3. The Spanish Latte, added on the screen, and its recipe: 200 ml of the milk costs AED 1.20.
  await page.goto(`${base}/products`)
  await page
    .getByRole('button', { name: L('Add product or service', 'أضف منتجًا أو خدمة') })
    .first()
    .click()
  const product = page.getByRole('dialog', {
    name: L('New product or service', 'منتج أو خدمة جديدة'),
  })
  await product.getByRole('textbox', { name: L('Name', 'الاسم') }).fill(w.latte)
  await product.getByRole('textbox', { name: L('Usual price', 'السعر المعتاد') }).fill(n('18'))
  await product.getByRole('button', { name: L('Add', 'أضف'), exact: true }).click()
  await expect(product).toHaveCount(0)
  const latteRow = page
    .getByRole('main')
    .locator('li')
    .filter({ has: page.getByText(w.latte, { exact: true }) })
  await latteRow.getByRole('button', { name: L('Recipe', 'الوصفة'), exact: true }).click()
  const recipe = page.getByRole('dialog')
  const lines = recipe.locator('[data-recipe-line]')
  const recipeLines: [string, string][] = [
    [w.beans, '18'],
    [w.milk, '200'],
    [w.condensed, '25'],
    [w.cup, '1'],
    [w.lid, '1'],
    [w.straw, '1'],
  ]
  for (const [index, [name, qty]] of recipeLines.entries()) {
    await recipe
      .getByRole('button', { name: L('Add an ingredient or supply', 'أضف مكوّنًا أو مستلزمًا') })
      .click()
    await lines
      .nth(index)
      .getByLabel(L('Ingredient or supply', 'المكوّن أو المستلزم'))
      .selectOption({ label: name })
    await lines.nth(index).getByLabel(L('How much', 'الكمية')).fill(n(qty))
  }
  await expect(lines.nth(1).locator('[data-qty-words]')).toHaveText(
    L('200 ml = 0.2 L', '200 مل = 0.2 لتر'),
  )
  await expect(lines.nth(1).locator('[data-line-cost]')).toContainText(money(locale, '1.20'))
  await expect(lines.nth(0).locator('[data-line-cost]')).toContainText(money(locale, '1.17'))
  await expect(lines.nth(2).locator('[data-line-cost]')).toContainText(money(locale, '0.26'))
  await expect(recipe.locator('[data-recipe-total]')).toContainText(money(locale, '3.00'))
  await expect(recipe.locator('[data-incomplete]')).toHaveCount(0)
  await expectSound(page, locale)
  await recipe.getByRole('button', { name: L('Save changes', 'احفظ التغييرات') }).click()
  await expect(recipe).toHaveCount(0)
  const latteId = (
    await ok(
      callApi<{ items: { id: string; name: string }[] }>(
        page,
        'product.list',
        {},
        { businessId, query: true },
      ),
      'product.list',
    )
  ).items.find((item) => item.name === w.latte)!.id
  // Exact: 1.17 + 1.20 + 0.257034632035 + 0.25 + 0.09 + 0.035.
  expect(plain((await materialsCostOf(page, businessId, latteId)).materials)).toBe('3.002034632035')

  // 4. The owner's average: 50 L of fresh milk at AED 6 (a new material added from its line; it
  // looks like "Milk", so the sheet asks first), then 100 L at AED 7.
  await page.goto(`${base}/purchases/new`)
  line = page.getByRole('group', { name: L('Item 1', 'الصنف 1') })
  await line
    .getByRole('combobox', { name: L('Ingredient or supply', 'المكوّن أو المستلزم') })
    .fill(w.freshMilk)
  await line.locator('[data-add-option]').click()
  const quick = page.getByRole('dialog', {
    name: L('New ingredient or supply', 'مكوّن أو مستلزم جديد'),
  })
  await expect(quick.locator('[data-similar]')).toContainText(w.milk)
  await quick.getByRole('button', { name: L('No, add it as new', 'لا، أضفه كجديد') }).click()
  await quick.getByText(L('Volume', 'الحجم'), { exact: true }).click()
  await quick.getByRole('button', { name: L('Add', 'أضف'), exact: true }).click()
  await expect(quick).toHaveCount(0)
  await line.getByRole('textbox', { name: L('Quantity', 'الكمية') }).fill(n('50'))
  await line.getByRole('textbox', { name: L('Price per L', 'السعر لكل لتر') }).fill(n('6'))
  await expect(line.locator('[data-line-total]')).toContainText(money(locale, '300.00'))
  await finalizePurchase(page, w)
  await page.goto(`${base}/purchases/new`)
  line = await pickMaterial(page, w, 1, w.freshMilk)
  await line.getByRole('textbox', { name: L('Quantity', 'الكمية') }).fill(n('100'))
  await line.getByRole('textbox', { name: L('Price per L', 'السعر لكل لتر') }).fill(n('7'))
  const second = await finalizePurchase(page, w)

  // A product using 1 L of it.
  const freshId = (
    await ok(
      callApi<{ items: { id: string; name: string }[] }>(
        page,
        'material.list',
        {},
        { businessId, query: true },
      ),
      'material.list',
    )
  ).items.find((item) => item.name === w.freshMilk)!.id
  const milkCupId = randomUUID()
  await ok(
    callApi(
      page,
      'product.create',
      { id: milkCupId, name: w.milkCup, type: 'product', unit: 'piece', defaultPrice: '9' },
      { businessId },
    ),
    'product.create',
  )
  await ok(
    callApi(
      page,
      'recipe.save',
      {
        productId: milkCupId,
        version: 0,
        lines: [{ id: randomUUID(), materialId: freshId, qty: '1', unit: 'l' }],
      },
      { businessId },
    ),
    'recipe.save',
  )

  // (50 × 6 + 100 × 7) ÷ 150: 6.666666666667 stored, AED 6.67 shown, and the product costs AED 6.67.
  const wac = await averageOf(page, businessId, freshId)
  expect(wac?.perUnit).toBe('6.666666666667')
  expect((await materialsCostOf(page, businessId, milkCupId)).materials).toBe('6.666666666667')
  await page.goto(`${base}/materials`)
  const fresh = materialRow(page, w, w.freshMilk).locator('[data-cost]').first()
  await expect(fresh).toContainText(money(locale, '6.67'))
  await expect(fresh).toContainText(L('per L', 'لكل لتر'))
  await page.goto(`${base}/product-costs`)
  const milkCupRow = page.locator(`[data-product-cost-row="${w.milkCup}"]`)
  await expect(milkCupRow.locator('[data-figure="cost"]')).toContainText(money(locale, '6.67'))

  // The Spanish Latte, line by line, from real purchases: its running costs a line of their own,
  // worked out once sales are recorded; its total and margin before running costs.
  await expect(
    page.locator(`[data-product-cost-row="${w.latte}"] [data-figure="cost"]`),
  ).toContainText(money(locale, '3.00'))
  await expectSound(page, locale)
  await page.goto(`${base}/product-costs/${latteId}`)
  await expect(page.locator('[data-material-line]:visible')).toHaveCount(6)
  const milkLine = page.locator(`[data-material-line="${w.milk}"]:visible`)
  await expect(milkLine).toContainText(L('200 ml', '200 مل'))
  await expect(milkLine).toContainText(money(locale, '1.20'))
  await expect(page.locator(`[data-material-line="${w.beans}"]:visible`)).toContainText(
    money(locale, '1.17'),
  )
  const running = page.locator('[data-line="running"]')
  await expect(running).toContainText(L('Running costs', 'المصاريف التشغيلية'))
  await expect(running.locator('[data-awaiting]')).toHaveText(
    L('Worked out automatically once you record your sales.', 'تُحسب تلقائيًا بعد تسجيل مبيعاتك.'),
  )
  await expect(page.locator('[data-line="total"]')).toContainText(
    L('Cost per piece before running costs', 'التكلفة لكل قطعة قبل المصاريف التشغيلية'),
  )
  await expect(page.locator('[data-line="total"]')).toContainText(money(locale, '3.00'))
  await expect(page.locator('[data-line="margin"]')).toContainText(
    L('Margin before running costs', 'هامش الربح قبل المصاريف التشغيلية'),
  )
  await expect(page.locator('[data-line="margin"]')).toContainText(money(locale, '15.00'))
  // A team: no "Your time" line.
  await expect(page.locator('[data-line="time"]')).toHaveCount(0)
  await expectSound(page, locale)

  // 5. Reverse the second purchase, going through the app's own links (nothing reloads, so nothing
  // shown may be left from before): exactly 6 again, on the material and the product, at once.
  await section(page, w, L('Product costs', 'تكاليف المنتجات'))
  await expect(milkCupRow.locator('[data-figure="cost"]')).toContainText(money(locale, '6.67'))
  await section(page, w, L('Purchases', 'المشتريات'))
  await page.getByRole('main').locator(`a[href="${second}"]`).click()
  await page.getByRole('button', { name: L('Reverse', 'إبطال'), exact: true }).click()
  await page
    .getByRole('alertdialog', { name: L('Reverse this purchase?', 'إبطال هذه المشتريات؟') })
    .getByRole('button', { name: L('Reverse', 'إبطال') })
    .click()
  await expect(page.getByText(L('Reversed', 'مُبطلة'), { exact: true }).first()).toBeVisible()
  expect(plain((await averageOf(page, businessId, freshId))?.perUnit)).toBe('6')
  expect(plain((await materialsCostOf(page, businessId, milkCupId)).materials)).toBe('6')
  await section(page, w, L('Product costs', 'تكاليف المنتجات'))
  await expect(milkCupRow.locator('[data-figure="cost"]')).toContainText(money(locale, '6.00'))
  await expectSound(page, locale)
  await section(page, w, L('Ingredients & supplies', 'المكونات والمستلزمات'))
  await expect(fresh).toContainText(money(locale, '6.00'))
  await expectSound(page, locale)
}

/** Opens a section from the navigation: the sidebar, or the phone's tab bar and its "More". */
async function section(page: Page, w: Words, name: string) {
  // A dialog closing still hides the rest of the page from assistive technology (and getByRole).
  await expect(page.getByRole('dialog').or(page.getByRole('alertdialog'))).toHaveCount(0)
  const nav = page.getByRole('navigation', { name: w.L('Main', 'القائمة الرئيسية') })
  const link = nav.getByRole('link', { name, exact: true })
  const more = nav.getByRole('button', { name: w.L('More', 'المزيد') })
  await expect(link.or(more).first()).toBeVisible()
  if (await link.isVisible()) await link.click()
  else {
    await more.click()
    await page.getByRole('menuitem', { name, exact: true }).click()
  }
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name)
}

test('DoD: the owner’s carton, the owner’s average and the Spanish Latte, end to end in English (desktop)', async ({
  browser,
}) => {
  test.setTimeout(300_000)
  await ownersExamples(await open(browser, DESKTOP, 'en'), words('en'))
})

test('DoD: the same in Arabic on a phone, every number typed in Arabic-Indic digits', async ({
  browser,
}) => {
  test.setTimeout(300_000)
  await ownersExamples(await open(browser, PHONE, 'ar'), words('ar'))
})

test('DoD: every other quantity and price field takes Arabic-Indic and Eastern Arabic-Indic digits', async ({
  browser,
}) => {
  test.setTimeout(300_000)
  const page = await open(browser, DESKTOP, 'en')
  const businessId = await createBusiness(page, 'Sara Bakes', BAKER_ANSWERS)
  const base = `/b/${businessId}`
  await ok(
    callApi(page, 'supplier.create', { id: randomUUID(), name: 'Village Mill' }, { businessId }),
    'supplier.create',
  )
  const total = (key: string) => page.locator(`[data-total="${key}"]`)

  // A material's conversion: honey used by weight, bought by volume, 1 L = 1.4 kg (Eastern digits).
  await page.goto(`${base}/materials`)
  await page.getByRole('button', { name: 'Add ingredient or supply' }).first().click()
  const sheet = page.getByRole('dialog', { name: 'New ingredient or supply' })
  await sheet.getByRole('textbox', { name: 'Name' }).fill('Honey')
  await sheet.getByRole('combobox', { name: 'Unit you use it in' }).selectOption('kg')
  await sheet.getByRole('button', { name: 'Add a conversion' }).click()
  const conversion = sheet.getByRole('group', { name: 'Conversion 1' })
  await conversion.getByRole('combobox', { name: 'Unit' }).selectOption('l')
  await conversion.getByRole('textbox', { name: 'How many' }).fill(eastern('1.4'))
  await conversion.getByRole('combobox', { name: 'Of' }).selectOption('kg')
  await sheet.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(sheet).toHaveCount(0)
  const honey = (
    await ok(
      callApi<{ items: { id: string; name: string }[] }>(
        page,
        'material.list',
        {},
        { businessId, query: true },
      ),
      'material.list',
    )
  ).items.find((item) => item.name === 'Honey')!
  const saved = await ok(
    callApi<{ crossFactors: { qty: string }[] }>(
      page,
      'material.get',
      { id: honey.id },
      { businessId, query: true },
    ),
    'material.get',
  )
  expect(saved.crossFactors.map((factor) => plain(factor.qty))).toEqual(['1.4'])

  // A purchase on credit: 10 kg of flour at 4.5 (Arabic-Indic, with the Arabic decimal separator),
  // 10% off the line (Eastern), delivery 5 and 2 off the whole purchase (Arabic-Indic): 45 + 5 =
  // 50 before the discounts of 4.50 and 2, so 43.50.
  await material(page, businessId, 'Flour', 'kg')
  await page.goto(`${base}/purchases/new`)
  await page.getByRole('combobox', { name: 'Supplier' }).selectOption({ label: 'Village Mill' })
  const line = await pickMaterial(page, words('en'), 1, 'Flour')
  await line.getByRole('textbox', { name: 'Quantity' }).fill(arabic('10'))
  await line.getByRole('textbox', { name: 'Price per kg' }).fill(arabic('4.5'))
  await expect(line.locator('[data-line-total]')).toContainText('AED 45.00')
  await line.getByRole('button', { name: 'Add a discount' }).click()
  await line.getByRole('textbox', { name: 'Discount', exact: true }).fill(eastern('10'))
  await expect(line.locator('[data-line-total]')).toContainText('AED 40.50')
  await page.getByRole('button', { name: 'Add delivery on this invoice' }).click()
  await page.getByRole('textbox', { name: 'Delivery amount' }).fill(arabic('5'))
  await page.getByRole('button', { name: 'Add a discount on the whole purchase' }).click()
  await page.getByRole('combobox', { name: 'Kind of discount' }).last().selectOption('amount')
  await page.getByRole('textbox', { name: 'Discount on the whole purchase' }).fill(arabic('2'))
  await expect(total('subtotal')).toContainText('AED 50.00')
  await expect(total('discount')).toContainText('AED 6.50')
  await expect(total('total')).toContainText('AED 43.50')
  await page.getByRole('combobox', { name: 'How it was paid' }).selectOption({
    label: 'On credit: we pay the supplier later',
  })
  await page.getByRole('button', { name: 'Finalize', exact: true }).click()
  await page
    .getByRole('alertdialog', { name: 'Finalize this purchase?' })
    .getByRole('button', { name: 'Finalize' })
    .click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Purchase of /)
  await expect(page.locator('[data-purchase-line]')).toContainText('Cost of the goods: AED 43.50')

  // A return of 2 kg (Eastern): its value is 2 tenths of what the flour was paid after its discounts,
  // (45 − 4.50 − 2) × 0.2 = 7.70 (the delivery stays paid, D-143).
  await page.getByRole('button', { name: 'Return goods' }).click()
  const returnSheet = page.getByRole('dialog', { name: 'Return goods to the supplier' })
  await returnSheet
    .getByRole('textbox', { name: /^How many of .*Flour.* to return$/ })
    .fill(eastern('2'))
  await returnSheet.getByRole('button', { name: 'Finalize' }).click()
  const confirmReturn = page.getByRole('alertdialog', { name: 'Finalize this return?' })
  await expect(confirmReturn).toContainText('AED 7.70')
  await confirmReturn.getByRole('button', { name: 'Finalize' }).click()
  await expect(page.locator('[data-purchase-line]')).toContainText('2 kg returned')

  // Credit notes: 3 on the line (Arabic-Indic), then 1.50 on the whole purchase (Eastern).
  const documents = page.getByRole('list', { name: 'Returns and credit notes' })
  await page.getByRole('button', { name: 'Credit note', exact: true }).click()
  let credit = page.getByRole('dialog', { name: 'Credit note from the supplier' })
  await credit.getByRole('textbox', { name: /^Amount for .*Flour/ }).fill(arabic('3'))
  await credit.getByRole('button', { name: 'Finalize' }).click()
  await page
    .getByRole('alertdialog', { name: 'Finalize this credit note?' })
    .getByRole('button', { name: 'Finalize' })
    .click()
  await expect(documents.getByRole('listitem')).toHaveCount(2)
  await page.getByRole('button', { name: 'Credit note', exact: true }).click()
  credit = page.getByRole('dialog', { name: 'Credit note from the supplier' })
  await credit.getByText('One amount for the whole purchase').click()
  await credit.getByRole('textbox', { name: 'Amount', exact: true }).fill(eastern('1.50'))
  await credit.getByRole('button', { name: 'Finalize' }).click()
  await page
    .getByRole('alertdialog', { name: 'Finalize this credit note?' })
    .getByRole('button', { name: 'Finalize' })
    .click()
  await expect(documents.getByRole('listitem')).toHaveCount(3)
  await expect(documents).toContainText('AED 3.00')
  await expect(documents).toContainText('AED 1.50')
  // Still owed: 43.50 − 7.70 − 3 − 1.50 = 31.30. A payment of 10 (Arabic-Indic) leaves 21.30.
  await expect(page.locator('[data-owed="outstanding"]')).toContainText('AED 31.30')
  await page.getByRole('button', { name: 'Record a payment' }).click()
  const payment = page.getByRole('dialog', { name: 'Record a payment' })
  await payment.getByRole('textbox', { name: 'Amount' }).fill(arabic('10'))
  await payment.getByRole('combobox', { name: 'How you paid' }).selectOption({ label: 'Cash' })
  await payment.getByRole('button', { name: 'Record payment' }).click()
  await expect(payment).toHaveCount(0)
  await expect(page.locator('[data-owed="paid"]')).toContainText('AED 10.00')
  await expect(page.locator('[data-owed="outstanding"]')).toContainText('AED 21.30')

  // An expense of 250 (Eastern).
  await page.goto(`${base}/expenses/new`)
  await page.getByRole('textbox', { name: 'Amount' }).fill(eastern('250'))
  await page
    .getByRole('combobox', { name: 'Category', exact: true })
    .selectOption({ label: 'Other' })
  await page.getByRole('combobox', { name: 'How it was paid' }).selectOption({ label: 'Cash' })
  await page.getByRole('button', { name: 'Finalize' }).click()
  await page
    .getByRole('alertdialog', { name: 'Finalize this expense?' })
    .getByRole('button', { name: 'Finalize' })
    .click()
  await expect(page.getByText('Expense finalized.')).toBeVisible()
  await expect(page.locator('[data-total="total"]')).toContainText('AED 250.00')

  // A running cost of 1,500 a month (Arabic-Indic, with the Arabic thousands separator).
  await page.goto(`${base}/running-costs`)
  await page
    .getByRole('list', { name: 'Add what you pay' })
    .getByRole('button', { name: 'Rent', exact: true })
    .click()
  const running = page.getByRole('dialog', { name: 'New running cost' })
  await running.getByRole('textbox', { name: 'How much' }).fill('١٬٥٠٠')
  await running.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(running).toHaveCount(0)
  await expect(page.locator('[data-running-cost="Rent"]')).toContainText('AED 1,500.00 a month')

  // A cake slice: its price (Arabic-Indic) and her minutes (Eastern); a recipe that makes 12
  // (Arabic-Indic) with 500 g of flour (Eastern); her hourly rate of 40 (Arabic-Indic).
  await page.goto(`${base}/products`)
  await page.getByRole('button', { name: 'Add product or service' }).first().click()
  const product = page.getByRole('dialog', { name: 'New product or service' })
  await product.getByRole('textbox', { name: 'Name' }).fill('Cake slice')
  await product.getByRole('textbox', { name: 'Usual price' }).fill(arabic('24'))
  await product.getByRole('textbox', { name: /^Your time/ }).fill(eastern('15'))
  await product.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(product).toHaveCount(0)
  const row = page
    .getByRole('main')
    .locator('li')
    .filter({ has: page.getByText('Cake slice', { exact: true }) })
  await expect(row).toContainText('AED 24.00')
  await row.getByRole('button', { name: 'Recipe', exact: true }).click()
  const recipe = page.getByRole('dialog')
  await recipe.getByRole('textbox', { name: 'This recipe makes' }).fill(arabic('12'))
  await recipe.getByRole('button', { name: 'Add an ingredient or supply' }).click()
  const recipeLine = recipe.locator('[data-recipe-line]').first()
  await recipeLine.getByLabel('Ingredient or supply').selectOption({ label: 'Flour' })
  await recipeLine.getByLabel('How much').fill(eastern('500'))
  await expect(recipeLine.locator('[data-qty-words]')).toHaveText('500 g = 0.5 kg')
  await recipe.getByRole('button', { name: 'Save changes' }).click()
  await expect(recipe).toHaveCount(0)
  await page.goto(`${base}/settings/costing`)
  await page
    .getByRole('textbox', { name: 'How much is an hour of your time worth?' })
    .fill(arabic('40'))
  await page.locator('[data-setting="hourlyRate"]').getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Saved.')).toBeVisible()
  const cakeId = (
    await ok(
      callApi<{ items: { id: string; name: string }[] }>(
        page,
        'product.list',
        {},
        { businessId, query: true },
      ),
      'product.list',
    )
  ).items.find((item) => item.name === 'Cake slice')!.id
  await page.goto(`${base}/product-costs/${cakeId}`)
  await expect(page.locator('[data-line="time"]')).toContainText('15 minutes at AED 40.00 an hour.')
  await expect(page.locator('[data-line="time"]')).toContainText('AED 10.00')
  await expect(page.locator('[data-line="materials"] [data-whole]')).toContainText(
    'makes 12 pieces',
  )
  await expectSound(page, 'en')
})

/** The month (YYYY-MM) before `day`'s. */
function monthBefore(day: string): string {
  const [year, month] = day.split('-').map(Number) as [number, number]
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`
}

test('Product costs show at once what any screen just changed, reached through the app (no reload)', async ({
  browser,
}) => {
  // Product costs keep what they read for 30 s (the business's query cache): every screen that
  // changes a cost, a price or the month's costs refreshes them. Each step loads Product costs, makes
  // the change on its screen, and comes back through the navigation (no reload): the change shows
  // at once, or the step fails.
  test.setTimeout(300_000)
  const w = words('en')
  const page = await open(browser, DESKTOP, 'en')
  const businessId = await createBusiness(page, 'Fresh Café', CAFE_ANSWERS)
  const base = `/b/${businessId}`
  const day = await today(page, businessId)
  const lastMonth = monthBefore(day)
  const milk = await material(page, businessId, 'Milk', 'l')
  await buy(page, businessId, [{ materialId: milk, qty: '10', unit: 'l', unitPrice: '6' }])
  const cupId = randomUUID()
  await ok(
    callApi(
      page,
      'product.create',
      { id: cupId, name: 'Milk cup', type: 'product', unit: 'piece', defaultPrice: '9' },
      { businessId },
    ),
    'product.create',
  )
  await ok(
    callApi(
      page,
      'recipe.save',
      {
        productId: cupId,
        version: 0,
        lines: [{ id: randomUUID(), materialId: milk, qty: '1', unit: 'l' }],
      },
      { businessId },
    ),
    'recipe.save',
  )
  const categories = new Map(
    (
      await ok(
        callApi<{ items: { id: string; name: string }[] }>(
          page,
          'costCategory.list',
          { limit: 100 },
          { businessId, query: true },
        ),
        'costCategory.list',
      )
    ).items.map((category) => [category.name, category.id]),
  )
  await ok(
    callApi(
      page,
      'runningCost.create',
      {
        id: randomUUID(),
        name: 'Shop rent',
        categoryId: categories.get('Rent'),
        amount: '1000',
        frequency: 'monthly',
        startsOn: `${monthBefore(`${lastMonth}-01`)}-01`,
      },
      { businessId },
    ),
    'runningCost.create',
  )

  const cupRow = page.locator('[data-product-cost-row="Milk cup"]')
  const cost = cupRow.locator('[data-figure="cost"]')
  const monthCategory = (name: string) => page.locator(`[data-month-category="${name}"]`)
  const productCosts = () => section(page, w, 'Product costs')
  await page.goto(`${base}/product-costs`)
  await expect(cost).toContainText('AED 6.00')
  await expect(monthCategory('Rent')).toContainText('AED 1,000.00')

  // 1. A purchase finalized in the editor: 10 L more at AED 8 → (60 + 80) ÷ 20 = 7.
  await section(page, w, 'Purchases')
  await page.getByRole('main').getByRole('link', { name: 'New purchase' }).first().click()
  const line = await pickMaterial(page, w, 1, 'Milk')
  await line.getByRole('textbox', { name: 'Quantity' }).fill('10')
  await line.getByRole('textbox', { name: 'Price per L' }).fill('8')
  const bought = await finalizePurchase(page, w)
  await productCosts()
  await expect(cost).toContainText('AED 7.00')

  // 2. All of it sent back from the purchase: the average is 6 again.
  await section(page, w, 'Purchases')
  await page.getByRole('main').locator(`a[href="${bought}"]`).first().click()
  await page.getByRole('button', { name: 'Return goods' }).click()
  const returnSheet = page.getByRole('dialog', { name: 'Return goods to the supplier' })
  await returnSheet.getByRole('textbox', { name: /^How many of .*Milk.* to return$/ }).fill('10')
  await returnSheet.getByRole('button', { name: 'Finalize' }).click()
  await page
    .getByRole('alertdialog', { name: 'Finalize this return?' })
    .getByRole('button', { name: 'Finalize' })
    .click()
  await expect(page.locator('[data-purchase-line]')).toContainText('10 L returned')
  await productCosts()
  await expect(cost).toContainText('AED 6.00')

  // 3. The recipe changed from Products & Services: 2 L → AED 12.00.
  await section(page, w, 'Products & Services')
  const productRow = page
    .getByRole('main')
    .locator('li')
    .filter({ has: page.getByText('Milk cup', { exact: true }) })
  await productRow.getByRole('button', { name: 'Recipe', exact: true }).click()
  const recipe = page.getByRole('dialog')
  await recipe.locator('[data-recipe-line]').first().getByLabel('How much').fill('2')
  await recipe.getByRole('button', { name: 'Save changes' }).click()
  await expect(recipe).toHaveCount(0)
  await productCosts()
  await expect(cost).toContainText('AED 12.00')

  // 4. Its price changed in its sheet: AED 20.00, a margin of AED 8.00.
  await section(page, w, 'Products & Services')
  await productRow.getByText('Milk cup', { exact: true }).click()
  const productSheet = page.getByRole('dialog')
  await productSheet.getByRole('textbox', { name: 'Usual price' }).fill('20')
  await productSheet.getByRole('button', { name: 'Save changes' }).click()
  await expect(productSheet).toHaveCount(0)
  await productCosts()
  await expect(cupRow.locator('[data-figure="price"]')).toContainText('AED 20.00')
  await expect(cupRow.locator('[data-figure="margin"]')).toContainText('AED 8.00')

  // 5. The material renamed: the product's breakdown names it so.
  await page
    .getByRole('main')
    .getByRole('link', { name: /Milk cup/ })
    .first()
    .click()
  await expect(page.locator('[data-material-line="Milk"]:visible')).toHaveCount(1)
  await section(page, w, 'Ingredients & supplies')
  await page.getByRole('main').getByText('Milk', { exact: true }).click()
  const materialSheet = page.getByRole('dialog', { name: 'Milk' })
  await materialSheet.getByRole('textbox', { name: 'Name' }).fill('Fresh milk')
  await materialSheet.getByRole('button', { name: 'Save changes' }).click()
  await expect(materialSheet).toHaveCount(0)
  await productCosts()
  await page
    .getByRole('main')
    .getByRole('link', { name: /Milk cup/ })
    .first()
    .click()
  await expect(page.locator('[data-material-line="Fresh milk"]:visible')).toHaveCount(1)
  await productCosts()

  // 6. The rent changed in Running Costs: last month's costs say so.
  await section(page, w, 'Running Costs')
  await page.locator('[data-running-cost="Shop rent"]').first().click()
  const running = page.getByRole('dialog')
  await running.getByRole('textbox', { name: 'How much' }).fill('1500')
  await running.getByRole('button', { name: 'Save changes' }).click()
  await expect(running).toHaveCount(0)
  await productCosts()
  await expect(monthCategory('Rent')).toContainText('AED 1,500.00')

  // 7. Last month's electricity bill finalized in the editor: a category of the month's costs.
  await section(page, w, 'Expenses')
  await page.getByRole('main').getByRole('link', { name: 'New expense' }).first().click()
  await page.getByRole('textbox', { name: 'Amount' }).fill('300')
  await page
    .getByRole('combobox', { name: 'Category', exact: true })
    .selectOption({ label: 'Electricity' })
  await page.getByRole('combobox', { name: 'For which month?' }).selectOption(lastMonth)
  await page.getByRole('combobox', { name: 'How it was paid' }).selectOption({ label: 'Cash' })
  await page.getByRole('button', { name: 'Finalize' }).click()
  await page
    .getByRole('alertdialog', { name: 'Finalize this expense?' })
    .getByRole('button', { name: 'Finalize' })
    .click()
  await expect(page.getByText('Expense finalized.')).toBeVisible()
  await expect(page).toHaveURL(/\/expenses\/[0-9a-f-]{36}$/)
  const bill = new URL(page.url()).pathname
  await productCosts()
  await expect(monthCategory('Electricity')).toContainText('AED 300.00')

  // 8. That bill reversed from its page: no longer in the month's costs.
  await section(page, w, 'Expenses')
  await page.getByRole('main').locator(`a[href="${bill}"]`).first().click()
  await page.getByRole('button', { name: 'Reverse', exact: true }).click()
  await page
    .getByRole('alertdialog', { name: 'Reverse this expense?' })
    .getByRole('button', { name: 'Reverse' })
    .click()
  await expect(page.getByText('Expense reversed.')).toBeVisible()
  await productCosts()
  await expect(monthCategory('Electricity')).toHaveCount(0)

  // 9. The rent's category renamed in Categories: the month's costs name it so.
  await section(page, w, 'Expenses')
  await page.getByRole('button', { name: 'Categories', exact: true }).click()
  const categoriesSheet = page.getByRole('dialog', { name: 'Categories' })
  await categoriesSheet
    .locator('[data-category="Rent"]')
    .getByRole('button', { name: /^Edit .*Rent/ })
    .click()
  await categoriesSheet.getByRole('textbox', { name: /^New name for .*Rent/ }).fill('Shop premises')
  await categoriesSheet.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Category saved.')).toBeVisible()
  await categoriesSheet.getByRole('button', { name: 'Close' }).first().click()
  await expect(categoriesSheet).toHaveCount(0)
  await productCosts()
  await expect(monthCategory('Shop premises')).toContainText('AED 1,500.00')

  // 10. VAT registration turned off in Business profile: the cup's price no longer includes VAT.
  // Set up through the API (then a load): the café registered, the cup's AED 20 including VAT.
  const profile = await ok(
    callApi<{ version: number; legalName: string; legalNameAr: string | null }>(
      page,
      'business.profile',
      {},
      { businessId, query: true },
    ),
    'business.profile',
  )
  await ok(
    callApi(
      page,
      'business.updateProfile',
      {
        version: profile.version,
        legalName: profile.legalName,
        legalNameAr: profile.legalNameAr,
        vatRegistered: true,
        trn: '100123456700003',
      },
      { businessId },
    ),
    'business.updateProfile',
  )
  const cup = await ok(
    callApi<{ version: number }>(page, 'product.get', { id: cupId }, { businessId, query: true }),
    'product.get',
  )
  await ok(
    callApi(
      page,
      'product.update',
      {
        id: cupId,
        version: cup.version,
        name: 'Milk cup',
        type: 'product',
        unit: 'piece',
        defaultPrice: '20',
        vatCategory: 'standard',
        priceIncludesVat: true,
      },
      { businessId },
    ),
    'product.update',
  )
  await page.goto(`${base}/product-costs`)
  // 20 ÷ 1.05 = 19.05 before VAT, a margin of 7.05 on the cost of 12.
  await expect(cupRow.locator('[data-before-vat]')).toContainText('AED 19.05')
  await expect(cupRow.locator('[data-figure="margin"]')).toContainText('AED 7.05')
  const settingsSection = (name: RegExp) =>
    page
      .getByRole('list', { name: 'Business settings' })
      .getByRole('link')
      .filter({ hasText: name })
  await section(page, w, 'Settings')
  await settingsSection(/^Business profile/).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Business profile' })).toBeVisible()
  await page.getByRole('switch', { name: 'Registered for VAT' }).click()
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Business details saved.')).toBeVisible()
  await productCosts()
  await expect(cupRow.locator('[data-before-vat]')).toHaveCount(0)
  await expect(cupRow.locator('[data-figure="margin"]')).toContainText('AED 8.00')

  // 11. "Others work with you" switched off in Customize BizCost: the owner's time counts now, and
  // the cup says it is not added yet.
  await expect(cupRow).not.toContainText('Your time not added')
  await section(page, w, 'Settings')
  await settingsSection(/^Customize BizCost/).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Customize BizCost' })).toBeVisible()
  const teamRow = page.locator('[data-item="capability:has_team"]')
  const team = teamRow.getByRole('switch')
  await expect(team).toBeChecked()
  await team.click()
  // What else turns off with it is asked first.
  const confirm = page.getByRole('alertdialog')
  await expect(confirm.or(teamRow.locator('[role="switch"][aria-checked="false"]'))).toBeVisible()
  if (await confirm.isVisible()) await confirm.getByRole('button', { name: 'Turn off' }).click()
  await expect(team).not.toBeChecked()
  await productCosts()
  await expect(cupRow.locator('[data-reasons]')).toContainText('Your time not added')
  await expectSound(page, 'en')
})

/** The VAT, branch, approval and payer fields a business sees, on its screens. */
async function capabilityFields(page: Page, base: string, w: Words) {
  const { L } = w
  await page.goto(`${base}/purchases/new`)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  // The line's material, named in each business's wording ("Material", "Ingredient or supply").
  const item = page.getByRole('group', { name: L('Item 1', 'الصنف 1') })
  await item.getByRole('combobox').first().fill('Flour')
  await item.getByRole('option', { name: 'Flour', exact: true }).click()
  const purchase = {
    vatMode: await page
      .getByRole('group', { name: L('VAT in the prices', 'الضريبة في الأسعار') })
      .count(),
    vatNotReclaimable: await page
      .getByRole('switch', { name: L("VAT can't be reclaimed", 'لا يمكن استرداد الضريبة') })
      .count(),
    branch: await page.getByRole('combobox', { name: L('Branch', 'الفرع'), exact: true }).count(),
    paidByEmployee: await page
      .getByRole('combobox', { name: L('How it was paid', 'طريقة الدفع') })
      .locator('option', {
        hasText: L('Paid by an employee from their own money', 'دفعه موظف من ماله الخاص'),
      })
      .count(),
    lineVat: await page
      .getByRole('group', { name: L('Item 1', 'الصنف 1') })
      .getByRole('combobox', { name: L('VAT', 'الضريبة'), exact: true })
      .count(),
  }
  await page.goto(`${base}/expenses/new`)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  const expense = {
    vatMode: await page
      .getByRole('group', { name: L('VAT in the amount', 'الضريبة في المبلغ') })
      .count(),
    vat: await page
      .getByRole('combobox', { name: L('VAT on the bill', 'الضريبة في الفاتورة') })
      .count(),
    branch: await page.getByRole('combobox', { name: L('Branch', 'الفرع'), exact: true }).count(),
  }
  await page.goto(`${base}/products/new`)
  const sheet = page.getByRole('dialog')
  await expect(sheet).toBeVisible()
  const product = {
    vatType: await sheet.getByRole('combobox', { name: L('VAT type', 'نوع الضريبة') }).count(),
    whereSold: await sheet.getByText(L("Where it's sold", 'أين يُباع'), { exact: true }).count(),
  }
  await page.goto(`${base}/settings`)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  const settings = {
    approval: await page
      .getByRole('main')
      .getByRole('link', {
        name: new RegExp(`^${L('Expense approval', 'الموافقة على المصروفات')}`),
      })
      .count(),
  }
  return { purchase, expense, product, settings }
}

test('DoD: capabilities hide VAT fields, branch pickers, approval and stock quantities where they don’t apply', async ({
  browser,
}) => {
  test.setTimeout(300_000)
  const page = await open(browser, DESKTOP, 'en')
  // A workshop with a team, two branches and VAT; a home baker with none of them. Each has bought
  // 7 kg of flour: nothing on any screen says how much of it is in stock.
  const workshopId = await createBusiness(page, 'Falcon Workshop', WORKSHOP_ANSWERS)
  await ok(
    callApi(
      page,
      'location.create',
      { id: randomUUID(), name: 'Deira branch' },
      { businessId: workshopId },
    ),
    'location',
  )
  const bakerId = await createBusiness(page, 'Sara Bakes', BAKER_ANSWERS)
  for (const businessId of [workshopId, bakerId]) {
    const flour = await material(page, businessId, 'Flour', 'kg')
    await buy(page, businessId, [{ materialId: flour, qty: '7', unit: 'kg', unitPrice: '5' }])
  }

  for (const [locale, viewport] of [
    ['en', DESKTOP],
    ['ar', PHONE],
  ] as const) {
    await setLanguage(page, locale)
    await page.setViewportSize(viewport)
    const w = words(locale)
    const all = await capabilityFields(page, `/b/${workshopId}`, w)
    expect(all, `${locale}: every capability on`).toEqual({
      purchase: { vatMode: 1, vatNotReclaimable: 1, branch: 1, paidByEmployee: 1, lineVat: 1 },
      expense: { vatMode: 1, vat: 1, branch: 1 },
      product: { vatType: 1, whereSold: 1 },
      settings: { approval: 1 },
    })
    const none = await capabilityFields(page, `/b/${bakerId}`, w)
    expect(none, `${locale}: no VAT, one location, no team`).toEqual({
      purchase: { vatMode: 0, vatNotReclaimable: 0, branch: 0, paidByEmployee: 0, lineVat: 0 },
      expense: { vatMode: 0, vat: 0, branch: 0 },
      product: { vatType: 0, whereSold: 0 },
      settings: { approval: 0 },
    })
    // No stock quantities: the material's row has its cost, never how much is left.
    for (const businessId of [workshopId, bakerId]) {
      await page.goto(`/b/${businessId}/materials`)
      const row = page
        .getByRole('main')
        .getByRole('listitem')
        .filter({
          has: page.getByText('Flour', { exact: true }),
        })
      await expect(row).toContainText(money(locale, '5.00'))
      await expect(row).not.toContainText(/\b7(\.0+)?\s*(kg|كيلو)/)
      await expect(row).not.toContainText(w.L('stock', 'المخزون'))
      await expectSound(page, locale)
    }
  }

  // Approval: only with a team. The workshop turns it on and its expense editor offers "Send for
  // approval" to an employee; the baker has no such setting at all.
  await setLanguage(page, 'en')
  await page.setViewportSize(DESKTOP)
  await page.goto(`/b/${workshopId}/settings/approval`)
  await expect(page.getByRole('switch', { name: 'Expenses need approval' })).toBeVisible()
  await page.goto(`/b/${bakerId}/settings/approval`)
  await expect(page.getByRole('switch', { name: 'Expenses need approval' })).toHaveCount(0)
  expect(
    (await callApi(page, 'expense.updateSettings', { approval: true }, { businessId: bakerId }))
      .appCode,
  ).toBe('capability_disabled')
})

const PLANNED_ADDRESSES = [
  'sales',
  'customers',
  'payments',
  'reports',
  'orders',
  'quotations',
  'invoices',
  'inventory',
  'stock',
  'usage-waste',
  'employees',
  'attendance',
  'payroll',
  'equipment',
  'vehicles',
  'projects',
  'petty-cash',
  'vat-center',
]

const RELEASED_MODULES = [
  'dashboard',
  'settings',
  'products',
  'materials',
  'suppliers',
  'purchases',
  'expenses',
  'running_costs',
  'files',
  'cost_engine',
]

test('DoD: only the released modules appear, in English and Arabic', async ({ browser }) => {
  test.setTimeout(300_000)
  const page = await open(browser, DESKTOP, 'en')
  const businessId = await createBusiness(page, 'Moon Café', {
    ...CAFE_ANSWERS,
    vat: 'yes',
    sales_channels: ['walk_in', 'online', 'messages'],
  })
  const base = `/b/${businessId}`
  // Smart Setup turned planned modules on for the café (sales, orders…): none of them shows.
  const planned = (await savedSetup(businessId))!.enabledModules.filter(
    (id) => !RELEASED_MODULES.includes(id),
  )
  expect(planned.length).toBeGreaterThan(0)

  const released = [
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
  ]
  await page.goto(base)
  const nav = page.getByRole('navigation', { name: 'Main' })
  await expect(nav.getByRole('link')).toHaveText(released)
  // Each one opens its page.
  for (const name of released.slice(1)) {
    await nav.getByRole('link', { name, exact: true }).click()
    await expect(nav.getByRole('link', { name, exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    )
    await expect(page.getByRole('heading', { level: 1 }).first()).not.toHaveText('Page not found')
  }
  // A planned module's address is "Page not found".
  for (const address of PLANNED_ADDRESSES) {
    await page.goto(`${base}/${address}`)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Page not found')
  }

  // Customize BizCost: the planned modules that are on are marked "Soon"; a released module switched
  // off leaves the navigation and its address, and comes back when switched on.
  await page.goto(`${base}/settings/modules`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Customize BizCost')
  await expect(page.locator('[data-item]').first()).toBeVisible()
  // Every group open.
  const show = page.getByRole('main').getByRole('button', { name: 'Show', exact: true })
  while ((await show.count()) > 0) await show.first().click()
  for (const id of planned) {
    await expect(page.locator(`[data-item="${id}"]`)).toContainText('Soon')
  }
  const runningCosts = page.locator('[data-item="running_costs"]').getByRole('switch')
  await expect(runningCosts).toBeChecked()
  await runningCosts.click()
  const confirm = page.getByRole('alertdialog')
  if (await confirm.isVisible()) await confirm.getByRole('button', { name: 'Turn off' }).click()
  await expect(runningCosts).not.toBeChecked()
  await page.goto(base)
  await expect(nav.getByRole('link')).toHaveText(
    released.filter((name) => name !== 'Running Costs'),
  )
  // Its address says so (not its page), and the API refuses it (MODULE_DISABLED).
  await page.goto(`${base}/running-costs`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('This section is turned off')
  expect((await callApi(page, 'runningCost.list', {}, { businessId, query: true })).appCode).toBe(
    'module_disabled',
  )
  await page.goto(`${base}/settings/modules`)
  await expect(page.locator('[data-item]').first()).toBeVisible()
  while ((await show.count()) > 0) await show.first().click()
  await runningCosts.click()
  await expect(runningCosts).toBeChecked()
  await page.goto(`${base}/running-costs`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Running Costs')

  // Arabic, on a phone: the tab bar and "More" hold the same sections, and nothing else.
  await setLanguage(page, 'ar')
  await page.setViewportSize(PHONE)
  await page.goto(base)
  const bar = page.getByRole('navigation', { name: 'القائمة الرئيسية' })
  await expect(bar.getByRole('link')).toHaveText(['الرئيسية', 'المنتجات', 'التكاليف'])
  await bar.getByRole('button', { name: 'المزيد' }).click()
  await expect(page.getByRole('menuitem')).toHaveText([
    'المكونات والمستلزمات',
    'الموردون',
    'المشتريات',
    'المستحقات',
    'المصروفات',
    'المصاريف التشغيلية',
    'الإعدادات',
  ])
  await page.keyboard.press('Escape')
  for (const address of PLANNED_ADDRESSES) {
    await page.goto(`${base}/${address}`)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('الصفحة غير موجودة')
  }
  await expectSound(page, 'ar')
  await setLanguage(page, 'en')
})

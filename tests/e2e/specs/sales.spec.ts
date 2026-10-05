import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test'
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
  withValue,
  type TestUser,
} from '../helpers'
import { previewBaseURL } from '../stack'

// Sales (ROADMAP.md M3 Step 2), on the dev-only preview (D-125, D-127: the `preview` project, a
// `next dev` server with BIZCOST_PREVIEW_MODULES=sales). Sales stays `planned` until Release A.
//
//   - A café's Today's sales in Arabic on a phone, typed in Arabic-Indic digits (the plan's definition
//     of done: 40 lattes × 18.00 + 25 croissants × 9.00 = 945.00 before VAT, VAT 47.25, total 992.25):
//     the tab and "+", the products on the first screen (the day, channel and branch folded behind
//     «تغيير»), − / +, the price for the day, the running total, Save, «اعتمد نهائيًا» (what it counts
//     before VAT, and One sale for more sales of the day), leaving with changes, another day and
//     several days (never after today), the books-closed note, and the cost and profit of each line
//     for the owner (a product without its recipe: profit incomplete, never 0). Settings → Sales
//     channels adds Talabat with what it keeps, and only then does the sheet ask for the channel.
//   - The designer's One sale in English on a desktop: a service picked by typing, a new one added
//     from the line, a discount, delivery with what it cost, a draft, Finalize, the sale as recorded
//     (what the delivery cost her), and Reverse and Correct saying what they change.
//   - An employee who enters and finalizes only their own sheet and sees nothing else: no other sheet,
//     no total of the day, another's sale not found, no costs; the owner then sees "2 sheets".
// With E2E_SHOTS_DIR set, each step leaves a screenshot there.

test.describe.configure({ mode: 'serial' })

const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1440, height: 900 }

/** A café with a team, one location, VAT-registered, selling to walk-in customers. */
const CAFE_ANSWERS = {
  what_you_do: ['food_drinks'],
  workplace: 'shop',
  branches: false,
  team: 'team',
  team_tracking: ['hours'],
  work_setup: ['stock'],
  sales_channels: ['walk_in'],
  pos: false,
  vat: 'yes',
}

/** A freelance designer: services only, alone, not VAT-registered, paid by WhatsApp and phone. */
const DESIGNER_ANSWERS = {
  what_you_do: ['services'],
  workplace: 'home',
  team: 'alone',
  work_setup: ['none'],
  sales_channels: ['messages', 'quotes', 'invoice_later'],
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
    // A sheet the page adopts: React never removes it, as it may a <style> in <head>.
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

async function open(
  browser: Browser,
  viewport: { width: number; height: number },
  locale: 'en' | 'ar',
  displayName: string,
): Promise<{ page: Page; user: TestUser }> {
  const user = await createUser(`sales-${locale}`, { locale: 'en' })
  users.push(user)
  return { page: await openAs(browser, user, viewport, locale, displayName), user }
}

async function ok<T>(pending: Promise<{ data?: T; appCode?: string }>, what: string): Promise<T> {
  const result = await pending
  expect(result.appCode, what).toBeUndefined()
  return result.data as T
}

/**
 * Screenshots into E2E_SHOTS_DIR (only when it is set): the screen as it is, and for a long page
 * the screen scrolled to its end too (the shell's bars are fixed, so a full-page image misplaces them).
 */
async function shot(page: Page, name: string) {
  const dir = process.env.E2E_SHOTS_DIR
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(dir, `${name}.png`) })
  const long = await page.evaluate(
    () => document.documentElement.scrollHeight > window.innerHeight + 40,
  )
  const dialog = await page.getByRole('dialog').or(page.getByRole('alertdialog')).count()
  if (long && dialog === 0) {
    const y = await page.evaluate(() => window.scrollY)
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    await page.waitForTimeout(200)
    await page.screenshot({ path: join(dir, `${name}-end.png`) })
    await page.evaluate((top) => window.scrollTo(0, top), y)
  }
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

/** An amount as the page writes it: "AED 6.00" in English; in Arabic, its number and «د.إ.». */
function money(locale: 'en' | 'ar', value: string): RegExp {
  const number = value.replace(/[.]/g, '\\.')
  return locale === 'ar'
    ? new RegExp(`${number}[\\s\\u200e\\u200f]*د\\.إ\\.`)
    : new RegExp(`AED\\s${number}`)
}

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩'

/** `value` written in Arabic-Indic digits (and the Arabic decimal separator). */
function arabic(value: string): string {
  return value.replace(/\d/g, (d) => ARABIC_DIGITS[Number(d)]!).replace('.', '٫')
}

async function todayOf(page: Page, businessId: string): Promise<string> {
  return (
    await ok(
      callApi<{ today: string }>(page, 'books.get', {}, { businessId, query: true }),
      'books.get',
    )
  ).today
}

/** Creates a business through Smart Setup's confirm step in `locale` (its starter names' language). */
async function createBusinessIn(
  page: Page,
  legalName: string,
  answers: Record<string, unknown>,
  locale: 'en' | 'ar',
): Promise<string> {
  const result = await ok(
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
  return result.businessId
}

/** The day before `day` (YYYY-MM-DD). */
function dayBefore(day: string): string {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - 1)
  return date.toISOString().slice(0, 10)
}

async function product(
  page: Page,
  businessId: string,
  fields: { name: string; price: string; type?: 'product' | 'service' },
): Promise<string> {
  const id = randomUUID()
  await ok(
    callApi(
      page,
      'product.create',
      {
        id,
        name: fields.name,
        type: fields.type ?? 'product',
        unit: 'piece',
        defaultPrice: fields.price,
      },
      { businessId },
    ),
    `product.create ${fields.name}`,
  )
  return id
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
  const accepted = await ok(
    callApi<{ businessId: string }>(member, 'invitation.accept', { token }),
    'invitation.accept',
  )
  expect(accepted.businessId).toBe(businessId)
}

/** The label of a choice (a radio drawn as a button): what a person taps. */
function choice(page: Page, name: string): Locator {
  return page.locator('label').filter({ has: page.getByRole('radio', { name, exact: true }) })
}

/** A row of Today's sales, by its product's name. */
function sheetRow(page: Page, name: string): Locator {
  return page.locator('[data-sheet-row]').filter({ hasText: name })
}

test("a café's Today's sales in Arabic on a phone, typed in Arabic-Indic digits", async ({
  browser,
}) => {
  test.setTimeout(900_000)
  const { page } = await open(browser, PHONE, 'ar', 'خالد')
  // Set up in Arabic: its starter channel is named «المحل» (D-226).
  const businessId = await createBusinessIn(page, 'مقهى ركن البن', CAFE_ANSWERS, 'ar')
  const today = await todayOf(page, businessId)
  const yesterday = dayBefore(today)

  // The café's products, and the latte's milk bought today (200 ml at AED 6 a litre: 1.20 a cup).
  const latte = await product(page, businessId, { name: 'لاتيه إسباني', price: '18' })
  await product(page, businessId, { name: 'كرواسون', price: '9' })
  const milk = randomUUID()
  await ok(
    callApi(
      page,
      'material.create',
      { id: milk, name: 'حليب', unit: 'l', packs: [] },
      { businessId },
    ),
    'material.create',
  )
  await ok(
    callApi(
      page,
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
      page,
      'purchase.create',
      {
        id: purchase,
        businessDate: today,
        documentType: 'no_invoice',
        paymentMethod: 'cash',
        lines: [
          {
            kind: 'material',
            id: randomUUID(),
            materialId: milk,
            qty: '10',
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
    callApi(page, 'purchase.post', { id: purchase, version: draft.data.version }, { businessId }),
    'purchase.post',
  )

  // The phone's tab bar has Sales, and "+" offers Today's sales and One sale (the preview).
  await page.goto(`/b/${businessId}`)
  const tabs = page.getByRole('navigation', { name: 'القائمة الرئيسية' })
  await expect(tabs.getByRole('link', { name: 'المبيعات' })).toBeVisible()
  await tabs.getByRole('button', { name: 'إضافة جديد' }).click()
  await expect(page.getByRole('menuitem', { name: 'عملية بيع جديدة' })).toBeVisible()
  await shot(page, 'sales-ar-390-plus')
  await page.getByRole('menuitem', { name: 'مبيعات اليوم' }).click()
  await expect(page).toHaveURL(new RegExp(`/b/${businessId}/sales/today$`))
  await expect(page.getByRole('heading', { level: 1, name: 'مبيعات اليوم' })).toBeVisible()

  // On a phone the products start on the first screen: the day, channel and branch are said in one
  // line, and their choices fold behind «تغيير» (D-236).
  await expect(sheetRow(page, 'لاتيه إسباني')).toBeInViewport()
  const change = page.getByRole('button', { name: 'تغيير', exact: true })
  await expect(change).toHaveAttribute('aria-expanded', 'false')
  await change.click()
  // "These sales are for": today. One channel and one location: neither is asked.
  const forToday = page.getByRole('radio', { name: 'اليوم', exact: true })
  await expect(forToday).toBeChecked()
  await expect(page.getByRole('combobox', { name: 'قناة البيع' })).toHaveCount(0)
  await expect(page.getByRole('combobox', { name: 'الفرع' })).toHaveCount(0)

  // Each product with its price filled in, − / + and how many, typed in Arabic-Indic digits.
  const latteQty = page.getByRole('textbox', { name: withValue('عدد ', 'لاتيه إسباني') })
  const lattePrice = page.getByRole('textbox', { name: withValue('سعر ', 'لاتيه إسباني') })
  const croissantQty = page.getByRole('textbox', { name: withValue('عدد ', 'كرواسون') })
  await expect(lattePrice).toHaveValue('18')
  await expect(page.getByRole('textbox', { name: withValue('سعر ', 'كرواسون') })).toHaveValue('9')
  await latteQty.fill(arabic('40'))
  await lattePrice.fill(arabic('18.00'))
  await croissantQty.fill(arabic('24'))
  await page.getByRole('button', { name: withValue('زد واحدًا من ', 'كرواسون') }).click()
  await page.getByRole('button', { name: withValue('زد واحدًا من ', 'كرواسون') }).click()
  await page.getByRole('button', { name: withValue('أنقص واحدًا من ', 'كرواسون') }).click()
  await expect(croissantQty).toHaveValue('25')
  await expect(sheetRow(page, 'لاتيه إسباني').locator('[data-row-amount]')).toHaveText(
    money('ar', '720.00'),
  )
  // The running total, and the totals before VAT, the VAT and the total (VAT once on 945.00).
  await expect(page.locator('[data-running-total]')).toHaveText(money('ar', '992.25'))
  await expect(page.locator('[data-total="net"]')).toContainText(money('ar', '945.00'))
  await expect(page.locator('[data-total="vat"]')).toContainText(money('ar', '47.25'))
  await expect(page.locator('[data-total="total"]')).toContainText(money('ar', '992.25'))
  await expectSound(page, 'ar')
  await shot(page, 'sales-ar-390-today')

  // Leaving with changes asks first (D-161); keep editing stays.
  const unsaved = page.getByRole('alertdialog', { name: 'لديك تغييرات لم تُحفظ' })
  await tabs.getByRole('link', { name: 'المبيعات' }).click()
  await expect(unsaved).toBeVisible()
  await unsaved.getByRole('button', { name: 'متابعة التعديل' }).click()
  await expect(page).toHaveURL(new RegExp('/sales/today$'))

  // Save keeps it as a draft; opened again, it is as it was saved.
  await page.getByRole('button', { name: 'احفظ', exact: true }).click()
  await expect(page.getByText('تم الحفظ. يمكنك إكمالها لاحقًا.')).toBeVisible()
  await expect(page.locator('header').getByText('مسودة', { exact: true })).toBeVisible()
  await page.reload()
  await expect(latteQty).toHaveValue('40')
  await expect(croissantQty).toHaveValue('25')
  await expect(page.locator('[data-running-total]')).toHaveText(money('ar', '992.25'))

  // «اعتمد نهائيًا»: the confirmation says what it counts, before VAT.
  await page.getByRole('button', { name: 'اعتمد نهائيًا' }).click()
  const finalize = page.getByRole('alertdialog', { name: 'اعتماد مبيعات اليوم نهائيًا؟' })
  await expect(finalize).toContainText(money('ar', '945.00'))
  await expect(finalize).toContainText('قبل الضريبة')
  await shot(page, 'sales-ar-390-finalize')
  await finalize.getByRole('button', { name: 'اعتمد نهائيًا' }).click()
  await expect(page.getByText('هذه المبيعات نهائية')).toBeVisible()
  // What it counts, as the confirmation said: before VAT.
  await expect(page.getByText(/^تم الاعتماد بقيمة/)).toContainText(money('ar', '945.00'))
  await expect(page.getByText(/^تم الاعتماد بقيمة/)).toContainText('قبل الضريبة')
  // More sales of the day go in as one sale; the owner may also correct the sheet.
  await expect(page.locator('[data-final-hint]')).toHaveText(
    'مبيعات أخرى لهذا اليوم؟ أدخلها كعملية بيع. لا تتغير الورقة النهائية إلا بتصحيح.',
  )
  await shot(page, 'sales-ar-390-final')

  // The sale as recorded: what each line cost and earned before running costs (the owner sees costs).
  await page.getByRole('link', { name: 'اعرض المبيعات' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('مبيعات يوم')
  await expect(page.locator('header').getByText('نهائية', { exact: true })).toBeVisible()
  const latteLine = page.locator('[data-sale-line]').filter({ hasText: 'لاتيه إسباني' })
  await expect(latteLine.locator('[data-line-cost]')).toContainText(money('ar', '48.00'))
  await expect(latteLine.locator('[data-line-profit]')).toContainText(money('ar', '672.00'))
  // The croissant has no recipe yet: its cost is not known, so neither is its profit (never 0, D-223).
  const croissantLine = page.locator('[data-sale-line]').filter({ hasText: 'كرواسون' })
  await expect(croissantLine.locator('[data-line-cost]')).toContainText('لا وصفة بعد')
  await expect(croissantLine.locator('[data-no-recipe]')).toHaveText(
    'الربح غير مكتمل بعد: اكتب وصفته.',
  )
  await expect(croissantLine.locator('[data-line-profit]')).toHaveCount(0)
  await expect(page.locator('[data-cost-total]')).toContainText('غير مكتملة بعد')
  await expect(page.locator('[data-profit-total]')).toHaveCount(0)
  await expectSound(page, 'ar')
  await shot(page, 'sales-ar-390-view')

  // The Sales list: the day, what it came to before VAT, one sale.
  await page.goto(`/b/${businessId}/sales`)
  await expect(page.locator('[data-day-total]').first()).toContainText(money('ar', '945.00'))
  await expect(page.locator('[data-day-total]').first()).toContainText('عملية بيع واحدة')
  await expectSound(page, 'ar')
  await shot(page, 'sales-ar-390-list')

  // Another day: never after today; with the books closed up to yesterday, the sheet says so.
  await ok(
    callApi(page, 'books.close', { closedThrough: yesterday }, { businessId }),
    'books.close',
  )
  await page.goto(`/b/${businessId}/sales/today`)
  await page.getByRole('button', { name: 'تغيير', exact: true }).click()
  await choice(page, 'يوم آخر').click()
  await expect(page).toHaveURL(new RegExp(`date=${yesterday}`))
  const day = page.getByLabel('التاريخ', { exact: true })
  await expect(day).toHaveAttribute('max', today)
  await expect(day).toHaveValue(yesterday)
  await expect(
    page.getByText(/الدفاتر مغلقة حتى .*: يمكنك حفظ هذه المبيعات، لكن لا يمكنك اعتمادها\./),
  ).toBeVisible()
  // Nothing was entered for yesterday: an empty sheet of its own.
  await expect(latteQty).toHaveValue('')
  await shot(page, 'sales-ar-390-another-day')

  // Several days within one month: the last day is never after today, the first in its month.
  await choice(page, 'عدة أيام').click()
  await expect(page.getByLabel('إلى', { exact: true })).toHaveAttribute('max', today)
  await expect(page.getByLabel('من', { exact: true })).toHaveAttribute('min', /^\d{4}-\d{2}-01$/)
  await expect(page.getByText('أيام من شهر واحد. تُحفظ كعملية بيع واحدة في آخر يوم.')).toBeVisible()
  await expectSound(page, 'ar')
  await shot(page, 'sales-ar-390-several-days')

  // Settings → Sales channels: Talabat, with what it keeps (the owner sees costs).
  await page.goto(`/b/${businessId}/settings/channels`)
  await expect(page.getByRole('heading', { level: 1, name: 'قنوات البيع' })).toBeVisible()
  await expect(page.locator('[data-channel="المحل"]')).toBeVisible()
  await page.getByRole('button', { name: 'إضافة قناة' }).click()
  const add = page.getByRole('dialog', { name: 'إضافة قناة بيع' })
  await add.getByRole('button', { name: 'طلبات' }).click()
  await expect(add.getByRole('textbox', { name: 'الاسم' })).toHaveValue('طلبات')
  await expect(add.getByRole('combobox', { name: 'نوع القناة' })).toHaveValue('delivery_app')
  await add.getByRole('textbox', { name: 'كم يأخذ التطبيق من كل عملية بيع؟' }).fill(arabic('20'))
  await shot(page, 'sales-ar-390-channel-add')
  await add.getByRole('button', { name: 'إضافة قناة' }).click()
  await expect(add).toBeHidden()
  await expect(page.locator('[data-channel="طلبات"] [data-channel-fee]')).toHaveText('يأخذ 20%')
  await expectSound(page, 'ar')
  await shot(page, 'sales-ar-390-channels')

  // With two channels, Today's sales says which one, and asks behind «تغيير»; the café's Shop first.
  await page.goto(`/b/${businessId}/sales/today`)
  await expect(page.locator('[data-sheet-days]')).toContainText('المحل')
  await page.getByRole('button', { name: 'تغيير', exact: true }).click()
  const channel = page.getByRole('combobox', { name: 'قناة البيع' })
  await expect(channel.locator('option:checked')).toHaveText('المحل')
  await expect(channel.locator('option')).toHaveText(['المحل', 'طلبات'])
})

test("the designer's One sale in English on a desktop", async ({ browser }) => {
  test.setTimeout(900_000)
  const { page } = await open(browser, DESKTOP, 'en', 'Noura')
  const businessId = await createBusiness(page, 'Noura Design Studio', DESIGNER_ANSWERS)
  await product(page, businessId, { name: 'Logo design', price: '1500', type: 'service' })

  await page.goto(`/b/${businessId}/sales`)
  await expect(page.getByRole('heading', { level: 1, name: 'Sales' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'No sales yet' })).toBeVisible()
  await expectSound(page, 'en')
  await shot(page, 'sales-en-1440-empty')
  await page.getByRole('link', { name: 'One sale' }).click()
  await expect(page).toHaveURL(new RegExp('/sales/new$'))
  await expect(page.getByRole('heading', { level: 1, name: 'One sale' })).toBeVisible()
  // One channel and no branches: neither is asked.
  await expect(page.getByRole('combobox', { name: 'Channel' })).toHaveCount(0)
  await expect(page.getByRole('combobox', { name: 'Branch' })).toHaveCount(0)

  // A service picked by typing: its usual price is filled in.
  const lines = page.locator('[data-sale-line]')
  const first = lines.nth(0)
  await first.getByRole('combobox', { name: 'Product or service' }).fill('logo')
  await page.getByRole('option', { name: 'Logo design' }).click()
  await expect(first.getByRole('textbox', { name: 'Price' })).toHaveValue('1500')
  await expect(first.locator('[data-line-total]')).toHaveText(/AED\s1,500\.00/)

  // A new one added from the line: the product form opens with its name, and the line names it.
  await page.getByRole('button', { name: 'Add another' }).click()
  const second = lines.nth(1)
  await second.getByRole('combobox', { name: 'Product or service' }).fill('Brand guide')
  await page.getByRole('option', { name: 'Add “Brand guide” as a new service' }).click()
  const form = page.getByRole('dialog')
  await expect(form.getByRole('textbox', { name: 'Name' })).toHaveValue('Brand guide')
  await form.getByRole('textbox', { name: /Usual price/ }).fill('500')
  await form.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(form).toBeHidden()
  await expect(second.getByRole('combobox', { name: 'Product or service' })).toHaveValue(
    'Brand guide',
  )
  await expect(second.getByRole('textbox', { name: 'Price' })).toHaveValue('500')
  // A discount of 10% on it.
  await second.getByRole('button', { name: 'Add a discount' }).click()
  await second.getByRole('textbox', { name: 'Discount', exact: true }).fill('10')
  await expect(second.locator('[data-line-total]')).toHaveText(/AED\s450\.00/)

  // Delivered: the area, what the customer was charged, and what it actually cost her.
  await choice(page, 'Yes').click()
  await page.getByRole('textbox', { name: 'Area' }).fill('Al Barsha')
  await page.getByRole('textbox', { name: 'Delivery charged to the customer' }).fill('20')
  await page.getByRole('textbox', { name: 'What the delivery cost you' }).fill('25')
  // No VAT anywhere (not VAT-registered).
  await expect(page.locator('main')).not.toContainText('VAT')
  await expect(page.locator('[data-running-total]')).toHaveText('AED 1,970.00')
  await expectSound(page, 'en')
  await shot(page, 'sales-en-1440-new')

  // Save draft: it opens at its own address, as a draft.
  await page.getByRole('button', { name: 'Save draft' }).click()
  await expect(page.getByText('Draft saved.')).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`/b/${businessId}/sales/[0-9a-f-]{36}$`))
  const saleUrl = page.url()
  await expect(page.getByRole('heading', { level: 1, name: 'Draft sale' })).toBeVisible()

  // Leaving with changes asks first.
  await page.getByRole('textbox', { name: 'Notes' }).fill('Logo and brand guide for Al Noor')
  const unsaved = page.getByRole('alertdialog', { name: 'You have unsaved changes' })
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Sales' }).click()
  await expect(unsaved).toBeVisible()
  await unsaved.getByRole('button', { name: 'Keep editing' }).click()

  // Finalize: it counts as AED 1,970.00 of her sales today.
  await page.getByRole('button', { name: 'Finalize' }).click()
  const finalize = page.getByRole('alertdialog', { name: 'Finalize this sale?' })
  await expect(finalize).toContainText('It counts as AED 1,970.00 of your sales on')
  await shot(page, 'sales-en-1440-finalize')
  await finalize.getByRole('button', { name: 'Finalize' }).click()
  await expect(page.getByText(/Sale finalized: AED\s1,970\.00 on /)).toBeVisible()

  // The sale as recorded: its lines, what they cost (services, Materials off: nothing to cost), its
  // delivery.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Sale of /)
  await expect(page.locator('header').getByText('Final', { exact: true })).toBeVisible()
  const logo = page.locator('[data-sale-line]').filter({ hasText: 'Logo design' })
  await expect(logo).toContainText('no materials to cost')
  await expect(logo.locator('[data-line-profit]')).toContainText('AED 1,500.00')
  await expect(page.locator('[data-delivery-cost]')).toHaveText('AED 25.00')
  await expect(page.locator('[data-delivery-margin]')).toHaveText(
    'You paid AED 5.00 of the delivery.',
  )
  await expect(page.getByText('Logo and brand guide for Al Noor')).toBeVisible()
  await expectSound(page, 'en')
  await shot(page, 'sales-en-1440-view')

  // Reverse says what changes (and is not taken here).
  await page.getByRole('button', { name: 'Reverse' }).click()
  const reverse = page.getByRole('alertdialog', { name: 'Reverse this sale?' })
  await expect(reverse).toContainText(
    'It will be as if it was never finalized: it no longer counts in your sales of',
  )
  await expect(reverse).toContainText('It stays in your list, marked reversed.')
  await shot(page, 'sales-en-1440-reverse')
  await reverse.getByRole('button', { name: 'Cancel' }).click()

  // Correct: reversed, and a copy opens as a new draft with its lines and delivery.
  await page.getByRole('button', { name: 'Correct' }).click()
  const correct = page.getByRole('alertdialog', { name: 'Correct this sale?' })
  await expect(correct).toContainText('It is reversed and a copy opens as a new draft.')
  await expect(correct).toContainText("Until the copy is finalized, these sales don't count.")
  await correct.getByRole('button', { name: 'Reverse and copy' }).click()
  await expect(page.getByText('Sale reversed. Here is the copy to fix.')).toBeVisible()
  await expect(page.getByRole('heading', { level: 1, name: 'Draft sale' })).toBeVisible()
  await expect(page.getByText('This draft corrects a sale that was reversed.')).toBeVisible()
  await expect(page.locator('[data-sale-line]')).toHaveCount(2)
  await expect(page.getByRole('textbox', { name: 'What the delivery cost you' })).toHaveValue('25')
  await shot(page, 'sales-en-1440-copy')

  // The list: the reversed sale and its copy; the day counts nothing finalized now.
  await page.goto(`/b/${businessId}/sales`)
  await expect(page.locator('[data-sale-row]')).toHaveCount(2)
  await expect(page.locator('[data-sale-row]').filter({ hasText: 'Reversed' })).toHaveCount(1)
  await expect(page.locator('[data-sale-row]').filter({ hasText: 'Draft' })).toHaveCount(1)
  await expectSound(page, 'en')
  await shot(page, 'sales-en-1440-list')
  // The original stays as it was recorded, marked reversed.
  await page.goto(saleUrl)
  await expect(
    page.getByText(/^Reversed on .*: it no longer counts in your sales\.$/),
  ).toBeVisible()
})

test('an employee enters and finalizes only their own sheet, and sees nothing else', async ({
  browser,
}) => {
  test.setTimeout(900_000)
  const { page: owner } = await open(browser, DESKTOP, 'en', 'Khalid')
  const businessId = await createBusiness(owner, 'Corner Cafe', { ...CAFE_ANSWERS, vat: 'no' })
  const latte = await product(owner, businessId, { name: 'Spanish Latte', price: '18' })
  await product(owner, businessId, { name: 'Croissant', price: '9' })
  const today = await todayOf(owner, businessId)

  // The owner's own sheet for today, finalized (10 lattes).
  const ownSheet = randomUUID()
  const created = await ok(
    callApi<{ data: { version: number } }>(
      owner,
      'sale.create',
      {
        id: ownSheet,
        source: 'day_sheet',
        businessDate: today,
        lines: [{ kind: 'item', id: randomUUID(), productId: latte, qty: '10', unitPrice: '18' }],
      },
      { businessId },
    ),
    'sale.create',
  )
  await ok(
    callApi(owner, 'sale.post', { id: ownSheet, version: created.data.version }, { businessId }),
    'sale.post',
  )

  // A barista joins as an Employee: they enter and finalize their own sales only (Q10).
  const barista = await createUser('sales-employee', { locale: 'en' })
  users.push(barista)
  const page = await openAs(browser, barista, PHONE, 'en', 'Laila')
  await joinBusiness(owner, businessId, page, barista, 'employee')

  // Their Sales: nothing of the owner's, and no total of the day (they see only their own).
  await page.goto(`/b/${businessId}/sales`)
  await expect(page.getByRole('heading', { name: 'No sales yet' })).toBeVisible()
  await expect(page.locator('[data-sale-row]')).toHaveCount(0)
  await expectSound(page, 'en')
  await shot(page, 'sales-en-390-employee-empty')

  // Their own sheet for today starts empty: the owner's lattes are not on it, and no "2 sheets".
  await page.getByRole('link', { name: "Today's sales" }).first().click()
  await expect(page.getByRole('heading', { level: 1, name: "Today's sales" })).toBeVisible()
  const qty = page.getByRole('textbox', { name: withValue('How many ', 'Spanish Latte') })
  await expect(qty).toHaveValue('')
  await expect(page.locator('[data-sheets-note]')).toHaveCount(0)
  await page.getByRole('button', { name: withValue('One more ', 'Spanish Latte') }).click()
  await page.getByRole('button', { name: withValue('One more ', 'Spanish Latte') }).click()
  await page.getByRole('button', { name: withValue('One more ', 'Spanish Latte') }).click()
  await expect(qty).toHaveValue('3')
  await expect(page.locator('[data-running-total]')).toHaveText('AED 54.00')
  await expectSound(page, 'en')
  await shot(page, 'sales-en-390-employee-sheet')
  await page.getByRole('button', { name: 'Finalize' }).click()
  await page
    .getByRole('alertdialog', { name: "Finalize today's sales?" })
    .getByRole('button', { name: 'Finalize' })
    .click()
  await expect(page.getByText('These sales are final')).toBeVisible()
  // Not a dead end: more sales of the day go in as one sale (they can't correct a final sheet).
  await expect(page.locator('[data-final-hint]')).toHaveText(
    'More sales of this day? Enter them as one sale.',
  )
  await expect(page.getByRole('link', { name: 'One sale' })).toBeVisible()

  // The list shows only their sheet, still without a day total.
  await page.goto(`/b/${businessId}/sales`)
  await expect(page.locator('[data-sale-row]')).toHaveCount(1)
  await expect(page.locator('[data-day-total]')).toHaveCount(0)
  await shot(page, 'sales-en-390-employee-list')

  // Their sale as recorded: costs are hidden from them.
  await page.locator('[data-sale-row]').click()
  await expect(
    page.getByText("Costs and profit are hidden: your role doesn't show costs."),
  ).toBeVisible()
  await expect(page.locator('[data-locked="cost"]').first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Reverse' })).toHaveCount(0)
  await shot(page, 'sales-en-390-employee-view')

  // The owner's sheet is not theirs to see.
  await page.goto(`/b/${businessId}/sales/${ownSheet}`)
  await expect(page.getByRole('heading', { name: 'Sale not found' })).toBeVisible()

  // Nor are the sales channels.
  await page.goto(`/b/${businessId}/settings/channels`)
  await expect(page.getByRole('heading', { level: 1, name: 'Sales channels' })).toHaveCount(0)

  // The owner sees both sheets of the day ("2 sheets for Shop … (Khalid, Laila)") and their total.
  await owner.goto(`/b/${businessId}/sales/today`)
  await expect(owner.locator('[data-sheets-note]')).toHaveText(
    /^2 sheets for ⁨?Shop⁩? on .+ \(⁨?Khalid⁩?(, | and )⁨?Laila⁩?\)$/,
  )
  await shot(owner, 'sales-en-1440-two-sheets')
  await owner.goto(`/b/${businessId}/sales`)
  await expect(owner.locator('[data-sale-row]')).toHaveCount(2)
  await expect(owner.locator('[data-day-total]').first()).toContainText('AED 234.00')
  await expect(owner.locator('[data-day-total]').first()).toContainText('2 sales')
  await shot(owner, 'sales-en-1440-owner-list')
})

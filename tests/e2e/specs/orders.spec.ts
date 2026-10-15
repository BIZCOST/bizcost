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
  BAKER_ANSWERS,
  callApi,
  createUser,
  deleteUser,
  pngImage,
  RAW_KEY,
  setLanguage,
  signIn,
  useLanguage,
  WORKSHOP_ANSWERS,
  type TestUser,
} from '../helpers'
import { previewBaseURL } from '../stack'

// Orders, Customers and What customers owe (ROADMAP.md M3 Step 5), on the dev-only preview (D-125,
// D-127: the `preview` project, a `next dev` server with BIZCOST_PREVIEW_MODULES=…,customers,
// payments,orders). The modules stay `planned` until Release A (M3 Step 6).
//
//   - The home baker in Arabic on a phone (the plan's definition of done): order #1001 from "+", a
//     customer added on the spot after "Did you mean …?" shows another Fatima, a chocolate cake at 150
//     with delivery charged 20 (it cost 25) and a deposit of 50 by bank transfer typed in Arabic-Indic
//     digits; "Deposit paid" and 120 still owed; Deliver ("This counts as a sale on …: 170.00"); the
//     rest paid by card; a refund of 20 by amount for a damaged cake with the 20 given back; nothing
//     owed after it; the order's profit; the Dashboard's Recent orders.
//   - The workshop in English on a desktop: a business customer with its TRN and trade licence, two
//     orders with the customer's LPO (a discount on the whole order, VAT, a deposit by cheque, the LPO
//     attached), deliver ("AED 7,200.00 before VAT"), Profit by order in Reports, "Pay several at
//     once" over both orders oldest first, undo the delivery, cancel the other order and give its
//     money back, and the customer's page; an undone delivery's sale sends its cost to the order.
//   - The designer's One sale "they'll pay later" in English on a phone: the customer added on the
//     spot, paid in part, a price cut that lowers what they owe; What customers owe and the customer.
//   - The same screens in Arabic on a desktop (a workshop with VAT): the list, a pending order with a
//     payment (its customer kept), Deliver before VAT, a refund by quantity with VAT, What customers
//     owe, the customer, the Dashboard's cards and Profit by order.
// With E2E_SHOTS_DIR set, each step leaves a screenshot there.

test.describe.configure({ mode: 'serial' })

const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1440, height: 900 }

const users: TestUser[] = []
const contexts: BrowserContext[] = []

test.afterAll(async () => {
  for (const context of contexts) await context.close()
  for (const user of users) await deleteUser(user.id)
})

async function open(
  browser: Browser,
  viewport: { width: number; height: number },
  locale: 'en' | 'ar',
  displayName: string,
): Promise<Page> {
  const user = await createUser(`orders-${locale}`, { locale: 'en' })
  users.push(user)
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

/** An order's number as a sentence holds it: isolated, so it reads "#1001" in Arabic too. */
const n = (number: string) => `\u2068${number}\u2069`

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

/** Creates a business through Smart Setup's confirm step in `locale`. */
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

/** The day after `day` (YYYY-MM-DD). */
function dayAfter(day: string): string {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + 1)
  return date.toISOString().slice(0, 10)
}

async function product(
  page: Page,
  businessId: string,
  fields: { name: string; price: string },
): Promise<string> {
  const id = randomUUID()
  await ok(
    callApi(
      page,
      'product.create',
      { id, name: fields.name, type: 'product', unit: 'piece', defaultPrice: fields.price },
      { businessId },
    ),
    `product.create ${fields.name}`,
  )
  return id
}

/** The label of a choice (a radio drawn as a button): what a person taps. */
function choice(scope: Page | Locator, name: string): Locator {
  // The radio is found from the page: an inner locator is matched inside each label.
  const page = 'page' in scope ? scope.page() : scope
  return scope.locator('label').filter({ has: page.getByRole('radio', { name, exact: true }) })
}

test("the home baker's order #1001 in Arabic on a phone: a deposit, delivered, paid, refunded", async ({
  browser,
}) => {
  test.setTimeout(900_000)
  const page = await open(browser, PHONE, 'ar', 'مريم')
  const businessId = await createBusinessIn(page, 'كيك مريم', BAKER_ANSWERS, 'ar')
  const today = await todayOf(page, businessId)
  await product(page, businessId, { name: 'كيكة شوكولاتة', price: '150' })
  // Another Fatima is a customer already: names repeat (Q2), the phone tells them apart.
  await ok(
    callApi(
      page,
      'customer.create',
      { id: randomUUID(), name: 'فاطمة', phone: '055 765 4321' },
      { businessId },
    ),
    'customer.create',
  )

  // "+" offers a new order (the preview).
  await page.goto(`/b/${businessId}`)
  const tabs = page.getByRole('navigation', { name: 'القائمة الرئيسية' })
  await tabs.getByRole('button', { name: 'إضافة جديد' }).click()
  await page.getByRole('menuitem', { name: 'طلب جديد' }).click()
  await expect(page).toHaveURL(new RegExp(`/b/${businessId}/orders/new$`))
  await expect(page.getByRole('heading', { level: 1, name: 'طلب جديد' })).toBeVisible()
  await expectSound(page, 'ar')
  await shot(page, 'orders-ar-390-new')

  // The customer: a new Fatima, added on the spot after "Did you mean …?" shows the other one.
  const customer = page.getByRole('combobox', { name: 'العميل' })
  await customer.fill('فاطمة')
  await expect(
    page.getByRole('option', { name: /فاطمة · …4321|فاطمة · 055 765 4321/ }),
  ).toBeVisible()
  await page.getByRole('option', { name: 'أضف «فاطمة» كعميل جديد' }).click()
  const sheet = page.getByRole('dialog', { name: 'عميل جديد' })
  await expect(sheet.getByRole('textbox', { name: 'الاسم' })).toHaveValue('فاطمة')
  const didYouMean = sheet.locator('[data-did-you-mean]')
  await expect(didYouMean).toContainText('هل تقصد…؟')
  await expect(didYouMean).toContainText('055 765 4321')
  await expect(didYouMean.getByRole('button', { name: 'اختر هذا العميل' })).toBeVisible()
  await sheet.getByRole('textbox', { name: 'الهاتف' }).fill('050 123 4567')
  await shot(page, 'orders-ar-390-did-you-mean')
  await sheet.getByRole('button', { name: 'أضف', exact: true }).click()
  await expect(sheet).toBeHidden()
  await expect(customer).toHaveValue('فاطمة · 050 123 4567')

  // The cake, when it's due, delivery to Al Barsha: charged 20, it costs her 25.
  await page.getByRole('combobox', { name: 'المنتج أو الخدمة' }).fill('كيك')
  await page.getByRole('option', { name: 'كيكة شوكولاتة' }).click()
  await expect(page.getByRole('textbox', { name: 'السعر' })).toHaveValue('150')
  await page.getByLabel('موعد التسليم').fill(dayAfter(today))
  await choice(page, 'نعم').click()
  await page.getByRole('textbox', { name: 'المنطقة' }).fill('البرشاء')
  await page.getByRole('textbox', { name: 'رسوم التوصيل على العميل' }).fill(arabic('20'))
  await page.getByRole('textbox', { name: 'ما كلّفك التوصيل' }).fill(arabic('25'))
  await expect(page.locator('[data-running-total]')).toHaveText(money('ar', '170.00'))
  // No VAT anywhere (not VAT-registered).
  await expect(page.locator('main')).not.toContainText('الضريبة')

  // Paid now: a deposit of 50 by bank transfer; how it was paid is never picked for her.
  await choice(page, 'عربون').click()
  await page.getByRole('textbox', { name: 'العربون' }).fill(arabic('50'))
  const method = page.getByRole('combobox', { name: 'طريقة الدفع' })
  await expect(method).toHaveValue('')
  await page.getByRole('button', { name: 'احفظ الطلب' }).click()
  await expect(page.getByText('اختر طريقة دفع العميل.')).toBeVisible()
  await method.selectOption({ label: 'تحويل بنكي' })
  await page.getByRole('textbox', { name: 'ملاحظات' }).fill('عيد ميلاد سعيد يا سارة')
  await expectSound(page, 'ar')
  await shot(page, 'orders-ar-390-filled')
  await page.getByRole('button', { name: 'احفظ الطلب' }).click()

  // Order #1001: pending, its deposit paid, 120 still owed.
  await expect(page.getByText(`تم حفظ الطلب ${n('#1001')}.`)).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`/b/${businessId}/orders/[0-9a-f-]{36}$`))
  const orderUrl = page.url()
  await expect(page.getByRole('heading', { level: 1, name: `الطلب ${n('#1001')}` })).toBeVisible()
  await expect(page.locator('[data-order-status="pending"]')).toBeVisible()
  await expect(page.locator('header [data-payment-state="deposit"]')).toHaveText('دُفع العربون')
  await expect(page.locator('[data-owed="paid"]')).toContainText(money('ar', '50.00'))
  await expect(page.locator('[data-owed="owed"]')).toContainText(money('ar', '120.00'))
  await expect(page.locator('[data-delivery-cost]')).toHaveText(money('ar', '25.00'))
  await expectSound(page, 'ar')
  await shot(page, 'orders-ar-390-pending')

  // The list: #1001 waiting, with Fatima and what she still owes.
  await page.goto(`/b/${businessId}/orders`)
  const row = page.locator('[data-order-row="pending"]')
  await expect(row).toHaveCount(1)
  await expect(row).toContainText('#1001')
  await expect(row).toContainText('فاطمة')
  await expect(row).toContainText(money('ar', '120.00'))
  await expect(page.getByRole('heading', { name: 'بانتظار التسليم' })).toBeVisible()
  await expectSound(page, 'ar')
  await shot(page, 'orders-ar-390-list')

  // What customers owe: Fatima, 120 on #1001.
  await page.goto(`/b/${businessId}/receivables`)
  await expect(page.locator('[data-receivables-total]')).toContainText(money('ar', '120.00'))
  await expect(page.locator('[data-receivable-group]')).toContainText('فاطمة')
  await expect(page.locator('[data-owed-document="order"]')).toContainText(`الطلب ${n('#1001')}`)
  await expectSound(page, 'ar')
  await shot(page, 'orders-ar-390-receivables')

  // Deliver: "This counts as a sale on …: 170.00".
  await page.goto(orderUrl)
  await page.getByRole('button', { name: 'سلّم الطلب' }).click()
  const deliver = page.getByRole('alertdialog', { name: `تسليم الطلب ${n('#1001')}؟` })
  await expect(deliver).toContainText('يُحسب هذا الطلب بيعًا بقيمة')
  await expect(deliver).toContainText(money('ar', '170.00'))
  await shot(page, 'orders-ar-390-deliver')
  await deliver.getByRole('button', { name: 'سلّم الطلب' }).click()
  await expect(page.getByText(`تم تسليم الطلب ${n('#1001')}. أصبح يُحسب في مبيعاتك.`)).toBeVisible()
  await expect(page.locator('[data-order-status="delivered"]')).toBeVisible()
  await expect(page.getByText(/سُلّم في .*: أُضيف .*170\.00.* إلى مبيعاتك\./)).toBeVisible()
  // What it earned (the owner sees costs): no recipe for the cake yet, so not complete.
  await expect(page.getByRole('heading', { name: 'ما ربحه هذا الطلب' })).toBeVisible()

  // The rest, 120, paid by card: Paid.
  await page.getByRole('button', { name: 'سجّل دفعة' }).click()
  const pay = page.getByRole('dialog', { name: 'سجّل دفعة' })
  await expect(pay.getByRole('textbox', { name: 'المبلغ' })).toHaveValue('120.00')
  await pay.getByRole('combobox', { name: 'طريقة الدفع' }).selectOption({ label: 'بطاقة' })
  await shot(page, 'orders-ar-390-pay')
  await pay.getByRole('button', { name: 'سجّل الدفعة' }).click()
  await expect(pay).toBeHidden()
  await expect(page.locator('header [data-payment-state="paid"]')).toHaveText('مدفوع')
  await expect(page.locator('[data-paid-in-full]')).toBeVisible()
  await expectSound(page, 'ar')
  await shot(page, 'orders-ar-390-delivered')

  // A refund of 20 by amount for a damaged cake, the 20 given back in cash.
  await page.getByRole('button', { name: 'استرجاع' }).click()
  const refund = page.getByRole('dialog', { name: 'استرجاع' })
  // "Items came back": the delivery is taken back whole, so what is left of it is an amount (D-274).
  await expect(refund.locator('[data-refund-line="delivery"]')).toContainText(money('ar', '20.00'))
  await choice(refund, 'تخفيض في السعر').click()
  await refund.getByRole('textbox', { name: 'كم يُخصم من كيكة شوكولاتة' }).fill(arabic('20'))
  await expect(refund.locator('[data-refund-total]')).toContainText(money('ar', '20.00'))
  const back = refund.locator('[data-give-back]')
  await expect(back.getByRole('switch', { name: 'أعد المبلغ الآن' })).toBeChecked()
  await expect(back.getByRole('textbox', { name: 'المبلغ' })).toHaveValue('20.00')
  await back.getByRole('combobox', { name: 'كيف أعدته' }).selectOption({ label: 'نقدًا' })
  await refund.getByRole('textbox', { name: 'السبب' }).fill('كيك تالف')
  await expectSound(page, 'ar')
  await shot(page, 'orders-ar-390-refund')
  await refund.getByRole('button', { name: 'سجّل المرتجع' }).click()
  await expect(refund).toBeHidden()
  await expect(page.locator('[data-refund]')).toHaveCount(1)
  await expect(page.locator('[data-refund]')).toContainText(money('ar', '20.00'))
  await expect(page.locator('[data-owed="credited"]')).toContainText(money('ar', '20.00'))
  await expect(page.locator('[data-owed="refunded"]')).toContainText(money('ar', '20.00'))
  await expect(page.locator('[data-owed="owed"]')).toContainText(money('ar', '0.00'))
  // Undo delivery waits for the refund to be reversed first.
  await page.getByRole('button', { name: 'تراجع عن التسليم' }).click()
  const undo = page.getByRole('alertdialog', { name: `التراجع عن تسليم الطلب ${n('#1001')}؟` })
  await expect(undo).toContainText('على هذا الطلب مرتجعات.')
  // Said once, as a note: no error repeats it (D-274).
  await expect(undo.getByRole('alert')).toHaveCount(0)
  await expect(undo.getByRole('button', { name: 'تراجع عن التسليم' })).toBeDisabled()
  await undo.getByRole('button', { name: 'إلغاء' }).click()
  await expectSound(page, 'ar')
  await shot(page, 'orders-ar-390-refunded')

  // Nothing owed any more; the Dashboard's Recent orders shows #1001, delivered and paid.
  await page.goto(`/b/${businessId}/receivables`)
  await expect(page.getByRole('heading', { name: 'لا مستحقات على أحد' })).toBeVisible()
  await page.goto(`/b/${businessId}`)
  const recent = page.locator('[data-card="recent-orders"]')
  await expect(recent.locator('[data-recent-order]')).toHaveCount(1)
  await expect(recent).toContainText('#1001')
  await expect(recent).toContainText('كيكة شوكولاتة')
  await expect(recent.locator('[data-order-status="delivered"]')).toBeVisible()
  await expectSound(page, 'ar')
  await shot(page, 'orders-ar-390-dashboard')
})

test('the workshop in English on a desktop: LPOs, deliver, pay several at once, undo, cancel', async ({
  browser,
}) => {
  test.setTimeout(900_000)
  const page = await open(browser, DESKTOP, 'en', 'Rashed')
  const businessId = await createBusinessIn(page, 'Rashed Joinery', WORKSHOP_ANSWERS, 'en')
  const today = await todayOf(page, businessId)
  await product(page, businessId, { name: 'Wardrobe', price: '4000' })
  const cabinet = await product(page, businessId, { name: 'Kitchen cabinet', price: '2500' })

  // Customers: a business with its TRN and trade licence (for invoices later).
  await page.goto(`/b/${businessId}/customers`)
  await expect(page.getByRole('heading', { level: 1, name: 'Customers' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'No customers yet' })).toBeVisible()
  await page.getByRole('button', { name: 'Add customer' }).click()
  const add = page.getByRole('dialog', { name: 'New customer' })
  await add.getByRole('textbox', { name: 'Name' }).fill('Al Noor Developments')
  await choice(add, 'Business').click()
  await add.getByRole('textbox', { name: 'Phone' }).fill('04 123 4567')
  await add.getByRole('textbox', { name: 'TRN' }).fill('100123456700003')
  await add.getByRole('textbox', { name: 'Trade licence number' }).fill('CN-1234567')
  await expectSound(page, 'en')
  await shot(page, 'orders-en-1440-customer-new')
  await add.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(add).toBeHidden()
  const customerRow = page.locator('[data-customer-row]')
  await expect(customerRow).toHaveCount(1)
  await expect(customerRow).toContainText('Business · 04 123 4567')
  await shot(page, 'orders-en-1440-customers')

  // A new order with the customer's LPO: two wardrobes, 10% off the whole order, a deposit by cheque.
  await page.goto(`/b/${businessId}/orders`)
  await expect(page.getByRole('heading', { level: 1, name: 'Orders' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'No orders yet' })).toBeVisible()
  await page.getByRole('link', { name: 'New order' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'New order' })).toBeVisible()
  await page.getByRole('combobox', { name: 'Customer' }).fill('al noor')
  await page.getByRole('option', { name: 'Al Noor Developments · 04 123 4567' }).click()
  await page.getByRole('textbox', { name: "Customer's LPO or reference" }).fill('LPO-7781')
  await page.getByRole('combobox', { name: 'Product or service' }).fill('ward')
  await page.getByRole('option', { name: 'Wardrobe' }).click()
  await page.getByRole('textbox', { name: 'Quantity' }).fill('2')
  await page.getByRole('button', { name: 'Add a discount on the whole order' }).click()
  await page.getByRole('textbox', { name: 'Discount on the whole order' }).fill('10')
  await expect(page.locator('[data-total="net"]')).toContainText('AED 7,200.00')
  await expect(page.locator('[data-total="vat"]')).toContainText('AED 360.00')
  await expect(page.locator('[data-running-total]')).toHaveText('AED 7,560.00')
  await choice(page, 'A deposit').click()
  await page.getByRole('textbox', { name: 'Deposit' }).fill('2000')
  await page.getByRole('combobox', { name: 'How they paid' }).selectOption({ label: 'Cheque' })
  await expectSound(page, 'en')
  await shot(page, 'orders-en-1440-new')
  await page.getByRole('button', { name: 'Save order' }).click()
  await expect(page.getByText(`Order ${n('#1001')} saved.`)).toBeVisible()
  await expect(page.getByRole('heading', { level: 1, name: `Order ${n('#1001')}` })).toBeVisible()
  const firstUrl = page.url()
  const first = firstUrl.split('/').at(-1)!
  await expect(page.locator('header [data-payment-state="deposit"]')).toHaveText('Deposit paid')
  await expect(page.locator('[data-owed="owed"]')).toContainText('AED 5,560.00')

  // The customer's LPO, attached to the order.
  await page.locator('[data-receipt-input]').setInputFiles({
    name: 'lpo-7781.png',
    mimeType: 'image/png',
    buffer: pngImage(64),
  })
  await expect(page.getByText('File attached.')).toBeVisible()
  await expect(page.getByRole('list', { name: 'Files' })).toContainText('lpo-7781.png')
  await expectSound(page, 'en')
  await shot(page, 'orders-en-1440-pending')

  // A second order of theirs, a kitchen cabinet, nothing paid yet.
  const customers = await ok(
    callApi<{ items: { id: string }[] }>(page, 'customer.list', {}, { businessId, query: true }),
    'customer.list',
  )
  await ok(
    callApi(
      page,
      'order.create',
      {
        id: randomUUID(),
        customerId: customers.items[0]!.id,
        customerRef: 'LPO-7790',
        businessDate: today,
        lines: [
          { kind: 'item', id: randomUUID(), productId: cabinet, qty: '1', unitPrice: '2500' },
        ],
      },
      { businessId },
    ),
    'order.create',
  )

  // Deliver #1001: it counts as a sale before VAT, and shows what it earned.
  await page.getByRole('button', { name: 'Deliver' }).click()
  const deliver = page.getByRole('alertdialog', { name: `Deliver order ${n('#1001')}?` })
  await expect(deliver).toContainText('This counts as a sale on')
  await expect(deliver).toContainText('AED 7,200.00 before VAT')
  await shot(page, 'orders-en-1440-deliver')
  await deliver.getByRole('button', { name: 'Deliver' }).click()
  await expect(
    page.getByText(`Order ${n('#1001')} delivered. It now counts in your sales.`),
  ).toBeVisible()
  await expect(page.getByRole('heading', { name: 'What this order earned' })).toBeVisible()
  await expect(page.locator('[data-order-profit]')).toBeVisible()
  await expectSound(page, 'en')
  await shot(page, 'orders-en-1440-delivered')

  // Reports → Real profit by order: #1001 and its customer.
  await page.goto(`/b/${businessId}/reports/profit?by=order`)
  await expect(page.locator('[data-group-by="order"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator(`[data-profit-group="${first}"]`)).toContainText(
    `${n('#1001')} · Al Noor Developments`,
  )
  await expectSound(page, 'en')
  await shot(page, 'orders-en-1440-report')

  // What customers owe: 5,560 on #1001 and 2,625 on #1002; one payment of 6,000 over both, the
  // oldest first.
  await page.goto(`/b/${businessId}/receivables`)
  await expect(page.locator('[data-receivables-total]')).toContainText('AED 8,185.00')
  await page.getByRole('button', { name: 'Record a payment' }).click()
  const many = page.getByRole('dialog', { name: 'Record a payment' })
  const documents = many.locator('[data-pay-many-document]')
  await expect(documents).toHaveCount(2)
  await expect(many.getByRole('textbox', { name: 'Amount' })).toHaveValue('8185.00')
  await many.getByRole('textbox', { name: 'Amount' }).fill('6000')
  await expect(documents.nth(0)).toContainText('Pays all of it: AED 5,560.00')
  await expect(documents.nth(1)).toContainText('Pays AED 440.00 of AED 2,625.00')
  await many
    .getByRole('combobox', { name: 'How they paid' })
    .selectOption({ label: 'Bank transfer' })
  await expectSound(page, 'en')
  await shot(page, 'orders-en-1440-pay-many')
  await many.getByRole('button', { name: 'Record payment' }).click()
  await expect(page.getByText('Payment recorded on 2 orders and sales.')).toBeVisible()
  await expect(page.locator('[data-receivables-total]')).toContainText('AED 2,185.00')
  await shot(page, 'orders-en-1440-receivables')

  // Undo the delivery of #1001: it waits again, its payments stay on it.
  await page.goto(firstUrl)
  await page.getByRole('button', { name: 'Undo delivery' }).click()
  const undo = page.getByRole('alertdialog', { name: `Undo the delivery of order ${n('#1001')}?` })
  await expect(undo).toContainText('Its payments stay on it.')
  await undo.getByRole('button', { name: 'Undo delivery' }).click()
  await expect(
    page.getByText(`Delivery undone. Order ${n('#1001')} is waiting again.`),
  ).toBeVisible()
  await expect(page.locator('[data-order-status="pending"]')).toBeVisible()
  await expect(page.locator('header [data-payment-state="paid"]')).toHaveText('Paid')

  // Cancel #1002: the 440 paid on it is money back to the customer until it is given back.
  await page.goto(`/b/${businessId}/orders?status=pending`)
  await page.locator('[data-order-row]').filter({ hasText: '#1002' }).click()
  await page.getByRole('button', { name: 'Cancel order' }).click()
  const cancel = page.getByRole('alertdialog', { name: `Cancel order ${n('#1002')}?` })
  await expect(cancel).toContainText('The customer paid AED 440.00 on it')
  await cancel.getByRole('textbox').fill('They changed the design')
  await cancel.getByRole('button', { name: 'Cancel order' }).click()
  await expect(page.getByText(`Order ${n('#1002')} cancelled.`)).toBeVisible()
  await expect(page.locator('[data-order-status="cancelled"]')).toBeVisible()
  await expect(page.locator('[data-owed="overpaid"]')).toContainText('AED 440.00')
  await shot(page, 'orders-en-1440-cancelled')
  await page.getByRole('button', { name: 'Give money back' }).click()
  const giveBack = page.getByRole('dialog', { name: 'Give money back' })
  await expect(giveBack.getByRole('textbox', { name: 'Amount' })).toHaveValue('440.00')
  await giveBack
    .getByRole('combobox', { name: 'How you gave it back' })
    .selectOption({ label: 'Bank transfer' })
  await giveBack.getByRole('button', { name: 'Record money given back' }).click()
  await expect(giveBack).toBeHidden()
  await expect(page.locator('[data-owed="overpaid"]')).toHaveCount(0)
  await expect(page.locator('[data-payment]').filter({ hasText: 'Given back' })).toHaveCount(1)
  // Given back: never "Paid in full", and no longer "money back to the customer" (D-274).
  await expect(page.locator('[data-paid-in-full]')).toHaveCount(0)
  await expect(page.locator('[data-deposit-given-back]')).toHaveText(
    'The deposit was given back. Nothing is owed.',
  )
  await expect(page.getByText(/^A deposit on a cancelled order is money back/)).toHaveCount(0)

  // The customer's page: their details, nothing owed, their two orders and four payments.
  await page.goto(`/b/${businessId}/customers`)
  await page.locator('[data-customer-row]').click()
  await expect(page.getByRole('heading', { level: 1, name: 'Al Noor Developments' })).toBeVisible()
  await expect(page.getByText('100123456700003')).toBeVisible()
  await expect(page.getByText('CN-1234567')).toBeVisible()
  await expect(page.locator('[data-owes-nothing]')).toBeVisible()
  await expect(page.locator('[data-order-row]')).toHaveCount(2)
  await expect(page.locator('[data-payment]')).toHaveCount(4)
  await expectSound(page, 'en')
  await shot(page, 'orders-en-1440-customer')

  // An order delivered with a delivery whose cost isn't known yet: its sale offers to enter it. Once
  // the delivery is undone, that sale counts nowhere and sends it to the order instead (D-273).
  const courier = await ok(
    callApi<{ data: { id: string; version: number } }>(
      page,
      'order.create',
      {
        id: randomUUID(),
        businessDate: today,
        deliveryNeeded: true,
        deliveryArea: 'Al Quoz',
        lines: [
          { kind: 'item', id: randomUUID(), productId: cabinet, qty: '1', unitPrice: '2500' },
          { kind: 'delivery', id: randomUUID(), amount: '150' },
        ],
      },
      { businessId },
    ),
    'order.create',
  )
  const shipped = await ok(
    callApi<{ data: { saleId: string } }>(
      page,
      'order.deliver',
      { id: courier.data.id, version: courier.data.version },
      { businessId },
    ),
    'order.deliver',
  )
  const fillCost = page.getByRole('button', { name: 'Enter what the delivery cost' })
  await page.goto(`/b/${businessId}/sales/${shipped.data.saleId}`)
  await expect(fillCost).toBeVisible()
  await ok(
    callApi(page, 'order.undoDelivery', { id: courier.data.id }, { businessId }),
    'order.undoDelivery',
  )
  await page.reload()
  await expect(page.locator('[data-delivery-cost-on-order]')).toHaveText(
    "The order's delivery was undone: enter what the delivery cost on the order.",
  )
  await expect(fillCost).toHaveCount(0)
  await expectSound(page, 'en')
  await shot(page, 'orders-en-1440-undone-sale')
})

/** A freelance designer: services only, alone, not VAT-registered, invoices later (Customers on). */
const DESIGNER_ANSWERS = {
  what_you_do: ['services'],
  workplace: 'home',
  team: 'alone',
  work_setup: ['none'],
  sales_channels: ['messages', 'quotes', 'invoice_later'],
  vat: 'no',
}

test('the designer\'s One sale "they\'ll pay later" in English on a phone: paid in part, refunded', async ({
  browser,
}) => {
  test.setTimeout(900_000)
  const page = await open(browser, PHONE, 'en', 'Noura')
  const businessId = await createBusinessIn(page, 'Noura Design Studio', DESIGNER_ANSWERS, 'en')
  await ok(
    callApi(
      page,
      'product.create',
      {
        id: randomUUID(),
        name: 'Logo design',
        type: 'service',
        unit: 'piece',
        defaultPrice: '1500',
      },
      { businessId },
    ),
    'product.create',
  )

  // One sale for a customer added on the spot, who'll pay later.
  await page.goto(`/b/${businessId}/sales/new`)
  await expect(page.getByRole('heading', { level: 1, name: 'One sale' })).toBeVisible()
  const later = page.getByRole('switch', { name: "They'll pay later" })
  await expect(later).toBeDisabled()
  await page.getByRole('combobox', { name: 'Customer' }).fill('Al Noor Cafe')
  await page.getByRole('option', { name: 'Add “Al Noor Cafe” as a new customer' }).click()
  const sheet = page.getByRole('dialog', { name: 'New customer' })
  await sheet.getByRole('textbox', { name: 'Phone' }).fill('050 999 1234')
  await sheet.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(sheet).toBeHidden()
  await later.click()
  await expect(later).toBeChecked()
  await page.getByRole('combobox', { name: 'Product or service' }).fill('logo')
  await page.getByRole('option', { name: 'Logo design' }).click()
  await expectSound(page, 'en')
  await shot(page, 'orders-en-390-sale-later')
  await page.getByRole('button', { name: 'Finalize' }).click()
  await page
    .getByRole('alertdialog', { name: 'Finalize this sale?' })
    .getByRole('button', { name: 'Finalize' })
    .click()
  await expect(page.getByText(/Sale finalized: AED\s1,500\.00 on /)).toBeVisible()

  // The sale as recorded: its customer, and what they still owe.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Sale of /)
  await expect(page.getByText('Yes: owed by the customer')).toBeVisible()
  await expect(page.locator('[data-owed="owed"]')).toContainText('AED 1,500.00')
  await page.getByRole('button', { name: 'Record a payment' }).click()
  const pay = page.getByRole('dialog', { name: 'Record a payment' })
  await pay.getByRole('textbox', { name: 'Amount' }).fill('500')
  await pay.getByRole('combobox', { name: 'How they paid' }).selectOption({ label: 'Cash' })
  await pay.getByRole('button', { name: 'Record payment' }).click()
  await expect(pay).toBeHidden()
  await expect(page.locator('[data-owed="owed"]')).toContainText('AED 1,000.00')
  await expectSound(page, 'en')
  await shot(page, 'orders-en-390-sale-view')

  // A price cut of 100: it lowers what they owe (nothing to give back).
  await page.getByRole('button', { name: 'Refund' }).click()
  const refund = page.getByRole('dialog', { name: 'Refund' })
  await choice(refund, 'A price cut').click()
  await refund.getByRole('textbox', { name: 'How much off Logo design' }).fill('100')
  await expect(refund.locator('[data-owed-after]')).toHaveText('The customer then owes AED 900.00.')
  await expect(refund.locator('[data-give-back]')).toHaveCount(0)
  await expectSound(page, 'en')
  await shot(page, 'orders-en-390-refund')
  await refund.getByRole('button', { name: 'Record refund' }).click()
  await expect(refund).toBeHidden()
  await expect(page.locator('[data-owed="owed"]')).toContainText('AED 900.00')
  await expect(page.locator('[data-refund]')).toHaveCount(1)

  // What customers owe, their page, and the customers list, on a phone.
  await page.goto(`/b/${businessId}/receivables`)
  await expect(page.locator('[data-receivable-group]')).toContainText('Al Noor Cafe')
  await expect(page.locator('[data-owed-document="sale"]')).toContainText('AED 900.00')
  await expectSound(page, 'en')
  await shot(page, 'orders-en-390-receivables')
  await page.goto(`/b/${businessId}/customers`)
  await expect(page.locator('[data-customer-row]')).toContainText('050 999 1234')
  await expectSound(page, 'en')
  await shot(page, 'orders-en-390-customers')
  await page.locator('[data-customer-row]').click()
  await expect(page.locator('[data-customer-owes]')).toContainText('AED 900.00')
  await expect(page.locator('[data-customer-sale]')).toHaveCount(2)
  await expectSound(page, 'en')
  await shot(page, 'orders-en-390-customer')
})

test('the orders screens in Arabic on a desktop (a workshop with VAT)', async ({ browser }) => {
  test.setTimeout(900_000)
  const page = await open(browser, DESKTOP, 'ar', 'راشد')
  const businessId = await createBusinessIn(page, 'نجارة راشد', WORKSHOP_ANSWERS, 'ar')
  const today = await todayOf(page, businessId)
  const wardrobe = await product(page, businessId, { name: 'خزانة ملابس', price: '4000' })
  const customer = randomUUID()
  await ok(
    callApi(
      page,
      'customer.create',
      { id: customer, name: 'شركة النور للتطوير', kind: 'business', phone: '04 123 4567' },
      { businessId },
    ),
    'customer.create',
  )
  const order = randomUUID()
  await ok(
    callApi(
      page,
      'order.create',
      {
        id: order,
        customerId: customer,
        customerRef: 'LPO-7781',
        businessDate: today,
        dueDate: dayAfter(today),
        discount: { percent: '10' },
        lines: [
          { kind: 'item', id: randomUUID(), productId: wardrobe, qty: '2', unitPrice: '4000' },
        ],
        payment: { id: randomUUID(), method: 'cheque', amount: '2000' },
      },
      { businessId },
    ),
    'order.create',
  )

  await page.goto(`/b/${businessId}/orders`)
  await expect(page.getByRole('heading', { level: 1, name: 'الطلبات' })).toBeVisible()
  await expect(page.locator('[data-order-row="pending"]')).toContainText('LPO-7781')
  await expectSound(page, 'ar')
  await shot(page, 'orders-ar-1440-list')

  await page.goto(`/b/${businessId}/orders/${order}/edit`)
  await expect(
    page.getByRole('heading', { level: 1, name: `تعديل الطلب ${n('#1001')}` }),
  ).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'أمر الشراء أو مرجع العميل' })).toHaveValue(
    'LPO-7781',
  )
  // It has a payment: it keeps its customer.
  await expect(page.getByRole('combobox', { name: 'العميل' })).toBeDisabled()
  await expectSound(page, 'ar')
  await shot(page, 'orders-ar-1440-edit')

  await page.goto(`/b/${businessId}/orders/${order}`)
  await expect(page.getByRole('heading', { level: 1, name: `الطلب ${n('#1001')}` })).toBeVisible()
  await page.getByRole('button', { name: 'سلّم الطلب' }).click()
  const deliver = page.getByRole('alertdialog', { name: `تسليم الطلب ${n('#1001')}؟` })
  await expect(deliver).toContainText(money('ar', '7,200.00'))
  await expect(deliver).toContainText('قبل الضريبة')
  await shot(page, 'orders-ar-1440-deliver')
  await deliver.getByRole('button', { name: 'سلّم الطلب' }).click()
  await expect(page.locator('[data-order-status="delivered"]')).toBeVisible()
  await expectSound(page, 'ar')
  await shot(page, 'orders-ar-1440-view')
  await page.getByRole('button', { name: 'استرجاع' }).click()
  const refund = page.getByRole('dialog', { name: 'استرجاع' })
  await refund.getByRole('textbox', { name: 'كم أُعيد من خزانة ملابس' }).fill('1')
  // One of two back: 3,600 + 5% VAT.
  await expect(refund.locator('[data-refund-total]')).toContainText(money('ar', '3,780.00'))
  await expectSound(page, 'ar')
  await shot(page, 'orders-ar-1440-refund')
  await refund.getByRole('button', { name: 'إلغاء' }).click()

  await page.goto(`/b/${businessId}/receivables`)
  await expect(page.locator('[data-receivables-total]')).toContainText(money('ar', '5,560.00'))
  await expectSound(page, 'ar')
  await shot(page, 'orders-ar-1440-receivables')
  await page.goto(`/b/${businessId}/customers/${customer}`)
  await expect(page.getByRole('heading', { level: 1, name: 'شركة النور للتطوير' })).toBeVisible()
  await expectSound(page, 'ar')
  await shot(page, 'orders-ar-1440-customer')
  await page.goto(`/b/${businessId}/customers`)
  await expectSound(page, 'ar')
  await shot(page, 'orders-ar-1440-customers')
  await page.goto(`/b/${businessId}`)
  await expect(page.locator('[data-card="recent-orders"]')).toContainText('#1001')
  await expect(page.locator('[data-card="customers-owe"]')).toContainText(money('ar', '5,560.00'))
  await expectSound(page, 'ar')
  await shot(page, 'orders-ar-1440-dashboard')
  await page.goto(`/b/${businessId}/reports/profit?by=order`)
  await expect(page.locator(`[data-profit-group="${order}"]`)).toContainText('#1001')
  await expectSound(page, 'ar')
  await shot(page, 'orders-ar-1440-report')
})

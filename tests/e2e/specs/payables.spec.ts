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
  setLanguage,
  signIn,
  useLanguage,
  withValue,
  type TestUser,
} from '../helpers'
import { previewBaseURL } from '../stack'

// The owner's requests of 2026-09-29 on the purchasing screens, on the development server with the
// dev-only preview (D-125, D-127):
//   - VAT clarity: a tax invoice typed before VAT and a purchase without an invoice typed with VAT
//     (105 with 5% VAT = 100 + 5), each posted with the right average; the prices' captions and the
//     totals say it (English, desktop);
//   - how it was paid is required, in the screen and in the API; on credit needs the supplier;
//   - amounts owed: a purchase on credit and one an employee paid from their own money show under the
//     supplier and the person, with who entered them; a part payment, then the rest; a purchase with
//     payments can't be reversed until they are (English, desktop and phone; Arabic, phone and
//     desktop);
//   - a material added from its purchase line: «حليب» added, «حليب» again refused with a way to the
//     one that exists, «حليب طازج» warned "Did you mean …?" and added anyway (Arabic, phone).
// With E2E_SHOTS_DIR set, each step leaves a screenshot there (AR/EN at 390 and 1440 px).

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

const RAW_KEY =
  /\b(?:common|catalog|units|errors|nav|modules|purchasing|settings)\.[a-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+/

const users: TestUser[] = []
const contexts: BrowserContext[] = []
let cafe: { page: Page; businessId: string; purchaseId: string } | undefined

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
  const user = await createUser(`payables-${locale}`, { locale: 'en' })
  users.push(user)
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
  await signIn(page, user)
  expect((await callApi(page, 'account.updateProfile', { displayName })).appCode).toBeUndefined()
  if (locale === 'ar') await setLanguage(page, 'ar')
  return page
}

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
  const dialog = await page.getByRole('dialog').or(page.getByRole('alertdialog')).count()
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

async function createMaterial(page: Page, businessId: string, name: string, unit: string) {
  const result = await callApi(
    page,
    'material.create',
    { id: randomUUID(), name, unit, packs: [], crossFactors: [] },
    { businessId },
  )
  expect(result.appCode).toBeUndefined()
}

/** Picks a line's material: typed in its box, then picked from the list. */
async function pickMaterial(line: Locator, label: string, name: string) {
  await line.getByRole('combobox', { name: label }).fill(name)
  await line.getByRole('option', { name, exact: true }).click()
}

async function finalize(page: Page) {
  await page.getByRole('button', { name: 'Finalize' }).click()
  await page
    .getByRole('alertdialog', { name: 'Finalize this purchase?' })
    .getByRole('button', { name: 'Finalize' })
    .click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Purchase of /)
}

test('English, desktop: prices before and with VAT, how it was paid, amounts owed and payments', async ({
  browser,
}) => {
  test.setTimeout(900_000)
  const page = await open(browser, DESKTOP, 'en', 'Salma')
  const businessId = await createBusiness(page, 'Palm Café', CAFE_ANSWERS)
  await createMaterial(page, businessId, 'Milk', 'l')
  const supplier = await callApi(
    page,
    'supplier.create',
    { id: randomUUID(), name: 'Al Ain Dairy' },
    { businessId },
  )
  expect(supplier.appCode).toBeUndefined()
  const total = (key: string) => page.locator(`[data-total="${key}"]`)
  const vatMode = page.getByRole('group', { name: 'VAT in the prices' })
  const paid = page.getByRole('combobox', { name: 'How it was paid' })

  // 1. A tax invoice, typed before VAT (the default for a tax invoice): 10 L at AED 6.
  await page.goto(`/b/${businessId}/purchases/new`)
  await expect(vatMode.getByRole('radio', { name: 'Prices before VAT' })).toBeChecked()
  await page.getByRole('combobox', { name: 'Supplier' }).selectOption({ label: 'Al Ain Dairy' })
  const first = page.getByRole('group', { name: 'Item 1' })
  await pickMaterial(first, 'Ingredient or supply', 'Milk')
  await first.getByRole('textbox', { name: 'Quantity' }).fill('10')
  await first.getByRole('textbox', { name: 'Price per L before VAT' }).fill('6')
  await expect(total('net')).toContainText('AED 60.00')
  await expect(total('vat')).toContainText('AED 3.00')
  await expect(total('total')).toContainText('AED 63.00')
  // How it was paid is required: nothing is picked, and saving says so on the field.
  await expect(paid).toHaveValue('')
  await page.getByRole('button', { name: 'Save draft' }).click()
  await expect(page.getByText('Choose how it was paid.')).toBeVisible()
  await expect(paid).toHaveAttribute('aria-invalid', 'true')
  await expect(page).toHaveURL(`/b/${businessId}/purchases/new`)
  await expectSound(page, 'en')
  await shot(page, 'en-1440-payment-required')
  // The API refuses it too.
  const books = await callApi<{ today: string }>(page, 'books.get', {}, { businessId, query: true })
  const today = books.data!.today
  const refused = await callApi(
    page,
    'purchase.create',
    { id: randomUUID(), businessDate: today, documentType: 'no_invoice', lines: [] },
    { businessId },
  )
  expect(refused.appCode).toBe('validation')
  await paid.selectOption({ label: 'Cash' })
  await expect(page.getByText('Choose how it was paid.')).toHaveCount(0)
  await shot(page, 'en-1440-before-vat')
  await finalize(page)
  await expect(page.getByRole('main').getByText('Before VAT', { exact: true })).toBeVisible()
  await expect(page.locator('[data-purchase-line]')).toContainText('Cost of the goods: AED 60.00')

  // 2. No invoice: the prices include VAT until the person chooses. A choice made stays.
  await page.goto(`/b/${businessId}/purchases/new`)
  await vatMode.getByText('Prices including VAT').click()
  await page.getByRole('combobox', { name: 'Invoice type' }).selectOption('non_tax_invoice')
  await page.getByRole('combobox', { name: 'Invoice type' }).selectOption('tax_invoice')
  await expect(vatMode.getByRole('radio', { name: 'Prices including VAT' })).toBeChecked()
  await page.goto(`/b/${businessId}/purchases/new`)
  await page.getByRole('combobox', { name: 'Invoice type' }).selectOption('no_invoice')
  await expect(vatMode.getByRole('radio', { name: 'Prices including VAT' })).toBeChecked()
  await page.getByRole('combobox', { name: 'Supplier' }).selectOption({ label: 'Al Ain Dairy' })
  const second = page.getByRole('group', { name: 'Item 1' })
  await pickMaterial(second, 'Ingredient or supply', 'Milk')
  await second.getByRole('textbox', { name: 'Quantity' }).fill('1')
  await second.getByRole('textbox', { name: 'Price per L incl. VAT' }).fill('105')
  await second.getByRole('combobox', { name: 'VAT' }).selectOption('5')
  // 105 with 5% VAT is 100 before VAT and 5 VAT.
  await expect(total('net')).toContainText('AED 100.00')
  await expect(total('vat')).toContainText('AED 5.00')
  await expect(total('total')).toContainText('AED 105.00')
  await expect(page.getByText('Your prices include VAT')).toBeVisible()
  // Bought on credit: owed to the supplier (it needs one).
  await page.getByRole('combobox', { name: 'Supplier' }).selectOption('')
  await paid.selectOption({ label: 'On credit: we pay the supplier later' })
  await expect(
    page.getByText('On credit needs the supplier. Pick the supplier first.'),
  ).toBeVisible()
  await page.getByRole('combobox', { name: 'Supplier' }).selectOption({ label: 'Al Ain Dairy' })
  await expect(page.getByText('It shows in Amounts owed until you pay the supplier.')).toBeVisible()
  await expectSound(page, 'en')
  await shot(page, 'en-1440-including-vat')
  await finalize(page)
  const creditUrl = page.url()
  const creditId = creditUrl.split('/').at(-1)!
  await expect(page.getByRole('main').getByText('Including VAT', { exact: true })).toBeVisible()
  await expect(page.locator('[data-purchase-line]')).toContainText('per L incl. VAT')
  // Without an invoice the VAT is part of the cost: the goods cost 105.
  await expect(page.locator('[data-purchase-line]')).toContainText('Cost of the goods: AED 105.00')
  // (60 + 105) ÷ 11 L = AED 15.00 a litre.
  await page.goto(`/b/${businessId}/materials`)
  await expect(
    page.getByRole('list', { name: 'Ingredients & supplies' }).getByRole('listitem'),
  ).toContainText('Average cost: AED 15.00 per L')

  // 3. Paid by an employee from their own money: the one entering it, until someone else is picked.
  await page.goto(`/b/${businessId}/purchases/new`)
  const third = page.getByRole('group', { name: 'Item 1' })
  await pickMaterial(third, 'Ingredient or supply', 'Milk')
  await third.getByRole('textbox', { name: 'Quantity' }).fill('5')
  await third.getByRole('textbox', { name: 'Price per L before VAT' }).fill('8')
  await paid.selectOption({ label: 'Paid by an employee from their own money' })
  const payer = page.getByRole('combobox', { name: 'Who paid' })
  await expect(payer.locator('option:checked')).toHaveText('Salma (you)')
  await finalize(page)
  await expect(page.getByRole('main').getByText('Salma', { exact: true })).toBeVisible()

  // Amounts owed: the supplier, and the person who paid.
  const nav = page.getByRole('navigation', { name: 'Main' })
  await nav.getByRole('link', { name: 'Amounts owed' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Amounts owed')
  await expect(page.getByRole('tab', { name: 'To suppliers' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  const group = page.locator('[data-payable-group]').filter({ hasText: 'Al Ain Dairy' })
  await expect(group.locator('[data-invoice]')).toHaveCount(1)
  await expect(group.locator('[data-amount="total"]')).toContainText('AED 105.00')
  await expect(group.locator('[data-amount="outstanding"]')).toContainText('AED 105.00')
  await expect(group).toContainText(withValue('Entered by ', 'Salma'))
  await expect(page.locator('[data-payables-total]')).toContainText('AED 105.00')
  await expectSound(page, 'en')
  await shot(page, 'en-1440-payables-suppliers')

  // A part payment: AED 40 by bank transfer. How it was paid is required here too.
  await group.getByRole('button', { name: 'Record a payment' }).click()
  const sheet = page.getByRole('dialog', { name: 'Record a payment' })
  await expect(sheet.getByRole('textbox', { name: 'Amount' })).toHaveValue('105.00')
  await sheet.getByRole('textbox', { name: 'Amount' }).fill('120')
  await expect(sheet.getByText("That's more than is still owed on this purchase.")).toBeVisible()
  await sheet.getByRole('textbox', { name: 'Amount' }).fill('40')
  await sheet.getByRole('button', { name: 'Record payment' }).click()
  await expect(sheet.getByText('Choose how you paid.')).toBeVisible()
  await sheet
    .getByRole('combobox', { name: 'How you paid' })
    .selectOption({ label: 'Bank transfer' })
  await sheet.getByRole('textbox', { name: 'Note' }).fill('TT-1')
  await shot(page, 'en-1440-payment-sheet')
  await sheet.getByRole('button', { name: 'Record payment' }).click()
  await expect(page.getByText('Payment recorded.')).toBeVisible()
  await expect(sheet).toHaveCount(0)
  await expect(group.locator('[data-amount="paid"]')).toContainText('AED 40.00')
  await expect(group.locator('[data-amount="outstanding"]')).toContainText('AED 65.00')

  // To employees: Salma, who paid 42.00 (40 + 5% VAT).
  await page.getByRole('tab', { name: 'To employees' }).click()
  await expect(page).toHaveURL(/\?to=employees$/)
  const salma = page.locator('[data-payable-group]').filter({ hasText: 'Salma' })
  await expect(salma.locator('[data-amount="outstanding"]')).toContainText('AED 42.00')
  await expectSound(page, 'en')
  await shot(page, 'en-1440-payables-employees')

  // The purchase: its payments; it can't be reversed while they stand.
  await page.goto(creditUrl)
  const owed = (key: string) => page.locator(`[data-owed="${key}"]`)
  await expect(owed('paid')).toContainText('AED 40.00')
  await expect(owed('outstanding')).toContainText('AED 65.00')
  const payments = page.getByRole('list', { name: 'Payments' })
  await expect(payments.getByRole('listitem')).toHaveCount(1)
  await expect(payments).toContainText('Bank transfer')
  await expect(payments).toContainText('TT-1')
  await expect(payments).toContainText(withValue('Recorded by ', 'Salma'))
  // The purchase's own Reverse (its header) is not offered; each payment has its own.
  const actions = page.getByRole('main').locator('header')
  await expect(actions.getByRole('button', { name: 'Reverse', exact: true })).toHaveCount(0)
  await expect(actions.getByRole('button', { name: 'Correct', exact: true })).toHaveCount(0)
  await expect(
    page.getByText('To reverse this purchase, reverse its payments first.'),
  ).toBeVisible()
  expect((await callApi(page, 'purchase.reverse', { id: creditId }, { businessId })).appCode).toBe(
    'purchase_has_payments',
  )
  await expectSound(page, 'en')
  await shot(page, 'en-1440-purchase-payments')

  // The rest: all that is still owed, in cash. Nothing is owed to the supplier any more.
  await page.getByRole('button', { name: 'Record a payment' }).click()
  await expect(sheet.getByRole('textbox', { name: 'Amount' })).toHaveValue('65.00')
  await sheet.getByRole('combobox', { name: 'How you paid' }).selectOption({ label: 'Cash' })
  await sheet.getByRole('button', { name: 'Record payment' }).click()
  await expect(page.locator('[data-paid-in-full]')).toHaveText('Paid in full.')
  await expect(owed('outstanding')).toContainText('AED 0.00')
  await expect(payments.getByRole('listitem')).toHaveCount(2)
  await page.goto(`/b/${businessId}/payables`)
  await expect(
    page.getByRole('heading', { level: 2, name: 'Nothing owed to suppliers' }),
  ).toBeVisible()
  cafe = { page, businessId, purchaseId: creditId }

  // A payment recorded by mistake is reversed: it stays listed, and is owed again.
  await page.goto(creditUrl)
  await payments
    .getByRole('listitem')
    .filter({ hasText: 'Cash' })
    .getByRole('button', { name: 'Reverse' })
    .click()
  const reverse = page.getByRole('alertdialog', { name: 'Reverse this payment?' })
  await expect(reverse).toContainText('AED 65.00 is owed again.')
  await reverse.getByRole('button', { name: 'Reverse' }).click()
  await expect(page.getByText('Payment reversed.')).toBeVisible()
  await expect(owed('outstanding')).toContainText('AED 65.00')
  await expect(payments.getByRole('listitem').filter({ hasText: 'Cash' })).toContainText('Reversed')

  // The same screens on a phone.
  await page.setViewportSize(PHONE)
  await expectSound(page, 'en')
  await shot(page, 'en-390-purchase-payments')
  await page.goto(`/b/${businessId}/payables`)
  await expect(group.locator('[data-amount="outstanding"]')).toContainText('AED 65.00')
  await expectSound(page, 'en')
  await shot(page, 'en-390-payables-suppliers')
  await group.getByRole('button', { name: 'Record a payment' }).click()
  await expect(sheet).toBeVisible()
  await shot(page, 'en-390-payment-sheet')
  await sheet.getByRole('button', { name: 'Cancel' }).click()
  await expect(sheet).toHaveCount(0)
  await page.goto(`/b/${businessId}/purchases/new`)
  await pickMaterial(page.getByRole('group', { name: 'Item 1' }), 'Ingredient or supply', 'Milk')
  await paid.selectOption({ label: 'Paid by an employee from their own money' })
  await expectSound(page, 'en')
  await shot(page, 'en-390-purchase-editor')
})

test('Arabic, phone and desktop: amounts owed and a payment', async () => {
  test.setTimeout(600_000)
  if (!cafe) throw new Error('the first test makes the business')
  const { page, businessId, purchaseId } = cafe
  await setLanguage(page, 'ar')
  await page.setViewportSize(PHONE)
  await page.goto(`/b/${businessId}/payables`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('المستحقات')
  const group = page.locator('[data-payable-group]').filter({ hasText: 'Al Ain Dairy' })
  await expect(group.locator('[data-amount="outstanding"]')).toContainText('65.00')
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-payables-suppliers')
  await page.getByRole('tab', { name: 'للموظفين' }).click()
  await expect(page.locator('[data-payable-group]').filter({ hasText: 'Salma' })).toBeVisible()
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-payables-employees')
  await page.getByRole('tab', { name: 'للموردين' }).click()
  await group.getByRole('button', { name: 'سجّل دفعة' }).click()
  const sheet = page.getByRole('dialog', { name: 'تسجيل دفعة' })
  await sheet.getByRole('combobox', { name: 'طريقة الدفع' }).selectOption({ label: 'شيك' })
  await sheet.getByRole('textbox', { name: 'المبلغ' }).fill('٢٥')
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-payment-sheet')
  await sheet.getByRole('button', { name: 'سجّل الدفعة' }).click()
  await expect(page.getByText('سُجّلت الدفعة.')).toBeVisible()
  await expect(group.locator('[data-amount="outstanding"]')).toContainText('40.00')

  await page.goto(`/b/${businessId}/purchases/${purchaseId}`)
  await expect(page.getByRole('list', { name: 'الدفعات' }).getByRole('listitem')).toHaveCount(3)
  await expect(page.getByText('لإبطال هذه المشتريات، أبطِل دفعاتها أولًا.')).toBeVisible()
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-purchase-payments')

  await page.setViewportSize(DESKTOP)
  await expectSound(page, 'ar')
  await shot(page, 'ar-1440-purchase-payments')
  await page.goto(`/b/${businessId}/payables`)
  await expect(group.locator('[data-amount="outstanding"]')).toContainText('40.00')
  await expectSound(page, 'ar')
  await shot(page, 'ar-1440-payables-suppliers')
  await group.getByRole('button', { name: 'سجّل دفعة' }).click()
  await expect(sheet).toBeVisible()
  await shot(page, 'ar-1440-payment-sheet')
  await sheet.getByRole('button', { name: 'إلغاء' }).click()
  await page.goto(`/b/${businessId}/purchases/new`)
  await page.getByRole('combobox', { name: 'نوع الفاتورة' }).selectOption('no_invoice')
  await expect(page.getByRole('radio', { name: 'الأسعار شاملة الضريبة' })).toBeChecked()
  await page
    .getByRole('group', { name: 'الصنف 1' })
    .getByRole('combobox', { name: 'المكوّن أو المستلزم' })
    .fill('Milk')
  await page.getByRole('option', { name: 'Milk', exact: true }).click()
  await expect(
    page.getByRole('group', { name: 'الصنف 1' }).getByRole('textbox', {
      name: 'السعر لكل لتر شامل الضريبة',
    }),
  ).toBeVisible()
  await page
    .getByRole('group', { name: 'الصنف 1' })
    .getByRole('textbox', { name: 'الكمية' })
    .fill('2')
  await page
    .getByRole('group', { name: 'الصنف 1' })
    .getByRole('textbox', { name: 'السعر لكل لتر شامل الضريبة' })
    .fill('10.5')
  // On a phone: the VAT choice, and how it was paid, required (saving without it says so there).
  await page.setViewportSize(PHONE)
  await page.getByRole('group', { name: 'الضريبة في الأسعار' }).scrollIntoViewIfNeeded()
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-purchase-vat')
  await page.getByRole('button', { name: 'احفظ كمسودة' }).click()
  await expect(page.getByText('اختر طريقة الدفع.')).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'طريقة الدفع' })).toHaveAttribute(
    'aria-invalid',
    'true',
  )
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-payment-required')
  await page.setViewportSize(DESKTOP)
  await page.getByRole('combobox', { name: 'طريقة الدفع' }).selectOption({
    label: 'دفعه موظف من ماله الخاص',
  })
  await expect(page.getByRole('combobox', { name: 'من دفع' })).toBeVisible()
  await expectSound(page, 'ar')
  await shot(page, 'ar-1440-purchase-editor')
  await page.setViewportSize(PHONE)
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-purchase-editor')
})

test('Arabic, phone: a material added from its line, the same name refused, a similar one warned', async ({
  browser,
}) => {
  test.setTimeout(600_000)
  const page = await open(browser, PHONE, 'ar', 'راشد')
  const businessId = await createBusiness(page, 'Karak Corner', CAFE_ANSWERS)
  await createMaterial(page, businessId, 'بن', 'kg')
  await page.goto(`/b/${businessId}/purchases/new`)
  const line = page.getByRole('group', { name: 'الصنف 1' })
  const picker = line.getByRole('combobox', { name: 'المكوّن أو المستلزم' })

  // «حليب» is not in the list: it is added from the line, measured by volume, in cartons of 12 L.
  await picker.fill('حليب')
  const add = line.getByRole('option', { name: /^أضف «.?حليب.?» كمكوّن أو مستلزم جديد$/ })
  await expect(add).toBeVisible()
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-picker-add')
  await add.click()
  const sheet = page.getByRole('dialog', { name: 'مكوّن أو مستلزم جديد' })
  await expect(sheet.getByRole('textbox', { name: 'الاسم' })).toHaveValue('حليب')
  await sheet.getByRole('button', { name: 'أضف', exact: true }).click()
  await expect(sheet.getByText('اختر كيف تقيسه.')).toBeVisible()
  await sheet.getByText('الحجم', { exact: true }).click()
  await expect(sheet.getByRole('combobox', { name: 'الوحدة التي تستخدمه بها' })).toHaveValue('l')
  await sheet.getByRole('button', { name: 'أضف عبوة' }).click()
  await sheet.getByRole('textbox', { name: 'اسم العبوة' }).fill('كرتون')
  await sheet.getByRole('textbox', { name: 'الكمية' }).fill('١٢')
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-quick-add')
  await sheet.getByRole('button', { name: 'أضف', exact: true }).click()
  await expect(page.getByText(withValue('تمت إضافة ', 'حليب', '.'))).toBeVisible()
  await expect(sheet).toHaveCount(0)
  // Picked on the line, in its carton.
  await expect(picker).toHaveValue('حليب')
  await expect(line.getByRole('combobox', { name: 'الوحدة' })).toHaveValue(/^pack:/)

  // «حليب» again: the list offers the one that exists, never a second one.
  await page.getByRole('button', { name: 'أضف مكوّنًا أو مستلزمًا' }).click()
  const second = page.getByRole('group', { name: 'الصنف 2' })
  const secondPicker = second.getByRole('combobox', { name: 'المكوّن أو المستلزم' })
  await secondPicker.fill('حَليب')
  await expect(second.getByRole('option', { name: 'حليب', exact: true })).toBeVisible()
  await expect(second.locator('[data-add-option]')).toHaveCount(0)
  // The API refuses the same name written another way (marks and tatweel).
  const same = await callApi(
    page,
    'material.quickCreate',
    { id: randomUUID(), name: 'حـليب', unit: 'l', packs: [], crossFactors: [] },
    { businessId },
  )
  expect(same.appCode).toBe('name_taken')

  // «حليب طازج»: "Did you mean «حليب»?". Changing the name to «حليب» is refused, with the way to it.
  await secondPicker.fill('حليب طازج')
  await second.locator('[data-add-option]').click()
  // One name looks alike: the question names it, and its button says it uses it.
  await expect(sheet.locator('[data-similar]')).toContainText(withValue('هل تقصد «', 'حليب', '»؟'))
  await expect(
    sheet.locator('[data-similar]').getByRole('button', { name: /^استخدم «.?حليب.?»$/ }),
  ).toBeVisible()
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-quick-add-similar')
  await sheet.getByRole('textbox', { name: 'الاسم' }).fill('حليب')
  await expect(sheet.getByText(withValue('«', 'حليب', '» موجود في قائمتك.'))).toBeVisible()
  await shot(page, 'ar-390-quick-add-exists')
  await sheet.getByRole('button', { name: /^استخدم «.?حليب.?»$/ }).click()
  await expect(sheet).toHaveCount(0)
  await expect(secondPicker).toHaveValue('حليب')

  // Added anyway: the warning asks first, "No, add it as new" adds it.
  await page.getByRole('button', { name: 'أضف مكوّنًا أو مستلزمًا' }).click()
  const third = page.getByRole('group', { name: 'الصنف 3' })
  await third.getByRole('combobox', { name: 'المكوّن أو المستلزم' }).fill('حليب طازج')
  await third.locator('[data-add-option]').click()
  await sheet.getByText('الحجم', { exact: true }).click()
  await sheet.getByRole('button', { name: 'أضف', exact: true }).click()
  await expect(sheet.getByText('اختر واحدًا منها، أو اضغط «لا، أضفه كجديد».')).toBeVisible()
  await expect(sheet).toBeVisible()
  await sheet.getByRole('button', { name: 'لا، أضفه كجديد' }).click()
  await expect(sheet.locator('[data-similar]')).toHaveCount(0)
  await sheet.getByRole('button', { name: 'أضف', exact: true }).click()
  await expect(sheet).toHaveCount(0)
  await expect(third.getByRole('combobox', { name: 'المكوّن أو المستلزم' })).toHaveValue(
    'حليب طازج',
  )
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-quick-add-lines')

  // Any member who enters purchases adds materials this way; the Materials list has them.
  await page.setViewportSize(DESKTOP)
  await page.goto(`/b/${businessId}/materials`)
  const list = page.getByRole('list', { name: 'المكونات والمستلزمات' })
  await expect(list.getByRole('listitem')).toHaveCount(3)
  await expect(list).toContainText('حليب طازج')
  await expect(list).toContainText(/1\sكرتون\s=\s12\sلتر/)
  await page.goto(`/b/${businessId}/purchases/new`)
  await page
    .getByRole('group', { name: 'الصنف 1' })
    .getByRole('combobox', { name: 'المكوّن أو المستلزم' })
    .fill('حليب')
  await expect(
    page.getByRole('group', { name: 'الصنف 1' }).locator('[data-add-option]'),
  ).toHaveCount(0)
  await expectSound(page, 'ar')
  await shot(page, 'ar-1440-picker')
})

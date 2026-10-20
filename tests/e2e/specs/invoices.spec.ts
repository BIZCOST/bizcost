import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import {
  callApi,
  createUser,
  deleteUser,
  RAW_KEY,
  setLanguage,
  signIn,
  useLanguage,
  type TestUser,
} from '../helpers'
import { previewBaseURL } from '../stack'

// Invoices, credit notes, payments on invoices and customer statements (ROADMAP.md M3 Step 8; Q3, Q17,
// Q22, Q25–Q27), on the dev-only preview until Release B (D-125):
//
//   - The fit-out company in Arabic on a desktop: before its TRN, a draft says «أضف رقمك الضريبي
//     وعنوانك» and its issue waits; a full «فاتورة ضريبية» made from scratch (a typed line, the
//     customer's LPO, a due date), issued (its number taken, the PDF downloaded), part paid; a
//     «إشعار دائن ضريبي» for 4 m² of glass not fitted (reason, event date, by quantity), issued with
//     its own number; then the 30 / 40 / 30 stage invoices of another accepted quotation, made from the
//     quotation, issued one by one, adding up to the quotation; the list's filters and search.
//   - The designer in English on a phone: a plain «Invoice» of the sale she recorded (no VAT, never
//     "tax"), its draft opened from the sale, issued and shared as a PDF; the sale says it is invoiced.
//   - The factory's statement: a deposit recorded on an order without its tax invoice shows on Invoices
//     with its 14-day deadline and gets its deposit invoice; two invoiced orders with their LPOs, one
//     paid; the customer's page → Statement → this month → the PDF.
// With E2E_SHOTS_DIR set, each step leaves a screenshot there; with E2E_PDF_DIR, the PDFs downloaded.

test.describe.configure({ mode: 'serial' })

const PHONE = { width: 390, height: 844 }
const SMALL_PHONE = { width: 375, height: 812 }
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
  const user = await createUser(`invoices-${locale}`, { locale: 'en' })
  users.push(user)
  const context = await browser.newContext({
    baseURL: previewBaseURL,
    locale: locale === 'ar' ? 'ar-AE' : 'en-US',
    viewport,
    acceptDownloads: true,
  })
  contexts.push(context)
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

/** Screenshots into E2E_SHOTS_DIR (only when it is set): the screen, and a long page's end. */
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
    await page.screenshot({ path: join(dir, `${name}-full.png`), fullPage: true })
  }
}

/** Downloads the PDF the trigger offers (into E2E_PDF_DIR when set); its bytes. */
async function savePdf(page: Page, trigger: () => Promise<void>, name: string): Promise<Buffer> {
  const pending = page.waitForEvent('download')
  await trigger()
  const download = await pending
  const bytes = readFileSync(await download.path())
  expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  const dir = process.env.E2E_PDF_DIR
  if (dir) {
    mkdirSync(dir, { recursive: true })
    await download.saveAs(join(dir, `${name}.pdf`))
  }
  return bytes
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

/** A number as a sentence holds it: isolated, so it reads "INV-0001" in Arabic too. */
const n = (number: string) => `⁨${number}⁩`

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

/** A designer alone, not registered for VAT, who invoices companies later. */
const DESIGNER_ANSWERS = {
  what_you_do: ['services'],
  workplace: 'home',
  team: 'alone',
  work_setup: ['none'],
  sales_channels: ['messages', 'quotes', 'invoice_later'],
  vat: 'no',
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

/** The business's names, TRN and contact lines, as Settings saves them. */
async function setProfile(
  page: Page,
  businessId: string,
  fields: { legalName: string; legalNameAr: string; trn: string; letterhead: object },
) {
  const profile = await ok(
    callApi<{ version: number }>(page, 'business.profile', {}, { businessId, query: true }),
    'business.profile',
  )
  await ok(
    callApi(
      page,
      'business.updateProfile',
      {
        version: profile.version,
        legalName: fields.legalName,
        legalNameAr: fields.legalNameAr,
        vatRegistered: true,
        trn: fields.trn,
        letterhead: fields.letterhead,
      },
      { businessId },
    ),
    'business.updateProfile',
  )
}

async function today(page: Page, businessId: string): Promise<string> {
  return (
    await ok(
      callApi<{ today: string }>(page, 'books.get', {}, { businessId, query: true }),
      'books.get',
    )
  ).today
}

async function firstChannel(page: Page, businessId: string): Promise<string> {
  const channels = await ok(
    callApi<{ data: { items: { id: string }[] } }>(
      page,
      'channel.list',
      { status: 'active' },
      { businessId, query: true },
    ),
    'channel.list',
  )
  return channels.data.items[0]!.id
}

async function customer(page: Page, businessId: string, fields: object): Promise<string> {
  const made = await ok(
    callApi<{ id: string }>(
      page,
      'customer.create',
      { id: randomUUID(), ...fields },
      { businessId },
    ),
    'customer.create',
  )
  return made.id
}

interface Issued {
  id: string
  number: string
  version: number
  lines: { id: string }[]
}

test('the fit-out company in Arabic on a desktop: a full tax invoice, a tax credit note, stage invoices', async ({
  browser,
}) => {
  test.setTimeout(900_000)
  const page = await open(browser, DESKTOP, 'ar', 'عبدالله')
  const businessId = await createBusinessIn(page, 'Modern Touch Interiors', FITOUT_ANSWERS, 'ar')
  const day = await today(page, businessId)
  const towers = await customer(page, businessId, {
    name: 'أبراج الخليج ذ.م.م',
    kind: 'business',
    trn: '100555666700003',
    addressLine: 'مكتب 1402، مارينا بلازا',
    city: 'دبي مارينا',
    emirate: 'dubai',
  })

  // Invoices: nothing yet.
  await page.goto(`/b/${businessId}/invoices`)
  await expect(page.getByRole('heading', { level: 1, name: 'الفواتير' })).toBeVisible()
  await expect(page.getByText('لا فواتير بعد')).toBeVisible()
  await expectSound(page, 'ar')
  await shot(page, 'invoices-ar-1440-empty')

  // A full tax invoice from scratch: the customer, a typed line, the LPO and a due date.
  await page.getByRole('link', { name: 'فاتورة جديدة' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'فاتورة جديدة' })).toBeVisible()
  await page.getByRole('combobox', { name: 'العميل' }).fill('أبراج')
  await page.getByRole('option', { name: /أبراج الخليج/ }).click()
  await page.getByRole('textbox', { name: 'رقم أمر الشراء (LPO) للعميل' }).fill('LPO-7781')
  const lines = page.locator('[data-quotation-line]')
  await lines.nth(0).getByRole('combobox', { name: 'البند' }).fill('قواطع زجاجية للمكاتب')
  await lines.nth(0).getByRole('textbox', { name: 'الكمية' }).fill('12')
  await lines.nth(0).getByRole('combobox', { name: 'الوحدة' }).selectOption('m2')
  await lines.nth(0).getByRole('textbox', { name: 'السعر قبل الضريبة' }).fill('850')
  // 12 × 850 = 10,200.00 before VAT; 510.00 VAT: 10,710.00.
  await expect(page.locator('[data-running-total]:visible')).toHaveText(money('ar', '10,710.00'))
  await expectSound(page, 'ar')
  await shot(page, 'invoices-ar-1440-editor')
  await page.getByRole('button', { name: 'حفظ المسودة' }).click()
  await expect(page.getByText('حُفظت مسودة الفاتورة. راجعها ثم أصدرها.')).toBeVisible()

  // Before its TRN, the draft leads to «أضف رقمك الضريبي وعنوانك» and the issue waits for it.
  await expect(page.getByRole('heading', { level: 1, name: 'مسودة فاتورة ضريبية' })).toBeVisible()
  const firstTax = page.locator('[data-first-tax-note]')
  await expect(firstTax).toContainText('قبل أول فاتورة ضريبية')
  await expect(firstTax.getByRole('link', { name: 'أضف رقمك الضريبي وعنوانك' })).toHaveAttribute(
    'href',
    `/b/${businessId}/settings/business`,
  )
  await expectSound(page, 'ar')
  await shot(page, 'invoices-ar-1440-draft-first-tax')
  await page.getByRole('button', { name: 'إصدار', exact: true }).click()
  const issueDialog = page.getByRole('alertdialog')
  await expect(issueDialog).toContainText('إصدار فاتورة ضريبية؟')
  await expect(issueDialog.locator('[data-issue-missing="business_trn"]')).toBeVisible()
  await expect(issueDialog.getByRole('button', { name: 'إصدار', exact: true })).toBeDisabled()
  await shot(page, 'invoices-ar-1440-issue-blocked')
  await issueDialog.getByRole('button', { name: 'إلغاء' }).click()

  // The TRN and the address added (as Settings → Business does): the draft is ready.
  await setProfile(page, businessId, {
    legalName: 'Modern Touch Interiors',
    legalNameAr: 'لمسة عصرية للديكور',
    trn: '100345678900003',
    letterhead: {
      phone: '+971 4 555 0142',
      phone2: null,
      email: 'hello@moderntouch.example',
      addressLine: 'مستودع 7، القوز الصناعية 3',
      city: 'دبي',
      emirate: 'dubai',
      tradeLicenceNo: 'DED-884210',
      tradeLicenceAuthority: 'دائرة الاقتصاد والسياحة',
    },
  })
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: 'مسودة فاتورة ضريبية' })).toBeVisible()
  await expect(page.locator('[data-first-tax-note]')).toHaveCount(0)

  // The due date set in the editor, then issued: «the number is taken; to fix it, a credit note».
  await page.getByRole('link', { name: 'تعديل' }).click()
  await expect(
    page.getByRole('heading', { level: 1, name: 'تعديل مسودة فاتورة ضريبية' }),
  ).toBeVisible()
  const due = new Date(Date.parse(`${day}T00:00:00Z`) + 30 * 86_400_000).toISOString().slice(0, 10)
  await page.getByLabel('تاريخ الاستحقاق').fill(due)
  await page.getByRole('button', { name: 'حفظ التغييرات' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'مسودة فاتورة ضريبية' })).toBeVisible()
  await page.getByRole('button', { name: 'إصدار', exact: true }).click()
  await expect(issueDialog).toContainText('لتصحيحها، ستصدر إشعارًا دائنًا.')
  await expect(issueDialog).toContainText('تأخذ رقم الفاتورة التالي وتاريخ اليوم')
  await shot(page, 'invoices-ar-1440-issue')
  await issueDialog.getByRole('button', { name: 'إصدار', exact: true }).click()
  await expect(page.getByText(`صدرت ${n('INV-0001')}.`)).toBeVisible()
  const pdfDialog = page.getByRole('dialog')
  await expect(pdfDialog).toContainText(`صدرت ${n('INV-0001')}: نزّلها أو شاركها`)
  await expect(page.locator('[data-pdf-preview]')).toBeVisible({ timeout: 60_000 })
  await shot(page, 'invoices-ar-1440-issued-pdf')
  await savePdf(
    page,
    () => pdfDialog.getByRole('button', { name: 'تنزيل PDF' }).click(),
    'fitout-tax-invoice-ar',
  )
  await page.keyboard.press('Escape')
  await expect(
    page.getByRole('heading', { level: 1, name: `فاتورة ضريبية ${n('INV-0001')}` }),
  ).toBeVisible()
  await expect(page.locator('[data-invoice-state="owed"]')).toBeVisible()
  await expect(page.locator('[data-invoice-counting]')).toContainText('تُحسب عملية بيعها في')

  // Part paid: 5,000.00 by bank transfer.
  await page.getByRole('button', { name: 'سجّل دفعة' }).click()
  const paySheet = page.getByRole('dialog')
  await paySheet.getByLabel('طريقة الدفع').selectOption('bank_transfer')
  await paySheet.getByRole('textbox', { name: 'المبلغ' }).fill('5000')
  await paySheet.getByRole('button', { name: 'سجّل الدفعة' }).click()
  await expect(paySheet).toBeHidden()
  await expect(page.locator('[data-invoice-state="partPaid"]')).toBeVisible()
  await expect(page.locator('[data-owed="owed"]')).toContainText(money('ar', '5,710.00'))
  await expectSound(page, 'ar')
  await shot(page, 'invoices-ar-1440-invoice')

  // A tax credit note: 4 m² of glass not fitted, by quantity; its own number (CN-0001).
  await page.getByRole('button', { name: 'إشعار دائن' }).click()
  const creditSheet = page.getByRole('dialog')
  await expect(creditSheet).toContainText(`إشعار دائن ضريبي للفاتورة ${n('INV-0001')}`)
  await creditSheet.locator('[data-credit-reason]').selectOption('price_changed')
  await creditSheet.locator('[data-credit-reason-text]').fill('لم يُركَّب 4 م² من الزجاج')
  // An event more than 14 days old says a tax credit note is late.
  const old = new Date(Date.parse(`${day}T00:00:00Z`) - 20 * 86_400_000).toISOString().slice(0, 10)
  await creditSheet.locator('[data-credit-event-date]').fill(old)
  await expect(creditSheet.locator('[data-credit-late]')).toContainText(
    'الإشعار الدائن الضريبي مستحق خلال 14 يومًا',
  )
  await creditSheet.locator('[data-credit-event-date]').fill(day)
  await expect(creditSheet.locator('[data-credit-late]')).toHaveCount(0)
  await creditSheet.getByRole('textbox', { name: /ما يُسترد من/ }).fill('4')
  await shot(page, 'invoices-ar-1440-credit-sheet')
  await creditSheet.getByRole('button', { name: 'حفظ وإصدار…' }).click()
  const creditConfirm = page.getByRole('alertdialog')
  await expect(creditConfirm).toContainText('إصدار إشعار دائن ضريبي؟')
  // 4 × 850 = 3,400.00 + 170.00 VAT.
  await expect(creditConfirm).toContainText(money('ar', '3,570.00'))
  await shot(page, 'invoices-ar-1440-credit-confirm')
  await creditConfirm.getByRole('button', { name: 'إصدار الإشعار الدائن' }).click()
  await expect(page.getByText(`صدر ${n('CN-0001')}.`)).toBeVisible()
  await expect(page.locator('[data-pdf-preview]')).toBeVisible({ timeout: 60_000 })
  await savePdf(
    page,
    () => page.getByRole('dialog').getByRole('button', { name: 'تنزيل PDF' }).click(),
    'fitout-tax-credit-note-ar',
  )
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-invoice-credit="partly"]')).toBeVisible()
  await expect(page.locator('[data-credit-note="issued"]')).toContainText('CN-0001')
  // What is owed: 10,710.00 − 3,570.00 − 5,000.00 = 2,140.00.
  await expect(page.locator('[data-owed="owed"]')).toContainText(money('ar', '2,140.00'))
  await expectSound(page, 'ar')
  await shot(page, 'invoices-ar-1440-credited')

  // Stage invoices: another accepted quotation, 30 / 40 / 30 of 21,000.00.
  const quote = await ok(
    callApi<{ id: string; version: number }>(
      page,
      'quotation.create',
      {
        id: randomUUID(),
        customerId: towers,
        businessDate: day,
        lines: [
          {
            id: randomUUID(),
            productId: null,
            description: 'تجهيز مكتب الاستقبال',
            qty: '1',
            unit: 'piece',
            unitPrice: '20000',
          },
        ],
        stages: [
          { label: 'دفعة التعاقد', due: 'عند التوقيع', percent: '30' },
          { label: null, due: 'عند التوريد', percent: '40' },
          { label: null, due: 'عند التسليم', percent: '30' },
        ],
      },
      { businessId },
    ),
    'quotation.create',
  )
  const sent = await ok(
    callApi<{ id: string; version: number }>(
      page,
      'quotation.send',
      { id: quote.id, version: quote.version },
      { businessId },
    ),
    'quotation.send',
  )
  await ok(
    callApi(
      page,
      'quotation.accept',
      { id: sent.id, version: sent.version, note: null },
      { businessId },
    ),
    'quotation.accept',
  )
  const stageAmounts = ['6,300.00', '8,400.00', '6,300.00']
  for (let stage = 0; stage < 3; stage++) {
    await page.goto(`/b/${businessId}/quotations/${quote.id}`)
    await page.getByRole('button', { name: 'إنشاء فاتورة' }).click()
    const bill = page.getByRole('alertdialog')
    await expect(bill).toContainText(`فوترة عرض السعر ${n('Q-0001')}`)
    // The next stage is chosen to start with; those invoiced are marked and can't be chosen again,
    // nor a later one before it (stages are billed in their order, each once).
    await expect(bill.locator(`[data-bills="stage-${stage}"]`)).toBeChecked()
    for (let other = 0; other < 3; other++) {
      if (other === stage) continue
      await expect(bill.locator(`[data-bills="stage-${other}"]`)).toBeDisabled()
    }
    if (stage > 0) await expect(bill).toContainText('فُوترت')
    if (stage === 0) await shot(page, 'invoices-ar-1440-bill-stage')
    await bill.getByRole('button', { name: 'أنشئ المسودة' }).click()
    await expect(
      page.getByRole('heading', { level: 1, name: 'تعديل مسودة فاتورة ضريبية' }),
    ).toBeVisible()
    await expect(page.locator('[data-running-total]:visible')).toHaveText(
      money('ar', stageAmounts[stage]!),
    )
    if (stage === 0) await shot(page, 'invoices-ar-1440-stage-editor')
    await page.getByRole('button', { name: 'حفظ التغييرات' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'مسودة فاتورة ضريبية' })).toBeVisible()
    await page.getByRole('button', { name: 'إصدار', exact: true }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'إصدار', exact: true }).click()
    await expect(page.getByText(`صدرت ${n(`INV-000${stage + 2}`)}.`)).toBeVisible()
    await expect(page.locator('[data-pdf-preview]')).toBeVisible({ timeout: 60_000 })
    if (stage === 2) {
      await savePdf(
        page,
        () => page.getByRole('dialog').getByRole('button', { name: 'تنزيل PDF' }).click(),
        'fitout-stage-3-ar',
      )
    }
    await page.keyboard.press('Escape')
  }
  // The three stages add up to the quotation.
  await page.goto(`/b/${businessId}/quotations/${quote.id}`)
  await expect(page.locator('[data-source-invoiced]')).toContainText(money('ar', '21,000.00'))
  await expect(page.locator('[data-source-invoices] [data-invoice-row]')).toHaveCount(3)
  // Invoiced in full: nothing more to invoice.
  await expect(page.getByRole('button', { name: 'إنشاء فاتورة' })).toHaveCount(0)
  await expectSound(page, 'ar')
  await shot(page, 'invoices-ar-1440-quotation-invoiced')

  // The customer's statement, in Arabic on a desktop: the invoices, the credit note and the payment.
  await page.goto(`/b/${businessId}/customers/${towers}/statement`)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('كشف حساب')
  await expect(page.locator('[data-statement-entry="invoice"]:visible')).toHaveCount(4)
  await expect(page.locator('[data-statement-entry="credit_note"]:visible')).toHaveCount(1)
  await expect(page.getByRole('columnheader', { name: 'الدفعات والإشعارات الدائنة' })).toBeVisible()
  await expect(page.locator('[data-statement-detail]:visible').first()).toContainText('تحويل بنكي')
  await expectSound(page, 'ar')
  await shot(page, 'invoices-ar-1440-statement')

  // The list: four invoices; credited ones and a search by LPO.
  await page.goto(`/b/${businessId}/invoices`)
  await expect(page.locator('[data-invoice-row]')).toHaveCount(4)
  await expectSound(page, 'ar')
  await shot(page, 'invoices-ar-1440-list')
  await page.getByText('بإشعار دائن', { exact: true }).click()
  await expect(page).toHaveURL(/status=credited/)
  await expect(page.locator('[data-invoice-row]')).toHaveCount(1)
  await page.getByText('الكل', { exact: true }).click()
  await page.getByRole('searchbox').fill('LPO-7781')
  await expect(page).toHaveURL(/q=LPO-7781/)
  await expect(page.locator('[data-invoice-row]')).toHaveCount(1)
  await expect(page.locator('[data-invoice-row]')).toContainText('INV-0001')

  // Copied to a new quotation: its customer and lines, a draft to change.
  await page.locator('[data-invoice-row]').click()
  await page.getByRole('button', { name: 'نسخ إلى عرض سعر' }).click()
  const copy = page.getByRole('alertdialog')
  await expect(copy).toContainText('نسخ إلى عرض سعر جديد؟')
  await copy.getByRole('button', { name: 'نسخ', exact: true }).click()
  await expect(page.getByText(`عرض السعر ${n('Q-0002')} جاهز للتعديل.`)).toBeVisible()
  await expect(page.locator('[data-quotation-line]')).toHaveCount(1)
  await expect(
    page.locator('[data-quotation-line]').getByRole('combobox', { name: 'البند' }),
  ).toHaveValue('قواطع زجاجية للمكاتب')
})

test('the designer in English on a phone: a plain invoice of the sale she recorded', async ({
  browser,
}) => {
  test.setTimeout(600_000)
  const page = await open(browser, PHONE, 'en', 'Noura')
  const businessId = await createBusinessIn(page, 'Noura Designs', DESIGNER_ANSWERS, 'en')
  const day = await today(page, businessId)
  const bloom = await customer(page, businessId, { name: 'Bloom Florists LLC', kind: 'business' })
  const service = await ok(
    callApi<{ id: string }>(
      page,
      'product.create',
      {
        id: randomUUID(),
        name: 'Brand identity',
        type: 'service',
        unit: 'piece',
        defaultPrice: '4500',
      },
      { businessId },
    ),
    'product.create',
  )
  const draft = await ok(
    callApi<{ data: { id: string; version: number } }>(
      page,
      'sale.create',
      {
        id: randomUUID(),
        source: 'single',
        channelId: await firstChannel(page, businessId),
        businessDate: day,
        customerId: bloom,
        payLater: true,
        lines: [
          { kind: 'item', id: randomUUID(), productId: service.id, qty: '1', unitPrice: '4500' },
        ],
      },
      { businessId },
    ),
    'sale.create',
  )
  await ok(
    callApi(page, 'sale.post', { id: draft.data.id, version: draft.data.version }, { businessId }),
    'sale.post',
  )

  // From the sale: "Invoice this sale".
  await page.goto(`/b/${businessId}/sales/${draft.data.id}`)
  await page.getByRole('button', { name: 'Invoice this sale' }).click()
  const confirm = page.getByRole('alertdialog')
  await expect(confirm).toContainText('Invoice this sale?')
  await expect(confirm).toContainText(money('en', '4,500.00'))
  await shot(page, 'invoices-en-390-invoice-sale')
  await confirm.getByRole('button', { name: 'Make the draft' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Change draft Invoice' })).toBeVisible()
  await expect(page.locator('[data-invoice-bills]')).toHaveText(
    'Bills a sale you recorded, as it was.',
  )
  const due = new Date(Date.parse(`${day}T00:00:00Z`) + 14 * 86_400_000).toISOString().slice(0, 10)
  await page.getByLabel('Due date').fill(due)
  await expectSound(page, 'en')
  await shot(page, 'invoices-en-390-editor')
  await page.locator('[data-phone-save-bar]').getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Draft Invoice' })).toBeVisible()
  await expect(page.locator('[data-invoice-counting]')).toHaveText(
    'The sale it bills already counts.',
  )
  // A plain invoice never says "tax" or VAT.
  expect(await page.locator('main').innerText()).not.toMatch(/\bTax\b|\bVAT\b/)
  await expectSound(page, 'en')
  await shot(page, 'invoices-en-390-draft')

  await page.getByRole('button', { name: 'Issue', exact: true }).click()
  const issue = page.getByRole('alertdialog')
  await expect(issue).toContainText('Issue Invoice?')
  await expect(issue).toContainText("To fix it, you'll issue a credit note.")
  await shot(page, 'invoices-en-390-issue')
  await issue.getByRole('button', { name: 'Issue', exact: true }).click()
  await expect(page.getByText(`${n('INV-0001')} is issued.`)).toBeVisible()
  const pdf = page.getByRole('dialog')
  await expect(pdf.getByRole('button', { name: 'Download PDF' })).toBeEnabled({ timeout: 60_000 })
  await shot(page, 'invoices-en-390-pdf')
  await savePdf(
    page,
    () => pdf.getByRole('button', { name: 'Download PDF' }).click(),
    'designer-invoice-en',
  )
  await page.keyboard.press('Escape')
  await expect(
    page.getByRole('heading', { level: 1, name: `Invoice ${n('INV-0001')}` }),
  ).toBeVisible()
  expect(await page.locator('main').innerText()).not.toMatch(/\bTax\b|\bVAT\b/)
  await expect(page.locator('[data-invoice-state="owed"]')).toBeVisible()
  await expectSound(page, 'en')
  await shot(page, 'invoices-en-390-invoice')

  // The sale now says it is invoiced: payments go on the invoice.
  await page.goto(`/b/${businessId}/sales/${draft.data.id}`)
  await expect(page.getByRole('link', { name: `Open invoice ${n('INV-0001')}` })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Invoice this sale' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Reverse' })).toHaveCount(0)
  await expectSound(page, 'en')
  await shot(page, 'invoices-en-390-sale-invoiced')

  // An invoice from scratch, now that she records her sales: "already in your recorded sales?" is
  // asked before the issue, never preselected (Q3).
  await page.goto(`/b/${businessId}/invoices/new`)
  await expect(page.getByRole('heading', { level: 1, name: 'New invoice' })).toBeVisible()
  await page.getByRole('combobox', { name: 'Customer' }).fill('Bloom')
  await page.getByRole('option', { name: /Bloom Florists LLC/ }).click()
  const line = page.locator('[data-quotation-line]').nth(0)
  await line.getByRole('combobox', { name: 'Item' }).fill('Social media pack, October')
  await line.getByRole('textbox', { name: 'Quantity' }).fill('1')
  await line.getByRole('textbox', { name: 'Price' }).fill('1200')
  await expect(page.locator('[data-running-total]:visible')).toHaveText(money('en', '1,200.00'))
  await expectSound(page, 'en')
  await shot(page, 'invoices-en-390-new')
  await page.locator('[data-phone-save-bar]').getByRole('button', { name: 'Save draft' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Draft Invoice' })).toBeVisible()
  await expect(page.getByText("you'll be asked whether this sale is already")).toBeVisible()
  await page.getByRole('button', { name: 'Issue', exact: true }).click()
  const asked = page.getByRole('alertdialog')
  const question = asked.locator('[data-counted-question]')
  await expect(question).toContainText('Is this sale already in your recorded sales')
  await expect(question.locator('[data-counted="yes"]')).not.toBeChecked()
  await expect(question.locator('[data-counted="no"]')).not.toBeChecked()
  await asked.getByRole('button', { name: 'Issue', exact: true }).click()
  await expect(question).toContainText('Answer this to issue the invoice.')
  await shot(page, 'invoices-en-390-counted')
  await question.locator('[data-counted="yes"]').check()
  await asked.getByRole('button', { name: 'Issue', exact: true }).click()
  await expect(page.getByText(`${n('INV-0002')} is issued.`)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-invoice-counting]')).toHaveText(
    "It's already in your recorded sales, so it isn't counted again.",
  )

  // Invoices on the phone.
  await page.goto(`/b/${businessId}/invoices`)
  await expect(page.locator('[data-invoice-row]')).toHaveCount(2)
  await expectSound(page, 'en')
  await shot(page, 'invoices-en-390-list')
})

test("the factory's deposit invoice and its customer's statement", async ({ browser }) => {
  test.setTimeout(600_000)
  const page = await open(browser, DESKTOP, 'en', 'Saeed')
  const businessId = await createBusinessIn(page, 'Al Noor Metal Works', FACTORY_ANSWERS, 'en')
  await setProfile(page, businessId, {
    legalName: 'Al Noor Metal Works',
    legalNameAr: 'النور للأعمال المعدنية',
    trn: '100678901200003',
    letterhead: {
      phone: '+971 6 555 0177',
      phone2: null,
      email: 'sales@alnoor.example',
      addressLine: 'Industrial Area 2',
      city: 'Sharjah',
      emirate: 'sharjah',
      tradeLicenceNo: 'SHJ-55102',
      tradeLicenceAuthority: 'Sharjah SEDD',
    },
  })
  const day = await today(page, businessId)
  const channelId = await firstChannel(page, businessId)
  const gulf = await customer(page, businessId, {
    name: 'Gulf Build Contracting LLC',
    kind: 'business',
    trn: '100555666700003',
    addressLine: 'Office 12, Al Majaz Tower',
    city: 'Al Majaz',
    emirate: 'sharjah',
  })
  const bracket = await ok(
    callApi<{ id: string }>(
      page,
      'product.create',
      {
        id: randomUUID(),
        name: 'Steel bracket, galvanised',
        type: 'product',
        unit: 'piece',
        defaultPrice: '35',
      },
      { businessId },
    ),
    'product.create',
  )
  const orderOf = async (lpo: string, qty: string, payment?: string) =>
    (
      await ok(
        callApi<{ data: { id: string; number: string; version: number } }>(
          page,
          'order.create',
          {
            id: randomUUID(),
            customerId: gulf,
            customerRef: lpo,
            businessDate: day,
            channelId,
            lines: [
              { kind: 'item', id: randomUUID(), productId: bracket.id, qty, unitPrice: '35' },
            ],
            ...(payment
              ? { payment: { id: randomUUID(), method: 'bank_transfer', amount: payment } }
              : {}),
          },
          { businessId },
        ),
        'order.create',
      )
    ).data
  // Two orders delivered and invoiced with their LPOs; the first paid.
  const invoiced: Issued[] = []
  for (const [lpo, qty] of [
    ['LPO-2231', '200'],
    ['LPO-2244', '120'],
  ] as const) {
    const order = await orderOf(lpo, qty)
    await ok(
      callApi(page, 'order.deliver', { id: order.id, version: order.version }, { businessId }),
      'order.deliver',
    )
    const draft = await ok(
      callApi<Issued>(
        page,
        'invoice.fromOrder',
        { orderId: order.id, newId: randomUUID() },
        { businessId },
      ),
      'invoice.fromOrder',
    )
    invoiced.push(
      await ok(
        callApi<Issued>(
          page,
          'invoice.issue',
          { id: draft.id, version: draft.version },
          { businessId },
        ),
        'invoice.issue',
      ),
    )
  }
  await ok(
    callApi(
      page,
      'customerPayment.record',
      {
        id: randomUUID(),
        invoiceId: invoiced[0]!.id,
        businessDate: day,
        method: 'bank_transfer',
        amount: '7350',
      },
      { businessId },
    ),
    'customerPayment.record',
  )
  // A third order waits, with a deposit of 1,000.00 paid on it and no tax invoice yet.
  const waiting = await orderOf('LPO-2260', '300', '1000')

  // Invoices shows the deposit with its 14-day deadline; its deposit invoice is made from there.
  await page.goto(`/b/${businessId}/invoices`)
  const deposits = page.locator('[data-deposits-without-invoice]')
  await expect(deposits).toContainText('Deposits without a tax invoice')
  await expect(deposits.locator('[data-deposit-without-invoice]')).toContainText(
    `Order ${n(waiting.number)}`,
  )
  await expect(deposits.locator('[data-deposit-due="due"]')).toContainText('tax invoice due by')
  await expectSound(page, 'en')
  await shot(page, 'invoices-en-1440-deposits')
  // … and under "Needs a look" on the Dashboard.
  await page.goto(`/b/${businessId}`)
  const look = page.locator('[data-needs-look="depositsWithoutInvoice"]')
  await expect(look).toContainText('Deposits waiting for their tax invoice')
  await expect(look).toContainText(waiting.number)
  await look.scrollIntoViewIfNeeded()
  await shot(page, 'invoices-en-1440-needs-look')
  await look.getByRole('link', { name: 'Open Invoices' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Invoices' })).toBeVisible()
  await deposits.getByRole('button', { name: 'Make its deposit invoice' }).click()
  const bill = page.getByRole('alertdialog')
  await expect(bill).toContainText(`Invoice order ${n(waiting.number)}`)
  await expect(bill.locator('[data-bills="part"]')).toBeChecked()
  await expect(bill.locator('[data-bill-deposit]')).toBeChecked()
  await shot(page, 'invoices-en-1440-deposit-bill')
  await bill.getByRole('button', { name: 'Make the draft' }).click()
  await expect(
    page.getByRole('heading', { level: 1, name: 'Change draft Tax Invoice' }),
  ).toBeVisible()
  await expect(page.locator('[data-invoice-bills]')).toContainText('A deposit of')
  await page.getByRole('button', { name: 'Save changes' }).first().click()
  await expect(page.locator('[data-invoice-counting]')).toHaveText(
    'This sale counts when order ' + n(waiting.number) + ' is delivered.',
  )
  await page.getByRole('button', { name: 'Issue', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Issue', exact: true }).click()
  await expect(page.getByText(`${n('INV-0003')} is issued.`)).toBeVisible()
  await page.keyboard.press('Escape')
  await page.goto(`/b/${businessId}/invoices`)
  await expect(page.locator('[data-deposits-without-invoice]')).toHaveCount(0)
  await expect(page.locator('[data-invoice-row]')).toHaveCount(3)
  await page.getByText('Owed', { exact: true }).click()
  await expect(page).toHaveURL(/status=owed/)
  await expect(page.locator('[data-invoice-row]')).toHaveCount(1)
  await shot(page, 'invoices-en-1440-list')

  // The customer's page → Statement → this month: what was invoiced, paid and is still owed.
  await page.goto(`/b/${businessId}/customers/${gulf}`)
  await page.getByRole('link', { name: 'Statement' }).click()
  await expect(
    page.getByRole('heading', {
      level: 1,
      name: `Statement for ${n('Gulf Build Contracting LLC')}`,
    }),
  ).toBeVisible()
  await expect(page.locator('[data-statement-preset="thisMonth"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  // 200 × 35 = 7,000 + 350 VAT; 120 × 35 = 4,200 + 210 VAT; the deposit invoice 1,000.00.
  await expect(page.locator('[data-statement-entry="invoice"]:visible')).toHaveCount(3)
  await expect(page.locator('[data-statement-sum="invoiced"]')).toContainText(
    money('en', '12,760.00'),
  )
  await expect(page.locator('[data-statement-sum="paid"]')).toContainText(money('en', '8,350.00'))
  await expect(page.locator('[data-statement-sum="closing"]')).toContainText(
    money('en', '4,410.00'),
  )
  await expectSound(page, 'en')
  await shot(page, 'invoices-en-1440-statement')
  await page.getByRole('button', { name: 'PDF', exact: true }).click()
  const pdf = page.getByRole('dialog')
  await expect(page.locator('[data-pdf-preview]')).toBeVisible({ timeout: 60_000 })
  await shot(page, 'invoices-en-1440-statement-pdf')
  await savePdf(
    page,
    () => pdf.getByRole('button', { name: 'Download PDF' }).click(),
    'factory-statement-en',
  )
  await page.keyboard.press('Escape')
  // Last month: nothing yet, owed nothing.
  await page.locator('[data-statement-preset="lastMonth"]').click()
  await expect(page).toHaveURL(/from=/)
  await expect(page.getByText('Nothing in this period.')).toBeVisible()

  // The customer's address, asked with Invoices on (a tax invoice prints it).
  await page.goto(`/b/${businessId}/customers/${gulf}`)
  await page.getByRole('button', { name: 'Edit' }).click()
  const form = page.getByRole('dialog')
  const address = form.locator('[data-customer-address]')
  await expect(address.getByRole('textbox', { name: 'Street or building' })).toHaveValue(
    'Office 12, Al Majaz Tower',
  )
  await expect(address.getByRole('combobox', { name: 'Emirate' })).toHaveValue('sharjah')
  await address.getByRole('textbox', { name: 'Area or city' }).fill('Al Majaz 3')
  await shot(page, 'invoices-en-1440-customer-address')
  await form.getByRole('button', { name: 'Save' }).click()
  await expect(form).toBeHidden()

  // Settings → Documents numbers invoices and credit notes too.
  await page.goto(`/b/${businessId}/settings/documents`)
  await expect(page.getByRole('group', { name: 'Credit notes' })).toBeVisible()
  await expect(page.getByText('INV-0004')).toBeVisible()
  await shot(page, 'invoices-en-1440-settings-series')

  // In Arabic on a small phone: the statement, the list and an invoice.
  await setLanguage(page, 'ar')
  await page.setViewportSize(SMALL_PHONE)
  await page.goto(`/b/${businessId}/customers/${gulf}/statement`)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('كشف حساب')
  await expect(page.locator('[data-statement-sum="closing"]')).toContainText(
    money('ar', '4,410.00'),
  )
  await expectSound(page, 'ar')
  await shot(page, 'invoices-ar-375-statement')
  await page.goto(`/b/${businessId}/invoices`)
  await expect(page.locator('[data-invoice-row]')).toHaveCount(3)
  await expectSound(page, 'ar')
  await shot(page, 'invoices-ar-375-list')
  await page.goto(`/b/${businessId}/invoices/${invoiced[1]!.id}`)
  await expect(
    page.getByRole('heading', { level: 1, name: `فاتورة ضريبية ${n('INV-0002')}` }),
  ).toBeVisible()
  await expectSound(page, 'ar')
  await shot(page, 'invoices-ar-375-invoice')
  await page.getByRole('button', { name: 'إشعار دائن' }).click()
  await expect(page.getByRole('dialog')).toContainText(`إشعار دائن ضريبي للفاتورة ${n('INV-0002')}`)
  await expectSound(page, 'ar')
  await shot(page, 'invoices-ar-375-credit-sheet')
  await page.getByRole('dialog').getByRole('button', { name: 'إلغاء' }).click()
  await page.goto(`/b/${businessId}/invoices/new`)
  await expect(page.getByRole('heading', { level: 1, name: 'فاتورة جديدة' })).toBeVisible()
  await expectSound(page, 'ar')
  await shot(page, 'invoices-ar-375-new')
})

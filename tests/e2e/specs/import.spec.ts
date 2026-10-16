import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
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
import { baseURL } from '../stack'

// Importing sales from a file (ROADMAP.md M3 Step 4; the owner's answer Q15 of D-218), on the
// production build since Release A released Sales (M3 Step 6, as D-199 after M2).
//
//   - A VAT-registered café with two branches imports its POS's day file for its first branch, in
//     English on a desktop: the file read on the device (a summary with a title line and a "Total"
//     row), the columns found from their names, "These sales are for: one day", "Do these amounts
//     include VAT?" (Yes), then the names: "Spanish Latte L" blocks «Finalize» until it is settled by
//     "Did you mean Spanish Latte?"; the preview's sales before VAT (2,268.00 + 236.25 with VAT =
//     2,385.00 before VAT); Finalize. The same file again is refused ("already imported on …").
//   - The second branch's line file in Arabic on a phone: Arabic headers and Arabic-Indic digits, a
//     column before VAT (no VAT question), tips («بقشيش») unmatched until marked "not something I
//     sell"; then Talabat's statement read from the statement template (Arabic headers) and finalized.
//   - The import, its list and the statements in the other language and size (EN phone, AR desktop).
// With E2E_SHOTS_DIR set, each step leaves a screenshot there.

test.describe.configure({ mode: 'serial' })

const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1440, height: 900 }

/** A café with a team and two branches, VAT-registered, a POS, walk-in customers and online. */
const CAFE_ANSWERS = {
  what_you_do: ['food_drinks'],
  workplace: 'shop',
  branches: true,
  team: 'team',
  team_tracking: ['hours'],
  work_setup: ['stock'],
  sales_channels: ['walk_in', 'online'],
  pos: true,
  vat: 'yes',
}

const users: TestUser[] = []
const contexts: BrowserContext[] = []

test.afterAll(async () => {
  for (const context of contexts) await context.close()
  for (const user of users) await deleteUser(user.id)
})

async function ok<T>(pending: Promise<{ data?: T; appCode?: string }>, what: string): Promise<T> {
  const result = await pending
  expect(result.appCode, what).toBeUndefined()
  return result.data as T
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

/** `value` in Arabic-Indic digits, with ٫ and ٬. */
function arabic(value: string): string {
  return value
    .replace(/\d/g, (d) => ARABIC_DIGITS[Number(d)]!)
    .replace('.', '٫')
    .replace(',', '٬')
}

/** The day before `day` (YYYY-MM-DD), and a day as a file writes it (dd/mm/yyyy). */
function dayBefore(day: string, days = 1): string {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - days)
  return date.toISOString().slice(0, 10)
}
const dmy = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`

/** A CSV file to pick (UTF-8 with a byte-order mark, as spreadsheets save Arabic). */
function csv(name: string, lines: readonly string[]) {
  return {
    name,
    mimeType: 'text/csv',
    buffer: Buffer.from(`\uFEFF${lines.join('\r\n')}\r\n`, 'utf8'),
  }
}

let owner: Page

/**
 * Picks a file on the import page (once the page answers: a file set before it hydrates is not read).
 */
async function pick(page: Page, file: ReturnType<typeof csv>) {
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
let businessId: string
let today: string
let yesterday: string
let marina: string
let talabat: string

async function openAs(
  browser: Browser,
  user: TestUser,
  viewport: { width: number; height: number },
  locale: 'en' | 'ar',
): Promise<Page> {
  const context = await browser.newContext({
    baseURL,
    locale: locale === 'ar' ? 'ar-AE' : 'en-US',
    viewport,
  })
  contexts.push(context)
  await useLanguage(context, 'en')
  const page = await context.newPage()
  // Leaving a file read and not sent asks first (D-161): the tests leave it on purpose.
  page.on('dialog', (dialog) => void dialog.accept())
  await signIn(page, user)
  if (locale === 'ar') await setLanguage(page, 'ar')
  return page
}

test('a café imports its first branch’s day file in English on a desktop, and the same file is refused', async ({
  browser,
}) => {
  const user = await createUser('import-en', { locale: 'en' })
  users.push(user)
  owner = await openAs(browser, user, DESKTOP, 'en')
  const created = await ok(
    callApi<{ businessId: string }>(owner, 'business.createFromSetup', {
      businessId: randomUUID(),
      legalName: 'Import Café',
      locale: 'en',
      questionSetVersion: 1,
      answers: CAFE_ANSWERS,
      adjustments: { modules: [], capabilities: [] },
    }),
    'business.createFromSetup',
  )
  businessId = created.businessId
  const api = (path: string, input: object) => ok(callApi(owner, path, input, { businessId }), path)
  marina = randomUUID()
  await api('location.create', { id: marina, name: 'Marina' })
  talabat = randomUUID()
  await api('channel.create', {
    id: talabat,
    name: 'Talabat',
    kind: 'delivery_app',
    feePercent: '20',
  })
  for (const [name, price] of [
    ['Spanish Latte', '18'],
    ['Croissant', '9'],
  ] as const) {
    await api('product.create', {
      id: randomUUID(),
      name,
      type: 'product',
      unit: 'piece',
      defaultPrice: price,
    })
  }
  today = (
    await ok(
      callApi<{ today: string }>(owner, 'books.get', {}, { businessId, query: true }),
      'books',
    )
  ).today
  yesterday = dayBefore(today)

  // Sales → Imports: nothing imported yet, and the templates.
  await owner.goto(`/b/${businessId}/sales?view=imports`)
  await expect(owner.getByRole('heading', { name: 'No imports yet' })).toBeVisible()
  await expect(owner.locator('[data-template=daily]').first()).toBeVisible()
  await expectSound(owner, 'en')
  await shot(owner, 'import-en-desktop-1-imports-empty')

  // 1. The file, the channel and the branch.
  await owner.locator('[data-import-start]').first().click()
  await expect(owner).toHaveURL(new RegExp(`/b/${businessId}/sales/import$`))
  await expect(owner.getByRole('heading', { name: 'Import sales from a file' })).toBeVisible()
  const day = csv('pos-main-day.csv', [
    'Item sales summary,,',
    'Item,Items sold,Gross sales',
    'Spanish Latte L,120,"2,268.00"',
    'Croissant,25,236.25',
    'Total,145,"2,504.25"',
  ])
  await pick(owner, day)
  await expect(owner.locator('[data-file-name]')).toHaveText('pos-main-day.csv')
  await expect(owner.locator('[data-field=channel]')).toHaveValue(/.+/)
  await expect(owner.locator('[data-field=branch]')).toBeVisible()
  await expect(owner.getByText('The file stays on this device.')).toBeVisible()
  await shot(owner, 'import-en-desktop-2-file')

  // 2. The columns, found from their names.
  await owner.locator('[data-next]').click()
  await expect(owner.getByRole('heading', { name: 'The columns' })).toBeVisible()
  await expect(owner.locator('[data-read-summary]')).toContainText('2')
  await expect(owner.getByRole('radio', { name: 'What the customer paid' })).toBeChecked()
  await expect(owner.getByText('1 total row was skipped, so nothing counts twice.')).toBeVisible()
  await expectSound(owner, 'en')
  await shot(owner, 'import-en-desktop-3-columns')

  // 3. These sales are for one day (yesterday). 4. Do these amounts include VAT? Yes.
  await owner.locator('[data-next]').click()
  await expect(owner.getByRole('radio', { name: 'One day' })).toBeChecked()
  await owner.locator('[data-field=day]').fill(yesterday)
  await owner.locator('[data-next]').click()
  await expect(owner.getByText('Do these amounts include VAT?')).toBeVisible()
  await expect(owner.locator('[data-send]')).toBeDisabled()
  await owner.getByRole('radio', { name: 'Yes, they include VAT' }).check()
  await expect(owner.locator('[data-send]')).toBeEnabled()
  await shot(owner, 'import-en-desktop-4-vat')
  await owner.locator('[data-send]').click()

  // 5. The names: "Spanish Latte L" blocks Finalize until it is settled.
  await expect(owner).toHaveURL(new RegExp(`/b/${businessId}/sales/import/[0-9a-f-]{36}$`))
  const importUrl = owner.url()
  const latteL = owner.locator('[data-import-name="Spanish Latte L"]')
  await expect(latteL).toContainText('Not settled')
  await expect(owner.locator('[data-import-name="Croissant"]')).toHaveCount(0)
  await expect(owner.locator('[data-finalize]')).toBeDisabled()
  await expect(owner.getByText('Settle 1 name first, then finalize.')).toBeVisible()
  await expect(owner.locator('[data-figure=sales-before-vat]')).toContainText('—')
  await expectSound(owner, 'en')
  await shot(owner, 'import-en-desktop-5-names')
  await latteL.locator('[data-suggestion="Spanish Latte"]').click()
  await expect(owner.getByText('Every name is settled.')).toBeVisible()

  // 6. The preview, then Finalize.
  await expect(owner.locator('[data-figure=sales-before-vat]')).toContainText(
    money('en', '2,385.00'),
  )
  await expect(owner.locator('[data-finalize]')).toBeEnabled()
  await shot(owner, 'import-en-desktop-6-preview')
  await owner.locator('[data-finalize]').click()
  const dialog = owner.getByRole('alertdialog')
  await expect(dialog).toContainText(
    /This adds 1 day of \W?Shop\W? sales: AED\s2,385\.00 before VAT/,
  )
  await shot(owner, 'import-en-desktop-7-confirm')
  await dialog.getByRole('button', { name: 'Finalize' }).click()
  await expect(owner.getByText('Imported', { exact: true }).first()).toBeVisible()
  await expect(owner.locator('[data-figure=sales-before-vat]')).toContainText(
    money('en', '2,385.00'),
  )
  await shot(owner, 'import-en-desktop-8-imported')

  // Its sale says where it came from.
  await owner.locator('[data-import-day] a').first().click()
  await expect(owner.getByText('Imported from a file')).toBeVisible()
  await expect(owner.getByRole('link', { name: 'Open its import' })).toBeVisible()
  await expect(owner.getByRole('button', { name: 'Reverse' })).toHaveCount(0)
  await shot(owner, 'import-en-desktop-9-sale')

  // The same file again is refused.
  await owner.goto(`/b/${businessId}/sales/import`)
  await pick(owner, day)
  await owner.locator('[data-next]').click()
  await owner.locator('[data-next]').click()
  await owner.locator('[data-field=day]').fill(yesterday)
  await owner.locator('[data-next]').click()
  await owner.getByRole('radio', { name: 'Yes, they include VAT' }).check()
  await owner.locator('[data-send]').click()
  await expect(owner.getByText(/This file was already imported on/)).toBeVisible()
  await expect(owner.getByRole('link', { name: 'Open that import' })).toHaveAttribute(
    'href',
    new URL(importUrl).pathname,
  )
  await shot(owner, 'import-en-desktop-10-refused')

  // The Imports list.
  await owner.goto(`/b/${businessId}/sales?view=imports`)
  await expect(owner.locator('[data-import-row=posted]')).toHaveCount(1)
  await expect(owner.locator('[data-import-row=posted]')).toContainText('pos-main-day.csv')
  await shot(owner, 'import-en-desktop-11-list')
})

test('the second branch’s file in Arabic on a phone, tips not sold, and Talabat’s statement', async ({
  browser,
}) => {
  await setLanguage(owner, 'ar')
  await owner.setViewportSize(PHONE)
  await owner.goto(`/b/${businessId}/sales/import`)
  await expect(owner.getByRole('heading', { name: 'استيراد المبيعات من ملف' })).toBeVisible()
  const file = csv('pos-marina.csv', [
    'التاريخ,الصنف,الكمية,صافي المبيعات',
    `${dmy(yesterday)},Spanish Latte,${arabic('40')},${arabic('720.00')}`,
    `${dmy(yesterday)},Croissant,${arabic('20')},${arabic('180.00')}`,
    `${dmy(yesterday)},بقشيش,${arabic('1')},${arabic('25.00')}`,
  ])
  await pick(owner, file)
  await expect(owner.locator('[data-file-name]')).toHaveText('pos-marina.csv')
  await owner.locator('[data-field=branch]').selectOption({ label: 'Marina' })
  await expectSound(owner, 'ar')
  await shot(owner, 'import-ar-phone-1-file')
  await owner.locator('[data-next]').click()
  await expect(owner.getByRole('radio', { name: 'المبيعات قبل الضريبة' })).toBeChecked()
  // A day column: no "These sales are for", and a column before VAT: no VAT question.
  await expect(owner.locator('[data-send]')).toBeEnabled()
  await expectSound(owner, 'ar')
  await shot(owner, 'import-ar-phone-2-columns')
  await owner.locator('[data-send]').click()

  // Tips are unmatched until marked "not something I sell".
  await expect(owner).toHaveURL(new RegExp(`/b/${businessId}/sales/import/[0-9a-f-]{36}$`))
  const tips = owner.locator('[data-import-name="بقشيش"]')
  await expect(tips).toContainText('بلا تحديد')
  // It looks like a tip: offered first, never applied unasked (D-261).
  await expect(tips.locator('[data-looks-like=skip]')).toContainText('لا يُحسب')
  await expect(owner.locator('[data-finalize]')).toBeDisabled()
  await expect(owner.getByText('حدّد اسمًا واحدًا أولًا، ثم اعتمد نهائيًا.')).toBeVisible()
  await expectSound(owner, 'ar')
  await shot(owner, 'import-ar-phone-3-names')
  await tips.locator('[data-not-sold]').click()
  await tips.locator('[data-treatment=skip]').click()
  await expect(owner.getByText('حُدّد كل اسم.')).toBeVisible()
  await expect(owner.locator('[data-figure=sales-before-vat]')).toContainText(money('ar', '900.00'))
  await shot(owner, 'import-ar-phone-4-preview')
  await owner.locator('[data-finalize]').click()
  await owner.getByRole('alertdialog').getByRole('button', { name: 'اعتمد نهائيًا' }).click()
  await expect(owner.getByText('مستورد', { exact: true }).first()).toBeVisible()
  await expectSound(owner, 'ar')
  await shot(owner, 'import-ar-phone-5-imported')

  // Talabat's statement, read from the statement template in Arabic, then finalized.
  await owner.goto(`/b/${businessId}/settings/channels`)
  await owner.locator('[data-channel="Talabat"] [data-channel-statements]').click()
  await expect(owner).toHaveURL(new RegExp(`/settings/channels/${talabat}$`))
  await expect(owner.getByRole('heading', { name: /كشوف/ })).toBeVisible()
  const from = dayBefore(yesterday, 6)
  await owner
    .locator('input[type=file]')
    .setInputFiles(
      csv('talabat-statement.csv', [
        'من,إلى,المبيعات,العمولة,رسوم الدفع',
        `${dmy(from)},${dmy(yesterday)},"${arabic('1,000.00')}",${arabic('180.00')},${arabic('0')}`,
      ]),
    )
  await expect(owner.getByText('أُضيف كشف واحد مسودة. راجعه، ثم اعتمده نهائيًا.')).toBeVisible()
  await expect(owner.locator('[data-statement=draft] [data-statement-fees]')).toContainText(
    money('ar', '180.00'),
  )
  await shot(owner, 'import-ar-phone-6-statement-draft')
  await owner.locator('[data-statement=draft] [data-statement-post]').click()
  await owner.getByRole('alertdialog').getByRole('button', { name: 'اعتمد نهائيًا' }).click()
  await expect(owner.locator('[data-statement=posted]')).toHaveCount(1)
  await expectSound(owner, 'ar')
  await shot(owner, 'import-ar-phone-7-statement-final')
  void browser
})

test('the import, its list and the statements in English on a phone and Arabic on a desktop', async () => {
  for (const [locale, viewport, size] of [
    ['en', PHONE, 'phone'],
    ['ar', DESKTOP, 'desktop'],
  ] as const) {
    await setLanguage(owner, locale)
    await owner.setViewportSize(viewport)
    await owner.goto(`/b/${businessId}/sales?view=imports`)
    await expect(owner.locator('[data-import-row=posted]')).toHaveCount(2)
    await expectSound(owner, locale)
    await shot(owner, `import-${locale}-${size}-list`)
    await owner.locator('[data-import-row=posted]').first().click()
    await expect(owner.locator('[data-import-day]')).toHaveCount(1)
    await expectSound(owner, locale)
    await shot(owner, `import-${locale}-${size}-imported`)
    await owner.goto(`/b/${businessId}/sales/import`)
    await pick(
      owner,
      csv(`more-${locale}.csv`, ['Date,Item,Qty,Total', `${dmy(today)},Croissant,2,18.90`]),
    )
    await owner.locator('[data-next]').click()
    await expectSound(owner, locale)
    await shot(owner, `import-${locale}-${size}-columns`)
    await owner.goto(`/b/${businessId}/settings/channels/${talabat}`)
    await expect(owner.locator('[data-statement=posted]')).toHaveCount(1)
    await expectSound(owner, locale)
    await shot(owner, `import-${locale}-${size}-statements`)
  }
})

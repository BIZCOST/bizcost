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
  pngImage,
  setLanguage,
  signIn,
  useLanguage,
  withValue,
  type TestUser,
} from '../helpers'
import { previewBaseURL } from '../stack'

// Expenses and Running Costs (M2 Step 5; D-116, D-164–D-169), on the development server with the
// dev-only preview (D-125, D-127):
//   - a home baker (solo, no VAT) answers "What do you pay to run your business?" with rent and
//     electricity from the quick picks: each in its own frequency, what they make a month and the
//     monthly total; a change not saved is asked about (English, desktop; Arabic, phone);
//   - a café (VAT-registered, with a team) records an expense an employee paid from their own money,
//     with its receipt, before VAT; it shows under that employee in Amounts owed and is paid back
//     from there; the expense says it is paid in full (English, desktop; Arabic, phone). The
//     employee, whose role hides supplier prices, sees it with its amount in "My expenses", what is
//     owed to them and then paid back in "Owed to me" (the owner's answers of 2026-09-29, D-181;
//     Arabic, phone and desktop);
//   - a workshop with approval on: the employee (the template, D-180) enters an expense and sends it
//     for approval (Arabic, a 375 px phone: the total stays whole next to "Send for approval"), and
//     still sees its amount (their own); the manager sees it waiting, approves it, then finalizes it
//     (English, desktop); a second is rejected, the manager stays on it, with "Edit" (D-175, D-177),
//     and it comes back to the employee's editor with its amount;
//   - approval off: the employee's draft waits for someone who may finalize it, and says so.
// With E2E_SHOTS_DIR set, each step leaves a screenshot there (AR/EN at 375, 390 and 1440 px).

test.describe.configure({ mode: 'serial' })

const PHONE = { width: 390, height: 844 }
/** The narrowest phone the screens are checked at. */
const SMALL_PHONE = { width: 375, height: 812 }
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

/** A workshop with a team, not VAT-registered, one location. */
const WORKSHOP_ANSWERS = {
  what_you_do: ['make_products'],
  how_you_make: ['custom_jobs'],
  workplace: 'workshop',
  branches: false,
  team: 'team',
  team_tracking: ['hours'],
  work_setup: ['stock'],
  sales_channels: ['messages'],
  vat: 'no',
}

const RAW_KEY =
  /\b(?:common|catalog|units|errors|nav|modules|purchasing|expenses|settings|setup)\.[a-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+/

const users: TestUser[] = []
const contexts: BrowserContext[] = []

test.afterAll(async () => {
  for (const context of contexts) await context.close()
  for (const user of users) await deleteUser(user.id)
})

/** A new context for `user` (signed in, named `displayName`), in `locale` at `viewport`. */
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

/** A new user, signed in in a new context. */
async function open(
  browser: Browser,
  viewport: { width: number; height: number },
  locale: 'en' | 'ar',
  displayName: string,
): Promise<{ page: Page; user: TestUser }> {
  const user = await createUser(`expenses-${locale}`, { locale: 'en' })
  users.push(user)
  return { page: await openAs(browser, user, viewport, locale, displayName), user }
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

/**
 * The total in the expense editor's action bar is shown whole, never cut by its buttons (a long
 * "Send for approval" on a 375 px phone, D-177).
 */
async function expectWholeTotal(page: Page, amount: string) {
  const total = page.locator('[data-expense-total]')
  await expect(total).toContainText(amount)
  const cut = await total.evaluate((element) => {
    const box = element.getBoundingClientRect()
    return (
      element.scrollWidth > element.clientWidth + 1 || box.left < 0 || box.right > window.innerWidth
    )
  })
  expect(cut).toBe(false)
  // Nothing in the bar is outside the screen either.
  const outside = await page.locator('[data-expense-actions] button').evaluateAll((buttons) =>
    buttons.some((button) => {
      const box = button.getBoundingClientRect()
      return box.left < 0 || box.right > window.innerWidth
    }),
  )
  expect(outside).toBe(false)
}

/** Invites `user` into the business with the role of `templateKey`; they accept it. */
async function joinBusiness(
  owner: Page,
  businessId: string,
  member: Page,
  user: TestUser,
  templateKey: string,
) {
  const roles = await callApi<{ id: string; templateKey: string | null }[]>(
    owner,
    'role.list',
    {},
    { businessId, query: true },
  )
  const role = roles.data?.find((r) => r.templateKey === templateKey)
  expect(role).toBeDefined()
  const invited = await callApi(
    owner,
    'invitation.create',
    { id: randomUUID(), email: user.email, roleId: role!.id, locale: 'en' },
    { businessId },
  )
  expect(invited.appCode).toBeUndefined()
  const { token } = await nextInvitation(user.email)
  const accepted = await callApi<{ businessId: string }>(member, 'invitation.accept', { token })
  expect(accepted.data?.businessId).toBe(businessId)
}

/** The option a select shows as chosen. */
function chosen(page: Page, name: string) {
  return page.getByRole('combobox', { name, exact: true }).locator('option:checked')
}

test('a home baker: rent and electricity as running costs (English desktop, Arabic phone)', async ({
  browser,
}) => {
  test.setTimeout(600_000)
  const { page } = await open(browser, DESKTOP, 'en', 'Mona')
  const businessId = await createBusiness(page, 'Mona Bakes', BAKER_ANSWERS)
  const unsaved = page.getByRole('alertdialog', { name: 'You have unsaved changes' })

  // Running Costs is in the navigation, with Expenses.
  await page.goto(`/b/${businessId}`)
  const nav = page.getByRole('navigation', { name: 'Main' })
  await expect(nav.getByRole('link', { name: 'Expenses' })).toBeVisible()
  await nav.getByRole('link', { name: 'Running Costs' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Running Costs')
  await expect(page.getByText('What do you pay to run your business?')).toBeVisible()
  // The first time: the question, the owner's categories to pick from, no list tools.
  await expect(page.getByRole('heading', { name: 'No running costs yet' })).toBeVisible()
  const picks = page.getByRole('list', { name: 'Add what you pay' })
  await expect(picks.getByRole('button')).toHaveText([
    'Rent',
    'Electricity',
    'Water',
    'Salaries',
    'Internet',
    'Phone',
    'Licences',
    'Insurance',
    'Software subscriptions',
    'Vehicle costs',
    'Marketing',
    'Equipment costs',
    'Maintenance',
    'Other',
    'Something else',
  ])
  await expect(page.locator('[data-monthly-total]')).toHaveCount(0)
  await expectSound(page, 'en')
  await shot(page, 'en-1440-running-costs-empty')

  // Rent: AED 1,500 every month (the pick names it and picks its category).
  await picks.getByRole('button', { name: 'Rent', exact: true }).click()
  const sheet = page.getByRole('dialog', { name: 'New running cost' })
  await expect(sheet.getByRole('textbox', { name: 'What is it?' })).toHaveValue('Rent')
  // The name and category are filled in: the amount is what is left to type.
  await expect(sheet.getByRole('textbox', { name: 'How much' })).toBeFocused()
  await expect(
    sheet.getByRole('combobox', { name: 'Category' }).locator('option:checked'),
  ).toHaveText('Rent')
  await expect(
    sheet.getByRole('combobox', { name: 'How often' }).locator('option:checked'),
  ).toHaveText('Every month')
  await sheet.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(sheet.getByText('Enter a number.')).toBeVisible()
  await sheet.getByRole('textbox', { name: 'How much' }).fill('1500')
  await shot(page, 'en-1440-running-cost-sheet')
  await sheet.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.getByText(withValue('', 'Rent', ' added.'))).toBeVisible()
  await expect(sheet).toHaveCount(0)
  const rent = page.locator('[data-running-cost="Rent"]')
  await expect(rent).toContainText('AED 1,500.00 a month')
  await expect(rent).toContainText('Since ')

  // Electricity: AED 900 every 3 months, AED 300 a month as it is typed.
  await picks.getByRole('button', { name: 'Electricity', exact: true }).click()
  await sheet.getByRole('textbox', { name: 'How much' }).fill('900')
  await sheet.getByRole('combobox', { name: 'How often' }).selectOption('quarterly')
  await expect(sheet.locator('[data-monthly-amount]')).toHaveText("That's AED 300.00 a month.")
  await shot(page, 'en-1440-running-cost-quarterly')
  await sheet.getByRole('button', { name: 'Add', exact: true }).click()
  const electricity = page.locator('[data-running-cost="Electricity"]')
  await expect(electricity).toContainText('AED 900.00 every 3 months')
  await expect(electricity.locator('[data-monthly]')).toHaveText('AED 300.00 a month')
  // What they come to a month: 1,500 + 300.
  await expect(page.locator('[data-monthly-total]')).toContainText('AED 1,800.00')
  await expectSound(page, 'en')
  await shot(page, 'en-1440-running-costs')

  // A change not saved is asked about: Keep editing keeps it, Don't save drops it.
  await rent.click()
  const editing = page.getByRole('dialog', { name: 'Rent' })
  await editing.getByRole('textbox', { name: 'How much' }).fill('1600')
  await page.keyboard.press('Escape')
  await expect(unsaved).toBeVisible()
  await unsaved.getByRole('button', { name: 'Keep editing' }).click()
  await expect(editing.getByRole('textbox', { name: 'How much' })).toHaveValue('1600')
  await editing.getByRole('button', { name: 'Close' }).click()
  await unsaved.getByRole('button', { name: "Don't save" }).click()
  await expect(editing).toHaveCount(0)
  await expect(rent).toContainText('AED 1,500.00 a month')

  // Categories: one list with Expenses; a new one joins the picks before "Other", an archived one
  // leaves them.
  await page.getByRole('button', { name: 'Categories' }).click()
  const categories = page.getByRole('dialog', { name: 'Categories' })
  await categories.getByRole('textbox', { name: 'New category' }).fill('Packaging')
  await categories.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.getByText(withValue('', 'Packaging', ' added.'))).toBeVisible()
  await categories.getByRole('textbox', { name: 'New category' }).fill('rent')
  await categories.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(
    categories.getByText(withValue("There's already a category called ", 'Rent', '.')),
  ).toBeVisible()
  await categories.getByRole('textbox', { name: 'New category' }).fill('')
  await categories.getByRole('button', { name: withValue('Archive ', 'Vehicle costs') }).click()
  await expect(page.getByText(withValue('', 'Vehicle costs', ' archived.'))).toBeVisible()
  await expect(categories.locator('[data-category="Vehicle costs"]')).toContainText('Archived')
  await expectSound(page, 'en')
  await shot(page, 'en-1440-categories')
  await categories.getByRole('button', { name: 'Close' }).first().click()
  await expect(categories).toHaveCount(0)
  await expect(picks.getByRole('button', { name: 'Vehicle costs' })).toHaveCount(0)
  await expect(picks.getByRole('button').nth(-3)).toHaveText('Packaging')

  // The API holds the same monthly total.
  const listed = await callApi<{ data: { monthlyTotal: string } }>(
    page,
    'runningCost.list',
    {},
    { businessId, query: true },
  )
  expect(listed.data?.data.monthlyTotal).toBe('1800')

  // In Arabic on a phone: the same, and one more from "Something else" (weekly).
  await setLanguage(page, 'ar')
  await page.setViewportSize(PHONE)
  await page.goto(`/b/${businessId}/running-costs`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('المصاريف التشغيلية')
  await expect(page.getByText('ماذا تدفع لتشغيل عملك؟')).toBeVisible()
  await expect(page.locator('[data-monthly-total]')).toContainText('1,800.00')
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-running-costs')
  await page
    .getByRole('list', { name: 'أضف ما تدفعه' })
    .getByRole('button', { name: 'شيء آخر' })
    .click()
  const arSheet = page.getByRole('dialog', { name: 'مصروف تشغيلي جديد' })
  await arSheet.getByRole('textbox', { name: 'ما هو؟' }).fill('غاز الفرن')
  // The business's categories are named in its language (English here, D-113).
  await arSheet.getByRole('combobox', { name: 'الفئة' }).selectOption({ label: 'Equipment costs' })
  await arSheet.getByRole('textbox', { name: 'كم تدفع' }).fill('٦٠')
  await arSheet.getByRole('combobox', { name: 'كل متى' }).selectOption('weekly')
  // 60 a week × 52 ÷ 12 = 260 a month.
  await expect(arSheet.locator('[data-monthly-amount]')).toContainText('260.00')
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-running-cost-sheet')
  await arSheet.getByRole('button', { name: 'أضف', exact: true }).click()
  await expect(arSheet).toHaveCount(0)
  await expect(page.locator('[data-running-cost="غاز الفرن"]')).toContainText('في الأسبوع')
  await expect(page.locator('[data-monthly-total]')).toContainText('2,060.00')
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-running-costs-three')
  await page.setViewportSize(DESKTOP)
  await expectSound(page, 'ar')
  await shot(page, 'ar-1440-running-costs')

  // A solo business has no approval, and its Expenses page says how costs count (D-116).
  await page.goto(`/b/${businessId}/expenses`)
  await expect(page.locator('[data-costs-note]')).toHaveText(
    'تكاليف منتجاتك تُحسب من مصاريفك التشغيلية المنتظمة، أما المصروفات هنا فتُحسب في ربحك الحقيقي.',
  )
  await expect(page.getByRole('heading', { name: 'لا توجد مصروفات بعد' })).toBeVisible()
  await expectSound(page, 'ar')
  await shot(page, 'ar-1440-expenses-empty')
  await setLanguage(page, 'en')
  await page.setViewportSize(PHONE)
  await page.goto(`/b/${businessId}/running-costs`)
  await expect(page.locator('[data-monthly-total]')).toContainText('AED 2,060.00')
  await expectSound(page, 'en')
  await shot(page, 'en-390-running-costs')
  await page.locator('[data-running-cost="Electricity"]').click()
  await expect(page.getByRole('dialog', { name: 'Electricity' })).toBeVisible()
  await expectSound(page, 'en')
  await shot(page, 'en-390-running-cost-sheet')
})

test('a café: an expense an employee paid, owed to them, then paid back (English desktop, Arabic phone)', async ({
  browser,
}) => {
  test.setTimeout(900_000)
  const { page } = await open(browser, DESKTOP, 'en', 'Salma')
  const businessId = await createBusiness(page, 'Palm Café', CAFE_ANSWERS)
  const khalidUser = await createUser('expenses-employee', { locale: 'en' })
  users.push(khalidUser)
  const khalid = await openAs(browser, khalidUser, PHONE, 'ar', 'Khalid')
  await joinBusiness(page, businessId, khalid, khalidUser, 'employee')

  // The Expenses page, its line about costs, and a new expense.
  await page.goto(`/b/${businessId}/expenses`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Expenses')
  await expect(page.locator('[data-costs-note]')).toHaveText(
    'Product costs use your running costs; the expenses here count in your real profit.',
  )
  await page.getByRole('link', { name: 'New expense' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('New expense')
  // A tax invoice of a VAT-registered business: the amount before VAT, 5% VAT.
  const vatMode = page.getByRole('group', { name: 'VAT in the amount' })
  await expect(vatMode.getByRole('radio', { name: 'Amount before VAT' })).toBeChecked()
  await page.getByRole('button', { name: 'Save draft' }).click()
  await expect(page.getByText('Choose a category.')).toBeVisible()
  await expect(page.getByText('Choose how it was paid.')).toBeVisible()
  await page.getByRole('textbox', { name: 'Amount before VAT' }).fill('40')
  await expect(page.locator('[data-total="vat"]')).toContainText('AED 2.00')
  await expect(page.locator('[data-total="total"]')).toContainText('AED 42.00')
  await page
    .getByRole('combobox', { name: 'Category', exact: true })
    .selectOption({ label: 'Maintenance' })
  await page
    .getByRole('combobox', { name: 'How it was paid' })
    .selectOption({ label: 'Paid by an employee from their own money' })
  await expect(chosen(page, 'Who paid')).toHaveText('Salma (you)')
  await page.getByRole('combobox', { name: 'Who paid' }).selectOption({ label: 'Khalid' })
  await page.getByRole('textbox', { name: 'What it was for' }).fill('Fixing the coffee grinder')
  // A photo of the receipt, attached once it is saved.
  await page.locator('[data-receipt-input]').setInputFiles({
    name: 'grinder-receipt.png',
    mimeType: 'image/png',
    buffer: pngImage(64),
  })
  await expect(page.getByText('grinder-receipt.png')).toBeVisible()
  await expect(
    page.getByText("The business owes it to them: it shows in Amounts owed until it's paid back."),
  ).toBeVisible()
  await expectSound(page, 'en')
  await shot(page, 'en-1440-expense-editor')
  await page.getByRole('button', { name: 'Finalize' }).click()
  const finalize = page.getByRole('alertdialog', { name: 'Finalize this expense?' })
  // (Amounts are written with a no-break space after the currency.)
  await expect(finalize).toContainText('AED 42.00')
  await expect(finalize).toContainText(withValue(' for ', 'Maintenance'))
  await finalize.getByRole('button', { name: 'Finalize' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Expense of /)
  await expect(page.locator('[data-status="posted"]').first()).toHaveText('Final')
  const expenseUrl = page.url()
  const expenseId = expenseUrl.split('/').at(-1)!
  await expect(page.getByRole('link', { name: 'grinder-receipt.png' })).toBeVisible()
  await expect(
    page.getByText(withValue('Paid by ', 'Khalid', ' from their own money: owed to them.')),
  ).toBeVisible()
  // A tax invoice: the VAT is reclaimed, so it cost the business 40.
  await expect(page.getByText('What it cost the business:')).toContainText('AED 40.00')
  await expectSound(page, 'en')
  await shot(page, 'en-1440-expense-view')

  // Khalid (the Employee template: no supplier prices), Arabic, phone: his own expenses open first,
  // with their amounts, and what the business owes him (D-181).
  await khalid.goto(`/b/${businessId}/expenses`)
  await expect(khalid.getByRole('tab', { name: 'مصروفاتي' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  const mine = khalid.locator(`[data-mine-expense="${expenseId}"]`)
  await expect(mine).toContainText('Fixing the coffee grinder')
  await expect(mine).toContainText('42.00')
  await expect(mine).toContainText('من مالك الخاص')
  await expect(mine.locator('[data-settlement="owed"]')).toContainText('مستحق لك')
  await expect(khalid.locator('[data-owed-to-me-card]')).toContainText('42.00')
  await expect(khalid.locator('[data-locked]')).toHaveCount(0)
  await expectSound(khalid, 'ar')
  await shot(khalid, 'ar-390-my-expenses-owed')
  // Everyone's expenses still hide the amounts (supplier prices).
  await khalid.getByRole('tab', { name: 'كل المصروفات' }).click()
  await expect(
    khalid.locator(`[data-expense="${expenseId}"] [data-locked="supplier_price"]`),
  ).toHaveCount(1)
  // …and say where his own show theirs (D-184).
  await expect(khalid.locator('[data-own-amounts]')).toHaveText('تظهر مبالغ مصروفاتك في مصروفاتي.')
  // His expense itself shows its amounts, and leads to what is owed to him.
  await khalid.goto(`/b/${businessId}/expenses/${expenseId}`)
  await expect(khalid.locator('[data-total="total"]')).toContainText('42.00')
  // Only the receipt's file stays locked (its name shows, D-139); no amount is.
  await expect(khalid.locator('[data-locked]')).toHaveCount(1)
  await expect(khalid.getByText('grinder-receipt.png')).toBeVisible()
  await expect(khalid.getByText('دُفع هذا المصروف من مالك الخاص.')).toBeVisible()
  await expectSound(khalid, 'ar')
  await shot(khalid, 'ar-390-my-expense')
  await khalid.getByRole('link', { name: 'اعرض المستحق لك' }).click()
  await expect(khalid).toHaveURL(/\/payables\?to=me$/)
  await expect(khalid.getByRole('heading', { level: 1 })).toHaveText('المستحقات')
  // Only what is owed to him: no tabs of what is owed to others.
  await expect(khalid.getByRole('tab')).toHaveCount(0)
  await expect(khalid.locator('[data-owed-to-me-total]')).toContainText('42.00')
  const owedRow = khalid.locator(`[data-owed-item="${expenseId}"]`)
  await expect(owedRow.locator('[data-amount="outstanding"]')).toContainText('42.00')
  await expectSound(khalid, 'ar')
  await shot(khalid, 'ar-390-owed-to-me')

  // Amounts owed: to Khalid, the expense, with who entered it.
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Amounts owed' })
    .click()
  await page.getByRole('tab', { name: 'To employees' }).click()
  const owedToKhalid = page.locator('[data-payable-group]').filter({ hasText: 'Khalid' })
  await expect(owedToKhalid.locator('[data-invoice]')).toHaveCount(1)
  await expect(owedToKhalid.locator('[data-invoice]')).toContainText(/Expense of /)
  await expect(owedToKhalid.locator('[data-invoice]')).toContainText('Maintenance')
  await expect(owedToKhalid.locator('[data-invoice]')).toContainText('Fixing the coffee grinder')
  await expect(owedToKhalid.locator('[data-amount="outstanding"]')).toContainText('AED 42.00')
  await expect(owedToKhalid).toContainText(withValue('Entered by ', 'Salma'))
  await expect(owedToKhalid).toContainText('1 bill')
  await expectSound(page, 'en')
  await shot(page, 'en-1440-payables-expense')

  // Paid back in part first (20.00 of 42.00), in cash, from there.
  await owedToKhalid.getByRole('button', { name: 'Record a payment' }).click()
  const pay = page.getByRole('dialog', { name: 'Record a payment' })
  await expect(pay).toContainText(withValue('What you paid ', 'Khalid', ' back for this expense.'))
  await expect(pay.getByRole('textbox', { name: 'Amount' })).toHaveValue('42.00')
  await pay.getByRole('textbox', { name: 'Amount' }).fill('20')
  await pay.getByRole('combobox', { name: 'How you paid' }).selectOption({ label: 'Cash' })
  await shot(page, 'en-1440-expense-payment-sheet')
  await pay.getByRole('button', { name: 'Record payment' }).click()
  await expect(page.getByText('Payment recorded.')).toBeVisible()
  await expect(pay).toHaveCount(0)
  await expect(owedToKhalid.locator('[data-amount="outstanding"]')).toContainText('AED 22.00')

  // Khalid on a 375 px phone: partly paid back. The row keeps what it was for readable, with what
  // is still owed and what was paid back on a line of its own (D-184).
  await khalid.setViewportSize(SMALL_PHONE)
  await khalid.goto(`/b/${businessId}/expenses`)
  const partly = mine.locator('[data-settlement="owed"]')
  await expect(partly).toContainText('مستحق لك')
  await expect(partly).toContainText('سُدّد لك')
  await expect(partly).toContainText('20.00')
  await expect(partly).toContainText('42.00')
  const [title, settlement] = await Promise.all([
    mine.getByText('Fixing the coffee grinder').boundingBox(),
    partly.boundingBox(),
  ])
  expect(title?.width ?? 0).toBeGreaterThan(150)
  expect(settlement?.y ?? 0).toBeGreaterThanOrEqual((title?.y ?? 0) + (title?.height ?? 0))
  expect(
    await khalid.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true)
  await expectSound(khalid, 'ar')
  await shot(khalid, 'ar-375-my-expenses-partly-paid')
  await khalid.setViewportSize(PHONE)

  // Then the rest (22.00).
  await owedToKhalid.getByRole('button', { name: 'Record a payment' }).click()
  await expect(pay.getByRole('textbox', { name: 'Amount' })).toHaveValue('22.00')
  await pay.getByRole('combobox', { name: 'How you paid' }).selectOption({ label: 'Cash' })
  await pay.getByRole('button', { name: 'Record payment' }).click()
  await expect(pay).toHaveCount(0)
  await expect(
    page.getByRole('heading', { level: 2, name: 'Nothing owed to employees' }),
  ).toBeVisible()

  // Khalid sees it paid back: when and how much (each payment), and nothing owed.
  await khalid.goto(`/b/${businessId}/payables?to=me`)
  await expect(owedRow.locator('[data-amount="outstanding"]')).toContainText('سُدّد لك بالكامل')
  await expect(owedRow.locator('[data-paid-back]')).toHaveCount(2)
  await expect(owedRow.locator('[data-paid-back]').first()).toContainText('22.00')
  await expect(owedRow.locator('[data-paid-back]').last()).toContainText('20.00')
  await expect(owedRow.locator('[data-amount="paid"]')).toContainText('42.00')
  await expect(khalid.locator('[data-owed-to-me-total]')).toContainText('0.00')
  await expectSound(khalid, 'ar')
  await shot(khalid, 'ar-390-owed-to-me-paid')
  await khalid.setViewportSize(DESKTOP)
  await expectSound(khalid, 'ar')
  await shot(khalid, 'ar-1440-owed-to-me-paid')
  await khalid.goto(`/b/${businessId}/expenses`)
  await expect(mine.locator('[data-settlement="settled"]')).toHaveText('سُدّد لك')
  await expectSound(khalid, 'ar')
  await shot(khalid, 'ar-1440-my-expenses')
  // The Amounts owed entry is his too now (the business owed him).
  await expect(
    khalid
      .getByRole('navigation', { name: 'القائمة الرئيسية' })
      .getByRole('link', { name: 'المستحقات' }),
  ).toBeVisible()

  // The expense: paid in full; it can't be reversed while the payment stands.
  await page.goto(expenseUrl)
  await expect(page.locator('[data-paid-in-full]')).toHaveText('Paid in full.')
  await expect(page.getByText('To reverse this expense, reverse its payments first.')).toBeVisible()
  expect((await callApi(page, 'expense.reverse', { id: expenseId }, { businessId })).appCode).toBe(
    'expense_has_payments',
  )

  // On a phone.
  await page.setViewportSize(PHONE)
  await expectSound(page, 'en')
  await shot(page, 'en-390-expense-view')
  await page.goto(`/b/${businessId}/payables?to=employees`)
  await expectSound(page, 'en')
  await shot(page, 'en-390-payables-empty')
  await page.setViewportSize(DESKTOP)

  // In the expenses list.
  await page.goto(`/b/${businessId}/expenses`)
  const row = page.locator(`[data-expense="${expenseId}"]`)
  await expect(row).toContainText('Fixing the coffee grinder')
  await expect(row).toContainText('Maintenance')
  await expect(row).toContainText('AED 42.00')
  await expectSound(page, 'en')
  await shot(page, 'en-1440-expenses')

  // Arabic, on a phone: the list, the expense and a new one (with VAT, from a new category).
  await setLanguage(page, 'ar')
  await page.setViewportSize(PHONE)
  await page.goto(`/b/${businessId}/expenses`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('المصروفات')
  await expect(row).toContainText('42.00')
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-expenses')
  await page.goto(expenseUrl)
  await expect(page.locator('[data-paid-in-full]')).toHaveText('سُدّد المبلغ بالكامل.')
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-expense-view')
  await page.goto(`/b/${businessId}/expenses/new`)
  await page
    .getByRole('group', { name: 'الضريبة في المبلغ' })
    .getByText('المبلغ شامل الضريبة')
    .click()
  await page.getByRole('textbox', { name: 'المبلغ شامل الضريبة' }).fill('١٠٥')
  await expect(page.locator('[data-total="net"]')).toContainText('100.00')
  await expect(page.locator('[data-total="vat"]')).toContainText('5.00')
  await page
    .getByRole('combobox', { name: 'الفئة', exact: true })
    .selectOption({ label: 'فئة جديدة…' })
  await page.getByRole('textbox', { name: 'اسم الفئة الجديدة' }).fill('التنظيف')
  await page.getByRole('button', { name: 'أضف', exact: true }).click()
  await expect(chosen(page, 'الفئة')).toHaveText('التنظيف')
  await page.getByRole('combobox', { name: 'طريقة الدفع' }).selectOption({ label: 'بطاقة' })
  // Leaving with changes asks first; "Keep editing" stays.
  await page.getByRole('link', { name: 'المصروفات' }).first().click()
  const unsaved = page.getByRole('alertdialog', { name: 'لديك تغييرات لم تُحفظ' })
  await expect(unsaved).toBeVisible()
  await shot(page, 'ar-390-expense-unsaved')
  await unsaved.getByRole('button', { name: 'متابعة التعديل' }).click()
  await expect(unsaved).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'المبلغ شامل الضريبة' })).toHaveValue(/105|١٠٥/)
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-expense-editor')
  await page.getByRole('button', { name: 'احفظ المسودة' }).click()
  await expect(page.getByText('حُفظت المسودة.')).toBeVisible()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('مسودة مصروف')
  await expect(page).toHaveURL(new RegExp(`/b/${businessId}/expenses/[0-9a-f-]{36}$`))
  await page.setViewportSize(DESKTOP)
  await expectSound(page, 'ar')
  await shot(page, 'ar-1440-expense-editor')
  await page.goto(`/b/${businessId}/payables?to=employees`)
  await expectSound(page, 'ar')
  await shot(page, 'ar-1440-payables-empty')
  await setLanguage(page, 'en')
})

test('approval on: the employee sends an expense, the manager approves and finalizes it', async ({
  browser,
}) => {
  test.setTimeout(900_000)
  const { page: owner } = await open(browser, DESKTOP, 'en', 'Huda')
  const businessId = await createBusiness(owner, 'Huda Woodworks', WORKSHOP_ANSWERS)

  // The owner turns approval on (Settings → Expense approval), and lets employees enter expenses.
  await owner.goto(`/b/${businessId}/settings/approval`)
  await expect(owner.getByRole('heading', { level: 1 })).toHaveText('Expense approval')
  const approval = owner.getByRole('switch', { name: 'Expenses need approval' })
  await expect(approval).not.toBeChecked()
  await expectSound(owner, 'en')
  await approval.click()
  await expect(owner.getByText('Expenses now need approval.')).toBeVisible()
  await expect(approval).toBeChecked()
  // The Employee template enters expenses without approving them (the owner's answer of 2026-09-29,
  // D-180): what is sent has someone to approve it, so nothing warns that nobody would send.
  await expect(owner.locator('[data-nobody-sends]')).toHaveCount(0)
  await shot(owner, 'en-1440-settings-approval')

  const employeeUser = await createUser('expenses-sender', { locale: 'en' })
  const managerUser = await createUser('expenses-approver', { locale: 'en' })
  users.push(employeeUser, managerUser)
  const employee = await openAs(browser, employeeUser, SMALL_PHONE, 'ar', 'Omar')
  const manager = await openAs(browser, managerUser, DESKTOP, 'en', 'Rania')
  await joinBusiness(owner, businessId, employee, employeeUser, 'employee')
  await joinBusiness(owner, businessId, manager, managerUser, 'manager')

  // The employee (Arabic, phone): enters an expense and sends it for approval (they may not
  // finalize it).
  await employee.goto(`/b/${businessId}/expenses/new`)
  await expect(employee.getByRole('heading', { level: 1 })).toHaveText('مصروف جديد')
  await expect(employee.getByRole('button', { name: 'اعتمد نهائيًا' })).toHaveCount(0)
  await expect(employee.getByText('أرسله للموافقة', { exact: false })).toBeVisible()
  await employee.getByRole('textbox', { name: 'المبلغ' }).fill('75')
  await employee
    .getByRole('combobox', { name: 'الفئة', exact: true })
    .selectOption({ label: 'Maintenance' })
  await employee.getByRole('combobox', { name: 'طريقة الدفع' }).selectOption({ label: 'نقدًا' })
  await employee.getByRole('textbox', { name: 'ما صُرف عليه' }).fill('قطع غيار للمنشار')
  await expectSound(employee, 'ar')
  await expect(employee.getByRole('button', { name: 'أرسل للموافقة' })).toBeVisible()
  await expectWholeTotal(employee, '75.00')
  await shot(employee, 'ar-375-expense-submit-editor')
  await employee.getByRole('button', { name: 'أرسل للموافقة' }).click()
  const send = employee.getByRole('alertdialog', { name: 'إرسال هذا المصروف للموافقة؟' })
  await expect(send).toBeVisible()
  await shot(employee, 'ar-375-expense-submit-confirm')
  await send.getByRole('button', { name: 'أرسل', exact: true }).click()
  await expect(employee.getByRole('heading', { level: 1 })).toHaveText(/^مصروف /)
  await expect(employee.locator('[data-status="submitted"]').first()).toHaveText('بانتظار الموافقة')
  // Their role hides supplier prices, but this one is their own: they see its amount (D-181).
  await expect(employee.locator('[data-locked]')).toHaveCount(0)
  await expect(employee.locator('[data-total="total"]')).toContainText('75.00')
  await expectSound(employee, 'ar')
  await shot(employee, 'ar-375-expense-submitted')
  const expenseId = employee.url().split('/').at(-1)!
  // They may not finalize it themselves.
  const sent = await callApi<{ data: { version: number } }>(
    employee,
    'expense.get',
    { id: expenseId },
    { businessId, query: true },
  )
  expect(
    (
      await callApi(
        employee,
        'expense.post',
        { id: expenseId, version: sent.data!.data.version },
        { businessId },
      )
    ).appCode,
  ).toBe('forbidden')

  // The manager (English, desktop): told that expenses wait for them (only that: they approve,
  // and may not change the setting), approves it, then finalizes it.
  await manager.goto(`/b/${businessId}/expenses`)
  await expect(manager.locator('[data-waiting]')).toHaveText(
    'Expenses are waiting for your approval.',
  )
  await expect(manager.getByText("Expenses need approval before they're final.")).toHaveCount(0)
  await expectSound(manager, 'en')
  await shot(manager, 'en-1440-expenses-waiting')
  await manager.getByRole('button', { name: 'Show them' }).click()
  await expect(manager).toHaveURL(/status=submitted/)
  const row = manager.locator(`[data-expense="${expenseId}"]`)
  await expect(row).toContainText('قطع غيار للمنشار')
  await expect(row).toContainText(withValue('by ', 'Omar'))
  await expect(row).toContainText('AED 75.00')
  await row.click()
  await expect(manager.getByText(/^Sent for approval on .* by .*Omar/)).toBeVisible()
  await expectSound(manager, 'en')
  await shot(manager, 'en-1440-expense-to-approve')
  await manager.getByRole('button', { name: 'Approve', exact: true }).click()
  const approve = manager.getByRole('alertdialog', { name: 'Approve this expense?' })
  await expect(approve).toContainText('AED 75.00')
  await expect(approve).toContainText(withValue(' for ', 'Maintenance'))
  await approve.getByRole('button', { name: 'Approve' }).click()
  await expect(manager.getByText('Expense approved.')).toBeVisible()
  await expect(manager.locator('[data-status="approved"]').first()).toHaveText('Approved')
  await expect(manager.getByText(/^Approved on .* by .*Rania/)).toBeVisible()
  await shot(manager, 'en-1440-expense-approved')
  await manager.getByRole('button', { name: 'Finalize', exact: true }).click()
  await manager
    .getByRole('alertdialog', { name: 'Finalize this expense?' })
    .getByRole('button', { name: 'Finalize' })
    .click()
  await expect(manager.getByText('Expense finalized.')).toBeVisible()
  await expect(manager.locator('[data-status="posted"]').first()).toHaveText('Final')
  await expect(manager.getByRole('main').getByText('Rania', { exact: true })).toBeVisible()
  await expectSound(manager, 'en')
  await shot(manager, 'en-1440-expense-final')

  // The employee sees it final.
  await employee.reload()
  await expect(employee.locator('[data-status="posted"]').first()).toHaveText('نهائي')
  await expectSound(employee, 'ar')
  await shot(employee, 'ar-375-expense-final')

  // A second one, rejected with a reason, goes back to the employee to change.
  await employee.goto(`/b/${businessId}/expenses/new`)
  await employee.getByRole('textbox', { name: 'المبلغ' }).fill('30')
  await employee
    .getByRole('combobox', { name: 'الفئة', exact: true })
    .selectOption({ label: 'Other' })
  await employee.getByRole('combobox', { name: 'طريقة الدفع' }).selectOption({ label: 'نقدًا' })
  await employee.getByRole('button', { name: 'أرسل للموافقة' }).click()
  await employee
    .getByRole('alertdialog', { name: 'إرسال هذا المصروف للموافقة؟' })
    .getByRole('button', { name: 'أرسل', exact: true })
    .click()
  await expect(employee.locator('[data-status="submitted"]').first()).toBeVisible()
  const secondId = employee.url().split('/').at(-1)!
  await manager.goto(`/b/${businessId}/expenses/${secondId}`)
  await manager.getByRole('button', { name: 'Reject', exact: true }).click()
  const reject = manager.getByRole('alertdialog', { name: 'Reject this expense?' })
  await reject.getByRole('textbox', { name: 'Why' }).fill('Please add the receipt')
  await shot(manager, 'en-1440-expense-reject')
  await reject.getByRole('button', { name: 'Reject' }).click()
  await expect(manager.getByText('Expense rejected.')).toBeVisible()
  await expect(manager.locator('[data-status="rejected"]').first()).toHaveText('Rejected')
  // The manager stays on it as it was recorded (not in an editor written for Omar): it went back
  // to him; "Edit" is there if she wants to fix it herself.
  await expect(manager.getByRole('heading', { level: 1 })).toHaveText(/^Expense of /)
  await expect(
    manager.getByText(withValue('It went back to ', 'Omar', ' to change.')),
  ).toBeVisible()
  await expect(manager.getByRole('button', { name: 'Discard', exact: true })).toBeVisible()
  await shot(manager, 'en-1440-expense-rejected-reviewer')
  await manager.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(manager.getByRole('heading', { level: 1 })).toHaveText('Rejected expense')
  await expect(
    manager.getByText('You can also fix it here and finalize it yourself.', { exact: false }),
  ).toBeVisible()
  await shot(manager, 'en-1440-expense-rejected-reviewer-edit')
  await employee.reload()
  // It comes back to them to change: their own editor, with its amount and the reason.
  await expect(employee.getByRole('heading', { level: 1 })).toHaveText('مصروف مرفوض')
  await expect(employee.locator('[data-status="rejected"]').first()).toHaveText('مرفوض')
  await expect(
    employee.getByRole('alert').filter({ hasText: 'Please add the receipt' }),
  ).toBeVisible()
  await expect(employee.getByRole('textbox', { name: 'المبلغ' })).toHaveValue(/^30(?:\.0+)?$/)
  await expectSound(employee, 'ar')
  await shot(employee, 'ar-375-expense-rejected')
  await manager.setViewportSize(PHONE)
  await manager.goto(`/b/${businessId}/expenses`)
  await expectSound(manager, 'en')
  await shot(manager, 'en-390-expenses')
  await manager.goto(`/b/${businessId}/expenses/${expenseId}`)
  await expectSound(manager, 'en')
  await shot(manager, 'en-390-expense-final')
  await employee.setViewportSize(DESKTOP)
  await employee.goto(`/b/${businessId}/expenses`)
  await expectSound(employee, 'ar')
  await shot(employee, 'ar-1440-expenses')
  await employee.goto(`/b/${businessId}/expenses/${secondId}`)
  await expectSound(employee, 'ar')
  await shot(employee, 'ar-1440-expense-rejected')

  // In English on a 375 px phone, "Send for approval" is longer still: the total stays whole.
  await setLanguage(employee, 'en')
  await employee.setViewportSize(SMALL_PHONE)
  await employee.goto(`/b/${businessId}/expenses/new`)
  await employee.getByRole('textbox', { name: 'Amount' }).fill('12345.67')
  await expect(employee.getByRole('button', { name: 'Send for approval' })).toBeVisible()
  await expectWholeTotal(employee, '12,345.67')
  await expectSound(employee, 'en')
  await shot(employee, 'en-375-expense-submit-editor')

  // Approval off: the employee may not finalize, so their draft waits for someone who may; the
  // editor and the saved draft say so (D-180).
  await owner.goto(`/b/${businessId}/settings/approval`)
  await owner.getByRole('switch', { name: 'Expenses need approval' }).click()
  await expect(owner.getByRole('switch', { name: 'Expenses need approval' })).not.toBeChecked()
  await employee.reload()
  await expect(
    employee.getByText('someone who may finalize expenses will finalize it', { exact: false }),
  ).toBeVisible()
  await expect(employee.getByRole('button', { name: 'Send for approval' })).toHaveCount(0)
  await expect(employee.getByRole('button', { name: 'Finalize' })).toHaveCount(0)
  await employee.getByRole('textbox', { name: 'Amount' }).fill('18')
  await employee
    .getByRole('combobox', { name: 'Category', exact: true })
    .selectOption({ label: 'Other' })
  await employee.getByRole('combobox', { name: 'How it was paid' }).selectOption({ label: 'Cash' })
  await employee.getByRole('button', { name: 'Save draft' }).click()
  await expect(employee.getByText('Draft saved.')).toBeVisible()
  await expect(employee.getByRole('heading', { level: 1 })).toHaveText('Draft expense')
  // Saved, it says it waits (not "Save it" again, D-184).
  await expect(
    employee.getByText('This draft waits for someone who may finalize expenses.', { exact: false }),
  ).toBeVisible()
  await expect(employee.getByText('Save it:', { exact: false })).toHaveCount(0)
  await expectSound(employee, 'en')
  await shot(employee, 'en-375-expense-draft-waits')
  // Who may finalize it hears that a draft of the team waits for them, and finds it (D-184).
  await owner.goto(`/b/${businessId}/expenses`)
  await expect(owner.locator('[data-drafts-waiting]')).toHaveText(
    'Drafts entered by your team are waiting for you to finalize them.',
  )
  await owner.getByRole('link', { name: 'Show them' }).click()
  await expect(owner).toHaveURL(/status=draft/)
  await expect(owner.locator('[data-drafts-waiting]')).toHaveCount(0)
  await expect(owner.getByRole('list', { name: 'Expenses' })).toContainText('Other')
  await expectSound(owner, 'en')
  await shot(owner, 'en-1440-expenses-drafts-waiting')
  await setLanguage(employee, 'ar')
})

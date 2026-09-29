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
  pngImage,
  setLanguage,
  signIn,
  useLanguage,
  withValue,
  WORKSHOP_ANSWERS,
  type TestUser,
} from '../helpers'
import { previewBaseURL } from '../stack'

// Suppliers and Purchases (ROADMAP.md M2 Step 3), on the development server with the dev-only preview
// (D-125, D-127): the owner's milk example end to end (50 L at AED 6, then 100 L at AED 7: the
// average is 6.67; reversing the second brings it back to 6.00), a supplier, a receipt, correcting a
// purchase and the books-closed date, in English on a desktop; a café buying coffee beans in 1 kg
// bags priced per bag, sending a bag back and getting a credit note, in Arabic on a phone (no VAT: the
// business is not VAT-registered); a workshop with branches buying for a branch, with delivery, a
// discount on the whole purchase and VAT it can't reclaim (part of the cost); and an employee whose
// role doesn't show costs, who sees locks. Each purchase says how it was paid (required since the
// owner's requests of 2026-09-29, with prices before VAT on a tax invoice and the material picked from
// a list it is typed in; payables.spec.ts covers the rest of those requests).
// With E2E_SHOTS_DIR set, each step leaves a screenshot there (AR/EN at 390 and 1440 px).

test.describe.configure({ mode: 'serial' })

/** A café that is VAT-registered, with a team and one branch (food wording). */
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

/** A small café run alone, not VAT-registered (no VAT fields anywhere). */
const SMALL_CAFE_ANSWERS = {
  what_you_do: ['food_drinks'],
  workplace: 'shop',
  branches: false,
  team: 'alone',
  work_setup: ['stock'],
  sales_channels: ['walk_in'],
  pos: false,
  vat: 'no',
}

const RAW_KEY =
  /\b(?:common|catalog|units|errors|nav|modules|purchasing|settings)\.[a-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+/

const users: TestUser[] = []
const contexts: BrowserContext[] = []
let owner: { page: Page; businessId: string } | undefined

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
  const who = user ?? (await createUser(`purchasing-${locale}`, { locale: 'en' }))
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

/**
 * Screenshots into E2E_SHOTS_DIR (only when it is set): the screen as it is, and for a long page
 * the screen scrolled to its end too (the shell's bars are fixed, so a full-page image misplaces them).
 */
async function shot(page: Page, name: string) {
  const dir = process.env.E2E_SHOTS_DIR
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  // Let toasts and dialogs finish their animations.
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
  expect(await page.title()).not.toMatch(RAW_KEY)
}

async function createMaterial(
  page: Page,
  businessId: string,
  fields: { name: string; unit: string; packs?: { name: string; qty: string; ofUnit: string }[] },
): Promise<string> {
  const id = randomUUID()
  const result = await callApi(
    page,
    'material.create',
    {
      id,
      name: fields.name,
      unit: fields.unit,
      packs: (fields.packs ?? []).map((pack) => ({ id: randomUUID(), ...pack })),
      crossFactors: [],
    },
    { businessId },
  )
  expect(result.appCode).toBeUndefined()
  return id
}

/** Picks a line's material: typed in its box, then picked from the list. */
async function pickMaterial(line: Locator, label: string, name: string) {
  await line.getByRole('combobox', { name: label }).fill(name)
  await line.getByRole('option', { name, exact: true }).click()
}

/** Fills one material line of the purchase editor. */
async function fillLine(
  line: Locator,
  values: { material: string; materialLabel: string; qty: string; unit?: string; price: string },
  priceLabel: string | RegExp,
) {
  await pickMaterial(line, values.materialLabel, values.material)
  await line.getByRole('textbox', { name: /^(Quantity|الكمية)$/ }).fill(values.qty)
  if (values.unit) {
    await line
      .getByRole('combobox', { name: /^(Unit|الوحدة)$/ })
      .selectOption({ label: values.unit })
  }
  await line.getByRole('textbox', { name: priceLabel }).fill(values.price)
}

/** A material's row on the Materials page. */
function materialRow(page: Page, list: string, name: string): Locator {
  return page.getByRole('list', { name: list }).getByRole('listitem').filter({ hasText: name })
}

test('English, desktop: the milk example, a supplier, a receipt, reverse, correct and the books', async ({
  browser,
}) => {
  test.setTimeout(900_000)
  const { page } = await open(browser, { width: 1440, height: 900 }, 'en')
  const businessId = await createBusiness(page, 'Moon Café', CAFE_ANSWERS)
  owner = { page, businessId }
  await createMaterial(page, businessId, { name: 'Milk', unit: 'l' })
  await page.goto(`/b/${businessId}`)
  const nav = page.getByRole('navigation', { name: 'Main' })

  // Suppliers: a first-time page, then one supplier with its phone and TRN (Arabic digits).
  await nav.getByRole('link', { name: 'Suppliers' }).click()
  await expect(page).toHaveURL(`/b/${businessId}/suppliers`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Suppliers')
  await expect(page.getByRole('heading', { level: 2, name: 'No suppliers yet' })).toBeVisible()
  await expectSound(page, 'en')
  await shot(page, 'en-1440-suppliers-empty')
  await page.getByRole('button', { name: 'Add supplier' }).click()
  const supplierSheet = page.getByRole('dialog', { name: 'New supplier' })
  await supplierSheet.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(supplierSheet.getByText('Enter a name.')).toBeVisible()
  await supplierSheet.getByRole('textbox', { name: 'Name' }).fill('Al Ain Dairy')
  await supplierSheet.getByRole('textbox', { name: 'Phone' }).fill('+971 4 123 4567')
  await supplierSheet.getByRole('textbox', { name: 'TRN' }).fill('١٠٠١٢٣٤٥٦٧٨٩٠٠٣')
  await shot(page, 'en-1440-supplier-sheet')
  await supplierSheet.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.getByText(withValue('', 'Al Ain Dairy', ' added.'))).toBeVisible()
  const suppliers = page.getByRole('list', { name: 'Suppliers' })
  await expect(suppliers.getByRole('listitem')).toContainText('+971 4 123 4567')
  await expect(suppliers.getByRole('listitem')).toContainText('TRN 100123456789003')

  // Purchases: a first-time page with its one "New purchase".
  await nav.getByRole('link', { name: 'Purchases' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Purchases')
  await expect(page.getByRole('heading', { level: 2, name: 'No purchases yet' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'New purchase' })).toHaveCount(1)
  await page.getByRole('link', { name: 'New purchase' }).click()
  await expect(page).toHaveURL(`/b/${businessId}/purchases/new`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('New purchase')

  // 50 L of milk at AED 6 a litre, on a tax invoice (5% VAT, reclaimable: not in the cost).
  await page.getByRole('combobox', { name: 'Supplier' }).selectOption({ label: 'Al Ain Dairy' })
  await expect(page.getByRole('combobox', { name: 'Invoice type' })).toHaveValue('tax_invoice')
  await page.getByRole('textbox', { name: 'Invoice or receipt number' }).fill('INV-101')
  // Finalizing an empty line says what is missing, on the line.
  await page.getByRole('button', { name: 'Finalize' }).click()
  await expect(page.getByText('Pick what you bought.')).toBeVisible()
  const line = page.getByRole('group', { name: 'Item 1' })
  await fillLine(
    line,
    { material: 'Milk', materialLabel: 'Ingredient or supply', qty: '٥٠', price: '6' },
    'Price per L before VAT',
  )
  await expect(line.getByRole('combobox', { name: 'Unit' })).toHaveValue('unit:l')
  await expect(line.getByRole('combobox', { name: 'VAT' })).toHaveValue('5')
  await expect(line.getByText('Total AED 315.00')).toBeVisible()
  // Before VAT, the VAT and the total are always said (no discount: no subtotal).
  const total = (key: string) => page.locator(`[data-total="${key}"]`)
  await expect(total('subtotal')).toHaveCount(0)
  await expect(total('net')).toContainText('AED 300.00')
  await expect(total('vat')).toContainText('AED 15.00')
  await expect(total('total')).toContainText('AED 315.00')
  await page.getByRole('combobox', { name: 'How it was paid' }).selectOption({ label: 'Cash' })
  // A receipt picked before the first save is attached with it.
  await page.locator('[data-receipt-input]').setInputFiles({
    name: 'milk-receipt.png',
    mimeType: 'image/png',
    buffer: pngImage(),
  })
  await expect(page.getByText('milk-receipt.png')).toBeVisible()
  await expectSound(page, 'en')
  await shot(page, 'en-1440-purchase-editor')

  await page.getByRole('button', { name: 'Finalize' }).click()
  const finalize = page.getByRole('alertdialog', { name: 'Finalize this purchase?' })
  await expect(finalize).toContainText(
    withValue('Its goods come into your stock and the average cost of ', 'Milk', ' updates.'),
  )
  await shot(page, 'en-1440-finalize-dialog')
  await finalize.getByRole('button', { name: 'Finalize' }).click()
  await expect(
    page.getByText(withValue('Purchase finalized. The average cost of ', 'Milk', ' is updated.')),
  ).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`/b/${businessId}/purchases/[0-9a-f-]{36}$`))
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Purchase of /)
  await expect(page.getByText('Final', { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('link', { name: 'milk-receipt.png' })).toBeVisible()
  await expect(
    page.getByText("The VAT isn't part of the cost of the goods (you reclaim it)."),
  ).toBeVisible()
  await expect(page.locator('[data-purchase-line]')).toContainText('Cost of the goods: AED 300.00')
  const firstPurchase = page.url()
  await shot(page, 'en-1440-purchase-final')

  // The material's cost: AED 6 a litre, from the purchases of the last 90 days.
  await nav.getByRole('link', { name: 'Ingredients & supplies' }).click()
  const milk = materialRow(page, 'Ingredients & supplies', 'Milk')
  const average = milk.locator('[data-cost="Average cost"]')
  const lastCost = milk.locator('[data-cost="Last purchase cost"]')
  // The main value first, the rest on a muted line under it (D-143).
  await expect(average).toContainText('Average cost: AED 6.00 per L')
  await expect(average).toContainText('AED 0.0060 per ml · from your purchases of the last 90 days')
  await expect(lastCost).toContainText('Last purchase cost: AED 6.00 per L')
  await expect(lastCost).toContainText('AED 0.0060 per ml · with delivery and discounts')

  // The second purchase: 100 L at AED 7 → (50 × 6 + 100 × 7) ÷ 150 = 6.67.
  await page.goto(`/b/${businessId}/purchases/new`)
  await page.getByRole('combobox', { name: 'Supplier' }).selectOption({ label: 'Al Ain Dairy' })
  await fillLine(
    page.getByRole('group', { name: 'Item 1' }),
    { material: 'Milk', materialLabel: 'Ingredient or supply', qty: '100', price: '7' },
    'Price per L before VAT',
  )
  await page.getByRole('combobox', { name: 'How it was paid' }).selectOption({ label: 'Card' })
  await page.getByRole('button', { name: 'Finalize' }).click()
  await page
    .getByRole('alertdialog', { name: 'Finalize this purchase?' })
    .getByRole('button', { name: 'Finalize' })
    .click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Purchase of /)
  const secondPurchase = page.url()
  await page.goto(`/b/${businessId}/materials`)
  await expect(average).toContainText('Average cost: AED 6.67 per L')
  await expect(average).toContainText('AED 0.0067 per ml')
  await expect(lastCost).toContainText('Last purchase cost: AED 7.00 per L')
  await expect(lastCost).toContainText('AED 0.0070 per ml')
  await expectSound(page, 'en')
  await shot(page, 'en-1440-materials-costs')

  // The list: newest first, filters kept in the address.
  await nav.getByRole('link', { name: 'Purchases' }).click()
  const purchases = page.getByRole('list', { name: 'Purchases' })
  await expect(purchases.getByRole('listitem')).toHaveCount(2)
  await expect(purchases).toContainText('AED 315.00')
  await expect(purchases).toContainText('AED 735.00')
  await page.getByRole('searchbox', { name: 'Search' }).fill('INV-101')
  await expect(page).toHaveURL(/[?&]q=INV-101/)
  await expect(purchases.getByRole('listitem')).toHaveCount(1)
  await page.getByRole('button', { name: 'Clear filters' }).click()
  await expect(page).not.toHaveURL(/[?&]q=/)
  await expect(purchases.getByRole('listitem')).toHaveCount(2)
  await page.getByRole('group', { name: 'Show' }).getByText('Drafts', { exact: true }).click()
  await expect(page).toHaveURL(/[?&]status=draft/)
  await expect(page.getByText('No purchases match these filters.')).toBeVisible()
  await page.getByRole('group', { name: 'Show' }).getByText('All', { exact: true }).click()
  await expect(purchases.getByRole('listitem')).toHaveCount(2)
  await shot(page, 'en-1440-purchases-list')

  // Reverse the second purchase: the average goes back to exactly 6.
  await page.goto(secondPurchase)
  await page.getByRole('button', { name: 'Reverse' }).click()
  const reverse = page.getByRole('alertdialog', { name: 'Reverse this purchase?' })
  await expect(reverse).toContainText(
    withValue(
      'It will be as if it was never entered: its goods leave your stock and the average cost of ',
      'Milk',
      ' goes back to what it would be without it.',
    ),
  )
  await shot(page, 'en-1440-reverse-dialog')
  await reverse.getByRole('button', { name: 'Reverse' }).click()
  await expect(page.getByText('Reversed', { exact: true }).first()).toBeVisible()
  await expect(
    page.getByText(/^Reversed on .*\. It no longer counts in your costs\.$/),
  ).toBeVisible()
  await page.goto(`/b/${businessId}/materials`)
  await expect(milk).toContainText('Average cost: AED 6.00 per L')

  // Correct the first one: reversed, and a copy opens as a draft to fix (AED 6.50 a litre).
  await page.goto(firstPurchase)
  await page.getByRole('button', { name: 'Correct' }).click()
  await page
    .getByRole('alertdialog', { name: 'Correct this purchase?' })
    .getByRole('button', { name: 'Reverse and copy' })
    .click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Draft purchase')
  await expect(page.getByText('This draft corrects a purchase that was reversed.')).toBeVisible()
  const copy = page.getByRole('group', { name: 'Item 1' })
  await expect(copy.getByRole('textbox', { name: 'Price per L before VAT' })).toHaveValue('6')
  await copy.getByRole('textbox', { name: 'Price per L before VAT' }).fill('6.5')
  await page.getByRole('button', { name: 'Save draft' }).click()
  await expect(page.getByText('Draft saved.')).toBeVisible()
  await page.getByRole('button', { name: 'Finalize' }).click()
  await page
    .getByRole('alertdialog', { name: 'Finalize this purchase?' })
    .getByRole('button', { name: 'Finalize' })
    .click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Purchase of /)
  const corrected = page.url()
  await page.goto(`/b/${businessId}/materials`)
  await expect(milk).toContainText('Average cost: AED 6.50 per L')

  // Closing the books up to today: nothing of today can be reversed until they open again.
  await page.goto(`/b/${businessId}/settings`)
  await page.getByRole('link', { name: /^Closing the books/ }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Closing the books')
  await expect(
    page.getByText('The books are open: anything can be finalized or reversed.'),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Close the books' }).click()
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: /^The books are closed up to / })
      .first(),
  ).toBeVisible()
  await expectSound(page, 'en')
  await shot(page, 'en-1440-books')
  await page.goto(`/b/${businessId}/purchases`)
  await expect(
    page.getByText(
      /^The books are closed up to .*\. Nothing dated on or before it can be finalized or reversed\.$/,
    ),
  ).toBeVisible()
  await page.goto(`/b/${businessId}/purchases/new`)
  await expect(
    page.getByText(
      /^The books are closed up to today \(.*\)\. You can save a draft and finalize it tomorrow, or open the books in Settings\.$/,
    ),
  ).toBeVisible()
  await fillLine(
    page.getByRole('group', { name: 'Item 1' }),
    { material: 'Milk', materialLabel: 'Ingredient or supply', qty: '1', price: '6' },
    'Price per L before VAT',
  )
  await page.getByRole('combobox', { name: 'How it was paid' }).selectOption({ label: 'Cash' })
  await page.getByRole('button', { name: 'Finalize' }).click()
  await expect(page.getByRole('alertdialog', { name: 'Finalize this purchase?' })).toHaveCount(0)
  await expect(
    page.getByRole('alert').filter({ hasText: /^The books are closed up to today/ }),
  ).toBeVisible()
  await expectSound(page, 'en')
  await shot(page, 'en-1440-editor-books-closed')
  await page.goto(corrected)
  await page.getByRole('button', { name: 'Reverse' }).click()
  const refused = page.getByRole('alertdialog', { name: 'Reverse this purchase?' })
  await expect(
    refused.getByText(
      'The books are closed up to today, so nothing can be reversed today. You can reverse it from tomorrow, or once the books are opened again in Settings.',
    ),
  ).toBeVisible()
  await expect(refused.getByRole('button', { name: 'Reverse' })).toBeDisabled()
  await refused.getByRole('button', { name: 'Cancel' }).click()
  // The API refuses it too.
  const correctedId = corrected.split('/').at(-1)
  expect(
    (await callApi(page, 'purchase.reverse', { id: correctedId }, { businessId })).appCode,
  ).toBe('books_closed')
  await page.goto(`/b/${businessId}/settings/books`)
  await page.getByRole('button', { name: 'Open the books' }).click()
  await expect(
    page.getByText('The books are open: anything can be finalized or reversed.'),
  ).toBeVisible()

  // The same screens on a phone, in English. The supplier and the days fold under one button.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/b/${businessId}/purchases`)
  const more = page.getByRole('button', { name: 'Supplier and dates' })
  await expect(more).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('combobox', { name: 'Supplier' })).toBeHidden()
  await more.click()
  await expect(page.getByRole('combobox', { name: 'Supplier' })).toBeVisible()
  await expectSound(page, 'en')
  await shot(page, 'en-390-purchases-list')
  await page.goto(corrected)
  await expectSound(page, 'en')
  await shot(page, 'en-390-purchase-final')

  // The running totals follow the document maths: 12 L at AED 6.25 = 75.00, 10% off the whole
  // purchase (7.50) before VAT, delivery AED 10 on the invoice; VAT 5% on 67.50 (3.38) and on the
  // delivery (0.50).
  await page.goto(`/b/${businessId}/purchases/new`)
  await fillLine(
    page.getByRole('group', { name: 'Item 1' }),
    { material: 'Milk', materialLabel: 'Ingredient or supply', qty: '12', price: '6.25' },
    'Price per L before VAT',
  )
  await page.getByRole('button', { name: 'Add delivery on this invoice' }).click()
  await page.getByRole('textbox', { name: 'Delivery amount' }).fill('10')
  await page.getByRole('button', { name: 'Add a discount on the whole purchase' }).click()
  await page.getByRole('textbox', { name: 'Discount on the whole purchase' }).fill('10')
  await expect(total('subtotal')).toContainText('AED 85.00')
  await expect(total('discount')).toContainText('AED 7.50')
  await expect(total('net')).toContainText('AED 77.50')
  await expect(total('vat')).toContainText('AED 3.88')
  await expect(total('total')).toContainText('AED 81.38')
  await expectSound(page, 'en')
  await shot(page, 'en-390-purchase-editor')
  await page.goto(`/b/${businessId}/materials`)
  await expectSound(page, 'en')
  await shot(page, 'en-390-materials-costs')
  await page.goto(`/b/${businessId}/suppliers`)
  await expectSound(page, 'en')
  await shot(page, 'en-390-suppliers')
  await page.goto(`/b/${businessId}/settings/books`)
  await expectSound(page, 'en')
  await shot(page, 'en-390-books')
})

test('Arabic, phone: a café buys beans in 1 kg bags priced per bag, returns one and gets a credit note', async ({
  browser,
}) => {
  test.setTimeout(900_000)
  const { page } = await open(browser, { width: 390, height: 844 }, 'ar')
  const businessId = await createBusiness(page, 'Bean Corner', SMALL_CAFE_ANSWERS)
  await createMaterial(page, businessId, {
    name: 'بن',
    unit: 'kg',
    packs: [{ name: 'كيس', qty: '1', ofUnit: 'kg' }],
  })
  const supplier = await callApi(
    page,
    'supplier.create',
    { id: randomUUID(), name: 'محمصة الخليج' },
    { businessId },
  )
  expect(supplier.appCode).toBeUndefined()

  await page.goto(`/b/${businessId}/purchases/new`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('مشتريات جديدة')
  await page.getByRole('combobox', { name: 'المورد' }).selectOption({ label: 'محمصة الخليج' })
  // Not VAT-registered: no VAT on the lines, and the price is what was paid. One branch: no picker.
  await expect(page.getByRole('combobox', { name: 'الضريبة' })).toHaveCount(0)
  await expect(page.getByRole('switch', { name: 'لا يمكن استرداد الضريبة' })).toHaveCount(0)
  await expect(page.getByRole('combobox', { name: 'الفرع' })).toHaveCount(0)
  const line = page.getByRole('group', { name: 'الصنف 1' })
  await pickMaterial(line, 'المكوّن أو المستلزم', 'بن')
  // Not VAT-registered: no choice of prices before or with VAT.
  await expect(page.getByRole('radio', { name: 'الأسعار شاملة الضريبة' })).toHaveCount(0)
  // Bought the way it was set up: in bags of 1 kg, the price per bag.
  await expect(line.getByRole('combobox', { name: 'الوحدة' })).toHaveValue(/^pack:/)
  await line.getByRole('textbox', { name: 'الكمية' }).fill('٣')
  await expect(line.locator('[data-qty-words]')).toHaveText('3 × كيس = 3 كيلو')
  await line.getByRole('textbox', { name: 'السعر لكل كيس' }).fill('٤٥')
  await expect(line.locator('[data-per-unit]')).toContainText('45.00')
  await expect(line.locator('[data-per-unit]')).toContainText('لكل كيلو')
  await expect(line.locator('[data-line-total]')).toContainText('135.00')
  await expectSound(page, 'ar')
  // The line in view: its pack, its words, its price per bag and what that makes per kilo.
  await line.evaluate((element) => element.scrollIntoView({ block: 'center' }))
  await shot(page, 'ar-390-purchase-editor')

  await page.getByRole('combobox', { name: 'طريقة الدفع' }).selectOption({ label: 'نقدًا' })
  await page.getByRole('button', { name: 'احفظ كمسودة' }).click()
  await expect(page.getByText('تم حفظ المسودة.')).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`/b/${businessId}/purchases/[0-9a-f-]{36}$`))
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('مسودة مشتريات')
  await page.getByRole('button', { name: 'اعتمد' }).click()
  const finalize = page.getByRole('alertdialog', { name: 'اعتماد هذه المشتريات؟' })
  await expect(finalize).toContainText(
    withValue('تدخل بضاعتها مخزونك ويتحدّث متوسط تكلفة ', 'بن', '.'),
  )
  await shot(page, 'ar-390-finalize-dialog')
  await finalize.getByRole('button', { name: 'اعتمد' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^مشتريات /)
  await expect(page.getByText('معتمدة', { exact: true }).first()).toBeVisible()
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-purchase-final')

  // Send one bag back: it leaves the stock at the price paid for it.
  await page.getByRole('button', { name: 'إرجاع بضاعة' }).click()
  const returnSheet = page.getByRole('dialog', { name: 'إرجاع بضاعة إلى المورد' })
  await expect(returnSheet.getByText('حتى 3 × كيس')).toBeVisible()
  await returnSheet.getByRole('textbox', { name: /^كم تُرجع من/ }).fill('٤')
  await expect(
    returnSheet.getByText('هذا أكثر مما تبقى من هذه المشتريات. تحقق من الكمية أو المبلغ.'),
  ).toBeVisible()
  await returnSheet.getByRole('textbox', { name: /^كم تُرجع من/ }).fill('١')
  await shot(page, 'ar-390-return-sheet')
  await returnSheet.getByRole('button', { name: 'اعتمد' }).click()
  const confirmReturn = page.getByRole('alertdialog', { name: 'اعتماد هذا المرتجع؟' })
  // What goes back and for how much (no VAT: the price paid).
  await expect(confirmReturn).toContainText('يخرج من مخزونك:')
  await expect(confirmReturn).toContainText('45.00')
  await shot(page, 'ar-390-return-confirm')
  await confirmReturn.getByRole('button', { name: 'اعتمد' }).click()
  await expect(
    page.getByText(withValue('تم اعتماد المرتجع. تحدّث متوسط تكلفة ', 'بن', '.')),
  ).toBeVisible()
  const documents = page.getByRole('list', { name: 'المرتجعات وإشعارات التخفيض' })
  await expect(documents.getByRole('listitem')).toHaveCount(1)
  await expect(documents).toContainText('مرتجع')
  await expect(documents).toContainText('معتمد')
  await expect(documents).toContainText('45.00')
  await expect(page.locator('[data-purchase-line]')).toContainText('أُرجع 1 كيس')

  // A credit note of AED 10 on the beans.
  await page.getByRole('button', { name: 'إشعار تخفيض' }).click()
  const creditSheet = page.getByRole('dialog', { name: 'إشعار تخفيض من المورد' })
  // Not VAT-registered: the amount is what was paid, never "before VAT".
  await expect(creditSheet).not.toContainText('قبل الضريبة')
  await creditSheet.getByRole('textbox', { name: /^مبلغ / }).fill('١٠')
  await shot(page, 'ar-390-credit-sheet')
  await creditSheet.getByRole('button', { name: 'اعتمد' }).click()
  await page
    .getByRole('alertdialog', { name: 'اعتماد إشعار التخفيض هذا؟' })
    .getByRole('button', { name: 'اعتمد' })
    .click()
  await expect(documents.getByRole('listitem')).toHaveCount(2)
  await expect(page.locator('[data-purchase-line]')).toContainText('تخفيض بإشعار:')
  // What the goods cost once the return and the credit took theirs off: 135 − 45 − 10.
  await expect(page.locator('[data-cost-after-returns]')).toContainText('80.00')
  // A purchase with returns and credit notes is reversed only after them.
  await expect(
    page.getByText('لإبطال هذه المشتريات، أبطِل مرتجعاتها وإشعارات التخفيض أولًا.'),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'إبطال' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'تصحيح' })).toHaveCount(0)
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-purchase-returns')

  // The beans now cost (135 − 45 − 10) ÷ 2 kg = AED 40 a kilo.
  await page.goto(`/b/${businessId}/materials`)
  const beans = materialRow(page, 'المكونات والمستلزمات', 'بن')
  await expect(beans).toContainText('متوسط التكلفة:')
  await expect(beans).toContainText('40.00')
  await expect(beans).toContainText('لكل كيلو')
  await expect(beans).toContainText('من مشترياتك في آخر 90 يومًا')
  await expect(beans).toContainText('آخر تكلفة شراء:')
  await expect(beans).toContainText('مع التوصيل والخصومات')
  // A bag of 1 kg costs what a kilo does: said once.
  await expect(beans).not.toContainText('لكل كيس')
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-materials-costs')

  // The purchases list, and the same screens on a desktop.
  await page.goto(`/b/${businessId}/purchases`)
  await expect(page.getByRole('list', { name: 'المشتريات' }).getByRole('listitem')).toHaveCount(1)
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-purchases-list')
  await page.goto(`/b/${businessId}/suppliers`)
  await expect(page.getByRole('list', { name: 'الموردون' })).toContainText('محمصة الخليج')
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-suppliers')
  await page.goto(`/b/${businessId}/purchases`)
  await page.setViewportSize({ width: 1440, height: 900 })
  await expectSound(page, 'ar')
  await shot(page, 'ar-1440-purchases-list')
  await page.getByRole('list', { name: 'المشتريات' }).getByRole('link').first().click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^مشتريات /)
  await expectSound(page, 'ar')
  await shot(page, 'ar-1440-purchase-returns')
  await page.goto(`/b/${businessId}/materials`)
  await shot(page, 'ar-1440-materials-costs')
  await page.goto(`/b/${businessId}/suppliers`)
  await expectSound(page, 'ar')
  await shot(page, 'ar-1440-suppliers')
  await page.goto(`/b/${businessId}/purchases/new`)
  await pickMaterial(page.getByRole('group', { name: 'الصنف 1' }), 'المكوّن أو المستلزم', 'بن')
  await expectSound(page, 'ar')
  await shot(page, 'ar-1440-purchase-editor')
  await page.goto(`/b/${businessId}/settings/books`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('إغلاق الدفاتر')
  await expectSound(page, 'ar')
  await shot(page, 'ar-1440-books')
})

test('English, desktop: a workshop with branches buys for a branch, with VAT it cannot reclaim', async ({
  browser,
}) => {
  test.setTimeout(600_000)
  const { page } = await open(browser, { width: 1440, height: 900 }, 'en')
  const businessId = await createBusiness(page, 'Falcon Workshop', WORKSHOP_ANSWERS)
  const branch = await callApi(
    page,
    'location.create',
    { id: randomUUID(), name: 'Deira branch' },
    { businessId },
  )
  expect(branch.appCode).toBeUndefined()
  await createMaterial(page, businessId, { name: 'Steel sheet', unit: 'kg' })

  await page.goto(`/b/${businessId}/purchases/new`)
  // With branches: where the goods came in.
  const where = page.getByRole('combobox', { name: 'Branch' })
  await expect(where.getByRole('option')).toHaveCount(2)
  await where.selectOption({ label: 'Deira branch' })
  await fillLine(
    page.getByRole('group', { name: 'Item 1' }),
    { material: 'Steel sheet', materialLabel: 'Material', qty: '10', price: '20' },
    'Price per kg before VAT',
  )
  await page.getByRole('combobox', { name: 'How it was paid' }).selectOption({ label: 'Cheque' })
  // The VAT can't be reclaimed: it becomes part of the cost. 10 kg × 20 = 200, 10% off the whole
  // purchase (20), VAT 9.00, delivery 10 with VAT 0.50: the goods cost 180 + 9 + 10.50 = 199.50.
  await page.getByRole('switch', { name: "VAT can't be reclaimed" }).click()
  await page.getByRole('button', { name: 'Add delivery on this invoice' }).click()
  await page.getByRole('textbox', { name: 'Delivery amount' }).fill('10')
  await page.getByRole('button', { name: 'Add a discount on the whole purchase' }).click()
  await page.getByRole('textbox', { name: 'Discount on the whole purchase' }).fill('10')
  const total = (key: string) => page.locator(`[data-total="${key}"]`)
  await expect(total('subtotal')).toContainText('AED 210.00')
  await expect(total('discount')).toContainText('AED 20.00')
  await expect(total('net')).toContainText('AED 190.00')
  await expect(total('vat')).toContainText('AED 9.50')
  await expect(total('total')).toContainText('AED 199.50')
  await expectSound(page, 'en')
  await shot(page, 'en-1440-branch-purchase-editor')

  await page.getByRole('button', { name: 'Finalize' }).click()
  await page
    .getByRole('alertdialog', { name: 'Finalize this purchase?' })
    .getByRole('button', { name: 'Finalize' })
    .click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Purchase of /)
  await expect(page.getByText('Deira branch')).toBeVisible()
  await expect(
    page.getByText("The VAT is part of the cost of the goods (it can't be reclaimed)."),
  ).toBeVisible()
  await expect(page.locator('[data-purchase-line]')).toContainText(
    'Cost of the goods: AED 199.50 · AED 19.95 per kg',
  )
  await expectSound(page, 'en')
  await shot(page, 'en-1440-branch-purchase-final')
  await page.goto(`/b/${businessId}/materials`)
  const steel = materialRow(page, 'Materials', 'Steel sheet')
  await expect(steel).toContainText('Average cost: AED 19.95 per kg')
  await expect(steel).toContainText('AED 0.020 per g')
  await shot(page, 'en-1440-branch-materials-costs')
})

test('an employee whose role shows no costs sees locks instead of prices', async ({ browser }) => {
  test.setTimeout(600_000)
  if (!owner) throw new Error('the first test makes the business')
  const { page: ownerPage, businessId } = owner
  // The Employee role may now see materials, suppliers and purchases, but still no costs.
  const roles = await callApi<
    { id: string; templateKey: string | null; permissionKeys: string[]; version: number }[]
  >(ownerPage, 'role.list', {}, { businessId, query: true })
  const employeeRole = roles.data?.find((role) => role.templateKey === 'employee')
  if (!employeeRole) throw new Error('no Employee role')
  const updated = await callApi(
    ownerPage,
    'role.updatePermissions',
    {
      id: employeeRole.id,
      version: employeeRole.version,
      permissionKeys: [
        ...employeeRole.permissionKeys,
        'materials.items.view',
        'suppliers.items.view',
        'purchases.documents.view',
      ],
    },
    { businessId },
  )
  expect(updated.appCode).toBeUndefined()
  const employee = await createUser('purchasing-employee')
  users.push(employee)
  const invited = await callApi(
    ownerPage,
    'invitation.create',
    { id: randomUUID(), email: employee.email, roleId: employeeRole.id, locale: 'en' },
    { businessId },
  )
  expect(invited.appCode).toBeUndefined()
  const { token } = await nextInvitation(employee.email)
  const { page } = await open(browser, { width: 1440, height: 900 }, 'en', employee)
  const accepted = await callApi(page, 'invitation.accept', { token })
  expect(accepted.appCode).toBeUndefined()

  // Materials: the average and the last price are locked, never 0; the day still shows.
  await page.goto(`/b/${businessId}/materials`)
  const milk = materialRow(page, 'Ingredients & supplies', 'Milk')
  await expect(milk.locator('[data-locked="cost"]')).toHaveCount(1)
  await expect(milk.locator('[data-locked="supplier_price"]')).toHaveCount(1)
  await expect(milk).not.toContainText('AED')
  await expectSound(page, 'en')
  await shot(page, 'en-1440-employee-materials')

  // Purchases: no "New purchase", totals locked.
  await page.goto(`/b/${businessId}/purchases`)
  await expect(page.getByRole('link', { name: 'New purchase' })).toHaveCount(0)
  await expect(
    page.getByText("Some amounts are hidden: your role doesn't show supplier prices or costs."),
  ).toBeVisible()
  const rows = page.getByRole('list', { name: 'Purchases' }).getByRole('listitem')
  await expect(rows.first().locator('[data-locked="supplier_price"]')).toBeVisible()
  await expect(page.getByRole('list', { name: 'Purchases' })).not.toContainText('AED')
  await shot(page, 'en-1440-employee-purchases')

  // A purchase: prices, totals and the receipt's file locked; no actions.
  await rows
    .filter({ hasText: 'INV-101' })
    .filter({ hasText: 'Reversed' })
    .getByRole('link')
    .click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Purchase of /)
  await expect(
    page.locator('[data-purchase-line] [data-locked="supplier_price"]').first(),
  ).toBeVisible()
  await expect(page.getByRole('main')).not.toContainText('AED')
  await expect(page.getByText('milk-receipt.png')).toBeVisible()
  await expect(page.getByRole('link', { name: 'milk-receipt.png' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Reverse' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Correct' })).toHaveCount(0)
  await expectSound(page, 'en')
  await shot(page, 'en-1440-employee-purchase')
  // The API refuses what the screens don't offer.
  expect(
    (await callApi(page, 'books.close', { closedThrough: null }, { businessId })).appCode,
  ).toBe('forbidden')

  // The same locks in Arabic on a phone.
  await setLanguage(page, 'ar')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/b/${businessId}/materials`)
  const milkAr = materialRow(page, 'المكونات والمستلزمات', 'Milk')
  await expect(milkAr.locator('[data-locked="cost"]')).toHaveCount(1)
  await expect(milkAr.locator('[data-locked="cost"]')).toContainText('مخفي')
  await expect(milkAr).not.toContainText('د.إ.')
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-employee-materials')
  await page.goto(`/b/${businessId}/purchases`)
  await expect(
    page.getByText('بعض المبالغ مخفية: دورك لا يعرض أسعار الموردين أو التكاليف.'),
  ).toBeVisible()
  await expect(page.getByRole('link', { name: 'مشتريات جديدة' })).toHaveCount(0)
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-employee-purchases')
})

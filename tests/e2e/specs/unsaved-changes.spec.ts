import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
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

// Changes not saved are never lost without asking (the owner's request of 2026-09-29), on the
// development server with the dev-only preview (D-125): leaving a form with changes asks "You have
// unsaved changes" with Save (saves, then leaves; a failed save stays and says why), Don't save and
// Keep editing. A material sheet (×, Escape, a tap beside it), a purchase (a link of the sidebar or
// the tab bar, the browser's Back button, a reload: the browser's own question) and a settings
// section (Business profile); nothing asks when nothing changed or once it is saved. English on a
// desktop, Arabic on a phone, and the question itself in both languages at both sizes.

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

const RAW_KEY =
  /\b(?:common|catalog|units|errors|nav|modules|purchasing|settings)\.[a-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+/

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
): Promise<{ page: Page; businessId: string }> {
  const user = await createUser(`unsaved-${locale}`, { locale: 'en' })
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
  if (locale === 'ar') await setLanguage(page, 'ar')
  const businessId = await createBusiness(page, 'Palm Café', CAFE_ANSWERS)
  const milk = await callApi(
    page,
    'material.create',
    { id: randomUUID(), name: 'Milk', unit: 'l', packs: [], crossFactors: [] },
    { businessId },
  )
  expect(milk.appCode).toBeUndefined()
  return { page, businessId }
}

async function shot(page: Page, name: string) {
  const dir = process.env.E2E_SHOTS_DIR
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(dir, `${name}.png`) })
}

async function expectSound(page: Page, locale: 'en' | 'ar') {
  await expect(page.locator('html')).toHaveAttribute('lang', locale)
  await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr')
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
  expect(await page.locator('body').innerText()).not.toMatch(RAW_KEY)
}

/** Fills the first line of the purchase editor: 2 L of milk at AED 6. */
async function fillMilk(page: Page, labels: { group: string; material: string; qty: string }) {
  const line = page.getByRole('group', { name: labels.group })
  await line.getByRole('combobox', { name: labels.material }).fill('Milk')
  await line.getByRole('option', { name: 'Milk', exact: true }).click()
  await line.getByRole('textbox', { name: labels.qty }).fill('2')
  await line.locator('input[inputmode="decimal"]').last().fill('6')
}

test('English, desktop: a material sheet, a purchase and a settings section ask before leaving', async ({
  browser,
}) => {
  test.setTimeout(900_000)
  const { page, businessId } = await open(browser, DESKTOP, 'en')
  const unsaved = page.getByRole('alertdialog', { name: 'You have unsaved changes' })
  const nav = page.getByRole('navigation', { name: 'Main' })

  // A material sheet: opened and closed without a change, it just closes.
  await page.goto(`/b/${businessId}/materials`)
  await page.getByRole('button', { name: 'Add ingredient or supply' }).click()
  const sheet = page.getByRole('dialog', { name: 'New ingredient or supply' })
  await sheet.getByRole('button', { name: 'Close' }).click()
  await expect(sheet).toHaveCount(0)
  await expect(unsaved).toHaveCount(0)
  // Escape with a name typed asks; Keep editing keeps it.
  await page.getByRole('button', { name: 'Add ingredient or supply' }).click()
  await sheet.getByRole('textbox', { name: 'Name' }).fill('Sugar')
  await page.keyboard.press('Escape')
  await expect(unsaved).toBeVisible()
  await expect(unsaved).toContainText('Save them before you leave?')
  await expectSound(page, 'en')
  await shot(page, 'en-1440-unsaved-material')
  await unsaved.getByRole('button', { name: 'Keep editing' }).click()
  await expect(unsaved).toHaveCount(0)
  await expect(sheet.getByRole('textbox', { name: 'Name' })).toHaveValue('Sugar')
  // A tap beside the sheet asks too; Don't save drops it.
  await page.mouse.click(200, 450)
  await expect(unsaved).toBeVisible()
  await unsaved.getByRole('button', { name: "Don't save" }).click()
  await expect(sheet).toHaveCount(0)
  const list = page.getByRole('list', { name: 'Ingredients & supplies' })
  await expect(list).not.toContainText('Sugar')
  // Save saves it, then closes.
  await page.getByRole('button', { name: 'Add ingredient or supply' }).click()
  await sheet.getByRole('textbox', { name: 'Name' }).fill('Sugar')
  await sheet.getByRole('combobox', { name: 'Unit you use it in' }).selectOption('kg')
  await sheet.getByRole('button', { name: 'Close' }).click()
  await unsaved.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText(withValue('', 'Sugar', ' added.'))).toBeVisible()
  await expect(sheet).toHaveCount(0)
  await expect(list).toContainText('Sugar')
  // A save that fails stays, and says why.
  await page.getByRole('button', { name: 'Add ingredient or supply' }).click()
  await sheet.getByRole('textbox', { name: 'Name' }).fill('Salt')
  await page.keyboard.press('Escape')
  await unsaved.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(unsaved).toHaveCount(0)
  await expect(sheet.getByText('Pick the unit you use it in.')).toBeVisible()
  await sheet.getByRole('button', { name: 'Cancel' }).click()
  await unsaved.getByRole('button', { name: "Don't save" }).click()
  await expect(sheet).toHaveCount(0)

  // A purchase: nothing typed, a link just goes.
  await page.goto(`/b/${businessId}/purchases/new`)
  await nav.getByRole('link', { name: 'Suppliers' }).click()
  await expect(page).toHaveURL(`/b/${businessId}/suppliers`)
  await expect(unsaved).toHaveCount(0)
  // With a line typed, a link asks; Keep editing stays with what was typed.
  await page.goto(`/b/${businessId}/purchases/new`)
  const labels = { group: 'Item 1', material: 'Ingredient or supply', qty: 'Quantity' }
  await fillMilk(page, labels)
  await nav.getByRole('link', { name: 'Suppliers' }).click()
  await expect(unsaved).toBeVisible()
  await shot(page, 'en-1440-unsaved-purchase')
  await unsaved.getByRole('button', { name: 'Keep editing' }).click()
  await expect(page).toHaveURL(`/b/${businessId}/purchases/new`)
  const qty = page.getByRole('group', { name: 'Item 1' }).getByRole('textbox', { name: 'Quantity' })
  await expect(qty).toHaveValue('2')
  // The browser's Back button asks too; Don't save goes back.
  await page.goBack()
  await expect(unsaved).toBeVisible()
  await expect(page).toHaveURL(`/b/${businessId}/purchases/new`)
  await unsaved.getByRole('button', { name: "Don't save" }).click()
  await expect(page).toHaveURL(`/b/${businessId}/suppliers`)
  // Save saves the draft, then goes.
  await page.goto(`/b/${businessId}/purchases/new`)
  await fillMilk(page, labels)
  await page.getByRole('combobox', { name: 'How it was paid' }).selectOption({ label: 'Cash' })
  await nav.getByRole('link', { name: 'Purchases' }).click()
  await unsaved.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Draft saved.')).toBeVisible()
  await expect(page).toHaveURL(`/b/${businessId}/purchases`)
  await expect(page.getByRole('list', { name: 'Purchases' }).getByRole('listitem')).toHaveCount(1)
  // A save that fails (how it was paid is missing) stays and says why.
  await page.goto(`/b/${businessId}/purchases/new`)
  await fillMilk(page, labels)
  await nav.getByRole('link', { name: 'Suppliers' }).click()
  await unsaved.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Choose how it was paid.')).toBeVisible()
  await expect(page).toHaveURL(`/b/${businessId}/purchases/new`)
  // Reloading asks with the browser's own question; staying keeps what was typed.
  const asked = new Promise<string>((resolve) => {
    page.once('dialog', (dialog) => {
      resolve(dialog.type())
      void dialog.dismiss()
    })
  })
  // Staying cancels the reload (its promise ends with it or with this short wait).
  await page.reload({ timeout: 3_000 }).catch(() => undefined)
  expect(await asked).toBe('beforeunload')
  await expect(qty).toHaveValue('2')

  // A settings section: unchanged, a link just goes.
  await page.goto(`/b/${businessId}/settings/business`)
  const name = page.getByRole('textbox', { name: 'Business name', exact: true })
  await expect(name).toHaveValue('Palm Café')
  await nav.getByRole('link', { name: 'Dashboard' }).click()
  await expect(page).toHaveURL(`/b/${businessId}`)
  // Changed: Save saves it, then goes.
  await page.goto(`/b/${businessId}/settings/business`)
  await name.fill('Palm Café & Bakery')
  await nav.getByRole('link', { name: 'Dashboard' }).click()
  await expect(unsaved).toBeVisible()
  await shot(page, 'en-1440-unsaved-settings')
  // The café is VAT-registered without its TRN yet: saving fails, so it stays and says so.
  await unsaved.getByRole('button', { name: 'Save', exact: true }).click()
  const trn = page.getByRole('textbox', { name: 'Tax Registration Number (TRN)' })
  await expect(trn).toHaveAttribute('aria-invalid', 'true')
  await expect(page).toHaveURL(`/b/${businessId}/settings/business`)
  await trn.fill('100123456789003')
  await nav.getByRole('link', { name: 'Dashboard' }).click()
  await unsaved.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Business details saved.')).toBeVisible()
  await expect(page).toHaveURL(`/b/${businessId}`)
  await page.goto(`/b/${businessId}/settings/business`)
  await expect(name).toHaveValue('Palm Café & Bakery')
  // Changed again: Don't save leaves it as it was.
  await name.fill('Something else')
  await nav.getByRole('link', { name: 'Dashboard' }).click()
  await unsaved.getByRole('button', { name: "Don't save" }).click()
  await expect(page).toHaveURL(`/b/${businessId}`)
  await page.goto(`/b/${businessId}/settings/business`)
  await expect(name).toHaveValue('Palm Café & Bakery')

  // The question on a phone, in English.
  await page.setViewportSize(PHONE)
  await name.fill('Palm')
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link').first().click()
  await expect(unsaved).toBeVisible()
  await expectSound(page, 'en')
  await shot(page, 'en-390-unsaved-settings')
  await unsaved.getByRole('button', { name: 'Keep editing' }).click()
  await expect(name).toHaveValue('Palm')
})

test('Arabic, phone: the same question in Arabic, from a sheet, a purchase and the tab bar', async ({
  browser,
}) => {
  test.setTimeout(600_000)
  const { page, businessId } = await open(browser, PHONE, 'ar')
  const unsaved = page.getByRole('alertdialog', { name: 'لديك تغييرات لم تُحفظ' })
  const tabs = page.getByRole('navigation', { name: 'القائمة الرئيسية' })

  await page.goto(`/b/${businessId}/materials`)
  await page.getByRole('button', { name: 'أضف مكوّنًا أو مستلزمًا' }).click()
  const sheet = page.getByRole('dialog', { name: 'مكوّن أو مستلزم جديد' })
  await sheet.getByRole('button', { name: 'إغلاق' }).click()
  await expect(sheet).toHaveCount(0)
  await expect(unsaved).toHaveCount(0)
  await page.getByRole('button', { name: 'أضف مكوّنًا أو مستلزمًا' }).click()
  await sheet.getByRole('textbox', { name: 'الاسم' }).fill('سكر')
  await sheet.getByRole('button', { name: 'إغلاق' }).click()
  await expect(unsaved).toBeVisible()
  await expect(unsaved.getByRole('button', { name: 'حفظ', exact: true })).toBeVisible()
  await expect(unsaved.getByRole('button', { name: 'عدم الحفظ' })).toBeVisible()
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-unsaved-material')
  await unsaved.getByRole('button', { name: 'متابعة التعديل' }).click()
  await expect(sheet.getByRole('textbox', { name: 'الاسم' })).toHaveValue('سكر')
  await sheet.getByRole('button', { name: 'إلغاء' }).click()
  await unsaved.getByRole('button', { name: 'عدم الحفظ' }).click()
  await expect(sheet).toHaveCount(0)

  // A purchase with a quick-add sheet open over it, both changed: Back is about the sheet alone
  // (asked once); Don't save closes it and the purchase stays, its own question still there.
  await page.goto(`/b/${businessId}/purchases/new`)
  await fillMilk(page, { group: 'الصنف 1', material: 'المكوّن أو المستلزم', qty: 'الكمية' })
  await page.getByRole('button', { name: 'أضف مكوّنًا أو مستلزمًا' }).click()
  const second = page.getByRole('group', { name: 'الصنف 2' })
  await second.getByRole('combobox', { name: 'المكوّن أو المستلزم' }).fill('هيل')
  await second.locator('[data-add-option]').click()
  await expect(sheet).toBeVisible()
  await sheet.getByText('الوزن', { exact: true }).click()
  await page.goBack()
  await expect(unsaved).toBeVisible()
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-unsaved-sheet-back')
  await unsaved.getByRole('button', { name: 'عدم الحفظ' }).click()
  await expect(sheet).toHaveCount(0)
  await expect(unsaved).toHaveCount(0)
  await expect(page).toHaveURL(`/b/${businessId}/purchases/new`)
  await page.goBack()
  await expect(unsaved).toBeVisible()
  await unsaved.getByRole('button', { name: 'متابعة التعديل' }).click()
  await expect(page).toHaveURL(`/b/${businessId}/purchases/new`)
  await expect(
    page.getByRole('group', { name: 'الصنف 1' }).getByRole('textbox', { name: 'الكمية' }),
  ).toHaveValue('2')

  // A purchase, left from the tab bar.
  await tabs.getByRole('link', { name: 'الرئيسية' }).click()
  await expect(unsaved).toBeVisible()
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-unsaved-purchase')
  await unsaved.getByRole('button', { name: 'عدم الحفظ' }).click()
  await expect(page).toHaveURL(`/b/${businessId}`)

  // A settings section, on a desktop.
  await page.setViewportSize(DESKTOP)
  await page.goto(`/b/${businessId}/settings/business`)
  await page.getByRole('textbox', { name: 'اسم العمل التجاري', exact: true }).fill('مقهى النخلة')
  await page.getByRole('textbox', { name: 'رقم التسجيل الضريبي (TRN)' }).fill('100123456789003')
  await page
    .getByRole('navigation', { name: 'القائمة الرئيسية' })
    .getByRole('link', { name: 'الرئيسية' })
    .click()
  await expect(unsaved).toBeVisible()
  await expectSound(page, 'ar')
  await shot(page, 'ar-1440-unsaved-settings')
  await unsaved.getByRole('button', { name: 'حفظ', exact: true }).click()
  await expect(page.getByText('تم حفظ بيانات العمل التجاري.')).toBeVisible()
  await expect(page).toHaveURL(`/b/${businessId}`)
})

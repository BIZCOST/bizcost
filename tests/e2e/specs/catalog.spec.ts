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
  callApi,
  createBusiness,
  createUser,
  deleteUser,
  setLanguage,
  signIn,
  useLanguage,
  withValue,
  WORKSHOP_ANSWERS,
  type TestUser,
} from '../helpers'
import { previewBaseURL } from '../stack'

// Materials and Products & Services (ROADMAP.md M2 Step 2), on the development server with the
// dev-only preview (D-125; the `preview` project of playwright.config.ts): the lists with their
// first-time empty states, the sheet on a phone and the side panel on a desktop, a material bought
// in cartons of 12 one-litre bottles with its chain said in words as it is typed, a product and a
// service, editing, searching, a name already used, archiving and bringing back, the business's
// wording (food: "Ingredients & supplies") and what capabilities show (VAT, branches). Numbers are
// typed with Arabic digits in both languages. English on a desktop, Arabic on a phone.

test.describe.configure({ mode: 'serial' })

/** A café that is VAT-registered, with one branch (food wording). */
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
  /\b(?:common|catalog|units|errors|nav|modules)\.[a-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+/

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
): Promise<{ page: Page; user: TestUser }> {
  const user = await createUser(`catalog-${locale}`, { locale: 'en' })
  users.push(user)
  const context = await browser.newContext({
    baseURL: previewBaseURL,
    locale: locale === 'ar' ? 'ar-AE' : 'en-US',
    viewport,
  })
  contexts.push(context)
  // The development server's own badge and overlay are not part of the app.
  await context.addInitScript(() => {
    // A sheet the page adopts: React never removes it, as it may a <style> in <head>.
    const sheet = new CSSStyleSheet()
    sheet.replaceSync('[data-nextjs-dev-overlay] { display: none !important; }')
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
  })
  await useLanguage(context, 'en')
  const page = await context.newPage()
  await signIn(page, user)
  if (locale === 'ar') await setLanguage(page, 'ar')
  return { page, user }
}

/** Where a dialog ends up, once its opening animation is over. */
async function settledBox(dialog: Locator) {
  await dialog.evaluate((element) =>
    Promise.all(element.getAnimations().map((animation) => animation.finished)),
  )
  return (await dialog.boundingBox())!
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

test('English, desktop: a café adds its ingredients and what it sells', async ({ browser }) => {
  const { page } = await open(browser, { width: 1440, height: 900 }, 'en')
  const businessId = await createBusiness(page, 'Moon Café', CAFE_ANSWERS)
  await page.goto(`/b/${businessId}`)

  // The section, named in the food wording (D-118), from the sidebar.
  const nav = page.getByRole('navigation', { name: 'Main' })
  await nav.getByRole('link', { name: 'Ingredients & supplies' }).click()
  await expect(page).toHaveURL(`/b/${businessId}/materials`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Ingredients & supplies')
  await expect(page).toHaveTitle(/^Ingredients & supplies/)
  await expect(nav.getByRole('link', { name: 'Ingredients & supplies' })).toHaveAttribute(
    'aria-current',
    'page',
  )
  // A first-time list says what to add first.
  await expect(
    page.getByRole('heading', { level: 2, name: 'No ingredients or supplies yet' }),
  ).toBeVisible()
  await expect(page.getByText(/^Start with what you buy most often\./)).toBeVisible()
  // Nothing yet: only the card and its one "Add" (D-132).
  await expect(page.getByRole('searchbox')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Add ingredient or supply' })).toHaveCount(1)
  await expectSound(page, 'en')

  // The form: a panel on the end side of a desktop screen.
  await page.getByRole('button', { name: 'Add ingredient or supply' }).first().click()
  const sheet = page.getByRole('dialog', { name: 'New ingredient or supply' })
  await expect(sheet).toBeVisible()
  const panel = await settledBox(sheet)
  expect(Math.round(panel.x + panel.width)).toBe(1440)
  expect(Math.round(panel.height)).toBe(900)

  // Saving an empty form says what is missing, on the fields.
  await sheet.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(sheet.getByText('Enter a name.')).toBeVisible()
  await expect(sheet.getByText('Pick the unit you use it in.')).toBeVisible()
  await expect(sheet.getByRole('textbox', { name: 'Name' })).toBeFocused()

  await sheet.getByRole('textbox', { name: 'Name' }).fill('Milk')
  await sheet.getByRole('combobox', { name: 'Unit you use it in' }).selectOption('l')
  await sheet.getByRole('button', { name: 'Add a pack' }).click()
  const bottle = sheet.getByRole('group', { name: 'Pack 1' })
  await bottle.getByRole('textbox', { name: 'Pack name' }).fill('bottle')
  // Checked as it is typed, by the units engine.
  await bottle.getByRole('textbox', { name: 'How many' }).fill('0')
  await expect(bottle.getByText('Enter a number more than zero.')).toBeVisible()
  await bottle.getByRole('textbox', { name: 'How many' }).fill('١')
  await expect(bottle.getByText('1 bottle = 1 L', { exact: true })).toBeVisible()
  await sheet.getByRole('button', { name: 'Add a pack' }).click()
  const carton = sheet.getByRole('group', { name: 'Pack 2' })
  await carton.getByRole('textbox', { name: 'Pack name' }).fill('carton')
  await carton.getByRole('textbox', { name: 'How many' }).fill('١٢')
  await carton.getByRole('combobox', { name: 'Of' }).selectOption({ label: 'bottle' })
  await expect(carton.getByText('1 carton = 12 bottles = 12 L', { exact: true })).toBeVisible()
  // A pack with the name of another one.
  await sheet.getByRole('button', { name: 'Add a pack' }).click()
  const third = sheet.getByRole('group', { name: 'Pack 3' })
  await third.getByRole('textbox', { name: 'Pack name' }).fill('Bottle')
  await expect(third.getByText('Another pack has this name.')).toBeVisible()
  await third.getByRole('button', { name: 'Remove this pack' }).click()
  await expect(third).toHaveCount(0)

  await sheet.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.getByText(withValue('', 'Milk', ' added.'))).toBeVisible()
  await expect(sheet).toBeHidden()
  const materials = page.getByRole('list', { name: 'Ingredients & supplies' })
  const milk = materials.getByRole('listitem').filter({ hasText: 'Milk' })
  await expect(milk).toContainText('Unit: L')
  await expect(milk).toContainText('1 carton = 12 bottles = 12 L')

  // Edit: cartons of 6 now.
  await milk.getByText('Milk', { exact: true }).click()
  const edit = page.getByRole('dialog', { name: 'Milk' })
  // In the order they were added.
  const editCarton = edit.getByRole('group', { name: 'Pack 2' })
  await expect(editCarton.getByRole('textbox', { name: 'Pack name' })).toHaveValue('carton')
  await editCarton.getByRole('textbox', { name: 'How many' }).fill('٦')
  await expect(editCarton.getByText('1 carton = 6 bottles = 6 L', { exact: true })).toBeVisible()
  await edit.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Changes saved.')).toBeVisible()
  await expect(milk).toContainText('1 carton = 6 bottles = 6 L')
  await expectSound(page, 'en')

  // Products & Services: a product with its price including VAT (the café is VAT-registered).
  await nav.getByRole('link', { name: 'Products & Services' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Products & Services')
  await expect(
    page.getByRole('heading', { level: 2, name: 'No products or services yet' }),
  ).toBeVisible()
  await expect(page.getByText(/^Start with what you sell most\./)).toBeVisible()
  await page.getByRole('button', { name: 'Add product or service' }).first().click()
  let product = page.getByRole('dialog', { name: 'New product or service' })
  await product.getByRole('textbox', { name: 'Name' }).fill('Spanish Latte')
  await expect(product.getByRole('combobox', { name: 'Sold by' })).toHaveValue('piece')
  await product.getByRole('textbox', { name: 'Usual price' }).fill('١٨٫٥')
  await expect(product.getByRole('combobox', { name: 'VAT type' })).toHaveValue('standard')
  await product.getByRole('switch', { name: 'The price includes VAT' }).click()
  // One branch: nothing to choose.
  await expect(product.getByText("Where it's sold")).toHaveCount(0)
  await product.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.getByText(withValue('', 'Spanish Latte', ' added.'))).toBeVisible()
  const products = page.getByRole('list', { name: 'Products & Services' })
  const latte = products.getByRole('listitem').filter({ hasText: 'Spanish Latte' })
  await expect(latte).toContainText('AED 18.50 per piece · incl. VAT')

  // A service, by the hour.
  await page.getByRole('button', { name: 'Add product or service' }).click()
  product = page.getByRole('dialog', { name: 'New product or service' })
  await product.getByText('Service', { exact: true }).click()
  await product.getByRole('textbox', { name: 'Name' }).fill('Latte art class')
  await product.getByRole('combobox', { name: 'Sold by' }).selectOption('h')
  await product.getByRole('textbox', { name: 'Usual price' }).fill('150')
  await product.getByRole('button', { name: 'Add', exact: true }).click()
  const lesson = products.getByRole('listitem').filter({ hasText: 'Latte art class' })
  await expect(lesson).toContainText('Service')
  await expect(lesson).toContainText('AED 150.00 per hour · excl. VAT')

  // A name already used, whatever its case.
  await page.getByRole('button', { name: 'Add product or service' }).click()
  product = page.getByRole('dialog', { name: 'New product or service' })
  await product.getByRole('textbox', { name: 'Name' }).fill('spanish latte')
  await product.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(product.getByText(/^You already have one with this name\./)).toBeVisible()
  await product.getByRole('button', { name: 'Cancel' }).click()
  await expect(product).toBeHidden()

  // Edit the product's price.
  await latte.getByText('Spanish Latte', { exact: true }).click()
  const editProduct = page.getByRole('dialog', { name: 'Spanish Latte' })
  await expect(editProduct.getByRole('textbox', { name: 'Usual price' })).toHaveValue('18.5')
  await editProduct.getByRole('textbox', { name: 'Usual price' }).fill('19')
  await editProduct.getByRole('button', { name: 'Save changes' }).click()
  await expect(latte).toContainText('AED 19.00 per piece · incl. VAT')

  // Search, kept in the address.
  await page.getByRole('searchbox', { name: 'Search' }).fill('ART')
  await expect(page).toHaveURL(/[?&]q=ART/)
  await expect(products.getByRole('listitem')).toHaveCount(1)
  await expect(lesson).toBeVisible()
  await page.getByRole('button', { name: 'Clear search' }).click()
  await expect(products.getByRole('listitem')).toHaveCount(2)

  // Archive the service, find it under Archived, and bring it back.
  await page.getByRole('button', { name: withValue('Options for ', 'Latte art class') }).click()
  await page.getByRole('menuitem', { name: 'Archive' }).click()
  const confirm = page.getByRole('alertdialog', {
    name: withValue('Archive ', 'Latte art class', '?'),
  })
  await confirm.getByRole('button', { name: 'Archive' }).click()
  await expect(page.getByText(withValue('', 'Latte art class', ' archived.'))).toBeVisible()
  await expect(lesson).toHaveCount(0)
  const show = page.getByRole('group', { name: 'Show' })
  await show.getByText('Archived', { exact: true }).click()
  await expect(page).toHaveURL(/[?&]status=archived/)
  await expect(products.getByRole('listitem')).toHaveCount(1)
  await expect(lesson).toContainText('Archived')
  await page.getByRole('button', { name: withValue('Options for ', 'Latte art class') }).click()
  await page.getByRole('menuitem', { name: 'Bring back' }).click()
  await expect(
    page.getByText(withValue('', 'Latte art class', ' is back in your list.')),
  ).toBeVisible()
  await show.getByText('In use', { exact: true }).click()
  await expect(products.getByRole('listitem')).toHaveCount(2)
  await expectSound(page, 'en')
})

test('Arabic, phone: a workshop with branches adds a material, a product and a service', async ({
  browser,
}) => {
  const { page } = await open(browser, { width: 390, height: 844 }, 'ar')
  const businessId = await createBusiness(page, 'Falcon Workshop', WORKSHOP_ANSWERS)
  const branch = await callApi(
    page,
    'location.create',
    { id: randomUUID(), name: 'فرع مردف' },
    { businessId },
  )
  expect(branch.appCode).toBeUndefined()
  await page.goto(`/b/${businessId}/materials`)

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('المواد')
  await expect(page.getByRole('heading', { level: 2, name: 'لا توجد مواد بعد' })).toBeVisible()
  await expectSound(page, 'ar')

  // The form: a sheet from the bottom of a phone.
  await page.getByRole('button', { name: 'أضف مادة' }).first().click()
  const sheet = page.getByRole('dialog', { name: 'مادة جديدة' })
  await expect(sheet).toBeVisible()
  const box = await settledBox(sheet)
  expect(Math.round(box.width)).toBe(390)
  expect(Math.round(box.y + box.height)).toBe(844)

  await sheet.getByRole('textbox', { name: 'الاسم' }).fill('حليب')
  await sheet.getByRole('combobox', { name: 'الوحدة التي تستخدمه بها' }).selectOption('l')
  await sheet.getByRole('button', { name: 'أضف عبوة' }).click()
  const bottle = sheet.getByRole('group', { name: 'العبوة 1' })
  await bottle.getByRole('textbox', { name: 'اسم العبوة' }).fill('زجاجة')
  await bottle.getByRole('textbox', { name: 'الكمية' }).fill('١')
  await expect(bottle.getByText('1 زجاجة = 1 لتر', { exact: true })).toBeVisible()
  await sheet.getByRole('button', { name: 'أضف عبوة' }).click()
  const carton = sheet.getByRole('group', { name: 'العبوة 2' })
  await carton.getByRole('textbox', { name: 'اسم العبوة' }).fill('كرتونة')
  await carton.getByRole('textbox', { name: 'الكمية' }).fill('١٢')
  await carton.getByRole('combobox', { name: 'من' }).selectOption({ label: 'زجاجة' })
  await expect(carton.getByText('1 كرتونة = 12 زجاجة = 12 لتر', { exact: true })).toBeVisible()
  // From 3 to 10, an Arabic pack name is said as a count (D-132); typed digits turn Latin.
  await carton.getByRole('textbox', { name: 'الكمية' }).fill('٦')
  await expect(carton.getByText('1 كرتونة = 6 × زجاجة = 6 لتر', { exact: true })).toBeVisible()
  await carton.getByRole('textbox', { name: 'الكمية' }).blur()
  await expect(carton.getByRole('textbox', { name: 'الكمية' })).toHaveValue('6')
  await carton.getByRole('textbox', { name: 'الكمية' }).fill('١٢')
  await sheet.getByRole('button', { name: 'أضف', exact: true }).click()
  await expect(page.getByText(withValue('تمت إضافة ', 'حليب', '.'))).toBeVisible()
  const materials = page.getByRole('list', { name: 'المواد' })
  const milk = materials.getByRole('listitem').filter({ hasText: 'حليب' })
  await expect(milk).toContainText('1 كرتونة = 12 زجاجة = 12 لتر')

  // Archive it, then bring it back from the archived ones.
  await page.getByRole('button', { name: withValue('خيارات ', 'حليب') }).click()
  await page.getByRole('menuitem', { name: 'أرشفة' }).click()
  await page
    .getByRole('alertdialog', { name: withValue('أرشفة ', 'حليب', '؟') })
    .getByRole('button', { name: 'أرشفة' })
    .click()
  await expect(page.getByText(withValue('تمت أرشفة ', 'حليب', '.'))).toBeVisible()
  await expect(milk).toHaveCount(0)
  const show = page.getByRole('group', { name: 'اعرض' })
  await show.getByText('المؤرشفة', { exact: true }).click()
  await expect(milk).toContainText('مؤرشف')
  await page.getByRole('button', { name: withValue('خيارات ', 'حليب') }).click()
  await page.getByRole('menuitem', { name: 'إرجاع' }).click()
  await expect(page.getByText(withValue('تمت إعادة ', 'حليب', ' إلى قائمتك.'))).toBeVisible()
  await expectSound(page, 'ar')

  // Products & Services from the phone's tab bar.
  const tabs = page.getByRole('navigation', { name: 'القائمة الرئيسية' })
  await expect(tabs.getByRole('link', { name: 'المواد' })).toHaveAttribute('aria-current', 'page')
  // A long section name shows its short name on its tab (D-132).
  await expect(tabs.getByRole('link', { name: 'المنتجات والخدمات' })).toHaveText('المنتجات')
  await tabs.getByRole('link', { name: 'المنتجات والخدمات' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('المنتجات والخدمات')
  await page.getByRole('button', { name: 'أضف منتجًا أو خدمة' }).first().click()
  let product = page.getByRole('dialog', { name: 'منتج أو خدمة جديدة' })
  await product.getByRole('textbox', { name: 'الاسم' }).fill('طاولة خشب')
  await product.getByRole('textbox', { name: 'السعر المعتاد' }).fill('١٬٢٥٠')
  // VAT-registered: VAT is asked; branches: where it is sold.
  await expect(product.getByRole('combobox', { name: 'نوع الضريبة' })).toBeVisible()
  await product.getByText('في بعض الفروع فقط', { exact: true }).click()
  await product.getByRole('button', { name: 'أضف', exact: true }).click()
  await expect(product.getByText('اختر فرعًا واحدًا على الأقل.')).toBeVisible()
  await product.getByRole('checkbox', { name: 'فرع مردف' }).check()
  await product.getByRole('button', { name: 'أضف', exact: true }).click()
  await expect(page.getByText(withValue('تمت إضافة ', 'طاولة خشب', '.'))).toBeVisible()
  const products = page.getByRole('list', { name: 'المنتجات والخدمات' })
  const table = products.getByRole('listitem').filter({ hasText: 'طاولة خشب' })
  await expect(table).toContainText('1,250.00')
  await expect(table).toContainText('لكل قطعة')
  await expect(table).toContainText('فرع واحد')

  // A service, then edit it.
  await page.getByRole('button', { name: 'أضف منتجًا أو خدمة' }).click()
  product = page.getByRole('dialog', { name: 'منتج أو خدمة جديدة' })
  await product.getByText('خدمة', { exact: true }).click()
  await product.getByRole('textbox', { name: 'الاسم' }).fill('تصميم مخصص')
  await product.getByRole('combobox', { name: 'وحدة البيع' }).selectOption('h')
  await product.getByRole('button', { name: 'أضف', exact: true }).click()
  const design = products.getByRole('listitem').filter({ hasText: 'تصميم مخصص' })
  await expect(design).toContainText('خدمة')
  await expect(design).toContainText('بلا سعر معتاد')
  await design.getByText('تصميم مخصص', { exact: true }).click()
  const edit = page.getByRole('dialog', { name: 'تصميم مخصص' })
  await edit.getByRole('textbox', { name: 'السعر المعتاد' }).fill('٢٠٠')
  await edit.getByRole('button', { name: 'احفظ التغييرات' }).click()
  await expect(page.getByText('تم حفظ التغييرات.')).toBeVisible()
  await expect(design).toContainText('200.00')
  await expect(design).toContainText('لكل ساعة')
  await expectSound(page, 'ar')
})

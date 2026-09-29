import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import {
  callApi,
  createBusiness,
  createUser,
  deleteUser,
  nextInvitation,
  setLanguage,
  signIn,
  useLanguage,
  type TestUser,
} from '../helpers'
import { previewBaseURL } from '../stack'

// Recipes and product cost (ROADMAP.md M2 Step 4; D-115, D-117, D-147, D-154), on the development
// server with the dev-only preview (D-125; the `preview` project of playwright.config.ts).
//
// A café writes the owner's Spanish Latte from what it really bought, in Arabic on a phone: beans
// from 1 kg bags, milk from the carton of 12 bottles, condensed milk from a box of 24 cans, a cup, a
// lid and a straw never bought. Each line is said in words as it is typed ("18 غرام = 0.018 كيلو")
// and costed at its average; the straw says "no price yet" (never 0) and the total, AED 2.97, says
// it is incomplete; a line moved down stays there once saved. The API worked out 2.967034632035;
// once the straws are bought it is 3.002034632035, shown AED 3.00. The same screens in English on a
// desktop and a phone. An employee allowed to see recipes sees the quantities and locks. A shop adds
// an item bought ready to sell (English, desktop), buys it in cartons through the purchase editor,
// and its cost is what one piece cost; in Arabic on a phone, "Goods" adds one the same way.

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

const SHOP_ANSWERS = {
  what_you_do: ['sell_products'],
  workplace: 'shop',
  branches: false,
  team: 'team',
  team_tracking: ['salaries', 'staff_cash'],
  work_setup: ['stock', 'vehicles'],
  sales_channels: ['walk_in', 'messages'],
  pos: true,
  vat: 'yes',
}

const RAW_KEY =
  /\b(?:common|catalog|units|errors|nav|modules|purchasing|settings)\.[a-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+/

/** The latte's materials, in the order the recipe keeps them once saved. */
const LATTE = ['حبوب القهوة', 'حليب', 'حليب مكثف', 'كوب', 'غطاء', 'مصاصة']

const users: TestUser[] = []
const contexts: BrowserContext[] = []
let cafe:
  { page: Page; businessId: string; latteId: string; straw: string; strawPack: string } | undefined

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
  const who = user ?? (await createUser(`recipes-${locale}`, { locale: 'en' }))
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

/** Screenshots into E2E_SHOTS_DIR (only when it is set). */
async function shot(page: Page, name: string) {
  const dir = process.env.E2E_SHOTS_DIR
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(dir, `${name}.png`) })
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

async function ok<T>(pending: Promise<{ data?: T; appCode?: string }>, what: string): Promise<T> {
  const result = await pending
  expect(result.appCode, what).toBeUndefined()
  return result.data as T
}

async function material(
  page: Page,
  businessId: string,
  name: string,
  unit: string,
  packs: object[] = [],
): Promise<string> {
  const id = randomUUID()
  await ok(callApi(page, 'material.create', { id, name, unit, packs }, { businessId }), name)
  return id
}

/** A final purchase with no VAT on it (a no-invoice receipt), dated today. */
async function buy(page: Page, businessId: string, lines: object[]) {
  const id = randomUUID()
  const today = await ok(
    callApi<{ today: string }>(page, 'books.get', {}, { businessId, query: true }),
    'books.get',
  )
  const draft = await ok(
    callApi<{ data: { version: number } }>(
      page,
      'purchase.create',
      {
        id,
        businessDate: today.today,
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
    'purchase.post',
  )
}

async function recipeOf(page: Page, businessId: string, productId: string) {
  return ok(
    callApi<{
      data: {
        lines: { materialName: string }[]
        cost: { total: string; unpricedLines: number; complete: boolean }
      }
    }>(page, 'recipe.get', { productId }, { businessId, query: true }),
    'recipe.get',
  )
}

test('Arabic, phone: a café writes the Spanish Latte recipe from its purchases', async ({
  browser,
}) => {
  test.setTimeout(600_000)
  const { page } = await open(browser, PHONE, 'ar')
  const businessId = await createBusiness(page, 'Moon Café', CAFE_ANSWERS)
  const bag = randomUUID()
  const beans = await material(page, businessId, 'حبوب القهوة', 'kg', [
    { id: bag, name: 'كيس', qty: '1', ofUnit: 'kg' },
  ])
  const bottle = randomUUID()
  const carton = randomUUID()
  const milk = await material(page, businessId, 'حليب', 'l', [
    { id: bottle, name: 'زجاجة', qty: '1', ofUnit: 'l' },
    { id: carton, name: 'كرتونة', qty: '12', ofPackId: bottle },
  ])
  const can = randomUUID()
  const box = randomUUID()
  const condensed = await material(page, businessId, 'حليب مكثف', 'l', [
    { id: can, name: 'علبة', qty: '385', ofUnit: 'ml' },
    { id: box, name: 'صندوق', qty: '24', ofPackId: can },
  ])
  const sleeve = randomUUID()
  const cup = await material(page, businessId, 'كوب', 'piece', [
    { id: sleeve, name: 'رزمة', qty: '50', ofUnit: 'piece' },
  ])
  const lidBox = randomUUID()
  const lid = await material(page, businessId, 'غطاء', 'piece', [
    { id: lidBox, name: 'كرتون', qty: '100', ofUnit: 'piece' },
  ])
  const strawPack = randomUUID()
  const straw = await material(page, businessId, 'مصاصة', 'piece', [
    { id: strawPack, name: 'باكيت', qty: '200', ofUnit: 'piece' },
  ])
  // What the café paid: 2 bags of beans at 65 (0.065 a gram), a carton of 12 L of milk at 72 (0.006
  // a ml), a box of 24 cans of condensed milk at 95 (95 ÷ 9 240 ml), 2 sleeves of 50 cups at 12.50
  // (0.25 a cup) and a box of 100 lids at 9 (0.09 a lid). No straws yet.
  await buy(page, businessId, [
    { materialId: beans, qty: '2', packId: bag, unitPrice: '65' },
    { materialId: milk, qty: '1', packId: carton, unitPrice: '72' },
    { materialId: condensed, qty: '1', packId: box, unitPrice: '95' },
    { materialId: cup, qty: '2', packId: sleeve, unitPrice: '12.5' },
    { materialId: lid, qty: '1', packId: lidBox, unitPrice: '9' },
  ])
  const latteId = randomUUID()
  await ok(
    callApi(
      page,
      'product.create',
      { id: latteId, name: 'سبانش لاتيه', type: 'product', unit: 'piece', defaultPrice: '18' },
      { businessId },
    ),
    'product.create',
  )
  cafe = { page, businessId, latteId, straw, strawPack }

  await page.goto(`/b/${businessId}/products`)
  const row = page.getByRole('main').locator('li').filter({ hasText: 'سبانش لاتيه' })
  await expect(row).toContainText('لا وصفة بعد')
  await row.getByRole('button', { name: 'الوصفة', exact: true }).click()
  const sheet = page.getByRole('dialog')
  await expect(sheet).toContainText('سبانش لاتيه')
  await expect(sheet).toContainText('الكميات لكل قطعة')

  const add = sheet.getByRole('button', { name: 'أضف مكوّنًا أو مستلزمًا' })
  const lines = sheet.locator('[data-recipe-line]')
  async function addLine(index: number, name: string, qty: string) {
    await add.click()
    await lines.nth(index).getByLabel('المكوّن أو المستلزم').selectOption({ label: name })
    await lines.nth(index).getByLabel('الكمية').fill(qty)
  }
  // Beans: 18 g typed in Arabic digits, said in words, 1.17 (0.065 a gram).
  await addLine(0, 'حبوب القهوة', '١٨')
  await expect(lines.nth(0).locator('[data-qty-words]')).toHaveText('18 غرام = 0.018 كيلو')
  await expect(lines.nth(0).locator('[data-line-cost]')).toContainText('1.17')
  // Milk: 200 ml of the carton, 1.20.
  await addLine(1, 'حليب', '200')
  await expect(lines.nth(1).locator('[data-qty-words]')).toHaveText('200 مل = 0.2 لتر')
  await expect(lines.nth(1).locator('[data-line-cost]')).toContainText('1.20')
  // Condensed milk: 25 ml of a can, 0.26; its packs are in the unit list, said in words.
  await addLine(2, 'حليب مكثف', '25')
  await expect(lines.nth(2).locator('[data-qty-words]')).toHaveText('25 مل = 0.025 لتر')
  await expect(lines.nth(2).locator('[data-line-cost]')).toContainText('0.26')
  const units = lines.nth(2).getByLabel('الوحدة').locator('option')
  await expect(units.filter({ hasText: 'علبة (0.385 لتر)' })).toHaveCount(1)
  await expect(units.filter({ hasText: 'صندوق (9.24 لتر)' })).toHaveCount(1)
  // A straw never bought: no price yet, never 0.
  await addLine(3, 'مصاصة', '1')
  await expect(lines.nth(3).locator('[data-no-price]')).toHaveText('لا سعر بعد')
  await addLine(4, 'كوب', '1')
  await expect(lines.nth(4).locator('[data-line-cost]')).toContainText('0.25')
  await addLine(5, 'غطاء', '1')
  await expect(lines.nth(5).locator('[data-line-cost]')).toContainText('0.09')
  // A line added by mistake is taken out from its menu.
  await add.click()
  await expect(lines).toHaveCount(7)
  await sheet.getByRole('button', { name: 'خيارات السطر 7' }).click()
  await page.getByRole('menuitem', { name: 'احذف هذا السطر' }).click()
  await expect(lines).toHaveCount(6)
  // The straw goes last: moved down twice from its line's menu.
  for (const number of [4, 5]) {
    await sheet.getByRole('button', { name: `خيارات السطر ${number}` }).click()
    await page.getByRole('menuitem', { name: 'انقله للأسفل' }).click()
  }
  await expect(lines.nth(5).getByLabel('المكوّن أو المستلزم')).toHaveValue(straw)
  await expect(lines.nth(5).locator('[data-no-price]')).toHaveText('لا سعر بعد')
  await sheet.getByRole('button', { name: 'خيارات السطر 1' }).click()
  await expect(page.getByRole('menuitem', { name: 'انقله للأعلى' })).toBeDisabled()
  await expect(page.getByRole('menuitem', { name: 'احذف هذا السطر' })).toBeEnabled()
  await shot(page, 'ar-390-line-menu')
  await page.keyboard.press('Escape')
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  // The total is always in view: 1.17 + 1.20 + 0.26 + 0.25 + 0.09, incomplete, naming the straw.
  await expect(sheet.locator('[data-recipe-total]')).toHaveText(/^\u200f?2\.97\sد\.إ\.\u200f?$/)
  await expect(sheet.locator('[data-recipe-total]')).toBeInViewport()
  await expect(sheet.locator('[data-incomplete]')).toContainText(
    'غير مكتملة: عنصر واحد بلا سعر بعد',
  )
  await expect(sheet.locator('[data-incomplete]')).toContainText('مصاصة')
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-latte-recipe')
  await sheet.getByRole('button', { name: 'احفظ التغييرات' }).click()
  await expect(page.getByText('تم الحفظ.')).toBeVisible()
  await expect(sheet).toHaveCount(0)

  // The list says what one latte's recipe costs, and that it is incomplete.
  const cost = row.locator('[data-product-cost]')
  await expect(cost).toContainText('تكلفة الوصفة:')
  await expect(cost).toContainText('2.97')
  await expect(cost).toContainText('غير مكتملة')
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-products')

  // Saved in the order it was left in; the API's total is exact (never rounded before the screen).
  const saved = await recipeOf(page, businessId, latteId)
  expect(saved.data.lines.map((line) => line.materialName)).toEqual(LATTE)
  expect(saved.data.cost).toEqual({ total: '2.967034632035', unpricedLines: 1, complete: false })

  // The straws are bought (a pack of 200 at 7): complete, 3.002034632035, shown 3.00.
  await buy(page, businessId, [{ materialId: straw, qty: '1', packId: strawPack, unitPrice: '7' }])
  expect((await recipeOf(page, businessId, latteId)).data.cost).toEqual({
    total: '3.002034632035',
    unpricedLines: 0,
    complete: true,
  })
  await page.reload()
  await expect(cost).toHaveAttribute('data-product-cost', 'complete')
  await expect(cost).toContainText('3.00')
  await expect(cost).not.toContainText('غير مكتملة')

  // A desktop: the material cost and the recipe button are columns of the row (to the name's left in
  // Arabic), and the recipe is a table, one row per line, with the same costs.
  await page.setViewportSize(DESKTOP)
  const [nameBox, costBox] = await Promise.all([
    row.getByText('سبانش لاتيه', { exact: true }).boundingBox(),
    cost.boundingBox(),
  ])
  expect((costBox?.x ?? 1e4) + (costBox?.width ?? 0)).toBeLessThan(nameBox?.x ?? 0)
  expect(costBox?.y ?? 1e4).toBeLessThan((nameBox?.y ?? 0) + 40)
  await expectSound(page, 'ar')
  await shot(page, 'ar-1440-products')
  await row.getByRole('button', { name: 'الوصفة', exact: true }).click()
  await expect(lines).toHaveCount(6)
  await expect(lines.nth(5).locator('[data-line-cost]')).toContainText('0.04')
  await expect(sheet.locator('[data-recipe-total]')).toHaveText(/^\u200f?3\.00\sد\.إ\.\u200f?$/)
  await expect(sheet.locator('[data-incomplete]')).toHaveCount(0)
  const [material0, qty0, cost0] = await Promise.all([
    lines.nth(0).getByLabel('المكوّن أو المستلزم').boundingBox(),
    lines.nth(0).getByLabel('الكمية').boundingBox(),
    lines.nth(0).locator('[data-line-cost]').boundingBox(),
  ])
  // One row: the quantity and the cost sit beside the material (to its left in Arabic).
  expect(Math.abs((qty0?.y ?? 0) - (material0?.y ?? 1))).toBeLessThan(4)
  expect((qty0?.x ?? 0) + (qty0?.width ?? 0)).toBeLessThan(material0?.x ?? 0)
  expect(cost0?.x ?? 1e4).toBeLessThan(qty0?.x ?? 0)
  await expectSound(page, 'ar')
  await shot(page, 'ar-1440-latte-recipe')
  await sheet.getByRole('button', { name: 'إلغاء' }).click()
  await expect(sheet).toHaveCount(0)
})

test('English, desktop and phone: the owner reads the latte and its cost', async () => {
  test.setTimeout(600_000)
  if (!cafe) throw new Error('the first test makes the café')
  const { page, businessId } = cafe
  await setLanguage(page, 'en')
  await page.goto(`/b/${businessId}/products`)
  const row = page.getByRole('main').locator('li').filter({ hasText: 'سبانش لاتيه' })
  await expect(row.locator('[data-product-cost]')).toHaveText(
    /^Recipe cost:\sAED\s3\.00\sper\spiece$/,
  )
  await expectSound(page, 'en')
  await shot(page, 'en-1440-products')
  // Beside the sidebar at 1024 px the page is a tablet's width: the cost stays under the price.
  await page.setViewportSize({ width: 1024, height: 768 })
  await expectSound(page, 'en')
  await shot(page, 'en-1024-products')
  await page.setViewportSize(DESKTOP)
  await row.getByRole('button', { name: 'Recipe', exact: true }).click()
  const sheet = page.getByRole('dialog')
  const lines = sheet.locator('[data-recipe-line]')
  await expect(sheet).toContainText('Quantities per piece')
  await expect(lines.nth(0).locator('[data-qty-words]')).toHaveText('18 g = 0.018 kg')
  await expect(lines.nth(0).locator('[data-line-cost]')).toHaveText('AED 1.17')
  await expect(lines.nth(1).locator('[data-line-cost]')).toHaveText('AED 1.20')
  await expect(sheet.locator('[data-recipe-total]')).toHaveText(/^AED\s3\.00$/)
  await expect(sheet).toContainText('average of your purchases of the last 90 days')
  await expectSound(page, 'en')
  await shot(page, 'en-1440-latte-recipe')

  // A phone: each line stacks, and the total stays at the bottom of the screen.
  await page.setViewportSize(PHONE)
  await expect(sheet.locator('[data-recipe-total]')).toBeInViewport()
  const [material0, qty0] = await Promise.all([
    lines.nth(0).getByLabel('Ingredient or supply').boundingBox(),
    lines.nth(0).getByLabel('How much').boundingBox(),
  ])
  expect(qty0?.y ?? 0).toBeGreaterThan((material0?.y ?? 0) + (material0?.height ?? 0))
  // On a phone too, the recipe says its quantities are for one piece, and each caption says so.
  await expect(
    sheet.getByText('Quantities per piece. Costs come from your purchases.'),
  ).toBeVisible()
  await expect(lines.nth(0).getByText('How much per piece')).toBeVisible()
  await expectSound(page, 'en')
  await shot(page, 'en-390-latte-recipe')

  // Saving with nothing changed only closes: no new version.
  await sheet.getByRole('button', { name: 'Save changes' }).click()
  await expect(sheet).toHaveCount(0)
  const version = async () =>
    (
      await ok(
        callApi<{ data: { version: number } }>(
          page,
          'recipe.get',
          { productId: cafe?.latteId },
          { businessId, query: true },
        ),
        'recipe.get',
      )
    ).data.version
  const before = await version()

  // A change not saved is dropped only once confirmed: Escape asks, "Keep editing" keeps it.
  await row.getByRole('button', { name: 'Recipe', exact: true }).click()
  await lines.nth(0).getByLabel('How much').fill('20')
  await page.keyboard.press('Escape')
  const confirm = page.getByRole('alertdialog', { name: 'You have unsaved changes' })
  await confirm.getByRole('button', { name: 'Keep editing' }).click()
  await expect(confirm).toHaveCount(0)
  await expect(lines.nth(0).getByLabel('How much')).toHaveValue('20')
  await sheet.getByRole('button', { name: 'Cancel' }).click()
  await confirm.getByRole('button', { name: "Don't save" }).click()
  await expect(sheet).toHaveCount(0)
  expect(await version()).toBe(before)
  await shot(page, 'en-390-products')
  await setLanguage(page, 'ar')
})

test('Arabic, phone: an employee allowed to see recipes sees the quantities and locks', async ({
  browser,
}) => {
  test.setTimeout(600_000)
  if (!cafe) throw new Error('the first test makes the café')
  const { page: ownerPage, businessId } = cafe
  const roles = await ok(
    callApi<
      { id: string; templateKey: string | null; permissionKeys: string[]; version: number }[]
    >(ownerPage, 'role.list', {}, { businessId, query: true }),
    'role.list',
  )
  const employeeRole = roles.find((role) => role.templateKey === 'employee')
  if (!employeeRole) throw new Error('no Employee role')
  await ok(
    callApi(
      ownerPage,
      'role.updatePermissions',
      {
        id: employeeRole.id,
        version: employeeRole.version,
        // Seeing what goes into each product needs seeing its materials too (D-155).
        permissionKeys: [
          ...employeeRole.permissionKeys,
          'materials.items.view',
          'products.recipes.view',
        ],
      },
      { businessId },
    ),
    'role.updatePermissions',
  )
  const employee = await createUser('recipes-employee')
  users.push(employee)
  await ok(
    callApi(
      ownerPage,
      'invitation.create',
      { id: randomUUID(), email: employee.email, roleId: employeeRole.id, locale: 'en' },
      { businessId },
    ),
    'invitation.create',
  )
  const { token } = await nextInvitation(employee.email)
  const { page } = await open(browser, PHONE, 'ar', employee)
  await ok(callApi(page, 'invitation.accept', { token }), 'invitation.accept')

  await page.goto(`/b/${businessId}/products`)
  const row = page.getByRole('main').locator('li').filter({ hasText: 'سبانش لاتيه' })
  await expect(row.locator('[data-locked="cost"]')).toHaveCount(1)
  await expect(row).not.toContainText('3.00')
  await row.getByRole('button', { name: 'الوصفة', exact: true }).click()
  const sheet = page.getByRole('dialog')
  await expect(sheet).toContainText('يمكنك رؤية الكميات. التكاليف مخفية لدورك.')
  await expect(sheet.locator('[data-recipe-line]')).toHaveCount(6)
  await expect(sheet.locator('[data-recipe-line]').first()).toContainText('18 غرام')
  // A lock on each line and on the total, and no amount anywhere.
  await expect(sheet.locator('[data-locked="cost"]')).toHaveCount(7)
  await expect(sheet).not.toContainText('د.إ')
  await expect(sheet.getByRole('button', { name: 'احفظ التغييرات' })).toHaveCount(0)
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-employee-recipe')
  // The API refuses what the screen doesn't offer.
  expect(
    (
      await callApi(
        page,
        'recipe.save',
        { productId: cafe.latteId, version: 1, lines: [] },
        { businessId },
      )
    ).appCode,
  ).toBe('forbidden')
})

test('English, desktop: a shop adds an item bought ready to sell, buys it and sees its cost', async ({
  browser,
}) => {
  test.setTimeout(600_000)
  const { page } = await open(browser, DESKTOP, 'en')
  const businessId = await createBusiness(page, 'Corner Grocery', SHOP_ANSWERS)
  await page.goto(`/b/${businessId}/products`)
  await page.getByRole('button', { name: 'Add product or service' }).click()
  const sheet = page.getByRole('dialog')
  // A shop: "Bought ready to sell" is on, with the packs it is bought in.
  await expect(sheet.getByRole('switch', { name: 'Bought ready to sell' })).toBeChecked()
  await sheet.getByLabel('Name', { exact: true }).fill('Water 500 ml')
  await sheet.getByRole('button', { name: 'Add a pack' }).click()
  await sheet.getByLabel('Pack name').fill('carton')
  await sheet.getByLabel('How many').fill('24')
  await expect(sheet.locator('[data-chain]')).toHaveText(/^1\scarton\s=\s24\spieces$/)
  await sheet.getByLabel('Usual price').fill('1.5')
  await expectSound(page, 'en')
  await shot(page, 'en-1440-shop-new-item')
  await sheet.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(sheet).toHaveCount(0)
  const row = page.getByRole('main').locator('li').filter({ hasText: 'Water 500 ml' })
  await expect(row).toContainText('Bought ready to sell')
  await expect(row.locator('[data-product-cost]')).toHaveText(/^Cost:\sno price yet$/)
  // No recipe for it.
  await expect(row.getByRole('button', { name: 'Items used' })).toHaveCount(0)

  // One record: the same item in Goods, tagged, with its carton.
  const nav = page.getByRole('navigation', { name: 'Main' })
  await nav.getByRole('link', { name: 'Goods' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Goods')
  await expect(page.getByRole('button', { name: 'Add an item' })).toBeVisible()
  const goods = page.getByRole('main').locator('li').filter({ hasText: 'Water 500 ml' })
  await expect(goods).toContainText('Sold as it is')
  await expect(goods).toContainText(/1\scarton\s=\s24\spieces/)
  await expectSound(page, 'en')
  await shot(page, 'en-1440-goods')

  // Bought in the purchase editor, in the shop's words: 3 cartons at AED 12 (VAT reclaimed).
  await nav.getByRole('link', { name: 'Purchases' }).click()
  await page.getByRole('link', { name: 'New purchase' }).click()
  const line = page.getByRole('group', { name: 'Item 1' })
  // The item is typed and picked from the list.
  await line.getByRole('combobox', { name: 'Item' }).fill('water')
  await page.getByRole('option', { name: 'Water 500 ml', exact: true }).click()
  await expect(line.getByRole('combobox', { name: 'Unit' })).toHaveValue(/^pack:/)
  await line.getByRole('textbox', { name: 'Quantity' }).fill('3')
  await line.getByRole('textbox', { name: 'Price per carton before VAT' }).fill('12')
  await page.getByRole('combobox', { name: 'How it was paid' }).selectOption({ label: 'Card' })
  await page.getByRole('button', { name: 'Finalize' }).click()
  await page
    .getByRole('alertdialog', { name: 'Finalize this purchase?' })
    .getByRole('button', { name: 'Finalize' })
    .click()
  await expect(page.getByText('Final', { exact: true }).first()).toBeVisible()

  // One bottle costs what it was bought for: 12 ÷ 24 = AED 0.50.
  await nav.getByRole('link', { name: 'Products & Services' }).click()
  await expect(row.locator('[data-product-cost]')).toHaveText(/^Cost:\sAED\s0\.50\sper\spiece$/)
  await expectSound(page, 'en')
  await shot(page, 'en-1440-shop-products')

  // Editing it: it stays a product, sold by the piece like its packs.
  await row.getByRole('button').first().click()
  await expect(sheet.getByRole('radio', { name: /Service/ })).toHaveCount(0)
  await expect(sheet).toContainText('Its name and unit change in Goods too.')
  await expect(sheet.getByLabel('Sold by').locator('option:not([disabled])')).toHaveText(['Piece'])
  await expectSound(page, 'en')
  await shot(page, 'en-1440-shop-item-edit')
  await sheet.getByRole('button', { name: 'Cancel' }).click()

  // The same on a phone.
  await page.setViewportSize(PHONE)
  await expect(row.locator('[data-product-cost]')).toHaveText(/^Cost:\sAED\s0\.50\sper\spiece$/)
  await expectSound(page, 'en')
  await shot(page, 'en-390-shop-products')
})

test('Arabic, phone: a shop adds an item to sell from Goods', async ({ browser }) => {
  test.setTimeout(600_000)
  const { page } = await open(browser, PHONE, 'ar')
  const businessId = await createBusiness(page, 'بقالة الحي', SHOP_ANSWERS)
  await page.goto(`/b/${businessId}/materials`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('البضاعة')
  await expect(page.getByRole('heading', { level: 2, name: 'لا توجد بضاعة بعد' })).toBeVisible()
  await page.getByRole('button', { name: 'أضف صنفًا' }).click()
  // "Add an item" is the product form, bought ready to sell: no switch, no type.
  const sheet = page.getByRole('dialog', { name: 'صنف جديد' })
  await expect(sheet.getByRole('switch', { name: 'تشتريه جاهزًا لتبيعه' })).toHaveCount(0)
  await expect(sheet.getByRole('radio')).toHaveCount(0)
  await sheet.getByLabel('الاسم', { exact: true }).fill('عصير برتقال')
  await sheet.getByRole('button', { name: 'أضف عبوة' }).click()
  await sheet.getByLabel('اسم العبوة').fill('كرتونة')
  await sheet.getByLabel('الكمية', { exact: true }).fill('١٢')
  await expect(sheet.locator('[data-chain]')).toHaveText(/^1\sكرتونة\s=\s12\s\S+$/)
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-shop-new-item')
  await sheet.getByRole('button', { name: 'أضف', exact: true }).click()
  await expect(sheet).toHaveCount(0)
  const goods = page.getByRole('main').locator('li').filter({ hasText: 'عصير برتقال' })
  await expect(goods).toContainText('يُباع كما هو')
  await expect(page.getByRole('button', { name: 'أضف مستلزمًا تستخدمه' })).toBeVisible()
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-goods')

  // Bought: 2 cartons at 30, so one bottle costs 2.50.
  const materials = await ok(
    callApi<{ items: { id: string; name: string }[] }>(
      page,
      'material.list',
      {},
      { businessId, query: true },
    ),
    'material.list',
  )
  const juice = materials.items.find((item) => item.name === 'عصير برتقال')
  const detail = await ok(
    callApi<{ packs: { id: string }[] }>(
      page,
      'material.get',
      { id: juice?.id },
      { businessId, query: true },
    ),
    'material.get',
  )
  await buy(page, businessId, [
    { materialId: juice?.id, qty: '2', packId: detail.packs[0]?.id, unitPrice: '30' },
  ])
  await page.goto(`/b/${businessId}/products`)
  const row = page.getByRole('main').locator('li').filter({ hasText: 'عصير برتقال' })
  await expect(row).toContainText('يُشترى جاهزًا')
  await expect(row.locator('[data-product-cost]')).toHaveText(
    /^التكلفة:\s\u200f?2\.50\sد\.إ\.\u200f?\sلكل\sقطعة$/,
  )
  await expectSound(page, 'ar')
  await shot(page, 'ar-390-shop-products')
  await page.setViewportSize(DESKTOP)
  await page.goto(`/b/${businessId}/materials`)
  await expect(goods).toContainText('يُباع كما هو')
  await expectSound(page, 'ar')
  await shot(page, 'ar-1440-goods')
})

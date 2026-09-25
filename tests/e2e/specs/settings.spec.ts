import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import {
  BAKER_ANSWERS,
  callApi,
  createBusiness,
  createUser,
  deleteUser,
  pngImage,
  setLanguage,
  signIn,
  useLanguage,
  type TestUser,
} from '../helpers'
import { baseURL } from '../stack'

// Settings of a business (ROADMAP.md Step 6), as its owner: a solo home bakery sees only its own
// sections; the business profile (names, VAT and TRN), the logo, Customize BizCost (dependency
// warnings, Team and Branches appearing, the branches guard) and the business language; Arabic.
// One signed-in page for the whole file (the local Auth server limits sign-ins per IP).

test.describe.configure({ mode: 'serial' })

let owner: TestUser
let context: BrowserContext
let page: Page
let businessId: string

test.beforeAll(async ({ browser }) => {
  owner = await createUser('settings')
  context = await browser.newContext({ baseURL, locale: 'en-US' })
  await useLanguage(context, 'en')
  page = await context.newPage()
  await signIn(page, owner)
  businessId = await createBusiness(page, 'Maha Bakes', BAKER_ANSWERS)
})

test.afterAll(async () => {
  await context?.close()
  await deleteUser(owner?.id)
})

const settings = (path = '') => `/b/${businessId}/settings${path}`

function sectionLinks(p: Page) {
  return p.getByRole('list', { name: 'Business settings' }).getByRole('link')
}

test('a solo home business sees only its own settings; team screens are refused', async () => {
  await page.goto(`/b/${businessId}`)
  await page.getByRole('link', { name: 'Settings' }).click()
  await expect(page).toHaveURL(settings())
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
  await expect(sectionLinks(page)).toHaveText([
    /^Business profile/,
    /^Customize BizCost/,
    /^Language/,
  ])
  await expect(page.getByRole('link', { name: /^Your account/ })).toHaveAttribute(
    'href',
    '/account',
  )

  // A typed link to a hidden section says so; the API refuses it too.
  await page.goto(settings('/members'))
  await expect(page.getByRole('heading', { name: "This section isn't open to you" })).toBeVisible()
  expect((await callApi(page, 'member.list', {}, { businessId, query: true })).appCode).toBe(
    'capability_disabled',
  )
  expect((await callApi(page, 'location.list', {}, { businessId, query: true })).appCode).toBe(
    'capability_disabled',
  )
})

test('business profile: name, VAT and TRN (checked, and saved as 15 digits)', async () => {
  await page.goto(settings('/business'))
  await expect(page.getByRole('heading', { level: 1, name: 'Business profile' })).toBeVisible()
  const name = page.getByRole('textbox', { name: 'Business name', exact: true })
  await expect(name).toHaveValue('Maha Bakes')
  const save = page.getByRole('button', { name: 'Save changes' })
  await expect(save).toBeDisabled()

  await name.fill('Maha Bakes & Co')
  await page.getByRole('textbox', { name: 'Business name in Arabic' }).fill('مها للحلويات')
  const vat = page.getByRole('switch', { name: 'Registered for VAT' })
  await expect(vat).not.toBeChecked()
  await vat.click()
  await expect(page.getByText('When you save, the sections that use VAT')).toBeVisible()
  const trn = page.getByRole('textbox', { name: 'Tax Registration Number (TRN)' })

  await save.click()
  await expect(page.getByText('Enter your TRN.')).toBeVisible()
  await trn.fill('12345')
  await save.click()
  await expect(page.getByText('A TRN has 15 digits.')).toBeVisible()
  await expect(trn).toHaveAttribute('aria-invalid', 'true')
  // Arabic-Indic digits and dashes are accepted; the API stores the 15 digits.
  await trn.fill('١٠٠-١٢٣٤-٥٦٧٠-٠٠٠٣')
  await save.click()
  await expect(page.getByText('Business details saved.')).toBeVisible()
  await expect(page.getByText(/^Also turned on: .*VAT Center/)).toBeVisible()

  await page.reload()
  await expect(trn).toHaveValue('100123456700003')
  await expect(vat).toBeChecked()
  // The header's switcher shows the new name.
  await expect(
    page.getByRole('button', { name: /Switch business: .*Maha Bakes & Co/ }),
  ).toBeVisible()
  await expect(page.getByText('United Arab Emirates', { exact: true })).toBeVisible()
})

test('logo: upload with a preview, replace, refuse other types, remove', async () => {
  await page.goto(settings('/business'))
  const logo = page.getByTestId('business-logo')
  await expect(page.getByText('No logo', { exact: true })).toBeVisible()
  const input = page.locator('input[type=file]')

  await input.setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: pngImage() })
  await expect(page.getByText('Logo saved.')).toBeVisible()
  await expect(logo).toHaveAttribute('src', /\/storage\/v1\/object\/sign\/business-files\//)
  await expect
    .poll(() => logo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
    .toBe(64)
  const first = await logo.getAttribute('src')

  await input.setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: pngImage(48) })
  await expect
    .poll(async () => {
      const src = (await logo.getAttribute('src')) ?? ''
      return src !== first && src.includes('/storage/v1/object/sign/business-files/')
    })
    .toBe(true)
  await expect
    .poll(() => logo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
    .toBe(48)

  // Checked before anything is uploaded.
  await input.setInputFiles({
    name: 'logo.gif',
    mimeType: 'image/gif',
    buffer: Buffer.from('GIF89a'),
  })
  await expect(
    page.getByRole('alert').filter({ hasText: 'Use a PNG, JPG or WebP image.' }),
  ).toBeVisible()
  await input.setInputFiles({
    name: 'big.png',
    mimeType: 'image/png',
    buffer: Buffer.concat([pngImage(), Buffer.alloc(2 * 1024 * 1024)]),
  })
  await expect(page.getByText('This image is larger than 2 MB.')).toBeVisible()

  await page.getByRole('button', { name: 'Remove logo' }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Remove the logo?' })
  await dialog.getByRole('button', { name: 'Remove logo' }).click()
  await expect(page.getByText('Logo removed.')).toBeVisible()
  await expect(page.getByText('No logo', { exact: true })).toBeVisible()
  expect(
    (
      await callApi<{ logoUrl: string | null }>(
        page,
        'business.profile',
        {},
        { businessId, query: true },
      )
    ).data?.logoUrl,
  ).toBeNull()
})

test('Customize BizCost: dependency warnings, Team and Branches appear, guards', async () => {
  await page.goto(settings('/modules'))
  await expect(page.getByRole('heading', { level: 1, name: 'Customize BizCost' })).toBeVisible()
  await expect(page.getByText('Turning something off only hides it.')).toBeVisible()

  // Turning off a section others need asks first, and names them.
  await page.getByRole('button', { name: 'Show' }).first().click()
  const products = page.locator('[data-item="products"]').getByRole('switch')
  const orders = page.locator('[data-item="orders"]').getByRole('switch')
  await expect(orders).toBeChecked()
  await products.click()
  let confirm = page.getByRole('alertdialog', { name: /Turn off .*Products & Services/ })
  // Invoices came with VAT (the profile test above).
  await expect(confirm.getByRole('listitem')).toHaveText(['Orders', 'Invoices'])
  await confirm.getByRole('button', { name: 'Cancel' }).click()
  await expect(products).toBeChecked()
  await products.click()
  confirm = page.getByRole('alertdialog', { name: /Turn off .*Products & Services/ })
  await confirm.getByRole('button', { name: 'Turn off' }).click()
  await expect(products).not.toBeChecked()
  await expect(orders).not.toBeChecked()
  await expect(page.locator('[data-item="products"]').getByText('Also turned off:')).toBeVisible()

  // Team on: the team screens appear.
  const team = page.getByRole('switch', { name: 'Team', exact: true })
  await team.click()
  await expect(team).toBeChecked()
  await expect(team).toHaveAccessibleDescription('Others work with you')
  await expect(page.locator('[data-item="capability:has_team"]').getByRole('listitem')).toHaveText([
    'Employees',
  ])

  // Branches on: add one, and the switch can't be turned off while it is there.
  const branches = page.getByRole('switch', { name: 'Branches', exact: true })
  await branches.click()
  await expect(branches).toBeChecked()
  await page.goto(settings())
  await expect(sectionLinks(page)).toHaveText([
    /^Business profile/,
    /^Branches/,
    /^Team/,
    /^Roles/,
    /^Customize BizCost/,
    /^Language/,
  ])
  await sectionLinks(page).filter({ hasText: 'Branches' }).click()
  await page.getByRole('button', { name: 'Add branch' }).click()
  const add = page.getByRole('dialog', { name: 'Add a branch' })
  await add.getByRole('button', { name: 'Add branch' }).click()
  await expect(add.getByText('Enter a name for the branch.')).toBeVisible()
  await add.getByRole('textbox', { name: 'Branch name' }).fill('Mirdif shop')
  await add.getByRole('button', { name: 'Add branch' }).click()
  await expect(page.getByText(/Mirdif shop⁩? added\./)).toBeVisible()
  await expect(page.locator('[data-location]')).toHaveCount(2)

  await page.goto(settings('/modules'))
  await expect(branches).toBeDisabled()
  await expect(page.getByText('To turn this off, first remove the other branches')).toBeVisible()

  await page.goto(settings('/locations'))
  const mirdif = page.locator('[data-location="Mirdif shop"]')
  await mirdif.getByRole('button', { name: /Options for/ }).click()
  await page.getByRole('menuitem', { name: 'Remove branch' }).click()
  await page
    .getByRole('alertdialog', { name: /Remove .*Mirdif shop/ })
    .getByRole('button', { name: 'Remove branch' })
    .click()
  await expect(page.locator('[data-location]')).toHaveCount(1)

  await page.goto(settings('/modules'))
  await branches.click()
  await expect(branches).not.toBeChecked()
  // Team off again (no one else in it): Employees goes too, after a warning.
  await team.click()
  confirm = page.getByRole('alertdialog', { name: /Turn off .*Team/ })
  await expect(confirm.getByRole('listitem')).toHaveText(['Employees'])
  await confirm.getByRole('button', { name: 'Turn off' }).click()
  await expect(team).not.toBeChecked()
  await page.goto(settings())
  await expect(sectionLinks(page)).toHaveText([
    /^Business profile/,
    /^Customize BizCost/,
    /^Language/,
  ])
})

test('business language: saved for the invitations', async () => {
  await page.goto(settings('/language'))
  const arabic = page.getByRole('radio', { name: 'العربية' })
  await expect(page.getByRole('radio', { name: 'English' })).toBeChecked()
  await page.locator('label').filter({ has: arabic }).click()
  await expect(page.getByText('Business language saved.')).toBeVisible()
  await page.reload()
  await expect(arabic).toBeChecked()
  await expect(page.getByRole('link', { name: 'Change in your account' })).toHaveAttribute(
    'href',
    '/account#language',
  )
})

test('in Arabic, right to left', async () => {
  await setLanguage(page, 'ar')
  await page.goto(settings())
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
  await expect(page.getByRole('heading', { level: 1, name: 'الإعدادات' })).toBeVisible()
  await expect(
    page.getByRole('list', { name: 'إعدادات العمل التجاري' }).getByRole('link'),
  ).toHaveText([/^بيانات العمل التجاري/, /^تخصيص BizCost/, /^اللغة/])
  await page.goto(settings('/business'))
  const trn = page.getByRole('textbox', { name: 'رقم التسجيل الضريبي (TRN)' })
  await expect(trn).toHaveValue('100123456700003')
  await expect(trn).toHaveAttribute('dir', 'ltr')
  await trn.fill('1001234')
  await page.getByRole('button', { name: 'حفظ التغييرات' }).click()
  await expect(page.getByText('يتكون رقم التسجيل الضريبي من 15 رقمًا.')).toBeVisible()
  await page.goto(settings('/modules'))
  await expect(page.getByRole('heading', { level: 1, name: 'تخصيص BizCost' })).toBeVisible()
  await expect(page.getByRole('switch', { name: 'الفريق', exact: true })).not.toBeChecked()
  await setLanguage(page, 'en')
})

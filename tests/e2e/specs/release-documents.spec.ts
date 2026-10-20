import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import {
  BAKER_ANSWERS,
  callApi,
  createBusiness,
  createUser,
  deleteUser,
  nextInvitation,
  RAW_KEY,
  setLanguage,
  signIn,
  useLanguage,
  WORKSHOP_ANSWERS,
  type TestUser,
} from '../helpers'
import { baseURL } from '../stack'

// Release B (ROADMAP.md M3 Step 9): Quotations and Invoices released, on the production build without
// the dev-only preview:
//   - the shell per role: Quotations and Invoices in the sidebar's "Sales" group, "Add new" with New
//     quotation and New invoice (each only for who may prepare it), and on a phone Invoices in the
//     Sales place of a business that invoices without orders (Q14): the owner Home | Invoices | + |
//     Costs | More, the accountant "+" with New invoice only, the supervisor neither (Sales keeps its
//     place);
//   - Customize BizCost without "Soon" for them;
//   - the branch of a new quotation and a new invoice for a business with branches (the capability
//     audit);
//   - an issued tax invoice's PDF downloads;
//   - an orders-only business's customer statement (B10): its delivered orders and payments, "Orders
//     and sales" and "Payments and refunds", and its PDF.
// Arabic and English, phone and desktop. With E2E_SHOTS_DIR set, each step leaves a screenshot there.

test.describe.configure({ mode: 'serial' })

const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1440, height: 900 }

/** A fit-out company with a team and VAT: Quotations and Invoices on, no Orders. */
const FITOUT_ANSWERS = {
  what_you_do: ['projects'],
  workplace: 'customer_sites',
  branches: false,
  team: 'team',
  team_tracking: ['hours'],
  work_setup: ['materials'],
  vat: 'yes',
}

const users: TestUser[] = []
const contexts: BrowserContext[] = []

let owner: Page
let accountant: Page
let supervisor: Page
let fitOutId: string
let bakerId: string
let workshopId: string

async function openAs(browser: Browser, user: TestUser, displayName: string): Promise<Page> {
  const context = await browser.newContext({
    baseURL,
    locale: 'en-US',
    viewport: DESKTOP,
    acceptDownloads: true,
  })
  contexts.push(context)
  await useLanguage(context, 'en')
  const page = await context.newPage()
  await signIn(page, user)
  expect((await callApi(page, 'account.updateProfile', { displayName })).appCode).toBeUndefined()
  return page
}

async function ok<T>(pending: Promise<{ data?: T; appCode?: string }>, what: string): Promise<T> {
  const result = await pending
  expect(result.appCode, what).toBeUndefined()
  return result.data as T
}

async function joinTeam(businessId: string, member: Page, user: TestUser, templateKey: string) {
  const roles = await ok(
    callApi<{ id: string; templateKey: string | null }[]>(
      owner,
      'role.list',
      {},
      { businessId, query: true },
    ),
    'role.list',
  )
  const role = roles.find((r) => r.templateKey === templateKey)
  expect(role).toBeDefined()
  await ok(
    callApi(
      owner,
      'invitation.create',
      { id: randomUUID(), email: user.email, roleId: role!.id, locale: 'en' },
      { businessId },
    ),
    'invitation.create',
  )
  const { token } = await nextInvitation(user.email)
  await ok(callApi(member, 'invitation.accept', { token }), 'invitation.accept')
}

async function today(businessId: string): Promise<string> {
  return (
    await ok(
      callApi<{ today: string }>(owner, 'books.get', {}, { businessId, query: true }),
      'books.get',
    )
  ).today
}

test.beforeAll(async ({ browser }) => {
  const ownerUser = await createUser('release-b-owner', { locale: 'en' })
  const accountantUser = await createUser('release-b-accountant', { locale: 'en' })
  const supervisorUser = await createUser('release-b-supervisor', { locale: 'en' })
  users.push(ownerUser, accountantUser, supervisorUser)
  owner = await openAs(browser, ownerUser, 'Hamad Saleh')
  accountant = await openAs(browser, accountantUser, 'Rana Odeh')
  supervisor = await openAs(browser, supervisorUser, 'Faisal Nasser')
  fitOutId = await createBusiness(owner, 'Cedar Interiors', FITOUT_ANSWERS)
  bakerId = await createBusiness(owner, 'Sweet Crumbs', BAKER_ANSWERS)
  workshopId = await createBusiness(owner, 'Oak & Iron Joinery', WORKSHOP_ANSWERS)
  await joinTeam(fitOutId, accountant, accountantUser, 'accountant')
  await joinTeam(fitOutId, supervisor, supervisorUser, 'supervisor')
})

test.afterAll(async () => {
  for (const context of contexts) await context.close()
  for (const user of users) await deleteUser(user.id)
})

/** A screenshot into E2E_SHOTS_DIR (only when it is set). */
async function shot(page: Page, name: string) {
  const dir = process.env.E2E_SHOTS_DIR
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(dir, `release-b-${name}.png`) })
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
    await download.saveAs(join(dir, `release-b-${name}.pdf`))
  }
  return bytes
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

/** An amount as the page writes it in English: "AED 6.00". */
const aed = (value: string) => new RegExp(`AED\\s${value.replace(/[.]/g, '\\.')}`)

const mainNav = (page: Page, name = 'Main') => page.getByRole('navigation', { name })

/** The "Add new" menu's items, once it is open. */
async function addNew(page: Page, nav: ReturnType<typeof mainNav>, name = 'Add new') {
  await nav.getByRole('button', { name }).click()
  await expect(page.getByRole('menuitem').first()).toBeVisible()
  return page.getByRole('menuitem').allTextContents()
}

// ---------------------------------------------------------------------------------------------------
// The shell per role (Q10, Q14)
// ---------------------------------------------------------------------------------------------------

test('the fit-out owner: Quotations and Invoices in the Sales group, "+" with both, Home | Invoices | + | Costs | More', async () => {
  await owner.setViewportSize(DESKTOP)
  await owner.goto(`/b/${fitOutId}`)
  const nav = mainNav(owner)
  await expect(nav.getByRole('list', { name: 'Sales' }).getByRole('link')).toHaveText([
    'Sales',
    'Customers',
    'What customers owe',
    'Quotations',
    'Invoices',
  ])
  const items = await addNew(owner, nav)
  expect(items.slice(-3)).toEqual(['New customer', 'New quotation', 'New invoice'])
  await expectSound(owner, 'en')
  await shot(owner, 'en-1440-fitout-add-new')
  await owner.getByRole('menuitem', { name: 'New quotation' }).click()
  await expect(owner).toHaveURL(`/b/${fitOutId}/quotations/new`)
  await expect(owner.getByRole('heading', { level: 1, name: 'New quotation' })).toBeVisible()
  await expect(nav.getByRole('link', { name: 'Quotations', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  )
  // One location: no branch to choose.
  await expect(owner.locator('[data-document-branch]')).toHaveCount(0)
  await nav.getByRole('button', { name: 'Add new' }).click()
  await owner.getByRole('menuitem', { name: 'New invoice' }).click()
  await expect(owner).toHaveURL(`/b/${fitOutId}/invoices/new`)
  await expect(owner.getByRole('heading', { level: 1, name: 'New invoice' })).toBeVisible()
  await expect(owner.locator('[data-document-branch]')).toHaveCount(0)

  // On a phone, in Arabic: Invoices takes the Sales place (Q14); Sales and Quotations under "More".
  await setLanguage(owner, 'ar')
  await owner.setViewportSize(PHONE)
  await owner.goto(`/b/${fitOutId}`)
  const bar = mainNav(owner, 'القائمة الرئيسية')
  await expect(bar.getByRole('listitem')).toHaveCount(5)
  await expect(bar.getByRole('link')).toHaveText(['الرئيسية', 'الفواتير', 'التكاليف'])
  const phoneItems = await addNew(owner, bar, 'إضافة جديد')
  expect(phoneItems.slice(-2)).toEqual(['عرض سعر جديد', 'فاتورة جديدة'])
  await expectSound(owner, 'ar')
  await shot(owner, 'ar-390-fitout-add-new')
  await owner.keyboard.press('Escape')
  await bar.getByRole('button', { name: 'المزيد' }).click()
  const more = await owner.getByRole('menuitem').allTextContents()
  expect(more).toEqual(expect.arrayContaining(['المبيعات', 'العملاء', 'عروض الأسعار']))
  expect(more).not.toContain('الفواتير')
  await shot(owner, 'ar-390-fitout-more')
  await owner.keyboard.press('Escape')
  await bar.getByRole('link', { name: 'الفواتير' }).click()
  await expect(owner).toHaveURL(`/b/${fitOutId}/invoices`)
  await expect(bar.getByRole('link', { name: 'الفواتير' })).toHaveAttribute('aria-current', 'page')
  await expect(owner.getByRole('heading', { level: 1, name: 'الفواتير' })).toBeVisible()
  await expectSound(owner, 'ar')
  await setLanguage(owner, 'en')
  await owner.setViewportSize(DESKTOP)
})

test('the fit-out accountant: "+" with New invoice only, Invoices in the Sales place', async () => {
  await accountant.setViewportSize(PHONE)
  await accountant.goto(`/b/${fitOutId}`)
  const bar = mainNav(accountant)
  // One action: "+" goes straight to it (a link named for it, D-195), between Invoices and Costs.
  await expect(bar.getByRole('link')).toHaveText(['Dashboard', 'Invoices', '', 'Costs'])
  await expect(bar.getByRole('link').nth(2)).toHaveAccessibleName('New invoice')
  await expect(bar.getByRole('button', { name: 'Add new' })).toHaveCount(0)
  await expectSound(accountant, 'en')
  await shot(accountant, 'en-390-accountant-tabs')
  await bar.getByRole('link', { name: 'New invoice' }).click()
  await expect(accountant).toHaveURL(`/b/${fitOutId}/invoices/new`)
  await expect(accountant.getByRole('heading', { level: 1, name: 'New invoice' })).toBeVisible()
  await accountant.setViewportSize(DESKTOP)
  await accountant.goto(`/b/${fitOutId}`)
  const nav = mainNav(accountant)
  await expect(nav.getByRole('list', { name: 'Sales' }).getByRole('link')).toHaveText([
    'Sales',
    'Customers',
    'What customers owe',
    'Quotations',
    'Invoices',
  ])
})

test('the fit-out supervisor: neither Quotations nor Invoices, Sales keeps its place', async () => {
  await supervisor.setViewportSize(PHONE)
  await supervisor.goto(`/b/${fitOutId}`)
  const bar = mainNav(supervisor)
  await expect(bar.getByRole('link').nth(1)).toHaveText('Sales')
  const items = await addNew(supervisor, bar)
  expect(items).not.toContain('New quotation')
  expect(items).not.toContain('New invoice')
  await supervisor.keyboard.press('Escape')
  await supervisor.setViewportSize(DESKTOP)
  await supervisor.goto(`/b/${fitOutId}`)
  const links = await mainNav(supervisor).getByRole('link').allTextContents()
  expect(links).not.toContain('Quotations')
  expect(links).not.toContain('Invoices')
  await supervisor.goto(`/b/${fitOutId}/invoices`)
  await expect(
    supervisor.getByRole('heading', { name: "This page isn't open to you" }),
  ).toBeVisible()
})

test('Customize BizCost: Quotations and Invoices without "Soon"', async () => {
  await owner.setViewportSize(DESKTOP)
  await owner.goto(`/b/${fitOutId}/settings/modules`)
  await expect(owner.getByRole('heading', { level: 1 })).toHaveText('Customize BizCost')
  await expect(owner.locator('[data-item]').first()).toBeVisible()
  const show = owner.getByRole('main').getByRole('button', { name: 'Show', exact: true })
  while ((await show.count()) > 0) await show.first().click()
  for (const id of ['quotations', 'invoices']) {
    await expect(owner.locator(`[data-item="${id}"]`), id).toBeVisible()
    await expect(owner.locator(`[data-item="${id}"]`), id).not.toContainText('Soon')
  }
  // A module of a later phase keeps it (VAT Center, for a VAT-registered business).
  await expect(owner.locator('[data-item="vat_center"]')).toContainText('Soon')
  await expectSound(owner, 'en')
  await shot(owner, 'en-1440-customize')
})

test('a business with branches picks the branch of a new quotation and a new invoice', async () => {
  const sharjah = randomUUID()
  await ok(
    callApi(
      owner,
      'location.create',
      { id: sharjah, name: 'Sharjah workshop' },
      {
        businessId: workshopId,
      },
    ),
    'location.create',
  )
  // Two channels, as a café's shop and delivery app (Release B review): the branch list is read on
  // one of them, never refused for naming none.
  await ok(
    callApi(
      owner,
      'channel.create',
      { id: randomUUID(), name: 'Website', kind: 'website' },
      { businessId: workshopId },
    ),
    'channel.create',
  )
  await owner.setViewportSize(DESKTOP)
  for (const path of ['quotations/new', 'invoices/new']) {
    await owner.goto(`/b/${workshopId}/${path}`)
    const branch = owner.getByRole('combobox', { name: 'Branch' })
    await expect(branch, path).toBeVisible()
    await expect(branch.locator('option')).toHaveCount(2)
    await branch.selectOption(sharjah)
    await expect(branch).toHaveValue(sharjah)
  }
  await shot(owner, 'en-1440-invoice-branch')
})

// ---------------------------------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------------------------------

test('an issued tax invoice: its page and its PDF, downloaded', async () => {
  const profile = await ok(
    callApi<{ version: number }>(
      owner,
      'business.profile',
      {},
      { businessId: fitOutId, query: true },
    ),
    'business.profile',
  )
  await ok(
    callApi(
      owner,
      'business.updateProfile',
      {
        version: profile.version,
        legalName: 'Cedar Interiors',
        legalNameAr: 'سيدار للديكور',
        vatRegistered: true,
        trn: '100987654300003',
        letterhead: {
          phone: '+971 4 555 0190',
          email: 'hello@cedar.example',
          addressLine: 'Warehouse 9, Al Quoz Industrial 3',
          city: 'Dubai',
          emirate: 'dubai',
        },
      },
      { businessId: fitOutId },
    ),
    'business.updateProfile',
  )
  const customer = await ok(
    callApi<{ id: string }>(
      owner,
      'customer.create',
      {
        id: randomUUID(),
        name: 'Horizon Consulting LLC',
        kind: 'business',
        trn: '100555666700003',
        addressLine: 'Office 1204, Business Tower',
        city: 'Business Bay',
        emirate: 'dubai',
      },
      { businessId: fitOutId },
    ),
    'customer.create',
  )
  const draft = await ok(
    callApi<{ id: string; version: number }>(
      owner,
      'invoice.create',
      {
        id: randomUUID(),
        customerId: customer.id,
        lpoReference: 'LPO-7781',
        countedElsewhere: false,
        lines: [
          {
            id: randomUUID(),
            productId: null,
            description: 'Gypsum partition with sound insulation',
            qty: '20',
            unit: 'm2',
            unitPrice: '120',
          },
        ],
      },
      { businessId: fitOutId },
    ),
    'invoice.create',
  )
  const issued = await ok(
    callApi<{ id: string; number: string }>(
      owner,
      'invoice.issue',
      { id: draft.id, version: draft.version },
      { businessId: fitOutId },
    ),
    'invoice.issue',
  )
  expect(issued.number).toBe('INV-0001')
  await owner.setViewportSize(DESKTOP)
  await owner.goto(`/b/${fitOutId}/invoices/${issued.id}`)
  await expect(owner.getByRole('heading', { level: 1 })).toContainText('Tax Invoice')
  await expect(owner.getByRole('heading', { level: 1 })).toContainText('INV-0001')
  // 20 m² × 120 = 2,400.00 + 120.00 VAT.
  await expect(owner.getByRole('main')).toContainText(aed('2,520.00'))
  await expectSound(owner, 'en')
  await shot(owner, 'en-1440-tax-invoice')
  await owner.getByRole('button', { name: 'Download or share PDF' }).click()
  const pdf = owner.getByRole('dialog')
  await expect(pdf.getByRole('button', { name: 'Download PDF' })).toBeEnabled({ timeout: 60_000 })
  const bytes = await savePdf(
    owner,
    () => pdf.getByRole('button', { name: 'Download PDF' }).click(),
    'fitout-tax-invoice',
  )
  expect(bytes.byteLength).toBeGreaterThan(5_000)
  await owner.keyboard.press('Escape')
})

test("an orders-only business's customer statement: its orders and payments, in its own words, and its PDF (B10)", async () => {
  const day = await today(bakerId)
  const customer = await ok(
    callApi<{ id: string }>(
      owner,
      'customer.create',
      { id: randomUUID(), name: 'Mona Saeed', phone: '050 123 4567' },
      { businessId: bakerId },
    ),
    'customer.create',
  )
  const cake = await ok(
    callApi<{ id: string }>(
      owner,
      'product.create',
      {
        id: randomUUID(),
        name: 'Chocolate cake',
        type: 'product',
        unit: 'piece',
        defaultPrice: '250',
      },
      { businessId: bakerId },
    ),
    'product.create',
  )
  const channels = await ok(
    callApi<{ data: { items: { id: string }[] } }>(
      owner,
      'channel.list',
      { status: 'active' },
      { businessId: bakerId, query: true },
    ),
    'channel.list',
  )
  const order = (
    await ok(
      callApi<{ data: { id: string; version: number } }>(
        owner,
        'order.create',
        {
          id: randomUUID(),
          customerId: customer.id,
          businessDate: day,
          channelId: channels.data.items[0]!.id,
          lines: [
            { kind: 'item', id: randomUUID(), productId: cake.id, qty: '2', unitPrice: '250' },
          ],
          payment: { id: randomUUID(), method: 'cash', amount: '200' },
        },
        { businessId: bakerId },
      ),
      'order.create',
    )
  ).data
  await ok(
    callApi(
      owner,
      'order.deliver',
      { id: order.id, version: order.version },
      { businessId: bakerId },
    ),
    'order.deliver',
  )

  // On the customer's page in Arabic on a phone: "Statement".
  await setLanguage(owner, 'ar')
  await owner.setViewportSize(PHONE)
  await owner.goto(`/b/${bakerId}/customers/${customer.id}`)
  await owner.getByRole('link', { name: 'كشف الحساب' }).click()
  await expect(owner).toHaveURL(new RegExp(`/b/${bakerId}/customers/${customer.id}/statement`))
  await expect(owner.locator('[data-statement-sum="invoiced"]')).toContainText('الطلبات والمبيعات')
  await expect(owner.locator('[data-statement-sum="credited"]')).toContainText('المسترد')
  await expect(owner.locator('[data-statement-entry="order"]:visible')).toHaveCount(1)
  await expect(owner.locator('[data-statement-entry="payment"]:visible')).toHaveCount(1)
  expect(await owner.getByRole('main').innerText()).not.toMatch(/فاتورة|فواتير|إشعار دائن/)
  await expectSound(owner, 'ar')
  await shot(owner, 'ar-390-baker-statement')

  // On a desktop in English: the sums and the columns, then the PDF.
  await setLanguage(owner, 'en')
  await owner.setViewportSize(DESKTOP)
  await owner.goto(`/b/${bakerId}/customers/${customer.id}/statement`)
  await expect(owner.locator('[data-statement-sum="invoiced"]')).toContainText('Orders and sales')
  await expect(owner.locator('[data-statement-sum="invoiced"]')).toContainText(aed('500.00'))
  await expect(owner.locator('[data-statement-sum="paid"]')).toContainText(aed('200.00'))
  await expect(owner.locator('[data-statement-sum="closing"]')).toContainText(aed('300.00'))
  await expect(owner.getByRole('columnheader', { name: 'Orders and sales' })).toBeVisible()
  await expect(owner.getByRole('columnheader', { name: 'Payments and refunds' })).toBeVisible()
  await expect(owner.getByText(/invoiced or delivered|credited/i)).toHaveCount(0)
  await expectSound(owner, 'en')
  await shot(owner, 'en-1440-baker-statement')
  await owner.getByRole('button', { name: 'PDF', exact: true }).click()
  const pdf = owner.getByRole('dialog')
  await expect(owner.locator('[data-pdf-preview]')).toBeVisible({ timeout: 60_000 })
  await savePdf(
    owner,
    () => pdf.getByRole('button', { name: 'Download PDF' }).click(),
    'baker-statement',
  )
  await owner.keyboard.press('Escape')

  // Settings → Documents for her letterhead (the statements print on it): no signature or quotes.
  await owner.goto(`/b/${bakerId}/settings/documents`)
  await expect(owner.getByRole('heading', { level: 1, name: 'Documents' })).toBeVisible()
  await expect(owner.getByRole('heading', { name: 'Signature and stamp' })).toHaveCount(0)
  await expect(owner.getByRole('textbox', { name: 'Usual terms' })).toHaveCount(0)
  // Its words are hers (Release B review): statements, her order numbers, no signature, no
  // quotations' terms, no TRN without VAT registration; the preview is titled as her statements.
  const main = owner.getByRole('main')
  await expect(main).toContainText(
    'Your letterhead on the statements you send, your order numbers, and the bank details printed at the foot.',
  )
  await expect(main).toContainText('Statement of account')
  await expect(main).toContainText('Your bank details are printed under the totals.')
  await expect(main).toContainText('with your trade licence under your name')
  await expect(main).not.toContainText(/signature|quotation|TRN/i)
  await expectSound(owner, 'en')
})

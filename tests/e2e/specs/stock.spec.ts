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
  RAW_KEY,
  setLanguage,
  signIn,
  useLanguage,
  type TestUser,
} from '../helpers'
import { previewBaseURL } from '../stack'

// Stock: the first count, counts and stock on hand (ROADMAP.md M4 Step 2; D-339 Q2, Q3, Q5, Q6, Q16,
// Q17), on the development server with the dev-only preview of Stock (`preview` project, D-127):
//   - The owner of a café with two branches, in English on a desktop: nothing is tracked yet, so the
//     Stock page explains it and starts tracking; milk and coffee beans go on a first count two days
//     ago, counted in packs in both branches (3 cartons + 4 bottles, 2 cartons; 2 bags, 1 bag with +);
//     the review says what each starts at (64 L at the 90-day average of 6.00 = AED 384.00), and the
//     confirmation says it in words. The Stock page then shows each in packs and what it is worth. A
//     count of the main branch today finds the milk 12 L short ("1 carton (12 L) less", AED 72.00 less,
//     never "loss"), the beans as expected; finalized after a confirmation that says the difference.
//     The milk's stock card lists the count and both first-count rows with what they moved.
//   - An Employee counts blind, in Arabic on a phone: Stock is under More (Q17), the counts waiting for
//     them, the sheet, − / + and packs, "Counted by you"; nothing on the page says what was expected,
//     a difference or an amount, no answer the page reads carries them at all, and the review isn't
//     open to them. The owner types on the same line meanwhile: once the Employee saves first, the
//     owner's save is refused and the line shows what Sara counted (no silent overwrite). Leaving with
//     a line typed asks first, and a failed save from that question says why on the line (D-161).
//   - A Supervisor, who sees stock without the costs switch: what stock is worth and what a count moved
//     its value by are locked; a finalized count shows what was counted, not what was expected.
//   - The owner discards a draft and reverses the latest count.
//   - The owner's review (D-348): lids never bought, counted 2 short, are a difference worth AED 0.00,
//     never "everything matches"; a line saved again while the confirmation is open is said, not
//     finalized; a first count of cups misses a branch opened since and adds it; and, once another
//     first count of cups is finalized, finalizing this one is refused by name.
// The café is a food business: its pages say "ingredients and supplies" (D-118).
// With E2E_SHOTS_DIR set, each step leaves a screenshot there.

test.describe.configure({ mode: 'serial' })

const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1440, height: 900 }

/** A café with a team, two branches and stock, not VAT-registered. */
const CAFE_ANSWERS = {
  what_you_do: ['food_drinks'],
  workplace: 'shop',
  branches: true,
  team: 'team',
  team_tracking: ['hours'],
  work_setup: ['stock'],
  sales_channels: ['walk_in'],
  pos: false,
  vat: 'no',
}

const users: TestUser[] = []
const contexts: BrowserContext[] = []

test.afterAll(async () => {
  for (const context of contexts) await context.close()
  for (const user of users) await deleteUser(user.id)
})

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
  // The development server's own badge (bottom corner, a production build has none) covers the
  // phone's "More" tab in Arabic; it is hidden so a tap reaches the page.
  await context.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style')
      style.textContent = 'nextjs-portal { display: none !important; }'
      document.head.append(style)
    })
  })
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

/** A screenshot into E2E_SHOTS_DIR (only when it is set): the whole page. */
async function shot(page: Page, name: string) {
  const dir = process.env.E2E_SHOTS_DIR
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true })
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

/** `day` (YYYY-MM-DD) moved by `days`. */
function shift(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/** A business day as the English pages write it ("29 Oct 2026"). */
function englishDay(day: string): string {
  return new Intl.DateTimeFormat('en-AE', { dateStyle: 'medium', timeZone: 'UTC' }).format(
    new Date(`${day}T00:00:00Z`),
  )
}

/** Words of a quantity or an amount, whatever space joins them (a no-break space on screen). */
function words(text: string): RegExp {
  // Isolates (U+2066–U+2069) keep a name or an amount whole inside a sentence.
  const escaped = text
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/ /g, '[\\u2066-\\u2069]?\\s[\\u2066-\\u2069]?')
  return new RegExp(escaped)
}

/** Invites `user` into the business with the role of `templateKey`; they accept it. */
async function joinBusiness(
  owner: Page,
  businessId: string,
  member: Page,
  user: TestUser,
  templateKey: string,
) {
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

/** A line of a count's sheet: its item, and its branch when given. */
function sheetLine(page: Page, item: string, branch?: string): Locator {
  const line = page.locator('[data-count-line]').filter({ hasText: item })
  return branch ? line.filter({ hasText: branch }) : line
}

/** Types what was counted on a line, part by part (each after the first is added), and saves it. */
async function countLine(line: Locator, parts: string[], counted: RegExp) {
  for (const [index, qty] of parts.entries()) {
    if (index > 0) await line.getByRole('button', { name: /Add another|أضف وحدة/ }).click()
    await line
      .getByLabel(/How many|الكمية/)
      .nth(index)
      .fill(qty)
  }
  await line.getByRole('button', { name: /^(Save|احفظ)/ }).click()
  await expect(line.locator('[data-counted-when]')).toContainText(counted)
}

/** A count's line as the API returns it. */
interface ApiLine {
  id: string
  version: number
  locationId: string
  materialId: string
}

/** What a counter must never receive: what the book expected, a difference and its value (Q6). */
const BLIND_KEYS = new Set(['bookQty', 'differenceQty', 'differenceValue', 'unitCost'])

/** The keys of a JSON answer that a counter must never receive, anywhere in it. */
function blindKeysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(blindKeysOf)
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([key, inner]) => [
    ...(BLIND_KEYS.has(key) ? [key] : []),
    ...blindKeysOf(inner),
  ])
}

/** The count answers a counter's page reads (a saved line comes back too). */
const WATCHED = new Set(['count.get', 'count.list', 'count.saveLine'])

/** Collects the count answers the page receives (tRPC batches included). */
function watchCountAnswers(page: Page): { seen: Set<string>; bodies: unknown[] } {
  const watched = { seen: new Set<string>(), bodies: [] as unknown[] }
  page.on('response', async (response) => {
    const url = new URL(response.url())
    if (!url.pathname.startsWith('/api/trpc/')) return
    const procedures = url.pathname.slice('/api/trpc/'.length).split(',')
    const counts = procedures.filter((name) => WATCHED.has(name))
    if (counts.length === 0) return
    try {
      watched.bodies.push(JSON.parse(await response.text()))
      for (const name of counts) watched.seen.add(name)
    } catch {
      // A page left before its answer was read.
    }
  })
  return watched
}

let businessId = ''
let today = ''
let owner: Page
let marina = ''
let main = ''
let milk = ''

test('the owner of a café starts tracking, counts two branches and counts again, in English on a desktop', async ({
  browser,
}) => {
  test.setTimeout(900_000)
  const user = await createUser('stock-owner', { locale: 'en' })
  users.push(user)
  owner = await openAs(browser, user, DESKTOP, 'en', 'Khalid')
  businessId = await createBusiness(owner, 'Stock Café', CAFE_ANSWERS)
  const api = <T>(path: string, input: unknown, query = false) =>
    ok(callApi<T>(owner, path, input, { businessId, query }), path)
  today = (await api<{ today: string }>('books.get', {}, true)).today
  marina = randomUUID()
  await api('location.create', { id: marina, name: 'Marina' })
  // The café's own location (Smart Setup names it), now one of two branches.
  const locations = await api<{ id: string; name: string }[]>('location.list', {}, true)
  main = locations.find((location) => location.id !== marina)!.name
  // Milk in litres, bought in cartons of 12 bottles; coffee beans in kilos, in 1 kg bags.
  milk = randomUUID()
  const bottle = randomUUID()
  await api('material.create', {
    id: milk,
    name: 'Milk',
    unit: 'l',
    packs: [
      { id: bottle, name: 'bottle', qty: '1', ofUnit: 'l' },
      { id: randomUUID(), name: 'carton', qty: '12', ofPackId: bottle },
    ],
  })
  const beans = randomUUID()
  await api('material.create', {
    id: beans,
    name: 'Coffee beans',
    unit: 'kg',
    packs: [{ id: randomUUID(), name: 'bag', qty: '1', ofUnit: 'kg' }],
  })
  // Bought three days ago: 12 L at 6.00 and 2 kg at 80.00 (the 90-day averages).
  const purchase = randomUUID()
  const draft = await api<{ data: { version: number } }>('purchase.create', {
    id: purchase,
    businessDate: shift(today, -3),
    documentType: 'no_invoice',
    paymentMethod: 'cash',
    lines: [
      {
        kind: 'material',
        id: randomUUID(),
        materialId: milk,
        qty: '12',
        unit: 'l',
        unitPrice: '6',
        vatRate: '0',
      },
      {
        kind: 'material',
        id: randomUUID(),
        materialId: beans,
        qty: '2',
        unit: 'kg',
        unitPrice: '80',
        vatRate: '0',
      },
    ],
  })
  await api('purchase.post', { id: purchase, version: draft.data.version })

  // Stock is in the menu; nothing is tracked yet, so the page says what tracking means.
  await owner.goto(`/b/${businessId}`)
  await owner.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Stock' }).click()
  await expect(owner).toHaveURL(new RegExp(`/b/${businessId}/stock$`))
  await expect(owner.getByRole('heading', { level: 1, name: 'Stock' })).toBeVisible()
  await expect(owner.getByRole('heading', { name: 'Start tracking your stock' })).toBeVisible()
  await expect(owner.getByText(/milk, beans, cups/)).toBeVisible()
  await expectSound(owner, 'en')
  await shot(owner, 'stock-en-1440-empty')

  // Start tracking: the milk and the beans, counted two days ago.
  await owner.getByRole('button', { name: 'Start tracking' }).click()
  const start = owner.getByRole('dialog', { name: 'Start tracking your stock' })
  await expect(start.getByText(/in every branch/)).toBeVisible()
  await start.getByLabel('Day of the count').fill(shift(today, -2))
  await start.getByRole('checkbox', { name: 'Milk' }).check()
  await start.getByRole('checkbox', { name: 'Coffee beans' }).check()
  await expect(start.getByText('2 picked')).toBeVisible()
  await shot(owner, 'stock-en-1440-start')
  await start.getByRole('button', { name: 'Start the first count' }).click()
  await expect(owner).toHaveURL(new RegExp(`/b/${businessId}/stock/counts/[0-9a-f-]{36}$`))
  const openingUrl = owner.url()
  await expect(
    owner.getByRole('heading', {
      level: 1,
      name: `First count of ${englishDay(shift(today, -2))}`,
    }),
  ).toBeVisible()
  await expect(owner.locator('[data-count-progress]')).toContainText('0 of 4 counted')

  // Each item in each branch, in packs: 3 cartons + 4 bottles (40 L) and 2 cartons (24 L) of milk.
  await countLine(sheetLine(owner, 'Milk', main), ['3', '4'], /Counted by you/)
  await expect(sheetLine(owner, 'Milk', main).locator('[data-comes-to]')).toContainText(
    words('3 cartons + 4 bottles (40 L)'),
  )
  await countLine(sheetLine(owner, 'Milk', 'Marina'), ['2'], /Counted by you/)
  await countLine(sheetLine(owner, 'Coffee beans', main), ['2'], /Counted by you/)
  // One bag in Marina, with +.
  const beansMarina = sheetLine(owner, 'Coffee beans', 'Marina')
  await beansMarina.getByRole('button', { name: /One more/ }).click()
  await expect(beansMarina.getByLabel(/How many/)).toHaveValue('1')
  await beansMarina.getByRole('button', { name: /^Save/ }).click()
  await expect(beansMarina.locator('[data-counted-when]')).toContainText('Counted by you')
  await expect(owner.locator('[data-count-progress]')).toContainText('4 of 4 counted')
  // "Not counted yet" leaves nothing.
  await owner.getByLabel('Not counted yet').check()
  await expect(owner.getByText('Everything is counted.')).toBeVisible()
  await owner.getByLabel('Not counted yet').uncheck()
  await shot(owner, 'stock-en-1440-opening-sheet')

  // The review: what each item starts at, at the 90-day average.
  await owner.getByRole('link', { name: 'Review and finalize' }).click()
  await expect(owner.getByRole('heading', { level: 1, name: 'Review the count' })).toBeVisible()
  const milkOpening = owner.locator(`[data-opening="${milk}"]`)
  await expect(milkOpening).toContainText(words('5 cartons + 4 bottles (64 L)'))
  await expect(milkOpening).toContainText(words('AED 6.00 per L'))
  await expect(milkOpening).toContainText(words('AED 384.00'))
  await expect(owner.locator(`[data-opening="${beans}"]`)).toContainText(words('AED 240.00'))
  await shot(owner, 'stock-en-1440-opening-review')
  await owner.getByRole('button', { name: 'Finalize' }).click()
  const finalizeOpening = owner.getByRole('alertdialog', { name: 'Finalize this first count?' })
  await expect(finalizeOpening).toContainText(
    `BizCost will track the stock of 2 ingredients and supplies from the end of ${englishDay(shift(today, -2))}`,
  )
  await expect(finalizeOpening).toContainText(words('It starts worth AED 624.00'))
  await finalizeOpening.getByRole('button', { name: 'Finalize' }).click()
  await expect(owner).toHaveURL(openingUrl)
  await expect(owner.getByText('Finalized', { exact: true }).first()).toBeVisible()

  // The Stock page: each item in packs, what it is worth, per branch.
  await owner.goto(`/b/${businessId}/stock`)
  const milkRow = owner.locator(`[data-stock-row="${milk}"]`)
  await expect(milkRow).toContainText(words('5 cartons + 4 bottles (64 L)'))
  await expect(milkRow.locator('[data-stock-value]')).toContainText(words('AED 384.00'))
  await expect(milkRow).toContainText(words(`${main}: 3 cartons + 4 bottles (40 L)`))
  await expect(milkRow).toContainText(words('Marina: 2 cartons (24 L)'))
  await expect(owner.locator(`[data-stock-row="${beans}"]`)).toContainText(words('3 bags (3 kg)'))
  await expectSound(owner, 'en')
  await shot(owner, 'stock-en-1440-on-hand')

  // A count of the main branch today: the milk is 12 L short, the beans as expected.
  await owner.getByRole('button', { name: 'Count stock' }).click()
  const newCount = owner.getByRole('dialog', { name: 'Count stock' })
  await newCount.getByLabel('Branch').selectOption({ label: main })
  // A day on or before the first count can't be finalized: the sheet says so up front.
  await newCount.getByLabel('Day of the count').fill(shift(today, -2))
  await expect(newCount.locator('[data-too-early]')).toBeVisible()
  await newCount.getByLabel('Day of the count').fill(today)
  await expect(newCount.locator('[data-too-early]')).toHaveCount(0)
  await newCount.getByRole('button', { name: 'Start the count' }).click()
  await expect(
    owner.getByRole('heading', { level: 1, name: `Count of ${englishDay(today)}` }),
  ).toBeVisible()
  const countUrl = owner.url()
  // Blind on the sheet, for the manager too: nothing says what is expected here.
  await expect(owner.getByText(/Count what you see on the shelf/)).toBeVisible()
  await expect(owner.getByText('Expected')).toHaveCount(0)
  await countLine(sheetLine(owner, 'Milk'), ['2', '4'], /Counted by you/)
  await countLine(sheetLine(owner, 'Coffee beans'), ['2'], /Counted by you/)
  await owner.getByRole('link', { name: 'Review and finalize' }).click()
  const milkReview = owner.locator('[data-review-line]').filter({ hasText: 'Milk' })
  await expect(milkReview).toContainText(words('Expected3 cartons + 4 bottles (40 L)'))
  await expect(milkReview).toContainText(words('Counted2 cartons + 4 bottles (28 L)'))
  await expect(milkReview).toContainText(words('1 carton (12 L) less'))
  await expect(milkReview).toContainText(words('AED 72.00 less'))
  await expect(
    owner.locator('[data-review-line]').filter({ hasText: 'Coffee beans' }),
  ).toContainText('As expected')
  await expect(owner.locator('[data-review-total]')).toContainText(words('AED 72.00 less'))
  await expect(owner.locator('body')).not.toContainText(/\bloss\b|theft/i)
  // "Count again": the beans go back to "Not counted yet", and Finalize waits for them.
  await owner.getByRole('button', { name: /Count .*Coffee beans.* again/ }).click()
  await expect(owner.locator('[data-not-counted]')).toContainText('Coffee beans')
  await expect(owner.getByRole('button', { name: 'Finalize' })).toBeDisabled()
  await owner.getByRole('link', { name: 'Back to the count' }).first().click()
  await expect(sheetLine(owner, 'Coffee beans').locator('[data-counted-when]')).toHaveText(
    'Not counted yet',
  )
  await countLine(sheetLine(owner, 'Coffee beans'), ['2'], /Counted by you/)
  await owner.getByRole('link', { name: 'Review and finalize' }).click()
  await expect(
    owner.locator('[data-review-line]').filter({ hasText: 'Coffee beans' }),
  ).toContainText('As expected')
  await expect(owner.locator('[data-not-counted]')).toHaveCount(0)
  await expect(owner.locator('[data-review-total]')).toContainText(words('AED 72.00 less'))
  await shot(owner, 'stock-en-1440-review')
  await owner.getByRole('button', { name: 'Finalize' }).click()
  const finalize = owner.getByRole('alertdialog', { name: 'Finalize this count?' })
  await expect(finalize).toContainText(
    words(
      `The stock of 2 ingredients and supplies in ${main} will be set to what was counted at the end of ${englishDay(today)}.`,
    ),
  )
  // One of the two differs: said in quantity, then in value.
  await expect(finalize).toContainText('1 of them differs from what was expected.')
  await expect(finalize).toContainText(
    words('The difference, AED 72.00 less than expected, counts on'),
  )
  await expect(finalize).not.toContainText('Everything matches')
  await shot(owner, 'stock-en-1440-finalize')
  await finalize.getByRole('button', { name: 'Finalize' }).click()
  await expect(owner).toHaveURL(countUrl)
  // Finalized: the manager sees what was expected and the difference.
  const milkFinal = owner.locator('[data-count-line]').filter({ hasText: 'Milk' })
  await expect(milkFinal).toContainText(words('1 carton (12 L) less'))
  await expect(milkFinal).toContainText(words('AED 72.00 less'))

  // The milk's stock card: the count, then both first-count rows.
  await owner.goto(`/b/${businessId}/stock`)
  await expect(owner.locator(`[data-stock-row="${milk}"]`)).toContainText(
    words('4 cartons + 4 bottles (52 L)'),
  )
  await owner.locator(`[data-stock-row="${milk}"]`).getByRole('link', { name: 'Milk' }).click()
  await expect(owner.getByRole('heading', { level: 1, name: 'Milk' })).toBeVisible()
  await expect(owner.locator('[data-card-on-hand]')).toContainText(
    words('4 cartons + 4 bottles (52 L)'),
  )
  const countEntry = owner.locator('[data-card-entry="count"]')
  await expect(countEntry).toContainText(words('\u221212 L'))
  await expect(countEntry).toContainText(words('\u2212AED 72.00'))
  await expect(owner.locator('[data-card-entry="opening"]')).toHaveCount(2)
  await countEntry.getByRole('link', { name: 'Open the count' }).click()
  await expect(owner).toHaveURL(countUrl)
  await owner.goBack()
  await expectSound(owner, 'en')
  await shot(owner, 'stock-en-1440-card')
})

test('an Employee counts blind, in Arabic on a phone', async ({ browser }) => {
  test.setTimeout(600_000)
  expect(businessId, 'the first test made the café').not.toBe('')
  const user = await createUser('stock-employee', { locale: 'en' })
  users.push(user)
  const page = await openAs(browser, user, PHONE, 'en', 'Sara')
  await joinBusiness(owner, businessId, page, user, 'employee')
  // The owner starts a count of Marina today, of everything tracked.
  const countId = randomUUID()
  await ok(
    callApi(
      owner,
      'count.start',
      { id: countId, kind: 'count', businessDate: today, locationId: marina, materialIds: 'all' },
      { businessId },
    ),
    'count.start',
  )

  // Every count answer the Employee's page reads is checked: none carries what was expected.
  const answers = watchCountAnswers(page)
  await setLanguage(page, 'ar')
  await page.goto(`/b/${businessId}`)
  // Stock is under More on a phone (Q17).
  const tabs = page.getByRole('navigation', { name: 'القائمة الرئيسية' })
  await tabs.getByRole('button', { name: 'المزيد' }).click()
  await page.getByRole('menuitem', { name: 'المخزون' }).click()
  await expect(page).toHaveURL(new RegExp(`/b/${businessId}/stock$`))
  // Only the counts waiting for them: no "On hand", no stock.
  await expect(page.getByRole('heading', { level: 1, name: 'المخزون' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'صفحات المخزون' })).toHaveCount(0)
  await expect(page.getByText(/عمليات جرد بانتظارك/)).toBeVisible()
  await page.locator(`[data-count-row="${countId}"]`).click()
  await expect(page).toHaveURL(new RegExp(`/stock/counts/${countId}$`))
  await expect(page.getByText(/اعدُد ما تراه على الرف/)).toBeVisible()
  await expect(page.getByRole('link', { name: 'راجع واعتمد' })).toHaveCount(0)

  // The owner opens the same sheet and starts typing the milk too, before Sara saves it.
  await owner.goto(`/b/${businessId}/stock/counts/${countId}`)
  const ownerMilk = sheetLine(owner, 'Milk')
  await ownerMilk.getByLabel(/How many/).fill('3')
  await expect(ownerMilk.getByRole('button', { name: /^Save/ })).toBeEnabled()

  // Two cartons of milk, with + on the first part and a second part of 5 bottles.
  const milkLine = sheetLine(page, 'Milk')
  await milkLine.getByRole('button', { name: /واحد أكثر/ }).click()
  await milkLine.getByRole('button', { name: /واحد أكثر/ }).click()
  await expect(milkLine.getByLabel(/الكمية/)).toHaveValue('2')
  await milkLine.getByRole('button', { name: 'أضف وحدة أو عبوة أخرى' }).click()
  // Typed in Arabic-Indic digits.
  await milkLine
    .getByLabel(/الكمية/)
    .nth(1)
    .fill('٥')
  await milkLine.getByRole('button', { name: /^احفظ/ }).click()
  await expect(milkLine.locator('[data-counted-when]')).toContainText('عددته أنت')
  await expect(milkLine.locator('[data-comes-to]')).toContainText(/29/)

  // Blind: nothing on the page says what was expected, a difference or an amount, and no answer
  // the page read carries those fields, not even empty.
  const text = await page.locator('main').innerText()
  expect(text).not.toMatch(/المتوقع|الفرق|د\.إ|AED/)
  await expect
    .poll(() => ['count.get', 'count.list', 'count.saveLine'].every((n) => answers.seen.has(n)))
    .toBe(true)
  expect(answers.bodies.flatMap(blindKeysOf)).toEqual([])
  await expectSound(page, 'ar')
  await shot(page, 'stock-ar-390-employee-sheet')

  // The owner saves the milk typed before Sara's save: refused, and the line shows what Sara
  // counted (2 cartons + 5 bottles), never overwritten unseen.
  await ownerMilk.getByRole('button', { name: /^Save/ }).click()
  await expect(
    owner.getByText('Someone else saved this line just now.', { exact: false }),
  ).toBeVisible()
  await expect(ownerMilk.locator('[data-counted-when]')).toContainText(/Counted by \u2068?Sara/)
  await expect(ownerMilk.getByLabel(/How many/).first()).toHaveValue('2')
  await expect(ownerMilk.locator('[data-comes-to]')).toContainText(
    words('2 cartons + 5 bottles (29 L)'),
  )

  // Leaving with a line typed asks first; Save with a box left empty stays and says why on the line.
  const ownerBeans = sheetLine(owner, 'Coffee beans')
  await ownerBeans.getByLabel(/How many/).fill('1')
  await ownerBeans.getByRole('button', { name: 'Add another unit or pack' }).click()
  await expect(ownerBeans.getByLabel(/^How many, .?Coffee beans.?, part 2$/)).toBeVisible()
  await owner.getByRole('link', { name: 'Counts', exact: true }).first().click()
  const unsaved = owner.getByRole('alertdialog', { name: 'You have unsaved changes' })
  await unsaved.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(unsaved).toHaveCount(0)
  await expect(owner).toHaveURL(new RegExp(`/stock/counts/${countId}$`))
  await expect(ownerBeans.getByRole('alert')).toContainText('Enter a number.')
  await expect(ownerBeans.locator('[data-counted-when]')).toHaveText('Not counted yet')
  // Leaving without saving: nothing of it is kept.
  await owner.getByRole('link', { name: 'Counts', exact: true }).first().click()
  await unsaved.getByRole('button', { name: "Don't save" }).click()
  await expect(owner).toHaveURL(new RegExp(`/b/${businessId}/stock/counts$`))

  // The review isn't open to them, nor a stock card.
  await page.goto(`/b/${businessId}/stock/counts/${countId}/review`)
  await expect(page.getByRole('heading', { name: 'هذه الصفحة غير متاحة لك' })).toBeVisible()
  await page.goto(`/b/${businessId}/stock/${milk}`)
  await expect(page.getByRole('heading', { name: 'هذه الصفحة غير متاحة لك' })).toBeVisible()
})

test('a Supervisor sees stock with its values locked, without the costs switch', async ({
  browser,
}) => {
  test.setTimeout(600_000)
  expect(businessId, 'the first test made the café').not.toBe('')
  const user = await createUser('stock-supervisor', { locale: 'en' })
  users.push(user)
  const page = await openAs(browser, user, DESKTOP, 'en', 'Omar')
  await joinBusiness(owner, businessId, page, user, 'supervisor')

  await page.goto(`/b/${businessId}/stock`)
  const milkRow = page.locator(`[data-stock-row="${milk}"]`)
  await expect(milkRow).toContainText(words('4 cartons + 4 bottles (52 L)'))
  await expect(milkRow.locator('[data-stock-value] [data-locked="cost"]')).toBeVisible()
  await expect(page.getByText("Values are hidden: your role doesn't show costs.")).toBeVisible()
  await expect(page.locator('body')).not.toContainText('AED')
  // Counts are theirs to fill, not to start.
  await expect(page.getByRole('button', { name: 'Count stock' })).toHaveCount(0)
  await shot(page, 'stock-en-1440-supervisor')

  // The stock card: what each movement moved the value by is locked.
  await milkRow.getByRole('link', { name: 'Milk' }).click()
  await expect(
    page.locator('[data-card-entry="count"]').locator('[data-locked="cost"]'),
  ).toBeVisible()
  await expect(page.locator('main')).not.toContainText('AED')

  // A finalized count: what was counted, never what was expected (that is for managers of counts).
  await page
    .locator('[data-card-entry="count"]')
    .getByRole('link', { name: 'Open the count' })
    .click()
  await expect(page.locator('[data-count-line]').filter({ hasText: 'Milk' })).toContainText(
    words('2 cartons + 4 bottles (28 L)'),
  )
  await expect(page.getByText('Expected')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Reverse' })).toHaveCount(0)
  await expectSound(page, 'en')
})

test('the owner discards a draft and reverses the latest count, in English on a desktop', async () => {
  test.setTimeout(600_000)
  expect(businessId, 'the first test made the café').not.toBe('')
  // The Employee's draft of Marina: discarded, the stock unchanged.
  await owner.goto(`/b/${businessId}/stock/counts`)
  await owner.getByRole('group', { name: 'Show' }).getByText('Drafts').click()
  await expect(owner).toHaveURL(/status=draft/)
  await expect(owner.locator('[data-count-row]')).toHaveCount(1)
  await owner.locator('[data-count-row]').click()
  await owner.getByRole('button', { name: 'Discard draft' }).click()
  const discard = owner.getByRole('alertdialog', { name: 'Discard this draft?' })
  await expect(discard).toContainText("Your stock doesn't change.")
  await discard.getByRole('button', { name: 'Discard' }).click()
  await expect(owner).toHaveURL(new RegExp(`/b/${businessId}/stock/counts$`))

  // The latest count of the main branch, reversed: the milk is back to what the first count found.
  await owner.getByRole('group', { name: 'Show' }).getByText('Finalized').click()
  await expect(owner).toHaveURL(/status=posted/)
  await owner
    .locator('[data-count-row]')
    .filter({ hasText: /^Count/ })
    .click()
  await owner.getByRole('button', { name: 'Reverse' }).click()
  const reverse = owner.getByRole('alertdialog', { name: 'Reverse this count?' })
  await expect(reverse).toContainText(
    words(
      `The stock of 2 ingredients and supplies goes back to what it was before this count, as if it was never finalized. The reversal is dated ${englishDay(today)}.`,
    ),
  )
  await reverse.getByRole('button', { name: 'Reverse' }).click()
  await expect(
    owner.getByText(`Reversed on ${englishDay(today)}. It no longer counts.`),
  ).toBeVisible()
  await owner.goto(`/b/${businessId}/stock`)
  const milkRow = owner.locator(`[data-stock-row="${milk}"]`)
  await expect(milkRow).toContainText(words('5 cartons + 4 bottles (64 L)'))
  await expect(milkRow.locator('[data-stock-value]')).toContainText(words('AED 384.00'))
  await expectSound(owner, 'en')
})

test('the owner reviews what changed: worth nothing, saved since, a branch added, a refusal by name', async () => {
  test.setTimeout(900_000)
  expect(businessId, 'the first test made the café').not.toBe('')
  const api = <T>(path: string, input: unknown, query = false) =>
    ok(callApi<T>(owner, path, input, { businessId, query }), path)
  /** Counts every line of a count through the API: `qty` pieces each. */
  const countAll = async (countId: string, qty: string) => {
    const count = await api<{ data: { lines: ApiLine[] } }>('count.get', { id: countId }, true)
    for (const line of count.data.lines) {
      await api('count.saveLine', {
        countId,
        lineId: line.id,
        parts: [{ qty, unit: 'piece' }],
        version: line.version,
      })
    }
  }
  /** Finalizes a count through the API, with the version its review returns. */
  const finalizeByApi = async (countId: string) => {
    const review = await api<{ data: { version: number } }>('count.review', { id: countId }, true)
    await api('count.finalize', { id: countId, version: review.data.version })
  }
  const locations = await api<{ id: string; name: string }[]>('location.list', {}, true)
  const mainId = locations.find((location) => location.name === main)!.id

  // Lids, never bought (no price yet): first counted yesterday, 10 in each branch.
  const lids = randomUUID()
  await api('material.create', { id: lids, name: 'Lids', unit: 'piece', packs: [] })
  const lidsOpening = randomUUID()
  await api('count.start', {
    id: lidsOpening,
    kind: 'opening',
    businessDate: shift(today, -1),
    materialIds: [lids],
  })
  await countAll(lidsOpening, '10')
  await finalizeByApi(lidsOpening)

  // A count of the main branch today: 8 lids, 2 short, a difference worth AED 0.00.
  const lidsCount = randomUUID()
  await api('count.start', {
    id: lidsCount,
    kind: 'count',
    businessDate: today,
    locationId: mainId,
    materialIds: [lids],
  })
  await owner.goto(`/b/${businessId}/stock/counts/${lidsCount}`)
  await countLine(sheetLine(owner, 'Lids'), ['8'], /Counted by you/)
  await owner.getByRole('link', { name: 'Review and finalize' }).click()
  const lidsReview = owner.locator('[data-review-line]').filter({ hasText: 'Lids' })
  await expect(lidsReview.locator('[data-difference="less"]')).toBeVisible()
  await owner.getByRole('button', { name: 'Finalize' }).click()
  const finalize = owner.getByRole('alertdialog', { name: 'Finalize this count?' })
  await expect(finalize.getByRole('button', { name: 'Finalize' })).toBeEnabled()
  // Not "everything matches": one line differs, and its value is said apart.
  await expect(finalize).toContainText('1 of them differs from what was expected.')
  await expect(finalize).toContainText(words('Together their value comes to AED 0.00'))
  await expect(finalize).not.toContainText('Everything matches')
  await shot(owner, 'stock-en-1440-finalize-worth-nothing')

  // Someone saves the line again (9) while the confirmation is open: finalizing is refused, the
  // review says lines changed since and shows the 9; nothing is finalized unseen.
  const draft = await api<{ data: { lines: ApiLine[] } }>('count.get', { id: lidsCount }, true)
  const line = draft.data.lines[0]!
  await api('count.saveLine', {
    countId: lidsCount,
    lineId: line.id,
    parts: [{ qty: '9', unit: 'piece' }],
    version: line.version,
  })
  await finalize.getByRole('button', { name: 'Finalize' }).click()
  await expect(owner.locator('[data-review-changed]')).toContainText(
    'Lines were counted or changed since you looked.',
  )
  await expect(finalize).toHaveCount(0)
  await expect(owner).toHaveURL(new RegExp(`/stock/counts/${lidsCount}/review$`))
  await expect(lidsReview).toContainText(/Counted\s*9/)
  // Looked at again, it is finalized.
  await owner.getByRole('button', { name: 'Finalize' }).click()
  await expect(finalize.getByRole('button', { name: 'Finalize' })).toBeEnabled()
  await finalize.getByRole('button', { name: 'Finalize' }).click()
  await expect(owner).toHaveURL(new RegExp(`/stock/counts/${lidsCount}$`))
  await expect(owner.locator('[data-count-line]').filter({ hasText: 'Lids' })).toContainText(
    /Counted\s*9/,
  )

  // Cups on a first count of today; a branch opens since, so the review lists what it misses.
  const cups = randomUUID()
  await api('material.create', { id: cups, name: 'Cups', unit: 'piece', packs: [] })
  const cupsCount = randomUUID()
  await api('count.start', {
    id: cupsCount,
    kind: 'opening',
    businessDate: today,
    materialIds: [cups],
  })
  await countAll(cupsCount, '50')
  await api('location.create', { id: randomUUID(), name: 'Airport' })
  await owner.goto(`/b/${businessId}/stock/counts/${cupsCount}/review`)
  const missing = owner.locator('[data-missing-lines]')
  await expect(missing).toContainText(/Cups\s*·\s*Airport/)
  await expect(owner.getByRole('button', { name: 'Finalize' })).toBeDisabled()
  await owner.getByRole('button', { name: 'Add the new branch' }).click()
  await expect(missing).toHaveCount(0)
  await expect(owner.locator('[data-not-counted]')).toContainText('Airport')
  await owner.getByRole('link', { name: 'Back to the count' }).first().click()
  await countLine(sheetLine(owner, 'Cups', 'Airport'), ['5'], /Counted by you/)

  // Meanwhile another first count of cups is finalized: finalizing this one is refused, by name.
  const otherCups = randomUUID()
  await api('count.start', {
    id: otherCups,
    kind: 'opening',
    businessDate: today,
    materialIds: [cups],
  })
  await countAll(otherCups, '50')
  await finalizeByApi(otherCups)
  await owner.getByRole('link', { name: 'Review and finalize' }).click()
  await owner.getByRole('button', { name: 'Finalize' }).click()
  const finalizeCups = owner.getByRole('alertdialog', { name: 'Finalize this first count?' })
  await finalizeCups.getByRole('button', { name: 'Finalize' }).click()
  await expect(finalizeCups).toContainText(/Their stock is tracked already: \u2068?Cups\u2069?\./)
  await expectSound(owner, 'en')
  await shot(owner, 'stock-en-1440-refused-by-name')
})

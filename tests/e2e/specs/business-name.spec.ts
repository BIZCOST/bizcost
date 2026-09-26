import { randomUUID } from 'node:crypto'
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test'
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
  uniqueEmail,
  useLanguage,
  WORKSHOP_ANSWERS,
  type TestUser,
} from '../helpers'
import { baseURL } from '../stack'

// The business's name and logo in the app (D-097): the Arabic app shows the Arabic legal name where
// the business has one (switcher, sidebar, Dashboard, page title, invitation page and email), the
// English app the legal name; the logo shows in the switcher, its list and the Dashboard, the store
// mark without one; a logo whose signed link no longer works is fetched again. One signed-in owner
// for the file (the local Auth server limits sign-ins per IP).

test.describe.configure({ mode: 'serial' })

const EN = 'Moon Café LLC'
const AR = 'مقهى القمر ذ.م.م'
const OTHER = 'Sun Works'

let owner: TestUser
let context: BrowserContext
let page: Page
let moon: string
let sun: string
const cleanup: string[] = []

test.beforeAll(async ({ browser }) => {
  owner = await createUser('names')
  cleanup.push(owner.id)
  context = await browser.newContext({ baseURL, locale: 'en-US' })
  await useLanguage(context, 'en')
  page = await context.newPage()
  await signIn(page, owner)
  moon = await createBusiness(page, EN, WORKSHOP_ANSWERS)
  sun = await createBusiness(page, OTHER, BAKER_ANSWERS)

  // The Arabic name and the logo, as Settings → Business profile saves them.
  const profile = await callApi<{ version: number }>(
    page,
    'business.profile',
    {},
    { businessId: moon, query: true },
  )
  const saved = await callApi(
    page,
    'business.updateProfile',
    {
      version: profile.data?.version,
      legalName: EN,
      legalNameAr: AR,
      vatRegistered: true,
      trn: '100123456700003',
    },
    { businessId: moon },
  )
  expect(saved.appCode).toBeUndefined()
  const target = await callApi<{ path: string; uploadUrl: string }>(
    page,
    'business.logoUploadUrl',
    { contentType: 'image/png' },
    { businessId: moon },
  )
  const uploaded = await fetch(target.data!.uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': 'image/png', 'x-upsert': 'false' },
    body: new Uint8Array(pngImage()),
  })
  expect(uploaded.ok).toBe(true)
  const logo = await callApi(
    page,
    'business.setLogo',
    { path: target.data!.path },
    { businessId: moon },
  )
  expect(logo.appCode).toBeUndefined()
})

test.afterAll(async () => {
  await context?.close()
  for (const id of cleanup) await deleteUser(id)
})

const switcher = (p: Page) =>
  p.getByRole('button', { name: /^(Switch business|تبديل العمل التجاري): / })
const logoOf = (scope: Locator | Page, name: string) => scope.locator(`img[alt="${name}"]`)

/** Width of a loaded logo image (0 while loading or broken). */
async function loadedWidth(image: Locator): Promise<number> {
  return image.evaluate((img: HTMLImageElement) => (img.complete ? img.naturalWidth : 0))
}

async function box(locator: Locator) {
  const found = await locator.boundingBox()
  if (!found) throw new Error('not visible')
  return found
}

test('English: the legal name and the logo in the sidebar, the Dashboard and the switcher', async () => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/b/${moon}`)
  await expect(page.getByRole('heading', { level: 1, name: EN })).toBeVisible()
  await expect(page).toHaveTitle(new RegExp(EN))
  const trigger = switcher(page)
  await expect(trigger).toHaveAccessibleName(new RegExp(EN))
  await expect(trigger).toContainText(EN)

  // The logo: a square of a fixed size in the switcher and beside the heading, drawn whole.
  const sidebarLogo = logoOf(trigger, EN)
  const heroLogo = logoOf(page.getByRole('main'), EN)
  await expect.poll(() => loadedWidth(sidebarLogo)).toBe(64)
  await expect.poll(() => loadedWidth(heroLogo)).toBe(64)
  const mark = await box(sidebarLogo.locator('..'))
  expect(mark.width).toBe(mark.height)
  expect(await sidebarLogo.evaluate((img) => getComputedStyle(img).objectFit)).toBe('contain')
  // Named once for screen readers: the name beside it says it.
  await expect(sidebarLogo.locator('..')).toHaveAttribute('aria-hidden', 'true')

  // Both businesses in the list: the logo, or the store mark without one.
  await trigger.click()
  const items = page.getByRole('menuitemradio')
  await expect(items).toHaveText([new RegExp(EN), new RegExp(OTHER)])
  await expect.poll(() => loadedWidth(logoOf(items.nth(0), EN))).toBe(64)
  // The store mark instead, in a square of the same size (layout sizes: the menu zooms in).
  await expect(items.nth(1).locator('img')).toHaveCount(0)
  const size = (item: Locator) =>
    item
      .locator('span[aria-hidden]')
      .first()
      .evaluate((el: HTMLElement) => [el.offsetWidth, el.offsetHeight])
  expect(await size(items.nth(0))).toEqual([32, 32])
  expect(await size(items.nth(1))).toEqual([32, 32])
  await page.keyboard.press('Escape')

  // Without a logo: the store mark, and no picture beside the heading.
  await page.goto(`/b/${sun}`)
  await expect(page.getByRole('heading', { level: 1, name: OTHER })).toBeVisible()
  await expect(switcher(page).locator('img')).toHaveCount(0)
  await expect(page.getByRole('main').locator('img')).toHaveCount(0)
})

test('Arabic: the Arabic name and the logo, on a desktop and on a phone', async () => {
  await setLanguage(page, 'ar')
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/b/${moon}`)
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
  await expect(page.getByRole('heading', { level: 1, name: AR })).toBeVisible()
  await expect(page).toHaveTitle(new RegExp(AR))
  await expect(page.getByText(EN)).toHaveCount(0)
  const trigger = switcher(page)
  await expect(trigger).toHaveAccessibleName(new RegExp(AR))
  await expect(trigger).toHaveAttribute('title', AR)
  await expect.poll(() => loadedWidth(logoOf(trigger, AR))).toBe(64)
  await expect.poll(() => loadedWidth(logoOf(page.getByRole('main'), AR))).toBe(64)

  // The list: the Arabic name where there is one, else the legal name.
  await trigger.click()
  const items = page.getByRole('menuitemradio')
  await expect(items).toHaveText([new RegExp(AR), new RegExp(OTHER)])
  await page.keyboard.press('Escape')

  // Smart Setup's "ready" screen (kept across reloads) names the business the same way.
  await page.goto(`/setup?done=${moon}`)
  await expect(page.getByRole('heading', { level: 1, name: 'BizCost جاهز لك' })).toBeVisible()
  await expect(page.getByText(new RegExp(`تم إعداد \\u2068?${AR}`))).toBeVisible()
  await expect(page.getByText(EN)).toHaveCount(0)

  // On a phone the switcher is in the top bar, with the logo; nothing runs off the screen.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/b/${moon}`)
  const phone = switcher(page)
  await expect(phone).toBeVisible()
  await expect(phone).toContainText(AR)
  await expect.poll(() => loadedWidth(logoOf(phone, AR))).toBe(64)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  // The phone's Dashboard tab keeps its name «الرئيسية» (D-098).
  await expect(
    page.getByRole('navigation', { name: 'القائمة الرئيسية' }).getByRole('link').first(),
  ).toHaveText('الرئيسية')
  await setLanguage(page, 'en')
})

test('a logo whose link no longer works is fetched again', async ({ browser }) => {
  // A browser that has not loaded the logo yet (the owner's session, empty caches).
  const fresh = await browser.newContext({
    baseURL,
    storageState: await context.storageState(),
    viewport: { width: 1440, height: 900 },
  })
  const tab = await fresh.newPage()
  const isMe = (url: string) => new URL(url).pathname.split('/').at(-1)!.split(',').includes('me')
  // The logo's link fails the way an expired signed link does, until the page asks for `me` again.
  let meAgain = false
  let failed = 0
  tab.on('request', (request) => {
    if (isMe(request.url())) meAgain = true
  })
  await tab.route('**/storage/v1/object/sign/business-files/**', async (route) => {
    if (meAgain) return route.continue()
    failed++
    await route.fulfill({ status: 400, body: '{"error":"InvalidJWT"}' })
  })
  await tab.goto(`/b/${moon}`)
  await expect.poll(() => meAgain).toBe(true)
  expect(failed).toBeGreaterThan(0)
  // `me` came again: the logo is tried again and shows.
  await expect.poll(() => loadedWidth(logoOf(switcher(tab), EN))).toBe(64)
  await expect.poll(() => loadedWidth(logoOf(tab.getByRole('main'), EN))).toBe(64)
  await fresh.close()
})

test('the invitation page and email name the business in their language', async ({ browser }) => {
  const roles = await callApi<{ id: string; templateKey: string | null }[]>(
    page,
    'role.list',
    {},
    { businessId: moon, query: true },
  )
  const employee = roles.data?.find((role) => role.templateKey === 'employee')
  const arabicEmail = uniqueEmail('arabic-name')
  const englishEmail = uniqueEmail('english-name')
  for (const [email, locale] of [
    [arabicEmail, 'ar'],
    [englishEmail, 'en'],
  ] as const) {
    const created = await callApi(
      page,
      'invitation.create',
      { id: randomUUID(), email, roleId: employee?.id, locale },
      { businessId: moon },
    )
    expect(created.appCode).toBeUndefined()
  }
  const arabic = await nextInvitation(arabicEmail)
  expect(arabic.subject).toContain(AR)
  expect(arabic.subject).not.toContain(EN)
  const english = await nextInvitation(englishEmail)
  expect(english.subject).toContain(EN)
  expect(english.subject).not.toContain(AR)

  const visitor = await browser.newContext({ baseURL })
  await useLanguage(visitor, 'ar')
  const invitePage = await visitor.newPage()
  await invitePage.goto(`/invite/${arabic.token}`)
  await expect(
    invitePage.getByRole('heading', { name: new RegExp(`انضم إلى .*${AR}`) }),
  ).toBeVisible()
  await expect(invitePage.getByText(EN)).toHaveCount(0)
  // The sign-up page says which business, by the same name.
  await invitePage.getByRole('button', { name: 'إنشاء حساب' }).click()
  await expect(invitePage).toHaveURL('/signup')
  await expect(invitePage.getByText(new RegExp(AR))).toBeVisible()

  // The same link in English: the legal name.
  await useLanguage(visitor, 'en')
  await invitePage.goto(`/invite/${arabic.token}`)
  await expect(invitePage.getByRole('heading', { name: new RegExp(`Join .*${EN}`) })).toBeVisible()
  await visitor.close()
})

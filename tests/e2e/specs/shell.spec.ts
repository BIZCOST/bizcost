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

// The app shell of a business (ROADMAP.md Step 7, D-089–D-093): the sidebar from 1024px (English and
// Arabic, and by keyboard), the icon rail on tablets, the tab bar on phones, and focus that is never
// hidden under the bars; the Dashboard's checklist as the owner completes it (TRN, invitation, branch,
// profile) and as capabilities bring steps; an employee's Dashboard and settings (403), and a role
// without the Dashboard; "Page not found" inside the shell; the browser holding only its page's
// messages and drawing Arabic in the Arabic face. One signed-in owner for the file (the local Auth
// server limits sign-ins per IP).

test.describe.configure({ mode: 'serial' })

let owner: TestUser
let context: BrowserContext
let page: Page
let businessId: string
const cleanup: string[] = []

test.beforeAll(async ({ browser }) => {
  owner = await createUser('shell')
  cleanup.push(owner.id)
  context = await browser.newContext({ baseURL, locale: 'en-US' })
  await useLanguage(context, 'en')
  page = await context.newPage()
  await signIn(page, owner)
  businessId = await createBusiness(page, 'Al Noor Workshop', WORKSHOP_ANSWERS)
})

test.afterAll(async () => {
  await context?.close()
  for (const id of cleanup) await deleteUser(id)
})

const home = () => `/b/${businessId}`
const mainNav = (p: Page, name = 'Main') => p.getByRole('navigation', { name })
const checklist = (p: Page) => p.getByRole('region', { name: 'Finish setting up' })
const step = (p: Page, id: string) => p.locator(`[data-step="${id}"]`)

async function box(locator: Locator) {
  const found = await locator.boundingBox()
  if (!found) throw new Error('not visible')
  return found
}

/**
 * Tabs through the page (forward, then back) and returns every focused control that ended up under
 * the sticky top bar or the phone's tab bar (WCAG 2.4.11): none should.
 */
async function hiddenFocus(p: Page, presses: number): Promise<string[]> {
  const hidden: string[] = []
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let i = 0; i < presses; i++) {
      await p.keyboard.press(key)
      const found = await p.evaluate(() => {
        const el = document.activeElement
        if (!el || el === document.body || getComputedStyle(el).position === 'fixed') return null
        const bars = [...document.querySelectorAll('header, nav')].filter((bar) => {
          const position = getComputedStyle(bar).position
          return (position === 'fixed' || position === 'sticky') && bar.getClientRects().length > 0
        })
        if (bars.some((bar) => bar.contains(el))) return null
        const r = el.getBoundingClientRect()
        for (const bar of bars) {
          const b = bar.getBoundingClientRect()
          const overlap = Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top)
          if (overlap > 1) return `${(el.textContent ?? '').trim().slice(0, 30)} (${overlap}px)`
        }
        return null
      })
      if (found) hidden.push(found)
    }
  }
  return hidden
}

test('desktop: the sidebar lists the business’s sections, Settings last, the current one marked', async () => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(home())
  const nav = mainNav(page)
  await expect(nav.getByRole('link')).toHaveText(['Dashboard', 'Settings'])
  await expect(nav.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('aria-current', 'page')
  // On the start side, 16rem wide, beside the page; the switcher is in it, not in the top bar.
  const sidebar = await box(nav)
  expect(sidebar.x).toBeLessThan(20)
  const switcher = page.getByRole('button', { name: /^Switch business: / })
  await expect(switcher).toHaveCount(1)
  expect((await box(switcher)).x).toBeLessThan(256)
  // No tab bar on a desktop.
  await expect(mainNav(page)).toHaveCount(1)

  await nav.getByRole('link', { name: 'Settings' }).click()
  await expect(page).toHaveURL(`${home()}/settings`)
  await expect(nav.getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page')
  await expect(nav.getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute('aria-current')
  await page.getByRole('link', { name: /^Team/ }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Team' })).toBeVisible()
  // Every settings page keeps Settings marked.
  await expect(nav.getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page')
})

test('desktop in Arabic: the same sections on the right, in Arabic', async () => {
  await setLanguage(page, 'ar')
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(home())
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
  const nav = mainNav(page, 'القائمة الرئيسية')
  await expect(nav.getByRole('link')).toHaveText(['الرئيسية', 'الإعدادات'])
  await expect(nav.getByRole('link', { name: 'الرئيسية' })).toHaveAttribute('aria-current', 'page')
  const sidebar = await box(nav)
  expect(sidebar.x + sidebar.width).toBeGreaterThan(1420)
  // One «الرئيسية» on the page: the account menu has no second link with that name in a business.
  await page.getByRole('button', { name: /^قائمة الحساب/ }).click()
  await expect(page.getByRole('menuitem', { name: 'الحساب' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'الرئيسية' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await nav.getByRole('link', { name: 'الإعدادات' }).click()
  await expect(page).toHaveURL(`${home()}/settings`)
  await expect(page.getByRole('heading', { level: 1, name: 'الإعدادات' })).toBeVisible()
  await setLanguage(page, 'en')
})

test('keyboard: skip link first, then the sidebar in order; Enter opens a section', async () => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(home())
  // The business has arrived (while it loads, the shell's placeholder takes no focus).
  await expect(mainNav(page).getByRole('link', { name: 'Dashboard' })).toBeVisible()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: 'BizCost home' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: /^Switch business: / })).toBeFocused()
  await page.keyboard.press('Tab')
  const nav = mainNav(page)
  await expect(nav.getByRole('link', { name: 'Dashboard' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(nav.getByRole('link', { name: 'Settings' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(`${home()}/settings`)
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()

  // The skip link jumps over the navigation to the page.
  await page.goto(home())
  await expect(mainNav(page).getByRole('link', { name: 'Dashboard' })).toBeVisible()
  await page.keyboard.press('Tab')
  await page.keyboard.press('Enter')
  await expect(page.locator('main#main')).toBeFocused()
})

test('tablet: an icon rail whose names show in tooltips; the switcher in the top bar', async () => {
  await page.setViewportSize({ width: 768, height: 1024 })
  await page.goto(home())
  const nav = mainNav(page)
  const rail = await box(nav)
  expect(rail.width).toBeLessThanOrEqual(73)
  // The names are hidden on screen but stay the links' names.
  const settings = nav.getByRole('link', { name: 'Settings' })
  await expect(settings).toBeVisible()
  await expect(settings.getByText('Settings')).toHaveClass(/sr-only/)
  expect((await box(settings)).height).toBeGreaterThanOrEqual(44)
  await settings.hover()
  const tooltip = page.locator('[data-slot="tooltip-content"]')
  await expect(tooltip).toBeVisible()
  await expect(tooltip).toHaveText('Settings')
  // Said once: the link's name, not also its description.
  await expect(tooltip).toHaveAttribute('aria-hidden', 'true')
  await expect(settings).not.toHaveAttribute('aria-describedby', /./)
  const switcher = page.getByRole('button', { name: /^Switch business: / })
  await expect(switcher).toHaveCount(1)
  expect((await box(switcher)).x).toBeGreaterThan(rail.width)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(768)
})

test('phone: tabs at the bottom, 44px tall, no "+" or "More", nothing off the screen', async () => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto(home())
  const tabs = mainNav(page)
  const bar = await box(tabs)
  expect(bar.y + bar.height).toBeGreaterThan(800)
  await expect(tabs.getByRole('link')).toHaveText(['Dashboard', 'Settings'])
  await expect(tabs.getByRole('button')).toHaveCount(0)
  for (const link of await tabs.getByRole('link').all()) {
    expect((await box(link)).height).toBeGreaterThanOrEqual(44)
  }
  await expect(tabs.getByRole('link', { name: 'Dashboard' })).toHaveAttribute(
    'aria-current',
    'page',
  )
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375)
  // The last of the page is not hidden behind the tabs.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  const note = page.getByText('Your sections will appear here as soon as they are ready.')
  expect((await box(note)).y + (await box(note)).height).toBeLessThanOrEqual(bar.y)

  await tabs.getByRole('link', { name: 'Settings' }).click()
  await expect(page).toHaveURL(`${home()}/settings`)
  await expect(tabs.getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page')
  await page.setViewportSize({ width: 1280, height: 720 })
})

test('focus never lands under the top bar or the tab bar: phone, and 200% zoom', async () => {
  for (const size of [
    { width: 375, height: 667 },
    { width: 640, height: 360 },
  ]) {
    await page.setViewportSize(size)
    await page.goto(home())
    await expect(checklist(page)).toBeVisible()
    expect(await hiddenFocus(page, 14), `dashboard ${size.width}`).toEqual([])
    await page.goto(`${home()}/settings/business`)
    await expect(page.getByRole('heading', { level: 1, name: 'Business profile' })).toBeVisible()
    expect(await hiddenFocus(page, 30), `business profile ${size.width}`).toEqual([])
  }
  await page.setViewportSize({ width: 1280, height: 720 })
})

test('checklist: each step is done as the owner does it, then "You’re all set"', async () => {
  await page.setViewportSize({ width: 1280, height: 900 })
  // The steps come with the page (server render): no placeholder while the page runs.
  const html = await (await page.request.get(home())).text()
  expect(html).toContain('data-step="trn"')
  await page.goto(home())
  const list = checklist(page)
  await expect(list).toContainText('0 of 4 done')
  await expect(list.getByRole('link')).toHaveText([
    'Complete your business profile',
    'Add your TRN',
    'Invite your first team member',
    'Add your second branch',
  ])
  await expect(page.getByRole('progressbar', { name: 'Setup progress' })).toHaveAttribute(
    'aria-valuenow',
    '0',
  )

  // TRN: Smart Setup knows the business is VAT registered, not its number. Opened by keyboard: the
  // focus goes to the page, not nowhere.
  await list.getByRole('link', { name: 'Add your TRN' }).focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(`${home()}/settings/business`)
  await expect(page.locator('main#main')).toBeFocused()
  await page.getByRole('textbox', { name: 'Tax Registration Number (TRN)' }).fill('100123456700003')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Business details saved.')).toBeVisible()
  await mainNav(page).getByRole('link', { name: 'Dashboard' }).click()
  await expect(list).toContainText('1 of 4 done')
  await expect(step(page, 'trn')).toHaveAttribute('data-done', 'true')
  await expect(step(page, 'trn')).toContainText('Your TRN is saved.')
  await expect(list.getByRole('link', { name: 'Add your TRN' })).toHaveCount(0)

  // An invitation waiting counts as the first team member.
  await list.getByRole('link', { name: 'Invite your first team member' }).click()
  await expect(page).toHaveURL(`${home()}/settings/members`)
  await page.getByRole('button', { name: 'Invite someone' }).click()
  const invite = page.getByRole('dialog', { name: 'Invite someone' })
  await invite.getByRole('textbox', { name: 'Their email' }).fill(uniqueEmail('shell-invitee'))
  await invite.getByRole('button', { name: 'Send invitation' }).click()
  await expect(page.getByText(/^Invitation sent to /)).toBeVisible()
  await mainNav(page).getByRole('link', { name: 'Dashboard' }).click()
  await expect(list).toContainText('2 of 4 done')
  await expect(step(page, 'invite')).toHaveAttribute('data-done', 'true')

  await list.getByRole('link', { name: 'Add your second branch' }).click()
  await expect(page).toHaveURL(`${home()}/settings/locations`)
  await page.getByRole('button', { name: 'Add branch' }).click()
  const branch = page.getByRole('dialog', { name: 'Add a branch' })
  await branch.getByRole('textbox', { name: 'Branch name' }).fill('Mussafah')
  await branch.getByRole('button', { name: 'Add branch' }).click()
  await expect(page.locator('[data-location]')).toHaveCount(2)
  await mainNav(page).getByRole('link', { name: 'Dashboard' }).click()
  await expect(list).toContainText('3 of 4 done')

  // The profile: what is missing is said, and it is done with the name in Arabic and a logo.
  await expect(step(page, 'profile')).toContainText(
    'Add your business name in Arabic and your logo.',
  )
  await list.getByRole('link', { name: 'Complete your business profile' }).click()
  await page.locator('input[type=file]').setInputFiles({
    name: 'logo.png',
    mimeType: 'image/png',
    buffer: pngImage(),
  })
  await expect(page.getByText('Logo saved.')).toBeVisible()
  await mainNav(page).getByRole('link', { name: 'Dashboard' }).click()
  await expect(step(page, 'profile')).toContainText('Add your business name in Arabic.')
  await mainNav(page).getByRole('link', { name: 'Settings' }).click()
  await page.getByRole('link', { name: /^Business profile/ }).click()
  await page.getByRole('textbox', { name: 'Business name in Arabic' }).fill('ورشة النور')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Business details saved.')).toBeVisible()

  await mainNav(page).getByRole('link', { name: 'Dashboard' }).click()
  const allSet = page.getByRole('region', { name: "You're all set" })
  await expect(allSet).toBeVisible()
  await expect(checklist(page)).toHaveCount(0)
  await allSet.getByRole('button', { name: 'Hide' }).focus()
  await page.keyboard.press('Enter')
  await expect(allSet).toHaveCount(0)
  // The button went with the card: the focus moves on to what follows.
  await expect(page.getByRole('heading', { name: 'About your business' })).toBeFocused()

  // Loaded again: the server knows it was hidden, so neither the card nor a placeholder ever shows.
  const fresh = await context.newPage()
  await fresh.addInitScript(() => {
    const seen: string[] = []
    ;(window as unknown as { seen: string[] }).seen = seen
    new MutationObserver(() => {
      if (document.querySelector('[aria-labelledby="all-set-title"]')) seen.push('all set')
      if (document.querySelector('section[aria-busy]')) seen.push('placeholder')
    }).observe(document, { subtree: true, childList: true })
  })
  await fresh.setViewportSize({ width: 1280, height: 900 })
  await fresh.goto(home())
  await expect(fresh.getByRole('heading', { level: 1, name: 'Al Noor Workshop' })).toBeVisible()
  await expect(fresh.getByRole('region', { name: 'About your business' })).toBeVisible()
  await expect(fresh.getByRole('region', { name: "You're all set" })).toHaveCount(0)
  await expect(checklist(fresh)).toHaveCount(0)
  expect(await fresh.evaluate(() => (window as unknown as { seen: string[] }).seen)).toEqual([])
  await fresh.close()
})

test('checklist: a step comes with its capability', async () => {
  const bakery = await createBusiness(page, 'Maha Bakes', BAKER_ANSWERS)
  await page.goto(`/b/${bakery}`)
  // A solo home business without VAT: only its profile.
  await expect(checklist(page).getByRole('link')).toHaveText(['Complete your business profile'])
  await expect(checklist(page)).toContainText('0 of 1 done')
  const customize = (key: string, enabled: boolean) =>
    callApi(
      page,
      'business.customize',
      { item: { kind: 'capability', key }, enabled },
      { businessId: bakery },
    )
  expect((await customize('has_team', true)).appCode).toBeUndefined()
  await page.reload()
  await expect(checklist(page).getByRole('link')).toHaveText([
    'Complete your business profile',
    'Invite your first team member',
  ])
  expect((await customize('has_team', false)).appCode).toBeUndefined()
  await page.reload()
  await expect(checklist(page).getByRole('link')).toHaveText(['Complete your business profile'])
})

test('an employee sees no checklist, and settings sections are not open (403)', async ({
  browser,
}) => {
  const employee = await createUser('shell-employee')
  cleanup.push(employee.id)
  const roles = await callApi<{ id: string; templateKey: string | null }[]>(
    page,
    'role.list',
    {},
    { businessId, query: true },
  )
  const role = roles.data?.find((r) => r.templateKey === 'employee')
  const created = await callApi(
    page,
    'invitation.create',
    { id: randomUUID(), email: employee.email, roleId: role?.id, locale: 'en' },
    { businessId },
  )
  expect(created.appCode).toBeUndefined()
  const { token } = await nextInvitation(employee.email)
  const employeeContext = await browser.newContext({ baseURL, locale: 'en-US' })
  await useLanguage(employeeContext, 'en')
  const employeePage = await employeeContext.newPage()
  await signIn(employeePage, employee)
  expect((await callApi(employeePage, 'invitation.accept', { token })).appCode).toBeUndefined()

  await employeePage.goto(home())
  await expect(
    employeePage.getByRole('heading', { level: 1, name: 'Al Noor Workshop' }),
  ).toBeVisible()
  await expect(
    employeePage.getByRole('region', { name: 'Al Noor Workshop' }).getByText('Employee'),
  ).toBeVisible()
  await expect(employeePage.getByRole('region', { name: 'About your business' })).toBeVisible()
  await expect(checklist(employeePage)).toHaveCount(0)
  await expect(employeePage.getByRole('progressbar')).toHaveCount(0)
  expect(
    (await callApi(employeePage, 'dashboard.checklist', {}, { businessId, query: true })).data,
  ).toEqual({ items: [] })
  await expect(mainNav(employeePage).getByRole('link')).toHaveText(['Dashboard', 'Settings'])

  for (const section of ['business', 'members', 'modules']) {
    await employeePage.goto(`${home()}/settings/${section}`)
    await expect(
      employeePage.getByRole('heading', { level: 1, name: "This section isn't open to you" }),
    ).toBeVisible()
    // What screen readers announce after the navigation: the state, not the section.
    await expect(employeePage).toHaveTitle("This section isn't open to you · BizCost")
  }
  await employeePage.getByRole('link', { name: 'Back to settings' }).click()
  await expect(employeePage).toHaveURL(`${home()}/settings`)
  await expect(employeePage.getByRole('list', { name: 'Business settings' })).toHaveCount(0)

  // A role without the Dashboard: the business opens on the member's first section (Settings).
  const employeeRole = (
    await callApi<{ id: string; templateKey: string | null; version: number }[]>(
      page,
      'role.list',
      {},
      { businessId, query: true },
    )
  ).data?.find((r) => r.templateKey === 'employee')
  const edited = await callApi(
    page,
    'role.updatePermissions',
    { id: employeeRole?.id, version: employeeRole?.version, permissionKeys: [] },
    { businessId },
  )
  expect(edited.appCode).toBeUndefined()
  await employeePage.goto(home())
  await expect(employeePage).toHaveURL(`${home()}/settings`)
  await expect(mainNav(employeePage).getByRole('link')).toHaveText(['Settings'])
  await employeeContext.close()
})

test('an address that does not exist inside the business: "Page not found" inside the shell', async () => {
  await page.setViewportSize({ width: 1440, height: 900 })
  for (const path of ['orders', 'settings/nothing-here']) {
    await page.goto(`${home()}/${path}`)
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible()
    await expect(page).toHaveTitle('Page not found · BizCost')
    await expect(mainNav(page).getByRole('link')).toHaveText(['Dashboard', 'Settings'])
  }
  await page.getByRole('link', { name: 'Go to Dashboard' }).click()
  await expect(page).toHaveURL(home())
})

test('the browser holds only its page’s language and messages; switching needs no reload', async ({
  browser,
}) => {
  const visitor = await browser.newContext({ baseURL, locale: 'en-US' })
  await useLanguage(visitor, 'en')
  const login = await visitor.newPage()
  const response = await login.goto('/login')
  const html = (await response?.text()) ?? ''
  expect(html).toContain('Forgot password?')
  // Not the Arabic, nor another route's namespace, nor the API's emails.
  for (const absent of [
    'نسيت كلمة المرور؟',
    'Your business name, logo and VAT details.',
    'Finish setting up',
    'If the button doesn',
  ]) {
    expect(html, absent).not.toContain(absent)
  }
  // The code holds no translations at all.
  const scripts = await login
    .locator('script[src]')
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLScriptElement).src))
  for (const src of scripts) {
    const code = await (await login.request.get(src)).text()
    for (const text of [
      'Welcome back to BizCost.',
      'أهلًا بعودتك إلى BizCost.',
      'Forgot password?',
    ]) {
      expect(code.includes(text), `${text} in ${src}`).toBe(false)
    }
  }

  const family = await login.evaluate(() => getComputedStyle(document.body).fontFamily)
  const arabicFace = family.indexOf('"IBM Plex Sans Arabic"')
  expect(arabicFace, family).toBeGreaterThan(0)
  expect(family.slice(0, arabicFace), family).not.toContain('Fallback')

  await login.evaluate(() => {
    ;(window as unknown as { stayed: boolean }).stayed = true
  })
  await login.getByRole('button', { name: /^Change language/ }).click()
  await login.getByRole('menuitem', { name: 'العربية' }).click()
  await expect(login.locator('html')).toHaveAttribute('dir', 'rtl')
  await expect(login.getByRole('link', { name: 'نسيت كلمة المرور؟' })).toBeVisible()
  expect(await login.evaluate(() => (window as unknown as { stayed?: boolean }).stayed)).toBe(true)
  await visitor.close()
})

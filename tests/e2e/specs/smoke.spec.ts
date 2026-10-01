import { randomBytes, randomUUID } from 'node:crypto'
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import {
  callApi,
  createBusiness,
  createUser,
  deleteUser,
  nextInvitation,
  RAW_KEY,
  setLanguage,
  signIn,
  uniqueEmail,
  useLanguage,
  WORKSHOP_ANSWERS,
  type TestUser,
} from '../helpers'
import { baseURL } from '../stack'

// Smoke over every M1 screen (ROADMAP.md M1 definition of done: "every M1 screen works in Arabic RTL
// and English LTR at 375, 768 and 1440 px"): the auth pages, the invitation page, home, Smart Setup,
// the account, the business's Dashboard and every settings section, and the states (page not found,
// not a member, a section that is not open, an invitation for another email). On each, in each
// language and at each width: <html lang dir> of the language, a visible h1, nothing wider than the
// screen, no untranslated key or placeholder in the text or the title, and Arabic text in Arabic
// (English pages hold no Arabic but the name of the language itself). Every problem of a run is
// reported at once (soft checks). Four browsers: signed out, an account without a business, the
// owner of a workshop with every capability on, and an Employee of it.

test.describe.configure({ mode: 'serial' })

type Who = 'visitor' | 'fresh' | 'owner' | 'employee'

interface Screen {
  name: string
  who: Who
  path: () => string
  /** A code this tab asked for (sessionStorage), as the auth pages hand it on. */
  pending?: 'signIn' | 'recovery'
}

const LOCALES = ['en', 'ar'] as const
const WIDTHS = [
  { width: 375, height: 812 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
] as const

const ARABIC = /[\u0600-\u06FF]/

let owner: TestUser
let employee: TestUser
let fresh: TestUser
let businessId: string
let invitationToken: string
const pages = {} as Record<Who, Page>
const contexts: BrowserContext[] = []
const cleanup: string[] = []

async function openAs(browser: Browser, user: TestUser | null): Promise<Page> {
  const context = await browser.newContext({ baseURL, locale: 'en-US' })
  contexts.push(context)
  await useLanguage(context, 'en')
  const page = await context.newPage()
  if (user) await signIn(page, user)
  else await page.goto('/login')
  return page
}

test.beforeAll(async ({ browser }) => {
  owner = await createUser('smoke-owner')
  employee = await createUser('smoke-employee')
  fresh = await createUser('smoke-fresh')
  cleanup.push(owner.id, employee.id, fresh.id)
  pages.owner = await openAs(browser, owner)
  businessId = await createBusiness(page('owner'), 'Smoke Test Workshop', WORKSHOP_ANSWERS)

  const roles = await callApi<{ id: string; templateKey: string | null }[]>(
    page('owner'),
    'role.list',
    {},
    { businessId, query: true },
  )
  const employeeRole = roles.data?.find((r) => r.templateKey === 'employee')?.id
  const invite = async (email: string) => {
    const result = await callApi(
      page('owner'),
      'invitation.create',
      { id: randomUUID(), email, roleId: employeeRole, locale: 'en' },
      { businessId },
    )
    expect(result.appCode).toBeUndefined()
    return (await nextInvitation(email)).token
  }
  const employeeToken = await invite(employee.email)
  // A pending invitation for the invitation page (its address never signs up).
  invitationToken = await invite(uniqueEmail('smoke-invitee'))

  pages.employee = await openAs(browser, employee)
  const accepted = await callApi(page('employee'), 'invitation.accept', { token: employeeToken })
  expect(accepted.appCode).toBeUndefined()
  pages.fresh = await openAs(browser, fresh)
  pages.visitor = await openAs(browser, null)
})

test.afterAll(async () => {
  for (const context of contexts) await context.close()
  for (const id of cleanup) await deleteUser(id)
})

function page(who: Who): Page {
  const found = pages[who]
  if (!found) throw new Error(`no page for ${who}`)
  return found
}

const business = (path = '') => `/b/${businessId}${path}`

const SCREENS: Screen[] = [
  { name: 'sign in', who: 'visitor', path: () => '/login' },
  { name: 'sign up', who: 'visitor', path: () => '/signup' },
  { name: 'forgot password', who: 'visitor', path: () => '/forgot' },
  { name: 'code', who: 'visitor', path: () => '/verify', pending: 'signIn' },
  { name: 'reset code', who: 'visitor', path: () => '/reset', pending: 'recovery' },
  { name: 'invitation', who: 'visitor', path: () => `/invite/${invitationToken}` },
  {
    name: 'invitation that does not work',
    who: 'visitor',
    path: () => `/invite/${randomBytes(32).toString('base64url')}`,
  },
  { name: 'home without a business', who: 'fresh', path: () => '/' },
  { name: 'Smart Setup', who: 'fresh', path: () => '/setup' },
  { name: 'account', who: 'fresh', path: () => '/account' },
  { name: 'page not found', who: 'fresh', path: () => '/no-such-page' },
  { name: 'Dashboard', who: 'owner', path: () => business() },
  { name: 'settings', who: 'owner', path: () => business('/settings') },
  { name: 'business profile', who: 'owner', path: () => business('/settings/business') },
  { name: 'branches', who: 'owner', path: () => business('/settings/locations') },
  { name: 'team', who: 'owner', path: () => business('/settings/members') },
  { name: 'roles', who: 'owner', path: () => business('/settings/roles') },
  { name: 'Customize BizCost', who: 'owner', path: () => business('/settings/modules') },
  { name: 'language', who: 'owner', path: () => business('/settings/language') },
  { name: 'page not found in the shell', who: 'owner', path: () => business('/orders') },
  { name: 'not a member', who: 'owner', path: () => `/b/${randomUUID()}` },
  {
    name: 'invitation for another email',
    who: 'owner',
    path: () => `/invite/${invitationToken}`,
  },
  { name: 'Dashboard of an Employee', who: 'employee', path: () => business() },
  {
    name: 'a section not open to an Employee',
    who: 'employee',
    path: () => business('/settings/business'),
  },
]

async function inLanguage(locale: 'en' | 'ar') {
  for (const who of ['owner', 'employee', 'fresh'] as const) await setLanguage(page(who), locale)
  await useLanguage(page('visitor').context(), locale)
}

async function open(screen: Screen, path: string) {
  const p = page(screen.who)
  if (screen.pending) {
    const pending = {
      email: 'smoke-visitor@test.bizcost.local',
      purpose: screen.pending,
      sentAt: Date.now(),
    }
    await p.evaluate(
      (value) => sessionStorage.setItem('bz_pending_code', value),
      JSON.stringify(pending),
    )
  }
  await p.goto(path, { waitUntil: 'networkidle' })
  return p
}

for (const locale of LOCALES) {
  test.describe(`${locale === 'ar' ? 'Arabic (RTL)' : 'English (LTR)'}`, () => {
    test.beforeAll(async () => {
      await inLanguage(locale)
    })

    for (const size of WIDTHS) {
      test(`every M1 screen at ${size.width} px`, async () => {
        for (const who of Object.keys(pages) as Who[]) await page(who).setViewportSize(size)
        for (const screen of SCREENS) {
          await test.step(screen.name, async () => {
            const path = screen.path()
            const p = await open(screen, path)
            const what = `${screen.name} (${locale}, ${size.width} px, ${p.url().replace(baseURL, '')})`
            // The screen itself, not a redirect (to sign in, or away from a code page).
            expect.soft(new URL(p.url()).pathname, `${what}: stayed on the screen`).toBe(path)
            await expect.soft(p.locator('html'), what).toHaveAttribute('lang', locale)
            await expect
              .soft(p.locator('html'), what)
              .toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr')
            await expect
              .soft(p.locator('h1:visible').first(), `${what}: a visible h1`)
              .toBeVisible()
            const measured = await p.evaluate(() => ({
              scrollWidth: document.documentElement.scrollWidth,
              clientWidth: document.documentElement.clientWidth,
              text: `${document.title}\n${document.body.innerText}`,
            }))
            expect
              .soft(measured.scrollWidth, `${what}: wider than the screen`)
              .toBeLessThanOrEqual(measured.clientWidth)
            const text = measured.text.replace(/\S+@\S+/g, '')
            expect.soft(RAW_KEY.exec(text)?.[0], `${what}: an untranslated key`).toBeUndefined()
            expect.soft(text, `${what}: a placeholder`).not.toContain('{{')
            if (locale === 'ar') {
              expect.soft(ARABIC.test(text), `${what}: Arabic text`).toBe(true)
            } else {
              const arabic = text.replaceAll('العربية', '').match(/[\u0600-\u06FF]+/g)
              expect.soft(arabic, `${what}: Arabic in the English page`).toBeNull()
            }
          })
        }
      })
    }
  })
}

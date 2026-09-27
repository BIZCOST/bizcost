import { randomUUID } from 'node:crypto'
import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import {
  BAKER_ANSWERS,
  callApi,
  createBusiness,
  createUser,
  deleteUser,
  nextInvitation,
  signIn,
  useLanguage,
  WORKSHOP_ANSWERS,
  type TestUser,
} from '../helpers'
import { baseURL } from '../stack'

// M1 definition of done (ROADMAP.md): no cache leak when switching businesses or when two businesses
// are open in two tabs, and stale `me`/permissions refresh after FORBIDDEN (docs/ARCHITECTURE.md
// §Data fetching & caching: one QueryClient per business, x-business-id on every request, and
// `me` and `business.context` fetched again when the API refuses because access changed, or when an
// answer carries a newer x-permissions-version). One owner with two businesses, and members whose
// role changes while their page stays open (less access, then more).

test.describe.configure({ mode: 'serial' })

const WORKSHOP = 'Al Noor Workshop'
const BAKERY = 'Sara Sweets'

let owner: TestUser
let context: BrowserContext
let page: Page
let workshop: string
let bakery: string
const cleanup: string[] = []

test.beforeAll(async ({ browser }) => {
  owner = await createUser('isolation')
  cleanup.push(owner.id)
  context = await browser.newContext({ baseURL, locale: 'en-US' })
  await useLanguage(context, 'en')
  page = await context.newPage()
  await signIn(page, owner)
  workshop = await createBusiness(page, WORKSHOP, WORKSHOP_ANSWERS)
  bakery = await createBusiness(page, BAKERY, BAKER_ANSWERS)
})

test.afterAll(async () => {
  await context?.close()
  for (const id of cleanup) await deleteUser(id)
})

const sectionLinks = (p: Page) =>
  p.getByRole('list', { name: 'Business settings' }).getByRole('link')
const businessName = (p: Page) => p.getByRole('textbox', { name: 'Business name', exact: true })
/** "Settings" in the shell's sidebar. */
const settingsLink = (p: Page) =>
  p.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings' })

/** The x-business-id of every API request the page sends from now on ('' when it has none). */
function businessHeaders(p: Page): string[] {
  const seen: string[] = []
  p.on('request', (request) => {
    if (request.url().includes('/api/trpc/')) seen.push(request.headers()['x-business-id'] ?? '')
  })
  return seen
}

/** Marks the document, so a later check can tell that no reload happened. */
async function markDocument(p: Page): Promise<void> {
  await p.evaluate(() => {
    ;(window as unknown as { __sameDocument?: boolean }).__sameDocument = true
  })
}

async function sameDocument(p: Page): Promise<boolean> {
  return p.evaluate(() =>
    Boolean((window as unknown as { __sameDocument?: boolean }).__sameDocument),
  )
}

/** The settings' Business profile, reached by links (no page load). */
async function openProfile(p: Page): Promise<void> {
  await settingsLink(p).click()
  await expect(p.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
  await sectionLinks(p)
    .filter({ hasText: /^Business profile/ })
    .click()
  await expect(p.getByRole('heading', { level: 1, name: 'Business profile' })).toBeVisible()
}

test('two businesses in two tabs: each tab shows, asks for and changes only its own', async () => {
  const tabA = page
  const tabB = await context.newPage()
  const headersA = businessHeaders(tabA)
  const headersB = businessHeaders(tabB)

  await tabA.goto(`/b/${workshop}`)
  await expect(tabA.getByRole('heading', { level: 1 })).toHaveText(WORKSHOP)
  await tabB.goto(`/b/${bakery}`)
  await expect(tabB.getByRole('heading', { level: 1 })).toHaveText(BAKERY)
  await markDocument(tabA)
  await markDocument(tabB)

  // Turn by turn, each tab moves inside its business without a page load.
  await openProfile(tabA)
  await openProfile(tabB)
  await expect(businessName(tabA)).toHaveValue(WORKSHOP)
  await expect(businessName(tabB)).toHaveValue(BAKERY)
  await settingsLink(tabA).click()
  await settingsLink(tabB).click()
  // The workshop has a team and branches; the home bakery has neither.
  await expect(sectionLinks(tabA).filter({ hasText: /^Team/ })).toHaveCount(1)
  await expect(sectionLinks(tabA).filter({ hasText: /^Branches/ })).toHaveCount(1)
  await expect(sectionLinks(tabB)).toHaveText([
    /^Business profile/,
    /^Customize BizCost/,
    /^Language/,
  ])

  // A change in tab B stays in business B.
  await sectionLinks(tabB)
    .filter({ hasText: /^Business profile/ })
    .click()
  await businessName(tabB).fill(`${BAKERY} & Cakes`)
  await tabB.getByRole('button', { name: 'Save changes' }).click()
  await expect(tabB.getByText('Business details saved.')).toBeVisible()
  await sectionLinks(tabA)
    .filter({ hasText: /^Business profile/ })
    .click()
  await expect(businessName(tabA)).toHaveValue(WORKSHOP)

  expect(await sameDocument(tabA)).toBe(true)
  expect(await sameDocument(tabB)).toBe(true)
  // Every request of a tab named its own business.
  const named = (headers: string[]) => headers.filter(Boolean)
  expect(named(headersA).length).toBeGreaterThan(0)
  expect(named(headersB).length).toBeGreaterThan(0)
  expect(new Set(named(headersA))).toEqual(new Set([workshop]))
  expect(new Set(named(headersB))).toEqual(new Set([bakery]))
  await tabB.close()
})

test('switching businesses in one tab: nothing of the first shows in the second, and back', async () => {
  await page.goto(`/b/${workshop}/settings`)
  await expect(sectionLinks(page).filter({ hasText: /^Team/ })).toHaveCount(1)
  await markDocument(page)
  const headers = businessHeaders(page)

  await page.getByRole('button', { name: /^Switch business: / }).click()
  await page.getByRole('menuitemradio', { name: new RegExp(BAKERY) }).click()
  await expect(page).toHaveURL(`/b/${bakery}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${BAKERY} & Cakes`)
  const fromSwitch = headers.length
  await openProfile(page)
  await expect(businessName(page)).toHaveValue(`${BAKERY} & Cakes`)
  await settingsLink(page).click()
  await expect(sectionLinks(page).filter({ hasText: /^Team/ })).toHaveCount(0)
  await expect(sectionLinks(page).filter({ hasText: /^Branches/ })).toHaveCount(0)
  // After the switch, every request named the bakery.
  expect(new Set(headers.slice(fromSwitch).filter(Boolean))).toEqual(new Set([bakery]))

  // Back to the workshop: its own data again, not the bakery's.
  await page.getByRole('button', { name: /^Switch business: / }).click()
  await page.getByRole('menuitemradio', { name: new RegExp(WORKSHOP) }).click()
  await expect(page).toHaveURL(`/b/${workshop}`)
  await settingsLink(page).click()
  await expect(sectionLinks(page).filter({ hasText: /^Team/ })).toHaveCount(1)
  await sectionLinks(page)
    .filter({ hasText: /^Business profile/ })
    .click()
  await expect(businessName(page)).toHaveValue(WORKSHOP)
  expect(await sameDocument(page)).toBe(true)
})

test('a role changed while the page is open: the refusal refreshes the member’s access, no reload', async ({
  browser,
}) => {
  // The owner invites a Manager to the workshop.
  const member = await createUser('isolation-member')
  cleanup.push(member.id)
  const roles = await callApi<{ id: string; templateKey: string | null }[]>(
    page,
    'role.list',
    {},
    { businessId: workshop, query: true },
  )
  const roleId = (key: string) => roles.data?.find((r) => r.templateKey === key)?.id ?? ''
  const invited = await callApi(
    page,
    'invitation.create',
    { id: randomUUID(), email: member.email, roleId: roleId('manager'), locale: 'en' },
    { businessId: workshop },
  )
  expect(invited.appCode).toBeUndefined()
  const { token } = await nextInvitation(member.email)

  const memberContext = await browser.newContext({ baseURL, locale: 'en-US' })
  await useLanguage(memberContext, 'en')
  const memberPage = await memberContext.newPage()
  try {
    await signIn(memberPage, member)
    const accepted = await callApi(memberPage, 'invitation.accept', { token })
    expect(accepted.appCode).toBeUndefined()

    await memberPage.goto(`/b/${workshop}/settings`)
    await expect(sectionLinks(memberPage)).toHaveText([
      /^Business profile/,
      /^Branches/,
      /^Team/,
      /^Language/,
    ])
    await markDocument(memberPage)

    // Meanwhile the owner makes them an Employee (no business settings).
    const members = await callApi<{ id: string; email: string | null }[]>(
      page,
      'member.list',
      {},
      { businessId: workshop, query: true },
    )
    const memberId = members.data?.find((m) => m.email === member.email)?.id ?? ''
    const changed = await callApi(
      page,
      'member.changeRole',
      { memberId, roleId: roleId('employee') },
      { businessId: workshop },
    )
    expect(changed.appCode).toBeUndefined()

    // The page still lists the old sections. Opening one: the API refuses (FORBIDDEN), the page
    // fetches the member's access again and says the section is not open to them.
    const refused = memberPage.waitForResponse((r) => r.url().includes('business.profile'))
    const refreshed = memberPage.waitForResponse(
      (r) => r.url().includes('business.context') && r.ok(),
    )
    await sectionLinks(memberPage)
      .filter({ hasText: /^Business profile/ })
      .click()
    await refused
    await refreshed
    await expect(
      memberPage.getByRole('heading', { name: "This section isn't open to you" }),
    ).toBeVisible()
    await settingsLink(memberPage).click()
    await expect(memberPage.getByText('The owner and the admins manage')).toBeVisible()
    await expect(memberPage.getByRole('list', { name: 'Business settings' })).toHaveCount(0)
    expect(await sameDocument(memberPage)).toBe(true)
  } finally {
    await memberContext.close()
  }
})

test('a role given more access while the page is open: the next answer’s permissions version refreshes it, no reload', async ({
  browser,
}) => {
  // More access is refused nothing, so only x-permissions-version can tell the page (D-104).
  const member = await createUser('isolation-upgrade')
  cleanup.push(member.id)
  const roles = await callApi<
    { id: string; templateKey: string | null; version: number; permissionKeys: string[] }[]
  >(page, 'role.list', {}, { businessId: workshop, query: true })
  const manager = roles.data?.find((r) => r.templateKey === 'manager')
  if (!manager) throw new Error('no manager role')
  const invited = await callApi(
    page,
    'invitation.create',
    { id: randomUUID(), email: member.email, roleId: manager.id, locale: 'en' },
    { businessId: workshop },
  )
  expect(invited.appCode).toBeUndefined()
  const { token } = await nextInvitation(member.email)

  const memberContext = await browser.newContext({ baseURL, locale: 'en-US' })
  await useLanguage(memberContext, 'en')
  const memberPage = await memberContext.newPage()
  try {
    await memberPage.setViewportSize({ width: 1440, height: 900 })
    await signIn(memberPage, member)
    expect((await callApi(memberPage, 'invitation.accept', { token })).appCode).toBeUndefined()

    await memberPage.goto(`/b/${workshop}/settings/business`)
    const sideNav = memberPage.getByRole('navigation', { name: 'Settings' }).getByRole('listitem')
    await expect(sideNav).toHaveText(['Business profile', 'Branches', 'Team', 'Language'])
    await markDocument(memberPage)

    // Meanwhile the owner lets Managers customize BizCost.
    const granted = await callApi(
      page,
      'role.updatePermissions',
      {
        id: manager.id,
        version: manager.version,
        permissionKeys: [...manager.permissionKeys, 'settings.modules.manage'],
      },
      { businessId: workshop },
    )
    expect(granted.appCode).toBeUndefined()

    // The member opens another section: its answer carries the new version, and the page fetches
    // the member's access again, so the new section shows without a reload or a refusal.
    await sideNav.filter({ hasText: 'Branches' }).getByRole('link').click()
    await expect(memberPage.getByRole('heading', { level: 1, name: 'Branches' })).toBeVisible()
    await expect(sideNav).toHaveText([
      'Business profile',
      'Branches',
      'Team',
      'Customize BizCost',
      'Language',
    ])
    await sideNav.filter({ hasText: 'Customize BizCost' }).getByRole('link').click()
    await expect(
      memberPage.getByRole('heading', { level: 1, name: 'Customize BizCost' }),
    ).toBeVisible()
    expect(await sameDocument(memberPage)).toBe(true)
  } finally {
    await memberContext.close()
  }
})

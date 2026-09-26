import { randomUUID } from 'node:crypto'
import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import {
  ageSignIn,
  callApi,
  createBusiness,
  createUser,
  deleteUser,
  enterCode,
  findUserId,
  nextCode,
  nextInvitation,
  setLanguage,
  signIn,
  uniqueEmail,
  useLanguage,
  withValue,
  WORKSHOP_ANSWERS,
  type TestUser,
} from '../helpers'
import { baseURL } from '../stack'

// Team settings (ROADMAP.md Step 6) end to end: the owner invites someone by email, the email arrives
// (Mailpit), a new user creates an account from the link and joins; the invitation page in Arabic and
// a cancelled link; an employee sees no business settings until the owner changes their role; the team
// can't be switched off while it has members; ownership moves after "confirm it's you"; a removed
// member loses access on their next request; a member leaves from the settings home, after joining a
// business with a long Arabic name on a phone. One signed-in page per person for the whole file.

test.describe.configure({ mode: 'serial' })

const BUSINESS = 'Al Noor Workshop'
const PASSWORD = 'A-long-password-42'

let owner: TestUser
let ownerContext: BrowserContext
let ownerPage: Page
let inviteeContext: BrowserContext
let inviteePage: Page
let businessId: string
const inviteeEmail = uniqueEmail('invitee')
const cleanup: (string | null)[] = []

test.beforeAll(async ({ browser }) => {
  owner = await createUser('team-owner')
  cleanup.push(owner.id)
  ownerContext = await browser.newContext({ baseURL, locale: 'en-US' })
  await useLanguage(ownerContext, 'en')
  ownerPage = await ownerContext.newPage()
  await signIn(ownerPage, owner)
  await callApi(ownerPage, 'account.updateProfile', { displayName: 'Rashed Owner' })
  businessId = await createBusiness(ownerPage, BUSINESS, WORKSHOP_ANSWERS)
  inviteeContext = await browser.newContext({ baseURL, locale: 'en-US' })
  await useLanguage(inviteeContext, 'en')
  inviteePage = await inviteeContext.newPage()
})

test.afterAll(async () => {
  await ownerContext?.close()
  await inviteeContext?.close()
  for (const id of cleanup) await deleteUser(id)
})

const settings = (path = '') => `/b/${businessId}/settings${path}`
const memberRow = (page: Page, email: string) => page.locator(`[data-member="${email}"]`)

async function memberAction(page: Page, email: string, action: string): Promise<void> {
  await memberRow(page, email)
    .getByRole('button', { name: /Options for/ })
    .click()
  await page.getByRole('menuitem', { name: action }).click()
}

test('the owner invites someone; the email arrives and a new user joins from it', async () => {
  await ownerPage.goto(`/b/${businessId}`)
  await ownerPage.getByRole('link', { name: 'Settings' }).click()
  await ownerPage.getByRole('link', { name: /^Team/ }).click()
  await expect(ownerPage.getByRole('heading', { level: 1, name: 'Team' })).toBeVisible()
  await expect(memberRow(ownerPage, owner.email)).toContainText('Owner')

  await ownerPage.getByRole('button', { name: 'Invite someone' }).click()
  const dialog = ownerPage.getByRole('dialog', { name: 'Invite someone' })
  const email = dialog.getByRole('textbox', { name: 'Their email' })
  await email.fill('not-an-email')
  await dialog.getByRole('button', { name: 'Send invitation' }).click()
  await expect(dialog.getByText('Enter a valid email')).toBeVisible()
  await email.fill(inviteeEmail)
  // The least access by default; never the Owner role.
  await expect(dialog.getByRole('radio', { name: /^Employee/ })).toBeChecked()
  await expect(dialog.getByRole('radio', { name: /^Owner/ })).toHaveCount(0)
  await expect(dialog.getByRole('radio', { name: 'English' })).toBeChecked()
  await dialog.getByRole('button', { name: 'Send invitation' }).click()
  await expect(
    ownerPage.getByText(withValue('Invitation sent to ', inviteeEmail, '.')),
  ).toBeVisible()
  const invitation = ownerPage.locator(`[data-invitation="${inviteeEmail}"]`)
  await expect(invitation).toContainText('Waiting')
  await expect(invitation).toContainText('Employee')

  // The same address again: already waiting.
  await ownerPage.getByRole('button', { name: 'Invite someone' }).click()
  await dialog.getByRole('textbox', { name: 'Their email' }).fill(inviteeEmail.toUpperCase())
  await dialog.getByRole('button', { name: 'Send invitation' }).click()
  await expect(dialog.getByText('This email already has an invitation waiting.')).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel' }).click()

  const { token, subject } = await nextInvitation(inviteeEmail)
  expect(subject).toMatch(/Rashed Owner.* invited you to join .*Al Noor Workshop.* on BizCost/)

  // Signed in with another email: told to switch, and no way to join.
  await ownerPage.goto(`/invite/${token}`)
  await expect(ownerPage.getByRole('heading', { name: /Join .*Al Noor Workshop/ })).toBeVisible()
  await expect(ownerPage.getByText('This invitation was sent to')).toBeVisible()
  await expect(
    ownerPage.getByRole('button', { name: 'Sign out and use the invited email' }),
  ).toBeVisible()
  await expect(ownerPage.getByRole('button', { name: 'Accept the invitation' })).toHaveCount(0)

  // Signed out: create an account with the invited email, then come back and join.
  await inviteePage.goto(`/invite/${token}`)
  await expect(inviteePage.getByRole('heading', { name: /Join .*Al Noor Workshop/ })).toBeVisible()
  await expect(
    inviteePage.getByText(/Rashed Owner.* invited you to join their team on BizCost as Employee\./),
  ).toBeVisible()
  await expect(inviteePage.getByText('e•••@test.bizcost.local').first()).toBeVisible()
  // Nothing of the invitation is in the page's links (the token stays in this tab).
  await inviteePage.getByRole('button', { name: 'Create an account' }).click()
  await expect(inviteePage).toHaveURL('/signup')
  // The sign-up page says which business and which (masked) email the invitation is for.
  await expect(inviteePage.getByText(/You're joining .*Al Noor Workshop/)).toBeVisible()
  await expect(inviteePage.getByText('e•••@test.bizcost.local')).toBeVisible()
  await inviteePage.getByLabel('Email', { exact: true }).fill(inviteeEmail)
  await inviteePage.getByRole('textbox', { name: 'Password', exact: true }).fill(PASSWORD)
  await inviteePage.getByRole('button', { name: 'Create account' }).click()
  await expect(inviteePage).toHaveURL('/verify')
  cleanup.push(await findUserId(inviteeEmail))
  await enterCode(inviteePage, await nextCode(inviteeEmail))
  await expect(inviteePage).toHaveURL(`/invite/${token}`)
  await inviteePage.getByRole('button', { name: 'Accept the invitation' }).click()
  await expect(inviteePage).toHaveURL(`/b/${businessId}`)
  await expect(inviteePage.getByRole('heading', { level: 1, name: BUSINESS })).toBeVisible()
  await expect(inviteePage.getByRole('main').getByText('Employee', { exact: true })).toBeVisible()

  // The member appears; the invitation is gone and its link no longer works.
  await ownerPage.goto(settings('/members'))
  await expect(memberRow(ownerPage, inviteeEmail)).toContainText('Employee')
  await expect(ownerPage.locator(`[data-invitation="${inviteeEmail}"]`)).toHaveCount(0)
  await inviteePage.goto(`/invite/${token}`)
  await expect(
    inviteePage.getByRole('heading', { name: "This invitation link doesn't work" }),
  ).toBeVisible()
})

test('the invitation page in Arabic, and a cancelled invitation', async ({ browser }) => {
  const email = uniqueEmail('arabic')
  const roles = await callApi<{ id: string; templateKey: string | null }[]>(
    ownerPage,
    'role.list',
    {},
    { businessId, query: true },
  )
  const accountant = roles.data?.find((role) => role.templateKey === 'accountant')
  const created = await callApi(
    ownerPage,
    'invitation.create',
    { id: randomUUID(), email, roleId: accountant?.id, locale: 'ar' },
    { businessId },
  )
  expect(created.appCode).toBeUndefined()
  const { token, subject } = await nextInvitation(email)
  expect(subject).toMatch(/دعوة من .*Rashed Owner.* للانضمام إلى .*Al Noor Workshop.* على BizCost/)

  const visitor = await browser.newContext({ baseURL })
  await useLanguage(visitor, 'ar')
  const page = await visitor.newPage()
  await page.goto(`/invite/${token}`)
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
  await expect(page.getByRole('heading', { name: /انضم إلى .*Al Noor Workshop/ })).toBeVisible()
  await expect(page.getByText('المحاسب', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'إنشاء حساب' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'لدي حساب: تسجيل الدخول' })).toBeVisible()

  await ownerPage.goto(settings('/members'))
  await ownerPage
    .locator(`[data-invitation="${email}"]`)
    .getByRole('button', { name: 'Cancel invitation' })
    .click()
  await ownerPage
    .getByRole('alertdialog', { name: 'Cancel this invitation?' })
    .getByRole('button', { name: 'Cancel invitation' })
    .click()
  await expect(ownerPage.getByText(withValue('Invitation to ', email, ' cancelled.'))).toBeVisible()
  await expect(ownerPage.locator(`[data-invitation="${email}"]`)).toHaveCount(0)

  await page.reload()
  await expect(page.getByRole('heading', { name: 'رابط الدعوة هذا لا يعمل' })).toBeVisible()
  await visitor.close()
})

test('an employee sees no business settings until the owner changes their role', async () => {
  await inviteePage.goto(settings())
  await expect(inviteePage.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
  await expect(inviteePage.getByText('The owner and the admins manage')).toBeVisible()
  await expect(inviteePage.getByRole('list', { name: 'Business settings' })).toHaveCount(0)
  await inviteePage.goto(settings('/business'))
  await expect(
    inviteePage.getByRole('heading', { name: "This section isn't open to you" }),
  ).toBeVisible()
  expect(
    (await callApi(inviteePage, 'business.profile', {}, { businessId, query: true })).appCode,
  ).toBe('forbidden')

  await ownerPage.goto(settings('/members'))
  await memberAction(ownerPage, inviteeEmail, 'Change role')
  const dialog = ownerPage.getByRole('dialog', { name: 'Change role' })
  await expect(dialog.getByRole('radio', { name: /^Employee/ })).toBeChecked()
  await dialog
    .locator('label')
    .filter({ hasText: /^Manager/ })
    .click()
  await dialog.getByRole('button', { name: 'Save role' }).click()
  await expect(ownerPage.getByText(/role was changed\./)).toBeVisible()
  await expect(memberRow(ownerPage, inviteeEmail)).toContainText('Manager')

  // The member's next request has the Manager's access: the profile, read-only.
  await inviteePage.goto(settings())
  await expect(
    inviteePage.getByRole('list', { name: 'Business settings' }).getByRole('link'),
  ).toHaveText([/^Business profile/, /^Branches/, /^Team/, /^Language/])
  await inviteePage.goto(settings('/business'))
  await expect(
    inviteePage.getByRole('heading', { level: 1, name: 'Business profile' }),
  ).toBeVisible()
  await expect(inviteePage.getByText('You can see these details.')).toBeVisible()
  await expect(
    inviteePage.getByRole('textbox', { name: 'Business name', exact: true }),
  ).toHaveAttribute('readonly', '')
  await expect(inviteePage.getByRole('button', { name: 'Save changes' })).toHaveCount(0)
  await expect(inviteePage.getByRole('button', { name: 'Upload logo' })).toHaveCount(0)
})

test('the team cannot be switched off while it has members', async () => {
  await ownerPage.goto(settings('/modules'))
  await expect(ownerPage.getByRole('switch', { name: 'Team', exact: true })).toBeDisabled()
  await expect(ownerPage.getByText('first remove the other members')).toBeVisible()
  const refused = await callApi(
    ownerPage,
    'business.customize',
    { item: { kind: 'capability', key: 'has_team' }, enabled: false },
    { businessId },
  )
  expect(refused.appCode).toBe('team_in_use')
})

test('ownership moves after "confirm it\'s you"; the old owner becomes an Admin', async () => {
  // The owner signed in too long ago for this.
  await ageSignIn(ownerContext, 15)
  await ownerPage.goto(settings('/members'))
  await memberAction(ownerPage, inviteeEmail, 'Make owner')
  const dialog = ownerPage.getByRole('alertdialog', { name: /Make .* the owner\?/ })
  await dialog.getByRole('button', { name: 'Make owner' }).click()
  await expect(
    dialog.getByText('To keep the business safe, enter the code we sent to'),
  ).toBeVisible()
  await enterCode(ownerPage, await nextCode(owner.email))
  await dialog.getByRole('button', { name: 'Make owner' }).click()
  await expect(ownerPage.getByText(/is now the owner\./)).toBeVisible()
  await expect(memberRow(ownerPage, inviteeEmail)).toContainText('Owner')
  await expect(memberRow(ownerPage, owner.email)).toContainText('Admin')
  // An Admin cannot transfer ownership (only the owner can).
  await expect(
    memberRow(ownerPage, inviteeEmail).getByRole('button', { name: /Options for/ }),
  ).toHaveCount(0)
})

test('a removed member loses access on their next request', async () => {
  await inviteePage.goto(settings('/members'))
  await memberAction(inviteePage, owner.email, 'Remove from business')
  await inviteePage
    .getByRole('alertdialog', { name: /Remove .*Rashed Owner/ })
    .getByRole('button', { name: 'Remove from business' })
    .click()
  await expect(inviteePage.getByText(/Rashed Owner.* was removed\./)).toBeVisible()
  await expect(memberRow(inviteePage, owner.email)).toHaveCount(0)

  expect(
    (await callApi(ownerPage, 'business.context', {}, { businessId, query: true })).appCode,
  ).toBe('forbidden')
  await ownerPage.goto(`/b/${businessId}`)
  await expect(
    ownerPage.getByRole('heading', { level: 1, name: "This business isn't open to you" }),
  ).toBeVisible()
  // Once, under the app header (no second header of the not-found page).
  await expect(ownerPage.getByRole('banner')).toHaveCount(1)
})

test('joining on a phone a business with a long Arabic name, then leaving it', async ({
  browser,
}) => {
  const LONG_NAME = 'مؤسسة النور لأعمال النجارة والديكور والأثاث المنزلي ذ.م.م'
  const otherBusiness = await createBusiness(ownerPage, LONG_NAME, WORKSHOP_ANSWERS)
  const member = await createUser('leaver')
  cleanup.push(member.id)
  const roles = await callApi<{ id: string; templateKey: string | null }[]>(
    ownerPage,
    'role.list',
    {},
    { businessId: otherBusiness, query: true },
  )
  const employee = roles.data?.find((role) => role.templateKey === 'employee')
  const created = await callApi(
    ownerPage,
    'invitation.create',
    { id: randomUUID(), email: member.email, roleId: employee?.id, locale: 'ar' },
    { businessId: otherBusiness },
  )
  expect(created.appCode).toBeUndefined()
  const { token } = await nextInvitation(member.email)

  const phone = await browser.newContext({ baseURL, viewport: { width: 375, height: 812 } })
  await useLanguage(phone, 'en')
  const page = await phone.newPage()
  await signIn(page, member)
  await setLanguage(page, 'ar')
  await page.goto(`/invite/${token}`)
  const accept = page.getByRole('button', { name: 'قبول الدعوة' })
  await expect(accept).toBeVisible()
  // Nothing runs off the screen: no sideways scrolling, and the button's text fits inside it.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375)
  expect(await accept.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  await accept.click()
  await expect(page).toHaveURL(`/b/${otherBusiness}`)

  // An employee opens no business settings, but may leave.
  await page.goto(`/b/${otherBusiness}/settings`)
  await page.getByRole('button', { name: /^مغادرة هذا العمل التجاري/ }).click()
  const dialog = page.getByRole('alertdialog', { name: /^مغادرة .*مؤسسة النور/ })
  await dialog.getByRole('button', { name: 'مغادرة هذا العمل التجاري' }).click()
  await expect(page).not.toHaveURL(new RegExp(otherBusiness))
  expect(
    (await callApi(page, 'business.context', {}, { businessId: otherBusiness, query: true }))
      .appCode,
  ).toBe('forbidden')
  await phone.close()
})

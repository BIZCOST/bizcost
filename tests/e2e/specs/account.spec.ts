import { expect, test, type Browser } from '@playwright/test'
import {
  ageSignIn,
  createUser,
  deleteUser,
  enterCode,
  getUser,
  nextCode,
  passwordWorks,
  readSession,
  refreshWorks,
  sessionCount,
  signIn,
  uniqueEmail,
  useLanguage,
  withValue,
  type TestUser,
} from '../helpers'

// The account page: name, password ("confirm it's you" code), email (two codes), sessions, delete.

let user: TestUser
test.beforeEach(async ({ page, context }) => {
  user = await createUser('account')
  await useLanguage(context, 'en')
  await signIn(page, user)
  await page.goto('/account')
})
test.afterEach(async () => {
  await deleteUser(user.id)
})

/** The same user signed in on another device (a second browser). */
async function otherDevice(browser: Browser) {
  const context = await browser.newContext()
  await useLanguage(context, 'en')
  const page = await context.newPage()
  await signIn(page, user)
  return context
}

test('change the display name', async ({ page }) => {
  const name = page.getByLabel('Name', { exact: true })
  await expect(name).toHaveValue(user.email.split('@')[0]!)
  await name.fill('Rashed Al Test')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Your name is saved.')).toBeVisible()

  await page.reload()
  await expect(name).toHaveValue('Rashed Al Test')
  await expect(page.getByRole('button', { name: 'Account menu' })).toContainText('Rashed Al Test')
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    withValue('Hello, ', 'Rashed Al Test'),
  )
})

test('change the password with an emailed code', async ({ page }) => {
  await page.getByRole('button', { name: 'Change password' }).click()
  await expect(page.getByText(withValue('We sent a code to ', user.email))).toBeVisible()
  await enterCode(page, await nextCode(user.email))
  const password = 'Another-good-password-9'
  await page.getByLabel('New password', { exact: true }).fill(password)
  await page.getByLabel('Confirm new password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Change password' }).click()
  await expect(page.getByText('Your password is changed.')).toBeVisible()
  expect(await passwordWorks(user.email, password)).toBe(true)
})

test('change the email with a code to each address', async ({ page }) => {
  const newEmail = uniqueEmail('moved')
  await page.getByRole('button', { name: 'Change email' }).click()
  await page.getByLabel('New email', { exact: true }).fill(newEmail)
  await page.getByRole('button', { name: 'Send codes' }).click()

  await expect(page.getByText('We sent a code to your current email')).toBeVisible()
  await enterCode(page, await nextCode(user.email), 0)
  await enterCode(page, await nextCode(newEmail), 1)
  await page.getByRole('button', { name: 'Change email' }).click()

  await expect(page.getByText(withValue('Your email is now ', newEmail))).toBeVisible()
  await expect(page.getByTestId('current-email')).toHaveText(newEmail)
  expect((await getUser(user.id))?.email).toBe(newEmail)
})

test('delete the account right after signing in', async ({ page }) => {
  await page.getByRole('button', { name: 'Delete my account' }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toContainText('Delete your account?')
  await dialog.getByRole('button', { name: 'Delete account' }).click()

  await expect(page).toHaveURL('/login?notice=account-deleted')
  await expect(page.getByText('Your account is deleted.')).toBeVisible()
  expect(await getUser(user.id)).toBeNull()
  expect(await passwordWorks(user.email, user.password)).toBe(false)
})

test('deleting an account signed in long ago asks for an emailed code first', async ({
  page,
  context,
}) => {
  await ageSignIn(context, 30)
  await page.reload()
  await page.getByRole('button', { name: 'Delete my account' }).click()
  const dialog = page.getByRole('alertdialog')
  await dialog.getByRole('button', { name: 'Delete account' }).click()

  await expect(dialog.getByText(withValue('enter the code we sent to ', user.email))).toBeVisible()
  expect(await getUser(user.id)).not.toBeNull()
  // A wrong code is refused by Supabase Auth, and nothing is deleted.
  await enterCode(page, '000000')
  await dialog.getByRole('button', { name: 'Delete account' }).click()
  await expect(
    dialog.getByText('This code is wrong or has expired.', { exact: false }),
  ).toBeVisible()
  expect(await getUser(user.id)).not.toBeNull()

  await enterCode(page, await nextCode(user.email))
  await dialog.getByRole('button', { name: 'Delete account' }).click()
  await expect(page).toHaveURL('/login?notice=account-deleted')
  expect(await getUser(user.id)).toBeNull()
})

test('"Sign out" in the header signs out this device only', async ({ page, browser }) => {
  const other = await otherDevice(browser)
  try {
    const otherSession = await readSession(other)
    await page.getByRole('button', { name: 'Account menu' }).click()
    await page.getByRole('menuitem', { name: 'Sign out' }).click()
    await expect(page).toHaveURL('/login?notice=signed-out')
    await expect(page.getByText("You're signed out.")).toBeVisible()
    expect(await sessionCount(user.id)).toBe(1)
    expect(await refreshWorks(otherSession.refresh_token)).toBe(true)
  } finally {
    await other.close()
  }
})

test('sign out everywhere ends the sessions on other devices too', async ({ page, browser }) => {
  const other = await otherDevice(browser)
  try {
    const otherSession = await readSession(other)
    expect(await sessionCount(user.id)).toBe(2)
    await page.getByRole('button', { name: 'Sign out everywhere' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Sign out everywhere' }).click()
    await expect(page).toHaveURL('/login?notice=signed-out-everywhere')
    await page.goto('/account')
    await expect(page).toHaveURL('/login')
    // The other device's session is revoked: it cannot get a new access token.
    expect(await sessionCount(user.id)).toBe(0)
    expect(await refreshWorks(otherSession.refresh_token)).toBe(false)
  } finally {
    await other.close()
  }
})

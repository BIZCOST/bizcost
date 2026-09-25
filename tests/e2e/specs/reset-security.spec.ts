import { expect, test } from '@playwright/test'
import {
  deleteUser,
  enterCode,
  findUserId,
  nextCode,
  passwordWorks,
  uniqueEmail,
  useLanguage,
} from '../helpers'
import { stack } from '../stack'

// ATTACK (security review of the D-071 reset: code first, then "change password or go straight
// in"), kept as regression tests.

const users: (string | null)[] = []
test.afterAll(async () => {
  for (const id of users) await deleteUser(id)
})

test.beforeEach(async ({ context }) => {
  await useLanguage(context, 'en')
})

test('a reset that confirms a pre-registered address does not keep the stranger’s password', async ({
  page,
}) => {
  // Pre-account takeover. A stranger signs up with the victim's address and a password of their
  // own (the public sign-up endpoint, publishable key); the account stays unconfirmed, so that
  // password does not work yet. Later the victim uses "Forgot password": the recovery code confirms
  // the address, and "Continue without changing" keeps the stranger's password, which now signs in
  // to the victim's account. The Step 3 reset always replaced the password (and ended the other
  // sessions), so this path used to lock the stranger out.
  const email = uniqueEmail('preacct')
  const strangerPassword = 'Chosen-by-a-stranger-1'
  const { apiUrl, publishableKey } = stack()
  const signUp = await fetch(`${apiUrl}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: publishableKey, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: strangerPassword, data: { locale: 'en' } }),
  })
  expect(signUp.ok).toBe(true)
  users.push(await findUserId(email))
  expect(await passwordWorks(email, strangerPassword)).toBe(false) // not confirmed yet

  // The victim: "Forgot password" → the code → the easiest way in.
  await page.goto('/forgot')
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByRole('button', { name: 'Send code' }).click()
  await expect(page).toHaveURL('/reset')
  await enterCode(page, await nextCode(email, /password reset/i))

  const keep = page.getByRole('button', { name: 'Continue without changing' })
  const newPassword = page.getByLabel('New password', { exact: true })
  await expect(keep.or(newPassword)).toBeVisible()
  if (await keep.isVisible()) {
    await keep.click()
  } else {
    // A fix may skip the choice here and ask for a new password.
    const password = 'The-real-owner-password-2'
    await newPassword.fill(password)
    await page.getByLabel('Confirm new password', { exact: true }).fill(password)
    await page.getByRole('button', { name: 'Save new password' }).click()
  }
  await expect(page).toHaveURL('/')

  expect(
    await passwordWorks(email, strangerPassword),
    'the password set by whoever signed up first still signs in to the victim’s account',
  ).toBe(false)
})

test('a new password stays required after a reload, and with the next code', async ({ page }) => {
  // The same pre-registered address. The first code confirms it, so a new password is required;
  // the user reloads before saving one. The next code looks like any confirmed account's, but this
  // tab still requires the new password.
  test.setTimeout(150_000)
  const email = uniqueEmail('prereload')
  const strangerPassword = 'Chosen-by-a-stranger-2'
  const { apiUrl, publishableKey } = stack()
  const signUp = await fetch(`${apiUrl}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: publishableKey, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: strangerPassword, data: { locale: 'en' } }),
  })
  expect(signUp.ok).toBe(true)
  users.push(await findUserId(email))

  await page.goto('/forgot')
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByRole('button', { name: 'Send code' }).click()
  await expect(page).toHaveURL('/reset')
  await enterCode(page, await nextCode(email, /password reset/i))
  const title = page.getByRole('heading', { level: 1 })
  await expect(title).toHaveText('Set a new password')
  await expect(title).toBeFocused()
  await expect(page.getByRole('button', { name: 'Back', exact: true })).toHaveCount(0)

  await page.reload()
  await expect(title).toHaveText('Your password was not changed')
  // Back to the code; once the first code's countdown is over, ask for another.
  await page.getByRole('button', { name: 'Send a new code' }).click()
  await expect(page.getByLabel('Verification code')).toBeVisible()
  await page.getByRole('button', { name: 'Send a new code' }).click({ timeout: 75_000 })
  await expect(page.getByText('We sent a new code.')).toBeVisible()
  await enterCode(page, await nextCode(email, /password reset/i))

  await expect(title).toHaveText('Set a new password')
  await expect(page.getByRole('button', { name: 'Continue without changing' })).toHaveCount(0)
  const password = 'The-real-owner-password-3'
  await page.getByLabel('New password', { exact: true }).fill(password)
  await page.getByLabel('Confirm new password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Save new password' }).click()
  await expect(page).toHaveURL('/')
  expect(await passwordWorks(email, strangerPassword)).toBe(false)
  expect(await passwordWorks(email, password)).toBe(true)
})

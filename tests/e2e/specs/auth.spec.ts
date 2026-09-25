import { expect, test } from '@playwright/test'
import {
  createUser,
  deleteUser,
  enterCode,
  findUserId,
  nextCode,
  passwordWorks,
  signIn,
  uniqueEmail,
  useLanguage,
  withValue,
  type TestUser,
} from '../helpers'

// Sign-up, sign-in (password and email code) and password reset, in English.

const users: (string | null)[] = []
test.afterAll(async () => {
  for (const id of users) await deleteUser(id)
})

test.beforeEach(async ({ context }) => {
  await useLanguage(context, 'en')
})

test('sign up with an email code and land on home', async ({ page }) => {
  const email = uniqueEmail('signup')
  await page.goto('/signup')
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill('A-long-password-42')
  await page.getByRole('button', { name: 'Create account' }).click()

  await expect(page).toHaveURL('/verify')
  await expect(page.getByText(withValue('We sent a code to ', email))).toBeVisible()
  users.push(await findUserId(email))
  await enterCode(page, await nextCode(email))

  await expect(page).toHaveURL('/')
  // No name yet (the profile is named after the email): a plain welcome, not "Hello, <email>".
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Welcome to BizCost')
  await expect(page.getByText('Add your name in your account')).toBeVisible()
  await expect(page.getByText('No business yet')).toBeVisible()
})

test('signing up again with a registered email looks the same', async ({ page }) => {
  const user = await createUser('existing')
  users.push(user.id)
  await page.goto('/signup')
  await page.getByLabel('Email', { exact: true }).fill(user.email)
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill('A-long-password-42')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page).toHaveURL('/verify')
  await expect(page.getByText(withValue('We sent a code to ', user.email))).toBeVisible()
  // The code screen offers sign-in and password reset instead of revealing the account.
  await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Reset your password' })).toBeVisible()
})

test.describe('with an account', () => {
  let user: TestUser
  test.beforeEach(async () => {
    user = await createUser('signin')
    users.push(user.id)
  })

  test('sign in with the password', async ({ page }) => {
    await signIn(page, user)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Welcome to BizCost')
  })

  test('a wrong password shows one message', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('Email', { exact: true }).fill(user.email)
    await page.getByRole('textbox', { name: 'Password', exact: true }).fill('not-the-password')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page.getByRole('main').getByRole('alert')).toHaveText(
      'The email or password is wrong.',
    )
    await expect(page).toHaveURL('/login')
  })

  test('sign in with an email code', async ({ page }) => {
    await page.goto('/login')
    await page.getByText('Email code').click()
    await page.getByLabel('Email', { exact: true }).fill(user.email)
    await page.getByRole('button', { name: 'Send me a code' }).click()

    await expect(page).toHaveURL('/verify')
    await expect(page.getByText(withValue('We sent a code to ', user.email))).toBeVisible()
    await enterCode(page, await nextCode(user.email))
    await expect(page).toHaveURL('/')
  })

  test('reset the password with a code', async ({ page }) => {
    await page.goto('/login')
    await page.getByRole('link', { name: 'Forgot password?' }).click()
    await expect(page).toHaveURL('/forgot')
    await page.getByLabel('Email', { exact: true }).fill(user.email)
    await page.getByRole('button', { name: 'Send code' }).click()

    await expect(page).toHaveURL('/reset')
    await enterCode(page, await nextCode(user.email))
    const password = 'A-brand-new-password-7'
    await page.getByLabel('New password', { exact: true }).fill(password)
    await page.getByLabel('Confirm new password', { exact: true }).fill(password)
    await page.getByRole('button', { name: 'Save new password' }).click()

    await expect(page).toHaveURL('/')
    await expect(page.getByText('Your password is changed.')).toBeVisible()
    expect(await passwordWorks(user.email, password)).toBe(true)
  })
})

test('an email code for a new address creates the account and signs in (D-062)', async ({
  page,
}) => {
  const email = uniqueEmail('newcode')
  await page.goto('/login')
  await page.getByText('Email code').click()
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByRole('button', { name: 'Send me a code' }).click()
  // The same screen as for a registered address.
  await expect(page).toHaveURL('/verify')
  await expect(page.getByText(withValue('We sent a code to ', email))).toBeVisible()
  users.push(await findUserId(email))
  await enterCode(page, await nextCode(email))
  await expect(page).toHaveURL('/')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Welcome to BizCost')
})

test('signed-out visitors are sent to sign in', async ({ page }) => {
  await page.goto('/account')
  await expect(page).toHaveURL('/login')
})

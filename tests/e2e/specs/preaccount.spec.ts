import { expect, test, type Page } from '@playwright/test'
import {
  deleteUser,
  enterCode,
  findUserId,
  nextCode,
  passwordWorks,
  timePasses,
  uniqueEmail,
  useLanguage,
  withValue,
} from '../helpers'
import { stack } from '../stack'

// ATTACK (pre-registered account takeover, the D-071 gap; fixed by D-102), kept as regression
// tests. A stranger signs up with the owner's address and a password of their own (the public
// sign-up endpoint, publishable key); the account stays unconfirmed. When the owner later confirms
// the address — signing up themselves, "Send me a code", or a reset left before the new password —
// that password must not sign in. The owner's own passwords must keep working: the sign-up's (also
// after a reload of the code page) and the one typed on sign-in for an email not confirmed yet.

const STRANGER = 'Chosen-by-a-stranger-9'
const OWNER = 'The-real-owner-password-8'
const SIGN_UP_CODE = /sign-up code/i

const users: (string | null)[] = []
test.afterAll(async () => {
  for (const id of users) await deleteUser(id)
})

test.beforeEach(async ({ context }) => {
  await useLanguage(context, 'en')
})

/** A sign-up straight to the Auth server; its code lands in the owner's inbox (set aside). */
async function signUpElsewhere(email: string, password: string): Promise<void> {
  const { apiUrl, publishableKey } = stack()
  const response = await fetch(`${apiUrl}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: publishableKey, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, data: { locale: 'en' } }),
  })
  expect(response.ok).toBe(true)
  users.push(await findUserId(email))
  await nextCode(email, SIGN_UP_CODE)
  // The owner comes later (Supabase emails an address once a minute).
  await timePasses(email)
}

async function signUpOnPage(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/signup')
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(password)
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page).toHaveURL('/verify')
}

test('signing up after a stranger: the owner’s password signs in, the stranger’s does not', async ({
  page,
}) => {
  const email = uniqueEmail('preacct-signup')
  await signUpElsewhere(email, STRANGER)

  // Supabase keeps the first password when the address signs up again; the code drops it, and the
  // page sets the owner's.
  await signUpOnPage(page, email, OWNER)
  await enterCode(page, await nextCode(email, SIGN_UP_CODE))
  await expect(page).toHaveURL('/')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Welcome to BizCost')

  expect(await passwordWorks(email, STRANGER), 'the stranger’s password signs in').toBe(false)
  expect(await passwordWorks(email, OWNER), 'the owner’s password does not sign in').toBe(true)
})

test('"Send me a code" to a pre-registered address: the stranger’s password stops, no password is asked', async ({
  page,
}) => {
  const email = uniqueEmail('preacct-code')
  await signUpElsewhere(email, STRANGER)

  await page.goto('/login')
  await page.getByText('Email code').click()
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByRole('button', { name: 'Send me a code' }).click()
  await expect(page).toHaveURL('/verify')
  await enterCode(page, await nextCode(email, SIGN_UP_CODE))
  await expect(page).toHaveURL('/')

  expect(await passwordWorks(email, STRANGER), 'the stranger’s password signs in').toBe(false)
})

test('a reset left at the new password: the stranger’s password no longer signs in', async ({
  page,
}) => {
  // The recovery code confirms the address (a new password is required, D-071), and the owner
  // leaves: another page, another tab or device. The database rule has already dropped the
  // stranger's password.
  const email = uniqueEmail('preacct-reset')
  await signUpElsewhere(email, STRANGER)

  await page.goto('/forgot')
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByRole('button', { name: 'Send code' }).click()
  await expect(page).toHaveURL('/reset')
  await enterCode(page, await nextCode(email, /password reset/i))
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Set a new password')
  await page.goto('/')
  await expect(page).toHaveURL('/')

  expect(await passwordWorks(email, STRANGER), 'the stranger’s password signs in').toBe(false)
})

test('the sign-up’s own password survives the code; after a reload the page asks for it (Arabic)', async ({
  page,
  context,
}) => {
  await useLanguage(context, 'ar')
  const email = uniqueEmail('preacct-reload')
  await page.goto('/signup')
  await page.getByLabel('البريد الإلكتروني', { exact: true }).fill(email)
  await page.getByRole('textbox', { name: 'كلمة المرور', exact: true }).fill(OWNER)
  await page.getByRole('button', { name: 'إنشاء الحساب' }).click()
  await expect(page).toHaveURL('/verify')
  users.push(await findUserId(email))

  // The page forgets the password on a reload (it is never stored).
  await page.reload()
  await enterCode(page, await nextCode(email))

  const title = page.getByRole('heading', { level: 1 })
  await expect(title).toHaveText('اختر كلمة المرور')
  await expect(title).toBeFocused()
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
  await expect(
    page.getByText('تم تأكيد بريدك الإلكتروني. أدخل كلمة المرور التي ستستخدمها لتسجيل الدخول.'),
  ).toBeVisible()
  // The code dropped the password the sign-up gave: without this step it would not sign in.
  expect(await passwordWorks(email, OWNER)).toBe(false)

  const field = page.getByRole('textbox', { name: 'كلمة المرور', exact: true })
  await field.fill('short')
  await page.getByRole('button', { name: 'حفظ ومتابعة' }).click()
  await expect(page).toHaveURL('/verify') // the rule is checked on the page first
  await field.fill(OWNER)
  await page.getByRole('button', { name: 'حفظ ومتابعة' }).click()
  await expect(page).toHaveURL('/')
  expect(await passwordWorks(email, OWNER)).toBe(true)

  // Signed in: the code page is left behind.
  await page.goto('/verify')
  await expect(page).toHaveURL('/')
})

test('a password sign-in of an email not confirmed yet keeps that password after the code', async ({
  page,
}) => {
  // The owner signed up earlier and never entered the code.
  const email = uniqueEmail('preacct-confirm')
  await signUpElsewhere(email, OWNER)

  await page.goto('/login')
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(OWNER)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).toHaveURL('/verify')
  await expect(
    page.getByText('Please confirm your email first. We sent you a new code.'),
  ).toBeVisible()
  await expect(page.getByText(withValue('We sent a code to ', email))).toBeVisible()
  await enterCode(page, await nextCode(email, SIGN_UP_CODE))
  await expect(page).toHaveURL('/')

  expect(await passwordWorks(email, OWNER)).toBe(true)
})

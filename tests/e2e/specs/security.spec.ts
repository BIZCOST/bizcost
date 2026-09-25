import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import {
  createUser,
  deleteUser,
  findUserId,
  passwordWorks,
  signIn,
  uniqueEmail,
  useLanguage,
  withValue,
} from '../helpers'
import { repoRoot } from '../stack'

// ATTACK (Step 3 security review). These tests failed before the fixes (D-062 – D-066) and now guard
// against regressions.

const users: (string | null)[] = []
test.afterAll(async () => {
  for (const id of users) await deleteUser(id)
})

test.beforeEach(async ({ context }) => {
  await useLanguage(context, 'en')
})

interface AuthResponse {
  status: number
  body: string
}

/** The Supabase Auth response the browser receives for one request made by the page. */
async function authResponse(page: Page, path: string, act: () => Promise<void>, method = 'POST') {
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes(`/auth/v1/${path}`) && r.request().method() === method,
    ),
    act(),
  ])
  return { status: response.status(), body: await response.text() } satisfies AuthResponse
}

async function requestSignInCode(page: Page, email: string): Promise<AuthResponse> {
  await page.goto('/login')
  await page.getByText('Email code', { exact: true }).click()
  await page.getByLabel('Email', { exact: true }).fill(email)
  return authResponse(page, 'otp', () =>
    page.getByRole('button', { name: 'Send me a code' }).click(),
  )
}

async function submitSignUp(page: Page, email: string): Promise<AuthResponse> {
  await page.goto('/signup')
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill('A-long-password-42')
  return authResponse(page, 'signup', () =>
    page.getByRole('button', { name: 'Create account' }).click(),
  )
}

test.describe('account enumeration through the responses the browser receives', () => {
  // The screens look the same, but supabase-js runs in the page and anyone can read the Auth
  // responses (devtools, or the same public endpoint with the publishable key).

  test('"Send me a code" gets the same response for a registered and an unknown email', async ({
    page,
  }) => {
    const registered = await createUser('enum-otp')
    users.push(registered.id)
    const known = await requestSignInCode(page, registered.email)
    const missing = uniqueEmail('enum-otp-missing')
    const unknown = await requestSignInCode(page, missing)
    // Was: 422 {"error_code":"otp_disabled"} for an unknown address (now it gets an account, D-062).
    users.push(await findUserId(missing))
    expect(unknown.status).toBe(known.status)
    expect(unknown.body).toBe(known.body)
  })

  test('"Create account" gets the same response for a registered and a new email', async ({
    page,
  }) => {
    const registered = await createUser('enum-signup')
    users.push(registered.id)
    const fresh = uniqueEmail('enum-signup-new')
    const known = await submitSignUp(page, registered.email)
    const created = await submitSignUp(page, fresh)
    users.push(await findUserId(fresh))
    // Was: 422 {"error_code":"user_already_exists"} vs 200 (SMS auto-confirm, D-062).
    expect(known.status).toBe(created.status)
  })
})

test('changing the password with a wrong emailed code is refused', async ({ page }) => {
  // Was: secure_password_change checks the reauthenticate() nonce only for sessions older than 24
  // hours, so on a fresh session any 6 digits changed the password. The code is now checked by
  // Supabase Auth (verifyOtp) before the password is sent at all (D-063).
  const user = await createUser('reauth')
  users.push(user.id)
  await signIn(page, user)
  await page.goto('/account')
  await page.getByRole('button', { name: 'Change password' }).click()
  await expect(page.getByText(withValue('We sent a code to ', user.email))).toBeVisible()
  await page.locator('input[autocomplete="one-time-code"]').fill('000000')
  const password = 'Stolen-session-password-1'
  await page.getByLabel('New password', { exact: true }).fill(password)
  await page.getByLabel('Confirm new password', { exact: true }).fill(password)
  let passwordSent = false
  page.on('request', (request) => {
    if (request.url().includes('/auth/v1/user') && request.method() === 'PUT') passwordSent = true
  })
  const check = await authResponse(page, 'verify', () =>
    page.getByRole('button', { name: 'Change password' }).click(),
  )
  expect(check.status).toBeGreaterThanOrEqual(400)
  await expect(page.getByText('This code is wrong or has expired.', { exact: false })).toBeVisible()
  expect(passwordSent).toBe(false)
  expect(await passwordWorks(user.email, password)).toBe(false)
})

test('the Supabase session cookies are Secure', async ({ page, context }) => {
  // @supabase/ssr never sets `secure` by itself (DEFAULT_COOKIE_OPTIONS: path, sameSite lax,
  // httpOnly false, maxAge) and no cookieOptions are passed (browser.ts, proxy.ts, the API), so in
  // production the access and refresh tokens also travel over plain http. localhost is a secure
  // context, so a Secure cookie works here too.
  const user = await createUser('cookie-flags')
  users.push(user.id)
  await signIn(page, user)
  const session = (await context.cookies()).filter((c) => c.name.startsWith('sb-'))
  expect(session.length).toBeGreaterThan(0)
  for (const cookie of session) {
    expect(cookie.secure, `${cookie.name} is Secure`).toBe(true)
    expect(cookie.sameSite).toBe('Lax')
  }
})

test('pages cannot be framed by another site (clickjacking)', async ({ request }) => {
  for (const path of ['/login', '/signup', '/account']) {
    const response = await request.get(path, { maxRedirects: 0 })
    const frameOptions = response.headers()['x-frame-options'] ?? ''
    const csp = response.headers()['content-security-policy'] ?? ''
    expect(
      /^(deny|sameorigin)$/i.test(frameOptions) || /frame-ancestors/i.test(csp),
      `${path} sends X-Frame-Options or CSP frame-ancestors`,
    ).toBe(true)
  }
})

test('the project-wide auth email budget in config.toml is a production value', () => {
  // docs/ARCHITECTURE.md: config.toml is applied to hosted projects with `supabase config push`.
  // [auth.rate_limit] email_sent is per hour for the whole project (every sign-up, code, reset and
  // email change). At 2 the third email of an hour fails with over_email_send_rate_limit, which
  // app-core treats as success ("we sent a code") for sign-up, code sign-in and reset.
  const config = readFileSync(join(repoRoot, 'supabase', 'config.toml'), 'utf8')
  const section = /\[auth\.rate_limit\]([\s\S]*?)\n\[/.exec(config)?.[1] ?? ''
  const emailSent = Number(/^\s*email_sent\s*=\s*(\d+)/m.exec(section)?.[1])
  expect(emailSent).toBeGreaterThanOrEqual(30)
})

import { expect, test, type Page } from '@playwright/test'
import {
  createUser,
  deleteUser,
  drawn,
  emailsTo,
  enterCode,
  findUserId,
  nextCode,
  passwordWorks,
  sessionCount,
  signIn,
  signUpDirectly,
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

/** The note on the sign-up code screen, shown for every address (D-073). */
const REGISTERED_NOTE =
  'If this email is already registered, no code will be sent — sign in instead.'

/** "Forgot password?" from sign-in: the reset screen asks for the code only (D-071). */
async function startReset(page: Page, email: string): Promise<void> {
  await page.goto('/login')
  await page.getByRole('link', { name: 'Forgot password?' }).click()
  await expect(page).toHaveURL('/forgot')
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByRole('button', { name: 'Send code' }).click()

  await expect(page).toHaveURL('/reset')
  await expect(
    page.getByText(withValue('If you have an account, we sent a code to ', email)),
  ).toBeVisible()
  await expect(page.getByLabel('Verification code')).toBeVisible()
  await expect(page.getByLabel('New password')).toHaveCount(0)
}

/** Asks for a reset code on /forgot (the tab's next page is /reset); returns the Auth status. */
async function forgot(page: Page, email: string): Promise<number> {
  await page.goto('/forgot')
  await page.getByLabel('Email', { exact: true }).fill(email)
  const [recover] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/auth/v1/recover')),
    page.getByRole('button', { name: 'Send code' }).click(),
  ])
  await expect(page).toHaveURL('/reset')
  return recover.status()
}

/** The seconds "Send a new code" still waits, as the code screen shows them. */
async function resendWait(page: Page): Promise<number> {
  const wait = page.getByText(/^You can ask for a new code in \d+ seconds\.$/).first()
  return Number(/(\d+) seconds/.exec((await wait.textContent()) ?? '')?.[1])
}

/** Whether this tab's code screen plans an automatic resend (its pending entry, D-073). */
async function plansRetry(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const entry = JSON.parse(sessionStorage.getItem('bz_pending_code') ?? '{}') as object
    return 'retryAt' in entry
  })
}

test('sign up with an email code and land on home', async ({ page }) => {
  const email = uniqueEmail('signup')
  await page.goto('/signup')
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill('A-long-password-42')
  await page.getByRole('button', { name: 'Create account' }).click()

  await expect(page).toHaveURL('/verify')
  await expect(page.getByText(withValue('We sent a code to ', email))).toBeVisible()
  // The note for a registered address is there for a new one too, so it reveals nothing.
  await expect(page.getByText(REGISTERED_NOTE)).toBeVisible()
  users.push(await findUserId(email))
  await enterCode(page, await nextCode(email))

  await expect(page).toHaveURL('/')
  // No name yet (the profile is named after the email): a plain welcome, not "Hello, <email>".
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Welcome to BizCost')
  await expect(page.getByText('Add your name in your account')).toBeVisible()
  await expect(page.getByText('No business yet')).toBeVisible()
})

test('sign-up password rule (D-072): the checklist, and both the page and Auth refuse a weak one', async ({
  page,
}) => {
  const email = uniqueEmail('rule')
  let signUpRequests = 0
  page.on('request', (request) => {
    if (request.url().includes('/auth/v1/signup')) signUpRequests += 1
  })
  await page.setViewportSize({ width: 375, height: 812 }) // a phone: the error wraps
  await page.goto('/signup')
  const password = page.getByRole('textbox', { name: 'Password', exact: true })
  await expect(password).toHaveAccessibleDescription('At least 8 characters, a mix of (a-z, 0-9)')
  const rule = (name: string) => page.locator(`li[data-rule="${name}"]`)
  const announcement = page.getByRole('main').getByRole('status')
  await expect(rule('length')).toHaveText('8+ characters not yet')
  await expect(rule('letter')).toHaveText('Letter a-z not yet')
  await expect(rule('digit')).toHaveText('Number 0-9 not yet')

  // Letters only: two of three rules met, and the page does not send it.
  await page.getByLabel('Email', { exact: true }).fill(email)
  await password.fill('abcdefgh')
  await expect(rule('length')).toHaveAttribute('data-met', 'true')
  await expect(rule('letter')).toHaveAttribute('data-met', 'true')
  await expect(rule('digit')).toHaveAttribute('data-met', 'false')
  await expect(announcement).toHaveText('') // screen readers hear only a change of the whole rule
  await page.getByRole('button', { name: 'Create account' }).click()
  // "(a-z, 0-9)" stays whole on one line: a no-break space and a word joiner after each hyphen.
  const error = page
    .getByRole('alert')
    .filter({ hasText: 'Add at least one letter and one number' })
  await expect(error).toHaveText(
    'Add at least one letter and one number (a-\u2060z,\u00a00-\u20609).',
  )
  expect(await error.evaluate(drawn, '(a-\u2060z,\u00a00-\u20609)')).toEqual({
    text: '(a-z,\u00a00-9)',
    lines: 1,
  })
  await expect(password).toBeFocused()
  await expect(page).toHaveURL('/signup')
  expect(signUpRequests).toBe(0)

  // The Auth server enforces the same rule on its own (supabase/config.toml).
  expect(await signUpDirectly(email, 'abcdefgh')).toMatchObject({
    status: 422,
    code: 'weak_password',
    reasons: ['characters'],
  })
  expect(await signUpDirectly(email, 'abcde12')).toMatchObject({
    status: 422,
    code: 'weak_password',
    reasons: ['length'],
  })
  // Arabic-Indic digits and Arabic letters count for neither.
  expect(await signUpDirectly(email, 'abcdefg٣')).toMatchObject({ reasons: ['characters'] })
  expect(await signUpDirectly(email, 'كلمةمرور12')).toMatchObject({ reasons: ['characters'] })
  expect(await findUserId(email)).toBeNull()

  // A letter and a digit: every rule met, announced once, and the account is created.
  await password.fill('abcdef12')
  for (const name of ['length', 'letter', 'digit']) {
    await expect(rule(name)).toHaveAttribute('data-met', 'true')
  }
  await expect(announcement).toHaveText('Your password meets all the rules.')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page).toHaveURL('/verify')
  await expect(page.getByText(withValue('We sent a code to ', email))).toBeVisible()
  users.push(await findUserId(email))
  expect(users.at(-1)).toBeTruthy()
})

test('signing up twice with a new email: no error, and the first code still works (D-073)', async ({
  page,
}) => {
  const email = uniqueEmail('signup-twice')
  const submit = async () => {
    await page.goto('/signup')
    await page.getByLabel('Email', { exact: true }).fill(email)
    await page.getByRole('textbox', { name: 'Password', exact: true }).fill('A-long-password-42')
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/auth/v1/signup')),
      page.getByRole('button', { name: 'Create account' }).click(),
    ])
    await expect(page).toHaveURL('/verify')
    return response.status()
  }
  expect(await submit()).toBe(200)
  users.push(await findUserId(email))
  const first = await nextCode(email)
  // Supabase answers the second one "too soon" (a registered address gets a silent 200): the
  // screen is the same as after the first, with the usual wait and no automatic resend.
  expect(await submit()).toBe(429)
  await expect(page.getByText(withValue('We sent a code to ', email))).toBeVisible()
  await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0)
  expect(await resendWait(page)).toBeLessThanOrEqual(60)
  expect(await plansRetry(page)).toBe(false)
  await enterCode(page, first)
  await expect(page).toHaveURL('/')
})

test('signing up again with a registered email looks the same, and its note says to sign in', async ({
  page,
}) => {
  const user = await createUser('existing')
  users.push(user.id)
  await page.goto('/signup')
  await page.getByLabel('Email', { exact: true }).fill(user.email)
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill('A-long-password-42')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page).toHaveURL('/verify')
  await expect(page.getByText(withValue('We sent a code to ', user.email))).toBeVisible()
  // The code screen explains, to every address, that a registered one gets no code (D-073).
  await expect(page.getByText(REGISTERED_NOTE)).toBeVisible()
  await expect(page.getByText('Already have an account?')).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Reset your password' })).toBeVisible()
  // No email and no automatic resend: Supabase answered 200 and sent nothing.
  await page.waitForTimeout(3_000)
  expect(await emailsTo(user.email)).toHaveLength(0)
  await page.getByRole('link', { name: 'sign in', exact: true }).click()
  await expect(page).toHaveURL('/login')
  await signIn(page, user)
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

  test('reset: the code only, then go straight in with the old password', async ({ page }) => {
    await startReset(page, user.email)
    await enterCode(page, '000000')
    await expect(
      page.getByText('This code is wrong or has expired. Check it or ask for a new one.'),
    ).toBeVisible()
    // The wrong code is cleared and the cells have focus again: the right code is typed directly.
    const cells = page.getByLabel('Verification code')
    await expect(cells).toBeFocused()
    await expect(cells).toHaveValue('')
    await page.keyboard.type(await nextCode(user.email))

    const title = page.getByRole('heading', { level: 1 })
    await expect(title).toHaveText('Your email is confirmed')
    await expect(title).toBeFocused()
    await expect(page.getByText('Do you want to change your password?')).toBeVisible()
    await page.getByRole('button', { name: 'Continue without changing' }).click()
    await expect(page).toHaveURL('/')
    await expect(title).toHaveText('Welcome to BizCost')
    expect(await passwordWorks(user.email, user.password)).toBe(true)
  })

  test('"Send me a code" twice: the first code still works (D-073)', async ({ page }) => {
    const send = async () => {
      await page.goto('/login')
      await page.getByText('Email code').click()
      await page.getByLabel('Email', { exact: true }).fill(user.email)
      const [otp] = await Promise.all([
        page.waitForResponse((r) => r.url().includes('/auth/v1/otp')),
        page.getByRole('button', { name: 'Send me a code' }).click(),
      ])
      await expect(page).toHaveURL('/verify')
      return otp.status()
    }
    expect(await send()).toBe(200)
    const first = await nextCode(user.email)
    expect(await send()).toBe(429)
    // No automatic resend: a second email would make the first code stop working.
    expect(await resendWait(page)).toBeLessThanOrEqual(60)
    expect(await plansRetry(page)).toBe(false)
    await enterCode(page, first)
    await expect(page).toHaveURL('/')
  })

  test('"Forgot password" twice looks the same as for an unknown email, and the first code works (D-073)', async ({
    page,
  }) => {
    // An unknown email: nothing is sent, and Supabase answers 200 both times.
    const unknown = uniqueEmail('reset-unknown')
    expect(await forgot(page, unknown)).toBe(200)
    expect(await forgot(page, unknown)).toBe(200)
    const unknownWait = await resendWait(page)
    expect(await plansRetry(page)).toBe(false)

    // A registered email: the second request is answered "too soon" (its first code still works).
    expect(await forgot(page, user.email)).toBe(200)
    const first = await nextCode(user.email, /password reset/i)
    expect(await forgot(page, user.email)).toBe(429)
    const registeredWait = await resendWait(page)
    // The same screen: the usual wait (read right away, so 59 or 60 s), no automatic resend.
    expect(registeredWait).toBeLessThanOrEqual(60)
    expect(Math.abs(registeredWait - unknownWait)).toBeLessThanOrEqual(1)
    expect(await plansRetry(page)).toBe(false)
    await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0)

    await enterCode(page, first)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your email is confirmed')
    await page.getByRole('button', { name: 'Continue without changing' }).click()
    await expect(page).toHaveURL('/')
    expect(await emailsTo(user.email, /password reset/i)).toHaveLength(1)
  })

  test('reset asked for right after a sign-in code: the code still arrives (D-073)', async ({
    page,
  }) => {
    // Supabase emails an address once per 60 s (sign-in codes and resets alike), so this reset is
    // answered "too soon" and sends nothing; the screen looks as usual and sends it again once.
    test.slow()
    await page.goto('/login')
    await page.getByText('Email code').click()
    await page.getByLabel('Email', { exact: true }).fill(user.email)
    await page.getByRole('button', { name: 'Send me a code' }).click()
    await expect(page).toHaveURL('/verify')

    expect(await forgot(page, user.email)).toBe(429)
    await expect(
      page.getByText(withValue('If you have an account, we sent a code to ', user.email)),
    ).toBeVisible()
    // Nothing on screen tells this apart from a normal send: no notice, no error, the cells ready.
    const cells = page.getByLabel('Verification code')
    await expect(cells).toBeEnabled()
    await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0)
    // "Send a new code" waits for the automatic resend and the cooldown after it.
    expect(await resendWait(page)).toBeGreaterThan(60)
    expect(await plansRetry(page)).toBe(true)
    // What screen readers were told about the wait (said once, when it starts).
    const announced = page.locator('[role="status"]').filter({ hasText: 'new code in' })
    const said = await announced.textContent()

    const code = await nextCode(user.email, /password reset/i, 75_000)
    await expect(cells).toBeEnabled()
    await expect(page.getByText('We sent a new code.')).toHaveCount(0)
    // The resend changed nothing to announce.
    await expect(announced).toHaveText(said ?? '')
    expect(await plansRetry(page)).toBe(false)
    await enterCode(page, code)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your email is confirmed')
    await page.getByRole('button', { name: 'Continue without changing' }).click()
    await expect(page).toHaveURL('/')
    // Sent again once, never more.
    expect(await emailsTo(user.email, /password reset/i)).toHaveLength(1)
  })

  test('reset: the code, then a new password; the old one stops working', async ({
    page,
    context,
  }) => {
    await startReset(page, user.email)
    await enterCode(page, await nextCode(user.email))
    await page.getByRole('button', { name: 'Change password' }).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Set a new password')
    await expect(page.getByLabel('New password', { exact: true })).toBeFocused()
    // "Back" returns to the choice.
    await page.getByRole('button', { name: 'Back', exact: true }).click()
    await page.getByRole('button', { name: 'Change password' }).click()

    const password = 'A-brand-new-password-7'
    await page.getByLabel('New password', { exact: true }).fill(password)
    await page.getByLabel('Confirm new password', { exact: true }).fill(password)
    await page.getByRole('button', { name: 'Save new password' }).click()
    await expect(page).toHaveURL('/')
    await expect(page.getByText('Your password is changed.')).toBeVisible()
    expect(await passwordWorks(user.email, user.password)).toBe(false)

    // Signed out, the new password signs in through the page.
    await context.clearCookies()
    await useLanguage(context, 'en')
    await signIn(page, { ...user, password })
  })

  test('reset: Back, Forward or a reload after the code keep the user signed in', async ({
    page,
  }) => {
    await startReset(page, user.email)
    await enterCode(page, await nextCode(user.email))
    const title = page.getByRole('heading', { level: 1 })
    await expect(title).toHaveText('Your email is confirmed')

    // Back shows no email form to a signed-in user: /reset lets them continue.
    await page.goBack()
    await expect(page).toHaveURL('/reset')
    await expect(title).toHaveText("You're signed in")
    await expect(title).toBeFocused()
    await page.goForward()
    await expect(page).toHaveURL('/reset')
    await expect(title).toHaveText("You're signed in")

    // After a reload the page cannot tell the code's session apart: no password change here.
    await page.reload()
    await expect(title).toHaveText("You're signed in")
    await expect(page.getByRole('button', { name: 'Change password' })).toHaveCount(0)
    await expect(page.getByLabel('New password', { exact: true })).toHaveCount(0)
    expect(await sessionCount(user.id)).toBe(1)
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await expect(page).toHaveURL('/')
    await expect(title).toHaveText('Welcome to BizCost')
    expect(await passwordWorks(user.email, user.password)).toBe(true)
  })

  test('reset: no new password once the verified session is gone', async ({ page, context }) => {
    await startReset(page, user.email)
    await enterCode(page, await nextCode(user.email))
    await page.getByRole('button', { name: 'Change password' }).click()
    const password = 'A-brand-new-password-8'
    await page.getByLabel('New password', { exact: true }).fill(password)
    await page.getByLabel('Confirm new password', { exact: true }).fill(password)
    // Signed out in another tab.
    await context.clearCookies({ name: /^sb-/ })
    await page.getByRole('button', { name: 'Save new password' }).click()

    const title = page.getByRole('heading', { level: 1 })
    await expect(title).toHaveText('Your password was not changed')
    await expect(title).toBeFocused()
    await expect(
      page.getByText(
        "For your safety, you're signed out. Ask for a new code to reset your password",
      ),
    ).toBeVisible()
    expect(await passwordWorks(user.email, password)).toBe(false)
    expect(await passwordWorks(user.email, user.password)).toBe(true)

    // "Send a new code" goes back to the code (its countdown still runs for the last code).
    await page.getByRole('button', { name: 'Send a new code' }).click()
    await expect(page.getByLabel('Verification code')).toBeVisible()
    await expect(page.getByLabel('New password', { exact: true })).toHaveCount(0)
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

import { randomUUID } from 'node:crypto'
import { startHookedAuth, type HookedAuth } from '@bizcost/config/testing/hooked-auth'
import { LEGAL_VERSION } from '@bizcost/contracts'
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import postgres from 'postgres'
import {
  acceptTerms,
  callApi,
  createBusiness,
  createUser,
  createUserWithEmail,
  deleteUser,
  emailsTo,
  enterCode,
  findUserId,
  nextCode,
  pngImage,
  RAW_KEY,
  settle,
  uniqueEmail,
  WORKSHOP_ANSWERS,
  type TestUser,
} from '../helpers'
import { baseURL, E2E_FEEDBACK_TO, E2E_PLATFORM_ADMIN, heldBaseURL, stack } from '../stack'

// The closed beta on the production build (beta-launch.md Step 3; D-355–D-359):
//
//   - Closed sign-up: the browser's Auth calls go to a second real Auth server with the hook on (the
//     shared stack keeps it off for every other suite), so the pages meet the real refusal. A stranger
//     gets the kind message on the sign-up form and on "Send me a code"; an address on the beta list
//     goes through, with its code, in Arabic and English.
//   - The terms: the sign-up form's box; "Send me a code" asks once after the code; the version and the
//     time are stored; /privacy and /terms open to everyone, in both languages, and in the account menu.
//   - "Send feedback" on a business's page and outside any business, on a phone and on a desktop, with a
//     picture; it is saved, emailed, and read on the owner's page.
//   - The owner's page: only a platform admin; the list; everyone else finds no such page.
//   - A module held back (BIZCOST_HELD_MODULES=invoices), on a second server of the same build.
// With E2E_SHOTS_DIR set, each screen leaves a screenshot there.

test.describe.configure({ mode: 'serial' })

const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1440, height: 900 }

const users: TestUser[] = []
const contexts: BrowserContext[] = []
const addresses = new Set<string>()

function adminSql() {
  return postgres(
    process.env.DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
    { max: 1, onnotice: () => {} },
  )
}

async function list(email: string): Promise<void> {
  addresses.add(email)
  const sql = adminSql()
  try {
    await sql`insert into app.beta_list (email, note) values (${email}, 'e2e')`
  } finally {
    await sql.end()
  }
}

test.afterAll(async () => {
  for (const context of contexts) await context.close()
  for (const user of users) await deleteUser(user.id)
  const sql = adminSql()
  try {
    await sql`delete from app.beta_list where email::text = any(${[...addresses]})`
  } finally {
    await sql.end()
  }
})

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.E2E_SHOTS_DIR
  if (dir) await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true })
}

async function open(
  browser: Browser,
  options: {
    viewport?: { width: number; height: number }
    locale?: 'en' | 'ar'
    server?: string
  } = {},
): Promise<Page> {
  const locale = options.locale ?? 'en'
  const server = options.server ?? baseURL
  const context = await browser.newContext({
    baseURL: server,
    locale: locale === 'ar' ? 'ar-AE' : 'en-US',
    viewport: options.viewport ?? DESKTOP,
  })
  contexts.push(context)
  await context.addCookies([{ name: 'bz_locale', value: locale, url: server }])
  return context.newPage()
}

/** Signs in through the page, in the page's language. */
async function signInHere(page: Page, user: TestUser): Promise<void> {
  await page.goto('/login')
  await page.locator('input[type="email"]').fill(user.email)
  await page.locator('input[type="password"]').fill(user.password)
  await page.locator('form button[type="submit"]').click()
  await expect(page).not.toHaveURL(/\/login/)
}

async function signedIn(
  browser: Browser,
  options: Parameters<typeof open>[1] = {},
): Promise<{ page: Page; user: TestUser }> {
  const user = await createUser('beta', { locale: options.locale ?? 'en' })
  users.push(user)
  const page = await open(browser, options)
  await signInHere(page, user)
  return { page, user }
}

async function expectSound(page: Page): Promise<void> {
  const text = await page.locator('body').innerText()
  expect(text.match(RAW_KEY)?.[0]).toBeUndefined()
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow, 'no sideways scroll').toBeLessThanOrEqual(0)
}

test.describe('closed sign-up, against a real Auth server with the hook on', () => {
  let hooked: HookedAuth

  test.beforeAll(async () => {
    hooked = await startHookedAuth()
  })
  test.afterAll(async () => {
    await hooked?.stop()
  })

  /** The browser's Auth calls that can make an account go to the server with the hook on. */
  async function throughHookedAuth(page: Page): Promise<void> {
    for (const path of ['signup', 'otp'] as const) {
      await page.route(`**/auth/v1/${path}**`, async (route) => {
        const request = route.request()
        const response = await fetch(`${hooked.url}/${path}`, {
          method: request.method(),
          headers: { 'content-type': 'application/json' },
          body: request.postData() ?? undefined,
        })
        await route.fulfill({
          status: response.status,
          contentType: 'application/json',
          body: await response.text(),
        })
      })
    }
  }

  async function signUpForm(page: Page, email: string) {
    await page.goto('/signup')
    await page.locator('input[name="email"]').fill(email)
    await page.locator('input[name="password"]').fill('A-long-password-42')
    await acceptTerms(page)
    await page.locator('form button[type="submit"]').click()
  }

  test('a stranger is told, kindly, in Arabic on a phone: no account and no code', async ({
    browser,
  }) => {
    const page = await open(browser, { locale: 'ar', viewport: PHONE })
    await throughHookedAuth(page)
    const email = uniqueEmail('beta-refused')
    await signUpForm(page, email)
    const refusal = page.getByRole('alert').filter({ hasText: 'هذه نسخة تجريبية بدعوة فقط' })
    await expect(refusal).toBeVisible()
    await expect(refusal).toContainText('support@bizcost.ae')
    // The only next step: on a phone it is a tap, not copying by hand.
    await expect(refusal.getByRole('link', { name: 'support@bizcost.ae' })).toHaveAttribute(
      'href',
      'mailto:support@bizcost.ae',
    )
    // And the page said so before anything was typed.
    await expect(page.getByText('BizCost في مرحلة تجريبية مغلقة، وبدعوة فقط.')).toBeVisible()
    await expect(page).toHaveURL('/signup')
    await expectSound(page)
    await shot(page, 'ar-phone-signup-refused')
    expect(await findUserId(email)).toBeNull()
    expect(await emailsTo(email)).toEqual([])
  })

  test('and in English on a desktop, on "Send me a code" too', async ({ browser }) => {
    const page = await open(browser)
    await throughHookedAuth(page)
    const email = uniqueEmail('beta-refused-code')
    await page.goto('/login')
    await page.getByText('Email code').click()
    await page.getByLabel('Email', { exact: true }).fill(email)
    await page.getByRole('button', { name: 'Send me a code' }).click()
    const refusal = page
      .getByRole('alert')
      .filter({ hasText: 'This is a beta version, by invitation only' })
    await expect(refusal).toBeVisible()
    await expect(refusal.getByRole('link', { name: 'support@bizcost.ae' })).toHaveAttribute(
      'href',
      'mailto:support@bizcost.ae',
    )
    // Nothing under the refusal promises the account it was just refused.
    await expect(page.getByText("We'll email you a code to sign in")).toBeVisible()
    await expect(page.getByText('we’ll create one')).toHaveCount(0)
    await expect(page.getByText("we'll create one")).toHaveCount(0)
    await expect(page).toHaveURL('/login')
    expect(await findUserId(email)).toBeNull()
  })

  test('an address on the list goes through, with its code', async ({ browser }) => {
    const page = await open(browser, { locale: 'ar', viewport: PHONE })
    await throughHookedAuth(page)
    const email = uniqueEmail('beta-listed')
    await list(email)
    await signUpForm(page, email)
    await expect(page).toHaveURL('/verify')
    const id = await findUserId(email)
    users.push({ id: id!, email, password: '' })
    await enterCode(page, await nextCode(email))
    await expect(page).toHaveURL('/')
    // The sign-up form's box was ticked: no second question.
    await expect(page.getByRole('heading', { name: 'أمر واحد قبل أن تتابع' })).toHaveCount(0)
  })
})

test.describe('the terms', () => {
  async function termsOf(userId: string) {
    const sql = adminSql()
    try {
      const [row] = await sql<{ terms_version: string | null; terms_accepted_at: Date | null }[]>`
        select terms_version, terms_accepted_at from app.profiles where id = ${userId}`
      return row
    } finally {
      await sql.end()
    }
  }

  test('the sign-up form needs the box; its version and time are stored', async ({ browser }) => {
    const page = await open(browser)
    const email = uniqueEmail('beta-terms')
    await page.goto('/signup')
    await page.getByLabel('Email', { exact: true }).fill(email)
    await page.getByRole('textbox', { name: 'Password', exact: true }).fill('A-long-password-42')
    await page.getByRole('button', { name: 'Create account' }).click()
    await expect(
      page.getByText(
        'To create an account, please accept the terms of use and the privacy policy.',
      ),
    ).toBeVisible()
    await expect(page).toHaveURL('/signup')

    // Each link opens in a new tab, so the form keeps what was typed.
    const [terms] = await Promise.all([
      page.context().waitForEvent('page'),
      page.getByRole('link', { name: 'terms of use' }).click(),
    ])
    await expect(terms.getByRole('heading', { name: 'Terms of use', level: 1 })).toBeVisible()
    await terms.close()
    await expect(page.getByLabel('Email', { exact: true })).toHaveValue(email)

    await acceptTerms(page)
    await page.getByRole('button', { name: 'Create account' }).click()
    await expect(page).toHaveURL('/verify')
    const id = await findUserId(email)
    users.push({ id: id!, email, password: '' })
    await enterCode(page, await nextCode(email))
    await expect(page).toHaveURL('/')
    await expect(page.getByRole('heading', { name: 'One thing before you go on' })).toHaveCount(0)
    const row = await termsOf(id!)
    expect(row?.terms_version).toBe(LEGAL_VERSION)
    expect(row?.terms_accepted_at).toBeInstanceOf(Date)
  })

  test('"Send me a code" makes accounts too: it asks once, after the code', async ({ browser }) => {
    const page = await open(browser, { locale: 'ar', viewport: PHONE })
    const email = uniqueEmail('beta-gate')
    await page.goto('/login')
    await page.getByText('رمز عبر البريد').click()
    await page.locator('input[type="email"]').fill(email)
    await page.getByRole('button', { name: 'أرسل لي رمزًا' }).click()
    await expect(page).toHaveURL('/verify')
    const id = await findUserId(email)
    users.push({ id: id!, email, password: '' })
    await enterCode(page, await nextCode(email))
    const gate = page.getByRole('heading', { name: 'أمر واحد قبل أن تتابع' })
    await expect(gate).toBeVisible()
    await expectSound(page)
    await shot(page, 'ar-phone-terms-gate')
    expect((await termsOf(id!))?.terms_version).toBeNull()

    // Landed in the wrong language: the gate has its own menu, and the choice stays after a reload.
    await page.getByRole('button', { name: /اللغة/ }).click()
    await page.getByRole('menuitem', { name: 'English' }).click()
    const english = page.getByRole('heading', { name: 'One thing before you go on' })
    await expect(english).toBeVisible()
    await page.reload()
    await expect(english).toBeVisible()
    await page.getByRole('button', { name: /language/i }).click()
    await page.getByRole('menuitem', { name: 'العربية' }).click()
    await expect(gate).toBeVisible()

    await page.getByRole('button', { name: 'أوافق' }).click()
    await expect(gate).toHaveCount(0)
    expect((await termsOf(id!))?.terms_version).toBe(LEGAL_VERSION)
    await page.reload()
    await expect(gate).toHaveCount(0)
  })

  for (const [path, en, ar] of [
    ['/privacy', 'Privacy policy', 'سياسة الخصوصية'],
    ['/terms', 'Terms of use', 'شروط الاستخدام'],
  ] as const) {
    test(`${path} is open to everyone, says it is for the beta, in both languages`, async ({
      browser,
    }) => {
      const english = await open(browser)
      await english.goto(path)
      await expect(english).toHaveURL(path)
      await expect(english.getByRole('heading', { name: en, level: 1 })).toBeVisible()
      await expect(english.locator('[data-beta-notice]')).toContainText('closed beta')
      await expect(english.locator('main')).toContainText('support@bizcost.ae')
      await expectSound(english)

      const arabic = await open(browser, { locale: 'ar', viewport: PHONE })
      await arabic.goto(path)
      await expect(arabic.locator('html')).toHaveAttribute('dir', 'rtl')
      await expect(arabic.getByRole('heading', { name: ar, level: 1 })).toBeVisible()
      await expect(arabic.locator('[data-beta-notice]')).toContainText('تجريبية')
      await expectSound(arabic)
      await shot(arabic, `ar-phone-${path.slice(1)}`)

      const desktop = await open(browser, { locale: 'ar' })
      await desktop.goto(path)
      await shot(desktop, `ar-desktop-${path.slice(1)}`)
    })
  }

  test('both are in the account menu, signed in, and open from there', async ({ browser }) => {
    const { page } = await signedIn(browser)
    await page.getByRole('button', { name: /Account menu/ }).click()
    await page.getByRole('menuitem', { name: 'Privacy policy' }).click()
    await expect(page).toHaveURL('/privacy')
    await page.goBack()
    await page.getByRole('button', { name: /Account menu/ }).click()
    await page.getByRole('menuitem', { name: 'Terms of use' }).click()
    await expect(page).toHaveURL('/terms')
  })

  test('the sign-up form in Arabic, with its links', async ({ browser }) => {
    const page = await open(browser, { locale: 'ar', viewport: PHONE })
    await page.goto('/signup')
    await expect(page.getByRole('link', { name: 'شروط الاستخدام' })).toHaveAttribute(
      'href',
      '/terms',
    )
    await expect(page.getByRole('link', { name: 'سياسة الخصوصية' })).toHaveAttribute(
      'href',
      '/privacy',
    )
    await expectSound(page)
    await shot(page, 'ar-phone-signup')
    const desktop = await open(browser, { locale: 'ar' })
    await desktop.goto('/signup')
    await shot(desktop, 'ar-desktop-signup')
  })
})

test.describe('Send feedback, and the owner reads it', () => {
  // With a long link, as people paste them: the owner's page must not scroll sideways for it.
  const MESSAGE = `المجموع غير صحيح في المبيعات ${randomUUID().slice(0, 8)} https://drive.google.com/file/d/${'x'.repeat(120)}/view`
  let owner: TestUser

  test.beforeAll(async () => {
    owner = await createUserWithEmail(E2E_PLATFORM_ADMIN, { locale: 'ar' })
    users.push(owner)
  })

  test('from a business’s page, on a phone, with a picture: saved and emailed', async ({
    browser,
  }) => {
    const { page } = await signedIn(browser, { locale: 'ar', viewport: PHONE })
    const businessId = await createBusiness(page, 'ورشة التجربة', WORKSHOP_ANSWERS)
    await page.goto(`/b/${businessId}/sales`)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expectSound(page)
    await settle(page)
    await shot(page, 'ar-phone-shell')

    await page.locator('[data-feedback-button]').click()
    const dialog = page.getByRole('dialog', { name: 'إرسال ملاحظة' })
    await expect(dialog).toBeVisible()
    // Empty, the box follows the page: an Arabic placeholder and caret start on the right.
    const box = dialog.locator('textarea')
    await expect(box).toHaveCSS('direction', 'rtl')
    await box.fill('Latin text reads from the left')
    await expect(box).toHaveCSS('direction', 'ltr')
    await box.fill('')
    await expect(box).toHaveCSS('direction', 'rtl')
    await dialog.getByRole('button', { name: 'إرسال' }).click()
    await expect(dialog.getByText('اكتب رسالتك أولًا.')).toBeVisible()
    await dialog.getByRole('textbox').fill(MESSAGE)
    await page.locator('[data-feedback-picture-input]').setInputFiles({
      name: 'screen.png',
      mimeType: 'image/png',
      buffer: pngImage(64),
    })
    await expect(dialog).toContainText('screen.png')
    await shot(page, 'ar-phone-feedback')
    await dialog.getByRole('button', { name: 'إرسال' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByText('شكرًا لك. وصلتنا رسالتك.')).toBeVisible()

    await expect
      .poll(async () => (await emailsTo(E2E_FEEDBACK_TO)).length, { timeout: 15_000 })
      .toBeGreaterThan(0)
    const [email] = await emailsTo(E2E_FEEDBACK_TO)
    expect(email?.Subject).toBe('ملاحظة جديدة في BizCost')
    const detail = (await (
      await fetch(`${stack().mailpitUrl}/api/v1/message/${email?.ID}`)
    ).json()) as { Text: string; ReplyTo: { Address: string }[] }
    expect(detail.Text).toContain(MESSAGE)
    expect(detail.Text).toContain(`/b/${businessId}/sales`)
    expect(detail.Text).toContain('ورشة التجربة')
    expect(detail.ReplyTo[0]?.Address).toMatch(/@test\.bizcost\.local$/)
  })

  test('outside any business, on a desktop, in English', async ({ browser }) => {
    const { page, user } = await signedIn(browser)
    await page.goto('/account')
    await page.getByRole('button', { name: 'Send feedback' }).click()
    const dialog = page.getByRole('dialog', { name: 'Send feedback' })
    await dialog.getByRole('textbox').fill('Sent from my account page')
    // A file that is not an allowed picture is refused before anything is sent.
    await page.locator('[data-feedback-picture-input]').setInputFiles({
      name: 'page.html',
      mimeType: 'text/html',
      buffer: Buffer.from('<html></html>'),
    })
    await expect(dialog.getByRole('alert').filter({ hasText: 'PNG, JPEG or WebP' })).toBeVisible()
    await dialog.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByText('Thank you. We received your message.')).toBeVisible()
    const sql = adminSql()
    try {
      const [row] = await sql<{ page_path: string; from_business_id: string | null }[]>`
        select page_path, from_business_id from app.feedback where user_id = ${user.id}`
      expect(row).toEqual({ page_path: '/account', from_business_id: null })
    } finally {
      await sql.end()
    }
  })

  test('the owner’s page: the feedback with its picture, and the list', async ({ browser }) => {
    const page = await open(browser, { locale: 'ar' })
    await signInHere(page, owner)
    await page.getByRole('button', { name: /قائمة الحساب/ }).click()
    await page.getByRole('menuitem', { name: 'النسخة التجريبية' }).click()
    await expect(page).toHaveURL('/platform')
    await expect(page.getByRole('heading', { name: 'النسخة التجريبية', level: 1 })).toBeVisible()

    const item = page.locator('[data-feedback-item]').filter({ hasText: MESSAGE })
    // No sideways scrolling, whatever someone pasted (the review's long Drive link).
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
      .toBeLessThanOrEqual(0)
    await expect(item).toContainText('ورشة التجربة')
    await expect(item).toContainText('/sales')
    const picture = item.getByRole('img', { name: 'الصورة المرفقة بهذه الملاحظة' })
    await expect(picture).toBeVisible()
    await expect
      .poll(() => picture.evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBeGreaterThan(0)

    const email = uniqueEmail('beta-page')
    addresses.add(email)
    const form = page.locator('[data-beta-form]')
    await form.getByLabel('البريد الإلكتروني').fill('not an address')
    await form.getByRole('button', { name: 'إضافة' }).click()
    await expect(form.getByText('أدخل بريدًا إلكترونيًا صحيحًا.')).toBeVisible()
    await form.getByLabel('البريد الإلكتروني').fill(email.toUpperCase())
    await form.getByLabel('ملاحظة (اختيارية)').fill('ورشة صديق')
    await form.getByRole('button', { name: 'إضافة' }).click()
    const entry = page.locator('[data-beta-entry]').filter({ hasText: email })
    await expect(entry).toContainText('ورشة صديق')
    await expectSound(page)
    await shot(page, 'ar-desktop-platform')
    // One tap asks first, and names the address; only the second takes it off.
    await entry.getByRole('button', { name: `حذف ${email}` }).click()
    const confirm = page.getByRole('alertdialog')
    await expect(confirm).toContainText(email)
    await confirm.getByRole('button', { name: 'إلغاء' }).click()
    await expect(entry).toHaveCount(1)
    await entry.getByRole('button', { name: `حذف ${email}` }).click()
    await confirm.getByRole('button', { name: 'حذف', exact: true }).click()
    await expect(entry).toHaveCount(0)
    await expect(page.getByText(`حُذف ${email} من القائمة.`)).toBeVisible()

    const phone = await open(browser, { locale: 'ar', viewport: PHONE })
    await signInHere(phone, owner)
    await phone.goto('/platform')
    await expectSound(phone)
    await shot(phone, 'ar-phone-platform')
  })

  test('anyone else finds no such page, and no way to it', async ({ browser }) => {
    const { page } = await signedIn(browser)
    await page.getByRole('button', { name: /Account menu/ }).click()
    await expect(page.getByRole('menuitem', { name: 'Beta', exact: true })).toHaveCount(0)
    await page.keyboard.press('Escape')
    const response = await page.goto('/platform')
    expect(response?.status()).toBe(404)
    await expect(page.getByRole('heading', { name: 'Beta', level: 1 })).toHaveCount(0)
    const list = await callApi(page, 'platform.betaList', {}, { query: true })
    expect(list.appCode).toBe('forbidden')
  })

  test('the desktop top bar has the words, the shell’s dialog in Arabic', async ({ browser }) => {
    const { page } = await signedIn(browser, { locale: 'ar' })
    const businessId = await createBusiness(page, 'ورشة سطح المكتب', WORKSHOP_ANSWERS)
    await page.goto(`/b/${businessId}`)
    await expect(page.getByRole('button', { name: 'إرسال ملاحظة' })).toBeVisible()
    await settle(page)
    await shot(page, 'ar-desktop-shell')
    await page.getByRole('button', { name: 'إرسال ملاحظة' }).click()
    await expect(page.getByRole('dialog', { name: 'إرسال ملاحظة' })).toBeVisible()
    await shot(page, 'ar-desktop-feedback')
  })
})

test.describe('a module held back (BIZCOST_HELD_MODULES=invoices), on the production build', () => {
  async function businessWithQuotation(page: Page) {
    const businessId = await createBusiness(page, 'Held Workshop', WORKSHOP_ANSWERS)
    const customer = await callApi<{ id: string }>(
      page,
      'customer.create',
      { id: randomUUID(), name: 'A customer', kind: 'individual' },
      { businessId },
    )
    const quote = await callApi<{ id: string; version: number }>(
      page,
      'quotation.create',
      {
        id: randomUUID(),
        customerId: customer.data?.id,
        // Yesterday by UTC: never after the business's today, wherever the clock is.
        businessDate: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
        lines: [
          {
            id: randomUUID(),
            productId: null,
            description: 'A table',
            qty: '1',
            unit: 'piece',
            unitPrice: '100',
          },
        ],
      },
      { businessId },
    )
    if (!quote.data) throw new Error(`quotation.create: ${quote.appCode}`)
    const sent = await callApi<{ id: string; version: number }>(
      page,
      'quotation.send',
      { id: quote.data.id, version: quote.data.version },
      { businessId },
    )
    if (!sent.data) throw new Error(`quotation.send: ${sent.appCode}`)
    const accepted = await callApi(
      page,
      'quotation.accept',
      { id: sent.data.id, version: sent.data.version, note: null },
      { businessId },
    )
    if (accepted.appCode) throw new Error(`quotation.accept: ${accepted.appCode}`)
    return { businessId, quotationId: quote.data.id }
  }

  test('its page, nav, "+" and API are gone; quotations work, with no "convert to invoice"', async ({
    browser,
  }) => {
    const user = await createUser('beta-held', { locale: 'en' })
    users.push(user)
    // The same business on the plain server first, where everything is open.
    const open_ = await open(browser)
    await signInHere(open_, user)
    const { businessId, quotationId } = await businessWithQuotation(open_)
    await open_.goto(`/b/${businessId}/quotations/${quotationId}`)
    await expect(open_.locator('[data-quotation-invoice]')).toBeVisible()
    await open_.goto(`/b/${businessId}/invoices`)
    await expect(open_.getByRole('heading', { name: 'Invoices', level: 1 })).toBeVisible()

    const page = await open(browser, { server: heldBaseURL })
    await signInHere(page, user)
    await page.goto(`/b/${businessId}`)
    await expect(page.getByRole('link', { name: 'Quotations' }).first()).toBeVisible()
    await expect(page.getByRole('link', { name: 'Invoices', exact: true })).toHaveCount(0)

    for (const path of ['invoices', 'invoices/new']) {
      await page.goto(`/b/${businessId}/${path}`)
      await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
    }

    const answer = await callApi(page, 'invoice.list', {}, { businessId, query: true })
    expect(answer.appCode).toBe('module_disabled')

    const quotations = await page.goto(`/b/${businessId}/quotations`)
    expect(quotations?.status()).toBe(200)
    await page.goto(`/b/${businessId}/quotations/${quotationId}`)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.locator('[data-quotation-invoice]')).toHaveCount(0)
    await expectSound(page)

    // Customize marks it "Soon"; the business's own switch is kept.
    await page.goto(`/b/${businessId}/settings/modules`)
    await expect(page.getByText('Soon', { exact: true }).first()).toBeVisible()
  })

  /** The review of Smart Setup for a workshop that sends quotes: its row for Invoices. */
  async function invoicesRow(page: Page) {
    await page.goto('/setup')
    await expect(page.locator('main')).toBeVisible()
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem('bz_setup'))).not.toBeNull()
    await page.evaluate((answers) => {
      const draft = JSON.parse(sessionStorage.getItem('bz_setup') ?? '{}') as object
      sessionStorage.setItem(
        'bz_setup',
        JSON.stringify({ ...draft, name: 'Held Setup', answers, step: 'review' }),
      )
    }, WORKSHOP_ANSWERS)
    await page.reload()
    return page.locator('[data-item="invoices"]')
  }

  test('Smart Setup marks it "Soon" there, and not on the plain server; a business set up there has it off the nav', async ({
    browser,
  }) => {
    const user = await createUser('beta-held-setup', { locale: 'en' })
    users.push(user)
    const plain = await open(browser)
    await signInHere(plain, user)
    const plainRow = await invoicesRow(plain)
    await expect(plainRow).toBeVisible()
    await expect(plainRow.getByText('Soon', { exact: true })).toHaveCount(0)

    const page = await open(browser, { server: heldBaseURL })
    await signInHere(page, user)
    const row = await invoicesRow(page)
    await expect(row.getByText('Soon', { exact: true })).toBeVisible()

    const created = await callApi<{ businessId: string }>(page, 'business.createFromSetup', {
      businessId: randomUUID(),
      legalName: 'Held Setup',
      locale: 'en',
      questionSetVersion: 1,
      answers: WORKSHOP_ANSWERS,
      adjustments: { modules: [], capabilities: [] },
    })
    expect(created.data?.businessId).toBeTruthy()
    const context = await callApi<{ modules: { id: string }[] }>(
      page,
      'business.context',
      {},
      { businessId: created.data?.businessId, query: true },
    )
    expect(context.data?.modules.map((m) => m.id)).not.toContain('invoices')
    expect(context.data?.modules.map((m) => m.id)).toContain('quotations')
  })
})

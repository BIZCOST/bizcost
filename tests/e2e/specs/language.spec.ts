import { expect, test } from '@playwright/test'
import { createUser, deleteUser, drawn, getUser, signIn, useLanguage } from '../helpers'

// Switching between Arabic (RTL) and English (LTR), signed out and signed in.

test('a new visitor gets the browser language, and can switch it', async ({ page }) => {
  await page.goto('/login')
  const html = page.locator('html')
  await expect(html).toHaveAttribute('lang', 'en')
  await expect(html).toHaveAttribute('dir', 'ltr')

  await page.getByRole('button', { name: /Change language/ }).click()
  await page.getByRole('menuitem', { name: 'العربية' }).click()
  await expect(html).toHaveAttribute('dir', 'rtl')
  await expect(html).toHaveAttribute('lang', 'ar')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('تسجيل الدخول')

  // Remembered on the next visit.
  await page.reload()
  await expect(html).toHaveAttribute('dir', 'rtl')

  await page.getByRole('button', { name: /تغيير اللغة/ }).click()
  await page.getByRole('menuitem', { name: 'English' }).click()
  await expect(html).toHaveAttribute('dir', 'ltr')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in')
})

test('in Arabic, typed password text never runs under the show/hide button', async ({
  page,
  context,
}) => {
  await useLanguage(context, 'ar')
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto('/login')
  const input = page.getByRole('textbox', { name: 'كلمة المرور', exact: true })
  await input.fill('Password-123')
  const box = await input.boundingBox()
  const button = await page.getByRole('button', { name: 'إظهار كلمة المرور' }).boundingBox()
  const { direction, paddingRight } = await input.evaluate((element) => {
    const style = getComputedStyle(element)
    return { direction: style.direction, paddingRight: parseFloat(style.paddingRight) }
  })
  expect(direction).toBe('ltr')
  expect(box && button).toBeTruthy()
  // The button sits inside the input's end padding (on the right, where LTR text ends).
  expect(button!.x).toBeGreaterThanOrEqual(box!.x + box!.width - paddingRight - 1)
  expect(button!.x + button!.width).toBeLessThanOrEqual(box!.x + box!.width + 1)
})

test('in Arabic, the password rule shows (a-z , 0-9) and 0-9 left to right (D-072)', async ({
  page,
  context,
}) => {
  await useLanguage(context, 'ar')
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto('/signup')
  const input = page.getByRole('textbox', { name: 'كلمة المرور', exact: true })
  await expect(input).toHaveAccessibleDescription('8 أحرف على الأقل، مزيج من (a-z , 0-9)')
  await expect(page.locator('li[data-rule="length"]')).toContainText('8 أحرف أو أكثر')

  // Each Latin part is an LTR isolate, drawn left to right character by character, on one line.
  for (const text of ['(a-z , 0-9)', 'a-z', '0-9']) {
    const bdi = page
      .locator('bdi[dir="ltr"]')
      .filter({ hasText: new RegExp(`^${text.replace(/[()]/g, '\\$&')}$`) })
    await expect(bdi, text).toHaveCSS('direction', 'ltr')
    expect(await bdi.evaluate(drawn, text), text).toEqual({ text, lines: 1 })
  }

  // The checklist follows the typing; an Arabic-Indic digit is not a 0-9 digit.
  const digit = page.locator('li[data-rule="digit"]')
  await input.fill('abcdefg٣')
  await expect(digit).toHaveAttribute('data-met', 'false')
  await input.fill('abcdefg3')
  await expect(digit).toHaveAttribute('data-met', 'true')
  await expect(page.getByRole('main').getByRole('status')).toHaveText(
    'كلمة المرور تستوفي كل الشروط.',
  )

  // The error after submitting names the same range inside LTR isolate marks (LRI … PDI), kept on
  // one line by no-break spaces and a word joiner after each hyphen.
  await input.fill('abcdefgh')
  await page.getByRole('button', { name: 'إنشاء الحساب' }).click()
  const error = page.getByRole('alert').filter({ hasText: 'أضف حرفًا ورقمًا على الأقل' })
  await expect(error).toBeVisible()
  expect(await error.evaluate(drawn, '\u2066(a-\u2060z\u00a0,\u00a00-\u20609)\u2069')).toEqual({
    text: '(a-z\u00a0,\u00a00-9)',
    lines: 1,
  })
})

test('Arabic is the default for other browser languages', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'fr-FR' })
  const page = await context.newPage()
  await page.goto('/login')
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
  await context.close()
})

test('a signed-in user switches language and it is saved to the account', async ({
  page,
  context,
}) => {
  const user = await createUser('language', { locale: 'en' })
  try {
    await useLanguage(context, 'en')
    await signIn(page, user)
    const html = page.locator('html')
    await expect(html).toHaveAttribute('dir', 'ltr')

    await page.getByRole('button', { name: /Change language/ }).click()
    await page.getByRole('menuitem', { name: 'العربية' }).click()
    await expect(html).toHaveAttribute('dir', 'rtl')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('أهلًا بك في BizCost')

    // Saved in the profile (the account page shows it) and for the auth emails.
    await page.goto('/account')
    await expect(page.getByRole('radio', { name: 'العربية' })).toBeChecked()
    await expect.poll(async () => (await getUser(user.id))?.user_metadata.locale).toBe('ar')

    // The profile wins over another browser's cookie.
    await useLanguage(context, 'en')
    await page.goto('/account')
    await expect(html).toHaveAttribute('dir', 'rtl')
  } finally {
    await deleteUser(user.id)
  }
})

import { expect, test } from '@playwright/test'
import { createUser, deleteUser, getUser, signIn, useLanguage } from '../helpers'

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

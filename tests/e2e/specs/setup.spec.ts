import { expect, test, type Page } from '@playwright/test'
import {
  createUser,
  deleteUser,
  enterCode,
  findUserId,
  nextCode,
  savedSetup,
  signIn,
  uniqueEmail,
  useLanguage,
} from '../helpers'

// Smart Setup (docs/PRODUCT.md §6, ROADMAP.md Step 5): a new account sets up its first business,
// lands on the business home, adds a second business through the switcher and switches back; the
// wizard keeps its answers over a reload; English and Arabic.

const users: (string | null)[] = []
test.afterAll(async () => {
  for (const id of users) await deleteUser(id)
})

const BUSINESS_PATH = /\/b\/([0-9a-f-]{36})$/

function businessIdOf(page: Page): string {
  const id = BUSINESS_PATH.exec(new URL(page.url()).pathname)?.[1]
  if (!id) throw new Error(`not a business page: ${page.url()}`)
  return id
}

/** The question on screen: its heading has the focus (§6.3) and shows `title`. */
async function onQuestion(page: Page, title: string, progress?: string): Promise<void> {
  const heading = page.getByRole('heading', { level: 1, name: title })
  await expect(heading).toBeVisible()
  await expect(heading).toBeFocused()
  if (progress) await expect(page.getByText(progress, { exact: true })).toBeVisible()
}

/**
 * Chooses an option: the radio or checkbox is visually hidden inside its option card, so the card is
 * clicked, as a user does.
 */
async function pick(page: Page, role: 'radio' | 'checkbox', name: string): Promise<void> {
  const input = page.getByRole(role, { name, exact: true })
  await page.getByRole('main').locator('label').filter({ has: input }).click()
  await expect(page.getByRole('main').getByRole(role, { name, exact: true })).toBeChecked()
}

/** The message of the step on screen (Next.js also has an alert: its route announcer). */
function stepAlert(page: Page) {
  return page.getByRole('main').getByRole('alert')
}

interface Labels {
  next: string
  confirm: string
  go: string
}

const EN: Labels = { next: 'Next', confirm: 'Set up my BizCost', go: "Let's go" }
const AR: Labels = { next: 'التالي', confirm: 'جهّز BizCost لعملي', go: 'لنبدأ' }

/** Answers the questions on screen in order: [heading, option names] (radio or checkboxes). */
async function answer(
  page: Page,
  labels: Labels,
  steps: readonly (readonly [string, readonly string[]])[],
): Promise<void> {
  for (const [title, options] of steps) {
    await onQuestion(page, title)
    for (const name of options) {
      const radio = page.getByRole('main').getByRole('radio', { name, exact: true })
      await pick(page, (await radio.count()) > 0 ? 'radio' : 'checkbox', name)
    }
    await page.getByRole('button', { name: labels.next }).click()
  }
}

test('sign up, set up a home bakery with Smart Setup and land on its home (English)', async ({
  page,
  context,
}) => {
  await useLanguage(context, 'en')
  const email = uniqueEmail('setup')
  await page.goto('/signup')
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill('A-long-password-42')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page).toHaveURL('/verify')
  users.push(await findUserId(email))
  await enterCode(page, await nextCode(email))
  await expect(page).toHaveURL('/')

  // Home offers Smart Setup.
  await expect(page.getByText('No business yet')).toBeVisible()
  await page.getByRole('link', { name: 'Set up my business' }).click()
  await expect(page).toHaveURL('/setup')

  // Step 0: the name is required.
  const name = page.getByRole('textbox', { name: "What's your business called?" })
  await expect(name).toBeVisible()
  await page.getByRole('button', { name: 'Next' }).click()
  await expect(stepAlert(page)).toHaveText('Enter your business name.')
  await name.fill("Sara's Sweets")
  await page.getByRole('button', { name: 'Next' }).click()

  // Question 1: a group of checkboxes; Next needs a choice.
  await onQuestion(page, 'What does your business do?', 'Question 1 of 10')
  await expect(page.getByRole('group', { name: 'What does your business do?' })).toBeVisible()
  await page.getByRole('button', { name: 'Next' }).click()
  await expect(stepAlert(page)).toHaveText('Choose at least one.')
  await pick(page, 'checkbox', 'I make food or drinks')
  await page.getByRole('button', { name: 'Next' }).click()

  // Food skips "how are your products made"; home skips branches and the POS question.
  await onQuestion(page, 'Where do you mainly work?', 'Question 2 of 9')
  await expect(page.getByRole('radiogroup', { name: 'Where do you mainly work?' })).toBeVisible()
  await pick(page, 'radio', 'From home')
  await expect(page.getByText('Question 2 of 7', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Next' }).click()
  await onQuestion(page, 'Does anyone work with you?', 'Question 3 of 7')

  // A reload keeps the name, the answers and the step.
  await page.reload()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Does anyone work with you?')
  await page.getByRole('button', { name: 'Back' }).click()
  await onQuestion(page, 'Where do you mainly work?')
  await expect(page.getByRole('radio', { name: 'From home' })).toBeChecked()
  await page.getByRole('button', { name: 'Back' }).click()
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(page.getByRole('textbox', { name: "What's your business called?" })).toHaveValue(
    "Sara's Sweets",
  )
  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByRole('button', { name: 'Next' }).click()

  // The keyboard alone answers a question.
  await onQuestion(page, 'Does anyone work with you?')
  await page.keyboard.press('Tab')
  await expect(page.getByRole('radio', { name: 'No, just me' })).toBeFocused()
  await page.keyboard.press('Space')
  await expect(page.getByRole('radio', { name: 'No, just me' })).toBeChecked()
  await page.getByRole('button', { name: 'Next' }).click()

  await answer(page, EN, [
    ['Which of these apply to your work?', ['None of these']],
    ['How do customers order and pay?', ['They order by WhatsApp, Instagram or phone']],
  ])
  await onQuestion(page, 'Is your business registered for VAT?', 'Question 6 of 6')
  await pick(page, 'radio', 'No')
  await page.getByRole('button', { name: 'Next' }).click()

  // The review: Orders chosen, the food wording, capabilities as statements.
  await onQuestion(page, "Here's your BizCost")
  await expect(page.getByRole('switch', { name: 'Orders' })).toBeChecked()
  await expect(page.getByRole('listitem').filter({ hasText: /^Ingredients$/ })).toBeVisible()
  const team = page.getByRole('switch', { name: 'Team', exact: true })
  await expect(team).not.toBeChecked()
  await expect(team).toHaveAccessibleDescription('Just you, no team')
  // A switch with side effects says what else changed.
  await team.click()
  await expect(team).toBeChecked()
  await expect(team).toHaveAccessibleDescription('Others work with you')
  await expect(page.getByText('Also turned on:')).toBeVisible()
  await expect(page.getByRole('switch', { name: 'Employees' })).toBeChecked()
  await team.click()
  await expect(team).not.toBeChecked()
  await expect(page.getByText('Also turned off:')).toBeVisible()

  await page.getByRole('button', { name: 'Set up my BizCost' }).click()
  await expect(page).toHaveURL(/\/setup\?done=/)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your BizCost is ready')
  await expect(page.getByText(/Sara's Sweets⁩? is set up\./)).toBeVisible()
  await page.getByRole('link', { name: "Let's go" }).click()

  await expect(page).toHaveURL(BUSINESS_PATH)
  const businessId = businessIdOf(page)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText("Sara's Sweets")
  for (const statement of ['Just you, no team', 'Not registered for VAT']) {
    await expect(page.getByRole('listitem').filter({ hasText: statement })).toBeVisible()
  }
  // Only what is on besides team and VAT: a home business was never asked about branches.
  await expect(page.getByText('One branch')).toHaveCount(0)
  await expect(page.getByText('Cost and profit for each job')).toHaveCount(0)
  expect(await savedSetup(businessId)).toEqual({
    legalName: "Sara's Sweets",
    businessType: 'food',
    terminologyProfile: 'food',
    vatRegistered: false,
    defaultLocation: 'Home',
    enabledModules: ['orders'],
  })

  // Home now goes to the business; the finished setup does not come back.
  await page.goto('/')
  await expect(page).toHaveURL(`/b/${businessId}`)
  await page.goto('/setup')
  await expect(page.getByRole('textbox', { name: "What's your business called?" })).toHaveValue('')
})

test('a second business through the switcher, and back (Arabic)', async ({ page, context }) => {
  const user = await createUser('switch', { locale: 'ar' })
  users.push(user.id)
  await useLanguage(context, 'en')
  await signIn(page, user)
  // The account's language wins: Arabic, right to left.
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
  await page.getByRole('link', { name: 'إعداد عملي التجاري' }).click()

  await page.getByRole('textbox', { name: 'ما اسم عملك؟' }).fill('حلويات سارة')
  await page.getByRole('button', { name: AR.next }).click()
  await answer(page, AR, [
    ['ما طبيعة عملك؟', ['أحضّر طعامًا أو مشروبات']],
    ['أين مكان عملك في الغالب؟', ['من المنزل']],
    ['هل يعمل معك أحد؟', ['لا، أنا فقط']],
    ['ما الذي ينطبق على عملك؟', ['لا شيء مما سبق']],
    ['كيف يطلب منك العملاء ويدفعون؟', ['يطلبون عبر واتساب أو إنستغرام أو الهاتف']],
    ['هل عملك مسجّل في ضريبة القيمة المضافة؟', ['لا']],
  ])
  await onQuestion(page, 'إليك BizCost المناسب لعملك')
  await expect(page.getByRole('switch', { name: 'الطلبات' })).toBeChecked()
  await page.getByRole('button', { name: AR.confirm }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('BizCost جاهز لك')
  await page.getByRole('link', { name: AR.go }).click()
  await expect(page).toHaveURL(BUSINESS_PATH)
  const first = businessIdOf(page)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('حلويات سارة')
  expect((await savedSetup(first))?.defaultLocation).toBe('المنزل')

  // The switcher: create another business.
  const switcher = page.getByRole('button', { name: /^تبديل العمل التجاري: / })
  await expect(switcher).toContainText('حلويات سارة')
  await switcher.click()
  await page.getByRole('menuitem', { name: 'إنشاء عمل تجاري آخر' }).click()
  await expect(page).toHaveURL('/setup')
  await page.getByRole('textbox', { name: 'ما اسم عملك؟' }).fill('استوديو التصميم')
  await page.getByRole('button', { name: AR.next }).click()
  await answer(page, AR, [
    ['ما طبيعة عملك؟', ['أقدّم خدمات']],
    ['أين مكان عملك في الغالب؟', ['من المنزل']],
    ['هل يعمل معك أحد؟', ['لا، أنا فقط']],
    ['ما الذي ينطبق على عملك؟', ['لا شيء مما سبق']],
    ['كيف يطلب منك العملاء ويدفعون؟', ['أرسل عرض سعر مكتوبًا قبل أن أبدأ']],
    ['هل عملك مسجّل في ضريبة القيمة المضافة؟', ['نعم، مسجّل']],
  ])
  await onQuestion(page, 'إليك BizCost المناسب لعملك')
  await page.getByRole('button', { name: AR.confirm }).click()
  await page.getByRole('link', { name: AR.go }).click()
  await expect(page).toHaveURL(BUSINESS_PATH)
  const second = businessIdOf(page)
  expect(second).not.toBe(first)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('استوديو التصميم')
  await expect(
    // In "About your business" (the checklist's TRN step says the same).
    page
      .locator('[data-statement="vat_registered"]')
      .filter({ hasText: 'عملك مسجّل في ضريبة القيمة المضافة' }),
  ).toBeVisible()
  expect(await savedSetup(second)).toMatchObject({
    businessType: 'services',
    vatRegistered: true,
    enabledModules: ['invoices', 'quotations', 'vat_center'],
  })

  // Switch back to the first business; home remembers it.
  await page.getByRole('button', { name: /^تبديل العمل التجاري: / }).click()
  const items = page.getByRole('menuitemradio')
  await expect(items).toHaveCount(2)
  await expect(page.getByRole('menuitemradio', { name: /استوديو التصميم/ })).toHaveAttribute(
    'aria-checked',
    'true',
  )
  const remembered = page.waitForResponse(
    (r) => r.url().includes('account.setLastBusiness') && r.ok(),
  )
  await page.getByRole('menuitemradio', { name: /حلويات سارة/ }).click()
  await expect(page).toHaveURL(`/b/${first}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('حلويات سارة')
  await expect(page.getByRole('listitem').filter({ hasText: 'أنت فقط، بدون فريق' })).toBeVisible()
  await remembered
  await page.goto('/')
  await expect(page).toHaveURL(`/b/${first}`)
})

test('a business the user is not a member of is not open; a malformed link is not found', async ({
  page,
  context,
}) => {
  const user = await createUser('outsider')
  users.push(user.id)
  await useLanguage(context, 'en')
  await signIn(page, user)
  await page.goto('/b/0199a000-0000-7000-8000-000000000000')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    "This business isn't open to you",
  )
  await page.goto('/b/not-a-uuid')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Page not found')
})

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import {
  callApi,
  createUser,
  deleteUser,
  pngPicture,
  RAW_KEY,
  setLanguage,
  signIn,
  useLanguage,
  WORKSHOP_ANSWERS,
  type TestUser,
} from '../helpers'
import { baseURL } from '../stack'

// Quotations, Settings → Documents and the business's letterhead (ROADMAP.md M3 Step 7; Q21–Q25; the
// owner's document requests of 2026-10-16), on the production build since Release B (M3 Step 9):
//
//   - The fit-out company in Arabic on a phone (the plan's definition of done): a customer added on
//     the spot; two areas added as sections (D-299) and three lines in them (a wall cladding typed
//     with its details and a tall picture, a TV unit with a red note, a wardrobe picked from its work
//     items as it is typed, with a panorama picture adjusted in its frame), the TV unit moved to the
//     bedroom and up, the bedroom moved up and back, each area with its count, the focus in sight
//     after each move (never under the save bar); both pictures saved and printed at the frame's
//     800 × 600; the same editor on a desktop; the total rounded to 15,000.00 (the change before VAT
//     shown); payment stages 50/35/15 (7,500.00, 5,250.00, 2,250.00); saved, sent (the PDF
//     downloaded), revised (revision 2: a saved picture's «ضبط» says it is the framed one, the TV unit
//     moved into a new area that held only its empty line, the area renamed, the focus back on the
//     button each dialog was opened from; changed and sent again) and accepted with the signed PDF
//     attached; its history.
//   - A workshop in English on a desktop: a line picked from Products & Services, a typed one saved
//     as a work item, a 5% discount on the whole quotation, payment stages 40/60, sent and downloaded,
//     accepted, made into an order; copied for another customer and the copy discarded; the list's
//     status filter and search kept in the address.
//   - Settings → Documents, the business profile's contact lines and the checklist's "Add your
//     business address": the letterhead preview without a logo, then the accent colour, the watermark,
//     the signatory, the signature and the stamp, then with a logo; in Arabic on a phone too.
// With E2E_SHOTS_DIR set, each step leaves a screenshot there; with E2E_PDF_DIR, the PDFs downloaded.

test.describe.configure({ mode: 'serial' })

const PHONE = { width: 390, height: 844 }
const SMALL_PHONE = { width: 375, height: 812 }
const DESKTOP = { width: 1440, height: 900 }

const users: TestUser[] = []
const contexts: BrowserContext[] = []

test.afterAll(async () => {
  for (const context of contexts) await context.close()
  for (const user of users) await deleteUser(user.id)
})

async function open(
  browser: Browser,
  viewport: { width: number; height: number },
  locale: 'en' | 'ar',
  displayName: string,
): Promise<Page> {
  const user = await createUser(`quotes-${locale}`, { locale: 'en' })
  users.push(user)
  const context = await browser.newContext({
    baseURL,
    locale: locale === 'ar' ? 'ar-AE' : 'en-US',
    viewport,
    acceptDownloads: true,
  })
  contexts.push(context)
  await useLanguage(context, 'en')
  const page = await context.newPage()
  await signIn(page, user)
  expect((await callApi(page, 'account.updateProfile', { displayName })).appCode).toBeUndefined()
  if (locale === 'ar') await setLanguage(page, 'ar')
  return page
}

async function ok<T>(pending: Promise<{ data?: T; appCode?: string }>, what: string): Promise<T> {
  const result = await pending
  expect(result.appCode, what).toBeUndefined()
  return result.data as T
}

/**
 * Screenshots into E2E_SHOTS_DIR (only when it is set): the screen as it is, and for a long page
 * the screen scrolled to its end too (the shell's bars are fixed, so a full-page image misplaces them).
 */
async function shot(page: Page, name: string) {
  const dir = process.env.E2E_SHOTS_DIR
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(dir, `${name}.png`) })
  const long = await page.evaluate(
    () => document.documentElement.scrollHeight > window.innerHeight + 40,
  )
  const dialog = await page.getByRole('dialog').or(page.getByRole('alertdialog')).count()
  if (long && dialog === 0) {
    const y = await page.evaluate(() => window.scrollY)
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    await page.waitForTimeout(200)
    await page.screenshot({ path: join(dir, `${name}-end.png`) })
    // The whole page in one picture, for a review of a long form.
    await page.screenshot({ path: join(dir, `${name}-full.png`), fullPage: true })
    await page.evaluate((top) => window.scrollTo(0, top), y)
  }
}

/**
 * The focused control is on the screen, clear of the top bar (4rem) and, on a phone, of the editor's
 * save bar at the foot (WCAG 2.4.11): where a line moved down, or into another area, lands.
 */
async function expectFocusInSight(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const focused = document.activeElement
        if (!focused || focused === document.body) return 'nothing focused'
        const box = focused.getBoundingClientRect()
        const bar = document.querySelector<HTMLElement>('[data-phone-save-bar]')
        const barTop =
          bar && bar.offsetParent !== null ? bar.getBoundingClientRect().top : window.innerHeight
        return box.top >= 64 && box.bottom <= barTop
          ? 'in sight'
          : `${Math.round(box.top)}–${Math.round(box.bottom)} under the bars (${Math.round(barTop)})`
      }),
    )
    .toBe('in sight')
}

/** The page is in `locale`, fits its width and shows no untranslated key. */
async function expectSound(page: Page, locale: 'en' | 'ar') {
  await expect(page.locator('html')).toHaveAttribute('lang', locale)
  await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr')
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
  expect(await page.locator('body').innerText()).not.toMatch(RAW_KEY)
  expect(await page.title()).not.toMatch(RAW_KEY)
}

/** An amount as the page writes it: "AED 6.00" in English; in Arabic, its number and «د.إ.». */
function money(locale: 'en' | 'ar', value: string): RegExp {
  const number = value.replace(/[.]/g, '\\.')
  return locale === 'ar'
    ? new RegExp(`${number}[\\s\\u200e\\u200f]*د\\.إ\\.`)
    : new RegExp(`AED\\s${number}`)
}

/** A number as a sentence holds it: isolated, so it reads "Q-0001" in Arabic too. */
const n = (number: string) => `⁨${number}⁩`

/** Creates a business through Smart Setup's confirm step in `locale`. */
async function createBusinessIn(
  page: Page,
  legalName: string,
  answers: Record<string, unknown>,
  locale: 'en' | 'ar',
): Promise<string> {
  const result = await ok(
    callApi<{ businessId: string }>(page, 'business.createFromSetup', {
      businessId: randomUUID(),
      legalName,
      locale,
      questionSetVersion: 1,
      answers,
      adjustments: { modules: [], capabilities: [] },
    }),
    'business.createFromSetup',
  )
  return result.businessId
}

/** A fit-out / decor project company with a team and VAT (Quotations on). */
const FITOUT_ANSWERS = {
  what_you_do: ['projects'],
  workplace: 'customer_sites',
  branches: false,
  team: 'team',
  team_tracking: ['hours'],
  work_setup: ['materials'],
  vat: 'yes',
}

async function profileOf(page: Page, businessId: string) {
  return ok(
    callApi<{
      version: number
      legalName: string
      legalNameAr: string | null
      vatRegistered: boolean
      trn: string | null
    }>(page, 'business.profile', {}, { businessId, query: true }),
    'business.profile',
  )
}

/** The business's names, TRN and (optionally) its contact lines, as Settings saves them. */
async function setProfile(
  page: Page,
  businessId: string,
  fields: {
    legalName: string
    legalNameAr: string
    trn: string
    letterhead?: Record<string, string | null>
  },
) {
  const profile = await profileOf(page, businessId)
  await ok(
    callApi(
      page,
      'business.updateProfile',
      {
        version: profile.version,
        legalName: fields.legalName,
        legalNameAr: fields.legalNameAr,
        vatRegistered: true,
        trn: fields.trn,
        ...(fields.letterhead ? { letterhead: fields.letterhead } : {}),
      },
      { businessId },
    ),
    'business.updateProfile',
  )
}

/** Uploads `png` as the business's logo, as Settings does (a signed upload, then setLogo). */
async function uploadLogo(page: Page, businessId: string, png: Buffer) {
  const target = await ok(
    callApi<{ uploadUrl: string; path: string }>(
      page,
      'business.logoUploadUrl',
      { contentType: 'image/png' },
      { businessId },
    ),
    'business.logoUploadUrl',
  )
  const status = await page.evaluate(
    async ({ url, bytes }) =>
      (
        await fetch(url, {
          method: 'PUT',
          headers: { 'content-type': 'image/png', 'x-upsert': 'false' },
          body: new Uint8Array(bytes),
        })
      ).status,
    { url: target.uploadUrl, bytes: [...png] },
  )
  expect(status).toBeLessThan(300)
  await ok(callApi(page, 'business.setLogo', { path: target.path }, { businessId }), 'setLogo')
}

async function product(
  page: Page,
  businessId: string,
  fields: { name: string; price: string; unit: string },
): Promise<string> {
  const id = randomUUID()
  await ok(
    callApi(
      page,
      'product.create',
      { id, name: fields.name, type: 'product', unit: fields.unit, defaultPrice: fields.price },
      { businessId },
    ),
    `product.create ${fields.name}`,
  )
  return id
}

/** A logo for a fictional business: a dark arch on white (generated, as the demo's). */
function archLogo(): Buffer {
  return pngPicture(240, 240, (x, y) => {
    const dx = Math.abs(x - 120)
    const top = y < 120 && Math.hypot(x - 120, y - 120) > 70 && Math.hypot(x - 120, y - 120) < 92
    const sides = y >= 120 && y < 200 && dx > 70 && dx < 92
    const base = y >= 200 && y < 212 && dx < 100
    return top || sides || base ? [23, 37, 84, 255] : [255, 255, 255, 255]
  })
}

/** A tall (portrait) picture of a door: 300 × 800 (D-299: framed like every picture). */
function tallPicture(): Buffer {
  return pngPicture(300, 800, (x, y) =>
    x > 60 && x < 240 && y > 80 && y < 760
      ? [176, 141, 87, 255]
      : y > 700
        ? [205, 190, 170, 255]
        : [236, 228, 216, 255],
  )
}

/** A panorama of a wall: 1200 × 300. */
function widePicture(): Buffer {
  return pngPicture(1200, 300, (x, y) =>
    y > 230
      ? [190, 176, 150, 255]
      : x % 200 < 180 && y > 40
        ? [240, 238, 232, 255]
        : [90, 107, 90, 255],
  )
}

/** A signature: a dark stroke on a clear background. */
function signaturePng(): Buffer {
  return pngPicture(300, 100, (x, y) => {
    const curve = 50 + Math.round(22 * Math.sin(x / 18) * (1 - x / 400))
    return Math.abs(y - curve) < 3 ? [30, 41, 120, 255] : [255, 255, 255, 0]
  })
}

/** A round stamp: a blue ring. */
function stampPng(): Buffer {
  return pngPicture(160, 160, (x, y) => {
    const r = Math.hypot(x - 80, y - 80)
    return (r > 62 && r < 72) || (r > 48 && r < 52) ? [37, 66, 160, 255] : [255, 255, 255, 0]
  })
}

/** Saves a downloaded PDF into E2E_PDF_DIR (when set); returns its bytes. */
async function savePdf(page: Page, trigger: () => Promise<void>, name: string): Promise<Buffer> {
  const pending = page.waitForEvent('download')
  await trigger()
  const download = await pending
  const path = await download.path()
  const bytes = readFileSync(path)
  expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  const dir = process.env.E2E_PDF_DIR
  if (dir) {
    mkdirSync(dir, { recursive: true })
    await download.saveAs(join(dir, `${name}.pdf`))
  }
  return bytes
}

test('the fit-out quotation in Arabic on a phone: areas, a picture, rounded to 15,000.00, stages, sent, revised, accepted', async ({
  browser,
}) => {
  test.setTimeout(900_000)
  const page = await open(browser, PHONE, 'ar', 'عبدالله')
  const businessId = await createBusinessIn(page, 'Modern Touch Interiors', FITOUT_ANSWERS, 'ar')
  await setProfile(page, businessId, {
    legalName: 'Modern Touch Interiors',
    legalNameAr: 'لمسة عصرية للديكور',
    trn: '100345678900003',
    letterhead: {
      phone: '+971 4 555 0142',
      phone2: '+971 50 555 0199',
      email: 'hello@moderntouch.example',
      addressLine: 'Warehouse 7, Al Quoz Industrial 3',
      city: null,
      emirate: 'dubai',
      tradeLicenceNo: 'DED-884210',
      tradeLicenceAuthority: null,
    },
  })
  await uploadLogo(page, businessId, archLogo())
  await product(page, businessId, { name: 'خزانة ملابس بأبواب منزلقة', price: '980', unit: 'm2' })

  // Quotations: nothing yet.
  await page.goto(`/b/${businessId}/quotations`)
  await expect(page.getByRole('heading', { level: 1, name: 'عروض الأسعار' })).toBeVisible()
  await expect(page.getByText('لا عروض أسعار بعد')).toBeVisible()
  await expectSound(page, 'ar')
  await shot(page, 'quotations-ar-390-empty')
  await page.getByRole('link', { name: 'عرض سعر جديد' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'عرض سعر جديد' })).toBeVisible()
  await expectSound(page, 'ar')
  await shot(page, 'quotations-ar-390-new')

  // The customer, added on the spot; the project.
  await page.getByRole('combobox', { name: 'العميل' }).fill('يوسف الحمادي')
  await page.getByRole('option', { name: 'أضف «يوسف الحمادي» كعميل جديد' }).click()
  const sheet = page.getByRole('dialog', { name: 'عميل جديد' })
  await sheet.getByRole('textbox', { name: 'الهاتف' }).fill('055 555 0123')
  await sheet.getByRole('button', { name: 'أضف', exact: true }).click()
  await expect(sheet).toBeHidden()
  await page.getByRole('textbox', { name: 'المشروع أو الموقع' }).fill('فيلا 18، البرشاء')

  // The majlis, an area of its own (D-299): the new quotation's empty line goes into it.
  const lines = page.locator('[data-quotation-line]')
  const sections = page.locator('[data-area-section]')
  await page.getByRole('button', { name: 'أضف مكانًا أو غرفة' }).click()
  const areaDialog = page.getByRole('dialog', { name: 'مكان أو غرفة جديدة' })
  await areaDialog.getByRole('button', { name: 'أضف', exact: true }).click()
  await expect(areaDialog).toContainText('اكتب اسم المكان.')
  await areaDialog.getByRole('textbox', { name: 'المكان أو الغرفة' }).fill('المجلس')
  await areaDialog.getByRole('button', { name: 'أضف', exact: true }).click()
  await expect(areaDialog).toBeHidden()
  await expect(sections).toHaveCount(1)
  await expect(sections.nth(0).locator('[data-area-name]')).toHaveText('المجلس')
  await expect(sections.nth(0).locator('[data-area-count]')).toHaveText('بند واحد')
  await expect(lines).toHaveCount(1)

  // Line 1, the majlis: a wall cladding typed with its details and a tall (portrait) picture.
  const first = lines.nth(0)
  await expect(first.getByRole('combobox', { name: 'المكان أو الغرفة' })).toHaveValue('المجلس')
  await first.getByRole('combobox', { name: 'البند' }).fill('تكسية جدار بباب مخفي')
  await first
    .getByRole('textbox', { name: 'التفاصيل' })
    .fill('الخامة: MDF بقشرة بلوط\nباب مخفي 90 × 240 سم')
  await first.getByRole('textbox', { name: 'الكمية' }).fill('9.5')
  await first.getByRole('combobox', { name: 'الوحدة' }).selectOption('m2')
  await first.getByRole('textbox', { name: 'السعر قبل الضريبة' }).fill('650')
  await first.locator('[data-line-picture-input]').setInputFiles({
    name: 'majlis-door.png',
    mimeType: 'image/png',
    buffer: tallPicture(),
  })
  await expect(first.locator('[data-line-picture]')).toBeVisible()
  await expect(first.locator('[data-line-total]')).toContainText(money('ar', '6,175.00'))

  // Line 2, added inside the majlis: a TV unit with a note in red.
  await sections.nth(0).getByRole('button', { name: 'أضف بندًا إلى ⁨المجلس⁩' }).click()
  await expect(lines).toHaveCount(2)
  await expect(sections.nth(0).locator('[data-area-count]')).toHaveText('بندان')
  const second = lines.nth(1)
  await expect(second.getByRole('combobox', { name: 'المكان أو الغرفة' })).toHaveValue('المجلس')
  await second.getByRole('combobox', { name: 'البند' }).fill('وحدة تلفزيون')
  await second.getByRole('textbox', { name: 'الكمية' }).fill('1')
  await second.getByRole('combobox', { name: 'الوحدة' }).selectOption('piece')
  await second.getByRole('textbox', { name: 'السعر قبل الضريبة' }).fill('4800')
  await second.getByRole('button', { name: 'أضف ملاحظة' }).click()
  await second
    .getByRole('textbox', { name: 'ملاحظة بالأحمر' })
    .fill('* يُضاف سعر الرخام بعد اختياره')

  // Line 3, the bedroom (a second area): a wardrobe picked from the work items as it is typed, with
  // a panorama picture.
  await page.getByRole('button', { name: 'أضف مكانًا أو غرفة' }).click()
  await areaDialog.getByRole('textbox', { name: 'المكان أو الغرفة' }).fill('المجلس')
  await expect(areaDialog).toContainText('يوجد مكان بهذا الاسم.')
  await areaDialog.getByRole('textbox', { name: 'المكان أو الغرفة' }).fill('غرفة النوم')
  await areaDialog.getByRole('button', { name: 'أضف', exact: true }).click()
  await expect(sections).toHaveCount(2)
  await expect(lines).toHaveCount(3)
  const third = lines.nth(2)
  await expect(third.getByRole('combobox', { name: 'المكان أو الغرفة' })).toHaveValue('غرفة النوم')
  await third.getByRole('combobox', { name: 'البند' }).fill('خزانة')
  await page.getByRole('option', { name: /خزانة ملابس بأبواب منزلقة/ }).click()
  await expect(third.locator('[data-line-product]')).toHaveText('من خدماتك وبنود عملك')
  await expect(third.getByRole('textbox', { name: 'السعر قبل الضريبة' })).toHaveValue('980')
  await third.getByRole('textbox', { name: 'الكمية' }).fill('3.5')
  await third.locator('[data-line-picture-input]').setInputFiles({
    name: 'bedroom-wall.png',
    mimeType: 'image/png',
    buffer: widePicture(),
  })
  await expect(third.locator('[data-line-picture]')).toBeVisible()

  // Both pictures framed as the PDF prints them, whatever their shape: 800 × 600, shown in one
  // 4:3 frame.
  for (const line of [first, third]) {
    const picture = line.locator('[data-line-picture]')
    await expect
      .poll(() =>
        picture.evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight]),
      )
      .toEqual([800, 600])
  }
  const tallBox = await first.locator('[data-line-picture]').boundingBox()
  const wideBox = await third.locator('[data-line-picture]').boundingBox()
  expect(tallBox && wideBox && [tallBox.width, tallBox.height]).toEqual([
    wideBox?.width,
    wideBox?.height,
  ])

  // Adjust the panorama: moved and zoomed in its frame, then used.
  const before = await third.locator('[data-line-picture]').getAttribute('src')
  await third.getByRole('button', { name: 'اضبط صورة البند 3' }).click()
  const cropper = page.locator('[data-picture-cropper]')
  await expect(cropper.locator('[data-picture-crop]')).toBeVisible()
  await expect(cropper.getByRole('button', { name: 'ابدأ من جديد' })).toBeVisible()
  await cropper.getByRole('button', { name: 'تكبير' }).click()
  await cropper.locator('[data-picture-crop]').focus()
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await expectSound(page, 'ar')
  await shot(page, 'quotations-ar-390-adjust')
  await cropper.getByRole('button', { name: 'استخدم هذا' }).click()
  await expect(cropper).toBeHidden()
  await expect(third.locator('[data-line-picture]')).not.toHaveAttribute('src', before ?? '')
  await expect
    .poll(() =>
      third
        .locator('[data-line-picture]')
        .evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight]),
    )
    .toEqual([800, 600])

  // The TV unit moved to the bedroom, then up above the wardrobe; the bedroom moved up and back.
  await second.getByRole('combobox', { name: 'المكان أو الغرفة' }).selectOption('غرفة النوم')
  await expect(sections.nth(0).locator('[data-area-count]')).toHaveText('بند واحد')
  await expect(sections.nth(1).locator('[data-area-count]')).toHaveText('بندان')
  await expect(lines.nth(2).getByRole('combobox', { name: 'المكان أو الغرفة' })).toBeFocused()
  await expectFocusInSight(page)
  await expect(lines.nth(2).getByRole('combobox', { name: 'البند' })).toHaveValue('وحدة تلفزيون')
  await page.getByRole('button', { name: 'انقل البند 3 إلى الأعلى' }).click()
  await expect(lines.nth(1).getByRole('combobox', { name: 'البند' })).toHaveValue('وحدة تلفزيون')
  await expect(page.getByRole('button', { name: 'انقل البند 2 إلى الأعلى' })).toBeDisabled()
  await page.getByRole('button', { name: 'انقل ⁨غرفة النوم⁩ إلى الأعلى' }).click()
  await expect(sections.locator('[data-area-name]')).toHaveText(['غرفة النوم', 'المجلس'])
  await page.getByRole('button', { name: 'انقل ⁨غرفة النوم⁩ إلى الأسفل' }).click()
  await expect(sections.locator('[data-area-name]')).toHaveText(['المجلس', 'غرفة النوم'])
  await expect(lines.nth(1).getByRole('combobox', { name: 'البند' })).toHaveValue('وحدة تلفزيون')
  // Moved down on a phone: the focus stays on the line's buttons, in sight above the save bar.
  await page.getByRole('button', { name: 'انقل البند 2 إلى الأسفل' }).click()
  await expect(lines.nth(2).getByRole('combobox', { name: 'البند' })).toHaveValue('وحدة تلفزيون')
  await expect(page.getByRole('button', { name: 'انقل البند 3 إلى الأعلى' })).toBeFocused()
  await expectFocusInSight(page)
  await page.keyboard.press('Enter')
  await expect(lines.nth(1).getByRole('combobox', { name: 'البند' })).toHaveValue('وحدة تلفزيون')
  await expectFocusInSight(page)
  await expectSound(page, 'ar')
  await shot(page, 'quotations-ar-390-lines')
  // The same editor on a desktop.
  await page.setViewportSize(DESKTOP)
  await page.locator('[data-area-section]').first().scrollIntoViewIfNeeded()
  await expectSound(page, 'ar')
  await shot(page, 'quotations-ar-1440-areas')
  await page.setViewportSize(PHONE)

  // "Round the total": 15,000.00 with VAT, the change before VAT shown.
  await page.getByRole('textbox', { name: 'تقريب الإجمالي' }).fill('15000')
  await expect(page.locator('[data-rounding]').first()).toContainText(
    'تعديل لتقريب الإجمالي قبل الضريبة',
  )
  await expect(page.locator('[data-rounding]').first()).toContainText(money('ar', '-119.29'))
  await expect(page.locator('[data-running-total]:visible')).toHaveText(money('ar', '15,000.00'))

  // Payment terms 50/35/15.
  await page.getByRole('button', { name: 'استخدم 50% / 35% / 15%' }).click()
  const stages = page.locator('[data-stage]')
  await expect(stages).toHaveCount(3)
  await expect(stages.nth(0).locator('[data-stage-amount]')).toHaveText(money('ar', '7,500.00'))
  await expect(stages.nth(1).locator('[data-stage-amount]')).toHaveText(money('ar', '5,250.00'))
  await expect(stages.nth(2).locator('[data-stage-amount]')).toHaveText(money('ar', '2,250.00'))
  await expectSound(page, 'ar')
  await shot(page, 'quotations-ar-390-totals')

  // Saved as a draft: Q-0001, the picture uploaded with it.
  await page.getByRole('button', { name: 'احفظ المسودة' }).click()
  await expect(page.getByText(`تم حفظ عرض السعر ${n('Q-0001')} مسودةً.`)).toBeVisible()
  await expect(page.getByRole('heading', { level: 1, name: /عرض السعر/ })).toBeVisible()
  await expect(page.locator('[data-quotation-status="draft"]').first()).toBeVisible()
  await expect(page.locator('[data-area]')).toHaveText(['المجلس', 'غرفة النوم'])
  await expect(page.locator('[data-area-count]')).toHaveText(['بند واحد', 'بندان'])
  // The portrait and the panorama, both saved in the PDF's frame (800 × 600).
  await expect(page.locator('[data-line-picture]')).toHaveCount(2)
  for (const picture of await page.locator('[data-line-picture]').all()) {
    await expect
      .poll(() =>
        picture.evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight]),
      )
      .toEqual([800, 600])
  }
  await expectSound(page, 'ar')
  await shot(page, 'quotations-ar-390-draft')

  // Sent: frozen, then the PDF downloaded.
  await page.getByRole('button', { name: 'إرسال', exact: true }).click()
  const send = page.getByRole('alertdialog')
  await expect(send).toContainText('بعد الإرسال لا يمكن تعديل هذه النسخة')
  await shot(page, 'quotations-ar-390-send')
  await send.getByRole('button', { name: 'إرسال', exact: true }).click()
  const pdfDialog = page.getByRole('dialog')
  await expect(pdfDialog).toContainText('ملف PDF جاهز.', { timeout: 60_000 })
  await shot(page, 'quotations-ar-390-pdf')
  const sentPdf = await savePdf(
    page,
    () => pdfDialog.getByRole('button', { name: 'تنزيل PDF' }).click(),
    'fitout-ar-rev1',
  )
  // Both pictures printed at the frame's shape: two 800 × 600 images (the PDF's frame is 4:3, so
  // neither is cut further; frames.test.ts measures the frame).
  const pdfText = sentPdf.toString('latin1')
  expect(pdfText.match(/\/Width 800\b/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
  expect(pdfText.match(/\/Height 600\b/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-quotation-status="sent"]').first()).toBeVisible()

  // Revised: revision 2, a draft to change, then sent again.
  await page.getByRole('button', { name: 'نسخة معدّلة' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'إنشاء النسخة' }).click()
  await expect(
    page.getByRole('heading', { level: 1, name: /تعديل عرض السعر .*النسخة 2/ }),
  ).toBeVisible()
  await expect(lines).toHaveCount(3)
  await lines.nth(1).getByRole('textbox', { name: 'السعر قبل الضريبة' }).fill('5200')
  // The rounded total stays 15,000.00: the rounding adjustment takes the new price, and the editor
  // says so (D-297).
  await expect(page.locator('[data-running-total]:visible')).toHaveText(money('ar', '15,000.00'))
  await expect(page.locator('[data-rounding-stale]')).toContainText('يبقى الإجمالي مقرّبًا إلى')
  await expect(page.locator('[data-rounding-stale]')).toContainText('في النسخة السابقة')
  await expect(page.locator('[data-rounding-stale-hint]:visible')).toBeVisible()
  await shot(page, 'quotations-ar-390-revise')

  // A saved picture is the framed one: «ضبط» says so and offers to pick it again; closed, the focus
  // is back on its button.
  const adjustSaved = lines.nth(0).getByRole('button', { name: 'اضبط صورة البند 1' })
  await adjustSaved.click()
  const savedCropper = page.locator('[data-picture-cropper]')
  await expect(savedCropper).toContainText('هذه الصورة محفوظة بإطارها')
  await expect(savedCropper.getByRole('button', { name: 'اختر الصورة من جديد' })).toBeVisible()
  await expectSound(page, 'ar')
  await shot(page, 'quotations-ar-390-adjust-saved')
  await page.keyboard.press('Escape')
  await expect(savedCropper).toBeHidden()
  await expect(adjustSaved).toBeFocused()

  // The TV unit into a new area, the living room: the area's empty first line gives it its place,
  // so the living room holds one line (D-299).
  await page.getByRole('button', { name: 'أضف مكانًا أو غرفة' }).click()
  await areaDialog.getByRole('textbox', { name: 'المكان أو الغرفة' }).fill('الصالة')
  await areaDialog.getByRole('button', { name: 'أضف', exact: true }).click()
  await expect(lines).toHaveCount(4)
  await lines.nth(1).getByRole('combobox', { name: 'المكان أو الغرفة' }).selectOption('الصالة')
  await expect(lines).toHaveCount(3)
  await expect(sections.locator('[data-area-name]')).toHaveText(['المجلس', 'غرفة النوم', 'الصالة'])
  await expect(sections.locator('[data-area-count]')).toHaveText([
    'بند واحد',
    'بند واحد',
    'بند واحد',
  ])
  await expect(lines.nth(2).getByRole('combobox', { name: 'البند' })).toHaveValue('وحدة تلفزيون')
  await expectFocusInSight(page)
  // Renamed, the focus on its button again; the dialog closed without a name gives it back too.
  const renameLiving = page.getByRole('button', { name: 'غيّر اسم ⁨الصالة⁩' })
  await renameLiving.click()
  const renameDialog = page.getByRole('dialog', { name: 'غيّر اسم المكان' })
  await expect(renameDialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(renameDialog).toBeHidden()
  await expect(renameLiving).toBeFocused()
  await renameLiving.click()
  await renameDialog.getByRole('textbox', { name: 'المكان أو الغرفة' }).fill('الصالة الرئيسية')
  await renameDialog.getByRole('button', { name: 'احفظ', exact: true }).click()
  await expect(renameDialog).toBeHidden()
  await expect(page.getByRole('button', { name: 'غيّر اسم ⁨الصالة الرئيسية⁩' })).toBeFocused()
  await page.getByRole('button', { name: 'احفظ التغييرات' }).click()
  await expect(page.getByText('تم حفظ عرض السعر.')).toBeVisible()
  await page.getByRole('button', { name: 'إرسال', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'إرسال', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('ملف PDF جاهز.', { timeout: 60_000 })
  const signed = await savePdf(
    page,
    () => page.getByRole('dialog').getByRole('button', { name: 'تنزيل PDF' }).click(),
    'fitout-ar-rev2',
  )
  await page.keyboard.press('Escape')

  // Accepted, with the signed copy attached.
  await page.getByRole('button', { name: 'تسجيل القبول' }).click()
  const accept = page.getByRole('alertdialog')
  await accept.locator('[data-signed-input]').setInputFiles({
    name: 'Q-0001-signed.pdf',
    mimeType: 'application/pdf',
    buffer: signed,
  })
  await expect(accept.locator('[data-signed-name]')).toHaveText('Q-0001-signed.pdf')
  await shot(page, 'quotations-ar-390-accept')
  await accept.getByRole('button', { name: 'تسجيل القبول' }).click()
  await expect(page.getByText(`تم تسجيل قبول عرض السعر ${n('Q-0001')}.`)).toBeVisible()
  await expect(page.locator('[data-quotation-status="accepted"]').first()).toBeVisible()
  await expect(page.getByRole('link', { name: 'Q-0001-signed.pdf' })).toBeVisible()
  // Its history: created, sent, revised, sent, superseded, accepted.
  await expect(page.locator('[data-history-event="accepted"]')).toBeVisible()
  await expect(page.locator('[data-history-event="sent"]')).toHaveCount(2)
  await expectSound(page, 'ar')
  await shot(page, 'quotations-ar-390-accepted')

  // Copied to a new quotation: its total came rounded from the quotation it was copied from, and the
  // editor says so, never "the revision before" (D-297).
  await page.getByRole('button', { name: 'نسخ إلى عرض سعر جديد' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'نسخ', exact: true }).click()
  await expect(page.getByText(`تم إنشاء عرض السعر ${n('Q-0002')} نسخةً.`)).toBeVisible()
  const carried = page.locator('[data-rounding-stale]')
  await expect(carried).toContainText('في عرض السعر الذي نُسخ منه')
  await expect(carried).not.toContainText('النسخة السابقة')
  await shot(page, 'quotations-ar-390-copy-rounded')

  // The list: the accepted quotation, revision 2 (and its copy, a draft).
  await page.goto(`/b/${businessId}/quotations`)
  await expect(page.locator('[data-quotation-row="accepted"]')).toHaveCount(1)
  await expect(page.locator('[data-quotation-row="accepted"]')).toContainText('النسخة 2')
  await expect(page.locator('[data-quotation-row="accepted"]')).toContainText(
    money('ar', '15,000.00'),
  )
  await expectSound(page, 'ar')
  await shot(page, 'quotations-ar-390-list')
})

test('a workshop quotation in English on a desktop: a work item saved, a discount, stages, accepted, an order, a copy', async ({
  browser,
}) => {
  test.setTimeout(900_000)
  const page = await open(browser, DESKTOP, 'en', 'Hamad')
  const businessId = await createBusinessIn(page, 'Al Itqan Carpentry', WORKSHOP_ANSWERS, 'en')
  await setProfile(page, businessId, {
    legalName: 'Al Itqan Carpentry',
    legalNameAr: 'نجارة الإتقان',
    trn: '100678901200003',
    letterhead: {
      phone: '+971 6 555 0177',
      phone2: null,
      email: 'orders@alitqan.example',
      addressLine: 'Industrial Area 2',
      city: null,
      emirate: 'sharjah',
      tradeLicenceNo: null,
      tradeLicenceAuthority: null,
    },
  })
  await product(page, businessId, { name: 'Dining table, solid oak', price: '6500', unit: 'piece' })
  for (const name of ['Sara Haddad', 'Omar Khalil']) {
    await ok(
      callApi(page, 'customer.create', { id: randomUUID(), name }, { businessId }),
      'customer.create',
    )
  }

  await page.goto(`/b/${businessId}/quotations/new`)
  await expect(page.getByRole('heading', { level: 1, name: 'New quotation' })).toBeVisible()
  await page.getByRole('combobox', { name: 'Customer' }).fill('Sara')
  await page.getByRole('option', { name: /Sara Haddad/ }).click()
  const lines = page.locator('[data-quotation-line]')
  await lines.nth(0).getByRole('combobox', { name: 'Item' }).fill('dining')
  await page.getByRole('option', { name: /Dining table, solid oak/ }).click()
  await lines
    .nth(0)
    .getByRole('textbox', { name: 'Details' })
    .fill('220 × 100 cm\nFinish: natural oil')

  // A typed line, saved as a work item for next time.
  await page.getByRole('button', { name: 'Add a line' }).click()
  await lines.nth(1).getByRole('combobox', { name: 'Item' }).fill('Dining chairs, upholstered')
  await lines.nth(1).getByRole('textbox', { name: 'Quantity' }).fill('6')
  await lines.nth(1).getByRole('combobox', { name: 'Unit' }).selectOption('piece')
  await lines.nth(1).getByRole('textbox', { name: 'Price before VAT' }).fill('500')
  await lines.nth(1).getByRole('button', { name: 'Save as a product or service' }).click()
  const productSheet = page.getByRole('dialog')
  await expect(productSheet.getByRole('textbox', { name: 'Name' })).toHaveValue(
    'Dining chairs, upholstered',
  )
  await productSheet
    .getByRole('button', { name: /^(Add|Save)/ })
    .last()
    .click()
  await expect(productSheet).toBeHidden()
  await expect(lines.nth(1).locator('[data-line-product]')).toBeVisible()

  // 5% off the whole quotation; payment terms 40 / 60.
  await page.getByRole('button', { name: 'Add a discount on the whole quotation' }).click()
  await page.getByRole('textbox', { name: 'Discount on the whole quotation' }).fill('5')
  await page.getByRole('button', { name: 'Add a payment' }).click()
  await page.getByRole('button', { name: 'Add a payment' }).click()
  const stages = page.locator('[data-stage]')
  await stages.nth(0).getByRole('textbox', { name: 'When' }).fill('With the order')
  await stages.nth(0).getByRole('textbox', { name: 'Share' }).fill('40')
  await stages.nth(1).getByRole('textbox', { name: 'When' }).fill('On delivery')
  await stages.nth(1).getByRole('textbox', { name: 'Share' }).fill('60')
  // 9,500 − 475 = 9,025 before VAT; 451.25 VAT: 9,476.25.
  await expect(page.locator('[data-running-total]:visible')).toHaveText(money('en', '9,476.25'))
  await expect(stages.nth(0).locator('[data-stage-amount]')).toHaveText(money('en', '3,790.50'))
  await expect(stages.nth(1).locator('[data-stage-amount]')).toHaveText(money('en', '5,685.75'))
  await expectSound(page, 'en')
  await shot(page, 'quotations-en-1440-editor')

  await page.getByRole('button', { name: 'Save draft' }).click()
  await expect(page.getByText(`Quotation ${n('Q-0001')} saved as a draft.`)).toBeVisible()
  await expectSound(page, 'en')
  await shot(page, 'quotations-en-1440-draft')

  // The preview, then sent and downloaded.
  await page.getByRole('button', { name: 'Preview PDF' }).click()
  await expect(page.getByRole('dialog')).toContainText('Download PDF')
  await expect(page.locator('[data-pdf-preview]')).toBeVisible({ timeout: 60_000 })
  await shot(page, 'quotations-en-1440-preview')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.locator('[data-pdf-preview]')).toBeVisible({ timeout: 60_000 })
  await savePdf(
    page,
    () => page.getByRole('dialog').getByRole('button', { name: 'Download PDF' }).click(),
    'workshop-en',
  )
  await page.keyboard.press('Escape')

  // Accepted, then an order.
  await page.getByRole('button', { name: 'Mark accepted' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Mark accepted' }).click()
  await expect(page.locator('[data-quotation-status="accepted"]').first()).toBeVisible()
  await page.getByRole('button', { name: 'Make an order' }).click()
  const order = page.getByRole('alertdialog')
  await expect(order).toContainText(money('en', '9,476.25'))
  await order.getByRole('button', { name: 'Make order' }).click()
  await expect(page.getByText(`Order ${n('#1001')} made.`)).toBeVisible()
  await expect(page.getByRole('link', { name: `Open order ${n('#1001')}` })).toBeVisible()
  await expect(page.locator('[data-history-event="ordered"]')).toBeVisible()
  await shot(page, 'quotations-en-1440-ordered')

  // Copied for another customer: a new number, a draft; then discarded.
  await page.getByRole('button', { name: 'Copy to a new quotation' }).click()
  const copy = page.getByRole('alertdialog')
  await copy.getByRole('button', { name: 'Remove the customer' }).click()
  await copy.getByRole('combobox', { name: 'Customer' }).fill('Omar')
  await page.getByRole('option', { name: /Omar Khalil/ }).click()
  await copy.getByRole('button', { name: 'Copy', exact: true }).click()
  await expect(page.getByText(`Quotation ${n('Q-0002')} made as a copy.`)).toBeVisible()
  await expect(page.getByRole('heading', { level: 1, name: /Change quotation/ })).toBeVisible()
  await page.getByRole('link', { name: /Quotation .*Q-0002/ }).click()
  await page.getByRole('button', { name: 'Discard' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Discard' }).click()
  await expect(page.getByText(`Quotation ${n('Q-0002')} discarded.`)).toBeVisible()

  // The list: the status filter and the search live in the address.
  await expect(page).toHaveURL(new RegExp(`/b/${businessId}/quotations$`))
  await page.locator('label').filter({ hasText: 'Accepted' }).click()
  await expect(page).toHaveURL(/status=accepted/)
  await expect(page.locator('[data-quotation-row]')).toHaveCount(1)
  await page.getByRole('searchbox').fill('Q-0001')
  await expect(page).toHaveURL(/q=Q-0001/)
  await expect(page.locator('[data-quotation-row]')).toHaveCount(1)
  await page.reload()
  await expect(page.locator('[data-quotation-row="accepted"]')).toHaveCount(1)
  await expectSound(page, 'en')
  await shot(page, 'quotations-en-1440-list')
})

test('Settings → Documents: the letterhead without a logo and with one, the signature and stamp, the address on the checklist', async ({
  browser,
}) => {
  test.setTimeout(900_000)
  const page = await open(browser, DESKTOP, 'en', 'Abdulla')
  const businessId = await createBusinessIn(page, 'Modern Touch Interiors', FITOUT_ANSWERS, 'en')
  await setProfile(page, businessId, {
    legalName: 'Modern Touch Interiors',
    legalNameAr: 'لمسة عصرية للديكور',
    trn: '100345678900003',
  })

  // The checklist asks for the address (Quotations is on).
  await page.goto(`/b/${businessId}`)
  const step = page.getByRole('listitem').filter({ hasText: 'Add your business address' })
  await expect(step).toBeVisible()
  await expect(step).toContainText('Your quotations and invoices print it')

  // The business profile: phones, email, address and trade licence.
  await page.goto(`/b/${businessId}/settings/business`)
  await page.getByRole('textbox', { name: 'Phone', exact: true }).fill('+971 4 555 0142')
  await page.getByRole('textbox', { name: 'Email' }).fill('hello@moderntouch.example')
  await page.getByRole('textbox', { name: 'Address' }).fill('Warehouse 7, Al Quoz Industrial 3')
  await page.getByRole('combobox', { name: 'Emirate' }).selectOption('dubai')
  await page.getByRole('textbox', { name: 'Trade licence number' }).fill('DED-884210')
  await expectSound(page, 'en')
  await shot(page, 'documents-en-1440-profile')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Business details saved.')).toBeVisible()
  await page.goto(`/b/${businessId}`)
  await expect(
    page.getByRole('listitem').filter({ hasText: 'Your address is saved.' }),
  ).toBeVisible()

  // Settings → Documents without a logo: the names alone carry the letterhead.
  await page.goto(`/b/${businessId}/settings/documents`)
  await expect(page.getByRole('heading', { level: 1, name: 'Documents' })).toBeVisible()
  const preview = page.locator('[data-letterhead-preview]')
  await expect(preview.locator('[data-letterhead-name="en"]')).toHaveText('Modern Touch Interiors')
  await expect(preview.locator('[data-letterhead-name="ar"]')).toHaveText('لمسة عصرية للديكور')
  await expect(preview.locator('[data-letterhead-logo]')).toHaveCount(0)
  await expect(preview).toContainText('100345678900003')
  await expect(preview).toContainText('DED-884210')
  await expect(preview.locator('[data-letterhead-contacts]')).toContainText(
    'hello@moderntouch.example',
  )
  await expectSound(page, 'en')
  await shot(page, 'documents-en-1440-no-logo')

  // Black, the signatory, the signature and the stamp.
  await page.getByRole('radio', { name: 'Black' }).check({ force: true })
  await expect(preview).toHaveAttribute('data-accent', '#1A1A1A')
  await page.getByRole('textbox', { name: 'Who signs' }).fill('Abdulla Al Kaabi')
  await page.locator('[data-document-image-input="signature"]').setInputFiles({
    name: 'signature.png',
    mimeType: 'image/png',
    buffer: signaturePng(),
  })
  await expect(page.getByText('Signature saved.')).toBeVisible()
  await page.locator('[data-document-image-input="stamp"]').setInputFiles({
    name: 'stamp.png',
    mimeType: 'image/png',
    buffer: stampPng(),
  })
  await expect(page.getByText('Stamp saved.')).toBeVisible()
  await expect(preview.locator('[data-letterhead-signature]')).toBeVisible()
  await expect(preview.locator('[data-letterhead-stamp]')).toBeVisible()
  await page
    .getByRole('textbox', { name: 'Bank details' })
    .fill('Bank: Emirates Sample Bank\nIBAN: AE00 0000 0000 0000 0000 000')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Document settings saved.')).toBeVisible()
  await shot(page, 'documents-en-1440-signature')

  // With a logo: centred over the names, and faintly behind the page.
  await uploadLogo(page, businessId, archLogo())
  await page.reload()
  await expect(preview.locator('[data-letterhead-logo]')).toBeVisible()
  await expect(preview.locator('[data-letterhead-watermark]')).toBeVisible()
  await shot(page, 'documents-en-1440-logo')
  // The watermark switched off.
  await page.getByRole('switch', { name: 'Logo behind the page' }).click()
  await expect(preview.locator('[data-letterhead-watermark]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Document settings saved.')).toBeVisible()

  // The same page in Arabic on a small phone.
  await setLanguage(page, 'ar')
  await page.setViewportSize(SMALL_PHONE)
  await page.goto(`/b/${businessId}/settings/documents`)
  await expect(page.getByRole('heading', { level: 1, name: 'المستندات' })).toBeVisible()
  await expect(preview.locator('[data-letterhead-logo]')).toBeVisible()
  await expectSound(page, 'ar')
  await shot(page, 'documents-ar-375')
  // And on a desktop: the letterhead preview beside the form, the page drawn from the right.
  await page.setViewportSize(DESKTOP)
  await expect(preview.locator('[data-letterhead-logo]')).toBeVisible()
  await expectSound(page, 'ar')
  await shot(page, 'documents-ar-1440')
  await page.setViewportSize(SMALL_PHONE)
  await page.goto(`/b/${businessId}/settings/business`)
  await expect(page.getByRole('textbox', { name: 'رقم الرخصة التجارية' })).toHaveValue('DED-884210')
  await expectSound(page, 'ar')
  await shot(page, 'documents-ar-375-profile')
})

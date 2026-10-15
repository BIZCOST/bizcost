import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import {
  callApi,
  createBusiness,
  createUser,
  deleteUser,
  RAW_KEY,
  signIn,
  WORKSHOP_ANSWERS,
  type TestUser,
} from '../helpers'

// "Money back from the supplier" (ROADMAP.md M3 Step 5; Q18, D-268): it belongs to the released
// Purchases, so it ships at once and runs on the production build (the `chromium` project), with no
// preview. A purchase on credit paid in full, then one piece returned, is paid beyond what it came
// to: "Record money back from the supplier" settles that, with who received it; its reversal brings
// the overpaid amount back. Money a member received for the business counts against what the
// business owes them (Amounts owed → Owed to me, D-181).
// With E2E_SHOTS_DIR set, each step leaves a screenshot there.

const DESKTOP = { width: 1440, height: 900 }

let user: TestUser

test.afterAll(async () => {
  await deleteUser(user?.id)
})

async function ok<T>(pending: Promise<{ data?: T; appCode?: string }>, what: string): Promise<T> {
  const result = await pending
  expect(result.appCode, what).toBeUndefined()
  return result.data as T
}

async function shot(page: Page, name: string) {
  const dir = process.env.E2E_SHOTS_DIR
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(dir, `${name}.png`) })
}

interface Line {
  id: string
}

/** A posted tax invoice for 10 L × 10 at 5% VAT (105 in all), paid as `extra` says. */
async function bought(
  page: Page,
  businessId: string,
  materialId: string,
  today: string,
  extra: object,
): Promise<{ id: string; lines: Line[] }> {
  const id = randomUUID()
  const draft = await ok(
    callApi<{ data: { version: number } }>(
      page,
      'purchase.create',
      {
        id,
        businessDate: today,
        documentType: 'tax_invoice',
        lines: [
          {
            kind: 'material',
            id: randomUUID(),
            materialId,
            qty: '10',
            unit: 'l',
            unitPrice: '10',
            vatRate: '5',
          },
        ],
        ...extra,
      },
      { businessId },
    ),
    'purchase.create',
  )
  const posted = await ok(
    callApi<{ data: { id: string; lines: Line[] } }>(
      page,
      'purchase.post',
      { id, version: draft.data.version },
      { businessId },
    ),
    'purchase.post',
  )
  return posted.data
}

/** One piece of the purchase returned, final: 10.50 back off it. */
async function returnOne(page: Page, businessId: string, purchase: { id: string; lines: Line[] }) {
  const today = await todayOf(page, businessId)
  const draft = await ok(
    callApi<{ data: { id: string; version: number } }>(
      page,
      'purchaseReturn.create',
      {
        id: randomUUID(),
        purchaseId: purchase.id,
        kind: 'return',
        businessDate: today,
        lines: [{ id: randomUUID(), purchaseLineId: purchase.lines[0]!.id, qty: '1' }],
      },
      { businessId },
    ),
    'purchaseReturn.create',
  )
  await ok(
    callApi(
      page,
      'purchaseReturn.post',
      { id: draft.data.id, version: draft.data.version },
      { businessId },
    ),
    'purchaseReturn.post',
  )
}

async function todayOf(page: Page, businessId: string): Promise<string> {
  return (
    await ok(
      callApi<{ today: string }>(page, 'books.get', {}, { businessId, query: true }),
      'books.get',
    )
  ).today
}

test('money back from the supplier settles an overpaid purchase, and counts for a member who got it', async ({
  browser,
}) => {
  test.setTimeout(600_000)
  user = await createUser('money-back', { locale: 'en' })
  const context = await browser.newContext({ viewport: DESKTOP, locale: 'en-US' })
  const page = await context.newPage()
  await signIn(page, user)
  await ok(callApi(page, 'account.updateProfile', { displayName: 'Rashed' }), 'updateProfile')
  const businessId = await createBusiness(page, 'Rashed Joinery', WORKSHOP_ANSWERS)
  const today = await todayOf(page, businessId)
  const supplier = randomUUID()
  await ok(
    callApi(page, 'supplier.create', { id: supplier, name: 'Gulf Timber' }, { businessId }),
    'supplier.create',
  )
  const wood = randomUUID()
  await ok(
    callApi(
      page,
      'material.create',
      { id: wood, name: 'Wood glue', unit: 'l', packs: [] },
      { businessId },
    ),
    'material.create',
  )

  // Bought on credit, paid in full, then one piece returned: 10.50 overpaid.
  const purchase = await bought(page, businessId, wood, today, {
    supplierId: supplier,
    paymentMethod: 'supplier_credit',
  })
  await ok(
    callApi(
      page,
      'purchasePayment.record',
      {
        id: randomUUID(),
        purchaseId: purchase.id,
        businessDate: today,
        method: 'cash',
        amount: '105',
      },
      { businessId },
    ),
    'purchasePayment.record',
  )
  await returnOne(page, businessId, purchase)

  await page.goto(`/b/${businessId}/purchases/${purchase.id}`)
  await expect(page.locator('[data-owed="overpaid"]')).toContainText('AED 10.50')
  await expect(page.locator('[data-overpaid]')).toBeVisible()
  await page.getByRole('button', { name: 'Record money back from the supplier' }).click()
  const sheet = page.getByRole('dialog', { name: 'Money back from the supplier' })
  await expect(sheet).toContainText(/What \u2068?Gulf Timber\u2069? gave back for this purchase/)
  await expect(sheet.getByRole('textbox', { name: 'Amount' })).toHaveValue('10.50')
  const method = sheet.getByRole('combobox', { name: 'How you got it back' })
  await expect(method).toHaveValue('')
  await method.selectOption({ label: 'Bank transfer' })
  // Who received it: the business (the default), or a member.
  const receivedBy = sheet.getByRole('combobox', { name: 'Who received it?' })
  await expect(receivedBy).toHaveValue('')
  await expect(receivedBy.locator('option')).toContainText(['The business', 'Rashed'])
  await expect(page.locator('body')).not.toContainText(RAW_KEY)
  await shot(page, 'money-back-en-1440-sheet')
  await sheet.getByRole('button', { name: 'Record money back', exact: true }).click()
  await expect(page.getByText('Money back recorded.')).toBeVisible()
  await expect(sheet).toBeHidden()

  // Settled: no longer overpaid, the money back listed with who received it.
  await expect(page.locator('[data-owed="overpaid"]')).toHaveCount(0)
  await expect(page.locator('[data-owed="moneyBack"]')).toContainText('AED 10.50')
  await expect(page.locator('[data-paid-in-full]')).toBeVisible()
  const back = page.locator('[data-payment]').filter({ hasText: 'Money back' })
  await expect(back).toContainText('Received by the business')
  await shot(page, 'money-back-en-1440-settled')

  // Recorded by mistake: its reversal brings the overpaid amount back.
  await back.getByRole('button', { name: 'Reverse' }).click()
  const reverse = page.getByRole('alertdialog', { name: 'Reverse this money back?' })
  await expect(reverse).toContainText('AED 10.50 is owed back to you again.')
  await reverse.getByRole('button', { name: 'Reverse' }).click()
  await expect(page.locator('[data-owed="overpaid"]')).toContainText('AED 10.50')

  // Received by a member (here the owner): it counts against what the business owes them. They
  // paid another purchase from their own money: 105 owed to them.
  const payers = await ok(
    callApi<{ items: { memberId: string; isMe: boolean }[] }>(
      page,
      'purchase.payers',
      {},
      { businessId, query: true },
    ),
    'purchase.payers',
  )
  const me = payers.items.find((payer) => payer.isMe)!
  await bought(page, businessId, wood, today, {
    paymentMethod: 'paid_by_member',
    paidByMemberId: me.memberId,
  })
  await page.reload()
  await page.getByRole('button', { name: 'Record money back from the supplier' }).click()
  const second = page.getByRole('dialog', { name: 'Money back from the supplier' })
  await second
    .getByRole('combobox', { name: 'How you got it back' })
    .selectOption({ label: 'Cash' })
  await second
    .getByRole('combobox', { name: 'Who received it?' })
    .selectOption({ value: me.memberId })
  await second.getByRole('button', { name: 'Record money back', exact: true }).click()
  await expect(page.getByText('Money back recorded.')).toBeVisible()
  await expect(
    page.locator('[data-payment]').filter({ hasText: 'Money back' }).first(),
  ).toContainText(/Received by \u2068?Rashed\u2069?/)

  // Amounts owed → Owed to me: 105 owed, 10.50 of money back held: 94.50 after it.
  await page.goto(`/b/${businessId}/payables`)
  await page.getByRole('tab', { name: 'Owed to me' }).click()
  const mine = page.locator('[data-money-back-mine]')
  await expect(mine).toContainText('You received AED 10.50 of money back from suppliers')
  await expect(mine).toContainText('Owed to you after it: AED 94.50.')
  await expect(page.locator('body')).not.toContainText(RAW_KEY)
  await shot(page, 'money-back-en-1440-owed-to-me')
  await context.close()
})

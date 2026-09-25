import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { createUser, deleteUser, savedSetup, signIn, useLanguage } from '../helpers'

// Security/spec review of the Step 5 business routes: cases the Smart Setup spec (setup.spec.ts)
// does not cover. A failing test is an open finding.

const users: (string | null)[] = []
test.afterAll(async () => {
  for (const id of users) await deleteUser(id)
})

test('a business link with the id in capitals opens the business', async ({ page, context }) => {
  // UUIDs are case-insensitive: the layout accepts the id (isUuid) and the API answers for it
  // (x-business-id is lowercased), but the page compares it with `me` as typed, so the business
  // home and the switcher render nothing.
  const user = await createUser('upper')
  users.push(user.id)
  await useLanguage(context, 'en')
  await signIn(page, user)
  const businessId = await page.evaluate(async () => {
    const input = {
      businessId: crypto.randomUUID(),
      legalName: 'Capital Bakery',
      locale: 'en',
      questionSetVersion: 1,
      answers: {
        what_you_do: ['food_drinks'],
        workplace: 'home',
        team: 'alone',
        work_setup: ['none'],
        sales_channels: ['messages'],
        vat: 'no',
      },
      adjustments: { modules: [], capabilities: [] },
    }
    const response = await fetch('/api/trpc/business.createFromSetup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
    const body = (await response.json()) as { result?: { data: { businessId: string } } }
    return body.result?.data.businessId ?? null
  })
  expect(businessId).not.toBeNull()

  await page.goto(`/b/${businessId!.toUpperCase()}`)
  await expect(page.getByRole('heading', { level: 1, name: 'Capital Bakery' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Switch business/ })).toBeVisible()
})

test('a confirm retried with changed answers is not taken for the first setup', async ({
  page,
  context,
}) => {
  // The first Confirm reaches the server, but its answer is lost (a dropped connection). The user
  // changes the name and confirms again with the same business id: the server answers CONFLICT
  // (another payload), and the page, finding the business in `me`, shows "ready" for the first
  // setup. What the user confirmed the second time is dropped without a word.
  const user = await createUser('retry')
  users.push(user.id)
  await useLanguage(context, 'en')
  await signIn(page, user)
  const businessId = randomUUID()
  await page.goto('/setup')
  await expect(
    page.getByRole('heading', { level: 1, name: "What's your business called?" }),
  ).toBeVisible()
  await page.evaluate((draft) => sessionStorage.setItem('bz_setup', JSON.stringify(draft)), {
    version: 1,
    userId: user.id,
    businessId,
    name: 'First Name',
    answers: {
      what_you_do: ['food_drinks'],
      workplace: 'home',
      team: 'alone',
      work_setup: ['none'],
      sales_channels: ['messages'],
      vat: 'no',
    },
    adjustments: { modules: [], capabilities: [] },
    step: 'review',
  })
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: "Here's your BizCost" })).toBeVisible()

  await page.route(
    /business\.createFromSetup/,
    async (route) => {
      await route.fetch()
      await route.abort('failed')
    },
    { times: 1 },
  )
  await page.getByRole('button', { name: 'Set up my BizCost' }).click()
  await expect(page.getByRole('main').getByRole('alert')).toBeVisible()
  expect((await savedSetup(businessId))?.legalName).toBe('First Name')

  // Change the name (desktop side list), back to the review, confirm again.
  const steps = page.getByRole('navigation', { name: 'Smart Setup' })
  await steps.getByRole('button', { name: /^Name/ }).click()
  await page.getByRole('textbox', { name: "What's your business called?" }).fill('Second Name')
  await steps.getByRole('button', { name: /^Review/ }).click()
  await expect(page.getByRole('heading', { level: 1, name: "Here's your BizCost" })).toBeVisible()
  await page.getByRole('button', { name: 'Set up my BizCost' }).click()

  const ready = await page
    .waitForURL(/\/setup\?done=/, { timeout: 10_000 })
    .then(() => true)
    .catch(() => false)
  if (ready) {
    // "Ready" is only honest for the setup the user confirmed.
    await expect(page.getByRole('main')).toContainText('Second Name')
  } else {
    await expect(page.getByRole('main').getByRole('alert')).toBeVisible()
  }
})

import type { CreateFromSetupInput } from '@bizcost/contracts'
import { createDb, type Db } from '@bizcost/db'
import { newId } from '@bizcost/domain'
import { QUESTION_SET_VERSION, type SetupAnswers } from '@bizcost/modules'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  connectAdmin,
  connectApi,
  createBusiness,
  createUser,
  deleteUser,
  handlerFor,
  mintToken,
  mutate,
  type Admin,
  type TestUser,
} from './helpers'

// Security review of Smart Setup's confirm step (business.createFromSetup, M1 Step 5): attacks that
// the happy-path suite (setup.api.test.ts) does not cover. Each test states the expected, safe
// behaviour; a failing test is an open finding.

let db: Db
let admin: Admin
let handler: ReturnType<typeof handlerFor>
const users: TestUser[] = []

beforeAll(() => {
  db = connectApi()
  admin = connectAdmin()
  handler = handlerFor(db)
})

afterAll(async () => {
  for (const user of users) await deleteUser(user)
  await admin.end()
  await db.$client.end()
})

async function newUser() {
  const user = await createUser({ locale: 'en' })
  users.push(user)
  return { user, token: await mintToken(user) }
}

const BAKER: SetupAnswers = {
  what_you_do: ['food_drinks'],
  workplace: 'home',
  team: 'alone',
  work_setup: ['none'],
  sales_channels: ['messages'],
  vat: 'no',
}

function setupInput(patch: Partial<CreateFromSetupInput> = {}): CreateFromSetupInput {
  return {
    businessId: newId(),
    legalName: "Sara's Sweets",
    locale: 'en',
    questionSetVersion: QUESTION_SET_VERSION,
    answers: BAKER as CreateFromSetupInput['answers'],
    adjustments: { modules: [], capabilities: [] },
    ...patch,
  }
}

async function countBusinesses(id: string) {
  const [row] = await admin<{ n: number }[]>`
    select count(*)::int as n from app.businesses where id = ${id}`
  return row?.n ?? 0
}

describe('business.createFromSetup under attack', () => {
  it('stays idempotent for two identical requests racing at the daily limit', async () => {
    // The 10th business of the day, confirmed twice at once (a double submit or a client retry while
    // the first request is still running). Both must get the business, like below the limit
    // ("handles two identical requests at once"). app.create_business checks the limit before the
    // id, so the second request, which only has to find the business the first one created, is
    // refused with rate_limited instead.
    const { user, token } = await newUser()
    for (let i = 0; i < 9; i++) await createBusiness(db, user, `Business ${i}`)
    const input = setupInput()

    // A pool with room for both requests, so they really overlap.
    const wide = createDb(process.env.DATABASE_URL!, { max: 4 })
    const wideHandler = handlerFor(wide)
    const locker = connectAdmin()
    const watcher = connectAdmin()
    try {
      // Hold the per-user creation lock, so both requests pass their idempotency pre-check and then
      // wait inside app.create_business; release it once both wait.
      let release!: () => void
      let locked!: () => void
      const lockHeld = new Promise<void>((resolve) => (locked = resolve))
      const holding = locker.begin(async (sql) => {
        await sql`select pg_advisory_xact_lock(hashtextextended(${`app.create_business:${user.id}`}, 0))`
        locked()
        await new Promise<void>((resolve) => (release = resolve))
      })
      await lockHeld

      const call = () =>
        mutate<{ businessId: string }>(wideHandler, 'business.createFromSetup', {
          token,
          input,
        })
      const first = call()
      const second = call()
      // Both requests are in their write transaction and waiting: the first on the creation lock,
      // the second on the first (the same new profile row, or the creation lock too).
      for (let i = 0; i < 200; i++) {
        const [row] = await watcher<{ n: number }[]>`
          select count(*)::int as n from pg_stat_activity
           where usename = 'bizcost_api' and wait_event_type = 'Lock'`
        if ((row?.n ?? 0) >= 2) break
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      release()
      await holding

      const results = await Promise.all([first, second])
      expect(await countBusinesses(input.businessId)).toBe(1)
      for (const result of results) {
        expect(result.error?.data.appCode).toBeUndefined()
        expect(result.data).toEqual({ businessId: input.businessId })
      }
    } finally {
      await locker.end()
      await watcher.end()
      await wide.$client.end()
    }
  })

  it('answers VALIDATION, not an internal error, for a NUL character in the business name', async () => {
    // Postgres text cannot hold U+0000 (SQLSTATE 22021), which the API does not map: the user's
    // input becomes a 500 and an error report.
    const { token } = await newUser()
    const input = setupInput({ legalName: 'Sara\u0000Sweets' })
    const result = await mutate(handler, 'business.createFromSetup', { token, input })
    expect(result.error?.data.appCode).toBe('validation')
    expect(result.status).toBe(400)
    expect(await countBusinesses(input.businessId)).toBe(0)
  })
})

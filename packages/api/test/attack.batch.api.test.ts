import { API_MAX_BATCH_SIZE } from '@bizcost/contracts'
import type { Db } from '@bizcost/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  batch,
  connectApi,
  createUser,
  deleteUser,
  handlerFor,
  mintToken,
  ORIGIN,
  type TestUser,
} from './helpers'

// ATTACK (fixed, D-061: maxBatchSize = API_MAX_BATCH_SIZE, `me` memoized per request): without a
// maxBatchSize one GET could batch hundreds (a ~14 KB URL: thousands) of `me` calls, each running
// 1 + N withTenantTx transactions. With the deployed pool size of 1 (createDb default), a single
// signed-in request monopolized the connection: measured locally, 400 batched `me` calls took ~3.8 s
// and a concurrent business.context of another user went from ~27 ms to ~3.7 s.

let db: Db
let handler: ReturnType<typeof handlerFor>
let user: TestUser
let token: string

beforeAll(async () => {
  db = connectApi()
  handler = handlerFor(db)
  user = await createUser()
  token = await mintToken(user)
})

afterAll(async () => {
  await deleteUser(user)
  await db.$client.end()
})

describe('batch size', () => {
  it('rejects an oversized batch before running any procedure', async () => {
    const paths = Array.from({ length: 200 }, () => 'me').join(',')
    const response = await handler(
      new Request(`${ORIGIN}/api/trpc/${paths}?batch=1`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    )
    expect(response.status).toBe(400)
    // Rejected while reading the request, so one error for the whole batch.
    const body = (await response.json()) as { error: { data: { appCode: string } } }
    expect(body.error.data.appCode).toBe('validation')
  })

  it('serves a batch of the allowed size (clients set maxItems to API_MAX_BATCH_SIZE)', async () => {
    const paths = Array.from({ length: API_MAX_BATCH_SIZE }, () => 'me')
    const result = await batch(handler, paths, { token })
    expect(result.status).toBe(200)
    expect(result.results).toHaveLength(API_MAX_BATCH_SIZE)
    expect(result.results.every((r) => r.result !== undefined)).toBe(true)
  })
})

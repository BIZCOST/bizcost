import { describe, expect, it, vi } from 'vitest'
import type { Db } from './client'
import { withTenantTx } from './tenant'

const USER = '0199a3c2-5b1e-7c3a-9f00-1a2b3c4d5e6f'
const BUSINESS = '0199a3c2-5b1e-7c3a-9f00-1a2b3c4d5e70'
const REQUEST = '0199a3c2-5b1e-7c3a-9f00-1a2b3c4d5e71'

describe('withTenantTx input validation', () => {
  const transaction = vi.fn()
  const db = { transaction } as unknown as Db

  it.each([
    ['userId', { userId: 'nope', businessId: BUSINESS, requestId: REQUEST }],
    ['businessId', { userId: USER, businessId: "x' or '1'='1", requestId: REQUEST }],
    ['requestId', { userId: USER, businessId: null, requestId: '' }],
  ])('rejects a non-UUID %s before touching the database', async (name, ctx) => {
    await expect(withTenantTx(db, ctx, async () => 1)).rejects.toThrow(`${name} must be a UUID`)
    expect(transaction).not.toHaveBeenCalled()
  })
})

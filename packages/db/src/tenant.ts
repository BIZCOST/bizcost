import { isUuid } from '@bizcost/domain'
import { sql } from 'drizzle-orm'
import type { Db } from './client'

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

export type TenantContext = {
  /** Auth user id of the caller. */
  userId: string
  /** Active business (x-business-id), or null for calls outside a business (e.g. `me`, create business). */
  businessId: string | null
  /** Request id, recorded on every audit_log row. */
  requestId: string
}

function assertUuid(name: string, value: unknown): void {
  if (!isUuid(value)) throw new TypeError(`withTenantTx: ${name} must be a UUID`)
}

/**
 * The only entry point to tenant data. Opens a transaction whose FIRST statement sets the tenant
 * context transaction-locally (set_config(..., true)); RLS reads it through app.current_user_id() and
 * app.current_business_id(). The context is gone when the transaction ends, so a pooled connection
 * never carries it into the next request.
 */
export async function withTenantTx<T>(
  db: Db,
  ctx: TenantContext,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  assertUuid('userId', ctx.userId)
  if (ctx.businessId !== null) assertUuid('businessId', ctx.businessId)
  assertUuid('requestId', ctx.requestId)

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.user_id', ${ctx.userId}, true), set_config('app.business_id', coalesce(${ctx.businessId}, ''), true), set_config('app.request_id', ${ctx.requestId}, true)`,
    )
    return fn(tx)
  })
}

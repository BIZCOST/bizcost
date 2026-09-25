import type { BusinessAccess } from './access'
import type { AuthUser } from './auth'
import type { Context } from './context'
import type { TenantTx } from './trpc'

/** The context of a business procedure (businessProcedure): the verified caller in one business. */
export interface BusinessCtx extends Context {
  readonly auth: AuthUser
  readonly businessId: string
  readonly access: BusinessAccess
  /** withTenantTx as the caller in this business. */
  readonly tx: TenantTx
}

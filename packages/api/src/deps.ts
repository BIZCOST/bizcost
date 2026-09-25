import type { Db } from '@bizcost/db'

/** Server configuration of the API, read from the environment by the host app (apps/web). */
export interface ApiConfig {
  /** Supabase URL (custom domain in prod). Access tokens are verified against its JWKS. */
  readonly supabaseUrl: string
  readonly supabasePublishableKey: string
  /** Oldest app version (x-app-version, semver) the API still serves; older apps must update. */
  readonly minSupportedAppVersion: string
  /** Exact origins (scheme://host[:port]) allowed to send cookie-authenticated mutations. */
  readonly allowedOrigins: readonly string[]
  /** Server build version reported by `health`. */
  readonly version: string
  /**
   * Supabase secret key, for the Auth admin API only (deleting the auth user in account.delete,
   * src/admin). Required in production; account deletion fails with an internal error without it.
   */
  readonly supabaseSecretKey?: string
}

export interface ApiDeps {
  /** postgres.js + Drizzle as bizcost_api; reached only through withTenantTx(). */
  readonly db: Db
  readonly config: ApiConfig
  /** Receives unexpected (internal) errors, e.g. to report them to Sentry. */
  readonly reportError?: (error: unknown, info: { requestId?: string; path?: string }) => void
}

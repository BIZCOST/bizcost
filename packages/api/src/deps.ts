import type { Db } from '@bizcost/db'
import type { EmailSender } from './email/sender'

/** How the API sends its own emails (invitations). Auth emails are sent by Supabase Auth. */
export type EmailConfig =
  /** SMTP without authentication: locally Mailpit of the Supabase stack (127.0.0.1:54325). */
  | {
      readonly transport: 'smtp'
      readonly host: string
      readonly port: number
      readonly from: string
    }
  /** The Resend HTTP API (production). */
  | { readonly transport: 'resend'; readonly apiKey: string; readonly from: string }

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
   * Supabase secret key, for the admin APIs only (src/admin): deleting the auth user in
   * account.delete, and Storage signed URLs for the business logo. Required in production; those
   * procedures fail with an internal error without it.
   */
  readonly supabaseSecretKey?: string
  /** The web app's origin, for links in emails (e.g. {appUrl}/invite/{token}). */
  readonly appUrl: string
  /** Email transport; without it, sending an invitation fails with an internal error. */
  readonly email?: EmailConfig
}

export interface ApiDeps {
  /** postgres.js + Drizzle as bizcost_api; reached only through withTenantTx(). */
  readonly db: Db
  readonly config: ApiConfig
  /** Receives unexpected (internal) errors, e.g. to report them to Sentry. */
  readonly reportError?: (error: unknown, info: { requestId?: string; path?: string }) => void
  /** Sends the API's emails; default: a sender for `config.email` (tests pass their own). */
  readonly emailSender?: EmailSender
}

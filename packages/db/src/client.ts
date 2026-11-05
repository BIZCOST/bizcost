import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

export type CreateDbOptions = {
  /** Pool size, for this process (docs/ARCHITECTURE.md §Environments & deployment). */
  max?: number
  /** The certificate of the hosted database's CA (DATABASE_CA_CERT): public, not a secret. */
  ca?: string
}

const THIS_MACHINE = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * The TLS option of the driver for `url` (D-353, D-362). A database on this machine (the local stack,
 * CI) has no TLS: nothing to add. A hosted one must prove who it is: postgres.js's `ssl: 'require'` and
 * `sslmode=require` accept any certificate, so whoever sits on the network between could read the
 * password and every row. So its CA is given, or the URL asks for `verify-full` against the system's
 * own list (Supabase's CA is not on it). Anything else is refused here, before a connection is made.
 */
export function tlsFor(
  url: string,
  ca?: string,
): { ca: string; rejectUnauthorized: true } | undefined {
  const { hostname, searchParams } = new URL(url)
  if (THIS_MACHINE.has(hostname)) return undefined
  const mode = searchParams.get('sslmode')
  if (mode === 'disable') {
    throw new Error('DATABASE_URL: a hosted database needs TLS, and this one says sslmode=disable')
  }
  if (ca) return { ca, rejectUnauthorized: true }
  if (mode === 'verify-full') return undefined
  throw new Error('DATABASE_CA_CERT is required for a hosted database (docs/plans/beta-launch.md)')
}

/**
 * Drizzle over postgres.js, for the Supavisor transaction pooler: no prepared statements.
 * Connect as bizcost_api and reach tenant data only through withTenantTx().
 */
export function createDb(url: string, options: CreateDbOptions = {}) {
  const ssl = tlsFor(url, options.ca)
  const client = postgres(url, {
    prepare: false,
    max: options.max ?? 1,
    idle_timeout: 20,
    ...(ssl ? { ssl } : {}),
  })
  return drizzle({ client, schema })
}

export type Db = ReturnType<typeof createDb>

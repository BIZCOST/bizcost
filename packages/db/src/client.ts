import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

export type CreateDbOptions = {
  /** Pool size. Serverless functions use 1 (docs/ARCHITECTURE.md §Environments & deployment). */
  max?: number
}

/**
 * Drizzle over postgres.js, for the Supavisor transaction pooler: no prepared statements.
 * Connect as bizcost_api and reach tenant data only through withTenantTx().
 */
export function createDb(url: string, options: CreateDbOptions = {}) {
  const client = postgres(url, {
    prepare: false,
    max: options.max ?? 1,
    idle_timeout: 20,
  })
  return drizzle({ client, schema })
}

export type Db = ReturnType<typeof createDb>

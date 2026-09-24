import { createHash, randomBytes } from 'node:crypto'
import { newId } from '@bizcost/domain'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import { createDb, withTenantTx, type Db, type TenantContext } from '../src'

function env(name: 'DATABASE_URL' | 'DATABASE_URL_ADMIN'): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set (see vitest.db.config.ts)`)
  return value
}

/** Connects as `postgres` (BYPASSRLS). Test setup and assertions only; never used by app code. */
export function connectAdmin() {
  return postgres(env('DATABASE_URL_ADMIN'), { max: 1, prepare: false, onnotice: () => {} })
}

/** Connects as the API role bizcost_api, one pooled connection. */
export function connectApi(): Db {
  return createDb(env('DATABASE_URL'), { max: 1 })
}

export type Admin = ReturnType<typeof connectAdmin>

export type TestUser = { id: string; email: string }

/** Inserts a minimal auth.users row (what local GoTrue's schema requires). */
export async function createAuthUser(
  admin: Admin,
  options: { email?: string; verified?: boolean } = {},
): Promise<TestUser> {
  const id = newId()
  const email = options.email ?? `user-${id}@test.bizcost.local`
  const confirmedAt = options.verified === false ? null : new Date()
  await admin`
    insert into auth.users (
      id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at
    ) values (
      ${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', ${email}, '',
      ${confirmedAt}, '{}'::jsonb, '{}'::jsonb, now(), now()
    )`
  return { id, email }
}

export function ctx(userId: string, businessId: string | null, requestId = newId()): TenantContext {
  return { userId, businessId, requestId }
}

export type TestBusiness = { id: string; ownerRoleId: string; ownerMemberId: string }

/** Creates a business through app.create_business as bizcost_api, like the API will. */
export async function createBusiness(
  db: Db,
  owner: TestUser,
  legalName = 'Test Business',
): Promise<TestBusiness> {
  const business = { id: newId(), ownerRoleId: newId(), ownerMemberId: newId() }
  await withTenantTx(db, ctx(owner.id, null), (tx) =>
    tx.execute(
      sql`select app.create_business(${business.id}, ${legalName}, 'en', 'Owner Name', ${business.ownerRoleId}, ${business.ownerMemberId})`,
    ),
  )
  return business
}

export function newInvitationToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url')
  return { token, tokenHash: createHash('sha256').update(token, 'utf8').digest('hex') }
}

/** Postgres SQLSTATE of a failed query, however deep drizzle wrapped the driver error. */
export function sqlState(error: unknown): string | undefined {
  let current: unknown = error
  while (current && typeof current === 'object') {
    if (
      'code' in current &&
      typeof current.code === 'string' &&
      /^[0-9A-Z]{5}$/.test(current.code)
    ) {
      return current.code
    }
    current = 'cause' in current ? current.cause : undefined
  }
  return undefined
}

/** Runs the promise and returns the SQLSTATE it failed with (throws if it succeeded). */
export async function failsWith(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
  } catch (error) {
    return sqlState(error) ?? `non-sql error: ${String(error)}`
  }
  throw new Error('expected the query to fail')
}

/** Message of a failed query (the driver error's message, not drizzle's "Failed query" wrapper). */
export async function failureMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    let current: unknown = error
    while (current && typeof current === 'object' && 'cause' in current && current.cause) {
      current = current.cause
    }
    return current instanceof Error ? current.message : String(current)
  }
  throw new Error('expected the query to fail')
}

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type BrowserContext, type Page } from '@playwright/test'
import postgres from 'postgres'
import { baseURL, repoRoot, stack } from './stack'

// Test users through the Auth admin API (local secret key) and emailed codes through Mailpit.

export interface TestUser {
  id: string
  email: string
  password: string
}

/**
 * A new address. Its random part is letters only: the emails print the address next to the code,
 * so a run of digits in it must never look like a code.
 */
export function uniqueEmail(label: string): string {
  const letters = randomUUID()
    .replace(/-/g, '')
    .slice(0, 10)
    .replace(/[0-9]/g, (digit) => String.fromCharCode(103 + Number(digit)))
  return `e2e-${label}-${letters}@test.bizcost.local`
}

function adminHeaders(): Record<string, string> {
  const { secretKey } = stack()
  return {
    apikey: secretKey,
    authorization: `Bearer ${secretKey}`,
    'content-type': 'application/json',
  }
}

/** A confirmed user with a password (no email is sent). */
export async function createUser(
  label: string,
  metadata: Record<string, unknown> = { locale: 'en' },
): Promise<TestUser> {
  const email = uniqueEmail(label)
  const password = `Pw-${randomUUID()}`
  const response = await fetch(`${stack().apiUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({ email, password, email_confirm: true, user_metadata: metadata }),
  })
  if (!response.ok) throw new Error(`createUser: ${response.status} ${await response.text()}`)
  const user = (await response.json()) as { id: string }
  return { id: user.id, email, password }
}

export async function getUser(
  id: string,
): Promise<{ email: string; user_metadata: Record<string, unknown> } | null> {
  const response = await fetch(`${stack().apiUrl}/auth/v1/admin/users/${id}`, {
    headers: adminHeaders(),
  })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`getUser: ${response.status} ${await response.text()}`)
  return (await response.json()) as { email: string; user_metadata: Record<string, unknown> }
}

/** Runs `fn` as `postgres` on the local database (assertions only). */
async function asAdmin<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(
    process.env.DATABASE_URL_ADMIN ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
    { max: 1, onnotice: () => {} },
  )
  try {
    return await fn(sql)
  } finally {
    await sql.end()
  }
}

/**
 * Finds a user by email (users created through the sign-up page), as `postgres` on the local
 * database: the admin API's user list fails on rows that SQL tests insert into auth.users.
 */
export async function findUserId(email: string): Promise<string | null> {
  const rows = await asAdmin(
    (sql) => sql<{ id: string }[]>`select id from auth.users where email = ${email}`,
  )
  return rows[0]?.id ?? null
}

/** How many Auth sessions (signed-in devices) the user has. */
export async function sessionCount(userId: string): Promise<number> {
  const rows = await asAdmin(
    (sql) =>
      sql<{ n: number }[]>`select count(*)::int as n from auth.sessions where user_id = ${userId}`,
  )
  return rows[0]?.n ?? 0
}

// ---------------------------------------------------------------------------------------------------
// The session the browser keeps in @supabase/ssr cookies ("base64-" + base64url JSON, split into
// `.0`, `.1`… chunks when long)
// ---------------------------------------------------------------------------------------------------

interface StoredSession {
  access_token: string
  refresh_token: string
  [key: string]: unknown
}

const SESSION_COOKIE = /^sb-[^.]+-auth-token(\.\d+)?$/
const COOKIE_CHUNK = 3180

export async function readSession(context: BrowserContext): Promise<StoredSession> {
  const cookies = (await context.cookies(baseURL)).filter((c) => SESSION_COOKIE.test(c.name))
  const value = cookies
    .sort((a, b) => Number(a.name.split('.')[1] ?? 0) - Number(b.name.split('.')[1] ?? 0))
    .map((c) => c.value)
    .join('')
  if (!value.startsWith('base64-')) throw new Error('no session cookie')
  return JSON.parse(Buffer.from(value.slice(7), 'base64url').toString('utf8')) as StoredSession
}

async function writeSession(context: BrowserContext, session: StoredSession): Promise<void> {
  const existing = (await context.cookies(baseURL)).filter((c) => SESSION_COOKIE.test(c.name))
  const base = existing[0]
  if (!base) throw new Error('no session cookie')
  const name = base.name.replace(/\.\d+$/, '')
  await context.clearCookies({ name: SESSION_COOKIE })
  const value = `base64-${Buffer.from(JSON.stringify(session)).toString('base64url')}`
  const chunks: string[] = []
  for (let i = 0; i < value.length; i += COOKIE_CHUNK) chunks.push(value.slice(i, i + COOKIE_CHUNK))
  await context.addCookies(
    chunks.map((chunk, i) => ({
      name: chunks.length === 1 ? name : `${name}.${i}`,
      value: chunk,
      domain: base.domain,
      path: base.path,
      expires: base.expires,
      secure: base.secure,
      sameSite: base.sameSite,
      httpOnly: base.httpOnly,
    })),
  )
}

/** True when the Auth server still accepts this refresh token (the session was not revoked). */
export async function refreshWorks(refreshToken: string): Promise<boolean> {
  const { apiUrl, publishableKey } = stack()
  const response = await fetch(`${apiUrl}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: publishableKey, 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  })
  return response.ok
}

/**
 * Makes the browser's session look like a sign-in from `minutes` ago: the same access token claims
 * with older `amr` timestamps, signed with the local stack's key (supabase/signing_keys.json).
 */
export async function ageSignIn(context: BrowserContext, minutes: number): Promise<void> {
  const session = await readSession(context)
  const payload = JSON.parse(
    Buffer.from(session.access_token.split('.')[1] ?? '', 'base64url').toString('utf8'),
  ) as { amr?: { method: string; timestamp: number }[] }
  const then = Math.floor(Date.now() / 1000) - minutes * 60
  payload.amr = (payload.amr ?? []).map((entry) => ({ ...entry, timestamp: then }))
  const keys = JSON.parse(
    readFileSync(join(repoRoot, 'supabase', 'signing_keys.json'), 'utf8'),
  ) as (JsonWebKey & { kid: string })[]
  const key = keys[0]
  if (!key) throw new Error('supabase/signing_keys.json has no key')
  const encode = (part: object) => Buffer.from(JSON.stringify(part)).toString('base64url')
  const input = `${encode({ alg: 'ES256', kid: key.kid, typ: 'JWT' })}.${encode(payload)}`
  const signingKey = await crypto.subtle.importKey(
    'jwk',
    { ...key, key_ops: ['sign'] },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    signingKey,
    new TextEncoder().encode(input),
  )
  const token = `${input}.${Buffer.from(signature).toString('base64url')}`
  await writeSession(context, { ...session, access_token: token })
}

export async function deleteUser(id: string | null | undefined): Promise<void> {
  if (!id) return
  await fetch(`${stack().apiUrl}/auth/v1/admin/users/${id}`, {
    method: 'DELETE',
    headers: adminHeaders(),
  })
}

/** True when the password signs the user in (a direct Auth call, not through the UI). */
export async function passwordWorks(email: string, password: string): Promise<boolean> {
  const { apiUrl, publishableKey } = stack()
  const response = await fetch(`${apiUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: publishableKey, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  return response.ok
}

interface MailSummary {
  ID: string
  Subject: string
}

const seen = new Set<string>()

/**
 * The 6-digit code of the next unread email to `to` (Mailpit), waiting up to 15 s. Each message is
 * read once, so a second call returns the next email.
 */
export async function nextCode(to: string, subject?: RegExp): Promise<string> {
  const { mailpitUrl } = stack()
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const response = await fetch(
      `${mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`,
    )
    const { messages } = (await response.json()) as { messages: MailSummary[] }
    const fresh = messages
      .filter((m) => !seen.has(m.ID) && (!subject || subject.test(m.Subject)))
      .reverse()
    const message = fresh[0]
    if (message) {
      seen.add(message.ID)
      const detail = (await (await fetch(`${mailpitUrl}/api/v1/message/${message.ID}`)).json()) as {
        HTML: string
      }
      // The code is the whole text of its own table cell (supabase/templates/*.html).
      const code = />\s*(\d{6})\s*<\/td>/.exec(detail.HTML)?.[1]
      if (!code) throw new Error(`no code in "${message.Subject}"`)
      return code
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`no email to ${to}`)
}

/** Types a code into the code cells (the one-time-code input). */
export async function enterCode(page: Page, code: string, nth = 0): Promise<void> {
  const input = page.locator('input[autocomplete="one-time-code"]').nth(nth)
  // Replace any code typed before (the cells keep a wrong code so it can be corrected).
  await input.clear()
  await input.fill(code)
}

export async function useLanguage(context: BrowserContext, locale: 'en' | 'ar'): Promise<void> {
  await context.addCookies([{ name: 'bz_locale', value: locale, url: baseURL }])
}

/** Signs in through the page with the password. */
export async function signIn(page: Page, user: TestUser): Promise<void> {
  await page.goto('/login')
  await page.getByLabel('Email', { exact: true }).fill(user.email)
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(user.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).toHaveURL('/')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Matches `before + value + after` in page text. The app wraps emails and names in Unicode
 * directional isolates (so they read left to right inside Arabic text), which this allows for.
 */
export function withValue(before: string, value: string, after = ''): RegExp {
  return new RegExp(
    `${escapeRegExp(before)}\\u2068?${escapeRegExp(value)}\\u2069?${escapeRegExp(after)}`,
  )
}

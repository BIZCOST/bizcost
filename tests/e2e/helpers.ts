import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
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

/** What Smart Setup saved for a business (assertions only). */
export async function savedSetup(businessId: string): Promise<{
  legalName: string
  businessType: string | null
  terminologyProfile: string
  vatRegistered: boolean
  defaultLocation: string | null
  enabledModules: string[]
} | null> {
  return asAdmin(async (sql) => {
    const [business] = await sql<
      {
        legal_name: string
        business_type: string | null
        terminology_profile: string
        vat_registered: boolean
      }[]
    >`select legal_name, business_type, terminology_profile, vat_registered
       from app.businesses where id = ${businessId}`
    if (!business) return null
    const [location] = await sql<{ name: string }[]>`
      select name from app.locations where business_id = ${businessId} and is_default`
    const modules = await sql<{ module_key: string }[]>`
      select module_key from app.business_modules
      where business_id = ${businessId} and enabled order by module_key`
    return {
      legalName: business.legal_name,
      businessType: business.business_type,
      terminologyProfile: business.terminology_profile,
      vatRegistered: business.vat_registered,
      defaultLocation: location?.name ?? null,
      enabledModules: modules.map((m) => m.module_key),
    }
  })
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

/**
 * A sign-up request straight to the Auth server (no client checks): its status, error code and
 * `weak_password` reasons. An accepted address gets an account; delete it with `findUserId`.
 */
export async function signUpDirectly(
  email: string,
  password: string,
): Promise<{ status: number; code?: string; reasons?: string[] }> {
  const { apiUrl, publishableKey } = stack()
  const response = await fetch(`${apiUrl}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: publishableKey, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, data: { locale: 'en' } }),
  })
  const body = (await response.json()) as {
    error_code?: string
    weak_password?: { reasons?: string[] }
  }
  return { status: response.status, code: body.error_code, reasons: body.weak_password?.reasons }
}

export interface MailSummary {
  ID: string
  Subject: string
}

const seen = new Set<string>()

/** The emails to `to` in Mailpit (newest first), optionally only those whose subject matches. */
export async function emailsTo(to: string, subject?: RegExp): Promise<MailSummary[]> {
  const { mailpitUrl } = stack()
  const response = await fetch(
    `${mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`,
  )
  const { messages } = (await response.json()) as { messages: MailSummary[] }
  return messages.filter((m) => !subject || subject.test(m.Subject))
}

/**
 * The 6-digit code of the next unread email to `to` (Mailpit), waiting up to `timeout` ms (15 s).
 * Each message is read once, so a second call returns the next email.
 */
export async function nextCode(to: string, subject?: RegExp, timeout = 15_000): Promise<string> {
  const { mailpitUrl } = stack()
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const messages = await emailsTo(to, subject)
    const fresh = messages.filter((m) => !seen.has(m.ID)).reverse()
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

/**
 * How `part` (in the element's first text node) is drawn: its visible characters sorted left to
 * right, and on how many lines. `text` is `part` (without the characters that draw nothing) only
 * when it reads left to right with unmirrored brackets. Runs in the page:
 * `locator.evaluate(drawn, part)`.
 */
export function drawn(element: Element, part: string): { text: string; lines: number } {
  const node = element.firstChild!
  const start = (node.textContent ?? '').indexOf(part)
  if (start < 0) return { text: '', lines: 0 }
  const glyphs = [...part]
    .map((char, i) => {
      const range = document.createRange()
      range.setStart(node, start + i)
      range.setEnd(node, start + i + 1)
      const box = range.getBoundingClientRect()
      return { char, left: box.left, top: Math.round(box.top), width: box.width }
    })
    .filter(({ width }) => width > 0) // isolate marks and word joiners
  return {
    text: glyphs
      .sort((a, b) => a.left - b.left)
      .map(({ char }) => char)
      .join(''),
    lines: new Set(glyphs.map(({ top }) => top)).size,
  }
}

// ---------------------------------------------------------------------------------------------------
// Businesses and settings (ROADMAP.md Step 6)
// ---------------------------------------------------------------------------------------------------

/** Workshop with a team, branches, stock, machines and VAT (every capability on). */
export const WORKSHOP_ANSWERS = {
  what_you_do: ['make_products'],
  how_you_make: ['custom_jobs'],
  workplace: 'workshop',
  branches: true,
  team: 'team',
  team_tracking: ['hours', 'salaries', 'staff_cash'],
  work_setup: ['stock', 'machines', 'vehicles'],
  sales_channels: ['messages', 'quotes'],
  vat: 'yes',
}

/** Solo home baker: no team, one location, no VAT (Orders on). */
export const BAKER_ANSWERS = {
  what_you_do: ['food_drinks'],
  workplace: 'home',
  team: 'alone',
  work_setup: ['none'],
  sales_channels: ['messages'],
  vat: 'no',
}

export interface ApiResult<T> {
  data?: T
  appCode?: string
}

/**
 * Calls a procedure of /api/trpc from the page (its cookies and Origin), like the app does: a query
 * with GET, a mutation with POST; `businessId` goes in x-business-id.
 */
export async function callApi<T = unknown>(
  page: Page,
  path: string,
  input: unknown,
  options: { businessId?: string; query?: boolean } = {},
): Promise<ApiResult<T>> {
  return page.evaluate(
    async ({ path, input, businessId, query }) => {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (businessId) headers['x-business-id'] = businessId
      const url = query
        ? `/api/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input ?? {}))}`
        : `/api/trpc/${path}`
      const response = await fetch(url, {
        method: query ? 'GET' : 'POST',
        headers,
        body: query ? undefined : JSON.stringify(input ?? {}),
      })
      const body = (await response.json()) as {
        result?: { data: unknown }
        error?: { data?: { appCode?: string } }
      }
      return body.error
        ? { appCode: body.error.data?.appCode ?? 'unknown' }
        : { data: body.result?.data as never }
    },
    { path, input, businessId: options.businessId, query: options.query ?? false },
  ) as Promise<ApiResult<T>>
}

/** Creates a business through Smart Setup's confirm step, as the page's user; returns its id. */
export async function createBusiness(
  page: Page,
  legalName: string,
  answers: Record<string, unknown>,
): Promise<string> {
  const result = await callApi<{ businessId: string }>(page, 'business.createFromSetup', {
    businessId: randomUUID(),
    legalName,
    locale: 'en',
    questionSetVersion: 1,
    answers,
    adjustments: { modules: [], capabilities: [] },
  })
  if (!result.data) throw new Error(`createFromSetup: ${result.appCode}`)
  return result.data.businessId
}

/** Sets the signed-in user's language (profile and this browser's cookie). */
export async function setLanguage(page: Page, locale: 'en' | 'ar'): Promise<void> {
  const result = await callApi(page, 'account.updateProfile', { locale })
  if (result.appCode) throw new Error(`updateProfile: ${result.appCode}`)
  await useLanguage(page.context(), locale)
}

/**
 * The token of the next unread invitation email to `to` (Mailpit), waiting up to `timeout` ms. The
 * email is marked read, so nextCode() skips it.
 */
export async function nextInvitation(
  to: string,
  timeout = 15_000,
): Promise<{ token: string; subject: string }> {
  const { mailpitUrl } = stack()
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    for (const message of (await emailsTo(to)).reverse()) {
      if (seen.has(message.ID)) continue
      const detail = (await (await fetch(`${mailpitUrl}/api/v1/message/${message.ID}`)).json()) as {
        Text: string
      }
      const token = /\/invite\/([A-Za-z0-9_-]{43})/.exec(detail.Text)?.[1]
      if (!token) continue
      seen.add(message.ID)
      return { token, subject: message.Subject }
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`no invitation email to ${to}`)
}

/** A real PNG image (the logo's three bars), `size` pixels square. */
export function pngImage(size = 64): Buffer {
  const row = size * 4 + 1
  const raw = Buffer.alloc(row * size, 255)
  for (let y = 0; y < size; y++) {
    raw[y * row] = 0
    for (let x = 0; x < size; x++) {
      const bar = Math.floor((x * 3) / size)
      const top = size - Math.round(((bar + 1) * size * 0.8) / 3)
      if (y >= top && x % Math.ceil(size / 3) < Math.ceil(size / 3) - 3) {
        const i = y * row + 1 + x * 4
        raw[i] = 29
        raw[i + 1] = 78
        raw[i + 2] = 216
      }
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

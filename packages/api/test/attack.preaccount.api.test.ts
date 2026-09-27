import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectAdmin, SECRET_KEY, SUPABASE_URL, type Admin } from './helpers'

// ATTACK (pre-registered account takeover, the D-071 gap; fixed by D-102). Anyone can sign up with
// someone else's address and a password of their own (the public sign-up endpoint, publishable
// key). The account stays unconfirmed, so that password does not work yet, and signing up again
// with the address changes nothing (Supabase: "we can't be sure of their claimed identity"). When
// the owner of the address later confirms it — the sign-up code (signing up themselves), "Send me a
// code", a resent code, or a reset they leave right after the code — Supabase Auth kept the
// stranger's password, which then signed in to the owner's account.
//
// Straight against the local Auth server (the app calls it from the browser) and its Mailpit.
// Password sign-ins count against the Auth rate limit per IP (config.toml: 30 sign-ins and sign-ups
// per 5 minutes), so most checks compare the stored hash in SQL and only the decisive ones sign in.

const PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY ?? ''
const MAILPIT = process.env.SUPABASE_MAILPIT_URL ?? 'http://127.0.0.1:54324'

let admin: Admin
const addresses: string[] = []

beforeAll(() => {
  admin = connectAdmin()
})

afterAll(async () => {
  const rows = await admin<{ id: string }[]>`
    select id from auth.users where email = any(${addresses})`
  for (const { id } of rows) {
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${id}`, {
      method: 'DELETE',
      headers: { apikey: SECRET_KEY, authorization: `Bearer ${SECRET_KEY}` },
    })
  }
  await admin.end()
})

/** A new address; letters only, so no digits in it can look like a code in an email. */
function address(label: string): string {
  const letters = randomUUID()
    .replace(/-/g, '')
    .slice(0, 12)
    .replace(/[0-9]/g, (digit) => String.fromCharCode(103 + Number(digit)))
  const email = `preacct-${label}-${letters}@test.bizcost.local`
  addresses.push(email)
  return email
}

interface Answer {
  status: number
  body: Record<string, unknown>
}

/** A request to the Auth server as the browser makes it (publishable key, optional session). */
async function auth(
  path: string,
  body: object,
  options: { method?: string; token?: string } = {},
): Promise<Answer> {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
    method: options.method ?? 'POST',
    headers: {
      apikey: PUBLISHABLE_KEY,
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  }
}

/** An Auth admin request (local secret key). */
async function adminAuth(path: string, method: string, body?: object): Promise<Answer> {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
    method,
    headers: {
      apikey: SECRET_KEY,
      authorization: `Bearer ${SECRET_KEY}`,
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  }
}

/**
 * The stranger: signs up with the address and a password of their own. The sign-up code goes to
 * the owner's inbox, unasked for; it is set aside here (a newer code replaces it).
 */
async function preRegister(email: string, password: string): Promise<void> {
  const answer = await auth('signup', { email, password, data: { locale: 'en' } })
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  await nextCode(email, SIGN_UP_CODE)
}

/**
 * The owner acts later: Supabase emails an address at most once a minute ([auth.email]
 * max_frequency), so the send times are moved a minute back (the codes stay valid for 10).
 */
async function timePasses(email: string): Promise<void> {
  await admin`
    update auth.users
       set confirmation_sent_at = confirmation_sent_at - interval '61 seconds',
           recovery_sent_at = recovery_sent_at - interval '61 seconds',
           email_change_sent_at = email_change_sent_at - interval '61 seconds'
     where email = ${email}`
}

const seen = new Set<string>()

/** The 6-digit code of the next unread email to `to` whose subject matches (Mailpit). */
async function nextCode(to: string, subject: RegExp): Promise<string> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const response = await fetch(
      `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`,
    )
    const { messages } = (await response.json()) as { messages: { ID: string; Subject: string }[] }
    const message = messages.reverse().find((m) => !seen.has(m.ID) && subject.test(m.Subject))
    if (message) {
      seen.add(message.ID)
      const detail = (await (await fetch(`${MAILPIT}/api/v1/message/${message.ID}`)).json()) as {
        HTML: string
      }
      // The code is the whole text of its own table cell (supabase/templates/*.html).
      const code = />\s*(\d{6})\s*<\/td>/.exec(detail.HTML)?.[1]
      if (!code) throw new Error(`no code in "${message.Subject}"`)
      return code
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`no email to ${to} matching ${subject}`)
}

const SIGN_UP_CODE = /sign-up code/i
const RESET_CODE = /password reset code/i
const EMAIL_CHANGE = /email change/i

/** Enters a code as the app does; returns the session's access token. */
async function verify(
  email: string,
  token: string,
  type: 'email' | 'recovery' | 'email_change',
): Promise<string> {
  const answer = await auth('verify', { email, token, type })
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  return String(answer.body.access_token ?? '')
}

/** A real password sign-in (counts against the Auth rate limit). */
async function passwordSignsIn(email: string, password: string): Promise<boolean> {
  const answer = await auth('token?grant_type=password', { email, password })
  return answer.status === 200
}

/** Whether `password` is the one Auth stores for the address (bcrypt compared in SQL). */
async function stored(email: string, password: string): Promise<boolean> {
  const [row] = await admin<{ matches: boolean }[]>`
    select case when coalesce(encrypted_password, '') = '' then false
                else encrypted_password = extensions.crypt(${password}, encrypted_password) end
             as matches
      from auth.users where email = ${email}`
  if (!row) throw new Error(`no user ${email}`)
  return row.matches
}

async function hasPassword(email: string): Promise<boolean> {
  const [row] = await admin<{ has: boolean }[]>`
    select coalesce(encrypted_password, '') <> '' as has from auth.users where email = ${email}`
  if (!row) throw new Error(`no user ${email}`)
  return row.has
}

/** The app sets the password with the session the code created (updateUser). */
async function setPassword(accessToken: string, password: string): Promise<Answer> {
  return auth('user', { password }, { method: 'PUT', token: accessToken })
}

const STRANGER = 'Chosen-by-a-stranger-1'
const OWNER = 'The-real-owner-2'

describe('a stranger signs up first with the owner’s address and a password of their own', () => {
  it('"Send me a code" confirms the address: the stranger’s password no longer signs in', async () => {
    const email = address('code')
    await preRegister(email, STRANGER)
    expect(await passwordSignsIn(email, STRANGER)).toBe(false) // not confirmed yet
    await timePasses(email)

    // "Send me a code" (D-062): an unconfirmed account is sent its sign-up code again.
    const otp = await auth('otp', { email, create_user: true, data: { locale: 'en' } })
    expect(otp.status).toBe(200)
    await verify(email, await nextCode(email, SIGN_UP_CODE), 'email')

    expect(await passwordSignsIn(email, STRANGER), 'the stranger’s password signs in').toBe(false)
    expect(await hasPassword(email)).toBe(false)
  })

  it('the owner signs up too: the stranger’s password is dropped by the code and the owner’s is set', async () => {
    const email = address('signup')
    await preRegister(email, STRANGER)
    await timePasses(email)

    // The owner's own sign-up gets the same answer, and a new sign-up code, but Supabase keeps the
    // first password: whoever signed up first chose it.
    const again = await auth('signup', { email, password: OWNER, data: { locale: 'ar' } })
    expect(again.status).toBe(200)
    expect(await stored(email, STRANGER)).toBe(true)
    expect(await stored(email, OWNER)).toBe(false)

    const session = await verify(email, await nextCode(email, SIGN_UP_CODE), 'email')
    expect(await stored(email, STRANGER), 'the code keeps the stranger’s password').toBe(false)
    expect(await passwordSignsIn(email, STRANGER)).toBe(false)

    // The app sets the password its sign-up page was given, with the session the code created.
    const saved = await setPassword(session, OWNER)
    expect(saved.status, JSON.stringify(saved.body)).toBe(200)
    expect(await passwordSignsIn(email, OWNER)).toBe(true)
    expect(await stored(email, STRANGER)).toBe(false)
  })

  it('a resent sign-up code confirms the address: the stranger’s password no longer signs in', async () => {
    const email = address('resend')
    await preRegister(email, STRANGER)
    await timePasses(email)

    const resent = await auth('resend', { type: 'signup', email })
    expect(resent.status).toBe(200)
    await verify(email, await nextCode(email, SIGN_UP_CODE), 'email')

    expect(await passwordSignsIn(email, STRANGER), 'the stranger’s password signs in').toBe(false)
  })

  it('a reset left right after the code: the stranger’s password no longer signs in', async () => {
    const email = address('reset')
    await preRegister(email, STRANGER)

    // "Forgot password": the recovery code signs the owner in and confirms the address. The owner
    // closes the tab (or goes on another device) before choosing a new password (D-071).
    const recover = await auth('recover', { email })
    expect(recover.status).toBe(200)
    await verify(email, await nextCode(email, RESET_CODE), 'recovery')

    expect(await passwordSignsIn(email, STRANGER), 'the stranger’s password signs in').toBe(false)
    expect(await hasPassword(email)).toBe(false)
  })

  it('an address freed by a deleted account can be pre-registered again, and the rule holds', async () => {
    const email = address('deleted')
    const created = await adminAuth('admin/users', 'POST', {
      email,
      password: OWNER,
      email_confirm: true,
    })
    expect(created.status).toBe(200)
    const deleted = await adminAuth(`admin/users/${String(created.body.id)}`, 'DELETE')
    expect(deleted.status).toBe(200)

    await preRegister(email, STRANGER)
    await timePasses(email)
    await auth('otp', { email, create_user: true, data: { locale: 'en' } })
    await verify(email, await nextCode(email, SIGN_UP_CODE), 'email')
    expect(await stored(email, STRANGER)).toBe(false)
  })

  it('an email change to the pre-registered address is refused (it cannot join the stranger’s account)', async () => {
    const taken = address('taken')
    await preRegister(taken, STRANGER)
    const owner = address('mover')
    const created = await adminAuth('admin/users', 'POST', {
      email: owner,
      password: OWNER,
      email_confirm: true,
    })
    expect(created.status).toBe(200)
    const signIn = await auth('token?grant_type=password', { email: owner, password: OWNER })
    expect(signIn.status).toBe(200)

    const change = await auth(
      'user',
      { email: taken },
      { method: 'PUT', token: String(signIn.body.access_token) },
    )
    expect(change.status).toBe(422)
    expect(change.body.error_code).toBe('email_exists')
  })
})

describe('passwords that stay', () => {
  it('the owner’s own sign-up: the code drops the password, and the app’s next step sets it again', async () => {
    // The server cannot tell the owner's sign-up from the stranger's, so every password chosen before
    // the address was confirmed goes; the sign-up page's password is set again right after the code.
    const email = address('own')
    const signUp = await auth('signup', { email, password: OWNER, data: { locale: 'en' } })
    expect(signUp.status).toBe(200)
    const session = await verify(email, await nextCode(email, SIGN_UP_CODE), 'email')
    expect(await hasPassword(email)).toBe(false)

    const saved = await setPassword(session, OWNER)
    expect(saved.status, JSON.stringify(saved.body)).toBe(200) // not "same_password"
    expect(await passwordSignsIn(email, OWNER)).toBe(true)
  })

  it('an account the admin API creates with a confirmed email keeps its password', async () => {
    const email = address('admin')
    const created = await adminAuth('admin/users', 'POST', {
      email,
      password: OWNER,
      email_confirm: true,
    })
    expect(created.status).toBe(200)
    expect(await stored(email, OWNER)).toBe(true)
  })

  it('an admin who confirms a pre-registered address does not vouch for its password', async () => {
    const email = address('adminconfirm')
    await preRegister(email, STRANGER)
    const [user] = await admin<{ id: string }[]>`select id from auth.users where email = ${email}`
    const confirmed = await adminAuth(`admin/users/${user?.id}`, 'PUT', { email_confirm: true })
    expect(confirmed.status).toBe(200)
    expect(await stored(email, STRANGER)).toBe(false)

    // A password the admin sets (here or in the same call) is the admin's choice and stays.
    const other = address('adminboth')
    await preRegister(other, STRANGER)
    const [second] = await admin<{ id: string }[]>`select id from auth.users where email = ${other}`
    const both = await adminAuth(`admin/users/${second?.id}`, 'PUT', {
      email_confirm: true,
      password: OWNER,
    })
    expect(both.status).toBe(200)
    expect(await stored(other, OWNER)).toBe(true)
    expect(await stored(other, STRANGER)).toBe(false)
  })

  it('a confirmed user who changes their email keeps their password', async () => {
    const email = address('change')
    const created = await adminAuth('admin/users', 'POST', {
      email,
      password: OWNER,
      email_confirm: true,
      user_metadata: { locale: 'en' },
    })
    expect(created.status).toBe(200)
    const signIn = await auth('token?grant_type=password', { email, password: OWNER })
    expect(signIn.status).toBe(200)
    const token = String(signIn.body.access_token)

    // Secure email change: one code to each address (D-062, ARCHITECTURE.md §Auth).
    const next = address('changed')
    const change = await auth('user', { email: next }, { method: 'PUT', token })
    expect(change.status, JSON.stringify(change.body)).toBe(200)
    const current = await nextCode(email, EMAIL_CHANGE)
    const fresh = await nextCode(next, EMAIL_CHANGE)
    await auth('verify', { email, token: current, type: 'email_change' })
    const done = await auth('verify', { email: next, token: fresh, type: 'email_change' })
    expect(done.status, JSON.stringify(done.body)).toBe(200)

    expect(await stored(next, OWNER)).toBe(true)
  })
})

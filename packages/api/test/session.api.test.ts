import type { Db } from '@bizcost/db'
import { newId } from '@bizcost/domain'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { appRouter, authedProcedure, publicProcedure, router } from '../src'
import {
  connectAdmin,
  connectApi,
  createBusiness,
  createUser,
  decodePayload,
  deleteUser,
  handlerFor,
  kidOf,
  LEGACY_JWT_SECRET,
  mintToken,
  mutate,
  ORIGIN,
  query,
  sessionCookie,
  signHs256,
  signIn,
  signWithForeignKey,
  signWithLocalKey,
  type Admin,
  type Session,
  type TestUser,
} from './helpers'

// Session checks, request gates, error formatting, health and `me`, through the real fetch handler
// against the local Auth server and database.

const ok = z.object({ ok: z.boolean() })

// Test-only procedures (never part of appRouter).
const testRouter = router({
  ...appRouter._def.record,
  test: router({
    touch: authedProcedure.output(ok).mutation(() => ({ ok: true })),
    publicTouch: publicProcedure.output(ok).mutation(() => ({ ok: true })),
    missingTable: authedProcedure.output(ok).query(async ({ ctx }) => {
      await ctx.tenantTx(null, (tx) => tx.execute(sql`select * from app.no_such_table`))
      return { ok: true }
    }),
    auditForgery: authedProcedure.output(ok).mutation(async ({ ctx }) => {
      await ctx.tenantTx(null, (tx) =>
        tx.execute(
          sql`insert into app.audit_log (id, business_id, action, entity, entity_id, changes) values (${newId()}, ${newId()}, 'insert', 'x', ${newId()}, '{}')`,
        ),
      )
      return { ok: true }
    }),
  }),
})

let admin: Admin
let db: Db
let handler: ReturnType<typeof handlerFor>
let user: TestUser
let arabicDefault: TestUser
let session: Session
let businessId: string

beforeAll(async () => {
  admin = connectAdmin()
  db = connectApi()
  handler = handlerFor(db, testRouter)
  user = await createUser({ locale: 'en' })
  arabicDefault = await createUser()
  session = await signIn(user)
  businessId = (await createBusiness(db, user, 'Session Bakery')).id
})

afterAll(async () => {
  await deleteUser(user)
  await deleteUser(arabicDefault)
  await admin.end()
  await db.$client.end()
})

describe('session check', () => {
  it('rejects requests without a session', async () => {
    const result = await query(handler, 'me')
    expect(result.status).toBe(401)
    expect(result.error?.data).toMatchObject({
      appCode: 'unauthorized',
      i18nKey: 'errors.unauthorized',
    })
  })

  it('accepts a real ES256 access token as Bearer', async () => {
    const result = await query<{ profile: { id: string } }>(handler, 'me', {
      token: session.access_token,
    })
    expect(result.status).toBe(200)
    expect(result.data?.profile.id).toBe(user.id)
  })

  it('accepts the @supabase/ssr session cookies', async () => {
    const cookie = await sessionCookie(session)
    const result = await query<{ profile: { id: string } }>(handler, 'me', { cookie })
    expect(result.status).toBe(200)
    expect(result.data?.profile.id).toBe(user.id)
  })

  it('rejects a token whose payload was changed after signing', async () => {
    const [header, , signature] = session.access_token.split('.')
    const payload = { ...decodePayload(session.access_token), sub: arabicDefault.id }
    const tampered = `${header}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${signature}`
    const result = await query(handler, 'me', { token: tampered })
    expect(result.error?.data.appCode).toBe('unauthorized')
  })

  it('rejects an expired token signed with the real key', async () => {
    const now = Math.floor(Date.now() / 1000)
    const expired = await signWithLocalKey({
      ...decodePayload(session.access_token),
      iat: now - 7200,
      exp: now - 60,
    })
    expect((await query(handler, 'me', { token: expired })).error?.data.appCode).toBe(
      'unauthorized',
    )
  })

  it('accepts a fresh token signed with the real key (the expiry is what failed above)', async () => {
    const now = Math.floor(Date.now() / 1000)
    const fresh = await signWithLocalKey({ ...decodePayload(session.access_token), exp: now + 300 })
    expect((await query(handler, 'me', { token: fresh })).status).toBe(200)
  })

  it('rejects a token signed with an unpublished key under the real kid', async () => {
    const forged = await signWithForeignKey(
      decodePayload(session.access_token),
      kidOf(session.access_token),
    )
    expect((await query(handler, 'me', { token: forged })).error?.data.appCode).toBe('unauthorized')
  })

  it('rejects HS256 tokens, even one signed with the legacy JWT secret', async () => {
    const payload = decodePayload(session.access_token)
    for (const secret of [LEGACY_JWT_SECRET, 'attacker-chosen-secret-at-least-32-chars']) {
      const forged = await signHs256(payload, secret)
      expect((await query(handler, 'me', { token: forged })).error?.data.appCode).toBe(
        'unauthorized',
      )
    }
  })

  it('rejects tokens that are not for a signed-in user', async () => {
    const now = Math.floor(Date.now() / 1000)
    const service = await signWithLocalKey({
      role: 'service_role',
      iss: 'x',
      iat: now,
      exp: now + 60,
    })
    expect((await query(handler, 'me', { token: service })).error?.data.appCode).toBe(
      'unauthorized',
    )
    expect((await query(handler, 'me', { token: 'not-a-jwt' })).error?.data.appCode).toBe(
      'unauthorized',
    )
  })
})

describe('request gates', () => {
  it('sends a UUIDv7 x-request-id on every response', async () => {
    const result = await query(handler, 'health')
    expect(result.headers.get('x-request-id')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/)
    const failed = await query(handler, 'me')
    expect(failed.headers.get('x-request-id')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/)
  })

  it('rejects apps older than MIN_SUPPORTED_APP_VERSION with a typed error', async () => {
    const old = await query(handler, 'health', { headers: { 'x-app-version': '0.9.9' } })
    expect(old.status).toBe(412)
    expect(old.error?.data).toMatchObject({
      appCode: 'app_version_unsupported',
      i18nKey: 'errors.app_version_unsupported',
    })
    const current = await query(handler, 'health', { headers: { 'x-app-version': '1.0.0' } })
    expect(current.status).toBe(200)
    expect((await query(handler, 'health')).status).toBe(200)
  })

  it('requires an allowed Origin for cookie-authenticated mutations', async () => {
    const cookie = await sessionCookie(session)
    const missing = await mutate(handler, 'test.touch', { cookie })
    expect(missing.error?.data.appCode).toBe('forbidden')
    const foreign = await mutate(handler, 'test.touch', {
      cookie,
      headers: { origin: 'https://evil.example' },
    })
    expect(foreign.error?.data.appCode).toBe('forbidden')
    const allowed = await mutate(handler, 'test.touch', { cookie, headers: { origin: ORIGIN } })
    expect(allowed.data).toEqual({ ok: true })
    // Signed-out cookie-style requests are checked too (e.g. future public mutations).
    const anonymous = await mutate(handler, 'test.publicTouch', {
      headers: { origin: 'https://evil.example' },
    })
    expect(anonymous.error?.data.appCode).toBe('forbidden')
  })

  it('does not check the Origin of Bearer-authenticated mutations', async () => {
    const result = await mutate(handler, 'test.touch', { token: session.access_token })
    expect(result.data).toEqual({ ok: true })
  })
})

describe('error formatting', () => {
  it('gives unexpected database errors no SQL text in production', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    try {
      const result = await query(handler, 'test.missingTable', { token: session.access_token })
      expect(result.status).toBe(500)
      expect(result.error?.message).toBe('internal')
      expect(result.error?.data).toMatchObject({ appCode: 'internal', i18nKey: 'errors.internal' })
      expect(result.error?.data.stack).toBeUndefined()
      expect(result.raw).not.toMatch(/no_such_table|relation|select|app\./i)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('maps an RLS/grant violation (42501) to forbidden without SQL text, even outside production', async () => {
    const result = await mutate(handler, 'test.auditForgery', { token: session.access_token })
    expect(result.status).toBe(403)
    expect(result.error?.data).toMatchObject({ appCode: 'forbidden', i18nKey: 'errors.forbidden' })
    expect(result.error?.message).toBe('forbidden')
    expect(result.raw).not.toMatch(/audit_log|permission denied|insert/i)
  })

  it('maps bad input to validation', async () => {
    const result = await query(handler, 'business.context', {
      token: session.access_token,
      businessId: 'not-a-uuid',
    })
    expect(result.status).toBe(400)
    expect(result.error?.data).toMatchObject({
      appCode: 'validation',
      i18nKey: 'errors.validation',
    })
  })
})

describe('health', () => {
  it('is public and reports the function region', async () => {
    vi.stubEnv('VERCEL_REGION', 'bom1')
    try {
      const result = await query(handler, 'health')
      expect(result.data).toEqual({ ok: true, region: 'bom1', version: 'test' })
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("reports 'local' outside Vercel", async () => {
    vi.stubEnv('VERCEL_REGION', undefined)
    try {
      expect((await query<{ region: string }>(handler, 'health')).data?.region).toBe('local')
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('me', () => {
  it('creates the profile once and returns the same one on every call', async () => {
    const first = await query<{
      profile: { id: string; displayName: string; locale: string; lastBusinessId: null }
      memberships: unknown[]
    }>(handler, 'me', { token: session.access_token })
    const second = await query(handler, 'me', { token: session.access_token })
    expect(second.data).toEqual(first.data)
    expect(first.data?.profile).toEqual({
      id: user.id,
      displayName: user.email.split('@')[0],
      locale: 'en',
      lastBusinessId: null,
    })
    const [row] = await admin<
      { n: number }[]
    >`select count(*)::int as n from app.profiles where id = ${user.id}`
    expect(row?.n).toBe(1)
  })

  it('never overwrites an existing profile', async () => {
    await admin`update app.profiles set display_name = 'Rashed', locale = 'ar' where id = ${user.id}`
    const result = await query<{ profile: { displayName: string; locale: string } }>(
      handler,
      'me',
      {
        token: session.access_token,
      },
    )
    expect(result.data?.profile).toMatchObject({ displayName: 'Rashed', locale: 'ar' })
  })

  it("defaults the locale to 'ar' when the user has none", async () => {
    const result = await query<{ profile: { locale: string }; memberships: unknown[] }>(
      handler,
      'me',
      { token: await mintToken(arabicDefault) },
    )
    expect(result.data?.profile.locale).toBe('ar')
    expect(result.data?.memberships).toEqual([])
  })

  it('lists the businesses the user can open, with their role template', async () => {
    const result = await query<{ memberships: unknown[] }>(handler, 'me', {
      token: session.access_token,
    })
    expect(result.data?.memberships).toEqual([
      { businessId, legalName: 'Session Bakery', roleTemplateKey: 'owner', status: 'active' },
    ])
  })
})

import { sensitive, withMeta, zDecimal } from '@bizcost/contracts'
import type { Db } from '@bizcost/db'
import { TRPCError } from '@trpc/server'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { isVerifiableToken, userFromClaims } from './auth'
import { createContext } from './context'
import type { ApiConfig } from './deps'
import { appCodeOf } from './errors'
import { defaultDisplayName } from './services/profile'
import {
  assertQueryable,
  authedProcedure,
  createCallerFactory,
  isAllowedOrigin,
  isSupportedAppVersion,
  publicProcedure,
  router,
} from './trpc'
import type { BusinessAccess } from './access'

// Middleware behaviour that needs neither the database nor the Auth server. The integration tests
// (test/*.api.test.ts) cover the same rules end to end against the local stack.

const config: ApiConfig = {
  supabaseUrl: 'http://127.0.0.1:54321',
  supabasePublishableKey: 'sb_publishable_test',
  minSupportedAppVersion: '1.2.0',
  allowedOrigins: ['http://localhost:3000'],
  version: 'test',
  appUrl: 'http://localhost:3000',
}

const unusedDb = new Proxy({} as Db, {
  get() {
    throw new Error('the database must not be used here')
  },
})

const testRouter = router({
  ping: publicProcedure.output(z.object({ ok: z.boolean() })).query(() => ({ ok: true })),
  touch: publicProcedure.output(z.object({ ok: z.boolean() })).mutation(() => ({ ok: true })),
  whoami: authedProcedure.output(z.object({ id: z.string() })).query(({ ctx }) => ({
    id: ctx.auth.userId,
  })),
  leak: publicProcedure
    .output(withMeta(z.object({ cost: sensitive(zDecimal, 'cost') })))
    .query(() => ({ data: { cost: '1' }, meta: { redacted: [] } })),
})

function caller(headers: Record<string, string> = {}) {
  const req = new Request('http://localhost:3000/api/trpc/x', { headers })
  const ctx = createContext({
    req,
    resHeaders: new Headers(),
    deps: { db: unusedDb, config },
    router: testRouter,
  })
  return { ctx, call: createCallerFactory(testRouter)(ctx) }
}

async function appCodeOfFailure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof TRPCError) return appCodeOf(error)
    throw error
  }
  throw new Error('expected a failure')
}

describe('context', () => {
  it('gives every request a UUIDv7 id and sends it as x-request-id', () => {
    const { ctx } = caller()
    expect(ctx.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/)
    expect(ctx.resHeaders.get('x-request-id')).toBe(ctx.requestId)
  })

  it('authenticates by the Authorization header alone when it is present', () => {
    expect(caller({ authorization: 'Bearer x', cookie: 'a=b' }).ctx.authMode).toBe('bearer')
    expect(caller({ cookie: 'a=b' }).ctx.authMode).toBe('cookie')
  })
})

describe('app version gate', () => {
  it('serves requests without x-app-version (web)', async () => {
    await expect(caller().call.ping()).resolves.toEqual({ ok: true })
  })

  it.each(['1.2.0', '1.10.0', '2.0.0'])('serves app version %s', async (version) => {
    await expect(caller({ 'x-app-version': version }).call.ping()).resolves.toEqual({ ok: true })
  })

  it.each(['1.1.9', '0.9.0', '1.2.0-beta.1', 'garbage', ''])(
    'rejects app version %j',
    async (version) => {
      const failure = appCodeOfFailure(caller({ 'x-app-version': version }).call.ping())
      expect(await failure).toBe('app_version_unsupported')
    },
  )

  it('compares versions semantically', () => {
    expect(isSupportedAppVersion('1.10.0', '1.9.0')).toBe(true)
    expect(isSupportedAppVersion(' 1.9.0 ', '1.9.0')).toBe(true)
    expect(isSupportedAppVersion('1.9', '1.9.0')).toBe(false)
  })
})

describe('origin check', () => {
  it('rejects cookie mutations without an allowed Origin', async () => {
    expect(await appCodeOfFailure(caller().call.touch())).toBe('forbidden')
    const evil = caller({ origin: 'https://evil.example' }).call.touch()
    expect(await appCodeOfFailure(evil)).toBe('forbidden')
  })

  it('accepts cookie mutations from an allowed Origin', async () => {
    const call = caller({ origin: 'http://localhost:3000' }).call
    await expect(call.touch()).resolves.toEqual({ ok: true })
  })

  it('does not check queries or Bearer requests', async () => {
    await expect(caller({ origin: 'https://evil.example' }).call.ping()).resolves.toEqual({
      ok: true,
    })
    await expect(caller({ authorization: 'Bearer x' }).call.touch()).resolves.toEqual({ ok: true })
  })

  it('matches origins exactly', () => {
    const allowed = ['https://app.example.com']
    expect(isAllowedOrigin('https://app.example.com', allowed)).toBe(true)
    expect(isAllowedOrigin('https://app.example.com/', allowed)).toBe(false)
    expect(isAllowedOrigin('https://app.example.com.evil.io', allowed)).toBe(false)
    expect(isAllowedOrigin('http://app.example.com', allowed)).toBe(false)
    expect(isAllowedOrigin('null', allowed)).toBe(false)
    expect(isAllowedOrigin(null, allowed)).toBe(false)
  })
})

describe('authed procedures', () => {
  it('reject callers without a session', async () => {
    expect(await appCodeOfFailure(caller().call.whoami())).toBe('unauthorized')
  })

  it('reject a malformed or symmetric Bearer token without calling the Auth server', async () => {
    expect(await appCodeOfFailure(caller({ authorization: 'Bearer nope' }).call.whoami())).toBe(
      'unauthorized',
    )
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const hs256 = `${header}.e30.c2ln`
    expect(await appCodeOfFailure(caller({ authorization: `Bearer ${hs256}` }).call.whoami())).toBe(
      'unauthorized',
    )
  })

  it('reject cookie sessions that hold no verifiable token, without calling the Auth server', async () => {
    const stored = Buffer.from(JSON.stringify({ access_token: 'x.y.z', expires_at: 4e9 }))
    const cookie = `sb-127-auth-token=base64-${stored.toString('base64url')}`
    expect(await appCodeOfFailure(caller({ cookie }).call.whoami())).toBe('unauthorized')
  })
})

describe('isVerifiableToken', () => {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const header = { alg: 'ES256', kid: 'k1', typ: 'JWT' }
  const payload = { sub: 'u', exp: 1 }

  it('accepts an asymmetric JWT with a key id and a numeric expiry', () => {
    expect(isVerifiableToken(`${part(header)}.${part(payload)}.c2ln`)).toBe(true)
    expect(isVerifiableToken(`${part({ ...header, alg: 'RS256' })}.${part(payload)}.c2ln`)).toBe(
      true,
    )
  })

  it.each([
    ['a symmetric algorithm', `${part({ ...header, alg: 'HS256' })}.${part(payload)}.c2ln`],
    ['no algorithm', `${part({ kid: 'k1' })}.${part(payload)}.c2ln`],
    ['no key id', `${part({ alg: 'ES256' })}.${part(payload)}.c2ln`],
    ['a non-JSON header', `${Buffer.from('x').toString('base64url')}.${part(payload)}.c2ln`],
    ['a non-JSON payload', `${part(header)}.${Buffer.from('x').toString('base64url')}.c2ln`],
    ['a payload without exp', `${part(header)}.${part({ sub: 'u' })}.c2ln`],
    ['an array payload', `${part(header)}.${part([1])}.c2ln`],
    ['two parts', `${part(header)}.${part(payload)}`],
  ])('rejects %s', (_name, token) => {
    expect(isVerifiableToken(token)).toBe(false)
  })

  it('rejects non-strings', () => {
    expect(isVerifiableToken(undefined)).toBe(false)
    expect(isVerifiableToken(42)).toBe(false)
  })
})

describe('database access', () => {
  it('ctx.tenantTx needs a verified caller and never exposes the pool', async () => {
    const { ctx } = caller()
    expect('db' in ctx).toBe(false)
    const run = ctx.tenantTx(null, () => Promise.resolve('never'))
    await expect(run).rejects.toMatchObject({ appCode: 'unauthorized' })
  })
})

describe('redaction outside business procedures', () => {
  it('refuses to output sensitive fields, before the handler runs', async () => {
    let ran = false
    const leaky = router({
      leak: publicProcedure
        .output(withMeta(z.object({ cost: sensitive(zDecimal, 'cost') })))
        .query(() => {
          ran = true
          return { data: { cost: '1' }, meta: { redacted: [] } }
        }),
    })
    const ctx = createContext({
      req: new Request('http://localhost:3000/api/trpc/leak'),
      resHeaders: new Headers(),
      deps: { db: unusedDb, config },
      router: leaky,
    })
    expect(await appCodeOfFailure(createCallerFactory(leaky)(ctx).leak())).toBe('internal')
    expect(ran).toBe(false)
    expect(await appCodeOfFailure(caller().call.leak())).toBe('internal')
  })

  it('refuses untyped outputs, before the handler runs', async () => {
    let ran = false
    const untyped = router({
      raw: publicProcedure.output(z.object({ row: z.unknown() })).query(() => {
        ran = true
        return { row: { cost: '1' } }
      }),
    })
    const ctx = createContext({
      req: new Request('http://localhost:3000/api/trpc/raw'),
      resHeaders: new Headers(),
      deps: { db: unusedDb, config },
      router: untyped,
    })
    expect(await appCodeOfFailure(createCallerFactory(untyped)(ctx).raw())).toBe('internal')
    expect(ran).toBe(false)
  })
})

describe('userFromClaims', () => {
  const claims = {
    sub: '0199a3c2-5b1e-7c3a-9f00-1a2b3c4d5e6f',
    role: 'authenticated',
    aud: 'authenticated',
    email: 'rashed@example.com',
    user_metadata: { email_verified: true, locale: 'en' },
    is_anonymous: false,
    iss: 'x',
    exp: 1,
    iat: 0,
    aal: 'aal1' as const,
    session_id: 's',
    amr: [
      { method: 'password', timestamp: 1_700_000_000 },
      { method: 'otp', timestamp: 1_700_000_600 },
    ],
  }

  it('maps the claims of a signed-in user', () => {
    expect(userFromClaims('ES256', claims)).toEqual({
      userId: claims.sub,
      email: 'rashed@example.com',
      emailVerified: true,
      locale: 'en',
      authenticatedAt: 1_700_000_600,
    })
  })

  it('has no sign-in time without timestamped amr entries', () => {
    expect(userFromClaims('ES256', { ...claims, amr: ['password'] })?.authenticatedAt).toBeNull()
    expect(userFromClaims('ES256', { ...claims, amr: undefined })?.authenticatedAt).toBeNull()
  })

  it('ignores an unsupported locale', () => {
    const other = { ...claims, user_metadata: { locale: 'fr' } }
    expect(userFromClaims('ES256', other)?.locale).toBeNull()
  })

  it.each([
    ['a symmetric algorithm', 'HS256', {}],
    ['an anon token', 'ES256', { role: 'anon' }],
    ['a service token', 'ES256', { role: 'service_role' }],
    ['an anonymous user', 'ES256', { is_anonymous: true }],
    ['another audience', 'ES256', { aud: 'other' }],
    ['a non-UUID subject', 'ES256', { sub: 'admin' }],
  ])('rejects %s', (_name, algorithm, change) => {
    expect(userFromClaims(algorithm, { ...claims, ...change })).toBeNull()
  })
})

describe('assertQueryable', () => {
  const access = { visibleCategories: new Set(['supplier_price']) } as unknown as BusinessAccess

  it('allows plain and visible fields', () => {
    expect(() =>
      assertQueryable({ access }, [
        { name: 'name' },
        { name: 'lastPrice', category: 'supplier_price' },
      ]),
    ).not.toThrow()
  })

  it('forbids querying on a hidden field', () => {
    for (const field of [
      { name: 'cost', category: 'cost' as const },
      { name: 'margin', category: 'profit_margin' as const },
    ]) {
      expect(() => assertQueryable({ access }, [{ name: 'name' }, field])).toThrow(
        expect.objectContaining({ appCode: 'forbidden' }),
      )
    }
  })
})

describe('defaultDisplayName', () => {
  it('uses the local part of the email', () => {
    expect(defaultDisplayName('rashed@example.com')).toBe('rashed')
    expect(defaultDisplayName(null)).toBe('')
  })
})

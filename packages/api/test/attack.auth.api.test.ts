import type { Db } from '@bizcost/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createFetchHandler } from '../src'
import {
  connectApi,
  createUser,
  decodePayload,
  deleteUser,
  kidOf,
  query,
  sessionCookie,
  signIn,
  testConfig,
  type Session,
  type TestUser,
} from './helpers'

// ATTACK (fixed, D-061): unauthenticated requests with crafted access tokens must be answered with
// UNAUTHORIZED (401). Some shapes made supabase.auth.getClaims() throw a non-AuthError (WebCrypto
// DataError, JSON SyntaxError) that escaped resolveAuth() as INTERNAL_SERVER_ERROR (500), and every
// such request went to deps.reportError (Sentry + function log) with attacker-influenced text. Tokens
// are now checked structurally before getClaims() on both paths, and anything it throws is a 401.

function b64(value: unknown): string {
  return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString(
    'base64url',
  )
}

const reported: unknown[] = []
let db: Db
let handler: (req: Request) => Promise<Response>
let user: TestUser
let session: Session
let cookieName: string

beforeAll(async () => {
  db = connectApi()
  handler = createFetchHandler({
    db,
    config: testConfig,
    reportError: (error) => reported.push(error),
  })
  user = await createUser()
  session = await signIn(user)
  cookieName = (await sessionCookie(session)).split('=')[0] ?? ''
})

afterAll(async () => {
  await deleteUser(user)
  await db.$client.end()
})

beforeEach(() => {
  reported.length = 0
})

/** Crafted tokens: well-formed enough to pass the Bearer regex and the alg allow-list. */
function craftedTokens(): Record<string, string> {
  const kid = kidOf(session.access_token)
  const payload = {
    ...decodePayload(session.access_token),
    exp: Math.floor(Date.now() / 1000) + 600,
  }
  return {
    // RS256 is allowed by ACCEPTED_ALGORITHMS; the kid points at the real EC key, so
    // crypto.subtle.importKey() throws DataError ('Invalid JWK "kty" Parameter').
    'RS256 header with the real EC kid': `${b64({ alg: 'RS256', kid, typ: 'JWT' })}.${b64(payload)}.AAAA`,
    // decodeJWT() JSON.parse()s the payload without catching: SyntaxError.
    'ES256 header with a non-JSON payload': `${b64({ alg: 'ES256', kid, typ: 'JWT' })}.${b64('x')}.AAAA`,
  }
}

describe('crafted Bearer tokens', () => {
  const names = ['RS256 header with the real EC kid', 'ES256 header with a non-JSON payload']
  for (const name of names) {
    it(`answers 401 UNAUTHORIZED, not 500, and reports nothing: ${name}`, async () => {
      const token = craftedTokens()[name] ?? ''
      expect(token).not.toBe('')
      const result = await query(handler, 'me', { token })
      expect(result.status).toBe(401)
      expect(result.error?.data.appCode).toBe('unauthorized')
      expect(reported).toHaveLength(0)
    })
  }
})

describe('crafted cookie sessions', () => {
  const now = () => Math.floor(Date.now() / 1000)

  function cookieWith(accessToken: string): string {
    const stored = {
      access_token: accessToken,
      refresh_token: session.refresh_token,
      expires_at: now() + 3000,
      expires_in: 3000,
      token_type: 'bearer',
      user: { id: user.id },
    }
    return `${cookieName}=base64-${b64(stored)}`
  }

  it('answers 401 for an alg/key-type mismatch inside the session cookie', async () => {
    const token = craftedTokens()['RS256 header with the real EC kid'] ?? ''
    const result = await query(handler, 'me', { cookie: cookieWith(token) })
    expect(result.status).toBe(401)
    expect(result.error?.data.appCode).toBe('unauthorized')
    expect(reported).toHaveLength(0)
  })

  it('answers 401 for a non-JSON JWT header inside the session cookie', async () => {
    const result = await query(handler, 'me', { cookie: cookieWith(`${b64('x')}.${b64({})}.AAAA`) })
    expect(result.status).toBe(401)
    expect(result.error?.data.appCode).toBe('unauthorized')
    expect(reported).toHaveLength(0)
  })
})

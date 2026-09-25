import { readFileSync } from 'node:fs'
import {
  businessMembers,
  createDb,
  memberLocations,
  memberPermissionOverrides,
  rolePermissions,
  roles,
  withTenantTx,
  type Db,
} from '@bizcost/db'
import { newId, type PermissionEffect } from '@bizcost/domain'
import { roleTemplateByKey, type RoleTemplateKey } from '@bizcost/modules'
import { createServerClient } from '@supabase/ssr'
import type { AnyRouter } from '@trpc/server'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import { createFetchHandler, type ApiConfig } from '../src'

// Integration-test helpers: real users in the local Auth server, real ES256 tokens, businesses created
// through app.create_business as those users, and requests through the real fetch handler.

function env(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set (see vitest.api.config.ts)`)
  return value
}

export const SUPABASE_URL = env('SUPABASE_API_URL')
const PUBLISHABLE_KEY = env('SUPABASE_PUBLISHABLE_KEY')
export const SECRET_KEY = env('SUPABASE_SECRET_KEY')
/** The local stack's legacy HS256 secret (a public demo value), for forged-token tests. */
export const LEGACY_JWT_SECRET = env('SUPABASE_JWT_SECRET')

export const ORIGIN = 'http://localhost:3000'

export const testConfig: ApiConfig = {
  supabaseUrl: SUPABASE_URL,
  supabasePublishableKey: PUBLISHABLE_KEY,
  minSupportedAppVersion: '1.0.0',
  allowedOrigins: [ORIGIN],
  version: 'test',
}

/** Connects as `postgres` (BYPASSRLS): test setup and assertions only. */
export function connectAdmin() {
  return postgres(env('DATABASE_URL_ADMIN'), { max: 1, prepare: false, onnotice: () => {} })
}
export type Admin = ReturnType<typeof connectAdmin>

/** The API role bizcost_api, like the deployed API. */
export function connectApi(): Db {
  return createDb(env('DATABASE_URL'), { max: 1 })
}

export function handlerFor(db: Db, router?: AnyRouter, config: Partial<ApiConfig> = {}) {
  return createFetchHandler({ db, config: { ...testConfig, ...config } }, { router })
}

// ---------------------------------------------------------------------------------------------------
// Auth (GoTrue admin API with the local secret key; password sign-in with the publishable key)
// ---------------------------------------------------------------------------------------------------

export interface TestUser {
  id: string
  email: string
  password: string
  metadata: Record<string, unknown>
}

export interface Session {
  access_token: string
  refresh_token: string
}

export async function createUser(metadata: Record<string, unknown> = {}): Promise<TestUser> {
  const email = `api-${newId()}@test.bizcost.local`
  const password = `pw-${newId()}`
  const response = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: SECRET_KEY,
      authorization: `Bearer ${SECRET_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ email, password, email_confirm: true, user_metadata: metadata }),
  })
  if (!response.ok) throw new Error(`createUser failed: ${response.status}`)
  const user = (await response.json()) as { id: string }
  return { id: user.id, email, password, metadata }
}

export async function deleteUser(user: TestUser): Promise<void> {
  await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${user.id}`, {
    method: 'DELETE',
    headers: { apikey: SECRET_KEY, authorization: `Bearer ${SECRET_KEY}` },
  })
}

/**
 * Password sign-in: a real session from the Auth server. It counts against the sign-in rate limit
 * (config.toml: 30 per 5 minutes per IP), so only tests that need a real session or its refresh token
 * use it; the others use mintToken().
 */
export async function signIn(user: TestUser): Promise<Session> {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: PUBLISHABLE_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ email: user.email, password: user.password }),
  })
  if (!response.ok) throw new Error(`signIn failed: ${response.status}`)
  return (await response.json()) as Session
}

/** The Cookie header a browser would send after @supabase/ssr stored this session. */
export async function sessionCookie(session: Session): Promise<string> {
  const jar = new Map<string, string>()
  const supabase = createServerClient(SUPABASE_URL, PUBLISHABLE_KEY, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (cookies) => {
        for (const { name, value } of cookies) {
          if (value) jar.set(name, value)
          else jar.delete(name)
        }
      },
    },
  })
  const { error } = await supabase.auth.setSession(session)
  if (error) throw error
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
}

// ---------------------------------------------------------------------------------------------------
// Tokens signed outside the Auth server
// ---------------------------------------------------------------------------------------------------

function base64url(input: string | Uint8Array): string {
  return Buffer.from(input).toString('base64url')
}

export function decodePayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >
}

async function es256Sign(key: JsonWebKey, header: object, payload: object): Promise<string> {
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`
  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    { ...key, key_ops: ['sign'] },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    cryptoKey,
    new TextEncoder().encode(signingInput),
  )
  return `${signingInput}.${base64url(new Uint8Array(signature))}`
}

/** Signs claims with the local stack's real private key (supabase/signing_keys.json). */
export async function signWithLocalKey(payload: object): Promise<string> {
  const keys = JSON.parse(readFileSync(env('SIGNING_KEYS_PATH'), 'utf8')) as (JsonWebKey & {
    kid: string
  })[]
  const key = keys[0]
  if (!key) throw new Error('supabase/signing_keys.json has no key')
  return es256Sign(key, { alg: 'ES256', kid: key.kid, typ: 'JWT' }, payload)
}

/** Signs claims with a fresh ES256 key that the Auth server never published, under a real kid. */
export async function signWithForeignKey(payload: object, kid: string): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  return es256Sign(jwk, { alg: 'ES256', kid, typ: 'JWT' }, payload)
}

/**
 * An access token for `user` with the claims the Auth server puts in one, signed with the local
 * stack's real key: verified by getClaims() exactly like a token from a password sign-in, without
 * using up the sign-in rate limit. `signedInAt` (seconds) is the password sign-in time in `amr`
 * (default now).
 */
export async function mintToken(
  user: TestUser,
  options: { signedInAt?: number } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const signedInAt = options.signedInAt ?? now
  return signWithLocalKey({
    iss: `${SUPABASE_URL}/auth/v1`,
    sub: user.id,
    aud: 'authenticated',
    exp: now + 3600,
    iat: now,
    email: user.email,
    phone: '',
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: { ...user.metadata, email: user.email, email_verified: true, sub: user.id },
    role: 'authenticated',
    aal: 'aal1',
    amr: [{ method: 'password', timestamp: signedInAt }],
    session_id: newId(),
    is_anonymous: false,
  })
}

/** HS256 token signed with the given secret (e.g. the local legacy JWT secret). */
export async function signHs256(payload: object, secret: string): Promise<string> {
  const signingInput = `${base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${base64url(JSON.stringify(payload))}`
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput))
  return `${signingInput}.${base64url(new Uint8Array(signature))}`
}

export function kidOf(token: string): string {
  const header = JSON.parse(
    Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8'),
  ) as {
    kid: string
  }
  return header.kid
}

// ---------------------------------------------------------------------------------------------------
// Businesses and members (as the owner, through withTenantTx, like the future settings API)
// ---------------------------------------------------------------------------------------------------

export function tenant(userId: string, businessId: string | null) {
  return { userId, businessId, requestId: newId() }
}

export async function createBusiness(db: Db, owner: TestUser, legalName: string) {
  const business = { id: newId(), ownerRoleId: newId(), ownerMemberId: newId() }
  await withTenantTx(db, tenant(owner.id, null), (tx) =>
    tx.execute(
      sql`select app.create_business(${business.id}, ${legalName}, 'en', 'Owner', ${business.ownerRoleId}, ${business.ownerMemberId})`,
    ),
  )
  return business
}

export interface MemberSetup {
  template: RoleTemplateKey
  overrides?: { key: string; effect: PermissionEffect }[]
  locationIds?: string[]
}

/** Adds an active account member with a role copied from a code template (as Smart Setup will). */
export async function addMember(
  db: Db,
  owner: TestUser,
  businessId: string,
  user: TestUser,
  setup: MemberSetup,
): Promise<{ memberId: string; roleId: string }> {
  const template = roleTemplateByKey(setup.template)
  if (!template) throw new Error(`unknown template ${setup.template}`)
  const roleId = newId()
  const memberId = newId()
  await withTenantTx(db, tenant(owner.id, businessId), async (tx) => {
    await tx
      .insert(roles)
      .values({ id: roleId, businessId, name: template.key, templateKey: template.key })
    if (template.permissionKeys.length > 0) {
      await tx.insert(rolePermissions).values(
        template.permissionKeys.map((permissionKey) => ({
          id: newId(),
          businessId,
          roleId,
          permissionKey,
        })),
      )
    }
    await tx.insert(businessMembers).values({
      id: memberId,
      businessId,
      userId: user.id,
      kind: 'account',
      displayName: user.email,
      status: 'active',
      roleId,
    })
    for (const override of setup.overrides ?? []) {
      await tx.insert(memberPermissionOverrides).values({
        id: newId(),
        businessId,
        memberId,
        permissionKey: override.key,
        effect: override.effect,
      })
    }
    for (const locationId of setup.locationIds ?? []) {
      await tx.insert(memberLocations).values({ id: newId(), businessId, memberId, locationId })
    }
  })
  return { memberId, roleId }
}

// ---------------------------------------------------------------------------------------------------
// Calling the API over HTTP semantics (tRPC wire format, no transformer)
// ---------------------------------------------------------------------------------------------------

export interface CallOptions {
  token?: string
  cookie?: string
  businessId?: string
  headers?: Record<string, string>
  input?: unknown
}

export interface CallResult<T = unknown> {
  status: number
  headers: Headers
  data?: T
  error?: {
    message: string
    code: number
    data: { code: string; httpStatus: number; appCode: string; i18nKey: string; stack?: string }
  }
  raw: string
}

function requestHeaders(options: CallOptions): Headers {
  const headers = new Headers(options.headers)
  if (options.token) headers.set('authorization', `Bearer ${options.token}`)
  if (options.cookie) headers.set('cookie', options.cookie)
  if (options.businessId) headers.set('x-business-id', options.businessId)
  return headers
}

async function toResult<T>(response: Response): Promise<CallResult<T>> {
  const raw = await response.text()
  const body = JSON.parse(raw) as { result?: { data: T }; error?: CallResult['error'] }
  return {
    status: response.status,
    headers: response.headers,
    data: body.result?.data,
    error: body.error,
    raw,
  }
}

type Handler = (req: Request) => Promise<Response>

export async function query<T = unknown>(
  handler: Handler,
  path: string,
  options: CallOptions = {},
): Promise<CallResult<T>> {
  const search =
    options.input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(options.input))}`
  const response = await handler(
    new Request(`${ORIGIN}/api/trpc/${path}${search}`, { headers: requestHeaders(options) }),
  )
  return toResult<T>(response)
}

export async function mutate<T = unknown>(
  handler: Handler,
  path: string,
  options: CallOptions = {},
): Promise<CallResult<T>> {
  const headers = requestHeaders(options)
  headers.set('content-type', 'application/json')
  const response = await handler(
    new Request(`${ORIGIN}/api/trpc/${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(options.input ?? null),
    }),
  )
  return toResult<T>(response)
}

/** Batched GET of several queries, as httpBatchLink sends them. */
export async function batch(
  handler: Handler,
  paths: string[],
  options: CallOptions = {},
): Promise<{
  status: number
  headers: Headers
  results: { result?: { data: unknown }; error?: unknown }[]
}> {
  const input = Object.fromEntries(paths.map((_, i) => [String(i), null]))
  const response = await handler(
    new Request(
      `${ORIGIN}/api/trpc/${paths.join(',')}?batch=1&input=${encodeURIComponent(JSON.stringify(input))}`,
      { headers: requestHeaders(options) },
    ),
  )
  return { status: response.status, headers: response.headers, results: await response.json() }
}

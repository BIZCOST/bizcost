import { isLocale, isUuid, type Locale } from '@bizcost/domain'
import { createServerClient, parseCookieHeader, serializeCookieHeader } from '@supabase/ssr'
import {
  createClient,
  isAuthRetryableFetchError,
  type JwtPayload,
  type SupabaseClient,
} from '@supabase/supabase-js'
import type { ApiConfig } from './deps'
import { AppError } from './errors'

// Session check (docs/ARCHITECTURE.md §API & request flow, §Auth). Web sends the @supabase/ssr session
// cookies; mobile sends `Authorization: Bearer <access token>`. Either way the token is verified only
// with supabase.auth.getClaims(), which checks the signature locally against the project's JWKS
// (asymmetric signing keys) and the expiry. getSession()/getUser() are never trusted here.

export type AuthMode = 'bearer' | 'cookie'

/** The verified caller. */
export interface AuthUser {
  readonly userId: string
  readonly email: string | null
  /**
   * From user_metadata.email_verified: a hint for the UI only. user_metadata is writable by the user;
   * checks that need a verified email are made in the database (auth.users.email_confirmed_at).
   */
  readonly emailVerified: boolean
  /** user_metadata.locale when it is a supported locale (kept in sync with profiles.locale). */
  readonly locale: Locale | null
}

/**
 * Only tokens signed with an asymmetric key are accepted. For HS* tokens getClaims() would fall back
 * to asking the Auth server (getUser), and anyone holding the legacy JWT secret could mint them.
 */
const ACCEPTED_ALGORITHMS: ReadonlySet<string> = new Set(['ES256', 'RS256'])

/** A request that carries an Authorization header is authenticated by it alone (cookies ignored). */
export function authModeOf(req: Request): AuthMode {
  return req.headers.has('authorization') ? 'bearer' : 'cookie'
}

function bearerToken(req: Request): string | null {
  const match = /^Bearer\s+([\w-]+\.[\w-]+\.[\w-]+)$/i.exec(req.headers.get('authorization') ?? '')
  return match?.[1] ?? null
}

function jsonPart(part: string | undefined): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(part ?? '', 'base64url').toString('utf8'))
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/**
 * Cheap structural check before getClaims(): three parts, a JSON header with an accepted algorithm
 * and a key id (so auth-js verifies against the JWKS instead of asking the Auth server), and a JSON
 * payload with a numeric expiry. Anything else is not a session, and never reaches auth-js.
 */
export function isVerifiableToken(token: unknown): token is string {
  if (typeof token !== 'string') return false
  const parts = token.split('.')
  if (parts.length !== 3) return false
  const header = jsonPart(parts[0])
  const payload = jsonPart(parts[1])
  return (
    header !== null &&
    typeof header.alg === 'string' &&
    ACCEPTED_ALGORITHMS.has(header.alg) &&
    typeof header.kid === 'string' &&
    header.kid !== '' &&
    payload !== null &&
    typeof payload.exp === 'number'
  )
}

// One stateless client per configuration for Bearer tokens. The JWKS cache inside auth-js is global,
// so cookie clients (one per request) share it too.
const bearerClients = new WeakMap<ApiConfig, SupabaseClient>()

function bearerClient(config: ApiConfig): SupabaseClient {
  let client = bearerClients.get(config)
  if (!client) {
    client = createClient(config.supabaseUrl, config.supabasePublishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
    bearerClients.set(config, client)
  }
  return client
}

/**
 * Web session from cookies. A new client per request (required by @supabase/ssr). If the access token
 * is about to expire, auth-js refreshes it and the new cookies go out on this response.
 */
function cookieClient(req: Request, resHeaders: Headers, config: ApiConfig): SupabaseClient {
  return createServerClient(config.supabaseUrl, config.supabasePublishableKey, {
    cookies: {
      getAll: () =>
        parseCookieHeader(req.headers.get('cookie') ?? '').map(({ name, value }) => ({
          name,
          value: value ?? '',
        })),
      setAll: (cookies, headers) => {
        for (const { name, value, options } of cookies) {
          resHeaders.append('set-cookie', serializeCookieHeader(name, value, options))
        }
        for (const [key, value] of Object.entries(headers)) resHeaders.set(key, value)
      },
    },
  })
}

function hasAudience(claims: JwtPayload, audience: string): boolean {
  return Array.isArray(claims.aud) ? claims.aud.includes(audience) : claims.aud === audience
}

/** Maps verified claims to the caller; null for anything that is not a signed-in user's token. */
export function userFromClaims(algorithm: string | undefined, claims: JwtPayload): AuthUser | null {
  if (algorithm === undefined || !ACCEPTED_ALGORITHMS.has(algorithm)) return null
  if (claims.role !== 'authenticated' || !hasAudience(claims, 'authenticated')) return null
  if (claims.is_anonymous === true || !isUuid(claims.sub)) return null
  const email = typeof claims.email === 'string' && claims.email !== '' ? claims.email : null
  const metadata: Record<string, unknown> =
    claims.user_metadata && typeof claims.user_metadata === 'object' ? claims.user_metadata : {}
  return {
    userId: claims.sub.toLowerCase(),
    email,
    emailVerified: email !== null && metadata.email_verified === true,
    locale: isLocale(metadata.locale) ? metadata.locale : null,
  }
}

/**
 * Why a token could not be verified. Only an unreachable Auth server (JWKS or refresh) is a server
 * fault; everything else (a bad signature, an expired token, a key of the wrong type, malformed JSON,
 * whether auth-js returns it or throws it) means "not signed in", is never reported and costs 401.
 */
function rejectOrThrow(error: unknown): null {
  if (isAuthRetryableFetchError(error)) throw new AppError('internal', { cause: error })
  return null
}

async function verify(client: SupabaseClient, token: unknown): Promise<AuthUser | null> {
  if (!isVerifiableToken(token)) return null
  try {
    const { data, error } = await client.auth.getClaims(token)
    if (error) return rejectOrThrow(error)
    return data ? userFromClaims(data.header.alg, data.claims) : null
  } catch (error) {
    return rejectOrThrow(error)
  }
}

/** Verifies the caller of a request; null when it carries no valid user token. */
export async function resolveAuth(
  req: Request,
  resHeaders: Headers,
  config: ApiConfig,
): Promise<AuthUser | null> {
  if (authModeOf(req) === 'bearer') return verify(bearerClient(config), bearerToken(req))

  if (!req.headers.has('cookie')) return null
  const client = cookieClient(req, resHeaders, config)
  // Reads the stored session (refreshing it when it is about to expire). Nothing in it is trusted:
  // only its access token is used, and it is verified like a Bearer token.
  let token: unknown
  try {
    const { data, error } = await client.auth.getSession()
    if (error) return rejectOrThrow(error)
    token = data.session?.access_token
  } catch (error) {
    return rejectOrThrow(error)
  }
  return verify(client, token)
}

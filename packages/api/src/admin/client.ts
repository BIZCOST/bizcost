import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { ApiConfig } from '../deps'
import { AppError } from '../errors'

// The Supabase admin client with the secret key (docs/ARCHITECTURE.md §Secrets & server-only code):
// the Auth admin API (account deletion) and Storage (signed URLs for business files). Lint lets only
// the account and business profile services import src/admin.

/** Fails before any change when the secret key is not configured (e.g. a local .env without it). */
export function assertSecretKey(config: ApiConfig, purpose: string): string {
  if (!config.supabaseSecretKey) {
    throw new AppError('internal', {
      message: `SUPABASE_SECRET_KEY is not set: ${purpose} needs the Supabase secret key`,
    })
  }
  return config.supabaseSecretKey
}

/** fetch that gives up (the request fails with a TimeoutError) after `timeoutMs`. */
function fetchWithin(timeoutMs: number): typeof fetch {
  return (input, init) => {
    const timeout = AbortSignal.timeout(timeoutMs)
    return fetch(input, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
    })
  }
}

const clients = new WeakMap<ApiConfig, Map<number, SupabaseClient>>()

/**
 * The admin client of this configuration. With `timeoutMs`, each of its requests gives up after that
 * long (a client of its own per timeout); without it, a request waits as long as fetch does.
 */
export function adminClient(config: ApiConfig, purpose: string, timeoutMs = 0): SupabaseClient {
  const secretKey = assertSecretKey(config, purpose)
  let byTimeout = clients.get(config)
  if (!byTimeout) {
    byTimeout = new Map()
    clients.set(config, byTimeout)
  }
  let client = byTimeout.get(timeoutMs)
  if (!client) {
    client = createClient(config.supabaseUrl, secretKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      ...(timeoutMs > 0 ? { global: { fetch: fetchWithin(timeoutMs) } } : {}),
    })
    byTimeout.set(timeoutMs, client)
  }
  return client
}

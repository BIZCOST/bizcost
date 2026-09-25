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

const clients = new WeakMap<ApiConfig, SupabaseClient>()

export function adminClient(config: ApiConfig, purpose: string): SupabaseClient {
  const secretKey = assertSecretKey(config, purpose)
  let client = clients.get(config)
  if (!client) {
    client = createClient(config.supabaseUrl, secretKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
    clients.set(config, client)
  }
  return client
}

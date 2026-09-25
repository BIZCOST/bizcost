import type { AuthClient } from '@bizcost/app-core'
import { secureSessionCookies } from '@bizcost/contracts'
import { createBrowserClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'

// supabase-js in the browser, for Auth only (sign-in, codes, token refresh); all data goes through
// tRPC (docs/ARCHITECTURE.md §Overview). @supabase/ssr keeps the session in cookies, so the server
// (proxy.ts, /api/trpc, server components) sees the same session.

let client: SupabaseClient | undefined

export function supabaseBrowser(): SupabaseClient {
  if (typeof window === 'undefined') {
    throw new Error('supabaseBrowser() runs in the browser only')
  }
  if (!client) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    if (!url || !key) {
      throw new Error(
        'NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be set',
      )
    }
    client = createBrowserClient(url, key, {
      cookieOptions: { secure: secureSessionCookies(window.location.href) },
    })
  }
  return client
}

const auth = () => supabaseBrowser().auth

/**
 * The auth client the app-core flows take. Flows are created while a page renders (also on the
 * server), so the browser client is only created when a flow actually calls Supabase.
 */
const lazyAuthClient: AuthClient = {
  signUp: (credentials) => auth().signUp(credentials),
  signInWithPassword: (credentials) => auth().signInWithPassword(credentials),
  signInWithOtp: (credentials) => auth().signInWithOtp(credentials),
  verifyOtp: (params) => auth().verifyOtp(params),
  resend: (credentials) => auth().resend(credentials),
  resetPasswordForEmail: (email, options) => auth().resetPasswordForEmail(email, options),
  updateUser: (attributes, options) => auth().updateUser(attributes, options),
  signOut: (options) => auth().signOut(options),
}

export function authClient(): AuthClient {
  return lazyAuthClient
}

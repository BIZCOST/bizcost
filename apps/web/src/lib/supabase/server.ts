import 'server-only'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { serverEnv } from '../env'

/**
 * The signed-in user's email from the verified session (server components). Only for display: the
 * API verifies the caller itself. proxy.ts has already refreshed the session, and a server
 * component cannot write cookies, so refreshed cookies are ignored here.
 */
export async function sessionEmail(): Promise<string | null> {
  const env = serverEnv()
  const cookieStore = await cookies()
  const supabase = createServerClient(env.supabaseUrl, env.supabasePublishableKey, {
    cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} },
  })
  const { data } = await supabase.auth.getClaims()
  const email = data?.claims?.email
  return typeof email === 'string' && email !== '' ? email : null
}

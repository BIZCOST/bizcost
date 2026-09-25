import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * The part of supabase-js Auth the flows use. Apps inject their own client (web: the @supabase/ssr
 * browser client; mobile: supabase-js with LargeSecureStore); tests inject a fake.
 */
export type AuthClient = Pick<
  SupabaseClient['auth'],
  | 'signUp'
  | 'signInWithPassword'
  | 'signInWithOtp'
  | 'verifyOtp'
  | 'resend'
  | 'resetPasswordForEmail'
  | 'updateUser'
  | 'signOut'
>

/** Emails are compared and sent trimmed and lowercased (the code is tied to the exact address). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

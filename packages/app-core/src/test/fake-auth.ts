import { AuthApiError } from '@supabase/supabase-js'
import { vi, type Mock } from 'vitest'
import type { AuthClient } from '../auth/client'

// A supabase-js Auth fake: every method resolves `{ data, error: null }` unless a test queues an error.

type Method = keyof AuthClient
const METHODS: Method[] = [
  'signUp',
  'signInWithPassword',
  'signInWithOtp',
  'verifyOtp',
  'resend',
  'resetPasswordForEmail',
  'updateUser',
  'signOut',
]

export type FakeAuth = Record<Method, Mock>

export function fakeAuth(): { auth: AuthClient; calls: FakeAuth } {
  const calls = Object.fromEntries(
    METHODS.map((method) => [
      method,
      vi.fn().mockResolvedValue({ data: { user: null, session: null }, error: null }),
    ]),
  ) as FakeAuth
  return { auth: calls as unknown as AuthClient, calls }
}

/** A Supabase Auth API error with a code, as the server sends it. */
export function apiError(code: string, status = 400): AuthApiError {
  return new AuthApiError(`message for ${code}`, status, code)
}

/** Makes `method` resolve with `error` once. */
export function failOnce(calls: FakeAuth, method: Method, error: unknown): void {
  calls[method].mockResolvedValueOnce({ data: { user: null, session: null }, error })
}

/** A clock the test moves by hand. */
export function fakeClock(start = 1_000_000) {
  let now = start
  return { now: () => now, advance: (ms: number) => void (now += ms) }
}

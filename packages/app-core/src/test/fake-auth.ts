import { AuthApiError } from '@supabase/supabase-js'
import { vi, type Mock } from 'vitest'
import type { AuthClient } from '../auth/client'

// A supabase-js Auth fake: every method resolves `{ data, error: null }` unless a test queues an error.
// verifyOtp signs FAKE_USER in (FAKE_SESSION), and getSession returns that session.

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
  'getSession',
]

/** A confirmed account: its address was confirmed long before a recovery code was sent. */
export const FAKE_USER = {
  id: '00000000-0000-4000-8000-000000000001',
  email_confirmed_at: '2026-01-01T00:00:00.000000Z',
  recovery_sent_at: '2026-09-25T09:00:00.000000Z',
}

const base64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')

/** An access token as supabase-js stores it (claims only; nothing here checks the signature). */
export function fakeAccessToken(claims: Record<string, unknown>): string {
  return `${base64url({ alg: 'ES256', typ: 'JWT' })}.${base64url(claims)}.signature`
}

/** A session of `user` (default FAKE_USER) with the given `session_id` claim. */
export function fakeSession(user: { id: string } = FAKE_USER, sessionId = 'fake-session') {
  return {
    user,
    access_token: fakeAccessToken({ sub: user.id, session_id: sessionId, role: 'authenticated' }),
    refresh_token: `refresh-${sessionId}`,
  }
}

const EMPTY = { data: { user: null, session: null }, error: null }
const SIGNED_IN: Partial<Record<Method, unknown>> = {
  verifyOtp: { data: { user: FAKE_USER, session: fakeSession() }, error: null },
  getSession: { data: { session: fakeSession() }, error: null },
}

export type FakeAuth = Record<Method, Mock>

export function fakeAuth(): { auth: AuthClient; calls: FakeAuth } {
  const calls = Object.fromEntries(
    METHODS.map((method) => [method, vi.fn().mockResolvedValue(SIGNED_IN[method] ?? EMPTY)]),
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

/** Makes the next getSession find `user`'s session (the code's session id), or none (signed out). */
export function sessionOnce(calls: FakeAuth, user: { id: string } | null): void {
  calls.getSession.mockResolvedValueOnce({
    data: { session: user ? fakeSession(user) : null },
    error: null,
  })
}

/** A clock the test moves by hand. */
export function fakeClock(start = 1_000_000) {
  let now = start
  return { now: () => now, advance: (ms: number) => void (now += ms) }
}

import type { AuthClient } from '@bizcost/app-core'
import { describe, expect, it, vi } from 'vitest'
import { withCaptcha } from './captcha'

type Call = [string, ...unknown[]]

function fakeClient() {
  const calls: Call[] = []
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args])
      return Promise.resolve({ data: {}, error: null })
    }
  const client = {
    signUp: record('signUp'),
    signInWithPassword: record('signInWithPassword'),
    signInWithOtp: record('signInWithOtp'),
    verifyOtp: record('verifyOtp'),
    resend: record('resend'),
    resetPasswordForEmail: record('resetPasswordForEmail'),
    updateUser: record('updateUser'),
    signOut: record('signOut'),
    getSession: record('getSession'),
  } as unknown as AuthClient
  return { client, calls }
}

const email = 'owner@example.test'

describe('withCaptcha (D-352)', () => {
  it('puts a fresh token on every call Supabase Auth guards, keeping its options', async () => {
    const { client, calls } = fakeClient()
    let issued = 0
    const wrapped = withCaptcha(client, () => Promise.resolve(`token-${++issued}`))
    await wrapped.signUp({ email, password: 'abcd1234', options: { data: { locale: 'ar' } } })
    await wrapped.signInWithPassword({ email, password: 'abcd1234' })
    await wrapped.signInWithOtp({ email, options: { shouldCreateUser: false } })
    await wrapped.resend({ type: 'signup', email })
    await wrapped.resetPasswordForEmail(email, { redirectTo: 'https://app.example.test' })
    expect(calls).toEqual([
      [
        'signUp',
        {
          email,
          password: 'abcd1234',
          options: { data: { locale: 'ar' }, captchaToken: 'token-1' },
        },
      ],
      ['signInWithPassword', { email, password: 'abcd1234', options: { captchaToken: 'token-2' } }],
      ['signInWithOtp', { email, options: { shouldCreateUser: false, captchaToken: 'token-3' } }],
      ['resend', { type: 'signup', email, options: { captchaToken: 'token-4' } }],
      [
        'resetPasswordForEmail',
        email,
        { redirectTo: 'https://app.example.test', captchaToken: 'token-5' },
      ],
    ])
  })

  it('asks for no token on what Auth does not guard', async () => {
    const { client, calls } = fakeClient()
    const tokens = vi.fn(() => Promise.resolve('token'))
    const wrapped = withCaptcha(client, tokens)
    await wrapped.verifyOtp({ email, token: '123456', type: 'email' })
    await wrapped.updateUser({ password: 'abcd1234' })
    await wrapped.signOut({ scope: 'local' })
    await wrapped.getSession()
    expect(tokens).not.toHaveBeenCalled()
    expect(calls.map(([name]) => name)).toEqual([
      'verifyOtp',
      'updateUser',
      'signOut',
      'getSession',
    ])
  })

  it('sends each call as it is when there is no token (CAPTCHA off, the local stack)', async () => {
    const { client, calls } = fakeClient()
    const wrapped = withCaptcha(client, () => Promise.resolve(undefined))
    await wrapped.signInWithPassword({ email, password: 'abcd1234' })
    await wrapped.resetPasswordForEmail(email)
    expect(calls).toEqual([
      ['signInWithPassword', { email, password: 'abcd1234' }],
      ['resetPasswordForEmail', email, undefined],
    ])
  })
})

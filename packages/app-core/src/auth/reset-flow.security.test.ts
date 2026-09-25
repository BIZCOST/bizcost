import { describe, expect, it } from 'vitest'
import { fakeAuth } from '../test/fake-auth'
import { createPasswordReset } from './reset-flow'

// ATTACK (security review of the D-071 reset), kept as a regression test: the new password must go
// only through the session the recovery code created (docs/DECISIONS.md D-063/D-071), not through
// any later session of the same user.

const USER = { id: '00000000-0000-4000-8000-000000000001' }
const PASSWORD = 'a-new-password-1'

const base64url = (value: object) =>
  btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** An access token as supabase-js stores it (claims only; nothing here verifies the signature). */
function accessToken(sessionId: string, issuedAt: number): string {
  const claims = {
    sub: USER.id,
    session_id: sessionId,
    iat: issuedAt,
    aud: 'authenticated',
    role: 'authenticated',
  }
  return `${base64url({ alg: 'ES256', typ: 'JWT' })}.${base64url(claims)}.signature`
}

function session(sessionId: string, issuedAt: number) {
  return {
    user: USER,
    access_token: accessToken(sessionId, issuedAt),
    refresh_token: `refresh-${sessionId}-${issuedAt}`,
  }
}

async function onPasswordStep(current: ReturnType<typeof session>) {
  const { auth, calls } = fakeAuth()
  calls.verifyOtp.mockResolvedValueOnce({
    data: { user: USER, session: session('from-the-recovery-code', 1) },
    error: null,
  })
  calls.getSession.mockResolvedValue({ data: { session: current }, error: null })
  const flow = createPasswordReset({ auth, email: 'a@b.co' })
  expect(await flow.verify('123456')).toBe(true)
  flow.choosePassword()
  return { flow, calls }
}

describe('createPasswordReset: which session may set the new password', () => {
  it('refuses a later session of the same user (signed out and back in from another tab)', async () => {
    // Tab A: the code was accepted and the choice is still open. Tab B: "Sign out", then a new
    // sign-in as the same user (the cookies are shared). Tab A's new password now goes through a
    // session the code never created.
    const { flow, calls } = await onPasswordStep(session('a-later-sign-in', 2))
    expect(await flow.savePassword(PASSWORD)).toBe(false)
    expect(calls.updateUser).not.toHaveBeenCalled()
    expect(flow.getState().step).toBe('ended')
  })

  it('still accepts the verified session after a token refresh (same session, new tokens)', async () => {
    const { flow, calls } = await onPasswordStep(session('from-the-recovery-code', 3))
    expect(await flow.savePassword(PASSWORD)).toBe(true)
    expect(calls.updateUser).toHaveBeenCalledWith({ password: PASSWORD })
  })
})

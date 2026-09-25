import type { SentCode } from '@bizcost/app-core'
import { useEffect, useState } from 'react'

// The address a code was just sent to, handed from one auth page to the next (login/signup →
// verify, forgot → reset). Kept in sessionStorage (this tab only) instead of the URL, so the email
// never lands in history, logs or referrers, and a reload keeps the resend countdown and a planned
// automatic resend.

export type PendingPurpose = 'signUp' | 'signIn' | 'recovery'

export interface PendingCode {
  email: string
  purpose: PendingPurpose
  /** When the last code was sent (epoch ms). */
  sentAt: number
  /**
   * The request was answered "too soon", so no code was sent yet: the code page sends it again once
   * at this time (epoch ms, D-073). Removed once that has run.
   */
  retryAt?: number
  /** Shown above the code form. */
  notice?: 'confirmEmailFirst'
  /**
   * The reset code was accepted in this tab. Opened again (a reload, Back), the page no longer
   * knows the session was just verified, so it offers no password change (D-071).
   */
  verified?: true
  /** The reset code confirmed the address, so a new password is required (D-071). */
  passwordRequired?: true
}

const KEY = 'bz_pending_code'

function isPendingCode(value: unknown): value is PendingCode {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.email === 'string' &&
    (v.purpose === 'signUp' || v.purpose === 'signIn' || v.purpose === 'recovery') &&
    typeof v.sentAt === 'number' &&
    (v.retryAt === undefined || typeof v.retryAt === 'number')
  )
}

export function savePending(pending: PendingCode): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(pending))
  } catch {
    // Storage blocked: the next page sends the user back to start again.
  }
}

export function readPending(): PendingCode | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(KEY) ?? 'null')
    return isPendingCode(value) ? value : null
  } catch {
    return null
  }
}

/**
 * The code this tab last asked for with `purpose`, if it went out and was not used: no automatic
 * resend is planned for it and (a reset code) it was not accepted. A "too soon" answer to the same
 * request is about it, so it is not sent again (D-073).
 */
export function sentCode(purpose: PendingPurpose): SentCode | null {
  const pending = readPending()
  return pending?.purpose === purpose && pending.retryAt === undefined && !pending.verified
    ? { email: pending.email, sentAt: pending.sentAt }
    : null
}

export function clearPending(): void {
  try {
    sessionStorage.removeItem(KEY)
  } catch {
    // Nothing to clear.
  }
}

/**
 * The pending code of this tab for the given purposes: undefined until read (after mount, so server
 * and browser render the same), then the value or null.
 */
export function usePending(purposes: readonly PendingPurpose[]): PendingCode | null | undefined {
  const [pending, setPending] = useState<PendingCode | null | undefined>(undefined)
  const key = purposes.join(',')
  useEffect(() => {
    const value = readPending()
    setPending(value && key.split(',').includes(value.purpose) ? value : null)
  }, [key])
  return pending
}

import { useEffect, useState } from 'react'

// The address a code was just sent to, handed from one auth page to the next (login/signup →
// verify, forgot → reset). Kept in sessionStorage (this tab only) instead of the URL, so the email
// never lands in history, logs or referrers, and a reload keeps the resend countdown.

export type PendingPurpose = 'signUp' | 'signIn' | 'recovery'

export interface PendingCode {
  email: string
  purpose: PendingPurpose
  /** When the last code was sent (epoch ms). */
  sentAt: number
  /** Shown above the code form. */
  notice?: 'confirmEmailFirst'
}

const KEY = 'bz_pending_code'

function isPendingCode(value: unknown): value is PendingCode {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.email === 'string' &&
    (v.purpose === 'signUp' || v.purpose === 'signIn' || v.purpose === 'recovery') &&
    typeof v.sentAt === 'number'
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

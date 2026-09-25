import { AUTH_OTP_LENGTH, AUTH_RESEND_COOLDOWN_SECONDS } from '@bizcost/contracts'
import { normalizeDigits } from '@bizcost/domain'

/**
 * A typed or pasted email code as ASCII digits: Arabic-Indic digits become 0-9, everything else
 * (spaces, dashes, a pasted sentence) is dropped, and the result is cut to AUTH_OTP_LENGTH.
 */
export function normalizeCode(input: string): string {
  return normalizeDigits(input).replace(/\D/g, '').slice(0, AUTH_OTP_LENGTH)
}

export function isCompleteCode(code: string): boolean {
  return code.length === AUTH_OTP_LENGTH && /^\d+$/.test(code)
}

/** When another code may be requested after one was sent at `sentAt` (epoch ms). */
export function resendAvailableAt(sentAt: number): number {
  return sentAt + AUTH_RESEND_COOLDOWN_SECONDS * 1000
}

/** Whole seconds left until `until` (epoch ms), never negative: 0 means "now". */
export function secondsUntil(until: number, now: number): number {
  return Math.max(0, Math.ceil((until - now) / 1000))
}

// Notices shown on the sign-in page after leaving the app (?notice=…). Only these fixed values are
// read from the URL; nothing personal travels in it.

export const NOTICE_KEYS = {
  'signed-out': 'auth.notices.signedOut',
  'signed-out-everywhere': 'auth.notices.signedOutEverywhere',
  'account-deleted': 'auth.notices.accountDeleted',
  'session-ended': 'auth.notices.sessionEnded',
} as const

export type Notice = keyof typeof NOTICE_KEYS

export function parseNotice(value: unknown): Notice | undefined {
  return typeof value === 'string' && Object.hasOwn(NOTICE_KEYS, value)
    ? (value as Notice)
    : undefined
}

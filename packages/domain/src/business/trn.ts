import { normalizeDigits } from '../numbers/digits'

// UAE Tax Registration Number: 15 digits. Users often paste it with spaces or dashes,
// or type it with Arabic digits.

export const TRN_LENGTH = 15

export type TrnError = 'required' | 'invalid_chars' | 'invalid_length'

export type TrnResult = { ok: true; value: string } | { ok: false; error: TrnError }

export function parseTrn(input: string): TrnResult {
  const compact = normalizeDigits(input).replace(/[\s\-‎‏]/g, '')
  if (compact === '') return { ok: false, error: 'required' }
  if (!/^\d+$/.test(compact)) return { ok: false, error: 'invalid_chars' }
  if (compact.length !== TRN_LENGTH) return { ok: false, error: 'invalid_length' }
  return { ok: true, value: compact }
}

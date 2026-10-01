import type { UpdateProductCostSettingsInput } from '@bizcost/contracts'
import { compareDecimal, type CurrencyCode } from '@bizcost/domain'
import { readAmount, type FieldError } from '../catalog/numbers'

// Settings → How costs are worked out (M2 Step 6; D-119, D-202): without a team, the owner's hourly
// rate, as typed (either language's digits): empty for "not set" (null), else an amount above zero
// with at most the currency's decimals. Running costs need no setting (they reach what the business
// sells by its price, D-202).

/** An amount as typed: empty (not set, null) or more than zero. */
export function readSetting(
  input: string,
  currency: CurrencyCode,
): { ok: true; value: string | null } | { ok: false; error: FieldError } {
  if (input.trim() === '') return { ok: true, value: null }
  return readAmount(input, { positive: true, currency })
}

/** The same amount as stored: both not set, or equal as numbers ("30000" and "30000.00"). */
export function sameAmount(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b
  return compareDecimal(a, b) === 0
}

/**
 * productCost.updateSettings's input for the typed hourly rate; null when it did not change from
 * `saved` (or does not read: `errors` says so).
 */
export function settingsChange(
  typed: { readonly hourlyRate: string },
  saved: { readonly hourlyRate: string | null },
  currency: CurrencyCode,
): {
  errors: { hourlyRate?: FieldError }
  input: UpdateProductCostSettingsInput | null
} {
  const read = readSetting(typed.hourlyRate, currency)
  if (!read.ok) return { errors: { hourlyRate: read.error }, input: null }
  if (sameAmount(read.value, saved.hourlyRate)) return { errors: {}, input: null }
  return { errors: {}, input: { ownerHourlyRate: read.value } }
}

import type { UpdateProductCostSettingsInput } from '@bizcost/contracts'
import { compareDecimal, type CurrencyCode } from '@bizcost/domain'
import { readAmount, type FieldError } from '../catalog/numbers'

// Settings → How costs are worked out (M2 Step 6; D-116, D-119): the owner's estimate of the
// materials bought a month and, without a team, the owner's hourly rate, as typed (either language's
// digits). Each is empty for "not set" (null), else an amount above zero with at most the currency's
// decimals. Only what changed is sent: productCost.updateSettings keeps a field left out.

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
 * productCost.updateSettings's input for the typed values, with only the fields that changed from
 * `saved`; null when nothing changed (or a value does not read: `errors` says which).
 */
export function settingsChange(
  typed: { readonly estimate?: string; readonly hourlyRate?: string },
  saved: { readonly estimate: string | null; readonly hourlyRate: string | null },
  currency: CurrencyCode,
): {
  errors: { estimate?: FieldError; hourlyRate?: FieldError }
  input: UpdateProductCostSettingsInput | null
} {
  const errors: { estimate?: FieldError; hourlyRate?: FieldError } = {}
  const input: { estimatedMonthlyPurchases?: string | null; ownerHourlyRate?: string | null } = {}
  if (typed.estimate !== undefined) {
    const read = readSetting(typed.estimate, currency)
    if (!read.ok) errors.estimate = read.error
    else if (!sameAmount(read.value, saved.estimate)) input.estimatedMonthlyPurchases = read.value
  }
  if (typed.hourlyRate !== undefined) {
    const read = readSetting(typed.hourlyRate, currency)
    if (!read.ok) errors.hourlyRate = read.error
    else if (!sameAmount(read.value, saved.hourlyRate)) input.ownerHourlyRate = read.value
  }
  if (errors.estimate || errors.hourlyRate || Object.keys(input).length === 0) {
    return { errors, input: null }
  }
  return { errors, input }
}

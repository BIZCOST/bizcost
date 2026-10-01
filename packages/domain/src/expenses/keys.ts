import { exactProduct, plain, roundHalfUp, toDec } from '../numbers/decimal'
import { COST_SCALE, type CostAmount } from '../numbers/kinds'

// Stored values of the expenses and running-costs tables of M2 Step 5 (docs/DATA_MODEL.md §6:
// cost_categories, expenses, expense_payments, running_costs). The database CHECK constraints list
// the same values; pure code (contracts, the API, the web) reads them from here.

/**
 * `expenses.status` (PRODUCT.md §4 rule 13, D-164): a draft changes nothing; with approval on (a
 * business setting shown only with a team), an expense is sent for approval (`submitted`), then
 * `approved` or `rejected` (a rejected expense is edited like a draft); `posted` counts it (the word
 * in the app is "Finalize"); a posted expense is never edited, it is `reversed`.
 */
export const EXPENSE_STATUSES = [
  'draft',
  'submitted',
  'approved',
  'rejected',
  'posted',
  'reversed',
] as const
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number]

/**
 * The starter categories of the one list that expenses and running costs share (D-116: the owner's
 * list). Each business gets them once, named in its language (i18n `setup.cost_categories.<key>`);
 * then they are plain data: renamed, archived or added to like any other.
 */
export const STARTER_COST_CATEGORIES = [
  'rent',
  'electricity',
  'water',
  'salaries',
  'internet',
  'phone',
  'licences',
  'insurance',
  'software',
  'vehicles',
  'marketing',
  'equipment',
  'maintenance',
  'other',
] as const
export type StarterCostCategory = (typeof STARTER_COST_CATEGORIES)[number]

/** `running_costs.frequency`: how often the regular amount is paid (monthly by default). */
export const RUNNING_COST_FREQUENCIES = ['weekly', 'monthly', 'quarterly', 'yearly'] as const
export type RunningCostFrequency = (typeof RUNNING_COST_FREQUENCIES)[number]

/** Periods of each frequency in a year (a year has 52 weeks here, as people count them). */
export const PER_YEAR: Readonly<Record<RunningCostFrequency, string>> = {
  weekly: '52',
  monthly: '12',
  quarterly: '4',
  yearly: '1',
}

/**
 * A running cost's regular amount as a monthly amount (the Running Costs screen): amount × periods a
 * year ÷ 12, an exact product divided once and rounded once to 12 decimals (a cost-engine value,
 * never rounded to the currency; D-107). Weekly 1 200 → 5 200; quarterly 900 → 300; yearly 1 000 →
 * 83.333333333333.
 */
export function monthlyAmount(amount: string, frequency: RunningCostFrequency): CostAmount {
  const perYear = exactProduct([toDec(amount), toDec(PER_YEAR[frequency])])
  return plain(roundHalfUp(perYear.dividedBy(12), COST_SCALE)) as CostAmount
}

/**
 * What running costs come to in a month (the Running Costs screen's monthly total): Σ amount ×
 * periods a year, exact, divided by 12 once and rounded once to 12 decimals. It may differ from the
 * sum of the rounded monthlyAmount of each in the 12th decimal, never more.
 */
export function monthlyTotal(
  costs: readonly { readonly amount: string; readonly frequency: RunningCostFrequency }[],
): CostAmount {
  let perYear = toDec('0')
  for (const cost of costs) {
    perYear = perYear.plus(exactProduct([toDec(cost.amount), toDec(PER_YEAR[cost.frequency])]))
  }
  return plain(roundHalfUp(perYear.dividedBy(12), COST_SCALE)) as CostAmount
}

/**
 * Whether a running cost counts on `day` (YYYY-MM-DD): it has started (`startsOn` on or before the
 * day) and has not stopped (`endsOn` null, or after the day). `endsOn` is the day it stopped: it no
 * longer counts from that day, so a rent that stops on the day the new one starts is counted once
 * (D-176; daysRunIn counts the days of a month the same way, D-202).
 */
export function runningCostActiveOn(
  cost: { readonly startsOn: string; readonly endsOn: string | null },
  day: string,
): boolean {
  return cost.startsOn <= day && (cost.endsOn === null || cost.endsOn > day)
}

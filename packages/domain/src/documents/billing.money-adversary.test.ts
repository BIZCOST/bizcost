import { describe, expect, it } from 'vitest'
import type { Money, Percent } from '../numbers/kinds'
import {
  billingError,
  billingState,
  billPart,
  paymentStageAmounts,
  type BillingPart,
} from './billing'

// Money adversary of M3 Step 7 (billing in parts, Q22, and the payment stages of the owner's request of
// 2026-10-16). Step 8's stage invoices will bill a quotation's payment stages one after another; the two
// halves of billing.ts must agree on the same schedule. As D-283 decided, a % part is the total × % ÷
// 100 rounded once, so a schedule is billed by the amounts its stages stored (paymentStageAmounts, frozen
// with the sent quotation) or with its last part as "the rest": either way the parts bill exactly the
// total, as the stages share it. A state never says 100 % while something is left. Fictional amounts.

const m = (value: string) => value as Money
const p = (value: string) => value as Percent

/** Bills `parts` one after another with billPart, as Step 8's stage invoices would. */
function bill(total: string, parts: readonly BillingPart[]) {
  const billed: Money[] = []
  const plans = []
  for (const part of parts) {
    const error = billingError(m(total), billed, part, 'AED')
    expect(
      error,
      `billing ${JSON.stringify(part)} after ${billed.join(' + ') || 'nothing'}`,
    ).toBeNull()
    const plan = billPart(m(total), billed, part, 'AED')
    billed.push(plan.amount)
    plans.push(plan)
  }
  return plans
}

describe('billing the payment stages in parts (Q22)', () => {
  it('50 % then the rest of 100.01: the last stage bills exactly what is left (as the stages share it)', () => {
    expect(paymentStageAmounts(m('100.01'), [p('50'), p('50')], 'AED')).toEqual(['50.01', '50.00'])
    const plans = bill('100.01', [{ percent: p('50') }, { rest: true }])
    expect(plans.map((plan) => plan.amount)).toEqual(['50.01', '50.00'])
    expect(plans.at(-1)).toMatchObject({ last: true, after: { done: true, left: '0.00' } })
  })

  it('thirds billed by the amounts the stages stored bill the whole 100.00, not 99.99', () => {
    const stages = paymentStageAmounts(m('100.00'), ['33.3333', '33.3333', '33.3334'].map(p), 'AED')
    expect(stages).toEqual(['33.33', '33.33', '33.34'])
    const plans = bill(
      '100.00',
      stages.map((amount) => ({ amount })),
    )
    expect(plans.map((plan) => plan.amount)).toEqual(['33.33', '33.33', '33.34'])
    expect(plans.at(-1)).toMatchObject({
      last: true,
      after: { done: true, billedPercent: '100.00' },
    })
  })

  it('billedPercent says 100.00 only once everything is billed', () => {
    // 99,999.99 of 100,000.00 is 99.99999 %: rounded to "100.00" while 0.01 is still left to bill.
    const state = billingState(m('100000.00'), [m('99999.99')], 'AED')
    expect(state).toMatchObject({ left: '0.01', done: false })
    expect(state.billedPercent).not.toBe('100.00')
    expect(state.billedPercent).toBe('99.99')
    // The other edge (D-296): something billed never reads as 0.00.
    expect(billingState(m('100000.00'), [m('0.01')], 'AED').billedPercent).toBe('0.01')
    expect(billingState(m('100000.00'), [m('100000.00')], 'AED').billedPercent).toBe('100.00')
  })
})

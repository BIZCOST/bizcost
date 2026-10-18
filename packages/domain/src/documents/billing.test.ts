import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { plain, toDec } from '../numbers/decimal'
import type { Money, Percent } from '../numbers/kinds'
import {
  billingError,
  billingState,
  billPart,
  PAYMENT_STAGES_MAX,
  paymentStageAmounts,
  paymentStagesError,
} from './billing'

// Billing in parts (Q22) and a quotation's payment stages (the owner's request of 2026-10-16): goldens
// from the plan (the fit-out's 30 / 40 / 30 stages, the owner's 50 / 35 / 15) and properties: never
// above what is left, the last part exactly the rest, the stages adding up exactly.

const m = (value: string) => value as Money
const p = (value: string) => value as Percent

describe('billing: goldens', () => {
  it('a fit-out quote of 14,411.25 billed 30 %, 40 %, then the rest', () => {
    const first = billPart(m('14411.25'), [], { percent: p('30') }, 'AED')
    expect(first).toMatchObject({ amount: '4323.38', last: false })
    expect(first.after).toEqual({
      total: '14411.25',
      billed: '4323.38',
      left: '10087.87',
      billedPercent: '30.00',
      done: false,
    })
    const second = billPart(m('14411.25'), [first.amount], { percent: p('40') }, 'AED')
    expect(second.amount).toBe('5764.50')
    const rest = billPart(m('14411.25'), [first.amount, second.amount], { rest: true }, 'AED')
    expect(rest).toMatchObject({ amount: '4323.37', last: true })
    expect(rest.after.done).toBe(true)
    expect(rest.after.billedPercent).toBe('100.00')
  })

  it('a deposit as an amount, then a % that comes to all that is left is the last part', () => {
    const deposit = billPart(m('1000.00'), [], { amount: m('250') }, 'AED')
    expect(deposit).toMatchObject({ amount: '250.00', last: false })
    expect(billPart(m('1000.00'), ['250.00' as Money], { percent: p('75') }, 'AED')).toMatchObject({
      amount: '750.00',
      last: true,
    })
  })

  it('refuses more than is left, more than 100 %, nothing, too many decimals, and a finished one', () => {
    const billed = [m('600.00')]
    expect(billingError(m('1000.00'), billed, { percent: p('50') }, 'AED')).toBe('over_left')
    expect(billingError(m('1000.00'), [], { percent: p('100.5') }, 'AED')).toBe('over_100_percent')
    expect(billingError(m('1000.00'), [], { percent: p('0') }, 'AED')).toBe('not_positive')
    expect(billingError(m('1000.00'), [], { percent: p('0.0001') }, 'AED')).toBe('not_positive')
    expect(billingError(m('1000.00'), [], { amount: m('0') }, 'AED')).toBe('not_positive')
    expect(billingError(m('1000.00'), [], { amount: m('10.005') }, 'AED')).toBe('too_many_decimals')
    expect(billingError(m('1000.00'), billed, { amount: m('400.01') }, 'AED')).toBe('over_left')
    expect(billingError(m('1000.00'), [m('1000.00')], { rest: true }, 'AED')).toBe('nothing_left')
    expect(billingError(m('1000.00'), billed, { rest: true }, 'AED')).toBeNull()
    expect(() => billPart(m('1000.00'), billed, { percent: p('50') }, 'AED')).toThrow(RangeError)
  })

  it('a state of what was billed; bills past the total are malformed', () => {
    expect(billingState(m('0'), [], 'AED')).toEqual({
      total: '0.00',
      billed: '0.00',
      left: '0.00',
      billedPercent: '100.00',
      done: true,
    })
    expect(() => billingState(m('100'), [m('60'), m('41')], 'AED')).toThrow(RangeError)
    expect(() => billingState(m('-1'), [], 'AED')).toThrow(RangeError)
    expect(billingState(m('10.000'), [m('3.333')], 'KWD').left).toBe('6.667')
  })
})

describe('billing: properties', () => {
  const cents = (min: number, max: number) =>
    fc.integer({ min, max }).map((n) => plain(toDec(String(n)).dividedBy(100)))
  const part = fc.oneof(
    fc
      .integer({ min: 1, max: 10_000 })
      .map((n) => ({ percent: p(plain(toDec(String(n)).dividedBy(100))) })),
    cents(1, 5_000_000).map((amount) => ({ amount: m(amount) })),
    fc.constant({ rest: true as const }),
  )

  it('parts never pass the total, and the last one takes exactly the rest', () => {
    fc.assert(
      fc.property(cents(1, 10_000_000), fc.array(part, { maxLength: 12 }), (total, parts) => {
        const billed: Money[] = []
        for (const next of parts) {
          if (billingError(m(total), billed, next, 'AED') !== null) continue
          const plan = billPart(m(total), billed, next, 'AED')
          billed.push(plan.amount)
          const sum = billed.reduce((acc, value) => acc.plus(toDec(value)), toDec('0'))
          expect(sum.lte(toDec(total))).toBe(true)
          expect(plan.last).toBe(sum.eq(toDec(total)))
          expect(plan.after.done).toBe(plan.last)
        }
      }),
    )
  })
})

describe('payment stages', () => {
  it('the owner’s terms: 50 / 35 / 15 of 16,100.00', () => {
    expect(paymentStageAmounts(m('16100.00'), [p('50'), p('35'), p('15')], 'AED')).toEqual([
      '8050.00',
      '5635.00',
      '2415.00',
    ])
  })

  it('thirds of 100.00 add up exactly, the last taking the rest', () => {
    expect(
      paymentStageAmounts(m('100.00'), [p('33.3333'), p('33.3333'), p('33.3334')], 'AED'),
    ).toEqual(['33.33', '33.33', '33.34'])
  })

  it('a tiny total never gives a stage below zero', () => {
    expect(paymentStageAmounts(m('0.02'), [p('25'), p('25'), p('25'), p('25')], 'AED')).toEqual([
      '0.01',
      '0.00',
      '0.01',
      '0.00',
    ])
  })

  it('refuses a schedule that is not 100 %, a zero stage, too many decimals or stages', () => {
    expect(paymentStagesError([])).toBeNull()
    expect(paymentStagesError([p('50'), p('40')])).toEqual({ code: 'not_100_percent' })
    expect(paymentStagesError([p('100'), p('0')])).toEqual({ code: 'not_positive', stage: 1 })
    expect(paymentStagesError([p('120')])).toEqual({ code: 'over_100_percent', stage: 0 })
    expect(paymentStagesError([p('33.33333'), p('66.66667')])).toEqual({
      code: 'too_many_decimals',
      stage: 0,
    })
    expect(
      paymentStagesError(Array.from({ length: PAYMENT_STAGES_MAX + 1 }, () => p('1'))),
    ).toEqual({ code: 'too_many_stages' })
    expect(() => paymentStageAmounts(m('100'), [p('60')], 'AED')).toThrow(RangeError)
  })

  it('property: the stages add up to the total exactly, none below zero, each but the last as rounded', () => {
    const schedule = fc
      .array(fc.integer({ min: 1, max: 5000 }), { minLength: 1, maxLength: PAYMENT_STAGES_MAX })
      .map((weights) => {
        // Hundredths of a % that add up to 100.00.
        const sum = weights.reduce((a, b) => a + b, 0)
        const parts = weights.map((w) => Math.max(1, Math.floor((w * 10_000) / sum)))
        parts[parts.length - 1]! += 10_000 - parts.reduce((a, b) => a + b, 0)
        return parts
      })
      .filter((parts) => parts.every((part) => part > 0))
      .map((parts) => parts.map((part) => p(plain(toDec(String(part)).dividedBy(100)))))
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000_000 }).map((n) => plain(toDec(String(n)).dividedBy(100))),
        schedule,
        (total, percents) => {
          const amounts = paymentStageAmounts(m(total), percents, 'AED')
          const sum = amounts.reduce((acc, value) => acc.plus(toDec(value)), toDec('0'))
          expect(sum.eq(toDec(total))).toBe(true)
          // Each stage within half a fils of its exact share per other stage (the last carries them).
          const slack = toDec('0.005').times(amounts.length)
          for (const [i, amount] of amounts.entries()) {
            expect(toDec(amount).gte(0)).toBe(true)
            const exact = toDec(total).times(toDec(percents[i]!)).dividedBy(100)
            expect(toDec(amount).minus(exact).abs().lte(slack)).toBe(true)
          }
        },
      ),
    )
  })
})

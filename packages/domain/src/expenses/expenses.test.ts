import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { computePurchase } from '../documents/purchase'
import { subtractDecimals, sumDecimals } from '../documents/split'
import { toDec } from '../numbers/decimal'
import type { Money, Percent, Quantity } from '../numbers/kinds'
import { vatInCost } from '../purchasing/keys'
import { computeExpense, expenseError } from './amounts'
import {
  expenseActions,
  expenseTransition,
  EXPENSE_ACTIONS,
  type ExpenseAction,
  type ExpenseActionContext,
} from './approval'
import {
  EXPENSE_STATUSES,
  monthlyAmount,
  monthlyTotal,
  runningCostActiveOn,
  RUNNING_COST_FREQUENCIES,
  type ExpenseStatus,
} from './keys'

// Expenses and running costs (M2 Step 5; D-114 rule 4, D-116, D-157, D-164, D-165).

const money = (value: string) => value as Money
const rate = (value: string) => value as Percent

describe('computeExpense: one amount, before VAT or with it', () => {
  it('before VAT: 100 + 5 % = 105; VAT out of the cost on a tax invoice of a registered business', () => {
    const amounts = computeExpense(
      { amount: money('100'), vatRate: rate('5'), pricesIncludeVat: false, vatInCost: false },
      'AED',
    )
    expect(amounts).toEqual({ net: '100.00', vat: '5.00', total: '105.00', cost: '100.00' })
  })

  it('including VAT: 105 is 100 + 5; the VAT is part of the cost when it cannot be reclaimed', () => {
    const amounts = computeExpense(
      { amount: money('105'), vatRate: rate('5'), pricesIncludeVat: true, vatInCost: true },
      'AED',
    )
    expect(amounts).toEqual({ net: '100.00', vat: '5.00', total: '105.00', cost: '105.00' })
  })

  it('rounds the VAT to the fils once: 10 including 5 % is 9.52 + 0.48', () => {
    expect(
      computeExpense(
        { amount: money('10'), vatRate: rate('5'), pricesIncludeVat: true, vatInCost: false },
        'AED',
      ),
    ).toEqual({ net: '9.52', vat: '0.48', total: '10.00', cost: '9.52' })
  })

  it('three decimals in KWD', () => {
    expect(
      computeExpense(
        { amount: money('12.345'), vatRate: rate('5'), pricesIncludeVat: false, vatInCost: true },
        'KWD',
      ),
    ).toEqual({ net: '12.345', vat: '0.617', total: '12.962', cost: '12.962' })
  })

  it('no VAT: what was paid is net, total and cost', () => {
    for (const pricesIncludeVat of [false, true]) {
      expect(
        computeExpense(
          { amount: money('250.5'), vatRate: rate('0'), pricesIncludeVat, vatInCost: true },
          'AED',
        ),
      ).toEqual({ net: '250.50', vat: '0.00', total: '250.50', cost: '250.50' })
    }
  })

  it('refuses what is not an amount it can store as typed', () => {
    const at = (amount: string, vatRate = '5') =>
      expenseError({ amount: money(amount), vatRate: rate(vatRate) }, 'AED')
    expect(at('0')).toBe('amount_not_positive')
    expect(at('-1')).toBe('amount_not_positive')
    expect(at('10.005')).toBe('too_many_decimals')
    expect(at('10.500')).toBeNull()
    expect(at('10', '-1')).toBe('negative_vat_rate')
    expect(at('10', '100.5')).toBe('vat_rate_over_100')
    expect(() =>
      computeExpense(
        { amount: money('1.001'), vatRate: rate('0'), pricesIncludeVat: false, vatInCost: true },
        'AED',
      ),
    ).toThrow(RangeError)
  })

  it('the VAT rule of D-114 rule 4 through vatInCost: registered × tax invoice × marked', () => {
    const cases = [
      // registered, document, not reclaimable → VAT in cost
      [true, 'tax_invoice', false, false],
      [true, 'tax_invoice', true, true],
      [true, 'non_tax_invoice', false, true],
      [true, 'no_invoice', false, true],
      [false, 'tax_invoice', false, true],
      [false, 'no_invoice', false, true],
    ] as const
    for (const [vatRegistered, documentType, vatNotReclaimable, inCost] of cases) {
      const flag = vatInCost({ vatRegistered, documentType, vatNotReclaimable })
      expect(flag).toBe(inCost)
      const amounts = computeExpense(
        { amount: money('210'), vatRate: rate('5'), pricesIncludeVat: true, vatInCost: flag },
        'AED',
      )
      expect(amounts.cost).toBe(inCost ? '210.00' : '200.00')
    }
  })

  const minor = fc
    .bigInt({ min: 1n, max: 100_000_000n })
    .map((n) => money(`${n / 100n}.${String(n % 100n).padStart(2, '0')}`))
  const rates = fc.constantFrom('0', '5', '7.5', '15', '100').map(rate)

  it('always adds up: net + VAT = total, cost = net (+ VAT in cost), nothing negative', () => {
    fc.assert(
      fc.property(minor, rates, fc.boolean(), fc.boolean(), (amount, vatRate, incl, inCost) => {
        const a = computeExpense(
          { amount, vatRate, pricesIncludeVat: incl, vatInCost: inCost },
          'AED',
        )
        expect(sumDecimals([a.net, a.vat])).toBe(sumDecimals([a.total]))
        expect(sumDecimals([a.cost])).toBe(sumDecimals(inCost ? [a.net, a.vat] : [a.net]))
        expect(toDec(a.net).gte(0) && toDec(a.vat).gte(0)).toBe(true)
        if (incl) expect(subtractDecimals(a.total, amount)).toBe('0')
        else expect(subtractDecimals(a.net, amount)).toBe('0')
      }),
    )
  })

  it('is the purchase line maths: one line of quantity 1 gives the same figures', () => {
    fc.assert(
      fc.property(minor, rates, fc.boolean(), fc.boolean(), (amount, vatRate, incl, inCost) => {
        const expense = computeExpense(
          { amount, vatRate, pricesIncludeVat: incl, vatInCost: inCost },
          'AED',
        )
        const purchase = computePurchase(
          {
            lines: [{ kind: 'material', qty: '1' as Quantity, unitPrice: amount, vatRate }],
            vatInCost: inCost,
            pricesIncludeVat: incl,
          },
          'AED',
        )
        expect(expense).toEqual({
          net: purchase.net,
          vat: purchase.vat,
          total: purchase.total,
          cost: purchase.cost,
        })
      }),
    )
  })

  it('a bill typed with its VAT gives the figures of the same bill typed before VAT', () => {
    fc.assert(
      fc.property(minor, rates, (net, vatRate) => {
        const before = computeExpense(
          { amount: net, vatRate, pricesIncludeVat: false, vatInCost: false },
          'AED',
        )
        const incl = computeExpense(
          { amount: before.total, vatRate, pricesIncludeVat: true, vatInCost: false },
          'AED',
        )
        // Taking the VAT out of the rounded total can move it by one fils at most.
        const diff = toDec(subtractDecimals(incl.vat, before.vat)).abs()
        expect(diff.lte('0.01')).toBe(true)
        expect(incl.total).toBe(before.total)
      }),
    )
  })
})

describe('monthlyAmount: a regular amount per month (D-116)', () => {
  it.each([
    ['1000', 'monthly', '1000'],
    ['1200', 'weekly', '5200'],
    ['900', 'quarterly', '300'],
    ['1000', 'yearly', '83.333333333333'],
    ['100', 'yearly', '8.333333333333'],
    ['7', 'weekly', '30.333333333333'],
    ['0.01', 'quarterly', '0.003333333333'],
    ['2', 'yearly', '0.166666666667'],
  ] as const)('%s %s = %s a month', (amount, frequency, monthly) => {
    expect(monthlyAmount(amount, frequency)).toBe(monthly)
  })

  it('a year of months comes back to a year of periods (to the 12th decimal)', () => {
    fc.assert(
      fc.property(
        fc
          .bigInt({ min: 1n, max: 10_000_000_000n })
          .map((n) => `${n / 100n}.${String(n % 100n).padStart(2, '0')}`),
        fc.constantFrom(...RUNNING_COST_FREQUENCIES),
        (amount, frequency) => {
          const perYear = { weekly: 52, monthly: 12, quarterly: 4, yearly: 1 }[frequency]
          const year = toDec(monthlyAmount(amount, frequency)).times(12)
          const exact = toDec(amount).times(perYear)
          // One rounding to 12 decimals, times 12.
          expect(year.minus(exact).abs().lte('0.000000000006')).toBe(true)
        },
      ),
    )
  })
})

describe('monthlyTotal: Σ of the running costs, divided once (D-116)', () => {
  it('adds each at its frequency and divides by 12 once', () => {
    // 15 000 a month + 12 000 a year + 900 a quarter + 100 a week: 180 000 + 12 000 + 3 600 + 5 200
    // = 200 800 a year = 16 733.333333333333 a month.
    expect(
      monthlyTotal([
        { amount: '15000', frequency: 'monthly' },
        { amount: '12000', frequency: 'yearly' },
        { amount: '900', frequency: 'quarterly' },
        { amount: '100', frequency: 'weekly' },
      ]),
    ).toBe('16733.333333333333')
    expect(monthlyTotal([])).toBe('0')
  })

  it('stays within a unit in the 12th decimal of the sum of the monthly amounts', () => {
    const cost = fc.record({
      amount: fc
        .bigInt({ min: 1n, max: 100_000_000n })
        .map((n) => `${n / 100n}.${String(n % 100n).padStart(2, '0')}`),
      frequency: fc.constantFrom(...RUNNING_COST_FREQUENCIES),
    })
    fc.assert(
      fc.property(fc.array(cost, { maxLength: 20 }), (costs) => {
        const total = toDec(monthlyTotal(costs))
        const summed = costs.reduce(
          (sum, c) => sum.plus(monthlyAmount(c.amount, c.frequency)),
          toDec('0'),
        )
        expect(
          total
            .minus(summed)
            .abs()
            .lte(toDec('0.000000000001').times(costs.length + 1)),
        ).toBe(true)
      }),
    )
  })
})

describe('runningCostActiveOn', () => {
  it('counts from its start up to the day before it stopped (D-176)', () => {
    const cost = { startsOn: '2026-09-01', endsOn: '2027-01-01' }
    expect(runningCostActiveOn(cost, '2026-08-31')).toBe(false)
    expect(runningCostActiveOn(cost, '2026-09-01')).toBe(true)
    expect(runningCostActiveOn(cost, '2026-12-31')).toBe(true)
    expect(runningCostActiveOn(cost, '2027-01-01')).toBe(false)
    // A rent that stops on the day the new one starts: one of them counts that day, never both.
    const next = { startsOn: '2027-01-01', endsOn: null }
    expect(
      [cost, next].filter((c) => runningCostActiveOn(c, '2027-01-01')).map((c) => c.startsOn),
    ).toEqual(['2027-01-01'])
    expect(runningCostActiveOn({ startsOn: '2026-09-01', endsOn: null }, '2030-01-01')).toBe(true)
  })
})

describe('expenseTransition: the approval state machine (D-164)', () => {
  const ctx = (
    status: ExpenseStatus,
    approvalRequired = true,
    mayApprove = false,
  ): ExpenseActionContext => ({ status, approvalRequired, mayApprove })

  it('without approval: draft → posted → reversed; submitting is refused', () => {
    expect(expenseTransition('post', ctx('draft', false))).toEqual({
      ok: true,
      to: 'posted',
      changes: true,
    })
    expect(expenseTransition('submit', ctx('draft', false))).toEqual({
      ok: false,
      refusal: 'approval_off',
    })
    expect(expenseTransition('reverse', ctx('posted', false))).toMatchObject({ to: 'reversed' })
  })

  it('with approval: a member who may not approve sends it; an approver approves; then it posts', () => {
    expect(expenseTransition('post', ctx('draft'))).toEqual({
      ok: false,
      refusal: 'approval_required',
    })
    expect(expenseTransition('submit', ctx('draft'))).toMatchObject({ to: 'submitted' })
    expect(expenseTransition('post', ctx('submitted'))).toEqual({
      ok: false,
      refusal: 'approval_required',
    })
    expect(expenseTransition('approve', ctx('submitted'))).toMatchObject({ to: 'approved' })
    expect(expenseTransition('post', ctx('approved'))).toMatchObject({ to: 'posted' })
  })

  it('an approver may post a draft or a submitted expense directly', () => {
    expect(expenseTransition('post', ctx('draft', true, true))).toMatchObject({ to: 'posted' })
    expect(expenseTransition('post', ctx('submitted', true, true))).toMatchObject({
      to: 'posted',
    })
  })

  it('a submitted or approved expense is frozen until rejected; a rejected one is edited as a draft', () => {
    for (const status of ['submitted', 'approved'] as const) {
      expect(expenseTransition('update', ctx(status))).toEqual({
        ok: false,
        refusal: 'expense_in_approval',
      })
      expect(expenseTransition('discard', ctx(status))).toEqual({
        ok: false,
        refusal: 'expense_in_approval',
      })
      expect(expenseTransition('reject', ctx(status))).toMatchObject({ to: 'rejected' })
    }
    expect(expenseTransition('update', ctx('rejected'))).toMatchObject({ to: 'draft' })
    expect(expenseTransition('submit', ctx('rejected'))).toMatchObject({ to: 'submitted' })
    expect(expenseTransition('approve', ctx('rejected'))).toEqual({
      ok: false,
      refusal: 'expense_not_submitted',
    })
    expect(expenseTransition('approve', ctx('draft'))).toEqual({
      ok: false,
      refusal: 'expense_not_submitted',
    })
  })

  it('repeating an action is a no-op, never a second change', () => {
    expect(expenseTransition('submit', ctx('submitted'))).toEqual({
      ok: true,
      to: 'submitted',
      changes: false,
    })
    expect(expenseTransition('approve', ctx('approved'))).toMatchObject({ changes: false })
    expect(expenseTransition('reject', ctx('rejected'))).toMatchObject({ changes: false })
    expect(expenseTransition('post', ctx('posted'))).toMatchObject({ changes: false })
    expect(expenseTransition('post', ctx('reversed'))).toMatchObject({
      to: 'reversed',
      changes: false,
    })
    expect(expenseTransition('reverse', ctx('reversed'))).toMatchObject({ changes: false })
  })

  it('a final expense is never changed except by its reversal', () => {
    for (const status of ['posted', 'reversed'] as const) {
      for (const action of ['update', 'discard', 'submit', 'approve', 'reject'] as const) {
        expect(expenseTransition(action, ctx(status))).toEqual({
          ok: false,
          refusal: 'document_posted',
        })
      }
    }
    for (const status of ['draft', 'submitted', 'approved', 'rejected'] as const) {
      expect(expenseTransition('reverse', ctx(status))).toEqual({
        ok: false,
        refusal: 'document_not_posted',
      })
    }
  })

  it('invariants over every status, action and setting', () => {
    const statuses = fc.constantFrom(...EXPENSE_STATUSES)
    const actions = fc.constantFrom(...EXPENSE_ACTIONS)
    fc.assert(
      fc.property(statuses, actions, fc.boolean(), fc.boolean(), (status, action, req, may) => {
        const t = expenseTransition(action, { status, approvalRequired: req, mayApprove: may })
        if (!t.ok) return
        // Only posting reaches posted, only reversing reversed.
        if (t.changes && t.to === 'posted') expect(action).toBe('post')
        if (t.changes && t.to === 'reversed') expect(action).toBe('reverse')
        // With approval, nothing reaches posted from a draft without an approver.
        if (t.changes && t.to === 'posted' && req && status !== 'approved') expect(may).toBe(true)
        // A no-op leaves the status as it is.
        if (!t.changes) expect(t.to).toBe(status)
        // Nothing leaves a reversed expense.
        if (status === 'reversed') expect(t.changes).toBe(false)
      }),
    )
  })

  it('expenseActions lists what would change it', () => {
    const offered = (status: ExpenseStatus, req: boolean, may: boolean): ExpenseAction[] =>
      expenseActions({ status, approvalRequired: req, mayApprove: may })
    expect(offered('draft', false, false)).toEqual(['update', 'discard', 'post'])
    expect(offered('draft', true, false)).toEqual(['update', 'discard', 'submit'])
    expect(offered('draft', true, true)).toEqual(['update', 'discard', 'submit', 'post'])
    expect(offered('submitted', true, true)).toEqual(['approve', 'reject', 'post'])
    expect(offered('approved', true, false)).toEqual(['reject', 'post'])
    expect(offered('posted', true, true)).toEqual(['reverse'])
    expect(offered('reversed', true, true)).toEqual([])
  })
})

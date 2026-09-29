import { describe, expect, it } from 'vitest'
import { checkPayment, paymentDraft } from './payment-draft'

const CONTEXT = {
  currency: 'AED' as const,
  outstanding: '105.00',
  documentDate: '2026-09-20',
  today: '2026-09-29',
  closedThrough: null,
}

describe('a payment of what is owed', () => {
  it('starts today with all that is still owed and no method', () => {
    expect(paymentDraft('105', '2026-09-29', 'AED')).toEqual({
      businessDate: '2026-09-29',
      method: '',
      amount: '105.00',
      note: '',
    })
  })

  it('may be part of what is owed, never more, in the currency’s minor unit', () => {
    const draft = { ...paymentDraft('105', CONTEXT.today, 'AED'), method: 'cash' as const }
    expect(checkPayment({ ...draft, amount: '٤٠' }, CONTEXT).fields).toEqual({
      businessDate: '2026-09-29',
      method: 'cash',
      amount: '40',
      note: null,
    })
    expect(checkPayment({ ...draft, amount: '105.01' }, CONTEXT).errors.amount).toEqual({
      key: 'errors.exceeds_outstanding',
    })
    expect(checkPayment({ ...draft, amount: '10.005' }, CONTEXT).errors.amount?.key).toBe(
      'catalog.numbers.tooManyDecimals',
    )
    expect(checkPayment({ ...draft, amount: '0' }, CONTEXT).errors.amount?.key).toBe(
      'catalog.numbers.positive',
    )
  })

  it('needs how it was paid, and a day from the purchase to today, not in closed books', () => {
    const draft = paymentDraft('105', CONTEXT.today, 'AED')
    expect(checkPayment(draft, CONTEXT)).toMatchObject({
      errors: { method: { key: 'purchasing.payment.methodRequired' } },
      fields: null,
    })
    const cash = { ...draft, method: 'cash' as const }
    expect(
      checkPayment({ ...cash, businessDate: '2026-09-30' }, CONTEXT).errors.businessDate,
    ).toEqual({ key: 'errors.future_date' })
    expect(
      checkPayment({ ...cash, businessDate: '2026-09-19' }, CONTEXT).errors.businessDate,
    ).toEqual({ key: 'purchasing.payment.beforePurchase' })
    expect(
      checkPayment(
        { ...cash, businessDate: '2026-09-25' },
        { ...CONTEXT, closedThrough: '2026-09-25' },
      ).errors.businessDate,
    ).toEqual({ key: 'purchasing.payment.booksClosed' })
  })

  it('of an expense: never before the expense (D-166)', () => {
    const cash = { ...paymentDraft('105', CONTEXT.today, 'AED'), method: 'cash' as const }
    expect(
      checkPayment({ ...cash, businessDate: '2026-09-19' }, { ...CONTEXT, kind: 'expense' }).errors
        .businessDate,
    ).toEqual({ key: 'purchasing.payment.beforeExpense' })
    expect(
      checkPayment({ ...cash, businessDate: '2026-09-20' }, { ...CONTEXT, kind: 'expense' }).fields,
    ).toMatchObject({ businessDate: '2026-09-20', amount: '105' })
  })
})

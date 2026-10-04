import type { ExpenseDto } from '@bizcost/contracts'
import { describe, expect, it } from 'vitest'
import {
  checkExpense,
  expenseDraft,
  EXTRA,
  paysChoiceOf,
  paysInputOf,
  periodMonthOptions,
  withDocumentType,
  withPeriodDefault,
  type ExpenseDraft,
} from './expense-draft'

// The expense form (M2 Step 5; D-114, D-157, D-159, D-168): checked as the API checks it, with the
// amounts of the domain's maths as it is typed.

const TODAY = '2026-09-29'
const RENT = '0190a4f2-7b5c-7c3e-9b1a-2f3c4d5e6f70'
const SUPPLIER = '0190a4f2-7b5c-7c3e-9b1a-2f3c4d5e6f71'
const SALMA = '0190a4f2-7b5c-7c3e-9b1a-2f3c4d5e6f72'
const STAFF_SALARIES = '0190a4f2-7b5c-7c3e-9b1a-2f3c4d5e6f73'
const DEWA = '0190a4f2-7b5c-7c3e-9b1a-2f3c4d5e6f74'
const REGISTERED = { currency: 'AED' as const, vatRegistered: true, today: TODAY }
const NOT_REGISTERED = { ...REGISTERED, vatRegistered: false }

function filled(patch: Partial<ExpenseDraft> = {}, vatRegistered = true): ExpenseDraft {
  return {
    ...expenseDraft(undefined, { today: TODAY, vatRegistered }),
    amount: '100',
    categoryId: RENT,
    paymentMethod: 'cash',
    ...patch,
  }
}

describe('a new expense', () => {
  it('starts today, without category or payment method; a tax invoice with 5% before VAT', () => {
    expect(expenseDraft(undefined, { today: TODAY, vatRegistered: true })).toMatchObject({
      amount: '',
      categoryId: '',
      paymentMethod: '',
      businessDate: TODAY,
      documentType: 'tax_invoice',
      vatRate: '5',
      pricesIncludeVat: false,
    })
    // Without VAT: another invoice, typed as paid.
    expect(expenseDraft(undefined, { today: TODAY, vatRegistered: false })).toMatchObject({
      documentType: 'non_tax_invoice',
      vatRate: '0',
      pricesIncludeVat: true,
    })
  })

  it('says what is missing, and gives nothing to save until it is there', () => {
    const empty = expenseDraft(undefined, { today: TODAY, vatRegistered: true })
    const checked = checkExpense(empty, REGISTERED)
    expect(checked.fields).toBeNull()
    expect(checked.errors).toMatchObject({
      amount: { key: 'catalog.numbers.required' },
      category: { key: 'expenses.editor.errors.category' },
      paymentMethod: { key: 'purchasing.editor.errors.paymentMethod' },
    })
  })
})

describe('the amounts, before VAT or with it (D-157)', () => {
  it('100 before 5% VAT is 100 + 5 = 105; 105 with VAT is the same bill', () => {
    expect(checkExpense(filled(), REGISTERED).amounts).toEqual({
      net: '100.00',
      vat: '5.00',
      total: '105.00',
    })
    expect(
      checkExpense(filled({ amount: '105', pricesIncludeVat: true }), REGISTERED).amounts,
    ).toEqual({ net: '100.00', vat: '5.00', total: '105.00' })
  })

  it('a business that is not VAT-registered types what it paid, with no VAT', () => {
    const checked = checkExpense(
      filled({ amount: '١٠٥', vatRate: '5', pricesIncludeVat: false }, false),
      NOT_REGISTERED,
    )
    expect(checked.amounts).toEqual({ net: '105.00', vat: '0.00', total: '105.00' })
    expect(checked.fields).toMatchObject({ amount: '105', vatRate: '0', pricesIncludeVat: false })
  })

  it('refuses an amount of zero or with more decimals than the currency', () => {
    expect(checkExpense(filled({ amount: '0' }), REGISTERED).errors.amount?.key).toBe(
      'catalog.numbers.positive',
    )
    expect(checkExpense(filled({ amount: '10.005' }), REGISTERED).errors.amount?.key).toBe(
      'catalog.numbers.tooManyDecimals',
    )
    expect(checkExpense(filled({ amount: 'abc' }), REGISTERED).amounts.total).toBe('0')
  })

  it('a new document type moves the VAT and the "with VAT" switch until the person chose', () => {
    const draft = filled()
    expect(
      withDocumentType(draft, 'no_invoice', { vatRegistered: true, vatModeChosen: false }),
    ).toMatchObject({ documentType: 'no_invoice', vatRate: '0', pricesIncludeVat: true })
    expect(
      withDocumentType(draft, 'no_invoice', { vatRegistered: true, vatModeChosen: true }),
    ).toMatchObject({ vatRate: '0', pricesIncludeVat: false })
    // A rate the person chose stays.
    expect(
      withDocumentType({ ...draft, vatRate: '0' }, 'non_tax_invoice', {
        vatRegistered: true,
        vatModeChosen: false,
      }).vatRate,
    ).toBe('0')
  })
})

describe('how it was paid (D-159, D-166)', () => {
  it('on credit needs the supplier; paid by an employee names who', () => {
    expect(
      checkExpense(filled({ paymentMethod: 'supplier_credit' }), REGISTERED).errors.paymentMethod
        ?.key,
    ).toBe('purchasing.editor.errors.paymentMethodSupplier')
    expect(
      checkExpense(filled({ paymentMethod: 'supplier_credit', supplierId: SUPPLIER }), REGISTERED)
        .fields,
    ).toMatchObject({ paymentMethod: 'supplier_credit', supplierId: SUPPLIER })
    expect(
      checkExpense(filled({ paymentMethod: 'paid_by_member' }), REGISTERED).errors.paymentMethod
        ?.key,
    ).toBe('purchasing.editor.errors.paymentMethodMember')
    const payers = new Set([SALMA])
    expect(
      checkExpense(filled({ paymentMethod: 'paid_by_member', paidByMemberId: SALMA }), {
        ...REGISTERED,
        payers,
      }).fields,
    ).toMatchObject({ paymentMethod: 'paid_by_member', paidByMemberId: SALMA })
    // Someone who left the business since the draft was saved.
    expect(
      checkExpense(filled({ paymentMethod: 'paid_by_member', paidByMemberId: SUPPLIER }), {
        ...REGISTERED,
        payers,
      }).errors.paymentMethod?.key,
    ).toBe('purchasing.editor.errors.payerLeft')
    // Another method never sends who paid.
    expect(
      checkExpense(filled({ paymentMethod: 'card', paidByMemberId: SALMA }), REGISTERED).fields
        ?.paidByMemberId,
    ).toBeNull()
  })
})

describe('the fields to save', () => {
  it('trims the text, leaves out what is empty, and keeps "VAT can’t be reclaimed" to a tax invoice', () => {
    const fields = checkExpense(
      filled({
        description: '  Delivery  ',
        reference: ' ',
        notes: '',
        vatNotReclaimable: true,
      }),
      REGISTERED,
    ).fields
    expect(fields).toEqual({
      categoryId: RENT,
      supplierId: null,
      businessDate: TODAY,
      periodMonth: '2026-09',
      documentType: 'tax_invoice',
      reference: null,
      description: 'Delivery',
      paymentMethod: 'cash',
      paidByMemberId: null,
      pricesIncludeVat: false,
      locationId: null,
      vatNotReclaimable: true,
      amount: '100',
      vatRate: '5',
      notes: null,
    })
    expect(
      checkExpense(filled({ documentType: 'no_invoice', vatNotReclaimable: true }), REGISTERED)
        .fields?.vatNotReclaimable,
    ).toBe(false)
  })

  it('refuses a day after today, a category no longer in the list, and text too long', () => {
    expect(
      checkExpense(filled({ businessDate: '2026-09-30' }), REGISTERED).errors.businessDate,
    ).toEqual({ key: 'errors.future_date' })
    expect(
      checkExpense(filled(), { ...REGISTERED, categories: new Set<string>() }).errors.category,
    ).toEqual({ key: 'expenses.editor.errors.categoryGone' })
    expect(
      checkExpense(filled({ description: 'x'.repeat(201) }), REGISTERED).errors.description,
    ).toEqual({ key: 'purchasing.tooLong', values: { count: 200 } })
  })

  it('a saved draft opens as it is stored', () => {
    const saved = {
      amount: '105',
      vatRate: '5',
      pricesIncludeVat: true,
      categoryId: RENT,
      businessDate: '2026-09-28',
      documentType: 'tax_invoice',
      paymentMethod: 'paid_by_member',
      paidByMemberId: SALMA,
      supplierId: null,
      description: 'Milk run',
      reference: null,
      locationId: null,
      vatNotReclaimable: false,
      notes: null,
    } as unknown as ExpenseDto
    expect(expenseDraft(saved, { today: TODAY, vatRegistered: true })).toEqual({
      amount: '105',
      vatRate: '5',
      pricesIncludeVat: true,
      categoryId: RENT,
      businessDate: '2026-09-28',
      documentType: 'tax_invoice',
      paymentMethod: 'paid_by_member',
      paidByMemberId: SALMA,
      supplierId: '',
      description: 'Milk run',
      reference: '',
      locationId: null,
      vatNotReclaimable: false,
      notes: '',
      pays: '',
    })
  })
})

describe('"For which month?" (the request of 2026-09-30, D-194)', () => {
  it('starts at the month of the bill, and follows the category and the day until one is picked', () => {
    const draft = expenseDraft(undefined, { today: TODAY, vatRegistered: true })
    expect(draft.periodMonth).toBe('2026-09')
    // Electricity: its bills come the month after, so a bill of 3 October is for September.
    const electricity = withPeriodDefault(
      { ...draft, businessDate: '2026-10-03' },
      { chosen: false, billedNextMonth: true },
    )
    expect(electricity.periodMonth).toBe('2026-09')
    // Rent: the bill's own month.
    expect(
      withPeriodDefault(
        { ...draft, businessDate: '2026-10-03' },
        { chosen: false, billedNextMonth: false },
      ).periodMonth,
    ).toBe('2026-10')
    // A January bill of the month after is for December of the year before.
    expect(
      withPeriodDefault(
        { ...draft, businessDate: '2027-01-05' },
        { chosen: false, billedNextMonth: true },
      ).periodMonth,
    ).toBe('2026-12')
    // Picked by the person: kept.
    expect(
      withPeriodDefault(
        { ...draft, periodMonth: '2026-06', businessDate: '2026-10-03' },
        { chosen: true, billedNextMonth: true },
      ).periodMonth,
    ).toBe('2026-06')
  })

  it('is sent, from 12 months before the bill to 1 after it', () => {
    expect(checkExpense(filled({ periodMonth: '2026-08' }), REGISTERED).fields?.periodMonth).toBe(
      '2026-08',
    )
    expect(checkExpense(filled({ periodMonth: '2025-09' }), REGISTERED).fields?.periodMonth).toBe(
      '2025-09',
    )
    expect(checkExpense(filled({ periodMonth: '2026-10' }), REGISTERED).fields?.periodMonth).toBe(
      '2026-10',
    )
    for (const periodMonth of ['2025-08', '2026-11', '', '2026-13']) {
      const checked = checkExpense(filled({ periodMonth }), REGISTERED)
      expect(checked.fields, periodMonth).toBeNull()
      expect(checked.errors.periodMonth).toEqual({ key: 'expenses.editor.errors.periodMonth' })
    }
  })
})

describe('"For which month?" and the closed books (D-200)', () => {
  it('defaults to the first open month, never a closed one', () => {
    // The books closed through the end of August: a new expense on 30 September is for September.
    const draft = expenseDraft(undefined, {
      today: '2026-09-30',
      vatRegistered: false,
      closedThrough: '2026-08-31',
    })
    expect(draft.periodMonth).toBe('2026-09')
    // August's electricity, billed in September after the close: September.
    expect(
      withPeriodDefault(draft, {
        chosen: false,
        billedNextMonth: true,
        closedThrough: '2026-08-31',
      }).periodMonth,
    ).toBe('2026-09')
    // Not closed yet: August.
    expect(
      withPeriodDefault(draft, { chosen: false, billedNextMonth: true, closedThrough: null })
        .periodMonth,
    ).toBe('2026-08')
  })

  it('offers the open months only, and the saved one when it is not among them', () => {
    expect(periodMonthOptions('2026-09', '2026-09', null)).toHaveLength(14)
    expect(periodMonthOptions('2026-09', '2026-09', '2026-08-31')).toEqual(['2026-10', '2026-09'])
    // Closed only in part: August still offered.
    expect(periodMonthOptions('2026-09', '2026-09', '2026-08-15')).toEqual([
      '2026-10',
      '2026-09',
      '2026-08',
    ])
    // A correction's copy for a closed month: kept, last.
    expect(periodMonthOptions('2026-09', '2026-07', '2026-08-31')).toEqual([
      '2026-10',
      '2026-09',
      '2026-07',
    ])
    // A bill dated in the closed period: its months as before (its date says it cannot be finalized).
    expect(periodMonthOptions('2026-03', '2026-03', '2026-12-31')).toHaveLength(14)
  })
})

describe('what it pays, in a category that has running costs (the owner’s "1أ", D-216)', () => {
  const PAYABLE = [{ id: STAFF_SALARIES }]

  it('a saved expense opens with what it says: the running cost, an extra, or nothing', () => {
    expect(paysChoiceOf(null)).toBe('')
    expect(paysChoiceOf(undefined)).toBe('')
    expect(paysChoiceOf({ kind: 'extra', runningCost: null })).toBe(EXTRA)
    expect(paysChoiceOf({ kind: 'running_cost', runningCost: { id: DEWA, name: 'DEWA' } })).toBe(
      DEWA,
    )
    // Named only to a member who may see running costs: nothing to pick for anyone else.
    expect(paysChoiceOf({ kind: 'running_cost', runningCost: null })).toBe('')
  })

  it('sends the bill of a running cost its category can pay, an extra, or nothing said', () => {
    expect(paysInputOf(STAFF_SALARIES, PAYABLE)).toEqual({
      kind: 'running_cost',
      runningCostId: STAFF_SALARIES,
    })
    expect(paysInputOf(EXTRA, PAYABLE)).toEqual({ kind: 'extra' })
    expect(paysInputOf('', PAYABLE)).toBeNull()
    // A running cost of another category (the category was changed): nothing said.
    expect(paysInputOf(DEWA, PAYABLE)).toBeNull()
    // A category without running costs that month: nothing to say, not even "extra".
    expect(paysInputOf(EXTRA, [])).toBeNull()
    // Not known yet, or a member who may not say it: left out (the API keeps what it says).
    expect(paysInputOf(STAFF_SALARIES, undefined)).toBeUndefined()
  })

  it('saves without it, but says it is missing until it is chosen (needed to finalize)', () => {
    const asked = { ...REGISTERED, payable: PAYABLE }
    const notChosen = checkExpense(filled(), asked)
    expect(notChosen.fields).toMatchObject({ pays: null })
    expect(notChosen.paysMissing).toBe(true)
    const extra = checkExpense(filled({ pays: EXTRA }), asked)
    expect(extra.fields?.pays).toEqual({ kind: 'extra' })
    expect(extra.paysMissing).toBe(false)
    const bill = checkExpense(filled({ pays: STAFF_SALARIES }), asked)
    expect(bill.fields?.pays).toEqual({ kind: 'running_cost', runningCostId: STAFF_SALARIES })
    expect(bill.paysMissing).toBe(false)
    // Not asked: a category without running costs, or a member who may not see them.
    expect(checkExpense(filled(), { ...REGISTERED, payable: [] })).toMatchObject({
      fields: { pays: null },
      paysMissing: false,
    })
    const hidden = checkExpense(filled({ pays: EXTRA }), REGISTERED)
    expect(hidden.paysMissing).toBe(false)
    expect(hidden.fields).not.toHaveProperty('pays')
  })
})

import type { RunningCostDto } from '@bizcost/contracts'
import { describe, expect, it } from 'vitest'
import { checkRunningCost, runningCostDraft } from './running-cost-draft'

// "What do you pay to run your business?" (M2 Step 5; D-116, D-169): a regular amount, how often,
// and what it makes a month as it is typed.

const TODAY = '2026-09-29'
const RENT = '0190a4f2-7b5c-7c3e-9b1a-2f3c4d5e6f70'
const AED = { currency: 'AED' as const }

describe('a running cost', () => {
  it('starts monthly from today; a quick pick names it after its category', () => {
    expect(runningCostDraft(undefined, { today: TODAY, name: 'Rent', categoryId: RENT })).toEqual({
      name: 'Rent',
      categoryId: RENT,
      amount: '',
      frequency: 'monthly',
      startsOn: TODAY,
      endsOn: '',
      notes: '',
    })
  })

  it('says what is missing', () => {
    const checked = checkRunningCost(runningCostDraft(undefined, { today: TODAY }), AED)
    expect(checked.fields).toBeNull()
    expect(checked.monthly).toBeNull()
    expect(checked.errors).toMatchObject({
      name: { key: 'catalog.form.nameRequired' },
      category: { key: 'expenses.editor.errors.category' },
      amount: { key: 'catalog.numbers.required' },
    })
  })

  it('turns weekly, quarterly and yearly amounts into a month (52 weeks a year)', () => {
    const base = runningCostDraft(undefined, { today: TODAY, name: 'Rent', categoryId: RENT })
    const monthly = (amount: string, frequency: 'weekly' | 'monthly' | 'quarterly' | 'yearly') =>
      checkRunningCost({ ...base, amount, frequency }, AED).monthly
    expect(monthly('15000', 'monthly')).toBe('15000')
    expect(monthly('1200', 'weekly')).toBe('5200')
    expect(monthly('900', 'quarterly')).toBe('300')
    expect(monthly('1000', 'yearly')).toBe('83.333333333333')
  })

  it('gives the fields to save, trimmed, with no end date while it is still paid', () => {
    const draft = {
      ...runningCostDraft(undefined, { today: TODAY }),
      name: '  Shop rent ',
      categoryId: RENT,
      amount: '٣٠٠٠',
      notes: ' ',
    }
    expect(checkRunningCost(draft, AED).fields).toEqual({
      name: 'Shop rent',
      categoryId: RENT,
      amount: '3000',
      frequency: 'monthly',
      startsOn: TODAY,
      endsOn: null,
      notes: null,
    })
  })

  it('refuses an end before the start, a category no longer in the list, and a long name', () => {
    const draft = {
      ...runningCostDraft(undefined, { today: TODAY, name: 'Rent', categoryId: RENT }),
      amount: '100',
    }
    expect(checkRunningCost({ ...draft, endsOn: '2026-09-28' }, AED).errors.endsOn).toEqual({
      key: 'expenses.running.sheet.endsBeforeStart',
    })
    expect(checkRunningCost({ ...draft, endsOn: TODAY }, AED).fields?.endsOn).toBe(TODAY)
    expect(
      checkRunningCost(draft, { ...AED, categories: new Set<string>() }).errors.category,
    ).toEqual({ key: 'expenses.editor.errors.categoryGone' })
    expect(checkRunningCost({ ...draft, name: 'x'.repeat(101) }, AED).errors.name).toEqual({
      key: 'catalog.form.nameTooLong',
      values: { count: 100 },
    })
    expect(checkRunningCost({ ...draft, amount: '10.005' }, AED).errors.amount?.key).toBe(
      'catalog.numbers.tooManyDecimals',
    )
  })

  it('a saved one opens as it is stored', () => {
    const saved = {
      name: 'Internet',
      categoryId: RENT,
      amount: '399',
      frequency: 'monthly',
      startsOn: '2026-01-01',
      endsOn: '2026-12-31',
      notes: null,
    } as unknown as RunningCostDto
    expect(runningCostDraft(saved, { today: TODAY })).toEqual({
      name: 'Internet',
      categoryId: RENT,
      amount: '399',
      frequency: 'monthly',
      startsOn: '2026-01-01',
      endsOn: '2026-12-31',
      notes: '',
    })
  })
})

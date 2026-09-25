import { NO_ADJUSTMENTS, setupQuestion, type SetupAnswers } from '@bizcost/modules'
import { describe, expect, it } from 'vitest'
import { newDraft, parseDraft } from './draft'
import {
  chosenOptions,
  nameError,
  resolveStep,
  sideSteps,
  stepAfter,
  stepBefore,
  withChoice,
} from './flow'

// Moving through Smart Setup on the web (docs/PRODUCT.md §6.3); the question rules themselves are
// tested in @bizcost/modules.

const BAKER: SetupAnswers = {
  what_you_do: ['food_drinks'],
  workplace: 'home',
  team: 'alone',
  work_setup: ['none'],
  sales_channels: ['messages'],
  vat: 'no',
}

describe('nameError', () => {
  it('needs 1–100 characters after trimming', () => {
    expect(nameError('')).toBe('setup.name.required')
    expect(nameError('   ')).toBe('setup.name.required')
    expect(nameError(' Sara ')).toBeNull()
    expect(nameError('x'.repeat(100))).toBeNull()
    expect(nameError('x'.repeat(101))).toBe('setup.name.tooLong')
  })
})

describe('withChoice / chosenOptions', () => {
  it('stores a single answer, a yes/no answer as a boolean and a multi answer as a set', () => {
    const workplace = setupQuestion('workplace')
    let raw = withChoice({ what_you_do: ['food_drinks'] }, workplace, 'kitchen')
    expect(raw.workplace).toBe('kitchen')
    raw = withChoice(raw, workplace, 'shop')
    expect(raw.workplace).toBe('shop')
    raw = withChoice(raw, setupQuestion('pos'), 'false')
    expect(raw.pos).toBe(false)
    expect(chosenOptions(raw, setupQuestion('pos'))).toEqual(['false'])

    const channels = setupQuestion('sales_channels')
    raw = withChoice(raw, channels, 'online', true)
    raw = withChoice(raw, channels, 'walk_in', true)
    expect(raw.sales_channels).toEqual(['walk_in', 'online'])
    raw = withChoice(raw, channels, 'online', false)
    expect(raw.sales_channels).toEqual(['walk_in'])
  })

  it('clears the other options when an exclusive one is chosen, and the other way round', () => {
    const setup = setupQuestion('work_setup')
    let raw = withChoice({ what_you_do: ['services'] }, setup, 'materials', true)
    raw = withChoice(raw, setup, 'none', true)
    expect(raw.work_setup).toEqual(['none'])
    raw = withChoice(raw, setup, 'vehicles', true)
    expect(raw.work_setup).toEqual(['vehicles'])
  })

  it('keeps an answer that became hidden, and shows only the options shown now', () => {
    const workplace = setupQuestion('workplace')
    const raw: SetupAnswers = { what_you_do: ['services'], workplace: 'kitchen' }
    expect(raw.workplace).toBe('kitchen')
    expect(chosenOptions(raw, workplace)).toEqual([])
    const again = { ...raw, what_you_do: ['food_drinks'] } as SetupAnswers
    expect(chosenOptions(again, workplace)).toEqual(['kitchen'])
  })
})

describe('stepAfter / stepBefore', () => {
  it('walks the shown questions in order, skipping hidden ones, then the review', () => {
    expect(stepAfter({}, 'name')).toBe('what_you_do')
    const food: SetupAnswers = { what_you_do: ['food_drinks'] }
    expect(stepAfter(food, 'what_you_do')).toBe('workplace') // how_you_make is hidden
    expect(stepAfter({ ...food, workplace: 'home' }, 'workplace')).toBe('team') // no branches
    expect(stepAfter(BAKER, 'vat')).toBe('review')
    expect(stepBefore(BAKER, 'team')).toBe('workplace')
    expect(stepBefore(BAKER, 'what_you_do')).toBe('name')
    expect(stepBefore(BAKER, 'review')).toBe('vat')
  })

  it('reaches every question a changed answer left unanswered', () => {
    // The baker moves to a shop: branches and the POS question are new.
    const shop = { ...BAKER, workplace: 'shop' } as SetupAnswers
    expect(stepAfter(shop, 'workplace')).toBe('branches')
    // On in order through the answered questions (the new "in my shop" option is seen).
    expect(stepAfter({ ...shop, branches: false }, 'branches')).toBe('team')
    expect(stepAfter({ ...shop, branches: false }, 'sales_channels')).toBe('pos')
    // Reopened after it (from the side list): back to the unanswered one first.
    expect(stepAfter({ ...shop, branches: false }, 'vat')).toBe('pos')
    expect(stepAfter({ ...shop, branches: false, pos: true }, 'vat')).toBe('review')
  })
})

describe('resolveStep', () => {
  it('never resumes on a hidden question or an incomplete review', () => {
    expect(resolveStep(BAKER, 'Sara', 'team')).toBe('team')
    expect(resolveStep(BAKER, 'Sara', 'review')).toBe('review')
    expect(resolveStep(BAKER, 'Sara', 'branches')).toBe('review') // hidden, nothing missing
    expect(resolveStep({ ...BAKER, vat: undefined }, 'Sara', 'review')).toBe('vat')
    expect(resolveStep(BAKER, '', 'team')).toBe('name')
  })
})

describe('sideSteps', () => {
  it('lists Name, the counted questions and Review; answered ones can be reopened', () => {
    const steps = sideSteps({ what_you_do: ['food_drinks'] }, 'Sara', 'workplace')
    expect(steps.map((s) => s.step)).toEqual([
      'name',
      'what_you_do',
      'workplace',
      'branches', // still counted: workplace is not answered yet
      'team',
      'team_tracking', // team is not answered yet
      'work_setup',
      'sales_channels',
      'pos',
      'vat',
      'review',
    ])
    const byStep = new Map(steps.map((s) => [s.step, s]))
    expect(byStep.get('name')).toMatchObject({ done: true, canOpen: true })
    expect(byStep.get('what_you_do')).toMatchObject({ done: true, canOpen: true })
    expect(byStep.get('workplace')).toMatchObject({ current: true, canOpen: false })
    expect(byStep.get('team')).toMatchObject({ done: false, canOpen: false })
    expect(byStep.get('review')).toMatchObject({ canOpen: false })
    expect(sideSteps(BAKER, 'Sara', 'vat').at(-1)).toMatchObject({ canOpen: true })
    // The first unanswered question can be opened too.
    const shop = sideSteps({ ...BAKER, workplace: 'shop' }, 'Sara', 'vat')
    expect(shop.find((s) => s.step === 'branches')).toMatchObject({ done: false, canOpen: true })
    expect(shop.find((s) => s.step === 'pos')).toMatchObject({ done: false, canOpen: false })
    expect(shop.at(-1)).toMatchObject({ canOpen: false })
  })
})

describe('parseDraft', () => {
  const USER = '0199a000-0000-7000-8000-000000000001'

  it('restores a draft of the same user and question set', () => {
    const draft = { ...newDraft(USER), name: 'Sara', answers: BAKER, step: 'vat' as const }
    expect(parseDraft(JSON.stringify(draft), USER)).toEqual(draft)
  })

  it('starts afresh for another user, another question set or broken storage', () => {
    const draft = newDraft(USER)
    expect(parseDraft(JSON.stringify(draft), '0199a000-0000-7000-8000-000000000002')).toBeNull()
    expect(parseDraft(JSON.stringify({ ...draft, version: 0 }), USER)).toBeNull()
    expect(parseDraft('{', USER)).toBeNull()
    expect(parseDraft(null, USER)).toBeNull()
  })

  it('drops malformed parts', () => {
    const stored = JSON.stringify({
      ...newDraft(USER),
      name: 7,
      answers: { what_you_do: ['services'], nope: 'x', team: 3 },
      adjustments: { modules: [{ id: 'orders', enabled: 'yes' }], capabilities: 'x' },
      step: 'somewhere',
    })
    expect(parseDraft(stored, USER)).toMatchObject({
      name: '',
      answers: { what_you_do: ['services'] },
      adjustments: NO_ADJUSTMENTS,
      step: 'name',
    })
  })
})

import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  HOW_YOU_MAKE_OPTIONS,
  SALES_CHANNEL_OPTIONS,
  SETUP_QUESTION_IDS,
  TEAM_OPTIONS,
  TEAM_TRACKING_OPTIONS,
  VAT_OPTIONS,
  WHAT_YOU_DO_OPTIONS,
  WORK_SETUP_OPTIONS,
  WORKPLACE_OPTIONS,
  type SetupAnswers,
  type SetupQuestionId,
} from './answers'
import { isQuestionShown, SETUP_QUESTIONS, setupQuestion, shownOptions } from './questions'
import {
  nextQuestionId,
  normalizeAnswers,
  parseSetupAnswers,
  previousQuestionId,
  setupProgress,
  toggleMultiOption,
} from './walk'

const optionIds = (id: SetupQuestionId, a: SetupAnswers = {}) =>
  shownOptions(setupQuestion(id), a).map((o) => o.id)

const BAKER: SetupAnswers = {
  what_you_do: ['food_drinks'],
  workplace: 'home',
  team: 'alone',
  work_setup: ['none'],
  sales_channels: ['messages'],
  vat: 'no',
}

describe('question set v1', () => {
  it('asks the ten questions in the fixed order', () => {
    expect(SETUP_QUESTIONS.map((q) => q.id)).toEqual([...SETUP_QUESTION_IDS])
    expectTypeOf<SetupQuestionId>().toEqualTypeOf<keyof SetupAnswers>()
  })

  it('has the documented types and options', () => {
    const shape = Object.fromEntries(
      SETUP_QUESTIONS.map((q) => [q.id, [q.type, q.options.map((o) => o.id)]]),
    )
    expect(shape).toEqual({
      what_you_do: ['multi', [...WHAT_YOU_DO_OPTIONS]],
      how_you_make: ['multi', [...HOW_YOU_MAKE_OPTIONS]],
      workplace: ['single', [...WORKPLACE_OPTIONS]],
      branches: ['yes_no', ['true', 'false']],
      team: ['single', [...TEAM_OPTIONS]],
      team_tracking: ['multi', [...TEAM_TRACKING_OPTIONS]],
      work_setup: ['multi', [...WORK_SETUP_OPTIONS]],
      sales_channels: ['multi', [...SALES_CHANNEL_OPTIONS]],
      pos: ['yes_no', ['true', 'false']],
      vat: ['single', [...VAT_OPTIONS]],
    })
  })

  it('marks only "just what my team costs" and "none of these" as exclusive', () => {
    const exclusive = SETUP_QUESTIONS.flatMap((q) =>
      q.options.filter((o) => o.exclusive).map((o) => `${q.id}.${o.id}`),
    )
    expect(exclusive).toEqual(['team_tracking.cost_only', 'work_setup.none'])
  })

  it('depends only on earlier questions, and declares what its skip logic reads', () => {
    const order = SETUP_QUESTIONS.map((q) => q.id)
    for (const q of SETUP_QUESTIONS) {
      for (const d of q.dependsOn) expect(order.indexOf(d), q.id).toBeLessThan(order.indexOf(q.id))
      expect(q.dependsOn.length > 0, q.id).toBe(q.showIf !== undefined)
    }
  })

  it('uses the setup.q.<id> keys', () => {
    const q = setupQuestion('work_setup')
    expect(q.titleKey).toBe('setup.q.work_setup.title')
    expect(q.shortKey).toBe('setup.q.work_setup.short')
    expect(q.options[0]).toMatchObject({
      labelKey: 'setup.q.work_setup.opt.materials.label',
      hintKey: 'setup.q.work_setup.opt.materials.hint',
    })
    expect(q.options.at(-1)?.hintKey).toBeNull()
    expect(setupQuestion('workplace').hint({})).toBeNull()
    expect(setupQuestion('vat').hint({})).toBe('setup.q.vat.hint')
  })
})

describe('skip logic', () => {
  it('asks how products are made only for non-food makers', () => {
    const how = setupQuestion('how_you_make')
    expect(isQuestionShown(how, { what_you_do: ['make_products'] })).toBe(true)
    expect(isQuestionShown(how, { what_you_do: ['make_products', 'food_drinks'] })).toBe(false)
    expect(isQuestionShown(how, { what_you_do: ['sell_products'] })).toBe(false)
    expect(isQuestionShown(how, {})).toBe(false)
  })

  it('asks about branches everywhere but at home, and about a POS only in a shop', () => {
    const branches = setupQuestion('branches')
    const pos = setupQuestion('pos')
    expect(isQuestionShown(branches, { workplace: 'home' })).toBe(false)
    expect(isQuestionShown(branches, { workplace: 'customer_sites' })).toBe(true)
    expect(isQuestionShown(branches, {})).toBe(false)
    expect(isQuestionShown(pos, { workplace: 'shop' })).toBe(true)
    expect(isQuestionShown(pos, { workplace: 'kitchen' })).toBe(false)
  })

  it('asks what to track only for a team, and how customers pay unless projects only', () => {
    expect(isQuestionShown(setupQuestion('team_tracking'), { team: 'team' })).toBe(true)
    expect(isQuestionShown(setupQuestion('team_tracking'), { team: 'alone' })).toBe(false)
    const channels = setupQuestion('sales_channels')
    expect(isQuestionShown(channels, { what_you_do: ['projects'] })).toBe(false)
    expect(isQuestionShown(channels, { what_you_do: ['projects', 'services'] })).toBe(true)
  })

  it('offers a commercial kitchen only for food, and walk-in customers only in a shop', () => {
    expect(optionIds('workplace', { what_you_do: ['services'] })).not.toContain('kitchen')
    expect(optionIds('workplace', { what_you_do: ['food_drinks'] })).toContain('kitchen')
    expect(optionIds('sales_channels', { workplace: 'office' })).not.toContain('walk_in')
    expect(optionIds('sales_channels', { workplace: 'shop' })).toContain('walk_in')
  })

  it('hides "materials" when buying is already included, and stock from services-only businesses', () => {
    expect(optionIds('work_setup', { what_you_do: ['food_drinks'] })).toEqual([
      'stock',
      'machines',
      'vehicles',
      'none',
    ])
    expect(optionIds('work_setup', { what_you_do: ['services'] })).toEqual([
      'materials',
      'machines',
      'vehicles',
      'none',
    ])
    expect(optionIds('work_setup', { what_you_do: ['services', 'projects'] })).toContain('stock')
    const hint = setupQuestion('work_setup').hint
    expect(hint({ what_you_do: ['sell_products'] })).toBe('setup.q.work_setup.hint_included')
    expect(hint({ what_you_do: ['services'] })).toBe('setup.q.work_setup.hint')
  })
})

describe('normalizeAnswers', () => {
  it('keeps a complete walk as it is', () => {
    expect(normalizeAnswers(BAKER)).toEqual({
      answers: BAKER,
      shown: ['what_you_do', 'workplace', 'team', 'work_setup', 'sales_channels', 'vat'],
      missing: [],
      complete: true,
    })
  })

  it('drops answers to hidden questions and hidden options, and lists what is missing', () => {
    const kept = normalizeAnswers({
      what_you_do: ['services'],
      how_you_make: ['catalog'],
      workplace: 'kitchen',
      branches: true,
      team: 'alone',
      team_tracking: ['hours'],
      work_setup: ['stock'],
      pos: true,
      vat: 'yes',
    })
    expect(kept.answers).toEqual({ what_you_do: ['services'], team: 'alone', vat: 'yes' })
    expect(kept.missing).toEqual(['workplace', 'work_setup', 'sales_channels'])
    expect(kept.complete).toBe(false)
  })

  it('orders multi answers like the options and drops duplicates', () => {
    const { answers } = normalizeAnswers({
      what_you_do: ['services', 'food_drinks', 'services'],
    })
    expect(answers.what_you_do).toEqual(['food_drinks', 'services'])
  })

  it('treats an exclusive option combined with another as unanswered', () => {
    const { missing } = normalizeAnswers({ ...BAKER, work_setup: ['none', 'stock'] })
    expect(missing).toEqual(['work_setup'])
  })
})

describe('parseSetupAnswers', () => {
  const fails = (raw: unknown) => {
    const result = parseSetupAnswers(raw)
    return result.ok ? null : [result.issue, result.question]
  }

  it('accepts a complete walk and returns it in option order', () => {
    const result = parseSetupAnswers({ ...BAKER, what_you_do: ['food_drinks'] })
    expect(result).toEqual({ ok: true, answers: BAKER })
    const shop = parseSetupAnswers({
      what_you_do: ['services', 'sell_products'],
      workplace: 'shop',
      branches: false,
      team: 'alone',
      work_setup: ['vehicles', 'stock'],
      sales_channels: ['online', 'walk_in'],
      pos: false,
      vat: 'not_sure',
    })
    expect(shop.ok && shop.answers.work_setup).toEqual(['stock', 'vehicles'])
    expect(shop.ok && shop.answers.sales_channels).toEqual(['walk_in', 'online'])
  })

  it('refuses anything else, without fixing it', () => {
    expect(fails(null)).toEqual(['not_an_object', undefined])
    expect(fails([])).toEqual(['not_an_object', undefined])
    expect(fails({ ...BAKER, goals: ['x'] })).toEqual(['unknown_question', 'goals'])
    expect(fails({ ...BAKER, vat: true })).toEqual(['wrong_type', 'vat'])
    expect(fails({ ...BAKER, vat: 'maybe' })).toEqual(['unknown_option', 'vat'])
    expect(fails({ ...BAKER, sales_channels: 'messages' })).toEqual([
      'wrong_type',
      'sales_channels',
    ])
    expect(fails({ ...BAKER, sales_channels: [] })).toEqual(['missing_answer', 'sales_channels'])
    expect(fails({ ...BAKER, sales_channels: ['messages', 'messages'] })).toEqual([
      'duplicate_option',
      'sales_channels',
    ])
    expect(fails({ ...BAKER, sales_channels: ['walk_in'] })).toEqual([
      'hidden_option',
      'sales_channels',
    ])
    expect(fails({ ...BAKER, workplace: 'kitchen', what_you_do: ['services'] })).toEqual([
      'hidden_option',
      'workplace',
    ])
    expect(fails({ ...BAKER, work_setup: ['none', 'stock'] })).toEqual([
      'exclusive_combined',
      'work_setup',
    ])
    expect(fails({ ...BAKER, branches: false })).toEqual(['hidden_question', 'branches'])
    expect(fails({ ...BAKER, how_you_make: ['catalog'] })).toEqual([
      'hidden_question',
      'how_you_make',
    ])
    const noVat = Object.fromEntries(Object.entries(BAKER).filter(([id]) => id !== 'vat'))
    expect(fails(noVat)).toEqual(['missing_answer', 'vat'])
    expect(fails({ ...BAKER, workplace: 'shop' })).toEqual(['missing_answer', 'branches'])
  })

  it('refuses objects that are not plain JSON objects', () => {
    expect(fails(Object.assign(Object.create({ vat: 'no' }), BAKER))).toEqual([
      'not_an_object',
      undefined,
    ])
  })
})

describe('setupProgress', () => {
  it('counts every question until the answers that skip them are given', () => {
    expect(setupProgress({}, 'what_you_do')).toEqual({
      counted: [...SETUP_QUESTION_IDS],
      n: 1,
      m: 10,
    })
  })

  it('settles once workplace and team are answered (home baker: 6)', () => {
    const food = setupProgress({ what_you_do: ['food_drinks'] }, 'workplace')
    expect(food).toMatchObject({ n: 2, m: 9 })
    const home = setupProgress({ what_you_do: ['food_drinks'], workplace: 'home' }, 'team')
    expect(home).toMatchObject({ n: 3, m: 7 })
    const alone = setupProgress(
      { what_you_do: ['food_drinks'], workplace: 'home', team: 'alone' },
      'work_setup',
    )
    expect(alone).toEqual({
      counted: ['what_you_do', 'workplace', 'team', 'work_setup', 'sales_channels', 'vat'],
      n: 4,
      m: 6,
    })
    expect(setupProgress(BAKER, 'vat')).toMatchObject({ n: 6, m: 6 })
  })

  it('gives 0 for the name step and for a question that is not counted', () => {
    expect(setupProgress(BAKER, null).n).toBe(0)
    expect(setupProgress(BAKER, 'pos').n).toBe(0)
  })
})

describe('navigation', () => {
  it('goes to the next and previous shown question', () => {
    expect(nextQuestionId({}, null)).toBe('what_you_do')
    expect(nextQuestionId(BAKER, 'what_you_do')).toBe('workplace')
    expect(nextQuestionId(BAKER, 'team')).toBe('work_setup')
    expect(nextQuestionId(BAKER, 'vat')).toBeNull()
    expect(previousQuestionId(BAKER, 'work_setup')).toBe('team')
    expect(previousQuestionId(BAKER, 'what_you_do')).toBeNull()
  })
})

describe('toggleMultiOption', () => {
  const tracking = setupQuestion('team_tracking')

  it('adds and removes options in option order', () => {
    expect(toggleMultiOption(tracking, ['staff_cash'], 'hours', true)).toEqual([
      'hours',
      'staff_cash',
    ])
    expect(toggleMultiOption(tracking, ['hours', 'staff_cash'], 'hours', false)).toEqual([
      'staff_cash',
    ])
  })

  it('lets an exclusive option clear the others, and any other option clear it', () => {
    expect(toggleMultiOption(tracking, ['hours', 'salaries'], 'cost_only', true)).toEqual([
      'cost_only',
    ])
    expect(toggleMultiOption(tracking, ['cost_only'], 'hours', true)).toEqual(['hours'])
    expect(toggleMultiOption(tracking, ['cost_only'], 'cost_only', false)).toEqual([])
  })

  it('ignores an unknown option', () => {
    expect(toggleMultiOption(tracking, ['hours'], 'nope', true)).toEqual(['hours'])
  })
})

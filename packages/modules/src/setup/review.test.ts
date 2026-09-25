import { describe, expect, it } from 'vitest'
import { resolveCapabilities } from '../capabilities'
import type { SetupAnswers } from './answers'
import { NO_ADJUSTMENTS, recommendedState, toggleSetupItem } from './adjust'
import { recommend } from './recommend'
import { buildSetupReview, businessSummaryKeys, setupItemNameKey } from './review'

const WORKSHOP: SetupAnswers = {
  what_you_do: ['make_products'],
  how_you_make: ['custom_jobs'],
  workplace: 'workshop',
  branches: false,
  team: 'team',
  team_tracking: ['hours', 'salaries', 'staff_cash'],
  work_setup: ['stock', 'machines', 'vehicles'],
  sales_channels: ['messages', 'quotes'],
  vat: 'yes',
}
const DESIGNER: SetupAnswers = {
  what_you_do: ['services'],
  workplace: 'home',
  team: 'alone',
  work_setup: ['none'],
  sales_channels: ['messages', 'quotes', 'invoice_later'],
  vat: 'not_sure',
}

function reviewOf(answers: SetupAnswers) {
  const recommendation = recommend(answers)
  const state = recommendedState(recommendation)
  return { recommendation, review: buildSetupReview({ answers, recommendation, state }) }
}

const rowIds = (rows: readonly { item: { kind: string; id?: string; key?: string } }[]) =>
  rows.map((r) => (r.item.kind === 'module' ? r.item.id : r.item.key))

describe('buildSetupReview', () => {
  it('puts the cost of each job first, then the optional modules that are on', () => {
    const { review } = reviewOf(WORKSHOP)
    expect(rowIds(review.chosen)).toEqual([
      'jobs_and_tasks',
      'orders',
      'quotations',
      'invoices',
      'inventory',
      'usage_waste',
      'employees',
      'attendance',
      'payroll',
      'equipment',
      'vehicles',
      'petty_cash',
      'vat_center',
    ])
    expect(review.chosen[0]).toMatchObject({
      nameKey: 'setup.jobs.name',
      textKey: 'setup.jobs.reason.custom_jobs',
      enabled: true,
    })
    expect(review.chosen[1]).toMatchObject({
      nameKey: 'modules.orders.name',
      textKey: 'setup.reason.orders.custom_jobs',
    })
  })

  it('collapses the core modules that are on into the basics, never Dashboard or Settings', () => {
    const { review } = reviewOf(WORKSHOP)
    expect(rowIds(review.basics)).toEqual([
      'products',
      'materials',
      'suppliers',
      'purchases',
      'expenses',
      'running_costs',
      'files',
      'cost_engine',
      'customers',
      'sales',
      'payments',
      'reports',
    ])
  })

  it('offers off modules whose capabilities are on, with their note or description', () => {
    const { review } = reviewOf(DESIGNER)
    // Projects does not fit someone working alone from home.
    expect(rowIds(review.more)).toEqual([
      'materials',
      'purchases',
      'orders',
      'vehicles',
      'jobs_and_tasks',
    ])
    expect(review.more[0]?.textKey).toBe('modules.materials.desc')
    expect(review.more.at(-1)).toMatchObject({ textKey: 'setup.jobs.desc', enabled: false })
    const coffee = reviewOf({
      what_you_do: ['food_drinks'],
      workplace: 'shop',
      branches: false,
      team: 'team',
      team_tracking: ['hours'],
      work_setup: ['stock'],
      sales_channels: ['walk_in', 'messages'],
      pos: true,
      vat: 'yes',
    }).review
    const notes = Object.fromEntries(coffee.more.map((r) => [rowIds([r])[0], r.textKey]))
    expect(notes.orders).toBe('setup.note.orders.outside_pos')
    expect(notes.invoices).toBe('setup.note.invoices.pos_off')
    expect(notes.payroll).toBe('modules.payroll.desc')
    expect(notes.vat_center).toBeUndefined()
    expect(notes.projects).toBeUndefined() // not for food
  })

  it('offers Projects only where it can fit', () => {
    const more = (answers: SetupAnswers) => rowIds(reviewOf(answers).review.more)
    const studio: SetupAnswers = { ...DESIGNER, workplace: 'office', branches: false }
    expect(more(studio)).toContain('projects')
    expect(more({ ...DESIGNER, team: 'team', team_tracking: ['cost_only'] })).toContain('projects')
    expect(more({ ...WORKSHOP, how_you_make: ['catalog'] })).toContain('projects')
    const retail: SetupAnswers = {
      what_you_do: ['sell_products'],
      workplace: 'shop',
      branches: false,
      team: 'team',
      team_tracking: ['cost_only'],
      work_setup: ['stock'],
      sales_channels: ['walk_in'],
      pos: true,
      vat: 'yes',
    }
    expect(more(retail)).not.toContain('projects')
    expect(more({ ...retail, what_you_do: ['sell_products', 'services'] })).toContain('projects')
  })

  it('writes reasons and notes for the switches as they are now, not only for the answers', () => {
    const { recommendation } = reviewOf(WORKSHOP)
    const textOf = (review: ReturnType<typeof buildSetupReview>, id: string) =>
      [...review.chosen, ...review.basics, ...review.more].find((r) => rowIds([r])[0] === id)
        ?.textKey
    const vatOff = toggleSetupItem(
      recommendation,
      NO_ADJUSTMENTS,
      { kind: 'capability', key: 'vat_registered' },
      false,
    )
    if (!vatOff.ok) throw new Error(vatOff.issue)
    const workshop = buildSetupReview({
      answers: WORKSHOP,
      recommendation,
      state: vatOff.state,
    })
    expect(textOf(reviewOf(WORKSHOP).review, 'invoices')).toBe('setup.reason.invoices.vat')
    expect(textOf(workshop, 'invoices')).toBe('setup.reason.invoices.quotes')

    const COFFEE: SetupAnswers = {
      what_you_do: ['food_drinks'],
      workplace: 'shop',
      branches: false,
      team: 'team',
      team_tracking: ['hours'],
      work_setup: ['stock'],
      sales_channels: ['walk_in', 'online'],
      pos: true,
      vat: 'yes',
    }
    const coffee = reviewOf(COFFEE)
    expect(textOf(coffee.review, 'sales')).toBe('setup.reason.sales.pos_apps')
    expect(textOf(coffee.review, 'invoices')).toBe('setup.note.invoices.pos_off')
    const posOff = toggleSetupItem(
      coffee.recommendation,
      NO_ADJUSTMENTS,
      { kind: 'capability', key: 'sells_via_pos' },
      false,
    )
    if (!posOff.ok) throw new Error(posOff.issue)
    const noPos = buildSetupReview({
      answers: COFFEE,
      recommendation: coffee.recommendation,
      state: posOff.state,
    })
    expect(textOf(noPos, 'sales')).toBe('setup.reason.sales.apps')
    expect(textOf(noPos, 'invoices')).toBe('modules.invoices.desc')

    // A shop that turns its POS on keeps Orders, without "there's no POS in your shop".
    const SHOP: SetupAnswers = { ...COFFEE, sales_channels: ['walk_in'], pos: false }
    const shop = reviewOf(SHOP)
    expect(textOf(shop.review, 'orders')).toBe('setup.reason.orders.shop_no_pos')
    const posOn = toggleSetupItem(
      shop.recommendation,
      NO_ADJUSTMENTS,
      { kind: 'capability', key: 'sells_via_pos' },
      true,
    )
    if (!posOn.ok) throw new Error(posOn.issue)
    const withPos = buildSetupReview({
      answers: SHOP,
      recommendation: shop.recommendation,
      state: posOn.state,
    })
    expect(textOf(withPos, 'orders')).toBe('modules.orders.desc')
  })

  it('shows one banner while every listed item is planned (M1), and no per-row tags', () => {
    const { review } = reviewOf(WORKSHOP)
    expect(review.banner).toBe(true)
    for (const row of [...review.chosen, ...review.basics, ...review.more]) {
      expect(row.soon).toBe(false)
    }
  })

  it('states the capabilities whose question or option was shown, plus team, machines and VAT', () => {
    const designer = reviewOf(DESIGNER).review
    expect(designer.about.map((s) => [s.key, s.statementKey])).toEqual([
      ['has_team', 'setup.cap.has_team.off'],
      ['uses_machines', 'setup.cap.uses_machines.off'],
      ['vat_registered', 'setup.cap.vat_registered.off'],
    ])
    expect(designer.about[0]?.topicKey).toBe('setup.cap.has_team.topic')
    const workshop = reviewOf(WORKSHOP).review
    expect(workshop.about.map((s) => s.key)).toEqual([
      'has_team',
      'multi_location',
      'keeps_stock',
      'uses_machines',
      'vat_registered',
    ])
  })

  it('shows the team note with a team and the VAT note while "Not sure" VAT is off', () => {
    expect(reviewOf(WORKSHOP).review).toMatchObject({ teamNote: true, vatNotSureNote: false })
    expect(reviewOf(DESIGNER).review).toMatchObject({ teamNote: false, vatNotSureNote: true })
  })

  it('keeps a toggled module row in place until a capability changes the layout', () => {
    const { recommendation } = reviewOf(DESIGNER)
    const layout = recommendedState(recommendation)
    const toggled = toggleSetupItem(
      recommendation,
      NO_ADJUSTMENTS,
      { kind: 'module', id: 'orders' },
      true,
    )
    if (!toggled.ok) throw new Error(toggled.issue)
    const kept = buildSetupReview({
      answers: DESIGNER,
      recommendation,
      state: toggled.state,
      layout,
    })
    expect(kept.more.find((r) => rowIds([r])[0] === 'orders')).toMatchObject({ enabled: true })
    const regrouped = buildSetupReview({ answers: DESIGNER, recommendation, state: toggled.state })
    expect(rowIds(regrouped.chosen)).toContain('orders')
    expect(regrouped.chosen.find((r) => rowIds([r])[0] === 'orders')?.textKey).toBe(
      'modules.orders.desc',
    )
  })

  it('disables a module that needs VAT while VAT is off', () => {
    const { recommendation } = reviewOf(WORKSHOP)
    const off = toggleSetupItem(
      recommendation,
      NO_ADJUSTMENTS,
      { kind: 'capability', key: 'vat_registered' },
      false,
    )
    if (!off.ok) throw new Error(off.issue)
    const review = buildSetupReview({
      answers: WORKSHOP,
      recommendation,
      state: off.state,
      layout: recommendedState(recommendation),
    })
    expect(review.chosen.find((r) => rowIds([r])[0] === 'vat_center')).toMatchObject({
      enabled: false,
      needsVat: true,
    })
  })
})

describe('names and the business home summary', () => {
  it('names every switch', () => {
    expect(setupItemNameKey({ kind: 'module', id: 'inventory' })).toBe('modules.inventory.name')
    expect(setupItemNameKey({ kind: 'capability', key: 'jobs_and_tasks' })).toBe('setup.jobs.name')
    expect(setupItemNameKey({ kind: 'capability', key: 'has_team' })).toBe(
      'setup.cap.has_team.topic',
    )
  })

  it('always states team and VAT, and the other capabilities only when on', () => {
    const none = resolveCapabilities({ stored: [], derived: { vat_registered: false } })
    expect(businessSummaryKeys(none)).toEqual([
      'setup.cap.has_team.off',
      'setup.cap.vat_registered.off',
    ])
    const all = resolveCapabilities({
      stored: [
        'has_team',
        'multi_location',
        'keeps_stock',
        'uses_machines',
        'sells_via_pos',
        'jobs_and_tasks',
      ].map((key) => ({ key, enabled: true })),
      derived: { vat_registered: true },
    })
    expect(businessSummaryKeys(all)).toEqual([
      'setup.cap.has_team.on',
      'setup.cap.multi_location.on',
      'setup.cap.keeps_stock.on',
      'setup.cap.uses_machines.on',
      'setup.cap.sells_via_pos.on',
      'setup.cap.jobs_and_tasks.on',
      'setup.cap.vat_registered.on',
    ])
  })
})

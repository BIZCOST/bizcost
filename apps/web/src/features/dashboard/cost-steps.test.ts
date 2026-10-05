import type { BusinessContextDto, CostStepDto } from '@bizcost/contracts'
import { hasMessage, LOCALES, terminologyKey } from '@bizcost/i18n'
import { describe, expect, it } from 'vitest'
import { costProgress, costsReadyKeys, costStepIdsFor, costStepView } from './cost-steps'

// "Let's find the real cost of what you sell" on the Dashboard (M2 Step 7, D-193): which steps a
// member sees (the API's rules), and what each open step says and where it leads.

const ID = '0190a4f2-7b5c-7c3e-9b1a-2f3c4d5e6f70'
const COSTING = ['products', 'materials', 'suppliers', 'purchases', 'expenses', 'running_costs']

function context(
  modules: readonly string[],
  keys: readonly string[] | 'all',
  capabilities: Record<string, boolean> = {},
): Pick<BusinessContextDto, 'modules' | 'permissions' | 'capabilities' | 'visibleCategories'> {
  const all = keys === 'all'
  const has = (key: string) => all || keys.includes(key)
  return {
    modules: modules.map((id) => ({ id, nav: [], quickActions: [] })),
    permissions: all ? { all: true, keys: [] } : { all: false, keys: [...keys] },
    capabilities,
    visibleCategories: (['cost', 'supplier_price', 'profit_margin'] as const).filter((c) =>
      has(`data.${c}.view`),
    ),
  } as unknown as Pick<
    BusinessContextDto,
    'modules' | 'permissions' | 'capabilities' | 'visibleCategories'
  >
}

describe('costStepIdsFor', () => {
  it('gives an owner without a team every step, their time included', () => {
    expect(costStepIdsFor(context([...COSTING, 'cost_engine'], 'all'))).toEqual([
      'products',
      'recipes',
      'purchases',
      'running_costs',
      'owner_time',
      'product_costs',
    ])
  })

  it('leaves out the owner time with a team, and what a module turned off would need', () => {
    expect(costStepIdsFor(context([...COSTING, 'cost_engine'], 'all', { has_team: true }))).toEqual(
      ['products', 'recipes', 'purchases', 'running_costs', 'product_costs'],
    )
    expect(costStepIdsFor(context(['products'], 'all'))).toEqual(['products'])
  })

  it('gives a member without the keys (an employee) none', () => {
    expect(
      costStepIdsFor(
        context(
          [...COSTING, 'cost_engine'],
          [
            'dashboard.home.view',
            'products.items.view',
            'materials.items.view',
            'products.recipes.view',
            'expenses.documents.view',
            'expenses.documents.manage',
          ],
        ),
      ),
    ).toEqual([])
  })
})

describe('costStepView', () => {
  const step = (over: Partial<CostStepDto> & Pick<CostStepDto, 'id'>): CostStepDto => ({
    done: false,
    missing: [],
    remaining: null,
    ...over,
  })

  it('leads each open step to where it is done', () => {
    const href = (s: CostStepDto) => costStepView(ID, s, null).href
    expect(href(step({ id: 'products' }))).toBe(`/b/${ID}/products/new`)
    expect(href(step({ id: 'recipes', remaining: 2 }))).toBe(`/b/${ID}/products`)
    expect(href(step({ id: 'purchases', remaining: 3 }))).toBe(`/b/${ID}/purchases/new`)
    expect(href(step({ id: 'running_costs', missing: ['runningCosts'] }))).toBe(
      `/b/${ID}/running-costs`,
    )
    expect(href(step({ id: 'owner_time', missing: ['hourlyRate', 'minutes'] }))).toBe(
      `/b/${ID}/settings/costing`,
    )
    expect(href(step({ id: 'owner_time', missing: ['minutes'] }))).toBe(`/b/${ID}/products`)
    expect(href(step({ id: 'product_costs', remaining: 1 }))).toBe(`/b/${ID}/product-costs`)
  })

  it('says what is still missing, counted where the API counts it', () => {
    const recipes = costStepView(ID, step({ id: 'recipes', remaining: 2 }), null)
    expect(recipes.bodyKey).toBe('dashboard.costs.steps.recipes.remaining')
    expect(recipes.count).toBe(2)
    expect(costStepView(ID, step({ id: 'recipes', remaining: 2 }), 'food').bodyKey).toBe(
      'dashboard.costs.steps.recipes.remainingFood',
    )
    expect(costStepView(ID, step({ id: 'recipes', remaining: null }), null).bodyKey).toBe(
      'dashboard.costs.steps.recipes.todo',
    )
    expect(
      costStepView(ID, step({ id: 'running_costs', missing: ['runningCosts'] }), null).bodyKey,
    ).toBe('dashboard.costs.steps.running_costs.runningCosts')
    expect(costStepView(ID, step({ id: 'owner_time', done: true }), null).bodyKey).toBe(
      'dashboard.costs.steps.owner_time.done',
    )
  })

  it('has its words in both languages, in every wording', () => {
    const cases: CostStepDto[] = [
      step({ id: 'products' }),
      step({ id: 'recipes', remaining: 1 }),
      step({ id: 'recipes' }),
      step({ id: 'purchases', remaining: 1 }),
      step({ id: 'purchases' }),
      step({ id: 'running_costs', missing: ['runningCosts'] }),
      step({ id: 'owner_time', missing: ['hourlyRate'] }),
      step({ id: 'owner_time', missing: ['minutes'] }),
      step({ id: 'owner_time', missing: ['hourlyRate', 'minutes'] }),
      step({ id: 'product_costs', remaining: 1 }),
      step({ id: 'product_costs' }),
      step({ id: 'sales' }),
      step({ id: 'real_profit' }),
      ...(
        [
          'products',
          'recipes',
          'purchases',
          'running_costs',
          'owner_time',
          'product_costs',
          'sales',
          'real_profit',
        ] as const
      ).map((id) => step({ id, done: true })),
    ]
    for (const locale of LOCALES) {
      for (const [profile, servicesOnly] of [
        [null, false],
        ['food', false],
        ['projects', false],
        [null, true],
        ['projects', true],
      ] as const) {
        for (const item of cases) {
          const view = costStepView(ID, item, profile, servicesOnly)
          for (const key of [view.titleKey, view.actionKey]) {
            const shown = terminologyKey(key, profile, (k) => hasMessage(locale, k))
            expect(hasMessage(locale, shown), `${locale} ${shown}`).toBe(true)
          }
          const body = view.count === null ? view.bodyKey : `${view.bodyKey}_other`
          expect(hasMessage(locale, body), `${locale} ${body}`).toBe(true)
        }
      }
    }
  })
})

describe('a business that sells only services (D-200)', () => {
  const step = (over: Partial<CostStepDto> & Pick<CostStepDto, 'id'>): CostStepDto => ({
    done: false,
    missing: [],
    remaining: null,
    ...over,
  })

  it('speaks of services where the steps name products', () => {
    const products = costStepView(ID, step({ id: 'products' }), null, true)
    expect(products.actionKey).toBe('dashboard.costs.steps.products.action_services')
    expect(products.bodyKey).toBe('dashboard.costs.steps.products.todo_services')
    const costs = costStepView(ID, step({ id: 'product_costs', remaining: 2 }), null, true)
    expect(costs).toMatchObject({
      titleKey: 'dashboard.costs.steps.product_costs.title_services',
      bodyKey: 'dashboard.costs.steps.product_costs.remainingServices',
      count: 2,
    })
    expect(
      costStepView(ID, step({ id: 'owner_time', missing: ['minutes'] }), null, true).bodyKey,
    ).toBe('dashboard.costs.steps.owner_time.minutes_services')
    // What names no product keeps its words.
    expect(
      costStepView(ID, step({ id: 'owner_time', missing: ['hourlyRate'] }), null, true),
    ).toMatchObject({
      bodyKey: 'dashboard.costs.steps.owner_time.hourlyRate',
      titleKey: 'dashboard.costs.steps.owner_time.title',
    })
    // And a business selling products too reads about products.
    expect(costStepView(ID, step({ id: 'products' }), null).actionKey).toBe(
      'dashboard.costs.steps.products.action',
    )
  })

  it('says what the ready costs come from: time only without a team, services apart', () => {
    expect(costsReadyKeys({ servicesOnly: false, ownerTime: true }).body).toBe(
      'dashboard.costs.ready.body',
    )
    expect(costsReadyKeys({ servicesOnly: false, ownerTime: false }).body).toBe(
      'dashboard.costs.ready.bodyWithoutTime',
    )
    expect(costsReadyKeys({ servicesOnly: true, ownerTime: true })).toEqual({
      title: 'dashboard.costs.ready.title_services',
      body: 'dashboard.costs.ready.bodyServices',
      action: 'dashboard.costs.ready.action_services',
      path: 'product-costs',
    })
    for (const locale of LOCALES) {
      for (const servicesOnly of [false, true]) {
        for (const ownerTime of [false, true]) {
          const keys = costsReadyKeys({ servicesOnly, ownerTime })
          for (const key of [keys.title, keys.body, keys.action])
            expect(hasMessage(locale, key), `${locale} ${key}`).toBe(true)
        }
      }
      for (const key of ['dashboard.costs.description', 'dashboard.costs.description_services'])
        expect(hasMessage(locale, key), `${locale} ${key}`).toBe(true)
    }
  })

  it('with the sales steps: "Your real profit is ready", which leads to Real profit (M3 Step 3)', () => {
    expect(costsReadyKeys({ servicesOnly: false, ownerTime: true, profit: true })).toEqual({
      title: 'dashboard.costs.profitReady.title',
      body: 'dashboard.costs.profitReady.body',
      action: 'dashboard.costs.profitReady.action',
      path: 'reports/profit',
    })
    expect(costsReadyKeys({ servicesOnly: true, ownerTime: false, profit: true }).body).toBe(
      'dashboard.costs.profitReady.bodyWithoutTime',
    )
    for (const locale of LOCALES) {
      for (const ownerTime of [false, true]) {
        const keys = costsReadyKeys({ servicesOnly: false, ownerTime, profit: true })
        for (const key of [keys.title, keys.body, keys.action])
          expect(hasMessage(locale, key), `${locale} ${key}`).toBe(true)
      }
      for (const key of ['dashboard.costs.titleProfit', 'dashboard.costs.descriptionProfit'])
        expect(hasMessage(locale, key), `${locale} ${key}`).toBe(true)
    }
    expect(hasMessage('ar', 'dashboard.costs.titleProfit')).toBe(true)
  })
})

describe('costProgress', () => {
  it('counts what is done and names the next step', () => {
    const steps: CostStepDto[] = [
      { id: 'products', done: true, missing: [], remaining: null },
      { id: 'recipes', done: false, missing: [], remaining: 1 },
      { id: 'product_costs', done: false, missing: [], remaining: 1 },
    ]
    expect(costProgress(steps)).toEqual({ done: 1, total: 3, complete: false, next: 'recipes' })
    expect(costProgress([]).complete).toBe(false)
  })
})

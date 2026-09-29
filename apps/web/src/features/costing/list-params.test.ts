import { describe, expect, it } from 'vitest'
import {
  costListInput,
  filterChoices,
  isNarrowed,
  nextSort,
  readCostListParams,
  showChoices,
  showOf,
  showParams,
  sortChoices,
  writeCostListParams,
} from './list-params'

// The Product costs list's order and filter, from and to the address: never on a value the member
// may not see (redaction: the API refuses it as FORBIDDEN, so the page never asks).

const EVERYTHING = ['cost', 'profit_margin', 'supplier_price'] as const
const COSTS_ONLY = ['cost', 'supplier_price'] as const
const NOTHING = [] as const

const params = (query: string) => new URLSearchParams(query)

describe('the Product costs list in the address', () => {
  it('reads the defaults: products in use, by name', () => {
    expect(readCostListParams(params(''), EVERYTHING)).toEqual({
      search: '',
      status: 'active',
      sort: 'name',
      direction: 'asc',
      filter: null,
    })
  })

  it('reads a sort, its direction, a filter and a search', () => {
    expect(
      readCostListParams(
        params('q=%20latte%20&status=all&sort=margin_percent&filter=loss'),
        EVERYTHING,
      ),
    ).toEqual({
      search: 'latte',
      // A filter is over the products in use.
      status: 'active',
      sort: 'margin_percent',
      // A column's first direction: the lowest margins first.
      direction: 'asc',
      filter: 'loss',
    })
    expect(readCostListParams(params('dir=desc'), EVERYTHING)).toMatchObject({
      sort: 'name',
      direction: 'desc',
    })
    expect(readCostListParams(params('sort=cost&dir=asc'), EVERYTHING)).toMatchObject({
      sort: 'cost',
      direction: 'asc',
    })
    expect(readCostListParams(params('sort=cost'), EVERYTHING).direction).toBe('desc')
  })

  it('never keeps a sort or a filter on a value the member may not see', () => {
    // Without costs: no cost, margin or incomplete; the name order instead.
    for (const query of ['sort=cost&dir=desc', 'sort=margin', 'sort=margin_percent']) {
      expect(readCostListParams(params(query), NOTHING)).toMatchObject({
        sort: 'name',
        direction: 'asc',
      })
    }
    expect(readCostListParams(params('filter=incomplete'), NOTHING).filter).toBeNull()
    expect(readCostListParams(params('filter=loss'), NOTHING).filter).toBeNull()
    // Costs without margins (no role gets that since D-187, but the rule is per category): costs
    // yes, margins no.
    expect(readCostListParams(params('sort=cost'), COSTS_ONLY).sort).toBe('cost')
    expect(readCostListParams(params('sort=margin'), COSTS_ONLY).sort).toBe('name')
    expect(readCostListParams(params('filter=incomplete'), COSTS_ONLY).filter).toBe('incomplete')
    expect(readCostListParams(params('filter=loss'), COSTS_ONLY).filter).toBeNull()
    // Nonsense falls back too.
    expect(readCostListParams(params('sort=secret&dir=up&status=x'), EVERYTHING)).toMatchObject({
      sort: 'name',
      direction: 'asc',
      status: 'active',
    })
  })

  it('offers only the choices the member may use', () => {
    expect(sortChoices(NOTHING).map((c) => `${c.sort}:${c.direction}`)).toEqual([
      'name:asc',
      'name:desc',
      'price:desc',
      'price:asc',
    ])
    expect(sortChoices(COSTS_ONLY).map((c) => c.sort)).not.toContain('margin')
    expect(sortChoices(COSTS_ONLY).map((c) => c.sort)).toContain('cost')
    expect(sortChoices(EVERYTHING)).toHaveLength(10)
    expect(filterChoices(NOTHING)).toEqual([])
    expect(filterChoices(COSTS_ONLY)).toEqual(['incomplete'])
    expect(filterChoices(EVERYTHING)).toEqual(['incomplete', 'loss'])
  })

  it('"Show": the products in use, a filter of them, archived ones or all, as one choice', () => {
    expect(showChoices(NOTHING)).toEqual(['active', 'archived', 'all'])
    expect(showChoices(EVERYTHING)).toEqual(['active', 'incomplete', 'loss', 'archived', 'all'])
    for (const show of showChoices(EVERYTHING)) expect(showOf(showParams(show))).toBe(show)
    expect(showParams('loss')).toEqual({ status: 'active', filter: 'loss' })
    expect(showParams('archived')).toEqual({ status: 'archived', filter: null })
    expect(showOf(readCostListParams(params('status=archived&filter=loss'), EVERYTHING))).toBe(
      'loss',
    )
    expect(showOf(readCostListParams(params('status=archived&filter=loss'), NOTHING))).toBe(
      'archived',
    )
  })

  it('writes only what differs from the defaults', () => {
    expect(writeCostListParams(params(''), { sort: 'cost', direction: 'desc' })).toBe('sort=cost')
    expect(writeCostListParams(params('sort=cost'), { sort: 'cost', direction: 'asc' })).toBe(
      'sort=cost&dir=asc',
    )
    expect(
      writeCostListParams(params('sort=cost&dir=asc&q=x'), { sort: 'name', direction: 'asc' }),
    ).toBe('q=x')
    expect(writeCostListParams(params('filter=loss'), { filter: null })).toBe('')
    expect(writeCostListParams(params(''), { status: 'archived', search: ' cake ' })).toBe(
      'q=cake&status=archived',
    )
  })

  it("turns the parameters into productCost.list's input", () => {
    const read = readCostListParams(params('sort=margin&dir=desc&filter=incomplete'), EVERYTHING)
    expect(costListInput(read)).toEqual({
      search: undefined,
      status: 'active',
      sort: 'margin',
      order: 'desc',
      filter: 'incomplete',
    })
    expect(isNarrowed(read)).toBe(true)
    expect(isNarrowed(readCostListParams(params('sort=cost'), EVERYTHING))).toBe(false)
  })

  it('a header click sorts by its column, then turns the order round', () => {
    const byName = readCostListParams(params(''), EVERYTHING)
    expect(nextSort(byName, 'cost')).toEqual({ sort: 'cost', direction: 'desc' })
    expect(nextSort(byName, 'name')).toEqual({ sort: 'name', direction: 'desc' })
    const byCost = readCostListParams(params('sort=cost'), EVERYTHING)
    expect(nextSort(byCost, 'cost')).toEqual({ sort: 'cost', direction: 'asc' })
  })
})

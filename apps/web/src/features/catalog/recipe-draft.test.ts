import type { MaterialDto, RecipeDto } from '@bizcost/contracts'
import type { Quantity } from '@bizcost/domain'
import { describe, expect, it } from 'vitest'
import {
  checkRecipe,
  isSaved,
  lineCostOf,
  moveLine,
  recipeDraft,
  recipeUnitOf,
  type RecipeLineDraft,
} from './recipe-draft'

// The recipe form (M2 Step 4): lines checked with the domain units engine, as recipe.save will
// receive them, and what the screen shows while it is typed.

const MILK: MaterialDto = {
  id: '0190a4f2-7b5c-7c3e-9b1a-000000000001',
  name: 'Milk',
  dimension: 'volume',
  unit: 'l',
  packs: [
    { id: 'bottle', name: 'bottle', qty: '1', ofUnit: 'l', ofPackId: null },
    { id: 'carton', name: 'carton', qty: '12', ofUnit: null, ofPackId: 'bottle' },
  ],
  crossFactors: [],
  resaleProductId: null,
  archivedAt: null,
  version: 1,
}
const BEANS: MaterialDto = {
  id: '0190a4f2-7b5c-7c3e-9b1a-000000000002',
  name: 'بن',
  dimension: 'mass',
  unit: 'kg',
  packs: [{ id: 'bag', name: 'كيس', qty: '1', ofUnit: 'kg', ofPackId: null }],
  crossFactors: [],
  resaleProductId: null,
  archivedAt: null,
  version: 1,
}
const MATERIALS = new Map([MILK, BEANS].map((m) => [m.id, m] as const))

function line(fields: Partial<RecipeLineDraft> = {}): RecipeLineDraft {
  return {
    id: `line-${Math.random()}`,
    materialId: MILK.id,
    qty: '200',
    unit: 'unit:ml',
    ...fields,
  }
}

describe('checkRecipe', () => {
  it('turns lines into recipe.save lines, in base units too: Arabic digits, units and packs', () => {
    const lines = [
      line({ id: 'a', qty: '٢٠٠' }),
      line({ id: 'b', materialId: BEANS.id, qty: '18', unit: 'unit:g' }),
    ]
    const check = checkRecipe(lines, MATERIALS)
    expect(check.errors).toEqual({})
    expect(check.lines).toEqual([
      { id: 'a', materialId: MILK.id, qty: '200', unit: 'ml', packId: null },
      { id: 'b', materialId: BEANS.id, qty: '18', unit: 'g', packId: null },
    ])
    expect(check.baseQty.get('a')).toBe('200')
    expect(check.baseQty.get('b')).toBe('18')
    const pack = checkRecipe([line({ id: 'c', qty: '0.5', unit: 'pack:carton' })], MATERIALS)
    expect(pack.lines).toEqual([
      { id: 'c', materialId: MILK.id, qty: '0.5', unit: null, packId: 'carton' },
    ])
    expect(pack.baseQty.get('c')).toBe('6000')
  })

  it('says each problem on its line: no material, the same one twice, a unit it lacks, a number', () => {
    const check = checkRecipe(
      [
        line({ id: 'none', materialId: '' }),
        line({ id: 'first' }),
        line({ id: 'twice' }),
        line({ id: 'kg', materialId: MILK.id, unit: 'unit:kg' }),
        line({ id: 'text', materialId: BEANS.id, qty: 'lots', unit: 'unit:g' }),
        line({ id: 'zero', materialId: BEANS.id, qty: '0.0000001', unit: 'unit:mg' }),
      ],
      MATERIALS,
    )
    expect(check.lines).toBeNull()
    expect(check.errors.none?.material?.key).toBe('catalog.recipes.needMaterial')
    expect(check.errors.first).toBeUndefined()
    expect(check.errors.twice?.material?.key).toBe('catalog.recipes.duplicate')
    expect(check.errors.kg?.unit?.key).toBe('catalog.form.pickUnit')
    expect(check.errors.text?.qty?.key).toBe('catalog.numbers.invalid')
    expect(check.errors.zero?.qty?.key).toBeDefined()
  })
})

describe('the saved recipe', () => {
  const recipe: RecipeDto = {
    productId: 'p',
    productUnit: 'piece',
    version: 2,
    lines: [
      {
        id: 'a',
        materialId: MILK.id,
        materialName: 'Milk',
        materialUnit: 'l',
        dimension: 'volume',
        materialArchived: false,
        qty: '0.5',
        unit: null,
        packId: 'carton',
        packName: 'carton',
        baseQty: '6000',
        cost: null,
      },
    ],
    cost: { total: null, unpricedLines: 1, complete: false },
    averageFrom: '2026-07-02',
    averageTo: '2026-09-29',
  }

  it('reads back into the form, and knows when the form still says it', () => {
    const lines = recipeDraft(recipe)
    expect(lines).toEqual([{ id: 'a', materialId: MILK.id, qty: '0.5', unit: 'pack:carton' }])
    expect(isSaved(lines, recipe)).toBe(true)
    expect(isSaved([{ ...lines[0]!, qty: '0.50' }], recipe)).toBe(true)
    expect(isSaved([{ ...lines[0]!, qty: '1' }], recipe)).toBe(false)
    expect(isSaved([], recipe)).toBe(false)
  })
})

describe('what the screen shows', () => {
  it('starts a new line in grams, millilitres or pieces', () => {
    expect(recipeUnitOf(MILK)).toBe('unit:ml')
    expect(recipeUnitOf(BEANS)).toBe('unit:g')
  })

  it('costs a line at its base quantity × the average per base unit: 200 ml at 0.006 = 1.2', () => {
    expect(lineCostOf('200' as Quantity, '0.006')).toBe('1.2')
    expect(lineCostOf('25' as Quantity, '0.010281385281')).toBe('0.257034632025')
  })
})

describe('moving a line', () => {
  const lines = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

  it('swaps it with its neighbour, and leaves the ends as they are', () => {
    expect(moveLine(lines, 'c', -1).map((l) => l.id)).toEqual(['a', 'c', 'b'])
    expect(moveLine(lines, 'a', 1).map((l) => l.id)).toEqual(['b', 'a', 'c'])
    expect(moveLine(lines, 'a', -1).map((l) => l.id)).toEqual(['a', 'b', 'c'])
    expect(moveLine(lines, 'c', 1).map((l) => l.id)).toEqual(['a', 'b', 'c'])
    expect(moveLine(lines, 'x', 1).map((l) => l.id)).toEqual(['a', 'b', 'c'])
    expect(lines.map((l) => l.id)).toEqual(['a', 'b', 'c'])
  })

  it('makes the form differ from what was saved, and sends the lines in the new order', () => {
    const recipe: RecipeDto = {
      productId: 'p',
      productUnit: 'piece',
      version: 1,
      lines: [MILK, BEANS].map((material, i) => ({
        id: `line-${i}`,
        materialId: material.id,
        materialName: material.name,
        materialUnit: material.unit,
        dimension: material.dimension,
        materialArchived: false,
        qty: '1',
        unit: material.unit,
        packId: null,
        packName: null,
        baseQty: '1000',
        cost: null,
      })),
      cost: { total: null, unpricedLines: 2, complete: false },
      averageFrom: '2026-07-02',
      averageTo: '2026-09-29',
    }
    const moved = moveLine(recipeDraft(recipe), 'line-1', -1)
    expect(isSaved(moved, recipe)).toBe(false)
    const check = checkRecipe(moved, new Map([MILK, BEANS].map((m) => [m.id, m])))
    expect(check.lines?.map((l) => l.id)).toEqual(['line-1', 'line-0'])
  })
})

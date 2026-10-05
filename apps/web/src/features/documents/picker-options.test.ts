import type { MaterialDto } from '@bizcost/contracts'
import { describe, expect, it } from 'vitest'
import { pickerOptions, typedName } from './picker-options'

function material(id: string, name: string): MaterialDto {
  return {
    id,
    name,
    dimension: 'volume',
    unit: 'l',
    packs: [],
    crossFactors: [],
    resaleProductId: null,
    archivedAt: null,
    version: 1,
  }
}

const MILK = material('1', 'حليب طازج')
const CONDENSED = material('2', 'Condensed milk')
const MILK_EN = material('3', 'Milk')
const PICKABLE = [MILK, CONDENSED, MILK_EN]

const names = (options: ReturnType<typeof pickerOptions>) =>
  options.map((option) => (option.kind === 'item' ? option.item.name : `+${option.name}`))

describe('pickerOptions', () => {
  it('lists every material by name while nothing is typed', () => {
    expect(names(pickerOptions('  ', PICKABLE, 'en', true))).toEqual([
      'Condensed milk',
      'Milk',
      'حليب طازج',
    ])
  })

  it('keeps the names that hold what is typed, those starting with it first, then Add', () => {
    expect(names(pickerOptions('mil', PICKABLE, 'en', true))).toEqual([
      'Milk',
      'Condensed milk',
      '+mil',
    ])
  })

  it('reads Arabic the way people type it and offers no Add for the very same name', () => {
    // «حليب» is inside «حليب طازج»: listed, and a new «حليب» can still be added.
    expect(names(pickerOptions('حليب', PICKABLE, 'ar', true))).toEqual(['حليب طازج', '+حليب'])
    expect(names(pickerOptions('حَليب  طازج', PICKABLE, 'ar', true))).toEqual(['حليب طازج'])
    expect(names(pickerOptions('MILK', PICKABLE, 'en', true))).toEqual(['Milk', 'Condensed milk'])
  })

  it('offers an archived material that has the very name, not Add', () => {
    const sugar = { ...material('4', 'سكر'), archivedAt: '2026-09-01T00:00:00.000Z' }
    const all = [...PICKABLE, sugar]
    const options = pickerOptions('سُكّر', PICKABLE, 'ar', true, all)
    expect(options).toEqual([{ kind: 'item', item: sugar, archived: true }])
    // Only the very name: a part of it offers Add, as before.
    expect(names(pickerOptions('سك', PICKABLE, 'ar', true, all))).toEqual(['+سك'])
    // Not in `all`: Add.
    expect(names(pickerOptions('سكر', PICKABLE, 'ar', true))).toEqual(['+سكر'])
  })

  it('offers no Add to a member who may not add materials', () => {
    expect(names(pickerOptions('Sugar', PICKABLE, 'en', false))).toEqual([])
  })
})

describe('typedName', () => {
  it('trims and collapses spaces', () => {
    expect(typedName('  fresh   milk ')).toBe('fresh milk')
  })
})

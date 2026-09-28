import { describe, expect, it } from 'vitest'
import {
  decimalPlaces,
  materialUnits,
  nameAfterQuantity,
  outerPacks,
  packChain,
  UNIT_GROUPS,
} from './units'

// The chain in words of the unit editor ("1 carton = 12 bottles = 12 L"): the domain engine's exact
// conversions, step by step.

const CARTON = { id: 'carton', name: 'carton', qty: '12', ofUnit: null, ofPackId: 'bottle' }
const BOTTLE = { id: 'bottle', name: 'bottle', qty: '1', ofUnit: 'l' as const, ofPackId: null }

describe('packChain', () => {
  it("says the owner's carton down to litres", () => {
    const packs = [CARTON, BOTTLE]
    const units = materialUnits('l', packs, [])
    expect(packChain('carton', packs, units, 'l')).toEqual([
      { kind: 'pack', qty: '1', name: 'carton' },
      { kind: 'pack', qty: '12', name: 'bottle' },
      { kind: 'unit', qty: '12', unit: 'l' },
    ])
    expect(packChain('bottle', packs, units, 'l')).toEqual([
      { kind: 'pack', qty: '1', name: 'bottle' },
      { kind: 'unit', qty: '1', unit: 'l' },
    ])
  })

  it('adds the unit the material is used in when the chain ends in another one', () => {
    const packs = [{ ...CARTON }, { ...BOTTLE, qty: '1.5' }]
    const units = materialUnits('ml', packs, [])
    expect(packChain('carton', packs, units, 'ml')?.slice(2)).toEqual([
      { kind: 'unit', qty: '18', unit: 'l' },
      { kind: 'unit', qty: '18000', unit: 'ml' },
    ])
  })

  it('goes through a conversion to another kind of measure', () => {
    const packs = [{ id: 'bottle', name: 'bottle', qty: '2', ofUnit: 'l' as const, ofPackId: null }]
    const units = materialUnits('kg', packs, [{ unit: 'l', qty: '920', ofUnit: 'g' }])
    expect(packChain('bottle', packs, units, 'kg')).toEqual([
      { kind: 'pack', qty: '1', name: 'bottle' },
      { kind: 'unit', qty: '2', unit: 'l' },
      { kind: 'unit', qty: '1.84', unit: 'kg' },
    ])
  })

  it('gives nothing for a chain the engine cannot follow', () => {
    const loop = [
      { id: 'a', name: 'a', qty: '2', ofUnit: null, ofPackId: 'b' },
      { id: 'b', name: 'b', qty: '2', ofUnit: null, ofPackId: 'a' },
    ]
    expect(packChain('a', loop, materialUnits('g', loop, []), 'g')).toBeNull()
    const noConversion = [
      { id: 'bag', name: 'bag', qty: '1', ofUnit: 'l' as const, ofPackId: null },
    ]
    expect(packChain('bag', noConversion, materialUnits('g', noConversion, []), 'g')).toBeNull()
    expect(packChain('missing', [], materialUnits('g', [], []), 'g')).toBeNull()
  })
})

describe('outerPacks', () => {
  it('keeps the packs no other pack holds, in their order', () => {
    const tray = { id: 'tray', name: 'tray', qty: '6', ofUnit: 'piece' as const, ofPackId: null }
    expect(outerPacks([BOTTLE, CARTON, tray]).map((p) => p.id)).toEqual(['carton', 'tray'])
  })
})

describe('nameAfterQuantity', () => {
  it('makes English names plural after any quantity but 1', () => {
    expect(nameAfterQuantity('bottle', '12')).toBe('bottles')
    expect(nameAfterQuantity('bottle', '1')).toBe('bottle')
    expect(nameAfterQuantity('box', '3')).toBe('boxes')
    expect(nameAfterQuantity('bunch', '2')).toBe('bunches')
    expect(nameAfterQuantity('battery', '4')).toBe('batteries')
    expect(nameAfterQuantity('tray', '2')).toBe('trays')
    expect(nameAfterQuantity('six-pack', '0.5')).toBe('six-packs')
  })

  it('keeps English names that are plural already, in capitals or of several words', () => {
    expect(nameAfterQuantity('glass', '6')).toBe('glass')
    expect(nameAfterQuantity('eggs', '30')).toBe('eggs')
    expect(nameAfterQuantity('BOX', '3')).toBe('BOX')
    expect(nameAfterQuantity('tray of eggs', '12')).toBe('tray of eggs')
    expect(nameAfterQuantity('sleeve of cups', '20')).toBe('sleeve of cups')
  })

  it('says an Arabic name after 3 to 10 as a count, and keeps it after 1, 2 and 11 on', () => {
    expect(nameAfterQuantity('كيس', '6')).toBe('×\u00a0كيس')
    expect(nameAfterQuantity('زجاجة', '3')).toBe('×\u00a0زجاجة')
    expect(nameAfterQuantity('علبة', '10')).toBe('×\u00a0علبة')
    expect(nameAfterQuantity('زجاجة', '12')).toBe('زجاجة')
    expect(nameAfterQuantity('زجاجة', '2')).toBe('زجاجة')
    expect(nameAfterQuantity('زجاجة', '1.5')).toBe('زجاجة')
  })

  it('keeps other names as typed', () => {
    expect(nameAfterQuantity('pack 6', '2')).toBe('pack 6')
    expect(nameAfterQuantity('كيس 5kg', '4')).toBe('كيس 5kg')
    expect(nameAfterQuantity(' carton ', '1')).toBe('carton')
  })
})

describe('units', () => {
  it('lists every standard unit once, by kind of measure', () => {
    const all = UNIT_GROUPS.flatMap((group) => group.units)
    expect(new Set(all).size).toBe(15)
    expect(UNIT_GROUPS.map((group) => group.dimension)).toEqual([
      'mass',
      'volume',
      'count',
      'length',
      'area',
      'time',
    ])
  })

  it('counts decimal places', () => {
    expect(decimalPlaces('12')).toBe(0)
    expect(decimalPlaces('0.25')).toBe(2)
  })
})

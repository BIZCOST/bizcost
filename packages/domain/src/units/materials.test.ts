import { describe, expect, it } from 'vitest'
import { toDec } from '../numbers/decimal'
import { validateMaterialUnits, type MaterialUnits } from './materials'
import {
  BASE_UNITS,
  DIMENSIONS,
  dimensionOf,
  isDimension,
  isStandardUnit,
  STANDARD_UNITS,
} from './standard'

describe('standard units', () => {
  it('give each dimension a base unit with factor 1', () => {
    for (const dimension of DIMENSIONS) {
      const base = BASE_UNITS[dimension]
      expect(dimensionOf(base)).toBe(dimension)
      expect(STANDARD_UNITS[base].factor).toBe('1')
    }
    expect(BASE_UNITS).toEqual({
      mass: 'g',
      volume: 'ml',
      count: 'piece',
      length: 'mm',
      area: 'cm2',
      time: 's',
    })
  })

  it('have exact positive factors', () => {
    for (const { factor } of Object.values(STANDARD_UNITS)) {
      expect(toDec(factor).gt(0)).toBe(true)
    }
    expect(STANDARD_UNITS.kg.factor).toBe('1000')
    expect(STANDARD_UNITS.mg.factor).toBe('0.001')
    expect(STANDARD_UNITS.m2.factor).toBe('10000')
    expect(STANDARD_UNITS.h.factor).toBe('3600')
  })

  it('recognise their codes and dimensions only', () => {
    expect(isStandardUnit('kg')).toBe(true)
    expect(isStandardUnit('KG')).toBe(false)
    expect(isStandardUnit('constructor')).toBe(false)
    expect(isDimension('area')).toBe(true)
    expect(isDimension('weight')).toBe(false)
  })
})

const WATER: MaterialUnits = {
  dimension: 'volume',
  packs: [
    { id: 'carton', qty: '12', of: { pack: 'bottle' } },
    { id: 'bottle', qty: '1', of: 'l' },
  ],
}

describe('validateMaterialUnits', () => {
  it('accepts the owner examples', () => {
    expect(validateMaterialUnits(WATER)).toEqual([])
    expect(
      validateMaterialUnits({
        dimension: 'count',
        packs: [
          { id: 'box', qty: '20', of: { pack: 'pack' } },
          { id: 'pack', qty: '50', of: { pack: 'cup' } },
          { id: 'cup', qty: '1', of: 'piece' },
        ],
      }),
    ).toEqual([])
    expect(validateMaterialUnits({ dimension: 'mass' })).toEqual([])
  })

  it('refuses quantities that are not positive decimals of numeric(28,12)', () => {
    for (const qty of ['0', '-1', 'abc', '1e3', '0.0000000000001', '١٢']) {
      expect(
        validateMaterialUnits({ dimension: 'volume', packs: [{ id: 'p', qty, of: 'l' }] }),
      ).toEqual([{ code: 'invalid_qty', pack: 'p' }])
    }
  })

  it('refuses duplicate, unknown and looping packs', () => {
    expect(
      validateMaterialUnits({
        dimension: 'volume',
        packs: [
          { id: 'a', qty: '1', of: 'l' },
          { id: 'a', qty: '2', of: 'l' },
        ],
      }),
    ).toEqual([{ code: 'duplicate_pack', pack: 'a' }])
    expect(
      validateMaterialUnits({
        dimension: 'volume',
        packs: [{ id: 'a', qty: '1', of: { pack: 'b' } }],
      }),
    ).toEqual([{ code: 'unknown_pack', pack: 'a' }])
    expect(
      validateMaterialUnits({
        dimension: 'volume',
        packs: [{ id: 'a', qty: '1', of: 'lb' as 'l' }],
      }),
    ).toEqual([{ code: 'unknown_unit', pack: 'a' }])
    expect(
      validateMaterialUnits({
        dimension: 'volume',
        packs: [
          { id: 'a', qty: '2', of: { pack: 'b' } },
          { id: 'b', qty: '3', of: { pack: 'a' } },
          { id: 'c', qty: '4', of: { pack: 'c' } },
          { id: 'd', qty: '5', of: { pack: 'a' } },
        ],
      }),
    ).toEqual([
      { code: 'cycle', pack: 'a' },
      { code: 'cycle', pack: 'b' },
      { code: 'cycle', pack: 'c' },
      { code: 'cycle', pack: 'd' },
    ])
  })

  it('refuses a chain that ends in another dimension without a cross factor', () => {
    expect(
      validateMaterialUnits({ dimension: 'volume', packs: [{ id: 'sack', qty: '25', of: 'kg' }] }),
    ).toEqual([{ code: 'wrong_dimension', pack: 'sack' }])
    expect(
      validateMaterialUnits({
        dimension: 'volume',
        packs: [{ id: 'sack', qty: '25', of: 'kg' }],
        crossFactors: [{ unit: 'kg', qty: '1.087', of: 'l' }],
      }),
    ).toEqual([])
  })

  it('checks cross factors', () => {
    expect(
      validateMaterialUnits({
        dimension: 'mass',
        crossFactors: [
          { unit: 'kg', qty: '1', of: 'g' },
          { unit: 'l', qty: '920', of: 'g' },
          { unit: 'ml', qty: '0.92', of: 'g' },
          { unit: 'piece', qty: '150', of: 'ml' },
          { unit: 'h', qty: '0', of: 'g' },
          { unit: 'lb' as 'kg', qty: '453.59237', of: 'g' },
        ],
      }),
    ).toEqual([
      { code: 'cross_same_dimension', unit: 'kg' },
      { code: 'cross_duplicate_dimension', unit: 'ml' },
      { code: 'cross_wrong_target', unit: 'piece' },
      { code: 'invalid_qty', unit: 'h' },
      { code: 'unknown_unit', unit: 'lb' },
    ])
  })

  it('refuses units whose one is more or less base units than a stored quantity holds (D-130)', () => {
    // 1 silo = 9,999,999,999,999,999 kg: about 10^19 g, over numeric(24,6).
    expect(
      validateMaterialUnits({
        dimension: 'mass',
        packs: [{ id: 'silo', qty: '9999999999999999', of: 'kg' }],
      }),
    ).toEqual([{ code: 'too_large', pack: 'silo' }])
    // Each factor fits numeric(28,12), the chain does not: 1 fleet = 10^9 tanks = 10^21 ml.
    expect(
      validateMaterialUnits({
        dimension: 'volume',
        packs: [
          { id: 'tank', qty: '1000000000', of: 'l' },
          { id: 'fleet', qty: '1000000000', of: { pack: 'tank' } },
        ],
      }),
    ).toEqual([{ code: 'too_large', pack: 'fleet' }])
    // Just under 10^18 base units fits: 1 tanker = 999,999,999,999,999.999 L.
    expect(
      validateMaterialUnits({
        dimension: 'volume',
        packs: [{ id: 'tanker', qty: '999999999999999.999', of: 'l' }],
      }),
    ).toEqual([])
    // 1 speck = 0.0000001 g rounds to 0 g as a stored quantity; 0.0000005 g rounds to 0.000001.
    expect(
      validateMaterialUnits({
        dimension: 'mass',
        packs: [
          { id: 'speck', qty: '0.0000001', of: 'g' },
          { id: 'grain', qty: '0.0000005', of: 'g' },
        ],
      }),
    ).toEqual([{ code: 'too_small', pack: 'speck' }])
    // A cross factor: its own unit, and for too_large every unit of its kind (1 kg = 1000 g).
    expect(
      validateMaterialUnits({
        dimension: 'volume',
        crossFactors: [{ unit: 'kg', qty: '9999999999999999', of: 'l' }],
      }),
    ).toEqual([{ code: 'too_large', unit: 'kg' }])
    expect(
      validateMaterialUnits({
        dimension: 'volume',
        // 1 g = 10^15 ml fits; 1 kg is then 10^18 ml, which does not.
        crossFactors: [{ unit: 'g', qty: '1000000000000000', of: 'ml' }],
      }),
    ).toEqual([{ code: 'too_large', unit: 'g' }])
    expect(
      validateMaterialUnits({
        dimension: 'count',
        crossFactors: [{ unit: 'kg', qty: '0.0000001', of: 'piece' }],
      }),
    ).toEqual([{ code: 'too_small', unit: 'kg' }])
    // A small unit of the cross factor's kind may round to 0: only the unit given is checked.
    expect(
      validateMaterialUnits({
        dimension: 'count',
        crossFactors: [{ unit: 'm2', qty: '0.1', of: 'piece' }],
      }),
    ).toEqual([])
  })
})

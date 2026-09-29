import type { MaterialDto } from '@bizcost/contracts'
import type { Quantity } from '@bizcost/domain'
import { describe, expect, it } from 'vitest'
import {
  baseQuantity,
  defaultUnitOf,
  dimensionsOf,
  isUnitOf,
  lineUnitOf,
  pricePerCountingUnit,
  quantityInWords,
  unitRefOf,
} from './line-units'

// The units a purchase line is typed in, said in words, and what a price per pack makes per unit:
// the domain units engine's own conversions (the ones the API posts with).

function material(fields: Partial<MaterialDto> & Pick<MaterialDto, 'unit'>): MaterialDto {
  const dimension = { l: 'volume', ml: 'volume', kg: 'mass', g: 'mass', piece: 'count' } as const
  return {
    id: 'm1',
    name: 'Milk',
    dimension: dimension[fields.unit as keyof typeof dimension],
    packs: [],
    crossFactors: [],
    resaleProductId: null,
    archivedAt: null,
    version: 1,
    ...fields,
  }
}

const MILK = material({
  unit: 'l',
  packs: [
    { id: 'bottle', name: 'bottle', qty: '1', ofUnit: 'l', ofPackId: null },
    { id: 'carton', name: 'carton', qty: '12', ofUnit: null, ofPackId: 'bottle' },
  ],
})
const BEANS = material({
  name: 'Coffee beans',
  unit: 'kg',
  packs: [{ id: 'bag', name: 'bag', qty: '1', ofUnit: 'kg', ofPackId: null }],
})
const OIL = material({
  name: 'Oil',
  unit: 'g',
  crossFactors: [{ id: 'x', unit: 'l', qty: '920', ofUnit: 'g' }],
})

describe('purchase line units', () => {
  it('reads and writes the unit box', () => {
    expect(unitRefOf('unit:kg')).toBe('kg')
    expect(unitRefOf('pack:bag')).toEqual({ pack: 'bag' })
    expect(unitRefOf('')).toBeNull()
    expect(lineUnitOf('kg', null)).toBe('unit:kg')
    expect(lineUnitOf(null, 'bag')).toBe('pack:bag')
    expect(lineUnitOf(null, null)).toBe('')
  })

  it('starts a line in the biggest pack, else in the unit it is counted in', () => {
    expect(defaultUnitOf(MILK)).toBe('pack:carton')
    expect(defaultUnitOf(BEANS)).toBe('pack:bag')
    expect(defaultUnitOf(OIL)).toBe('unit:g')
  })

  it('offers its own kind of measure and the kinds it converts', () => {
    expect(dimensionsOf(OIL)).toEqual(['mass', 'volume'])
    expect(isUnitOf(OIL, 'unit:l')).toBe(true)
    expect(isUnitOf(MILK, 'unit:kg')).toBe(false)
    expect(isUnitOf(MILK, 'pack:bag')).toBe(false)
    expect(isUnitOf(MILK, 'pack:carton')).toBe(true)
  })

  it('says a quantity in words, down to the unit it is counted in', () => {
    expect(quantityInWords(MILK, '2' as Quantity, { pack: 'carton' })).toEqual([
      { kind: 'pack', qty: '2', name: 'carton' },
      { kind: 'pack', qty: '24', name: 'bottle' },
      { kind: 'unit', qty: '24', unit: 'l' },
    ])
    expect(quantityInWords(BEANS, '3' as Quantity, { pack: 'bag' })).toEqual([
      { kind: 'pack', qty: '3', name: 'bag' },
      { kind: 'unit', qty: '3', unit: 'kg' },
    ])
    expect(quantityInWords(BEANS, '500' as Quantity, 'g')).toEqual([
      { kind: 'unit', qty: '500', unit: 'g' },
      { kind: 'unit', qty: '0.5', unit: 'kg' },
    ])
    expect(quantityInWords(OIL, '2' as Quantity, 'l')).toEqual([
      { kind: 'unit', qty: '2', unit: 'l' },
      { kind: 'unit', qty: '1840', unit: 'g' },
    ])
    // Already in the counting unit: nothing more to say.
    expect(quantityInWords(MILK, '50' as Quantity, 'l')).toEqual([])
    // A removed pack.
    expect(quantityInWords(MILK, '1' as Quantity, { pack: 'gone' })).toBeNull()
  })

  it('works out the price per counting unit exactly', () => {
    // The owner's carton: AED 72 for 12 × 1 L → 6 per L.
    expect(pricePerCountingUnit(MILK, '72', '1' as Quantity, { pack: 'carton' })).toBe('6')
    expect(pricePerCountingUnit(BEANS, '45', '1' as Quantity, { pack: 'bag' })).toBe('45')
    expect(pricePerCountingUnit(BEANS, '12', '500' as Quantity, 'g')).toBe('24')
    expect(pricePerCountingUnit(BEANS, '1', '0' as Quantity, 'g')).toBeNull()
  })

  it('refuses a quantity the stock columns cannot hold', () => {
    const tanker = material({
      unit: 'kg',
      packs: [{ id: 't', name: 'tanker', qty: '1000000', ofUnit: 'kg', ofPackId: null }],
    })
    expect(baseQuantity(tanker, '1000000000000' as Quantity, { pack: 't' })).toEqual({
      ok: false,
      error: 'too_large',
    })
    expect(baseQuantity(BEANS, '0.000001' as Quantity, 'mg')).toEqual({
      ok: false,
      error: 'too_small',
    })
    expect(baseQuantity(MILK, '1' as Quantity, 'kg')).toEqual({ ok: false, error: 'unit' })
    expect(baseQuantity(MILK, '2' as Quantity, { pack: 'carton' })).toEqual({
      ok: true,
      base: '24000',
    })
  })
})

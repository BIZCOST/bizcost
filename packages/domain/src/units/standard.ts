// Standard units (D-034, docs/ARCHITECTURE.md §Numbers, money, units & time). Each dimension has
// one base unit, and every standard unit has an exact factor to it (powers of ten, 60, 3600), so
// standard conversions never lose a digit. The cost engine works per base unit.
//
// Base units:
// - mass → g, volume → ml, count → piece, length → mm (the owner's lists: kg/g/mg, L/ml, m/cm/mm);
// - area → cm²: a cost per base unit is stored at 12 decimals, and per cm² a price per m² keeps 4
//   more significant digits than per mm² would (AED 0.01 per m² is 0.000001 per cm²);
// - time → second (for machine and labour time): minute and hour are then exact whole factors,
//   while a base of one minute would make a second 1/60, which no decimal holds exactly.
// Across dimensions nothing converts, unless a material gives an explicit factor (units/materials.ts).

export const DIMENSIONS = ['mass', 'volume', 'count', 'length', 'area', 'time'] as const

export type Dimension = (typeof DIMENSIONS)[number]

/** Each standard unit: its dimension and how many base units one of it is (exact). */
export const STANDARD_UNITS = {
  mg: { dimension: 'mass', factor: '0.001' },
  g: { dimension: 'mass', factor: '1' },
  kg: { dimension: 'mass', factor: '1000' },
  ml: { dimension: 'volume', factor: '1' },
  l: { dimension: 'volume', factor: '1000' },
  piece: { dimension: 'count', factor: '1' },
  mm: { dimension: 'length', factor: '1' },
  cm: { dimension: 'length', factor: '10' },
  m: { dimension: 'length', factor: '1000' },
  mm2: { dimension: 'area', factor: '0.01' },
  cm2: { dimension: 'area', factor: '1' },
  m2: { dimension: 'area', factor: '10000' },
  s: { dimension: 'time', factor: '1' },
  min: { dimension: 'time', factor: '60' },
  h: { dimension: 'time', factor: '3600' },
} as const satisfies Record<string, { dimension: Dimension; factor: string }>

export type StandardUnit = keyof typeof STANDARD_UNITS

/** The base unit of each dimension: quantities and costs per unit are stored in it. */
export const BASE_UNITS = {
  mass: 'g',
  volume: 'ml',
  count: 'piece',
  length: 'mm',
  area: 'cm2',
  time: 's',
} as const satisfies Record<Dimension, StandardUnit>

export function isStandardUnit(value: string): value is StandardUnit {
  return Object.hasOwn(STANDARD_UNITS, value)
}

export function isDimension(value: string): value is Dimension {
  return (DIMENSIONS as readonly string[]).includes(value)
}

/** The dimension of a standard unit ('kg' → 'mass'). */
export function dimensionOf(unit: StandardUnit): Dimension {
  return STANDARD_UNITS[unit].dimension
}

import type { Tx } from '@bizcost/db'
import {
  checkDecimal,
  compareDecimal,
  toBase,
  type Dimension,
  type MaterialUnits,
  type Quantity,
  type StandardUnit,
} from '@bizcost/domain'
import { sql } from 'drizzle-orm'
import { AppError } from '../errors'
import { uuidArray } from './stock'

// The materials a purchase names, with the units they are bought in (D-034, D-108, D-130): a line's
// quantity in its purchase unit (a standard unit of the material's dimension, one of another dimension
// through its cross factor, or one of its packs) becomes base units through the domain's units engine.

export interface MaterialInfo {
  readonly id: string
  readonly name: string
  readonly dimension: Dimension
  readonly units: MaterialUnits
  /** Names of its live packs, by id. */
  readonly packNames: ReadonlyMap<string, string>
}

interface MaterialRecord extends Record<string, unknown> {
  id: string
  name: string
  dimension: Dimension
  units: {
    id: string
    kind: 'pack' | 'cross'
    name: string | null
    unit: StandardUnit | null
    qty: string
    of_unit: StandardUnit | null
    of_pack_id: string | null
  }[]
}

/** The live materials of the business among `ids`, with their live units. */
export async function loadMaterials(
  tx: Tx,
  businessId: string,
  ids: readonly string[],
): Promise<Map<string, MaterialInfo>> {
  const unique = [...new Set(ids)]
  const found = new Map<string, MaterialInfo>()
  if (unique.length === 0) return found
  const records = (await tx.execute(sql`
    select m.id, m.name, m.dimension,
           coalesce((
             select jsonb_agg(jsonb_build_object(
                      'id', u.id, 'kind', u.kind, 'name', u.name, 'unit', u.unit,
                      'qty', trim_scale(u.qty)::text, 'of_unit', u.of_unit,
                      'of_pack_id', u.of_pack_id) order by u.created_at, u.id)
               from app.material_units u
              where u.business_id = m.business_id and u.material_id = m.id and u.deleted_at is null
           ), '[]'::jsonb) as units
      from app.materials m
     where m.business_id = ${businessId}
       and m.id = any(${uuidArray(unique)})
       and m.deleted_at is null
  `)) as unknown as MaterialRecord[]
  for (const record of records) {
    const packs = record.units.filter((u) => u.kind === 'pack')
    found.set(record.id, {
      id: record.id,
      name: record.name,
      dimension: record.dimension,
      units: {
        dimension: record.dimension,
        packs: packs.map((u) => ({
          id: u.id,
          qty: u.qty,
          of: u.of_unit ?? { pack: u.of_pack_id ?? '' },
        })),
        crossFactors: record.units
          .filter((u) => u.kind === 'cross')
          .map((u) => ({ unit: u.unit ?? 'g', qty: u.qty, of: u.of_unit ?? 'g' })),
      },
      packNames: new Map(packs.map((u) => [u.id, u.name ?? ''] as const)),
    })
  }
  return found
}

/** A material line's purchase unit: a standard unit or one of the material's packs. */
export interface PurchaseUnit {
  readonly unit: StandardUnit | null
  readonly packId: string | null
}

/**
 * The line's quantity in the material's base unit. VALIDATION when the unit is not one of the
 * material's (a removed pack, another dimension without a cross factor), or the base quantity is 0
 * or more than a stored quantity holds (D-130).
 */
export function baseQtyOf(material: MaterialInfo, qty: string, unit: PurchaseUnit): Quantity {
  if (unit.packId !== null && !material.packNames.has(unit.packId)) {
    throw new AppError('validation', { message: 'unit: not a pack of this material' })
  }
  let base: Quantity
  try {
    base = toBase(
      qty as Quantity,
      unit.packId !== null ? { pack: unit.packId } : unit.unit!,
      material.units,
    )
  } catch (error) {
    throw new AppError('validation', {
      message: `unit: ${error instanceof Error ? error.message : 'cannot convert'}`,
    })
  }
  if (compareDecimal(base, '0') <= 0 || checkDecimal(base, 'quantity') !== null) {
    throw new AppError('validation', { message: 'qty: out of range in base units' })
  }
  return base
}

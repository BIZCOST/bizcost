import {
  CATALOG_NAME_MAX_LENGTH,
  cleanName,
  hasVisibleCharacter,
  PACK_NAME_MAX_LENGTH,
  withoutControlCharacters,
  type CreateMaterialInput,
  type MaterialDto,
} from '@bizcost/contracts'
import {
  dimensionOf,
  newId,
  validateMaterialUnits,
  type MaterialUnits,
  type StandardUnit,
  type UnitRef,
} from '@bizcost/domain'
import { readFactor, type FieldError } from './numbers'
import { isUnit } from './units'

// The material form (M2 Step 2; D-122): what the person typed, checked as they type with the domain
// units engine (validateMaterialUnits), and turned into material.create / material.update's fields.
// Every problem is attached to the field that can fix it.

/** A name as the API will store it (D-131): control characters as spaces, then cleanName. */
export function formName(value: string): string {
  return cleanName(withoutControlCharacters(value))
}

/** What a pack holds: a standard unit (`unit:l`) or another pack (`pack:<id>`); '' until chosen. */
export type PackOf = `unit:${StandardUnit}` | `pack:${string}` | ''

export interface PackDraft {
  readonly id: string
  readonly name: string
  readonly qty: string
  readonly of: PackOf
}

export interface CrossDraft {
  readonly id: string
  /** A unit of another kind of measure ('' until chosen). */
  readonly unit: StandardUnit | ''
  readonly qty: string
  /** A unit of the material's own kind of measure. */
  readonly of: StandardUnit | ''
}

export interface MaterialDraft {
  readonly name: string
  /** The unit the material is used in ('' until chosen). */
  readonly unit: StandardUnit | ''
  readonly packs: readonly PackDraft[]
  readonly crossFactors: readonly CrossDraft[]
}

export interface PackErrors {
  name?: FieldError
  qty?: FieldError
  of?: FieldError
}

export interface CrossErrors {
  unit?: FieldError
  qty?: FieldError
  of?: FieldError
}

export interface MaterialErrors {
  name?: FieldError
  unit?: FieldError
  packs: Record<string, PackErrors>
  crossFactors: Record<string, CrossErrors>
}

/** material.create's fields (without the id); material.update adds the id and the version. */
export type MaterialFields = Omit<CreateMaterialInput, 'id'>

export interface MaterialCheck {
  readonly errors: MaterialErrors
  /** The fields to send, when nothing is wrong. */
  readonly fields: MaterialFields | null
}

/** The form's first state: empty, or the material as it is stored. */
export function materialDraft(material?: MaterialDto): MaterialDraft {
  if (!material) return { name: '', unit: '', packs: [], crossFactors: [] }
  return {
    name: material.name,
    unit: material.unit,
    packs: material.packs.map((pack) => ({
      id: pack.id,
      name: pack.name,
      qty: pack.qty,
      of: pack.ofPackId ? `pack:${pack.ofPackId}` : pack.ofUnit ? `unit:${pack.ofUnit}` : '',
    })),
    crossFactors: material.crossFactors.map((cross) => ({
      id: cross.id,
      unit: cross.unit,
      qty: cross.qty,
      of: cross.ofUnit,
    })),
  }
}

/** How to check the form: which pack's "holds" was changed last (a loop is said on it). */
export interface MaterialCheckOptions {
  readonly lastChanged?: string
}

/** A new pack row: it holds the material's own unit until the person picks another. */
export function newPack(draft: MaterialDraft): PackDraft {
  return { id: newId(), name: '', qty: '', of: draft.unit ? `unit:${draft.unit}` : '' }
}

/** A new conversion row, landing in the material's own unit. */
export function newCross(draft: MaterialDraft): CrossDraft {
  return { id: newId(), unit: '', qty: '', of: draft.unit }
}

/** The pack or unit that `of` names, as the units engine reads it ('' for none yet). */
function refOf(of: PackOf): UnitRef {
  if (of.startsWith('pack:')) return { pack: of.slice(5) }
  const unit = of.slice(5)
  return (isUnit(unit) ? unit : '') as StandardUnit
}

function checkName(value: string, max: number, required: FieldError): FieldError | undefined {
  const name = formName(value)
  if (!hasVisibleCharacter(name)) return required
  if (name.length > max) return { key: 'catalog.form.nameTooLong', values: { count: max } }
  return undefined
}

/**
 * The loop `start` is part of, in the order the packs hold each other from `start` (null when its
 * chain does not come back to it).
 */
function loopOf(start: PackDraft, byId: ReadonlyMap<string, PackDraft>): PackDraft[] | null {
  const path: PackDraft[] = [start]
  for (let of = start.of; of.startsWith('pack:');) {
    const next = byId.get(of.slice(5))
    if (!next) return null
    if (next.id === start.id) return path
    if (path.includes(next)) return null
    path.push(next)
    of = next.of
  }
  return null
}

/** The pack a size problem is said on: not one whose inner pack has the same problem. */
function ownsSizeProblem(
  pack: PackDraft,
  code: string,
  problems: readonly { code: string; pack?: string }[],
): boolean {
  if (!pack.of.startsWith('pack:')) return true
  const inner = pack.of.slice(5)
  return !problems.some((p) => p.pack === inner && p.code === code)
}

/**
 * The material's units as far as they can be read: every pack and conversion, with quantities that
 * do not read yet taken as 1, so the chains can still be checked.
 */
export function draftUnits(draft: MaterialDraft): MaterialUnits | null {
  if (!draft.unit) return null
  return {
    dimension: dimensionOf(draft.unit),
    packs: draft.packs.map((pack) => {
      const qty = readFactor(pack.qty)
      return { id: pack.id, qty: qty.ok ? qty.value : '1', of: refOf(pack.of) }
    }),
    crossFactors: draft.crossFactors
      .filter((cross) => cross.unit !== '' && cross.of !== '')
      .map((cross) => {
        const qty = readFactor(cross.qty)
        return {
          unit: cross.unit as StandardUnit,
          qty: qty.ok ? qty.value : '1',
          of: cross.of as StandardUnit,
        }
      }),
  }
}

/**
 * Every problem of the form, and the fields to send when there is none. A loop of packs is said once,
 * on the pack whose "holds" was changed last when it is in the loop (else the loop's last in the
 * list), naming the loop.
 */
export function checkMaterial(
  draft: MaterialDraft,
  options: MaterialCheckOptions = {},
): MaterialCheck {
  const errors: MaterialErrors = { packs: {}, crossFactors: {} }
  errors.name = checkName(draft.name, CATALOG_NAME_MAX_LENGTH, { key: 'catalog.form.nameRequired' })
  if (!draft.unit) errors.unit = { key: 'catalog.materials.unitRequired' }

  const packErrors = (id: string) => (errors.packs[id] ??= {})
  const crossErrors = (id: string) => (errors.crossFactors[id] ??= {})

  const names = new Set<string>()
  for (const pack of draft.packs) {
    const name = checkName(pack.name, PACK_NAME_MAX_LENGTH, {
      key: 'catalog.materials.packs.nameRequired',
    })
    const key = formName(pack.name).toLowerCase()
    if (name) packErrors(pack.id).name = name
    else if (names.has(key)) packErrors(pack.id).name = { key: 'catalog.materials.packs.nameTaken' }
    names.add(key)
    const qty = readFactor(pack.qty)
    if (!qty.ok) packErrors(pack.id).qty = qty.error
    if (pack.of === '') packErrors(pack.id).of = { key: 'catalog.materials.packs.unknown' }
  }
  for (const cross of draft.crossFactors) {
    if (cross.unit === '') crossErrors(cross.id).unit = { key: 'catalog.form.pickUnit' }
    const qty = readFactor(cross.qty)
    if (!qty.ok) crossErrors(cross.id).qty = qty.error
    if (cross.of === '') crossErrors(cross.id).of = { key: 'catalog.form.pickUnit' }
  }

  // The chains, as the API will check them. A problem further down a chain is said once, on the
  // pack whose own choice causes it.
  const units = draftUnits(draft)
  if (units) {
    const byId = new Map(draft.packs.map((pack) => [pack.id, pack]))
    const crossByUnit = new Map(draft.crossFactors.map((cross) => [cross.unit, cross]))
    const problems = validateMaterialUnits(units)
    const loopsSaid = new Set<string>()
    for (const problem of problems) {
      const pack = problem.pack ? byId.get(problem.pack) : undefined
      const holdsPack = pack?.of.startsWith('pack:') ?? false
      switch (problem.code) {
        case 'cycle': {
          const loop = pack ? loopOf(pack, byId) : null
          if (!loop || loop.some((p) => loopsSaid.has(p.id))) break
          loop.forEach((p) => loopsSaid.add(p.id))
          const inList = draft.packs.filter((p) => loop.includes(p))
          const at =
            loop.find((p) => p.id === options.lastChanged) ?? inList[inList.length - 1] ?? loop[0]!
          const from = loop.indexOf(at)
          const names = [...loop.slice(from), ...loop.slice(0, from), at].map(
            (p) => formName(p.name) || '…',
          )
          packErrors(at.id).of ??= { key: 'catalog.materials.packs.cycle', chain: names }
          break
        }
        case 'unknown_pack':
          if (pack && holdsPack && !byId.has(pack.of.slice(5))) {
            packErrors(pack.id).of ??= { key: 'catalog.materials.packs.unknown' }
          }
          break
        case 'unknown_unit':
          if (pack && !holdsPack)
            packErrors(pack.id).of ??= { key: 'catalog.materials.packs.unknown' }
          break
        case 'wrong_dimension':
          if (pack && !holdsPack) {
            packErrors(pack.id).of ??= { key: 'catalog.materials.packs.wrongDimension' }
          }
          break
        case 'cross_same_dimension':
        case 'cross_duplicate_dimension': {
          const cross = crossByUnit.get(problem.unit as StandardUnit)
          if (cross) {
            crossErrors(cross.id).unit ??= {
              key:
                problem.code === 'cross_same_dimension'
                  ? 'catalog.materials.cross.sameKind'
                  : 'catalog.materials.cross.duplicate',
            }
          }
          break
        }
        case 'cross_wrong_target': {
          const cross = crossByUnit.get(problem.unit as StandardUnit)
          if (cross) crossErrors(cross.id).of ??= { key: 'catalog.materials.cross.wrongTarget' }
          break
        }
        case 'too_large':
        case 'too_small': {
          const large = problem.code === 'too_large'
          if (pack && ownsSizeProblem(pack, problem.code, problems)) {
            packErrors(pack.id).qty ??= {
              key: large ? 'catalog.materials.packs.tooLarge' : 'catalog.materials.packs.tooSmall',
            }
          }
          const cross = problem.unit ? crossByUnit.get(problem.unit as StandardUnit) : undefined
          if (cross) {
            crossErrors(cross.id).qty ??= {
              key: large ? 'catalog.materials.cross.tooLarge' : 'catalog.materials.cross.tooSmall',
            }
          }
          break
        }
        // Said by the quantity check above; pack ids are made by the form, never twice.
        case 'invalid_qty':
        case 'duplicate_pack':
          break
      }
    }
    // Two conversions of one kind: the engine names the unit, which both may share.
    const kinds = new Set<string>()
    for (const cross of draft.crossFactors) {
      if (!cross.unit) continue
      const kind = dimensionOf(cross.unit)
      if (kinds.has(kind))
        crossErrors(cross.id).unit ??= { key: 'catalog.materials.cross.duplicate' }
      kinds.add(kind)
    }
  }

  const hasErrors =
    Boolean(errors.name || errors.unit) ||
    Object.values(errors.packs).some((e) => e.name || e.qty || e.of) ||
    Object.values(errors.crossFactors).some((e) => e.unit || e.qty || e.of)
  if (hasErrors || !draft.unit) return { errors, fields: null }

  return {
    errors,
    fields: {
      name: formName(draft.name),
      unit: draft.unit,
      packs: draft.packs.map((pack) => ({
        id: pack.id,
        name: formName(pack.name),
        qty: (readFactor(pack.qty) as { value: string }).value,
        ofUnit: pack.of.startsWith('unit:') ? (pack.of.slice(5) as StandardUnit) : null,
        ofPackId: pack.of.startsWith('pack:') ? pack.of.slice(5) : null,
      })),
      crossFactors: draft.crossFactors.map((cross) => ({
        id: cross.id,
        unit: cross.unit as StandardUnit,
        qty: (readFactor(cross.qty) as { value: string }).value,
        ofUnit: cross.of as StandardUnit,
      })),
    },
  }
}

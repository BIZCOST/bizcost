import {
  COUNT_PARTS_MAX,
  STOCK_COUNT_LINES_MAX,
  type CountLineDto,
  type CountPartInput,
  type StockItemDto,
} from '@bizcost/contracts'
import {
  checkDecimal,
  compareDecimal,
  countedBaseQty,
  newId,
  parseNumber,
  subtractDecimals,
  sumDecimals,
  type CountedPart,
  type Quantity,
} from '@bizcost/domain'
import type { FieldError } from '../catalog/numbers'
import { outerPacks } from '../catalog/units'
import {
  defaultUnitOf,
  isUnitOf,
  lineUnitOf,
  unitRefOf,
  unitsOf,
  type LineUnit,
  type MaterialUnitsDto,
} from '../purchasing/line-units'

// A counted line as the count sheet holds it while someone types (M4 Step 2; Q6): one part or several
// ("12 cartons + 3 bottles"), each a quantity (zero or more, typed in either digit set) in one of the
// material's packs or units. What it comes to in base units is the domain's countedBaseQty, the very
// conversion the API saves with.

/** One part as typed: a quantity and its unit (`pack:<id>` or `unit:l`, LineUnit). */
export interface PartDraft {
  readonly key: string
  readonly qty: string
  readonly unit: LineUnit
}

export type LineDraft = readonly PartDraft[]

/**
 * The units a line offers, in the order "Add another" takes them: the biggest pack and the packs
 * inside it, then the unit the material is counted in.
 */
export function countingOrder(material: MaterialUnitsDto): LineUnit[] {
  const byId = new Map(material.packs.map((pack) => [pack.id, pack]))
  const order: LineUnit[] = []
  let pack = outerPacks(material.packs)[0]
  while (pack && !order.includes(`pack:${pack.id}`)) {
    order.push(`pack:${pack.id}`)
    pack = pack.ofPackId ? byId.get(pack.ofPackId) : undefined
  }
  order.push(`unit:${material.unit}`)
  return order
}

/** The unit a new part takes: the next of the counting order not used yet, else the counting unit. */
export function nextPartUnit(material: MaterialUnitsDto, draft: LineDraft): LineUnit {
  const used = new Set(draft.map((part) => part.unit))
  return countingOrder(material).find((unit) => !used.has(unit)) ?? `unit:${material.unit}`
}

/** A line's draft: what was saved, or one empty part in the biggest pack. */
export function lineDraftOf(
  line: Pick<CountLineDto, 'parts'>,
  material: MaterialUnitsDto,
): LineDraft {
  if (!line.parts || line.parts.length === 0) {
    return [{ key: newId(), qty: '', unit: defaultUnitOf(material) }]
  }
  return line.parts.map((part) => ({
    key: newId(),
    qty: part.qty,
    unit: lineUnitOf(part.unit, part.packId),
  }))
}

/** A part added after the others. */
export function withPart(material: MaterialUnitsDto, draft: LineDraft): LineDraft {
  if (draft.length >= COUNT_PARTS_MAX) return draft
  return [...draft, { key: newId(), qty: '', unit: nextPartUnit(material, draft) }]
}

/** One more or one less (never below zero; − on an empty box says 0: nothing on the shelf). */
export function stepCount(qty: string, step: 1 | -1): string {
  const read = parseNumber(qty)
  const current = read.ok && compareDecimal(read.value, '0') > 0 ? read.value : '0'
  const next = step === 1 ? sumDecimals([current, '1']) : subtractDecimals(current, '1')
  return compareDecimal(next, '0') > 0 ? next : '0'
}

/** A counted quantity: zero or more, numeric(24,6). */
export function readCountQty(
  input: string,
): { ok: true; value: string } | { ok: false; error: FieldError } {
  const parsed = parseNumber(input)
  if (!parsed.ok) {
    return {
      ok: false,
      error: {
        key: parsed.error === 'required' ? 'catalog.numbers.required' : 'catalog.numbers.invalid',
      },
    }
  }
  const fits = checkDecimal(parsed.value, 'quantity')
  if (fits === 'too_many_decimals')
    return { ok: false, error: { key: 'catalog.numbers.tooManyDecimals' } }
  if (fits) return { ok: false, error: { key: 'catalog.numbers.tooLarge' } }
  if (compareDecimal(parsed.value, '0') < 0) {
    return { ok: false, error: { key: 'catalog.numbers.notNegative' } }
  }
  return { ok: true, value: parsed.value }
}

export interface CheckedLine {
  /** Each part's problem, by its key. */
  readonly errors: Readonly<Record<string, FieldError>>
  /** What count.saveLine takes; null while a part does not read. */
  readonly parts: CountPartInput[] | null
  /** The parts together in base units; null while a part does not read. */
  readonly base: string | null
}

const UNIT_REQUIRED: FieldError = { key: 'stock.sheet.unitRequired' }

/** Each part's problem, and once every part reads, the parts to save and what they come to. */
export function checkLine(material: MaterialUnitsDto, draft: LineDraft): CheckedLine {
  const errors: Record<string, FieldError> = {}
  const parts: CountPartInput[] = []
  const counted: CountedPart[] = []
  for (const part of draft) {
    const qty = readCountQty(part.qty)
    const unit = unitRefOf(part.unit)
    if (!qty.ok) errors[part.key] = qty.error
    else if (!unit || !isUnitOf(material, part.unit)) errors[part.key] = UNIT_REQUIRED
    else {
      parts.push(
        typeof unit === 'string' ? { qty: qty.value, unit } : { qty: qty.value, packId: unit.pack },
      )
      counted.push({ qty: qty.value as Quantity, unit })
    }
  }
  if (Object.keys(errors).length > 0 || parts.length === 0)
    return { errors, parts: null, base: null }
  try {
    return { errors, parts, base: countedBaseQty(counted, unitsOf(material)) }
  } catch (error) {
    if (!(error instanceof RangeError)) throw error
    const last = draft.at(-1)!
    return { errors: { [last.key]: { key: 'catalog.numbers.tooLarge' } }, parts: null, base: null }
  }
}

/** What a draft says, without its keys and with numbers read (to tell whether it changed). */
function signature(draft: LineDraft): string {
  return JSON.stringify(
    draft.map((part) => {
      const read = parseNumber(part.qty)
      return [read.ok ? read.value : part.qty.trim(), part.unit]
    }),
  )
}

/** Whether `draft` says something else than the line as saved. */
export function changedFrom(
  draft: LineDraft,
  line: Pick<CountLineDto, 'parts'>,
  material: MaterialUnitsDto,
): boolean {
  if (!line.parts) return draft.some((part) => part.qty.trim() !== '')
  return signature(draft) !== signature(lineDraftOf(line, material))
}

/**
 * The latest day one of `items` was counted in `locationId`, with its name: a count must be dated
 * after it (COUNT_OUT_OF_ORDER otherwise, D-341). With the branch unknown (null: a business that
 * turned branches off and has several), each item's first count day, which every count follows.
 */
export function latestCount(
  items: readonly StockItemDto[],
  locationId: string | null,
): { date: string; name: string } | null {
  let latest: { date: string; name: string } | null = null
  for (const item of items) {
    const branch =
      locationId === null ? undefined : item.branches.find((b) => b.locationId === locationId)
    const date = branch?.lastCountedOn ?? item.trackedFrom
    if (latest === null || date > latest.date) latest = { date, name: item.material.name }
  }
  return latest
}

/**
 * Most materials one first count may take: it has a line per material in each of `branches` live
 * branches, and a count at most STOCK_COUNT_LINES_MAX lines.
 */
export function firstCountMax(branches: number): number {
  return Math.floor(STOCK_COUNT_LINES_MAX / Math.max(1, branches))
}

/**
 * "Select all": `ids` added to what is `picked`, in their order, up to `max` picked in all; `capped`
 * when some did not fit.
 */
export function pickUpTo(
  picked: ReadonlySet<string>,
  ids: readonly string[],
  max: number,
): { picked: ReadonlySet<string>; capped: boolean } {
  const next = new Set(picked)
  let capped = false
  for (const id of ids) {
    if (next.has(id)) continue
    if (next.size >= max) {
      capped = true
      break
    }
    next.add(id)
  }
  return { picked: next, capped }
}

import type { MaterialDto, RecipeDto, RecipeLineInput } from '@bizcost/contracts'
import {
  compareDecimal,
  costOfQty,
  type CostAmount,
  type Quantity,
  type StandardUnit,
} from '@bizcost/domain'
import {
  baseQuantity,
  isUnitOf,
  lineUnitOf,
  unitRefOf,
  type LineUnit,
} from '../purchasing/line-units'
import { readQuantity, type FieldError } from './numbers'

// The recipe form (M2 Step 4; D-115, D-146): what one unit of a product or service uses, a line per
// material, each a quantity in a unit or pack of it. What the person typed, checked with the domain
// units engine (the conversions the API saves with), and turned into recipe.save's lines. Costs on the
// screen are for display only: each line's base quantity × its material's average per base unit, the
// numbers the API works out exactly (and the saved total is shown as the API sent it).

export interface RecipeLineDraft {
  readonly id: string
  /** '' until one is picked. */
  readonly materialId: string
  /** As typed. */
  readonly qty: string
  readonly unit: LineUnit
}

export interface RecipeLineErrors {
  material?: FieldError
  qty?: FieldError
  unit?: FieldError
}

export interface RecipeCheck {
  readonly errors: Readonly<Record<string, RecipeLineErrors>>
  /** Each line in base units, where it converts (for the costs shown as it is typed). */
  readonly baseQty: ReadonlyMap<string, Quantity>
  /** recipe.save's lines, when nothing is wrong. */
  readonly lines: RecipeLineInput[] | null
}

/** The recipe as saved, as the form holds it. */
export function recipeDraft(recipe: RecipeDto): RecipeLineDraft[] {
  return recipe.lines.map((line) => ({
    id: line.id,
    materialId: line.materialId,
    qty: line.qty,
    unit: lineUnitOf(line.unit, line.packId),
  }))
}

/** The small unit a recipe usually counts a material in: grams, millilitres, pieces. */
const RECIPE_UNIT: Partial<Record<MaterialDto['dimension'], StandardUnit>> = {
  mass: 'g',
  volume: 'ml',
  count: 'piece',
}

/** The unit a new line of this material starts in (a recipe uses a little of it: 18 g, 200 ml). */
export function recipeUnitOf(material: MaterialDto): LineUnit {
  return `unit:${RECIPE_UNIT[material.dimension] ?? material.unit}`
}

/** Whether the form still says what was saved (same lines, in the same order). */
export function isSaved(lines: readonly RecipeLineDraft[], recipe: RecipeDto): boolean {
  const saved = recipeDraft(recipe)
  return (
    lines.length === saved.length &&
    lines.every((line, i) => {
      const other = saved[i]
      if (!other) return false
      const qty = readQuantity(line.qty)
      return (
        line.id === other.id &&
        line.materialId === other.materialId &&
        line.unit === other.unit &&
        qty.ok &&
        compareDecimal(qty.value, other.qty) === 0
      )
    })
  )
}

/**
 * The lines with one moved up (-1) or down (+1); unchanged at either end. recipe.save keeps the order
 * the lines are sent in.
 */
export function moveLine<T extends { readonly id: string }>(
  lines: readonly T[],
  id: string,
  by: -1 | 1,
): T[] {
  const from = lines.findIndex((line) => line.id === id)
  const to = from + by
  const next = [...lines]
  const moving = next[from]
  const other = next[to]
  if (from < 0 || moving === undefined || other === undefined) return next
  next[to] = moving
  next[from] = other
  return next
}

/**
 * Every problem of the form, each on the line that can fix it, and the lines to send when there is
 * none. A material on two lines is said on the second one.
 */
export function checkRecipe(
  lines: readonly RecipeLineDraft[],
  materials: ReadonlyMap<string, MaterialDto>,
): RecipeCheck {
  const errors: Record<string, RecipeLineErrors> = {}
  const baseQty = new Map<string, Quantity>()
  const seen = new Set<string>()
  const out: RecipeLineInput[] = []
  for (const line of lines) {
    const lineErrors: RecipeLineErrors = {}
    const material = line.materialId ? materials.get(line.materialId) : undefined
    if (!material) lineErrors.material = { key: 'catalog.recipes.needMaterial' }
    else if (seen.has(material.id)) lineErrors.material = { key: 'catalog.recipes.duplicate' }
    if (material) seen.add(material.id)
    const qty = readQuantity(line.qty)
    if (!qty.ok) lineErrors.qty = qty.error
    const ref = unitRefOf(line.unit)
    if (material && (!ref || !isUnitOf(material, line.unit))) {
      lineErrors.unit = { key: 'catalog.form.pickUnit' }
    } else if (material && ref && qty.ok) {
      const base = baseQuantity(material, qty.value as Quantity, ref)
      if (base.ok) baseQty.set(line.id, base.base)
      else if (base.error === 'too_small') lineErrors.qty = { key: 'catalog.recipes.tooSmall' }
      else if (base.error === 'too_large') lineErrors.qty = { key: 'catalog.recipes.tooLarge' }
      else lineErrors.unit = { key: 'catalog.form.pickUnit' }
    }
    if (lineErrors.material || lineErrors.qty || lineErrors.unit) {
      errors[line.id] = lineErrors
      continue
    }
    out.push({
      id: line.id,
      materialId: line.materialId,
      qty: (qty as { value: string }).value,
      unit: typeof ref === 'string' ? ref : null,
      packId: ref && typeof ref !== 'string' ? ref.pack : null,
    })
  }
  const valid = Object.keys(errors).length === 0
  return { errors, baseQty, lines: valid ? out : null }
}

/**
 * What a line costs, for the screen: its base quantity × the material's average per base unit (12
 * decimals, as material.costs gives it), rounded to 12 decimals; the screen rounds it again to the
 * currency.
 */
export function lineCostOf(baseQty: Quantity, perBaseUnit: string): CostAmount | null {
  return costOfQty(baseQty, { value: perBaseUnit, qty: '1' })
}

import { areaBlocks, areaKey, groupByArea, type AreaBlock } from '@bizcost/domain'

// A quotation's areas in the editor (the owner's round of 2026-10-18, D-299: «يقدر يحدد عدد البنود
// فالمنطقه اللي يطلع اسمها مائل»): the lines are grouped under their areas, each area's lines together
// as the PDF prints them (its name up the side of their cell). These moves keep that order: a line
// moves inside its area, or into another area (at its end), or out of any area (just after the area it
// leaves); an area moves with its lines past the area or line before or after it; a line without an
// area moves past the block beside it. The API saves the same order (groupByArea).

export interface AreaLineDraft {
  readonly id: string
  readonly area: string | null
}

const flat = <T extends AreaLineDraft>(blocks: readonly AreaBlock<T>[]): T[] =>
  groupByArea(blocks.flatMap((block) => block.lines))

const sameArea = (a: string | null, b: string | null) =>
  a === null || b === null ? a === b : areaKey(a) === areaKey(b)

/** The block holding line `id`, and where the line is in it. */
function find<T extends AreaLineDraft>(blocks: readonly AreaBlock<T>[], id: string) {
  for (const [index, block] of blocks.entries()) {
    const at = block.lines.findIndex((line) => line.id === id)
    if (at >= 0) return { index, at }
  }
  return null
}

function swap<T>(items: readonly T[], i: number, j: number): T[] {
  const copy = [...items]
  ;[copy[i], copy[j]] = [copy[j]!, copy[i]!]
  return copy
}

/** Whether line `id` can move one place up (-1) or down (1). */
export function canMoveLine(lines: readonly AreaLineDraft[], id: string, step: -1 | 1): boolean {
  const blocks = areaBlocks(lines)
  const found = find(blocks, id)
  if (!found) return false
  const block = blocks[found.index]!
  if (block.area !== null) {
    const to = found.at + step
    return to >= 0 && to < block.lines.length
  }
  const to = found.index + step
  return to >= 0 && to < blocks.length
}

/**
 * Moves line `id` one place up (-1) or down (1): inside its area, or (a line without an area) past
 * the block before or after it. A line at the edge of its area stays (it moves to another area
 * with `setLineArea`).
 */
export function moveLine<T extends AreaLineDraft>(
  lines: readonly T[],
  id: string,
  step: -1 | 1,
): T[] {
  if (!canMoveLine(lines, id, step)) return [...lines]
  const blocks = areaBlocks(lines)
  const found = find(blocks, id)!
  const block = blocks[found.index]!
  if (block.area !== null) {
    const moved = { area: block.area, lines: swap(block.lines, found.at, found.at + step) }
    return flat(blocks.map((b, i) => (i === found.index ? moved : b)))
  }
  return flat(swap(blocks, found.index, found.index + step))
}

/** Whether the area `name` can move one place up (-1) or down (1). */
export function canMoveArea(lines: readonly AreaLineDraft[], name: string, step: -1 | 1): boolean {
  const blocks = areaBlocks(lines)
  const index = blocks.findIndex((b) => b.area !== null && sameArea(b.area, name))
  return index >= 0 && index + step >= 0 && index + step < blocks.length
}

/** Moves the area `name`, with its lines, past the block (an area or a line) before or after it. */
export function moveArea<T extends AreaLineDraft>(
  lines: readonly T[],
  name: string,
  step: -1 | 1,
): T[] {
  if (!canMoveArea(lines, name, step)) return [...lines]
  const blocks = areaBlocks(lines)
  const index = blocks.findIndex((b) => b.area !== null && sameArea(b.area, name))
  return flat(swap(blocks, index, index + step))
}

/**
 * Puts line `id` in the area `area` (null: in none): at the end of that area's lines; a new area
 * starts where the line was (just after the area it leaves); a line taken out of an area comes just
 * after it. When `blank` is given and every line the area holds yet is blank (the empty line an area
 * starts with, nothing entered in it), those lines give their place to the line put in: lines typed
 * before their area was added are grouped without an empty line left at its top.
 */
export function setLineArea<T extends AreaLineDraft>(
  lines: readonly T[],
  id: string,
  area: string | null,
  blank?: (line: T) => boolean,
): T[] {
  const moved = placeLine(lines, id, area)
  if (!blank || area === null) return moved
  const others = moved.filter(
    (line) => line.id !== id && line.area !== null && sameArea(line.area, area),
  )
  if (others.length === 0 || !others.every(blank)) return moved
  const placeholders = new Set(others.map((line) => line.id))
  return moved.filter((line) => !placeholders.has(line.id))
}

function placeLine<T extends AreaLineDraft>(
  lines: readonly T[],
  id: string,
  area: string | null,
): T[] {
  const blocks = areaBlocks(lines)
  const found = find(blocks, id)
  if (!found) return [...lines]
  const from = blocks[found.index]!
  const line = from.lines[found.at]!
  const name = area === null || area.trim() === '' ? null : area.trim()
  if (sameArea(from.area, name)) return [...lines]
  const left: AreaBlock<T>[] = blocks.map((b, i) =>
    i === found.index ? { area: b.area, lines: b.lines.filter((l) => l.id !== id) } : b,
  )
  const target =
    name === null ? -1 : left.findIndex((b) => b.area !== null && sameArea(b.area, name))
  if (target >= 0) {
    const into = left[target]!
    const moved = { ...line, area: into.area }
    left[target] = { area: into.area, lines: [...into.lines, moved] }
  } else {
    // Just after the block it leaves (where it was, when that block is now empty).
    const at = left[found.index]!.lines.length > 0 ? found.index + 1 : found.index
    left.splice(at, 0, { area: name, lines: [{ ...line, area: name }] })
  }
  return flat(left.filter((b) => b.lines.length > 0))
}

/** Renames the area `from` to `to` on every line of it. */
export function renameArea<T extends AreaLineDraft>(
  lines: readonly T[],
  from: string,
  to: string,
): T[] {
  const name = to.trim()
  if (name === '') return [...lines]
  return groupByArea(
    lines.map((line) =>
      line.area !== null && sameArea(line.area, from) ? { ...line, area: name } : line,
    ),
  )
}

/** Adds `line` at the end of the area `area`'s lines (null, or an area not used yet: at the end). */
export function addLineTo<T extends AreaLineDraft>(
  lines: readonly T[],
  line: T,
  area: string | null,
): T[] {
  const blocks = areaBlocks(lines)
  const target =
    area === null ? -1 : blocks.findIndex((b) => b.area !== null && sameArea(b.area, area))
  if (target < 0) return groupByArea([...lines, { ...line, area }])
  const into = blocks[target]!
  return flat(
    blocks.map((b, i) =>
      i === target ? { area: b.area, lines: [...b.lines, { ...line, area: into.area }] } : b,
    ),
  )
}

/** Whether `name` would be a second area of the lines (read as areaKey reads names). */
export function areaTaken(
  lines: readonly AreaLineDraft[],
  name: string,
  except: string | null = null,
): boolean {
  const key = areaKey(name)
  return lines.some(
    (line) =>
      line.area !== null &&
      areaKey(line.area) === key &&
      (except === null || areaKey(except) !== key),
  )
}

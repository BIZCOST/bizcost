// A quotation's areas or rooms (M3 Step 7; the owner's round of 2026-10-18, D-299: «يقدر يحدد عدد
// البنود فالمنطقه اللي يطلع اسمها مائل»): the PDF writes an area's name up the side of one cell that
// spans its lines, so the lines the owner puts in an area must come one after the other. The editor
// keeps them so (areas are sections there), and the API puts any order it is sent into this one before
// it saves (`groupByArea`), so the cell spans exactly the lines of its area, also across a page break.
//
// Two names are one area when they read the same (`areaKey`: Unicode NFC, spaces collapsed, letter
// case ignored); its lines then all take the spelling of its first line.

export interface AreaLine {
  /** The area or room the line belongs to; null: none. */
  readonly area: string | null
}

/** How area names are compared: NFC, one space between words, trimmed, letter case ignored. */
export function areaKey(name: string): string {
  return name.normalize('NFC').replace(/\s+/gu, ' ').trim().toLowerCase()
}

/**
 * The lines in the order the PDF prints them: each area's lines together, in the order they came,
 * the areas in the order each first comes, and every line without an area kept in its place among
 * them ([A1, –, B1, A2] → [A1, A2, –, B1]). A line whose area is spelled differently from its area's
 * first line takes that spelling. Lines already in this order come back as they were (the same
 * objects, in a new array).
 */
export function groupByArea<T extends AreaLine>(lines: readonly T[]): T[] {
  const groups: { key: string | null; name: string | null; lines: T[] }[] = []
  const byKey = new Map<string, { key: string | null; name: string | null; lines: T[] }>()
  for (const line of lines) {
    const name = line.area === null || line.area.trim() === '' ? null : line.area
    if (name === null) {
      groups.push({ key: null, name: null, lines: [line] })
      continue
    }
    const key = areaKey(name)
    const group = byKey.get(key)
    if (group) {
      group.lines.push(group.name === line.area ? line : { ...line, area: group.name })
    } else {
      const made = { key, name, lines: [line] }
      byKey.set(key, made)
      groups.push(made)
    }
  }
  return groups.flatMap((group) => group.lines)
}

/** One area's lines, or one line without an area. */
export interface AreaBlock<T> {
  /** The area's name (as its first line spells it); null: a line without an area. */
  readonly area: string | null
  readonly lines: readonly T[]
}

/**
 * The lines as blocks, in order: the consecutive lines of one area as one block, and each line
 * without an area as a block of its own (the editor moves an area, or a line without one, past the
 * block beside it).
 */
export function areaBlocks<T extends AreaLine>(lines: readonly T[]): AreaBlock<T>[] {
  const blocks: { area: string | null; key: string | null; lines: T[] }[] = []
  for (const line of lines) {
    const name = line.area === null || line.area.trim() === '' ? null : line.area
    const key = name === null ? null : areaKey(name)
    const last = blocks.at(-1)
    if (key !== null && last && last.key === key) last.lines.push(line)
    else blocks.push({ area: name, key, lines: [line] })
  }
  return blocks.map(({ area, lines: blockLines }) => ({ area, lines: blockLines }))
}

/** The areas the lines use, each once (by areaKey), in the order each first comes. */
export function areaNames(lines: readonly AreaLine[]): string[] {
  const seen = new Map<string, string>()
  for (const line of lines) {
    if (line.area === null || line.area.trim() === '') continue
    const key = areaKey(line.area)
    if (!seen.has(key)) seen.set(key, line.area)
  }
  return [...seen.values()]
}

import type { MaterialDto } from '@bizcost/contracts'
import { nameKey } from '@bizcost/domain'

// What a purchase line's material picker lists (material-picker.tsx; the owner's request of
// 2026-09-29).

export type PickerOption =
  | { readonly kind: 'material'; readonly material: MaterialDto; readonly archived?: true }
  | { readonly kind: 'add'; readonly name: string }

/** A name as typed in a picker: spaces trimmed and collapsed (the quick-add sheet starts with it). */
export function typedName(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

/**
 * The list for `typed`: every material it offers by name while nothing is typed; else those whose
 * names hold what is typed, compared the way people read them (nameKey: case, spaces, Arabic letter
 * forms, marks and digits), names that start with it first; then, when none of them has that very
 * name: an archived material that has it (`all`: archived ones too), marked archived, since names
 * are one per business and it can still be used; else, when `canAdd`, "Add «typed»".
 */
export function pickerOptions(
  typed: string,
  pickable: readonly MaterialDto[],
  locale: string,
  canAdd: boolean,
  all: readonly MaterialDto[] = pickable,
): PickerOption[] {
  const byName = (a: MaterialDto, b: MaterialDto) => a.name.localeCompare(b.name, locale)
  const name = typedName(typed)
  const key = nameKey(name)
  if (key === '') {
    return [...pickable].sort(byName).map((material) => ({ kind: 'material', material }))
  }
  const starts = (material: MaterialDto) => nameKey(material.name).startsWith(key)
  const options: PickerOption[] = pickable
    .filter((material) => nameKey(material.name).includes(key))
    .sort((a, b) => Number(starts(b)) - Number(starts(a)) || byName(a, b))
    .map((material) => ({ kind: 'material', material }))
  if (pickable.some((material) => nameKey(material.name) === key)) return options
  const archived = all.find(
    (material) => material.archivedAt !== null && nameKey(material.name) === key,
  )
  if (archived) options.push({ kind: 'material', material: archived, archived: true })
  else if (canAdd) options.push({ kind: 'add', name })
  return options
}

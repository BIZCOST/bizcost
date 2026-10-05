import { nameKey } from '@bizcost/domain'

// What a document line's name picker lists (name-picker.tsx): a purchase line's material (the owner's
// request of 2026-09-29), a sale line's product or service (M3 Step 2).

/** What a picker can list: a record of the business with a name, archived or not. */
export interface Pickable {
  readonly id: string
  readonly name: string
  readonly archivedAt: string | null
}

export type PickerOption<T extends Pickable> =
  | { readonly kind: 'item'; readonly item: T; readonly archived?: true }
  | { readonly kind: 'add'; readonly name: string }

/** A name as typed in a picker: spaces trimmed and collapsed (the quick-add sheet starts with it). */
export function typedName(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

/**
 * The list for `typed`: every record it offers by name while nothing is typed; else those whose
 * names hold what is typed, compared the way people read them (nameKey: case, spaces, Arabic letter
 * forms, marks and digits), names that start with it first; then, when none of them has that very
 * name: an archived record that has it (`all`: archived ones too), marked archived, since names are
 * one per business and it can still be used; else, when `canAdd`, "Add «typed»".
 */
export function pickerOptions<T extends Pickable>(
  typed: string,
  pickable: readonly T[],
  locale: string,
  canAdd: boolean,
  all: readonly T[] = pickable,
): PickerOption<T>[] {
  const byName = (a: T, b: T) => a.name.localeCompare(b.name, locale)
  const name = typedName(typed)
  const key = nameKey(name)
  if (key === '') {
    return [...pickable].sort(byName).map((item) => ({ kind: 'item', item }))
  }
  const starts = (item: T) => nameKey(item.name).startsWith(key)
  const options: PickerOption<T>[] = pickable
    .filter((item) => nameKey(item.name).includes(key))
    .sort((a, b) => Number(starts(b)) - Number(starts(a)) || byName(a, b))
    .map((item) => ({ kind: 'item', item }))
  if (pickable.some((item) => nameKey(item.name) === key)) return options
  const archived = all.find((item) => item.archivedAt !== null && nameKey(item.name) === key)
  if (archived) options.push({ kind: 'item', item: archived, archived: true })
  else if (canAdd) options.push({ kind: 'add', name })
  return options
}

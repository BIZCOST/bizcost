import type { CountLineDto } from '@bizcost/contracts'
import type { MaterialUnitsDto } from '../purchasing/line-units'
import { changedFrom, type LineDraft } from './count-draft'

// What is typed on a count's sheet, line by line (M4 Step 2): a sheet may hold a thousand lines, so
// each line reads its own edit from this store and a keystroke re-renders that line alone; the sheet
// listens only to which lines have a change not saved (the unsaved-changes guard, "Not counted yet").
// Several people count one sheet (Q6): a line keeps the version its change started from, so saving
// over someone else's save is CONFLICT (the line reloads); once the typing is back to what is saved,
// the line follows the server again (a later save by someone else shows, no stale version is kept).

/** A line as typed. */
export interface LineEdit {
  readonly draft: LineDraft
  /**
   * The line's version when the change started: saved with it, so a save made since is CONFLICT.
   * Null while the draft says what is saved (nothing to save).
   */
  readonly version: number | null
  /** The line's version when it was last typed in. */
  readonly seen: number
}

/** A line's edit after `draft` was typed in it (`edit`: its edit before, as shown). */
export function nextEdit(
  edit: LineEdit | undefined,
  draft: LineDraft,
  line: Pick<CountLineDto, 'parts' | 'version'>,
  material: MaterialUnitsDto,
): LineEdit {
  if (!changedFrom(draft, line, material)) return { draft, version: null, seen: line.version }
  return { draft, version: edit?.version ?? line.version, seen: line.version }
}

/**
 * The edit a line shows: one with a change not saved, or one that says what is saved while the line
 * wasn't saved again since; otherwise none (the line as saved now).
 */
export function shownEdit(
  edit: LineEdit | undefined,
  line: Pick<CountLineDto, 'version'>,
): LineEdit | undefined {
  if (!edit) return undefined
  return edit.version !== null || edit.seen === line.version ? edit : undefined
}

type Listener = () => void

/** The edits of one count's sheet, by line id. */
export class CountEdits {
  readonly #edits = new Map<string, LineEdit>()
  readonly #lineListeners = new Map<string, Set<Listener>>()
  readonly #listeners = new Set<Listener>()
  #changed: ReadonlySet<string> = new Set()

  get(lineId: string): LineEdit | undefined {
    return this.#edits.get(lineId)
  }

  /** The lines with a change not saved: the same set until a line starts or stops having one. */
  readonly changed = (): ReadonlySet<string> => this.#changed

  /** Sets (or, with undefined, drops) a line's edit. */
  set(lineId: string, edit: LineEdit | undefined): void {
    if (edit) this.#edits.set(lineId, edit)
    else if (!this.#edits.delete(lineId)) return
    for (const listener of this.#lineListeners.get(lineId) ?? []) listener()
    const changed = edit !== undefined && edit.version !== null
    if (changed === this.#changed.has(lineId)) return
    const next = new Set(this.#changed)
    if (changed) next.add(lineId)
    else next.delete(lineId)
    this.#changed = next
    for (const listener of this.#listeners) listener()
  }

  /** Drops every edit. */
  clear(): void {
    for (const lineId of [...this.#edits.keys()]) this.set(lineId, undefined)
  }

  /** Calls `listener` when line `lineId`'s edit changes. */
  subscribeLine(lineId: string, listener: Listener): () => void {
    let listeners = this.#lineListeners.get(lineId)
    if (!listeners) {
      listeners = new Set()
      this.#lineListeners.set(lineId, listeners)
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.#lineListeners.delete(lineId)
    }
  }

  /** Calls `listener` when the lines with a change not saved change. */
  readonly subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }
}

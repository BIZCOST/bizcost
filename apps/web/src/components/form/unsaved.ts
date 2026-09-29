// Pure parts of the unsaved-changes guard (unsaved-changes.tsx): whether a form's state differs from
// what it started with, and whether a click on a link leaves the page for another page of the app.

/**
 * Whether two form states hold the same data: plain objects, arrays, strings, numbers, booleans,
 * null and undefined, compared by value (a Set by its members, a File by identity). A form that was
 * changed and changed back is unchanged.
 */
export function sameData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((value, index) => sameData(value, b[index]))
  }
  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set) || !(b instanceof Set) || a.size !== b.size) return false
    return [...a].every((value) => b.has(value))
  }
  if (
    Object.getPrototypeOf(a) !== Object.prototype ||
    Object.getPrototypeOf(b) !== Object.prototype
  ) {
    return false
  }
  const keysA = Object.keys(a).filter((key) => (a as Record<string, unknown>)[key] !== undefined)
  const keysB = Object.keys(b).filter((key) => (b as Record<string, unknown>)[key] !== undefined)
  if (keysA.length !== keysB.length) return false
  return keysA.every((key) =>
    sameData((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  )
}

/** What a click on a link does, as far as the guard is concerned. */
export interface LinkClick {
  /** The link's resolved address. */
  readonly href: string
  /** The link's target attribute ('' when none). */
  readonly target: string
  readonly download: boolean
  /** A modifier key or a button other than the main one (a new tab or window). */
  readonly modified: boolean
}

/**
 * The address a click leaves for, when it leaves the page for another page of the app in the same
 * tab (a path with its query and hash); null when the click stays (a hash on the same page), opens
 * elsewhere (another tab, a download) or leaves the app (the browser asks before it unloads).
 */
export function leavingTo(click: LinkClick, current: string): string | null {
  if (click.modified || click.download) return null
  if (click.target !== '' && click.target !== '_self') return null
  let to: URL
  let from: URL
  try {
    from = new URL(current)
    to = new URL(click.href, from)
  } catch {
    return null
  }
  if (to.origin !== from.origin) return null
  if (to.pathname === from.pathname && to.search === from.search) return null
  return `${to.pathname}${to.search}${to.hash}`
}

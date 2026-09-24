// Which locations a member may work with (`member_locations`). An EMPTY set means ALL locations of
// the business, including ones added later (DECISIONS.md). A non-empty set limits the member to it.

export type LocationScope =
  { readonly all: true } | { readonly all: false; readonly ids: ReadonlySet<string> }

const ALL_LOCATIONS: LocationScope = Object.freeze({ all: true })

export function resolveLocationScope(memberLocationIds: readonly string[]): LocationScope {
  if (memberLocationIds.length === 0) return ALL_LOCATIONS
  // UUIDs compare case-insensitively; Postgres returns them lowercase.
  return { all: false, ids: new Set(memberLocationIds.map((id) => id.toLowerCase())) }
}

export function canAccessLocation(scope: LocationScope, locationId: string): boolean {
  return scope.all || scope.ids.has(locationId.toLowerCase())
}

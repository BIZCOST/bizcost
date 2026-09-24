// Permission keys look like `module.resource.action` (docs/ARCHITECTURE.md §Permissions): three
// lowercase snake_case segments. The catalog of valid keys is data in @bizcost/modules; the engine
// receives it as an argument.

const SEGMENT = '[a-z][a-z0-9_]*'

const PERMISSION_KEY_PATTERN = new RegExp(`^${SEGMENT}\\.${SEGMENT}\\.${SEGMENT}$`)

/** True when the value is a well-formed `module.resource.action` key (it may not be in the catalog). */
export function isPermissionKey(value: unknown): value is string {
  return typeof value === 'string' && PERMISSION_KEY_PATTERN.test(value)
}

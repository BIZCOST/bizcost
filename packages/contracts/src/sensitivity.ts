import type { SensitivityCategory } from '@bizcost/domain'
import { z } from 'zod'

// Sensitivity tags on output schemas (docs/ARCHITECTURE.md §Permissions, Redaction). The redact
// middleware in @bizcost/api reads them from this registry and removes fields whose category the
// member may not see. A dedicated registry (not free-form .meta()) so tags cannot be set by accident.

export interface SensitivityMeta {
  readonly category: SensitivityCategory
}

export const sensitivityRegistry = z.registry<SensitivityMeta>()

/**
 * Tags a field as sensitive. The field may be removed by redaction, so the returned schema is
 * optional. The input schema itself is not tagged (it is copied first), so shared instances such as
 * zDecimal stay untagged.
 */
export function sensitive<T extends z.ZodType>(
  schema: T,
  category: SensitivityCategory,
): z.ZodOptional<T> {
  const meta: SensitivityMeta = { category }
  const tagged = schema.clone()
  sensitivityRegistry.add(tagged, meta)
  const field = tagged.optional()
  sensitivityRegistry.add(field, meta)
  return field
}

/**
 * Zod types that wrap one schema (`def.innerType`) and keep the wrapped value's shape: a tag on the
 * inner schema still applies. Shared with the redactor in @bizcost/api, so both agree on what a
 * field wrapper is.
 */
export const FIELD_WRAPPER_TYPES: ReadonlySet<string> = new Set([
  'optional',
  'nullable',
  'default',
  'prefault',
  'catch',
  'readonly',
  'nonoptional',
])

/**
 * The sensitivity category of a field schema, looking through wrappers such as optional/nullable/
 * default, through pipes (transforms) and through z.lazy(). Undefined when the field is not
 * sensitive. Does not look inside objects, arrays, unions or intersections: the redactor walks those
 * itself and rejects tags it cannot place.
 */
export function sensitivityOf(schema: z.core.$ZodType): SensitivityCategory | undefined {
  return categoryOf(schema, new Set())
}

function categoryOf(
  schema: z.core.$ZodType,
  seen: Set<z.core.$ZodType>,
): SensitivityCategory | undefined {
  const tag = sensitivityRegistry.get(schema)
  if (tag) return tag.category
  if (seen.has(schema)) return undefined // a lazy schema that refers to itself
  seen.add(schema)
  const def = schema._zod.def
  if (FIELD_WRAPPER_TYPES.has(def.type)) {
    return categoryOf((def as z.core.$ZodOptionalDef).innerType, seen)
  }
  if (def.type === 'pipe') {
    const pipe = def as z.core.$ZodPipeDef
    return categoryOf(pipe.in, seen) ?? categoryOf(pipe.out, seen)
  }
  if (def.type === 'lazy') return categoryOf((schema as z.core.$ZodLazy)._zod.innerType, seen)
  return undefined
}

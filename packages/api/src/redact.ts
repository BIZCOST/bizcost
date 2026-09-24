import {
  FIELD_WRAPPER_TYPES,
  isWithMeta,
  sensitivityOf,
  type RedactionMeta,
} from '@bizcost/contracts'
import type { SensitivityCategory } from '@bizcost/domain'
import type { z } from 'zod'

// Automatic redaction (docs/ARCHITECTURE.md §Permissions, Redaction; D-026). The redact middleware
// walks each procedure's OUTPUT schema, removes the fields tagged with sensitive() whose category the
// member may not see, and lists their paths in meta.redacted.
//
// Paths are dotted and relative to the envelope's `data`; `*` stands for every item of an array, every
// value of a record and every extra key of an object with .catchall() (e.g. `lines.*.unitCost`). They
// come from the schema, not from the value, so the UI can lock a column even when the list is empty,
// and presence reveals nothing.
//
// The walker fails closed: a schema whose values it cannot follow (z.unknown/any/custom, loose
// objects, transforms, Map/Set/promise, unknown Zod types) or a tag it cannot place is a
// SensitiveSchemaError, so an untyped value can never carry a sensitive field past it.

type Schema = z.core.$ZodType

export interface SensitivePath {
  readonly path: string
  readonly category: SensitivityCategory
}

/** An output schema the redactor cannot check safely: a schema bug, found by the contract test. */
export class SensitiveSchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SensitiveSchemaError'
  }
}

// Values without nested fields.
const LEAF_TYPES: ReadonlySet<string> = new Set([
  'string',
  'number',
  'int',
  'boolean',
  'bigint',
  'symbol',
  'null',
  'undefined',
  'void',
  'never',
  'nan',
  'date',
  'enum',
  'literal',
  'template_literal',
  'file',
  'success',
])

// Values that are not described by a schema: anything could be inside, including sensitive data.
const UNTYPED_TYPES: ReadonlySet<string> = new Set(['any', 'unknown', 'custom', 'transform'])

function defOf(schema: Schema) {
  return schema._zod.def
}

function lazyInner(schema: Schema): Schema {
  return (schema as z.core.$ZodLazy)._zod.innerType
}

function describe(where: string): string {
  return where || 'the root'
}

function assertNotTagged(schema: Schema, where: string): void {
  if (sensitivityOf(schema) !== undefined) {
    throw new SensitiveSchemaError(
      `sensitive() must tag an object field; found one on ${describe(where)}`,
    )
  }
}

function join(path: readonly string[], key: string): string[] {
  return [...path, key]
}

/**
 * Collects the sensitive fields of `schema` into `out`. `ancestors` holds the lazy schemas being
 * walked, so a recursive schema is listed once instead of forever.
 */
function collect(
  schema: Schema,
  path: string[],
  out: SensitivePath[],
  ancestors: Set<Schema>,
): void {
  const def = defOf(schema)
  const where = path.join('.')
  if (FIELD_WRAPPER_TYPES.has(def.type)) {
    collect((def as z.core.$ZodOptionalDef).innerType, path, out, ancestors)
    return
  }
  if (LEAF_TYPES.has(def.type)) return
  if (UNTYPED_TYPES.has(def.type)) {
    throw new SensitiveSchemaError(
      `untyped output (${def.type}) at ${describe(where)}: every output value needs a typed schema`,
    )
  }
  switch (def.type) {
    case 'object': {
      const { shape, catchall } = def as z.core.$ZodObjectDef
      for (const [key, field] of Object.entries(shape)) {
        const category = sensitivityOf(field)
        if (category !== undefined) out.push({ path: join(path, key).join('.'), category })
        else collect(field, join(path, key), out, ancestors)
      }
      // Extra keys of .catchall(): like record values. Loose objects (catchall unknown) are untyped.
      if (catchall && defOf(catchall).type !== 'never') {
        assertNotTagged(catchall, `${where}.*`)
        collect(catchall, join(path, '*'), out, ancestors)
      }
      return
    }
    case 'array': {
      const { element } = def as z.core.$ZodArrayDef
      assertNotTagged(element, `${where}.*`)
      collect(element, join(path, '*'), out, ancestors)
      return
    }
    case 'record': {
      const { valueType } = def as z.core.$ZodRecordDef
      assertNotTagged(valueType, `${where}.*`)
      collect(valueType, join(path, '*'), out, ancestors)
      return
    }
    case 'tuple': {
      const { items, rest } = def as z.core.$ZodTupleDef
      items.forEach((item, index) => {
        assertNotTagged(item, `${where}.${index}`)
        collect(item, join(path, String(index)), out, ancestors)
      })
      if (rest) {
        assertNotTagged(rest, `${where}.*`)
        collect(rest, join(path, '*'), out, ancestors)
      }
      return
    }
    case 'union': {
      for (const option of (def as z.core.$ZodUnionDef).options) {
        assertNotTagged(option, where)
        collect(option, path, out, ancestors)
      }
      return
    }
    case 'intersection': {
      const { left, right } = def as z.core.$ZodIntersectionDef
      assertNotTagged(left, where)
      assertNotTagged(right, where)
      collect(left, path, out, ancestors)
      collect(right, path, out, ancestors)
      return
    }
    case 'pipe': {
      const pipe = def as z.core.$ZodPipeDef
      // z.preprocess(): the value is what `out` parsed.
      if (defOf(pipe.in).type === 'transform') {
        collect(pipe.out, path, out, ancestors)
        return
      }
      // A codec: the value was decoded from `in` and then parsed by `out`, so tags under `in` cannot
      // be located in it. A plain .transform() lands on 'transform' (untyped) below.
      if (pipe.transform) {
        const before = out.length
        collect(pipe.in, path, out, ancestors)
        if (out.length > before) {
          throw new SensitiveSchemaError(`sensitive fields under a codec at ${describe(where)}`)
        }
        collect(pipe.out, path, out, ancestors)
        return
      }
      const before = out.length
      collect(pipe.in, path, out, ancestors)
      if (defOf(pipe.out).type === 'transform' && out.length > before) {
        throw new SensitiveSchemaError(`sensitive fields under a transform at ${describe(where)}`)
      }
      collect(pipe.out, path, out, ancestors) // a transform's result is untyped: rejected there
      return
    }
    case 'lazy': {
      if (ancestors.has(schema)) return
      ancestors.add(schema)
      collect(lazyInner(schema), path, out, ancestors)
      ancestors.delete(schema)
      return
    }
    default:
      // map, set, promise, function and any type added to Zod later: never plain JSON, not checked.
      throw new SensitiveSchemaError(
        `unsupported output type (${def.type}) at ${describe(where)}: the redactor cannot check it`,
      )
  }
}

const pathCache = new WeakMap<Schema, readonly SensitivePath[]>()

/**
 * Every sensitive field a schema declares, deduplicated. Throws SensitiveSchemaError when a tag sits
 * somewhere the redactor cannot remove it (not an object field, under a transform) or when part of
 * the output is untyped or of a type the redactor does not follow.
 */
export function sensitivePaths(schema: Schema): readonly SensitivePath[] {
  const cached = pathCache.get(schema)
  if (cached) return cached
  assertNotTagged(schema, '')
  const found: SensitivePath[] = []
  collect(schema, [], found, new Set())
  const unique = new Map(found.map((p) => [`${p.path}\u0000${p.category}`, p]))
  const paths = [...unique.values()]
  pathCache.set(schema, paths)
  return paths
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A copy of `value` without the fields of hidden categories, following `schema`. Call sensitivePaths()
 * first: it rejects the schemas this function cannot follow.
 */
export function redactValue(
  schema: Schema,
  value: unknown,
  visible: ReadonlySet<SensitivityCategory>,
): unknown {
  const def = defOf(schema)
  if (FIELD_WRAPPER_TYPES.has(def.type)) {
    return redactValue((def as z.core.$ZodOptionalDef).innerType, value, visible)
  }
  switch (def.type) {
    case 'object': {
      if (!isPlainObject(value)) return value
      const { shape, catchall } = def as z.core.$ZodObjectDef
      const copy: Record<string, unknown> = { ...value }
      for (const key of Object.keys(copy)) {
        const field = Object.hasOwn(shape, key) ? shape[key] : catchall
        if (!field) continue
        const category = sensitivityOf(field)
        if (category === undefined) copy[key] = redactValue(field, copy[key], visible)
        else if (!visible.has(category)) delete copy[key]
      }
      return copy
    }
    case 'array': {
      const { element } = def as z.core.$ZodArrayDef
      return Array.isArray(value) ? value.map((item) => redactValue(element, item, visible)) : value
    }
    case 'record': {
      const { valueType } = def as z.core.$ZodRecordDef
      if (!isPlainObject(value)) return value
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, redactValue(valueType, item, visible)]),
      )
    }
    case 'tuple': {
      const { items, rest } = def as z.core.$ZodTupleDef
      if (!Array.isArray(value)) return value
      return value.map((item, index) => {
        const itemSchema = items[index] ?? rest
        return itemSchema ? redactValue(itemSchema, item, visible) : item
      })
    }
    case 'union':
      // The matching option is unknown after parsing: apply every option (only removes more).
      return (def as z.core.$ZodUnionDef).options.reduce<unknown>(
        (current, option) => redactValue(option, current, visible),
        value,
      )
    case 'intersection': {
      const { left, right } = def as z.core.$ZodIntersectionDef
      return redactValue(right, redactValue(left, value, visible), visible)
    }
    case 'pipe': {
      const pipe = def as z.core.$ZodPipeDef
      if (defOf(pipe.in).type === 'transform' || pipe.transform) {
        return redactValue(pipe.out, value, visible)
      }
      return redactValue(pipe.out, redactValue(pipe.in, value, visible), visible)
    }
    case 'lazy':
      return redactValue(lazyInner(schema), value, visible)
    default:
      return value
  }
}

/** Why an output cannot be served; the middleware turns it into an internal error. */
export type RedactionFailure = 'sensitive_outside_business' | 'sensitive_without_meta'

export type RedactionResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: RedactionFailure }

function dataSchemaOf(schema: Schema): Schema {
  return isWithMeta(schema) ? (schema as z.ZodObject<{ data: Schema }>).shape.data : schema
}

/**
 * Whether a procedure with this output schema may run for this caller, checked before the handler:
 * sensitive fields outside a business procedure (`visible` null) or without the withMeta() envelope
 * are refused. Throws SensitiveSchemaError for schemas the redactor cannot check.
 */
export function redactionFailure(
  schema: Schema,
  visible: ReadonlySet<SensitivityCategory> | null,
): RedactionFailure | null {
  if (sensitivePaths(dataSchemaOf(schema)).length === 0) return null
  if (visible === null) return 'sensitive_outside_business'
  if (!isWithMeta(schema)) return 'sensitive_without_meta'
  return null
}

/**
 * Applies redaction to a procedure's (already validated) output.
 * - No sensitive fields: the value is returned unchanged.
 * - Sensitive fields outside a business procedure or without the withMeta() envelope: refused (see
 *   redactionFailure), so nothing sensitive can leave through a procedure that cannot redact it.
 * - Otherwise hidden fields are removed from `data` and listed in `meta.redacted`.
 */
export function redactOutput(
  schema: Schema,
  value: unknown,
  visible: ReadonlySet<SensitivityCategory> | null,
): RedactionResult {
  const failure = redactionFailure(schema, visible)
  if (failure) return { ok: false, reason: failure }
  const dataSchema = dataSchemaOf(schema)
  const paths = sensitivePaths(dataSchema)
  if (paths.length === 0 || visible === null) return { ok: true, value }

  const hidden = paths.filter((p) => !visible.has(p.category)).map((p) => p.path)
  const { data, meta } = value as { data: unknown; meta: RedactionMeta }
  if (hidden.length === 0) return { ok: true, value }
  const redacted = [...new Set([...meta.redacted, ...hidden])].sort()
  return { ok: true, value: { data: redactValue(dataSchema, data, visible), meta: { redacted } } }
}

import { FIELD_WRAPPER_TYPES } from '@bizcost/contracts'
import type { AnyRouter } from '@trpc/server'
import type { z } from 'zod'

// Input schemas of a router's procedures, walked the way the hardening suites need them: every leaf
// field a client may send (strings, numbers, booleans, enums…), named by its path ("lines.*.qty"; `*`
// for an array item or a record value). Wrappers (optional, nullable, default…), pipes (the side the
// client sends), z.lazy(), object catchalls, unions (every option) and intersections are walked
// through, so a field the walk does not see cannot exist.

export type Schema = z.core.$ZodType

export interface InputLeaf {
  /** "lines.*.qty" */
  readonly path: string
  /** The nearest field name ("qty"; "" for a bare top-level value). */
  readonly name: string
  readonly schema: Schema
}

/** The input schema of a procedure of `router` (undefined: it takes no input). */
export function inputSchemaOf(router: AnyRouter, path: string): Schema | undefined {
  const procedures = router._def.procedures as Record<string, { _def: { inputs: unknown[] } }>
  return procedures[path]?._def.inputs[0] as Schema | undefined
}

/** Every leaf of an input schema, deduplicated by path (a union's options may share one). */
export function inputLeaves(schema: Schema): InputLeaf[] {
  const found = new Map<string, InputLeaf>()
  walk(schema, [], new Set(), found)
  return [...found.values()]
}

function walk(schema: Schema, path: string[], seen: Set<Schema>, found: Map<string, InputLeaf>) {
  const def = schema._zod.def
  if (FIELD_WRAPPER_TYPES.has(def.type)) {
    walk((def as z.core.$ZodOptionalDef).innerType, path, seen, found)
    return
  }
  switch (def.type) {
    case 'pipe':
      walk((def as z.core.$ZodPipeDef).in, path, seen, found)
      return
    case 'lazy':
      if (seen.has(schema)) return
      seen.add(schema)
      walk((def as z.core.$ZodLazyDef).getter(), path, seen, found)
      return
    case 'object': {
      const { shape, catchall } = def as z.core.$ZodObjectDef
      for (const [key, field] of Object.entries(shape)) walk(field, [...path, key], seen, found)
      if (catchall && catchall._zod.def.type !== 'never') {
        walk(catchall, [...path, '*'], seen, found)
      }
      return
    }
    case 'array':
      walk((def as z.core.$ZodArrayDef).element, [...path, '*'], seen, found)
      return
    case 'record':
      walk((def as z.core.$ZodRecordDef).valueType, [...path, '*'], seen, found)
      return
    case 'tuple': {
      const { items, rest } = def as z.core.$ZodTupleDef
      items.forEach((item, index) => walk(item, [...path, String(index)], seen, found))
      if (rest) walk(rest, [...path, '*'], seen, found)
      return
    }
    case 'union':
      for (const option of (def as z.core.$ZodUnionDef).options) walk(option, path, seen, found)
      return
    case 'intersection': {
      const { left, right } = def as z.core.$ZodIntersectionDef
      walk(left, path, seen, found)
      walk(right, path, seen, found)
      return
    }
  }
  const key = path.join('.')
  if (found.has(key)) return
  const name = path.findLast((segment) => segment !== '*' && !/^\d+$/.test(segment)) ?? ''
  found.set(key, { path: key, name, schema })
}

/** The leaf without its wrappers (optional, nullable, default…). */
export function unwrapped(schema: Schema): Schema {
  let current = schema
  while (FIELD_WRAPPER_TYPES.has(current._zod.def.type)) {
    current = (current._zod.def as z.core.$ZodOptionalDef).innerType
  }
  return current
}

/** The options of an enum or literal leaf (undefined for any other leaf). */
export function optionsOf(schema: Schema): string[] | undefined {
  const def = unwrapped(schema)._zod.def
  if (def.type === 'enum') return Object.values((def as z.core.$ZodEnumDef).entries).map(String)
  if (def.type === 'literal')
    return (def as z.core.$ZodLiteralDef<z.core.util.Literal>).values.map(String)
  return undefined
}

/** Parses `value` with a leaf schema alone. */
export function parseLeaf(schema: Schema, value: unknown): { ok: boolean; value?: unknown } {
  const result = (schema as unknown as z.ZodType).safeParse(value)
  return result.success ? { ok: true, value: result.data } : { ok: false }
}

/** ASCII decimal strings a numeric field is tried with (each field accepts some of them). */
export const DECIMAL_CANDIDATES = ['1', '5', '12', '100', '0.5', '1.5', '12.25', '0', '-1']

/**
 * A decimal field: a string leaf that reads numbers (accepts one of DECIMAL_CANDIDATES) and refuses
 * words. Names, searches and cursors accept words; UUIDs, dates and months refuse "12".
 */
export function isDecimalLeaf(schema: Schema): boolean {
  if (unwrapped(schema)._zod.def.type !== 'string') return false
  if (parseLeaf(schema, 'abc').ok || parseLeaf(schema, 'x1').ok) return false
  return DECIMAL_CANDIDATES.some((candidate) => parseLeaf(schema, candidate).ok)
}

/** A number leaf (z.number(), z.int()…). */
export function isNumberLeaf(schema: Schema): boolean {
  return unwrapped(schema)._zod.def.type === 'number'
}

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩'
const EASTERN_ARABIC_INDIC = '۰۱۲۳۴۵۶۷۸۹'

export type Digits = 'ascii' | 'arabic' | 'eastern'

/**
 * An ASCII decimal string in other digits: Arabic-Indic with the Arabic decimal separator (٫), or
 * Eastern Arabic-Indic (Persian) with the same separator, as phone keyboards type them.
 */
export function spell(value: string, digits: Digits): string {
  if (digits === 'ascii') return value
  const set = digits === 'arabic' ? ARABIC_INDIC : EASTERN_ARABIC_INDIC
  return value.replace(/\d/g, (d) => set[Number(d)] ?? d).replace('.', '٫')
}

/** A copy of `value` with `fn` applied at every leaf path of `paths` ("lines.*.qty"). */
export function mapAtPaths(
  value: unknown,
  paths: readonly string[],
  fn: (leaf: unknown) => unknown,
): unknown {
  let result = value
  for (const path of paths) result = mapAt(result, path.split('.').filter(Boolean), fn)
  return result
}

function mapAt(value: unknown, path: string[], fn: (leaf: unknown) => unknown): unknown {
  if (path.length === 0) return value === undefined || value === null ? value : fn(value)
  const [head, ...rest] = path
  if (head === '*') {
    if (Array.isArray(value)) return value.map((item) => mapAt(item, rest, fn))
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, mapAt(item, rest, fn)]),
      )
    }
    return value
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || head === undefined) {
    return value
  }
  if (!Object.hasOwn(value, head)) return value
  return { ...value, [head]: mapAt((value as Record<string, unknown>)[head], rest, fn) }
}

/** Every string leaf of a JSON value that is a plain decimal, by its path ("data.lines.0.qty"). */
export function decimalsIn(value: unknown, at = ''): Record<string, string> {
  if (typeof value === 'string') return /^-?\d+(?:\.\d+)?$/.test(value) ? { [at]: value } : {}
  if (Array.isArray(value)) {
    return Object.assign({}, ...value.map((item, i) => decimalsIn(item, `${at}.${i}`)))
  }
  if (value && typeof value === 'object') {
    return Object.assign(
      {},
      ...Object.entries(value).map(([key, item]) => decimalsIn(item, at ? `${at}.${key}` : key)),
    )
  }
  return {}
}

import { sensitive, withMeta, zDecimal } from '@bizcost/contracts'
import { SENSITIVITY_CATEGORIES, type SensitivityCategory } from '@bizcost/domain'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { redactOutput, redactValue, SensitiveSchemaError, sensitivePaths } from './redact'

const NONE: ReadonlySet<SensitivityCategory> = new Set()
const ALL: ReadonlySet<SensitivityCategory> = new Set(SENSITIVITY_CATEGORIES)

const line = z.object({
  qty: zDecimal,
  unitCost: sensitive(zDecimal, 'cost'),
  supplierPrice: sensitive(zDecimal, 'supplier_price').nullable(),
})

const item = z.object({
  id: z.string(),
  name: z.string(),
  cost: sensitive(zDecimal, 'cost'),
  margin: sensitive(zDecimal, 'profit_margin'),
  lines: z.array(line),
  byLocation: z.record(z.string(), z.object({ stockValue: sensitive(zDecimal, 'cost') })),
  supplier: z
    .object({ name: z.string(), lastPrice: sensitive(zDecimal, 'supplier_price') })
    .nullable(),
})

const value = {
  id: 'p1',
  name: 'Latte',
  cost: '4.25',
  margin: '0.62',
  lines: [
    { qty: '1', unitCost: '2', supplierPrice: '1.8' },
    { qty: '2', unitCost: '1.125', supplierPrice: null },
  ],
  byLocation: { a: { stockValue: '100' }, b: { stockValue: '50' } },
  supplier: { name: 'Beans Co', lastPrice: '30' },
}

describe('sensitivePaths', () => {
  it('lists every tagged field with `*` for array items and record values', () => {
    expect(sensitivePaths(item)).toEqual([
      { path: 'cost', category: 'cost' },
      { path: 'margin', category: 'profit_margin' },
      { path: 'lines.*.unitCost', category: 'cost' },
      { path: 'lines.*.supplierPrice', category: 'supplier_price' },
      { path: 'byLocation.*.stockValue', category: 'cost' },
      { path: 'supplier.lastPrice', category: 'supplier_price' },
    ])
  })

  it('finds tags inside unions, intersections, tuples, pipes and lazy schemas', () => {
    const union = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('a'), salary: sensitive(zDecimal, 'payroll') }),
      z.object({ kind: z.literal('b'), phone: sensitive(z.string(), 'employee_pii') }),
    ])
    expect(sensitivePaths(union).map((p) => p.path)).toEqual(['salary', 'phone'])
    const both = z.intersection(
      z.object({ a: sensitive(zDecimal, 'cost') }),
      z.object({ b: sensitive(zDecimal, 'payroll') }),
    )
    expect(sensitivePaths(both).map((p) => p.path)).toEqual(['a', 'b'])
    const tuple = z.tuple([z.object({ c: sensitive(zDecimal, 'cost') })])
    expect(sensitivePaths(tuple).map((p) => p.path)).toEqual(['0.c'])
    const piped = z.object({ c: sensitive(zDecimal, 'cost') }).pipe(z.object({ c: z.string() }))
    expect(sensitivePaths(piped).map((p) => p.path)).toEqual(['c'])
    type Node = { cost?: string; children: Node[] }
    const node: z.ZodType<Node> = z.lazy(() =>
      z.object({ cost: sensitive(zDecimal, 'cost'), children: z.array(node) }),
    )
    expect(sensitivePaths(node).map((p) => p.path)).toEqual(['cost'])
  })

  it('finds tags under .catchall(), a lazy field, and a lazy schema reused in two places', () => {
    const line = z.object({ qty: zDecimal, unitCost: sensitive(zDecimal, 'cost') })
    expect(sensitivePaths(z.object({}).catchall(line))).toEqual([
      { path: '*.unitCost', category: 'cost' },
    ])
    expect(sensitivePaths(z.object({ n: z.string() }).catchall(z.array(line)))).toEqual([
      { path: '*.*.unitCost', category: 'cost' },
    ])
    const lazyField = z.object({ cost: z.lazy(() => sensitive(zDecimal, 'cost')) })
    expect(sensitivePaths(lazyField)).toEqual([{ path: 'cost', category: 'cost' }])
    const shared = z.lazy(() => line)
    expect(sensitivePaths(z.object({ a: shared, b: shared })).map((p) => p.path)).toEqual([
      'a.unitCost',
      'b.unitCost',
    ])
  })

  it('follows preprocess and codec outputs', () => {
    const pre = z.preprocess((v) => v, z.object({ c: sensitive(zDecimal, 'cost') }))
    expect(sensitivePaths(pre).map((p) => p.path)).toEqual(['c'])
    const codec = z.codec(z.string(), z.object({ c: sensitive(zDecimal, 'cost') }), {
      decode: () => ({ c: '1' }),
      encode: () => '',
    })
    expect(sensitivePaths(codec).map((p) => p.path)).toEqual(['c'])
  })

  it('is empty for schemas without tags', () => {
    expect(sensitivePaths(z.object({ a: zDecimal, b: z.array(z.string()) }))).toEqual([])
    expect(sensitivePaths(z.strictObject({ a: z.enum(['x']), d: z.date().nullable() }))).toEqual([])
  })

  it.each([
    ['z.unknown()', () => z.object({ row: z.unknown() })],
    ['z.any()', () => z.object({ rows: z.array(z.any()) })],
    ['z.custom()', () => z.object({ row: z.custom<{ cost: string }>(() => true) })],
    ['a loose object', () => z.looseObject({ id: z.string() })],
    ['a passthrough object', () => z.object({ id: z.string() }).passthrough()],
    ['a record of unknown values', () => z.record(z.string(), z.unknown())],
    ['a transform result', () => z.object({ n: z.string().transform((s) => ({ raw: s })) })],
    ['a Map', () => z.object({ m: z.map(z.string(), z.string()) })],
    ['a Set', () => z.object({ s: z.set(z.string()) })],
  ])('rejects untyped or unsupported output: %s', (_what, build) => {
    expect(() => sensitivePaths(build())).toThrow(SensitiveSchemaError)
  })

  it.each([
    ['the root', () => sensitive(zDecimal, 'cost')],
    ['an array item', () => z.object({ prices: z.array(sensitive(zDecimal, 'cost')) })],
    ['a record value', () => z.object({ m: z.record(z.string(), sensitive(zDecimal, 'cost')) })],
    ['a union option', () => z.object({ x: z.union([z.string(), sensitive(zDecimal, 'cost')]) })],
    ['a tuple item', () => z.object({ t: z.tuple([sensitive(zDecimal, 'cost')]) })],
    [
      'a field under a transform',
      () => z.object({ c: sensitive(zDecimal, 'cost') }).transform((v) => ({ total: v.c ?? '0' })),
    ],
    [
      'a Map',
      () => z.object({ m: z.map(z.string(), z.object({ c: sensitive(zDecimal, 'cost') })) }),
    ],
    ['a Map value', () => z.object({ m: z.map(z.string(), sensitive(zDecimal, 'cost')) })],
    ['a catchall', () => z.object({ id: z.string() }).catchall(sensitive(zDecimal, 'cost'))],
    ['an intersection side', () => z.object({ c: sensitive(zDecimal, 'cost').and(z.string()) })],
    [
      'a field under a codec',
      () =>
        z.codec(z.object({ c: sensitive(zDecimal, 'cost') }), z.object({ total: z.string() }), {
          decode: () => ({ total: '0' }),
          encode: () => ({}),
        }),
    ],
    ['an array item behind z.lazy()', () => z.array(z.lazy(() => sensitive(zDecimal, 'cost')))],
  ])('rejects a tag on %s', (_where, build) => {
    expect(() => sensitivePaths(build())).toThrow(SensitiveSchemaError)
  })
})

describe('redactValue', () => {
  it('keeps everything when every category is visible', () => {
    expect(redactValue(item, value, ALL)).toEqual(value)
  })

  it('removes every sensitive field at every depth when nothing is visible', () => {
    expect(redactValue(item, value, NONE)).toEqual({
      id: 'p1',
      name: 'Latte',
      lines: [{ qty: '1' }, { qty: '2' }],
      byLocation: { a: {}, b: {} },
      supplier: { name: 'Beans Co' },
    })
  })

  it('removes only the hidden categories', () => {
    const redacted = redactValue(item, value, new Set(['cost'])) as typeof value
    expect(redacted.cost).toBe('4.25')
    expect(redacted.lines[0]).toEqual({ qty: '1', unitCost: '2' })
    expect(redacted).not.toHaveProperty('margin')
    expect(redacted.supplier).toEqual({ name: 'Beans Co' })
  })

  it('does not change the input value', () => {
    const copy = structuredClone(value)
    redactValue(item, value, NONE)
    expect(value).toEqual(copy)
  })

  it('handles null parents and missing optional fields', () => {
    const partial = { ...value, supplier: null, cost: undefined }
    const redacted = redactValue(item, partial, NONE) as Record<string, unknown>
    expect(redacted.supplier).toBeNull()
    expect(redacted).not.toHaveProperty('cost')
  })

  it('redacts the extra keys of a .catchall() object and fields behind z.lazy()', () => {
    const line = z.object({ qty: zDecimal, unitCost: sensitive(zDecimal, 'cost') })
    const byId = z.object({ title: z.string() }).catchall(line)
    expect(
      redactValue(byId, { title: 'x', l1: { qty: '1', unitCost: '777' }, l2: null }, NONE),
    ).toEqual({ title: 'x', l1: { qty: '1' }, l2: null })
    const lazyField = z.object({
      name: z.string(),
      cost: z.lazy(() => sensitive(zDecimal, 'cost')),
    })
    expect(redactValue(lazyField, { name: 'Latte', cost: '888' }, NONE)).toEqual({ name: 'Latte' })
  })

  it('does not mistake inherited property names for fields', () => {
    const schema = z
      .object({ name: z.string() })
      .catchall(z.object({ c: sensitive(zDecimal, 'cost') }))
    expect(redactValue(schema, { name: 'x', toString: { c: '1' } }, NONE)).toEqual({
      name: 'x',
      toString: {},
    })
  })

  it('applies every option of a union', () => {
    const union = z.union([
      z.object({ kind: z.literal('a'), salary: sensitive(zDecimal, 'payroll') }),
      z.object({ kind: z.literal('b'), note: z.string() }),
    ])
    expect(redactValue(union, { kind: 'a', salary: '9000' }, NONE)).toEqual({ kind: 'a' })
    expect(redactValue(union, { kind: 'b', note: 'x' }, NONE)).toEqual({ kind: 'b', note: 'x' })
  })
})

describe('redactOutput', () => {
  const envelope = withMeta(item)
  const output = { data: value, meta: { redacted: [] } }

  it('returns outputs without sensitive fields unchanged, whoever asks', () => {
    const plain = z.object({ ok: z.boolean() })
    expect(redactOutput(plain, { ok: true }, null)).toEqual({ ok: true, value: { ok: true } })
    expect(
      redactOutput(withMeta(plain), { data: { ok: true }, meta: { redacted: [] } }, NONE),
    ).toEqual({ ok: true, value: { data: { ok: true }, meta: { redacted: [] } } })
  })

  it('refuses sensitive fields outside a business procedure', () => {
    expect(redactOutput(envelope, output, null)).toEqual({
      ok: false,
      reason: 'sensitive_outside_business',
    })
  })

  it('refuses sensitive fields without the withMeta envelope', () => {
    expect(redactOutput(item, value, ALL)).toEqual({ ok: false, reason: 'sensitive_without_meta' })
  })

  it('removes hidden fields and lists their schema paths in meta.redacted', () => {
    const result = redactOutput(envelope, output, new Set(['cost', 'profit_margin']))
    expect(result.ok).toBe(true)
    const redacted = (result as { value: { data: typeof value; meta: { redacted: string[] } } })
      .value
    expect(redacted.meta.redacted).toEqual(['lines.*.supplierPrice', 'supplier.lastPrice'])
    expect(redacted.data.cost).toBe('4.25')
    expect(redacted.data.lines[0]).toEqual({ qty: '1', unitCost: '2' })
  })

  it('lists hidden paths even when the list is empty and keeps paths the handler listed', () => {
    const result = redactOutput(
      envelope,
      { data: { ...value, lines: [] }, meta: { redacted: ['totals.profit'] } },
      NONE,
    )
    expect(result.ok && (result.value as { meta: { redacted: string[] } }).meta.redacted).toEqual([
      'byLocation.*.stockValue',
      'cost',
      'lines.*.supplierPrice',
      'lines.*.unitCost',
      'margin',
      'supplier.lastPrice',
      'totals.profit',
    ])
  })
})

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { zDecimal } from './primitives'
import { sensitive, sensitivityOf, sensitivityRegistry } from './sensitivity'

describe('sensitive', () => {
  it('makes the field optional, because redaction may remove it', () => {
    const schema = z.object({ unitCost: sensitive(zDecimal, 'cost') })
    expect(schema.parse({})).toEqual({})
    expect(schema.parse({ unitCost: '1.5' })).toEqual({ unitCost: '1.5' })
    expect(schema.safeParse({ unitCost: 1.5 }).success).toBe(false)
  })

  it('tags the inner copy as well, so unwrapping keeps the tag', () => {
    const field = sensitive(zDecimal, 'payroll')
    expect(sensitivityRegistry.get(field.unwrap())).toEqual({ category: 'payroll' })
    expect(field.unwrap()).not.toBe(zDecimal)
  })

  it('can tag whole objects and arrays', () => {
    const address = sensitive(z.object({ line1: z.string() }), 'employee_pii')
    const lines = sensitive(z.array(zDecimal), 'supplier_price')
    expect(sensitivityOf(address)).toBe('employee_pii')
    expect(sensitivityOf(lines)).toBe('supplier_price')
  })
})

describe('sensitivityOf', () => {
  it('reads the tag of a field', () => {
    expect(sensitivityOf(sensitive(zDecimal, 'cost'))).toBe('cost')
  })

  it('looks through wrappers added after tagging', () => {
    const base = sensitive(zDecimal, 'profit_margin')
    for (const wrapped of [
      base.nullable(),
      base.nullable().optional(),
      base.default('0'),
      base.prefault('0'),
      base.catch('0'),
      base.readonly(),
      base.nonoptional(),
      base.nullable().describe('Margin'),
    ]) {
      expect(sensitivityOf(wrapped)).toBe('profit_margin')
    }
  })

  it('looks through pipes (transforms)', () => {
    const piped = sensitive(zDecimal, 'cost').transform((v) => v ?? '0')
    expect(sensitivityOf(piped)).toBe('cost')
    const into = sensitive(z.string(), 'payroll')
    expect(sensitivityOf(z.string().optional().pipe(into))).toBe('payroll')
  })

  it('looks through z.lazy(), and stops on a lazy schema that refers to itself', () => {
    expect(sensitivityOf(z.lazy(() => sensitive(zDecimal, 'cost')))).toBe('cost')
    expect(sensitivityOf(z.lazy(() => sensitive(zDecimal, 'cost')).nullable())).toBe('cost')
    const loop: z.ZodType = z.lazy(() => loop.optional())
    expect(sensitivityOf(loop)).toBeUndefined()
  })

  it('is undefined for untagged schemas, including objects that contain tagged fields', () => {
    expect(sensitivityOf(zDecimal)).toBeUndefined()
    expect(sensitivityOf(zDecimal.nullable())).toBeUndefined()
    expect(sensitivityOf(z.object({ unitCost: sensitive(zDecimal, 'cost') }))).toBeUndefined()
    expect(sensitivityOf(z.array(sensitive(zDecimal, 'cost')))).toBeUndefined()
  })
})

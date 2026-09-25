import { sensitive, withMeta, zDecimal } from '@bizcost/contracts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { procedureContractViolations } from '../test/contract'
import { appRouter } from './routers'
import { authedProcedure, businessProcedure, publicProcedure, router } from './trpc'

const costly = z.object({ name: z.string(), cost: sensitive(zDecimal, 'cost') })

describe('appRouter contract', () => {
  it('serves exactly the Step 2–3 procedures', () => {
    expect(Object.keys(appRouter._def.procedures).sort()).toEqual([
      'account.delete',
      'account.updateProfile',
      'business.context',
      'health',
      'me',
    ])
  })

  it('every procedure has a Zod output, runs redact, and keeps sensitive fields in business envelopes', () => {
    expect(procedureContractViolations(appRouter)).toEqual([])
  })
})

describe('procedureContractViolations', () => {
  it('reports a procedure without .output()', () => {
    const bad = router({ noOutput: publicProcedure.query(() => 'x') })
    expect(procedureContractViolations(bad)).toEqual(['noOutput: has no Zod .output() schema'])
  })

  it('reports sensitive fields outside a business procedure', () => {
    const bad = router({
      leak: authedProcedure.output(withMeta(costly)).query(() => ({
        data: { name: 'x', cost: '1' },
        meta: { redacted: [] },
      })),
    })
    expect(procedureContractViolations(bad)).toEqual([
      'leak: outputs sensitive fields but is not a business procedure',
    ])
  })

  it('reports sensitive fields without the withMeta envelope', () => {
    const bad = router({
      bare: businessProcedure.output(costly).query(() => ({ name: 'x', cost: '1' })),
    })
    expect(procedureContractViolations(bad)).toEqual([
      'bare: outputs sensitive fields without the withMeta() envelope',
    ])
  })

  it('reports a sensitive tag the redactor cannot apply', () => {
    const bad = router({
      list: businessProcedure
        .output(withMeta(z.object({ prices: z.array(sensitive(zDecimal, 'cost')) })))
        .query(() => ({ data: { prices: [] }, meta: { redacted: [] } })),
    })
    expect(procedureContractViolations(bad)).toEqual([
      'list: SensitiveSchemaError: sensitive() must tag an object field; found one on prices.*',
    ])
  })

  it('reports sensitive fields hidden under .catchall() or z.lazy()', () => {
    const line = z.object({ unitCost: sensitive(zDecimal, 'cost') })
    const bad = router({
      byId: businessProcedure.output(z.object({}).catchall(line)).query(() => ({})),
      lazy: authedProcedure
        .output(z.object({ cost: z.lazy(() => sensitive(zDecimal, 'cost')) }))
        .query(() => ({})),
    })
    expect(procedureContractViolations(bad)).toEqual([
      'byId: outputs sensitive fields without the withMeta() envelope',
      'lazy: outputs sensitive fields but is not a business procedure',
      'lazy: outputs sensitive fields without the withMeta() envelope',
    ])
  })

  it('reports untyped outputs, which could carry any column', () => {
    const bad = router({
      raw: businessProcedure.output(z.object({ row: z.unknown() })).query(() => ({ row: 1 })),
      loose: publicProcedure.output(z.looseObject({ id: z.string() })).query(() => ({ id: 'x' })),
    })
    expect(procedureContractViolations(bad)).toEqual([
      'raw: SensitiveSchemaError: untyped output (unknown) at row: every output value needs a typed schema',
      'loose: SensitiveSchemaError: untyped output (unknown) at *: every output value needs a typed schema',
    ])
  })

  it('accepts a business procedure that returns sensitive fields in withMeta', () => {
    const good = router({
      item: businessProcedure
        .output(withMeta(costly))
        .query(() => ({ data: { name: 'x', cost: '1' }, meta: { redacted: [] } })),
    })
    expect(procedureContractViolations(good)).toEqual([])
  })
})

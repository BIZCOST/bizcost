import { isWithMeta } from '@bizcost/contracts'
import type { AnyRouter } from '@trpc/server'
import type { z } from 'zod'
import { sensitivePaths } from '../src/redact'
import { middlewareMarkers } from '../src/trpc'

// Contract checks for every procedure of a router (docs/ARCHITECTURE.md §Testing & CI, Contract checks):
// a Zod output schema, the redact middleware in the right place, and sensitive fields only in
// business procedures that return the withMeta() envelope.

interface ProcedureDef {
  output?: unknown
  middlewares: unknown[]
}

function defOf(procedure: unknown): ProcedureDef {
  return (procedure as { _def: ProcedureDef })._def
}

function isZodSchema(value: unknown): value is z.core.$ZodType {
  return typeof value === 'object' && value !== null && '_zod' in value
}

/** Every contract violation of a router, as "path: problem" lines (empty when it complies). */
export function procedureContractViolations(router: AnyRouter): string[] {
  const violations: string[] = []
  for (const [path, procedure] of Object.entries(router._def.procedures)) {
    const def = defOf(procedure)
    const problem = (text: string) => violations.push(`${path}: ${text}`)

    if (!isZodSchema(def.output)) {
      problem('has no Zod .output() schema')
      continue
    }

    const redactAt = def.middlewares.flatMap((m, i) => (m === middlewareMarkers.redact ? [i] : []))
    const outputAt = def.middlewares.findIndex((m) => (m as { _type?: string })._type === 'output')
    const authedAt = def.middlewares.indexOf(middlewareMarkers.authed)
    const businessAt = def.middlewares.indexOf(middlewareMarkers.businessScoped)
    if (redactAt.length !== 1) {
      problem(`must run the redact middleware exactly once (found ${redactAt.length})`)
      continue
    }
    const redact = redactAt[0] ?? -1
    if (outputAt < redact) problem('output validation must run inside the redact middleware')
    if (authedAt > redact || businessAt > redact) problem('auth must be resolved before redact')

    let paths: readonly { path: string }[]
    try {
      paths = sensitivePaths(
        isWithMeta(def.output) ? (def.output as z.ZodObject).shape.data : def.output,
      )
    } catch (error) {
      problem(String(error))
      continue
    }
    if (paths.length === 0) continue
    if (businessAt === -1) problem('outputs sensitive fields but is not a business procedure')
    if (!isWithMeta(def.output)) problem('outputs sensitive fields without the withMeta() envelope')
  }
  return violations
}

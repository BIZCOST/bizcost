import { isWithMeta, withMeta } from '@bizcost/contracts'
import { SENSITIVITY_CATEGORIES, type SensitivityCategory } from '@bizcost/domain'
import { ROLE_TEMPLATE_KEYS, type RoleTemplateKey } from '@bizcost/modules'
import type { AnyRouter } from '@trpc/server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { appRouter, businessProcedure, router } from '../../src'
import { sensitivePaths, type SensitivePath } from '../../src/redact'
import { item, itemDto, VALUES_OF, VISIBLE_TO } from '../oracle'
import { join, setupBusiness, WORKSHOP } from '../settings'
import { callProcedure, openApi, proceduresOf, type Api, type Person } from './fixture'

// Redaction oracle over EVERY procedure whose output has sensitivity tags (ROADMAP.md Step 9; M1
// definition of done: "the Employee (staff) role template receives no field tagged sensitive"). The
// router is walked: each procedure with sensitive() fields in its output must have an entry in
// ORACLE, and is called by a member holding each of the 7 role templates as Smart Setup copied them
// into a real business. What each template may see is the hand-written VISIBLE_TO (test/oracle.ts):
// `meta.redacted` must list exactly the paths of the hidden categories, and the response must carry
// a category's values exactly when the template may see it.
//
// In M1 no production procedure outputs a sensitive field (the first module with cost data ships in
// Phase 2), so ORACLE holds only the test procedure `test.item` (a value in every category, nested
// in objects and arrays). The first test fails the day a production procedure gets a sensitive field
// without an ORACLE entry, and the day an ORACLE entry no longer has one.

interface OracleEntry {
  /** Input of the call (default none). */
  input?: unknown
  /** The values the call returns in each category (each must be in the fixture's answer). */
  valuesOf: Partial<Record<SensitivityCategory, readonly string[]>>
}

/** Production procedures with sensitive output: none in M1. */
const PRODUCTION_ORACLE: Record<string, OracleEntry> = {}

/** The Step 2 test procedure, served beside appRouter (never part of it). */
const TEST_ORACLE: Record<string, OracleEntry> = {
  'test.item': { valuesOf: VALUES_OF },
}

const oracleRouter = router({
  ...appRouter._def.record,
  test: router({
    item: businessProcedure
      .output(withMeta(itemDto))
      .query(() => ({ data: item, meta: { redacted: [] } })),
  }),
})

/** Sensitive paths of every procedure of `r` that has any (paths relative to the envelope's data). */
function sensitiveProcedures(r: AnyRouter): Map<string, readonly SensitivePath[]> {
  const found = new Map<string, readonly SensitivePath[]>()
  for (const [path, procedure] of Object.entries(
    r._def.procedures as Record<string, { _def: { output?: unknown } }>,
  )) {
    const output = procedure._def.output as z.core.$ZodType
    const data = isWithMeta(output) ? (output as z.ZodObject).shape.data : output
    const paths = sensitivePaths(data as z.core.$ZodType)
    if (paths.length > 0) found.set(path, paths)
  }
  return found
}

describe('the oracle covers every procedure with sensitive output', () => {
  it('production: exactly the procedures in PRODUCTION_ORACLE have sensitive fields (none in M1)', () => {
    expect(
      [...sensitiveProcedures(appRouter).keys()].sort(),
      'a procedure outputs sensitive() fields: add it to PRODUCTION_ORACLE with its values',
    ).toEqual(Object.keys(PRODUCTION_ORACLE).sort())
  })

  it('the oracle router: every sensitive procedure has an entry, and every category a value', () => {
    const sensitive = sensitiveProcedures(oracleRouter)
    expect([...sensitive.keys()].sort()).toEqual(
      Object.keys({ ...PRODUCTION_ORACLE, ...TEST_ORACLE }).sort(),
    )
    // test.item holds every category, so every template's view is checked.
    expect(new Set(sensitive.get('test.item')?.map((p) => p.category))).toEqual(
      new Set(SENSITIVITY_CATEGORIES),
    )
  })
})

let api: Api
let businessId: string
const members = new Map<RoleTemplateKey, Person>()

beforeAll(async () => {
  api = openApi(oracleRouter)
  const owner = await api.newPerson()
  businessId = await setupBusiness(api.handler, owner.token, WORKSHOP, { name: 'Oracle Workshop' })
  members.set('owner', owner)
  for (const template of ROLE_TEMPLATE_KEYS.filter((key) => key !== 'owner')) {
    const person = await api.newPerson()
    // The business's own template role, as Smart Setup copied it (an accepted invitation's way).
    await join(api.db, owner.user, businessId, person.user, template)
    members.set(template, person)
  }
}, 60_000)

afterAll(async () => {
  await api.close()
})

const ORACLE = { ...PRODUCTION_ORACLE, ...TEST_ORACLE }
const CASES = Object.keys(ORACLE).flatMap((path) =>
  ROLE_TEMPLATE_KEYS.map((template) => [path, template] as const),
)

describe('each role template receives exactly the categories it may see', () => {
  it.each(CASES)('%s as %s', async (path, template) => {
    const entry = ORACLE[path]
    const person = members.get(template)
    const paths = sensitiveProcedures(oracleRouter).get(path) ?? []
    const procedure = proceduresOf(oracleRouter).find((p) => p.path === path)
    if (!entry || !person || !procedure) throw new Error(`no fixture for ${path} as ${template}`)
    const visible = new Set(VISIBLE_TO[template])

    const result = await callProcedure<{ meta: { redacted: string[] } }>(
      api.handler,
      procedure,
      person.token,
      { businessId, input: entry.input },
    )
    expect(result.error, result.raw).toBeUndefined()
    const hidden = paths.filter((p) => !visible.has(p.category)).map((p) => p.path)
    expect(result.data?.meta.redacted).toEqual([...hidden].sort())
    for (const category of SENSITIVITY_CATEGORIES) {
      for (const value of entry.valuesOf[category] ?? []) {
        expect(result.raw.includes(value), `${category} ${value}`).toBe(visible.has(category))
      }
    }

    // The client is told the same categories (business.context), so it locks the same fields.
    const context = await callProcedure<{ visibleCategories: string[] }>(
      api.handler,
      { path: 'business.context', type: 'query' },
      person.token,
      { businessId },
    )
    expect(context.data?.visibleCategories).toEqual(VISIBLE_TO[template])
  })
})

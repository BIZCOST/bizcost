import type { CapabilitySource } from '@bizcost/domain'
import { sql } from 'drizzle-orm'
import { boolean, check, integer, jsonb, text, unique, uuid } from 'drizzle-orm/pg-core'
import { timestamptz } from './_app'
import { tenantTable } from './_helpers'

// In-screen flags from Smart Setup; keys come from the capability registry in packages/modules.
// A capability that mirrors a businesses column is read from that column and never stored twice
// (vat_registered → businesses.vat_registered).
export const businessCapabilities = tenantTable(
  'business_capabilities',
  {
    key: text('key').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    value: jsonb('value'),
    source: text('source').$type<CapabilitySource>().notNull(),
  },
  (t) => [
    unique('business_capabilities_business_id_key_key').on(t.businessId, t.key),
    check('business_capabilities_key_check', sql`key <> 'vat_registered'`),
    check('business_capabilities_source_check', sql`source in ('setup', 'user')`),
  ],
)

// Which modules are on. Availability (released | planned) lives in the code manifests, not here.
export const businessModules = tenantTable(
  'business_modules',
  {
    moduleKey: text('module_key').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    enabledAt: timestamptz('enabled_at'),
    enabledBy: uuid('enabled_by'),
  },
  (t) => [unique('business_modules_business_id_module_key_key').on(t.businessId, t.moduleKey)],
)

// Raw Smart Setup answers. Runtime code reads the derived tables, never this one.
export const setupAnswers = tenantTable(
  'setup_answers',
  {
    questionSetVersion: integer('question_set_version').notNull(),
    answers: jsonb('answers').$type<Record<string, unknown>>().notNull(),
  },
  () => [check('setup_answers_answers_check', sql`jsonb_typeof(answers) = 'object'`)],
)

export type BusinessCapability = typeof businessCapabilities.$inferSelect
export type NewBusinessCapability = typeof businessCapabilities.$inferInsert
export type BusinessModule = typeof businessModules.$inferSelect
export type NewBusinessModule = typeof businessModules.$inferInsert
export type SetupAnswers = typeof setupAnswers.$inferSelect
export type NewSetupAnswers = typeof setupAnswers.$inferInsert

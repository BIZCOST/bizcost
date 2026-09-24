import type { AuditAction } from '@bizcost/domain'
import { sql } from 'drizzle-orm'
import { check, foreignKey, index, jsonb, text, uuid } from 'drizzle-orm/pg-core'
import { app, timestamptz } from './_app'
import { businesses } from './businesses'

export type AuditChanges = {
  before?: Record<string, unknown>
  after?: Record<string, unknown>
}

// Append-only write log. Rows are written only by the app.audit_row() trigger on businesses and every
// tenant table, so no write can skip it and no row can be forged: bizcost_api has SELECT only. `changes`
// may hold sensitive values: every read path must go through redaction.
export const auditLog = app.table(
  'audit_log',
  {
    id: uuid('id').primaryKey(),
    businessId: uuid('business_id').notNull(),
    actorUserId: uuid('actor_user_id'),
    action: text('action').$type<AuditAction>().notNull(),
    entity: text('entity').notNull(),
    entityId: uuid('entity_id').notNull(),
    requestId: uuid('request_id'),
    changes: jsonb('changes').$type<AuditChanges>().notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'audit_log_business_id_fk',
      columns: [t.businessId],
      foreignColumns: [businesses.id],
    }),
    index('audit_log_business_created_idx').on(t.businessId, t.createdAt),
    check('audit_log_action_check', sql`action in ('insert', 'update', 'delete')`),
  ],
)

export type AuditLogEntry = typeof auditLog.$inferSelect

import { sql } from 'drizzle-orm'
import { customType, integer, pgSchema, timestamp, uuid } from 'drizzle-orm/pg-core'

// All BizCost tables live in Postgres schema `app`, which is not exposed to the Supabase Data API.
export const app = pgSchema('app')

/** Case-insensitive text (extension `citext`, installed in schema `extensions`). */
export const citext = customType<{ data: string; driverData: string }>({
  dataType: () => 'citext',
})

export const timestamptz = (name: string) => timestamp(name, { withTimezone: true })

/**
 * created_* / updated_* / deleted_at / version, shared by `businesses` and every tenantTable().
 * Actor columns hold the auth user id without an FK (docs/DATA_MODEL.md §1.3). `created_by` defaults to
 * the tenant context; the `app.touch_row()` trigger maintains updated_at, updated_by and version.
 */
export const rowMetaColumns = () => ({
  createdBy: uuid('created_by')
    .notNull()
    .default(sql`app.current_user_id()`),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  deletedAt: timestamptz('deleted_at'),
  version: integer('version').notNull().default(1),
})

import { sql } from 'drizzle-orm'
import { boolean, text, uniqueIndex } from 'drizzle-orm/pg-core'
import { tenantTable } from './_helpers'

// Branches / sites. Smart Setup creates the default location.
export const locations = tenantTable(
  'locations',
  {
    name: text('name').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
  },
  (t) => [
    uniqueIndex('locations_one_default_key')
      .on(t.businessId)
      .where(sql`is_default and deleted_at is null`),
  ],
)

export type Location = typeof locations.$inferSelect
export type NewLocation = typeof locations.$inferInsert

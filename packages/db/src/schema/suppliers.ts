import { sql } from 'drizzle-orm'
import { check, text, uniqueIndex } from 'drizzle-orm/pg-core'
import { timestamptz } from './_app'
import { tenantTable } from './_helpers'

// Suppliers (M2 Step 3; docs/DATA_MODEL.md §6, D-112, D-113): one record per real supplier, reused by
// purchases, supplier returns and credit notes (and expenses from Step 5). A list of its own,
// separate from customers (Phase 3). One name in any language; contact details optional. Archived,
// never deleted (D-123): no API path soft-deletes a supplier.
export const suppliers = tenantTable(
  'suppliers',
  {
    name: text('name').notNull(),
    phone: text('phone'),
    email: text('email'),
    // 15 digits, as businesses.trn (needed on a supplier's tax invoice, not checked against it).
    trn: text('trn'),
    notes: text('notes'),
    // Archived: hidden from pickers; still listed (filter) and never deleted (D-123).
    archivedAt: timestamptz('archived_at'),
  },
  (t) => [
    // One name per business (case ignored); also the order of the list and its cursor.
    uniqueIndex('suppliers_name_key')
      .on(t.businessId, sql`lower(name)`)
      .where(sql`deleted_at is null`),
    check('suppliers_name_check', sql`btrim(name) <> '' and char_length(name) <= 100`),
    check('suppliers_phone_check', sql`btrim(phone) <> '' and char_length(phone) <= 30`),
    check('suppliers_email_check', sql`btrim(email) <> '' and char_length(email) <= 254`),
    check('suppliers_trn_check', sql`trn ~ '^[0-9]{15}$'`),
    check('suppliers_notes_check', sql`char_length(notes) <= 1000`),
  ],
)

export type Supplier = typeof suppliers.$inferSelect
export type NewSupplier = typeof suppliers.$inferInsert

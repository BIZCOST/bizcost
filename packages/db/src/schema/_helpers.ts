import type { BuildExtraConfigColumns } from 'drizzle-orm'
import {
  foreignKey,
  text,
  unique,
  uuid,
  type PgColumn,
  type PgColumnBuilderBase,
  type PgTableExtraConfigValue,
} from 'drizzle-orm/pg-core'
import { app, rowMetaColumns } from './_app'
import { businesses } from './businesses'

const tenantKeyColumns = () => ({
  id: uuid('id').primaryKey(),
  businessId: uuid('business_id').notNull(),
})

const tenantTrailingColumns = () => ({
  ...rowMetaColumns(),
  requestHash: text('request_hash'),
})

type TenantColumns = ReturnType<typeof tenantKeyColumns> & ReturnType<typeof tenantTrailingColumns>

/**
 * Declares a business-owned table in schema `app` with the standard tenant columns and constraints
 * (docs/DATA_MODEL.md §1.2): id (UUIDv7 from the client, no DB default), business_id → businesses,
 * UNIQUE (business_id, id) as the target of composite FKs, created/updated by+at, deleted_at, version,
 * request_hash. RLS (ENABLE + FORCE + the standard policy), the touch trigger and the audit trigger are
 * added in SQL migrations with app.apply_tenant_rls() and friends.
 */
export function tenantTable<
  TName extends string,
  TColumns extends Record<string, PgColumnBuilderBase>,
>(
  name: TName,
  columns: TColumns,
  extraConfig?: (
    t: BuildExtraConfigColumns<TName, TenantColumns & TColumns, 'pg'>,
  ) => PgTableExtraConfigValue[],
) {
  return app.table(name, { ...tenantKeyColumns(), ...columns, ...tenantTrailingColumns() }, (t) => [
    foreignKey({
      name: `${name}_business_id_fk`,
      columns: [t.businessId],
      foreignColumns: [businesses.id],
    }),
    unique(`${name}_business_id_id_key`).on(t.businessId, t.id),
    ...(extraConfig?.(t) ?? []),
  ])
}

/** Composite FK (business_id, <column>) → parent (business_id, id): no link can cross businesses. */
export function tenantRef(
  name: string,
  columns: [businessId: PgColumn, column: PgColumn],
  parent: { businessId: PgColumn; id: PgColumn },
) {
  return foreignKey({ name, columns, foreignColumns: [parent.businessId, parent.id] })
}

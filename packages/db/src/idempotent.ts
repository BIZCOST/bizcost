import { and, eq, sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm'
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core'
import type { Tx } from './tenant'

/**
 * A create was retried with an id that already belongs to a different row: another business, another
 * user or another payload. The API turns it into a typed CONFLICT (docs/DATA_MODEL.md §1.2).
 */
export class ConflictError extends Error {
  constructor(message = 'conflict') {
    super(message)
    this.name = 'ConflictError'
  }
}

/** Any tenantTable(): client-generated id plus the columns an idempotent create compares. */
type IdempotentTable = PgTable & {
  id: PgColumn
  businessId: PgColumn
  createdBy: PgColumn
  requestHash: PgColumn
}

type IdempotentValues<TTable extends IdempotentTable> = InferInsertModel<TTable> & {
  id: string
  businessId: string
  /** Fingerprint of the create payload; the same retry must send the same hash. */
  requestHash: string
}

/**
 * Idempotent create (docs/DATA_MODEL.md §1.2, D-031). Inserts the row; when its id already exists,
 * returns the existing row if it is the same create (same business, same creator = the current user,
 * same request hash) and throws ConflictError otherwise. Rows of other businesses are invisible under
 * RLS, so an id taken elsewhere is a conflict too and reveals nothing about that row. Only an id
 * conflict is absorbed: every other unique violation still raises (23505).
 */
export async function insertIdempotent<TTable extends IdempotentTable>(
  tx: Tx,
  table: TTable,
  values: IdempotentValues<TTable>,
): Promise<InferSelectModel<TTable>> {
  const inserted = (await tx
    .insert(table)
    .values(values)
    .onConflictDoNothing({ target: table.id })
    .returning()) as InferSelectModel<TTable>[]
  const created = inserted[0]
  if (created) return created

  const existing = (await tx
    .select()
    .from(table as PgTable)
    .where(
      and(
        eq(table.id, values.id),
        eq(table.businessId, values.businessId),
        eq(table.createdBy, sql`app.current_user_id()`),
        eq(table.requestHash, values.requestHash),
      ),
    )
    .limit(1)) as InferSelectModel<TTable>[]
  const same = existing[0]
  if (same) return same
  throw new ConflictError('id already used by a different create')
}

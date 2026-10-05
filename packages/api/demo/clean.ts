import type postgres from 'postgres'

// The part of `pnpm dev:clean-test-data` (clean-test-data.ts, D-182) that removes businesses' rows,
// apart so a test can run it on a business of its own (test/dev-tools.api.test.ts). Local only: the
// caller connects as `postgres` to the local stack.

type Sql = postgres.Sql

/**
 * The tables of schema app with a business_id (the tenant tables and the audit log), read from the
 * catalog: a table added later (the sales of M3 Step 2) is covered without a change here.
 */
export async function tenantTables(sql: Sql): Promise<string[]> {
  const rows = await sql<{ name: string }[]>`
    select c.relname as name from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'business_id' and not a.attisdropped
     where n.nspname = 'app' and c.relkind = 'r'
     order by c.relname`
  return rows.map((r) => r.name)
}

/**
 * Deletes every row of `ids` (businesses) in every table of `tables` and the businesses themselves, in
 * one transaction with session_replication_role = replica: the append-only ledger, the guards of
 * posted documents and their lines (a finalized sale's included), the audit and the foreign-key
 * triggers do not run. Local only.
 */
export async function deleteBusinesses(
  sql: Sql,
  ids: readonly string[],
  tables: readonly string[],
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`set local session_replication_role = replica`
    for (const table of tables) {
      await tx`delete from ${tx('app')}.${tx(table)} where business_id = any(${ids}::uuid[])`
    }
    await tx`delete from app.businesses where id = any(${ids}::uuid[])`
    await tx`
      update app.profiles set last_business_id = null
       where last_business_id = any(${ids}::uuid[])`
  })
}

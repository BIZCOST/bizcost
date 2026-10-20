import type postgres from 'postgres'

// The parts of `pnpm dev:clean-test-data` (clean-test-data.ts, D-182) that choose what to remove and
// remove businesses' rows, apart so a test can run them on businesses of its own
// (test/dev-tools.api.test.ts). Local only: the caller connects as `postgres` to the local stack.

type Sql = postgres.Sql

/** The emails of the test suites' users (lower case). */
export const TEST_EMAIL = '^[^@\\s]+@(test\\.bizcost\\.local|example\\.test)$'

/**
 * How long what a test run made stays "in use" (D-338): a business written to (its row or an audit
 * row of it) or a user made, changed or signed in within it is left for a later clean-up, so a clean-up
 * run while a suite runs (an e2e run takes about 35 minutes, an API run about 25; one file far less)
 * never removes a business a test is still using.
 */
export const IN_USE_MINUTES = 60

/**
 * Works out the test users and the businesses to remove, in temporary tables of this session:
 * clean_known (every email known for every user id), clean_users and clean_businesses (to remove), and
 * clean_in_use_users and clean_in_use_businesses (test data left for now, IN_USE_MINUTES). Changes
 * nothing.
 */
export async function chooseTestData(sql: Sql, inUseMinutes = IN_USE_MINUTES): Promise<void> {
  const since = sql`now() - make_interval(mins => ${inUseMinutes})`
  await sql`drop table if exists pg_temp.clean_known, pg_temp.clean_users, pg_temp.clean_businesses,
    pg_temp.clean_in_use_users, pg_temp.clean_in_use_businesses`
  // Every email known for every user id, from each place that keeps one.
  await sql`
    create temp table clean_known as
      select id, lower(email) as email from auth.users where email is not null
      union
      select (payload->'traits'->>'user_id')::uuid, lower(payload->'traits'->>'user_email')
        from auth.audit_log_entries
       where payload->'traits'->>'user_email' is not null
         and payload->'traits'->>'user_id' ~ '^[0-9a-f-]{36}$'
      union
      select user_id, lower(email::text) from app.business_members
       where user_id is not null and email is not null`
  // A business a run may still be using: made, changed or audited within the window (an index probe
  // of audit_log by business and time each).
  await sql`
    create temp table clean_in_use_businesses as
      select b.id from app.businesses b
       where b.created_at > ${since} or b.updated_at > ${since}
          or exists (select 1 from app.audit_log a
                      where a.business_id = b.id and a.created_at > ${since})`
  await sql`alter table clean_in_use_businesses add primary key (id)`
  // A user a run may still be using: made, changed or signed in within the window, or a member of a
  // business in use.
  await sql`
    create temp table clean_in_use_users as
      select u.id from auth.users u
       where u.created_at > ${since} or u.updated_at > ${since} or u.last_sign_in_at > ${since}
      union
      select m.user_id from app.business_members m
       where m.user_id is not null and m.business_id in (select id from clean_in_use_businesses)`
  await sql`alter table clean_in_use_users add primary key (id)`
  // A test user to remove: every email known for it is a test suite's, and no run is using it.
  await sql`
    create temp table clean_users as
      select id from clean_known group by id having bool_and(email ~ ${TEST_EMAIL})
      except
      select id from clean_in_use_users`
  await sql`alter table clean_users add primary key (id)`
  // A business all of whose members are test users to remove (or, with none, made by one), not in use.
  await sql`
    create temp table clean_businesses as
      select b.id from app.businesses b
       where ((
         exists (select 1 from app.business_members m where m.business_id = b.id)
         and not exists (
           select 1 from app.business_members m
            where m.business_id = b.id
              and (m.user_id is null or m.user_id not in (select id from clean_users)))
       ) or (
         not exists (select 1 from app.business_members m where m.business_id = b.id)
         and b.created_by in (select id from clean_users)
       ))
       and b.id not in (select id from clean_in_use_businesses)`
  await sql`alter table clean_businesses add primary key (id)`
  // The guard, once more: nothing chosen carries an address that is not a test suite's.
  const [bad] = await sql<{ n: number }[]>`
    select count(*)::int as n from clean_known k
      join clean_users u on u.id = k.id
     where k.email !~ ${TEST_EMAIL}`
  if ((bad?.n ?? 0) > 0)
    throw new Error('refusing: a chosen user has an address that is not a test one')
}

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

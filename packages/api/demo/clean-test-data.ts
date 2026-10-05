import { createClient } from '@supabase/supabase-js'
import postgres from 'postgres'
import { deleteBusinesses, tenantTables } from './clean'
import { useLocalStack } from './local-stack'

// `pnpm dev:clean-test-data` (docs/ARCHITECTURE.md §Local setup; D-182): removes what the test
// suites leave in the LOCAL database. Every API, database and Playwright run makes its own users and
// businesses and never deletes their rows (the audit log is append-only), so the local database only
// grows (1.3 GB by M2 Step 5, most of it audit_log).
//
// What it removes, and only that:
//   - the users the test suites make: every email they use ends in @test.bizcost.local (the API,
//     database and e2e helpers, their invitees) or @example.test (pgTAP, inside transactions it
//     rolls back). A user is one of them only when EVERY email known for it is (auth.users, the Auth
//     server's own log of the users it made and deleted, and the email copied to its memberships), so
//     the owner's account, the demo accounts (@demo.bizcost.local) and any other real-looking address
//     are never touched;
//   - every business ALL of whose members are such users (or, with no member at all, one such a user
//     made), with every row of it in every table of schema app that has a business_id (the audit log
//     and the stock ledger included) and its files in Storage ({business_id}/…, removed through the
//     Storage API);
//   - the Auth users themselves (their identities and sessions go with them), their profiles when no
//     business that stays still names them, and the Auth server's log lines about them.
// Rows are deleted with session_replication_role = replica inside one transaction per batch of
// businesses, which skips the append-only and audit triggers: local only. Then VACUUM (ANALYZE), or
// VACUUM (FULL, ANALYZE) of the app tables with --full (gives the space back to the disk; locks each
// table while it runs), and the sizes before and after.
//
// It refuses to run anywhere but the CLI's local stack (useLocalStack: `supabase status` on loopback
// addresses and the database setting only the local stack has, the guard of supabase/seed.sql and
// demo:seed). --dry-run lists what it would remove and changes nothing.

/** The emails of the test suites' users (lower case). */
const TEST_EMAIL = '^[^@\\s]+@(test\\.bizcost\\.local|example\\.test)$'
/** Businesses per transaction. */
const BATCH = 250
/** Storage objects per removal request. */
const STORAGE_CHUNK = 100
const BUCKET = 'business-files'

const dryRun = process.argv.includes('--dry-run')
const full = process.argv.includes('--full')

type Sql = postgres.Sql

const MB = new Intl.NumberFormat('en', { minimumFractionDigits: 1, maximumFractionDigits: 1 })

/** A size in bytes (as Postgres gives it) in megabytes, for the report only. */
function mb(bytes: number | string): string {
  return `${MB.format(Number(bytes) / 1024 / 1024)} MB`
}

async function sizes(sql: Sql, label: string) {
  const [db] = await sql<{ size: string }[]>`select pg_database_size(current_database()) as size`
  const tables = await sql<{ name: string; size: string }[]>`
    select n.nspname || '.' || c.relname as name, pg_total_relation_size(c.oid) as size
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind = 'r' and n.nspname in ('app', 'auth', 'storage')
     order by pg_total_relation_size(c.oid) desc limit 5`
  console.log(`\n${label}: database ${mb(db?.size ?? 0)}`)
  for (const t of tables) console.log(`  ${t.name.padEnd(28)} ${mb(t.size)}`)
  return Number(db?.size ?? 0)
}

/** Works out the test users and the businesses to remove, in temporary tables of this session. */
async function identify(sql: Sql) {
  await sql`drop table if exists pg_temp.clean_known, pg_temp.clean_users, pg_temp.clean_businesses`
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
  // A test user: every email known for it is a test suite's.
  await sql`
    create temp table clean_users as
      select id from clean_known group by id having bool_and(email ~ ${TEST_EMAIL})`
  await sql`alter table clean_users add primary key (id)`
  // A business all of whose members are test users (or, with none, made by one).
  await sql`
    create temp table clean_businesses as
      select b.id from app.businesses b
       where (
         exists (select 1 from app.business_members m where m.business_id = b.id)
         and not exists (
           select 1 from app.business_members m
            where m.business_id = b.id
              and (m.user_id is null or m.user_id not in (select id from clean_users)))
       ) or (
         not exists (select 1 from app.business_members m where m.business_id = b.id)
         and b.created_by in (select id from clean_users)
       )`
  await sql`alter table clean_businesses add primary key (id)`
  // The guard, once more: nothing chosen carries an address that is not a test suite's.
  const [bad] = await sql<{ n: number }[]>`
    select count(*)::int as n from clean_known k
      join clean_users u on u.id = k.id
     where k.email !~ ${TEST_EMAIL}`
  if ((bad?.n ?? 0) > 0)
    throw new Error('refusing: a chosen user has an address that is not a test one')
}

async function report(sql: Sql, tables: string[]) {
  const [users] = await sql<{ all: number; live: number }[]>`
    select count(*)::int as all,
           (select count(*)::int from auth.users a where a.id in (select id from clean_users)) as live
      from clean_users`
  const [businesses] = await sql<{ n: number; kept: number }[]>`
    select (select count(*)::int from clean_businesses) as n,
           (select count(*)::int from app.businesses) - (select count(*)::int from clean_businesses)
             as kept`
  console.log(`\nTest users: ${users?.all ?? 0} (${users?.live ?? 0} still in Auth)`)
  console.log(
    `Businesses to remove: ${businesses?.n ?? 0} (kept: ${businesses?.kept ?? 0}, each with a member who is not a test user)`,
  )
  const counts: [string, number][] = []
  for (const table of tables) {
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from ${sql('app')}.${sql(table)}
       where business_id in (select id from clean_businesses)`
    if ((row?.n ?? 0) > 0) counts.push([table, row?.n ?? 0])
  }
  counts.sort((a, b) => b[1] - a[1])
  for (const [table, n] of counts) console.log(`  app.${table.padEnd(26)} ${n} rows`)
  const [objects] = await sql<{ n: number }[]>`
    select count(*)::int as n from storage.objects
     where bucket_id = ${BUCKET}
       and split_part(name, '/', 1) in (select id::text from clean_businesses)`
  const [profiles] = await sql<{ n: number }[]>`
    select count(*)::int as n from app.profiles p
     where p.id in (select id from clean_users)`
  const [authLog] = await sql<{ n: number }[]>`
    select count(*)::int as n from auth.audit_log_entries e
     where lower(coalesce(e.payload->'traits'->>'user_email', '')) ~ ${TEST_EMAIL}
        or lower(coalesce(e.payload->>'actor_username', '')) ~ ${TEST_EMAIL}`
  console.log(`  storage objects              ${objects?.n ?? 0}`)
  console.log(`  profiles (at most)           ${profiles?.n ?? 0}`)
  console.log(`  auth.audit_log_entries       ${authLog?.n ?? 0}`)
}

/** Removes the Storage objects of these businesses through the Storage API (never by SQL). */
async function removeObjects(sql: Sql, ids: string[]): Promise<number> {
  const rows = await sql<{ name: string }[]>`
    select name from storage.objects
     where bucket_id = ${BUCKET} and split_part(name, '/', 1) = any(${ids}::text[])`
  if (rows.length === 0) return 0
  const url = process.env.SUPABASE_API_URL ?? ''
  const key = process.env.SUPABASE_SECRET_KEY ?? ''
  const storage = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  }).storage.from(BUCKET)
  let removed = 0
  for (let i = 0; i < rows.length; i += STORAGE_CHUNK) {
    const paths = rows.slice(i, i + STORAGE_CHUNK).map((r) => r.name)
    const { data, error } = await storage.remove(paths)
    if (error)
      throw new Error(`Storage refused to remove ${paths.length} objects: ${error.message}`)
    removed += data?.length ?? 0
  }
  return removed
}

async function main() {
  await useLocalStack()
  const url = process.env.DATABASE_URL_ADMIN
  if (!url) throw new Error('no local database address')
  const sql = postgres(url, { max: 1, onnotice: () => {} })
  try {
    const before = await sizes(sql, 'Before')
    await identify(sql)
    const tables = await tenantTables(sql)
    await report(sql, tables)
    if (dryRun) {
      console.log('\nDry run: nothing was changed. Run again without --dry-run to remove it.')
      return
    }

    const ids = (await sql<{ id: string }[]>`select id from clean_businesses order by id`).map(
      (r) => r.id,
    )
    let objects = 0
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH)
      objects += await removeObjects(sql, batch)
      // Local only: skips the append-only, guard, audit and foreign-key triggers (clean.ts).
      await deleteBusinesses(sql, batch, tables)
      process.stdout.write(`\rBusinesses removed: ${Math.min(i + BATCH, ids.length)}/${ids.length}`)
    }
    if (ids.length > 0) process.stdout.write('\n')

    // The users: profiles no business still names, then the Auth users (their identities, sessions
    // and tokens go with them by Auth's own foreign keys) and the Auth server's log lines about them.
    const users = await sql.begin(async (tx) => {
      const profiles = await tx`
        delete from app.profiles p
         where p.id in (select id from clean_users)
           and not exists (select 1 from app.business_members m where m.user_id = p.id)`
      const auth = await tx`delete from auth.users where id in (select id from clean_users)`
      const log = await tx`
        delete from auth.audit_log_entries e
         where lower(coalesce(e.payload->'traits'->>'user_email', '')) ~ ${TEST_EMAIL}
            or lower(coalesce(e.payload->>'actor_username', '')) ~ ${TEST_EMAIL}`
      return { profiles: profiles.count, auth: auth.count, log: log.count }
    })
    console.log(
      `Removed: ${ids.length} businesses, ${objects} storage objects, ${users.auth} Auth users, ` +
        `${users.profiles} profiles, ${users.log} Auth log lines.`,
    )

    if (full) {
      console.log('VACUUM (FULL, ANALYZE) of the app tables…')
      for (const table of [...tables, 'businesses', 'profiles']) {
        await sql`vacuum (full, analyze) ${sql('app')}.${sql(table)}`
      }
    } else {
      console.log('VACUUM (ANALYZE)…')
      await sql`vacuum (analyze)`
    }
    const after = await sizes(sql, 'After')
    console.log(`\nDatabase: ${mb(before)} → ${mb(after)}`)
  } finally {
    await sql.end()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})

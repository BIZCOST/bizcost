-- pgTAP (Milestone 1, Step 9 hardening): what Supabase's own client-facing services could reach
-- without the API. The API integration suite (packages/api/test/hardening/direct-access.api.test.ts)
-- attacks PostgREST and Storage over HTTP with a real user token; this file pins the catalog facts
-- behind those answers, so a later migration cannot open a path the HTTP suite does not try:
--   - the exposed schemas (public, graphql_public) hold nothing anon or authenticated can read,
--     write or call through /rest/v1 or /rpc, except Supabase's GraphQL entry point;
--   - service_role (the secret key) cannot use schema app either, should app ever be exposed;
--   - PostgREST's login role can become only anon, authenticated and service_role (a token's `role`
--     claim cannot name bizcost_api);
--   - no app table is in a publication (Realtime would stream its changes);
--   - Storage: RLS is on and no policy exists on objects or buckets, so clients reach files only
--     through the API's signed URLs (06_settings checks the business-files bucket itself).
begin;
select plan(8);

select is_empty(
  $$ select n.nspname || '.' || c.relname || ' for ' || r.rolname
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      cross join (values ('anon'), ('authenticated')) as r(rolname)
      where n.nspname in ('public', 'graphql_public')
        and c.relkind in ('r', 'p', 'v', 'm', 'f')
        and has_table_privilege(r.rolname, c.oid, 'SELECT, INSERT, UPDATE, DELETE') $$,
  'no table or view of the exposed schemas can be read or written by anon or authenticated'
);

select is(
  (select coalesce(array_agg(distinct p.oid::regprocedure::text), '{}')
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    cross join (values ('anon'), ('authenticated')) as r(rolname)
    where n.nspname in ('public', 'graphql_public')
      and has_function_privilege(r.rolname, p.oid, 'EXECUTE')),
  array['graphql_public.graphql(text,text,jsonb,jsonb)'],
  'the only function anon or authenticated can call through /rpc is Supabase''s GraphQL entry point'
);

select ok(
  not has_schema_privilege('service_role', 'app', 'USAGE, CREATE'),
  'service_role (the secret key) has no privilege on schema app'
);

select is(
  (select array_agg(b.rolname::text order by b.rolname)
     from pg_auth_members m
     join pg_roles a on a.oid = m.member
     join pg_roles b on b.oid = m.roleid
    where a.rolname = 'authenticator'),
  array['anon', 'authenticated', 'service_role'],
  'PostgREST''s login role can switch only to anon, authenticated and service_role'
);

select is_empty(
  $$ select pubname || ': ' || schemaname || '.' || tablename
       from pg_publication_tables
      where schemaname = 'app' $$,
  'no app table is published (Realtime would stream its rows)'
);

select ok(
  (select bool_and(relrowsecurity)
     from pg_class
    where relnamespace = 'storage'::regnamespace and relname in ('objects', 'buckets')),
  'storage.objects and storage.buckets have row level security on'
);

select is_empty(
  $$ select tablename || ': ' || policyname
       from pg_policies
      where schemaname = 'storage' and tablename in ('objects', 'buckets') $$,
  'no Storage policy on objects or buckets: files are reached only through API-signed URLs'
);

select is_empty(
  $$ select id from storage.buckets where public $$,
  'no public bucket'
);

select * from finish();
rollback;

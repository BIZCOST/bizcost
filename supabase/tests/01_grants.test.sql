-- pgTAP: grants and role hardening (Milestone 1, Step 1).
-- bizcost_api is the only role that reaches schema app: not superuser, no BYPASSRLS,
-- owns nothing; anon/authenticated/PUBLIC get nothing on app; audit_log is
-- read-only (only the audit trigger writes it); SECURITY DEFINER functions pin
-- search_path and are owned by postgres.
-- Not tested here: app not being exposed through PostgREST (covered by config.toml).
begin;
select plan(33);

-- 1. The API role -------------------------------------------------------------------

select has_role('bizcost_api', 'role bizcost_api exists');

select is(
  (select rolsuper from pg_roles where rolname = 'bizcost_api'),
  false,
  'bizcost_api is not a superuser'
);

select is(
  (select rolbypassrls from pg_roles where rolname = 'bizcost_api'),
  false,
  'bizcost_api does not bypass row level security'
);

select is(
  (select rolinherit from pg_roles where rolname = 'bizcost_api'),
  false,
  'bizcost_api is NOINHERIT'
);

select is(
  (select rolcreaterole or rolcreatedb or rolreplication from pg_roles where rolname = 'bizcost_api'),
  false,
  'bizcost_api cannot create roles or databases and has no replication'
);

select is_empty(
  $$ select roleid::regrole::text
       from pg_auth_members
      where member = (select oid from pg_roles where rolname = 'bizcost_api') $$,
  'bizcost_api is not a member of any other role'
);

select ok(
  coalesce(
    (select setconfig @> array['statement_timeout=15s', 'idle_in_transaction_session_timeout=30s']
       from pg_db_role_setting
      where setrole = (select oid from pg_roles where rolname = 'bizcost_api')
        and setdatabase = 0),
    false),
  'bizcost_api has statement_timeout = 15s and idle_in_transaction_session_timeout = 30s'
);

select is_empty(
  $$ select classid::regclass::text as catalog, objid
       from pg_shdepend
      where refclassid = 'pg_authid'::regclass
        and refobjid = (select oid from pg_roles where rolname = 'bizcost_api')
        and deptype = 'o' $$,
  'bizcost_api owns no database object (it is never a table owner)'
);

-- 2. Schema app ------------------------------------------------------------------------

select ok(has_schema_privilege('bizcost_api', 'app', 'USAGE'), 'bizcost_api can use schema app');
select ok(not has_schema_privilege('bizcost_api', 'app', 'CREATE'), 'bizcost_api cannot create objects in schema app');
select ok(not has_schema_privilege('anon', 'app', 'USAGE, CREATE'), 'anon has no privilege on schema app');
select ok(not has_schema_privilege('authenticated', 'app', 'USAGE, CREATE'), 'authenticated has no privilege on schema app');

select is_empty(
  $$ select case a.grantee when 0 then 'PUBLIC' else a.grantee::regrole::text end as grantee, a.privilege_type
       from pg_namespace n,
            aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) as a
      where n.nspname = 'app'
        and a.grantee not in (n.nspowner, (select oid from pg_roles where rolname = 'bizcost_api')) $$,
  'only the owner and bizcost_api hold privileges on schema app (none for PUBLIC)'
);

-- 3. Tables ------------------------------------------------------------------------------

select is_empty(
  $$ select c.relname,
            case a.grantee when 0 then 'PUBLIC' else a.grantee::regrole::text end as grantee,
            a.privilege_type
       from pg_class c,
            aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) as a
      where c.relnamespace = (select oid from pg_namespace where nspname = 'app')
        and c.relkind in ('r', 'p', 'v', 'm', 'f')
        and a.grantee not in (c.relowner, (select oid from pg_roles where rolname = 'bizcost_api')) $$,
  'only the owner and bizcost_api hold privileges on app tables (none for PUBLIC)'
);

select is_empty(
  $$ select c.relname
       from pg_class c
      where c.relnamespace = (select oid from pg_namespace where nspname = 'app')
        and c.relkind in ('r', 'p', 'v', 'm', 'f')
        and (has_table_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
             or has_any_column_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')) $$,
  'anon has no privilege on any app table or column'
);

select is_empty(
  $$ select c.relname
       from pg_class c
      where c.relnamespace = (select oid from pg_namespace where nspname = 'app')
        and c.relkind in ('r', 'p', 'v', 'm', 'f')
        and (has_table_privilege('authenticated', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
             or has_any_column_privilege('authenticated', c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')) $$,
  'authenticated has no privilege on any app table or column'
);

select is_empty(
  $$ select c.relname, priv
       from pg_class c
      cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as priv
      where c.relnamespace = (select oid from pg_namespace where nspname = 'app')
        and c.relkind in ('r', 'p')
        and c.relname <> 'audit_log'
        and not has_table_privilege('bizcost_api', c.oid, priv) $$,
  'bizcost_api can SELECT, INSERT, UPDATE and DELETE every app table except audit_log'
);

select is_empty(
  $$ select c.relname
       from pg_class c
      where c.relnamespace = (select oid from pg_namespace where nspname = 'app')
        and c.relkind in ('r', 'p')
        and has_table_privilege('bizcost_api', c.oid, 'TRUNCATE, REFERENCES, TRIGGER') $$,
  'bizcost_api has no TRUNCATE (it ignores RLS), REFERENCES or TRIGGER on app tables'
);

select ok(
  has_table_privilege('bizcost_api', to_regclass('app.audit_log'), 'SELECT'),
  'bizcost_api can read audit_log'
);

select ok(
  not has_table_privilege('bizcost_api', to_regclass('app.audit_log'), 'INSERT, UPDATE, DELETE, TRUNCATE')
  and not has_any_column_privilege('bizcost_api', to_regclass('app.audit_log'), 'INSERT, UPDATE'),
  'audit_log is read-only for bizcost_api: only the audit trigger writes it (no INSERT, UPDATE, DELETE or TRUNCATE)'
);

-- 4. Functions --------------------------------------------------------------------------

select is_empty(
  $$ select p.oid::regprocedure::text as function,
            case a.grantee when 0 then 'PUBLIC' else a.grantee::regrole::text end as grantee
       from pg_proc p,
            aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) as a
      where p.pronamespace = (select oid from pg_namespace where nspname = 'app')
        and a.grantee not in (p.proowner, (select oid from pg_roles where rolname = 'bizcost_api')) $$,
  'app functions are executable only by their owner and bizcost_api (never PUBLIC)'
);

select is_empty(
  $$ select p.oid::regprocedure::text
       from pg_proc p
      where p.pronamespace = (select oid from pg_namespace where nspname = 'app')
        and has_function_privilege('anon', p.oid, 'EXECUTE') $$,
  'anon cannot execute any app function'
);

select is_empty(
  $$ select p.oid::regprocedure::text
       from pg_proc p
      where p.pronamespace = (select oid from pg_namespace where nspname = 'app')
        and has_function_privilege('authenticated', p.oid, 'EXECUTE') $$,
  'authenticated cannot execute any app function'
);

select ok(
  (select count(*) from pg_proc
    where pronamespace = (select oid from pg_namespace where nspname = 'app') and prosecdef) >= 5,
  'sanity: app has SECURITY DEFINER functions to check (membership, bootstrap, audit)'
);

select is_empty(
  $$ select p.oid::regprocedure::text
       from pg_proc p
      where p.pronamespace = (select oid from pg_namespace where nspname = 'app')
        and p.prosecdef
        and not exists (select 1 from unnest(p.proconfig) as c where c like 'search_path=%') $$,
  'every SECURITY DEFINER function in app pins search_path in proconfig'
);

select is_empty(
  $$ select p.oid::regprocedure::text, p.proconfig
       from pg_proc p
      where p.pronamespace = (select oid from pg_namespace where nspname = 'app')
        and p.prosecdef
        and not ('search_path=""' = any(coalesce(p.proconfig, '{}'::text[]))) $$,
  'every SECURITY DEFINER function in app uses SET search_path = '''' (fully-qualified names)'
);

select is_empty(
  $$ select p.oid::regprocedure::text, pg_get_userbyid(p.proowner)
       from pg_proc p
      where p.pronamespace = (select oid from pg_namespace where nspname = 'app')
        and p.prosecdef
        and pg_get_userbyid(p.proowner) <> 'postgres' $$,
  'SECURITY DEFINER functions in app are owned by postgres'
);

select is_empty(
  $$ select sig
       from unnest(array[
         'app.current_user_id()',
         'app.current_business_id()',
         'app.is_active_member(uuid)',
         'app.my_business_ids()',
         'app.create_business(uuid, text, text, text, uuid, uuid)',
         'app.accept_invitation(text, uuid)'
       ]) as sig
      where to_regprocedure(sig) is null
         or not has_function_privilege('bizcost_api', to_regprocedure(sig), 'EXECUTE') $$,
  'bizcost_api can execute the context, membership and bootstrap functions'
);

select is_empty(
  $$ select p.oid::regprocedure::text
       from pg_proc p
      where p.pronamespace = (select oid from pg_namespace where nspname = 'app')
        and p.proname = 'apply_tenant_rls'
        and has_function_privilege('bizcost_api', p.oid, 'EXECUTE') $$,
  'the migration-only helper app.apply_tenant_rls is not executable by bizcost_api'
);

select is_empty(
  $$ select p.oid::regprocedure::text
       from pg_proc p
      where p.pronamespace = (select oid from pg_namespace where nspname = 'public')
        and p.prosecdef $$,
  'no SECURITY DEFINER function lives in schema public (it would be reachable through /rpc)'
);

-- 5. Auth schema ------------------------------------------------------------------------

select ok(
  not has_table_privilege('bizcost_api', 'auth.users', 'SELECT, INSERT, UPDATE, DELETE'),
  'bizcost_api cannot touch auth.users (app.accept_invitation reads the verified email as definer)'
);

-- 6. Default privileges for tables added by later migrations ---------------------------
-- Runs last: the probe table must not show up in the catalog checks above.

set local role postgres;
create table app.zz_default_privileges_probe (id uuid primary key);
reset role;

select ok(
  has_table_privilege('bizcost_api', 'app.zz_default_privileges_probe', 'SELECT')
  and has_table_privilege('bizcost_api', 'app.zz_default_privileges_probe', 'INSERT')
  and has_table_privilege('bizcost_api', 'app.zz_default_privileges_probe', 'UPDATE')
  and has_table_privilege('bizcost_api', 'app.zz_default_privileges_probe', 'DELETE'),
  'default privileges give bizcost_api SELECT, INSERT, UPDATE and DELETE on new app tables'
);

select ok(
  not has_table_privilege('anon', 'app.zz_default_privileges_probe', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
  and not has_table_privilege('authenticated', 'app.zz_default_privileges_probe', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
  and not has_table_privilege('public', 'app.zz_default_privileges_probe', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
  'new app tables get no privilege for anon, authenticated or PUBLIC'
);

select * from finish();
rollback;

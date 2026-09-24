-- BizCost: API database role and tenant-context readers.
-- See docs/DATA_MODEL.md §1.1 and docs/ARCHITECTURE.md §Tenancy & security.
-- This runs before the table migration because every tenant table's created_by defaults to
-- app.current_user_id().

-- The API connects as bizcost_api: not a superuser, no BYPASSRLS, owns nothing. RLS therefore always
-- applies, and a query without tenant context returns zero rows (fails closed).
-- NOLOGIN here. LOGIN + PASSWORD are set per environment from a secret (runbook); for local development
-- only, supabase/seed.sql sets a fixed password. Roles are cluster-wide, so creation is guarded.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'bizcost_api') then
    create role bizcost_api nologin noinherit;
  end if;
end
$$;

-- Lets postgres (migrations, pgTAP tests, debugging) SET ROLE bizcost_api to act under its policies.
-- No INHERIT: postgres gains nothing from it; bizcost_api gains nothing either.
grant bizcost_api to postgres with inherit false, set true;

alter role bizcost_api set statement_timeout = '15s';
alter role bizcost_api set idle_in_transaction_session_timeout = '30s';

-- Case-insensitive email column on business_invitations.
create extension if not exists citext with schema extensions;

-- citext's operators live in `extensions`. Without it on the search path, `email = $1` on a citext column
-- silently resolves to the case-sensitive text operator. App objects are always schema-qualified.
grant usage on schema extensions to bizcost_api;
alter role bizcost_api set search_path = extensions;

-- Tenant context. withTenantTx() (packages/db) sets these with set_config(..., true) as the first
-- statement of every transaction, so they are transaction-local and empty again afterwards.
create function app.current_user_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid
$$;

comment on function app.current_user_id() is
  'Auth user id of the current request (transaction-local app.user_id), or NULL.';

create function app.current_business_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif(pg_catalog.current_setting('app.business_id', true), '')::uuid
$$;

comment on function app.current_business_id() is
  'Active business of the current request (transaction-local app.business_id), or NULL.';

revoke all on function app.current_user_id() from public, anon, authenticated;
revoke all on function app.current_business_id() from public, anon, authenticated;
grant execute on function app.current_user_id() to bizcost_api;
grant execute on function app.current_business_id() to bizcost_api;

-- pgTAP: RLS policies are evaluated once per query (InitPlan), never per row (SubPlan).
-- The standard policy wraps every function call in a scalar sub-select and never
-- passes a row column to a function, so EXPLAIN as bizcost_api must show InitPlan
-- nodes and no SubPlan for every table with business_id, for SELECT/UPDATE/DELETE.
-- EXPLAIN without ANALYZE runs nothing, so no fixtures are needed.
begin;
select plan(16);

-- On Supabase, postgres is not a superuser: make sure it may SET ROLE bizcost_api.
do $$
begin
  if not pg_has_role(current_user, 'bizcost_api', 'SET') then
    execute format('grant bizcost_api to %I', current_user);
  end if;
exception when others then
  raise warning 'cannot let % SET ROLE bizcost_api: %', current_user, sqlerrm;
end
$$;

create function pg_temp.id(p_name text) returns uuid
language sql immutable
as $$ select md5(p_name)::uuid $$;

-- EXPLAIN (costs off) of p_sql as bizcost_api with a tenant context; the plan as text,
-- or 'ERROR <sqlstate>: <message>'.
create function pg_temp.api_plan(p_sql text)
returns text
language plpgsql
as $$
declare
  v_line text;
  v_plan text := '';
begin
  perform set_config('app.user_id', pg_temp.id('user A')::text, true);
  perform set_config('app.business_id', pg_temp.id('biz A')::text, true);
  perform set_config('app.request_id', pg_temp.id('request')::text, true);
  begin
    set local role bizcost_api;
    for v_line in execute 'explain (costs off) ' || p_sql loop
      v_plan := v_plan || v_line || E'\n';
    end loop;
  exception when others then
    v_plan := 'ERROR ' || sqlstate || ': ' || sqlerrm;
  end;
  reset role;
  perform set_config('app.user_id', '', true);
  perform set_config('app.business_id', '', true);
  perform set_config('app.request_id', '', true);
  return v_plan;
end
$$;

-- Tables with business_id: the standard tenant tables plus business_members.
create temp view policy_tables as
  select c.relname::text as table_name
    from pg_class c
   where c.relnamespace = (select oid from pg_namespace where nspname = 'app')
     and c.relkind in ('r', 'p')
     and exists (select 1 from pg_attribute a
                  where a.attrelid = c.oid and a.attname = 'business_id' and not a.attisdropped);

select is(
  (select count(*)::int from policy_tables),
  11,
  'sanity: 11 tables with business_id to explain'
);

-- SELECT ------------------------------------------------------------------------------

select is_empty(
  $$ select t.table_name, p.plan
       from policy_tables t
      cross join lateral (select pg_temp.api_plan(format('select * from app.%I', t.table_name)) as plan) as p
      where p.plan !~ 'InitPlan' $$,
  'SELECT plans on every table with business_id evaluate the policy as an InitPlan'
);

select is_empty(
  $$ select t.table_name, p.plan
       from policy_tables t
      cross join lateral (select pg_temp.api_plan(format('select * from app.%I', t.table_name)) as plan) as p
      where p.plan ~ 'SubPlan' or p.plan ~ '^ERROR' $$,
  'SELECT plans on every table with business_id have no SubPlan'
);

-- UPDATE (audit_log has no UPDATE/DELETE grant) -------------------------------------------

select is_empty(
  $$ select t.table_name, p.plan
       from policy_tables t
      cross join lateral (select pg_temp.api_plan(format(
        'update app.%I set updated_at = updated_at where id = %L', t.table_name, pg_temp.id('some row'))) as plan) as p
      where t.table_name <> 'audit_log' and p.plan !~ 'InitPlan' $$,
  'UPDATE plans evaluate the policy as an InitPlan'
);

select is_empty(
  $$ select t.table_name, p.plan
       from policy_tables t
      cross join lateral (select pg_temp.api_plan(format(
        'update app.%I set updated_at = updated_at where id = %L', t.table_name, pg_temp.id('some row'))) as plan) as p
      where t.table_name <> 'audit_log' and (p.plan ~ 'SubPlan' or p.plan ~ '^ERROR') $$,
  'UPDATE plans have no SubPlan'
);

-- DELETE --------------------------------------------------------------------------------

select is_empty(
  $$ select t.table_name, p.plan
       from policy_tables t
      cross join lateral (select pg_temp.api_plan(format(
        'delete from app.%I where id = %L', t.table_name, pg_temp.id('some row'))) as plan) as p
      where t.table_name <> 'audit_log' and p.plan !~ 'InitPlan' $$,
  'DELETE plans evaluate the policy as an InitPlan'
);

select is_empty(
  $$ select t.table_name, p.plan
       from policy_tables t
      cross join lateral (select pg_temp.api_plan(format(
        'delete from app.%I where id = %L', t.table_name, pg_temp.id('some row'))) as plan) as p
      where t.table_name <> 'audit_log' and (p.plan ~ 'SubPlan' or p.plan ~ '^ERROR') $$,
  'DELETE plans have no SubPlan'
);

-- profiles (own-row policy) ----------------------------------------------------------------

select matches(
  pg_temp.api_plan('select * from app.profiles'),
  'InitPlan',
  'the profiles policy is evaluated as an InitPlan'
);

select doesnt_match(
  pg_temp.api_plan('select * from app.profiles'),
  'SubPlan|^ERROR',
  'the profiles plan has no SubPlan'
);

-- A typical join (member with its role) ---------------------------------------------------

select matches(
  pg_temp.api_plan($$
    select m.display_name, r.name
      from app.business_members m
      join app.roles r on r.business_id = m.business_id and r.id = m.role_id $$),
  'InitPlan',
  'a member/role join evaluates both policies as InitPlans'
);

select doesnt_match(
  pg_temp.api_plan($$
    select m.display_name, r.name
      from app.business_members m
      join app.roles r on r.business_id = m.business_id and r.id = m.role_id $$),
  'SubPlan|^ERROR',
  'a member/role join has no SubPlan'
);

-- businesses (member list via app.my_business_ids(), update of the current business) ----------

select matches(
  pg_temp.api_plan('select * from app.businesses'),
  'InitPlan',
  'the businesses SELECT policy is evaluated as an InitPlan'
);

select doesnt_match(
  pg_temp.api_plan('select * from app.businesses'),
  'SubPlan|^ERROR',
  'the businesses SELECT plan has no SubPlan'
);

select matches(
  pg_temp.api_plan(format('update app.businesses set legal_name = legal_name where id = %L', pg_temp.id('biz A'))),
  'InitPlan',
  'the businesses UPDATE policy is evaluated as an InitPlan'
);

select doesnt_match(
  pg_temp.api_plan(format('update app.businesses set legal_name = legal_name where id = %L', pg_temp.id('biz A'))),
  'SubPlan|^ERROR',
  'the businesses UPDATE plan has no SubPlan'
);

-- business_members reads are OR-ed with the own-memberships arm (user_id alone): an index must
-- serve it, or every read scans the members of all businesses.

set local enable_seqscan = off;

select doesnt_match(
  pg_temp.api_plan('select * from app.business_members'),
  'Seq Scan|^ERROR',
  'reading business_members under RLS needs no sequential scan (user_id index for own memberships)'
);

reset enable_seqscan;

select * from finish();
rollback;

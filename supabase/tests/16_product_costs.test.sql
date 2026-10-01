-- pgTAP: product costs (M2 Step 6; docs/DATA_MODEL.md §6, D-119, D-202).
-- The settings of how product costs are worked out are a column of businesses (the owner's hourly
-- rate) and one of products_services (the owner's minutes for one unit); nothing else is stored:
-- every cost is worked out on read, and running costs reach products by their price without a
-- setting (the estimate of monthly material purchases is gone, D-202). Two businesses, each with its
-- owner. As bizcost_api, like the API: the columns; the CHECKs refuse 0 or less (NULL is "not
-- set yet", never 0); a business changes only its own row and products; every change is audited; and
-- the permission keys of the Cost Engine are held only with the keys they need (PERMISSION_NEEDS,
-- which the migration product_costs_access kept when it added them to the existing roles).
begin;
select plan(17);

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
grant execute on function pg_temp.id(text) to bizcost_api;

-- Runs p_sql as bizcost_api with the given user/business (fixture names; null = unset). Returns
-- 'ok <row count>', the first column of the first row (p_scalar), or 'ERROR <sqlstate>: <message>'.
create function pg_temp.api_run(p_user text, p_business text, p_sql text, p_scalar boolean)
returns text
language plpgsql
as $$
declare
  v_out text;
  v_rows bigint;
begin
  perform set_config('app.user_id', coalesce(pg_temp.id(p_user)::text, ''), true);
  perform set_config('app.business_id', coalesce(pg_temp.id(p_business)::text, ''), true);
  perform set_config('app.request_id', pg_temp.id('request')::text, true);
  begin
    set local role bizcost_api;
    if p_scalar then
      execute p_sql into v_out;
    else
      execute p_sql;
      get diagnostics v_rows = row_count;
      v_out := 'ok ' || v_rows;
    end if;
  exception when others then
    v_out := 'ERROR ' || sqlstate || ': ' || sqlerrm;
  end;
  reset role;
  perform set_config('app.user_id', '', true);
  perform set_config('app.business_id', '', true);
  perform set_config('app.request_id', '', true);
  return v_out;
end
$$;

create function pg_temp.api_exec(p_user text, p_business text, p_sql text)
returns text language sql
as $$ select pg_temp.api_run(p_user, p_business, p_sql, false) $$;

create function pg_temp.api_value(p_user text, p_business text, p_sql text)
returns text language sql
as $$ select pg_temp.api_run(p_user, p_business, p_sql, true) $$;

-- The SQLSTATE of a refused statement ('ok …' when it was not refused).
create function pg_temp.state_of(p_result text)
returns text language sql immutable
as $$ select case when p_result like 'ERROR %' then substr(p_result, 7, 5) else p_result end $$;

insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', pg_temp.id(u.name), 'authenticated', 'authenticated',
       u.email, now(), '{}', '{}', now(), now()
  from (values ('user A', 'amira@example.test'), ('user B', 'badr@example.test')) as u(name, email);

-- 1. Column types (3) ------------------------------------------------------------------------------

select hasnt_column('app', 'businesses', 'estimated_monthly_purchases',
                    'businesses has no estimate of monthly purchases any more (D-202)');
select col_type_is('app', 'businesses', 'owner_hourly_rate', 'numeric(20,4)',
                   'businesses.owner_hourly_rate is numeric(20,4): a document amount');
select col_type_is('app', 'products_services', 'owner_minutes', 'numeric(24,6)',
                   'products_services.owner_minutes is numeric(24,6): a quantity');

-- 2. Fixtures (3) ------------------------------------------------------------------------------------

select is(
  pg_temp.api_value(v.who, null, format(
    $$ select app.create_business(pg_temp.id(%L), %L, 'en', 'Owner', pg_temp.id(%L), pg_temp.id(%L)) $$,
    v.biz, v.name, v.biz || ' owner role', v.biz || ' owner member')),
  pg_temp.id(v.biz)::text,
  'setup: ' || v.who || ' creates ' || v.biz
)
  from (values ('user A', 'biz A', 'Alpha Bakery'), ('user B', 'biz B', 'Beta Bakery')) as v(who, biz, name);

select is(
  pg_temp.api_exec('user A', 'biz A', $$
    insert into app.products_services (id, business_id, name, type, unit, owner_minutes)
    values (pg_temp.id('cake A'), pg_temp.id('biz A'), 'Cake slice', 'product', 'piece', 10) $$),
  'ok 1',
  'setup: a cake slice in A that takes its owner 10 minutes'
);

-- 3. More than zero; NULL is "not set yet" (5) ---------------------------------------------------------

select is(
  pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', v.stmt)),
  '23514',
  v.what
)
  from (values
    ($$ update app.businesses set owner_hourly_rate = 0 where id = pg_temp.id('biz A') $$,
     'an hourly rate of 0 is refused (not set yet is NULL)'),
    ($$ update app.businesses set owner_hourly_rate = -45 where id = pg_temp.id('biz A') $$,
     'a negative hourly rate is refused'),
    ($$ update app.products_services set owner_minutes = 0 where id = pg_temp.id('cake A') $$,
     'zero minutes are refused (no time is NULL)')
  ) as v(stmt, what);

select is(
  pg_temp.api_exec('user A', 'biz A', $$
    update app.businesses
       set owner_hourly_rate = 45.5
     where id = pg_temp.id('biz A') $$),
  'ok 1',
  'the owner of A sets its hourly rate (45.50)'
);

select is(
  pg_temp.api_exec('user A', 'biz A', $$
    update app.businesses set owner_hourly_rate = null
     where id = pg_temp.id('biz A') and false $$),
  'ok 0',
  'sanity: an update that matches nothing changes nothing'
);

-- 4. Only its own (3) -----------------------------------------------------------------------------------

select is(
  pg_temp.api_exec('user B', 'biz B', $$
    update app.businesses set owner_hourly_rate = 1 where id = pg_temp.id('biz A') $$),
  'ok 0',
  'the owner of B cannot change A''s hourly rate (RLS: no row)'
);

select is(
  pg_temp.api_exec('user B', 'biz B', $$
    update app.products_services set owner_minutes = 1 where id = pg_temp.id('cake A') $$),
  'ok 0',
  'the owner of B cannot change the minutes of A''s cake (RLS: no row)'
);

select is(
  (select trim_scale(owner_hourly_rate)::text from app.businesses where id = pg_temp.id('biz A')),
  '45.5',
  'A''s settings are as its owner saved them'
);

-- 5. The audit (1) ----------------------------------------------------------------------------------------

select ok(
  (select count(*) from app.audit_log
    where business_id = pg_temp.id('biz A') and entity = 'businesses'
      and entity_id = pg_temp.id('biz A') and action = 'update'
      and actor_user_id = pg_temp.id('user A')) >= 1,
  'the change of A''s settings is in the audit log, by its owner'
);

-- 6. Keys with the keys they need (2) --------------------------------------------------------------------

select is_empty(
  $$ select r.id from app.role_permissions p
       join app.roles r on r.business_id = p.business_id and r.id = p.role_id
      where p.deleted_at is null and r.deleted_at is null
        and p.permission_key = 'cost_engine.product_costs.view'
        and not exists (
          select 1 from app.role_permissions n
           where n.business_id = p.business_id and n.role_id = p.role_id and n.deleted_at is null
             and n.permission_key = 'products.recipes.view') $$,
  'every role that sees product costs sees what goes into each product'
);

select is_empty(
  $$ select r.id from app.role_permissions p
       join app.roles r on r.business_id = p.business_id and r.id = p.role_id
      where p.deleted_at is null and r.deleted_at is null
        and p.permission_key = 'cost_engine.settings.manage'
        and not exists (
          select 1 from app.role_permissions n
           where n.business_id = p.business_id and n.role_id = p.role_id and n.deleted_at is null
             and n.permission_key = 'cost_engine.product_costs.view') $$,
  'every role that changes how product costs are worked out sees product costs'
);

select * from finish();
rollback;

-- pgTAP: Materials and Products & Services (M2 Step 2; docs/DATA_MODEL.md §6, D-121–D-123).
-- Two businesses, each with its owner. As bizcost_api, like the API: the rows of each business are
-- invisible to the other, composite FKs refuse every link across businesses (and a pack naming a pack
-- of another material), the CHECKs hold the documented value lists, names are unique per business
-- ignoring case (archived ones included, deleted ones not), and the touch and audit triggers run.
-- RLS, the policy, the triggers and the grants of every tenant table are also checked generically by
-- 00_catalog_coverage, 01_grants and 03_rls_initplan.
begin;
select plan(44);

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
  from (values ('user A', 'amal@example.test'), ('user B', 'bilal@example.test')) as u(name, email);

-- 1. Column types (3) -----------------------------------------------------------------------

select col_type_is('app', 'material_units', 'qty', 'numeric(28,12)',
                   'material_units.qty is numeric(28,12): an exact conversion factor');
select col_type_is('app', 'products_services', 'default_price', 'numeric(20,4)',
                   'products_services.default_price is numeric(20,4): money');
select col_type_is('app', 'materials', 'archived_at', 'timestamp with time zone',
                   'materials.archived_at is a timestamptz (archived, never deleted)');

-- 2. Fixtures: two businesses with a location, materials with packs and products (11) ------------

select is(
  pg_temp.api_value(v.who, null, format(
    $$ select app.create_business(pg_temp.id(%L), %L, 'en', 'Owner', pg_temp.id(%L), pg_temp.id(%L)) $$,
    v.biz, v.name, v.biz || ' owner role', v.biz || ' owner member')),
  pg_temp.id(v.biz)::text,
  'setup: ' || v.who || ' creates ' || v.biz
)
  from (values ('user A', 'biz A', 'Alpha Cafe'), ('user B', 'biz B', 'Beta Cafe')) as v(who, biz, name);

select is(pg_temp.api_exec(v.who, v.biz, v.stmt), 'ok 1', 'setup: ' || v.what)
  from (values
    ('user A', 'biz A', 'a location of A', $$
      insert into app.locations (id, business_id, name) values (pg_temp.id('loc A'), pg_temp.id('biz A'), 'Main') $$),
    ('user B', 'biz B', 'a location of B', $$
      insert into app.locations (id, business_id, name) values (pg_temp.id('loc B'), pg_temp.id('biz B'), 'Main') $$),
    ('user A', 'biz A', 'milk in A, counted in litres', $$
      insert into app.materials (id, business_id, name, dimension, unit)
      values (pg_temp.id('mat A'), pg_temp.id('biz A'), 'Milk', 'volume', 'l') $$),
    ('user A', 'biz A', 'a second material in A with a pack', $$
      with m as (
        insert into app.materials (id, business_id, name, dimension, unit)
        values (pg_temp.id('mat A2'), pg_temp.id('biz A'), 'Coffee beans', 'mass', 'kg')
        returning id
      )
      insert into app.material_units (id, business_id, material_id, kind, name, qty, of_unit)
      select pg_temp.id('bag A2'), pg_temp.id('biz A'), m.id, 'pack', 'bag', 1000, 'g' from m $$),
    ('user B', 'biz B', 'milk in B too: names are per business', $$
      insert into app.materials (id, business_id, name, dimension, unit)
      values (pg_temp.id('mat B'), pg_temp.id('biz B'), 'milk', 'volume', 'ml') $$),
    ('user A', 'biz A', 'a latte in A', $$
      insert into app.products_services (id, business_id, name, type, unit, default_price, vat_category, price_includes_vat)
      values (pg_temp.id('prod A'), pg_temp.id('biz A'), 'Latte', 'product', 'piece', 15.5, 'standard', true) $$),
    ('user B', 'biz B', 'a service in B', $$
      insert into app.products_services (id, business_id, name, type, unit)
      values (pg_temp.id('prod B'), pg_temp.id('biz B'), 'Catering', 'service', 'h') $$),
    ('user A', 'biz A', 'the latte is sold at A''s location', $$
      insert into app.product_locations (id, business_id, product_id, location_id)
      values (pg_temp.id('pl A'), pg_temp.id('biz A'), pg_temp.id('prod A'), pg_temp.id('loc A')) $$)
  ) as v(who, biz, what, stmt);

select is(
  pg_temp.api_exec('user A', 'biz A', $$
    insert into app.material_units (id, business_id, material_id, kind, name, unit, qty, of_unit, of_pack_id)
    values
      (pg_temp.id('bottle A'), pg_temp.id('biz A'), pg_temp.id('mat A'), 'pack', 'bottle', null, 1, 'l', null),
      (pg_temp.id('carton A'), pg_temp.id('biz A'), pg_temp.id('mat A'), 'pack', 'carton', null, 12, null, pg_temp.id('bottle A')),
      (pg_temp.id('cross A'), pg_temp.id('biz A'), pg_temp.id('mat A'), 'cross', null, 'kg', 0.97, 'l', null) $$),
  'ok 3',
  'setup: 1 carton = 12 bottles, 1 bottle = 1 l, 1 kg = 0.97 l (one statement: a pack names another)'
);

-- 3. Isolation (5) -------------------------------------------------------------------------

select is(
  pg_temp.api_value('user A', 'biz A', format(
    $$ select count(*) filter (where business_id = %L) || '/' || count(*) filter (where business_id <> %L) from app.%I $$,
    pg_temp.id('biz A'), pg_temp.id('biz A'), v.tbl)),
  v.seen,
  'user A in business A sees only A''s rows of ' || v.tbl
)
  from (values ('materials', '2/0'), ('material_units', '4/0'), ('products_services', '1/0'),
               ('product_locations', '1/0')) as v(tbl, seen);

select is(
  pg_temp.api_value('user A', 'biz B', $$
    select (select count(*) from app.materials) + (select count(*) from app.material_units)
         + (select count(*) from app.products_services) + (select count(*) from app.product_locations) $$),
  '0',
  'user A naming business B (not a member) sees no row of the catalog tables'
);

-- 4. No link across businesses or materials (5) ----------------------------------------------

select is(
  pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', v.stmt)),
  v.state,
  v.what
)
  from (values
    ('a unit of A on B''s material is refused by the composite FK', '23503', $$
      insert into app.material_units (id, business_id, material_id, kind, name, qty, of_unit)
      values (pg_temp.id('x1'), pg_temp.id('biz A'), pg_temp.id('mat B'), 'pack', 'box', 1, 'l') $$),
    ('a pack cannot name a pack of another material', '23503', $$
      insert into app.material_units (id, business_id, material_id, kind, name, qty, of_pack_id)
      values (pg_temp.id('x2'), pg_temp.id('biz A'), pg_temp.id('mat A'), 'pack', 'crate', 2, pg_temp.id('bag A2')) $$),
    ('a product of A cannot be sold at B''s location', '23503', $$
      insert into app.product_locations (id, business_id, product_id, location_id)
      values (pg_temp.id('x3'), pg_temp.id('biz A'), pg_temp.id('prod A'), pg_temp.id('loc B')) $$),
    ('A cannot link B''s product to its location', '23503', $$
      insert into app.product_locations (id, business_id, product_id, location_id)
      values (pg_temp.id('x4'), pg_temp.id('biz A'), pg_temp.id('prod B'), pg_temp.id('loc A')) $$),
    ('a row of business B written with A''s context breaks the policy', '42501', $$
      insert into app.materials (id, business_id, name, dimension, unit)
      values (pg_temp.id('x5'), pg_temp.id('biz B'), 'Sugar', 'mass', 'kg') $$)
  ) as v(what, state, stmt);

-- 5. Value lists and shapes (10) ------------------------------------------------------------

select is(
  pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', v.stmt)),
  '23514',
  v.what
)
  from (values
    ('a material''s unit must be of its dimension (kg is not a volume)', $$
      insert into app.materials (id, business_id, name, dimension, unit)
      values (pg_temp.id('c1'), pg_temp.id('biz A'), 'Flour', 'volume', 'kg') $$),
    ('a material needs a name that is not blank', $$
      insert into app.materials (id, business_id, name, dimension, unit)
      values (pg_temp.id('c2'), pg_temp.id('biz A'), '   ', 'mass', 'kg') $$),
    ('only standard units ("cup" is not one)', $$
      insert into app.materials (id, business_id, name, dimension, unit)
      values (pg_temp.id('c3'), pg_temp.id('biz A'), 'Cups', 'count', 'cup') $$),
    ('a pack needs a name', $$
      insert into app.material_units (id, business_id, material_id, kind, qty, of_unit)
      values (pg_temp.id('c4'), pg_temp.id('biz A'), pg_temp.id('mat A'), 'pack', 2, 'l') $$),
    ('a unit holds a standard unit or a pack, not both', $$
      insert into app.material_units (id, business_id, material_id, kind, name, qty, of_unit, of_pack_id)
      values (pg_temp.id('c5'), pg_temp.id('biz A'), pg_temp.id('mat A'), 'pack', 'tray', 2, 'l', pg_temp.id('bottle A')) $$),
    ('a quantity is more than zero', $$
      insert into app.material_units (id, business_id, material_id, kind, name, qty, of_unit)
      values (pg_temp.id('c6'), pg_temp.id('biz A'), pg_temp.id('mat A'), 'pack', 'drop', 0, 'ml') $$),
    ('a cross factor names a standard unit, never a pack', $$
      insert into app.material_units (id, business_id, material_id, kind, unit, qty, of_pack_id)
      values (pg_temp.id('c7'), pg_temp.id('biz A'), pg_temp.id('mat A'), 'cross', 'g', 1, pg_temp.id('bottle A')) $$),
    ('a product is a product or a service', $$
      insert into app.products_services (id, business_id, name, type, unit)
      values (pg_temp.id('c8'), pg_temp.id('biz A'), 'Box', 'bundle', 'piece') $$),
    ('a selling price is not negative', $$
      insert into app.products_services (id, business_id, name, type, unit, default_price)
      values (pg_temp.id('c9'), pg_temp.id('biz A'), 'Tea', 'product', 'piece', -1) $$),
    ('the VAT setting is standard, zero_rated or exempt', $$
      insert into app.products_services (id, business_id, name, type, unit, vat_category)
      values (pg_temp.id('c10'), pg_temp.id('biz A'), 'Water', 'product', 'piece', 'reduced') $$)
  ) as v(what, stmt);

-- 6. Names: unique per business ignoring case, archived included, deleted not (7) -------------

select is(
  pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', $$
    insert into app.materials (id, business_id, name, dimension, unit)
    values (pg_temp.id('n1'), pg_temp.id('biz A'), 'MILK', 'volume', 'l') $$)),
  '23505',
  'a second "milk" in business A is refused, whatever the case'
);

select is(
  pg_temp.api_exec('user A', 'biz A', $$
    update app.materials set archived_at = now() where id = pg_temp.id('mat A') $$),
  'ok 1',
  'setup: the milk is archived'
);

select is(
  pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', $$
    insert into app.materials (id, business_id, name, dimension, unit)
    values (pg_temp.id('n2'), pg_temp.id('biz A'), 'milk', 'volume', 'l') $$)),
  '23505',
  'an archived material keeps its name (unarchive it instead)'
);

select is(
  pg_temp.api_exec('user A', 'biz A', $$
    insert into app.materials (id, business_id, name, dimension, unit, deleted_at)
    values (pg_temp.id('n3'), pg_temp.id('biz A'), 'Oats', 'mass', 'kg', now()) $$),
  'ok 1',
  'setup: a deleted material named Oats'
);

select is(
  pg_temp.api_exec('user A', 'biz A', $$
    insert into app.materials (id, business_id, name, dimension, unit)
    values (pg_temp.id('n4'), pg_temp.id('biz A'), 'oats', 'mass', 'kg') $$),
  'ok 1',
  'a deleted row does not hold its name'
);

select is(
  pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', $$
    insert into app.products_services (id, business_id, name, type, unit)
    values (pg_temp.id('n5'), pg_temp.id('biz A'), 'LATTE', 'service', 'piece') $$)),
  '23505',
  'a product and a service of one business cannot share a name'
);

select is(
  pg_temp.api_exec('user B', 'biz B', $$
    insert into app.products_services (id, business_id, name, type, unit)
    values (pg_temp.id('n6'), pg_temp.id('biz B'), 'latte', 'product', 'piece') $$),
  'ok 1',
  'business B may have its own "latte"'
);

-- 7. Touch and audit triggers (3) ------------------------------------------------------------

select is(
  pg_temp.api_value('user A', 'biz A', $$
    update app.materials set name = 'Fresh milk' where id = pg_temp.id('mat A')
    returning version || '/' || (updated_by = pg_temp.id('user A')) $$),
  '3/true',
  'every change of a material bumps its version (archived, then renamed) and records who'
);

select is(
  pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', $$
    update app.material_units set business_id = pg_temp.id('biz B') where id = pg_temp.id('bottle A') $$)),
  '23514',
  'a unit cannot move to another business (touch_row)'
);

select is(
  (select string_agg(e.entity, ',' order by e.entity collate "C")
     from (select distinct entity
             from app.audit_log
            where business_id = pg_temp.id('biz A')
              and actor_user_id = pg_temp.id('user A')
              and entity in ('materials', 'material_units', 'products_services',
                             'product_locations')) as e),
  'material_units,materials,product_locations,products_services',
  'writes of the four catalog tables are in the audit log, with their actor'
);

select * from finish();
rollback;

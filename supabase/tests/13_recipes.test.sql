-- pgTAP: Recipes and items bought ready to sell (M2 Step 4; docs/DATA_MODEL.md §6, D-117, D-146–D-151).
-- Two businesses, each with its owner. As bizcost_api, like the API: the rows of each business are
-- invisible to the other; composite FKs refuse a recipe of another business's product, a line of
-- another business's material or recipe, and a pack of another material; the CHECKs hold a line's
-- shape; one live line per material; an item bought ready to sell is a product (not a service), one
-- per material, and never changes its material (keep_resale_link); a material a live recipe line names
-- keeps its kind of measure (keep_dimension); the audit trigger runs. RLS, the policy, the triggers
-- and the grants of every tenant table are also checked generically by 00_catalog_coverage, 01_grants
-- and 03_rls_initplan.
begin;
select plan(26);

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

-- 1. Column types (2) ------------------------------------------------------------------------

select col_type_is('app', 'recipe_lines', 'qty', 'numeric(24,6)',
                   'recipe_lines.qty is numeric(24,6): a quantity as typed');
select col_type_is('app', 'recipe_lines', 'base_qty', 'numeric(24,6)',
                   'recipe_lines.base_qty is numeric(24,6): the same in the material''s base unit');

-- 2. Fixtures (9) ------------------------------------------------------------------------------

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
    ('user A', 'biz A', 'milk in A, with a carton', $$
      with m as (
        insert into app.materials (id, business_id, name, dimension, unit)
        values (pg_temp.id('mat A'), pg_temp.id('biz A'), 'Milk', 'volume', 'l')
        returning id
      )
      insert into app.material_units (id, business_id, material_id, kind, name, qty, of_unit)
      select pg_temp.id('carton A'), pg_temp.id('biz A'), m.id, 'pack', 'carton', 12, 'l' from m $$),
    ('user A', 'biz A', 'beans in A', $$
      insert into app.materials (id, business_id, name, dimension, unit)
      values (pg_temp.id('beans A'), pg_temp.id('biz A'), 'Beans', 'mass', 'kg') $$),
    ('user B', 'biz B', 'milk in B', $$
      insert into app.materials (id, business_id, name, dimension, unit)
      values (pg_temp.id('mat B'), pg_temp.id('biz B'), 'Milk', 'volume', 'l') $$),
    ('user A', 'biz A', 'a latte in A', $$
      insert into app.products_services (id, business_id, name, type, unit)
      values (pg_temp.id('latte A'), pg_temp.id('biz A'), 'Latte', 'product', 'piece') $$),
    ('user B', 'biz B', 'a latte in B', $$
      insert into app.products_services (id, business_id, name, type, unit)
      values (pg_temp.id('latte B'), pg_temp.id('biz B'), 'Latte', 'product', 'piece') $$),
    ('user A', 'biz A', 'the latte''s recipe', $$
      insert into app.recipes (id, business_id, product_id)
      values (pg_temp.id('recipe A'), pg_temp.id('biz A'), pg_temp.id('latte A')) $$),
    ('user A', 'biz A', '200 ml of milk in it', $$
      insert into app.recipe_lines (id, business_id, recipe_id, position, material_id, qty, unit, base_qty)
      values (pg_temp.id('line A'), pg_temp.id('biz A'), pg_temp.id('recipe A'), 0, pg_temp.id('mat A'),
              200, 'ml', 200) $$)
  ) as v(who, biz, what, stmt);

-- 3. Isolation (1) ----------------------------------------------------------------------------

select is(
  pg_temp.api_value('user B', 'biz B', $$
    select (select count(*) from app.recipes) || '/' || (select count(*) from app.recipe_lines) $$),
  '0/0',
  'user B in business B sees none of A''s recipes and lines'
);

-- 4. No link across businesses or materials (4) ----------------------------------------------

select is(
  pg_temp.state_of(pg_temp.api_exec('user B', 'biz B', v.stmt)),
  v.state,
  v.what
)
  from (values
    ($$ insert into app.recipes (id, business_id, product_id)
       values (pg_temp.id('recipe B x'), pg_temp.id('biz B'), pg_temp.id('latte A')) $$,
     '23503', 'a recipe of another business''s product is refused (composite FK)'),
    ($$ with r as (
         insert into app.recipes (id, business_id, product_id)
         values (pg_temp.id('recipe B'), pg_temp.id('biz B'), pg_temp.id('latte B')) returning id)
       insert into app.recipe_lines (id, business_id, recipe_id, position, material_id, qty, unit, base_qty)
       select pg_temp.id('line B x'), pg_temp.id('biz B'), r.id, 0, pg_temp.id('mat A'), 1, 'l', 1000
         from r $$,
     '23503', 'a line of another business''s material is refused (composite FK)'),
    ($$ insert into app.recipe_lines (id, business_id, recipe_id, position, material_id, qty, unit, base_qty)
       values (pg_temp.id('line B y'), pg_temp.id('biz B'), pg_temp.id('recipe A'), 0, pg_temp.id('mat B'),
               1, 'l', 1000) $$,
     '23503', 'a line in another business''s recipe is refused (composite FK)')
  ) as v(stmt, state, what);

select is(
  pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', $$
    insert into app.recipe_lines (id, business_id, recipe_id, position, material_id, qty, pack_id, base_qty)
    values (pg_temp.id('line A x'), pg_temp.id('biz A'), pg_temp.id('recipe A'), 1, pg_temp.id('beans A'),
            1, pg_temp.id('carton A'), 12000) $$)),
  '23503',
  'a line in a pack of another material is refused (the pack FK names the line''s material)'
);

-- 5. A line's shape and one line per material (4) --------------------------------------------

select is(
  pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', v.stmt)),
  v.state,
  v.what
)
  from (values
    ($$ insert into app.recipe_lines (id, business_id, recipe_id, position, material_id, qty, unit, pack_id,
                                      base_qty)
       values (pg_temp.id('line s1'), pg_temp.id('biz A'), pg_temp.id('recipe A'), 1, pg_temp.id('mat A'),
               1, 'l', pg_temp.id('carton A'), 1000) $$,
     '23514', 'a line in a unit and a pack at once is refused'),
    ($$ insert into app.recipe_lines (id, business_id, recipe_id, position, material_id, qty, unit, base_qty)
       values (pg_temp.id('line s2'), pg_temp.id('biz A'), pg_temp.id('recipe A'), 1, pg_temp.id('beans A'),
               0, 'g', 0) $$,
     '23514', 'a line of zero is refused'),
    ($$ insert into app.recipe_lines (id, business_id, recipe_id, position, material_id, qty, unit, base_qty)
       values (pg_temp.id('line s3'), pg_temp.id('biz A'), pg_temp.id('recipe A'), 1, pg_temp.id('beans A'),
               1, 'cup', 1) $$,
     '23514', 'a line in a unit that is not a standard unit is refused'),
    ($$ insert into app.recipe_lines (id, business_id, recipe_id, position, material_id, qty, unit, base_qty)
       values (pg_temp.id('line s4'), pg_temp.id('biz A'), pg_temp.id('recipe A'), 1, pg_temp.id('mat A'),
               1, 'l', 1000) $$,
     '23505', 'a second live line of the same material is refused (recipe_lines_material_key)')
  ) as v(stmt, state, what);

-- 6. Items bought ready to sell (4) --------------------------------------------------------------

select is(
  pg_temp.api_exec('user A', 'biz A', $$
    with m as (
      insert into app.materials (id, business_id, name, dimension, unit)
      values (pg_temp.id('water A'), pg_temp.id('biz A'), 'Water', 'count', 'piece') returning id)
    insert into app.products_services (id, business_id, name, type, unit, resale_material_id)
    select pg_temp.id('water product A'), pg_temp.id('biz A'), 'Water', 'product', 'piece', m.id
      from m $$),
  'ok 1',
  'a product bought ready to sell names its material'
);

select is(
  pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', v.stmt)),
  v.state,
  v.what
)
  from (values
    ($$ insert into app.products_services (id, business_id, name, type, unit, resale_material_id)
       values (pg_temp.id('water 2'), pg_temp.id('biz A'), 'Water 2', 'product', 'piece',
               pg_temp.id('water A')) $$,
     '23505', 'one product per material bought ready to sell'),
    ($$ insert into app.products_services (id, business_id, name, type, unit, resale_material_id)
       values (pg_temp.id('wash'), pg_temp.id('biz A'), 'Wash', 'service', 'h', pg_temp.id('beans A')) $$,
     '23514', 'a service is never bought ready to sell'),
    ($$ update app.products_services set resale_material_id = pg_temp.id('beans A')
        where id = pg_temp.id('water product A') $$,
     '23514', 'an item bought ready to sell keeps its material (keep_resale_link)')
  ) as v(stmt, state, what);

-- 7. A material a recipe uses keeps its kind of measure (1) --------------------------------------

select is(
  pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', $$
    update app.materials set dimension = 'mass', unit = 'kg' where id = pg_temp.id('mat A') $$)),
  'BZ423',
  'a material a live recipe line names keeps its kind of measure (keep_dimension)'
);

-- 8. The audit trigger (1) -----------------------------------------------------------------------

select is(
  (select string_agg(e.entity, ',' order by e.entity collate "C")
     from (select distinct entity
             from app.audit_log
            where business_id = pg_temp.id('biz A')
              and actor_user_id = pg_temp.id('user A')
              and entity in ('recipes', 'recipe_lines')) as e),
  'recipe_lines,recipes',
  'writes of the recipe tables are in the audit log, with their actor'
);

select * from finish();
rollback;

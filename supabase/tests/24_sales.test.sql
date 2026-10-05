-- pgTAP: Today's sales and One sale (M3 Step 2; migrations sales_tables and sales_security; D-219,
-- D-222, D-225–D-232). As bizcost_api, like the API:
--   - the four tables are isolated between businesses and link only within one (composite foreign
--     keys: a sale's location, channel and copy; a line's sale and product; a material row's line, sale
--     and material);
--   - their CHECKs: value lists, a sheet for several days within one month, delivery's fields only with
--     delivery, quantities never 0, VAT category and rate together, the cost columns unbounded with a
--     scale of at most 12 (6 for a base quantity), a material's price all or nothing;
--   - one live day sheet per member × days × channel × location; a reversed or discarded one frees it;
--   - a posted sale is never edited: it only becomes reversed (its reversal columns), and its delivery
--     cost is filled once; its lines and materials take only their fill-once costs, each while null;
--     nothing is deleted, no line or material row is added to it;
--   - the books-closed date: no sale posted, written already posted or reversed on or before it; a
--     fill-once cost is not a posting (allowed in a closed month);
--   - touch and audit triggers.
-- The starter channels of the businesses that existed are run on their own fixtures by
-- packages/db/test/sales-channels.db.test.ts (it executes the migration's own statement).
begin;
select plan(79);

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

-- Runs p_sql as bizcost_api with the given user/business (fixture names): 'ok <row count>', or the
-- first column of the first row (p_scalar), or 'ERROR <sqlstate>: <message>'.
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

create function pg_temp.state_of(p_result text)
returns text language sql immutable
as $$ select case when p_result like 'ERROR %' then substr(p_result, 7, 5) else p_result end $$;

-- A sale of A on 20 January 2026 (columns given as SQL), in A's shop channel at A's location. The
-- database never checks a sale's day against today (the API does), so the days here are fixed.
create function pg_temp.sale_sql(p_id text, p_extra_columns text, p_extra_values text,
                                 p_source text default 'single')
returns text language sql immutable
as $$
  select format($f$
    insert into app.sales (id, business_id, source, business_date, location_id, channel_id,
                           currency %s)
    values (pg_temp.id(%L), pg_temp.id('biz A'), %L, date '2026-01-20', pg_temp.id('loc A'),
            pg_temp.id('chan A'), 'AED' %s) $f$,
    p_extra_columns, p_id, p_source, p_extra_values)
$$;

insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', pg_temp.id('user A'), 'authenticated',
        'authenticated', 'amal-sales@example.test', now(), '{}', '{}', now(), now()),
       ('00000000-0000-0000-0000-000000000000', pg_temp.id('user B'), 'authenticated',
        'authenticated', 'badr-sales@example.test', now(), '{}', '{}', now(), now());

-- 1. Columns (6) --------------------------------------------------------------------------------

select col_type_is('app', 'sale_lines', 'cost', 'numeric',
                   'a line''s cost is unbounded numeric (no hidden cost makes a posting fail, D-209)');
select col_type_is('app', 'sale_line_materials', 'cost', 'numeric',
                   'a material''s cost is unbounded numeric');
select col_type_is('app', 'sale_line_materials', 'base_qty', 'numeric',
                   'what a line used is unbounded numeric too (a recipe the caller may not see)');
select col_type_is('app', 'sales_channels', 'fee_percent', 'numeric(9,6)',
                   'a channel''s commission is a rate');
select col_type_is('app', 'sales', 'delivery_cost', 'numeric(20,4)',
                   'a delivery''s cost is a money amount');
select has_index('app', 'sales', 'sales_day_sheet_key',
                 'one live day sheet per member × days × channel × location');

-- 2. Fixtures (15) ------------------------------------------------------------------------------

select is(
  pg_temp.api_value(v.u, null, format($f$
    select app.create_business(pg_temp.id(%L), %L, 'en', 'Owner',
                               pg_temp.id(%L), pg_temp.id(%L)) $f$,
    v.b, v.name, v.b || ' owner role', v.b || ' owner member')),
  pg_temp.id(v.b)::text,
  'setup: ' || v.u || ' creates ' || v.b
)
  from (values ('user A', 'biz A', 'Alpha Cafe'), ('user B', 'biz B', 'Beta Cafe')) as v(u, b, name);

select is(pg_temp.api_exec(v.u, v.b, v.stmt), 'ok 1', 'setup: ' || v.what)
  from (values
    ('user A', 'biz A', 'a location of A', $$
      insert into app.locations (id, business_id, name, is_default)
      values (pg_temp.id('loc A'), pg_temp.id('biz A'), 'Main', true) $$),
    ('user A', 'biz A', 'a channel of A', $$
      insert into app.sales_channels (id, business_id, name, kind, fee_percent)
      values (pg_temp.id('chan A'), pg_temp.id('biz A'), 'Shop', 'shop', null) $$),
    ('user A', 'biz A', 'a product of A', $$
      insert into app.products_services (id, business_id, name, type, unit, default_price)
      values (pg_temp.id('latte A'), pg_temp.id('biz A'), 'Latte', 'product', 'piece', 18) $$),
    ('user A', 'biz A', 'a material of A', $$
      insert into app.materials (id, business_id, name, dimension, unit)
      values (pg_temp.id('milk A'), pg_temp.id('biz A'), 'Milk', 'volume', 'l') $$),
    ('user B', 'biz B', 'a location of B', $$
      insert into app.locations (id, business_id, name, is_default)
      values (pg_temp.id('loc B'), pg_temp.id('biz B'), 'Main', true) $$),
    ('user B', 'biz B', 'a channel of B', $$
      insert into app.sales_channels (id, business_id, name, kind)
      values (pg_temp.id('chan B'), pg_temp.id('biz B'), 'Shop', 'shop') $$),
    ('user B', 'biz B', 'a product of B', $$
      insert into app.products_services (id, business_id, name, type, unit)
      values (pg_temp.id('latte B'), pg_temp.id('biz B'), 'Latte', 'product', 'piece') $$),
    ('user B', 'biz B', 'a material of B', $$
      insert into app.materials (id, business_id, name, dimension, unit)
      values (pg_temp.id('milk B'), pg_temp.id('biz B'), 'Milk', 'volume', 'l') $$),
    ('user A', 'biz A', 'a draft sale of A with a delivery', pg_temp.sale_sql('sale A',
      ', delivery_needed, delivery_area', ', true, ''Marina''')),
    ('user A', 'biz A', 'a line of it', $$
      insert into app.sale_lines (id, business_id, sale_id, position, kind, product_id, description,
                                  qty, unit, unit_price)
      values (pg_temp.id('line A'), pg_temp.id('biz A'), pg_temp.id('sale A'), 0, 'item',
              pg_temp.id('latte A'), 'Latte', 2, 'piece', 18) $$),
    ('user A', 'biz A', 'two more drafts of A', pg_temp.sale_sql('c1', '', '')),
    ('user A', 'biz A', 'two more drafts of A', pg_temp.sale_sql('x chan', '', '')),
    ('user B', 'biz B', 'a draft sale of B', $$
      insert into app.sales (id, business_id, source, business_date, location_id, channel_id,
                             currency)
      values (pg_temp.id('sale B'), pg_temp.id('biz B'), 'single', date '2026-01-20',
              pg_temp.id('loc B'), pg_temp.id('chan B'), 'AED') $$)
  ) as v(u, b, what, stmt);

-- 3. Isolation and links (8) --------------------------------------------------------------------

select is(
  pg_temp.api_value('user B', 'biz B', $$
    select (select count(*) from app.sales where business_id = pg_temp.id('biz A'))
         + (select count(*) from app.sale_lines where business_id = pg_temp.id('biz A'))
         + (select count(*) from app.sales_channels where business_id = pg_temp.id('biz A')) $$),
  '0',
  'B sees none of A''s sales, lines or channels (RLS)'
);

select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', v.stmt)), '23503', v.what)
  from (values
    ('a sale never names another business''s channel', $$
      update app.sales set channel_id = pg_temp.id('chan B') where id = pg_temp.id('x chan') $$),
    ('nor its location', $$
      update app.sales set location_id = pg_temp.id('loc B') where id = pg_temp.id('sale A') $$),
    ('nor copies another business''s sale', $$
      update app.sales set copied_from_id = pg_temp.id('sale B') where id = pg_temp.id('sale A') $$),
    ('a line never names another business''s product', $$
      insert into app.sale_lines (id, business_id, sale_id, position, kind, product_id, qty, unit_price)
      values (pg_temp.id('x line'), pg_temp.id('biz A'), pg_temp.id('sale A'), 1, 'item',
              pg_temp.id('latte B'), 1, 1) $$),
    ('a material row never names another business''s material', $$
      insert into app.sale_line_materials (id, business_id, sale_id, sale_line_id, material_id,
                                           base_qty)
      values (pg_temp.id('x mat'), pg_temp.id('biz A'), pg_temp.id('sale A'), pg_temp.id('line A'),
              pg_temp.id('milk B'), 200) $$),
    ('nor a line of another sale', $$
      insert into app.sale_line_materials (id, business_id, sale_id, sale_line_id, material_id,
                                           base_qty)
      values (pg_temp.id('x mat 2'), pg_temp.id('biz A'), pg_temp.id('x chan'),
              pg_temp.id('line A'), pg_temp.id('milk A'), 200) $$),
    ('a sale''s business is the context''s (composite keys from B''s ids)', $$
      insert into app.sale_lines (id, business_id, sale_id, position, kind, product_id, qty, unit_price)
      values (pg_temp.id('x line 2'), pg_temp.id('biz A'), pg_temp.id('sale B'), 0, 'item',
              pg_temp.id('latte A'), 1, 1) $$)
  ) as v(what, stmt);

-- 4. CHECKs (16) --------------------------------------------------------------------------------

select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', v.stmt)), v.state, v.what)
  from (values
    ('23514', 'a source from the list', $$
      update app.sales set source = 'import' where id = pg_temp.id('c1') $$),
    ('23514', 'a status from the list', $$
      update app.sales set status = 'open' where id = pg_temp.id('c1') $$),
    ('23514', 'a sheet for several days is a day sheet', $$
      update app.sales set period_from = business_date - 1 where id = pg_temp.id('c1') $$),
    ('23514', 'within one month', pg_temp.sale_sql('c2', ', period_from',
      ', date ''2025-12-31''', 'day_sheet')),
    ('23514', 'delivery''s area only with delivery', $$
      update app.sales set delivery_area = 'JLT' where id = pg_temp.id('c1') $$),
    ('23514', 'delivery''s cost only with delivery, never negative', $$
      update app.sales set delivery_needed = true, delivery_cost = -1 where id = pg_temp.id('c1') $$),
    ('23514', 'a channel kind from the list', $$
      update app.sales_channels set kind = 'telepathy' where id = pg_temp.id('chan A') $$),
    ('23514', 'a commission from 0 to 100', $$
      update app.sales_channels set fee_percent = 101 where id = pg_temp.id('chan A') $$),
    ('23514', 'a sold quantity is never 0', $$
      update app.sale_lines set qty = 0 where id = pg_temp.id('line A') $$),
    ('23514', 'an item names its product', $$
      update app.sale_lines set product_id = null where id = pg_temp.id('line A') $$),
    ('23514', 'a VAT category goes with its rate', $$
      update app.sale_lines set vat_category = 'standard' where id = pg_temp.id('line A') $$),
    ('23514', 'a delivery line is 1, without a unit or discount', $$
      update app.sale_lines set kind = 'delivery', product_id = null where id = pg_temp.id('line A') $$),
    ('23514', 'a cost has at most 12 decimals', $$
      update app.sale_lines set cost_basis = 'recipe', cost = 1.0000000000001
       where id = pg_temp.id('line A') $$),
    ('23514', 'a cost has its basis', $$
      update app.sale_lines set cost = 1 where id = pg_temp.id('line A') $$),
    ('23514', 'a material''s price is all or nothing', $$
      insert into app.sale_line_materials (id, business_id, sale_id, sale_line_id, material_id,
                                           base_qty, cost)
      values (pg_temp.id('c mat'), pg_temp.id('biz A'), pg_temp.id('sale A'), pg_temp.id('line A'),
              pg_temp.id('milk A'), 200, 1.2) $$),
    ('23514', 'what a line used has at most 6 decimals', $$
      insert into app.sale_line_materials (id, business_id, sale_id, sale_line_id, material_id,
                                           base_qty)
      values (pg_temp.id('c mat 2'), pg_temp.id('biz A'), pg_temp.id('sale A'),
              pg_temp.id('line A'), pg_temp.id('milk A'), 0.0000001) $$)
  ) as v(state, what, stmt);

-- 5. One live sheet per member × days × channel × location (5) -----------------------------------

select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', v.stmt)), v.state, v.what)
  from (values
    (1, 'ok 1', 'a day sheet', pg_temp.sale_sql('sheet 1', '', '', 'day_sheet')),
    (2, '23505', 'a second live sheet of the member for the same day, channel and location',
     pg_temp.sale_sql('sheet 2', '', '', 'day_sheet')),
    (3, 'ok 1', 'a sheet for several days ending that day is another', pg_temp.sale_sql('sheet 3',
      ', period_from', ', date ''2026-01-01''', 'day_sheet')),
    (4, 'ok 1', 'setup: the first sheet is discarded', $$
      update app.sales set deleted_at = now() where id = pg_temp.id('sheet 1') $$),
    (5, 'ok 1', 'a discarded sheet frees its key', pg_temp.sale_sql('sheet 2', '', '',
      'day_sheet'))
  ) as v(n, state, what, stmt)
 order by v.n;

-- 6. A posted sale is never edited, but its costs are filled once (16) ---------------------------

select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', v.stmt)), v.state, v.what)
  from (values
    (1, 'ok 1', 'a draft changes', $$
      update app.sales set notes = 'by the window' where id = pg_temp.id('sale A') $$),
    (2, 'ok 1', 'posting writes the line''s snapshot while the sale is a draft', $$
      update app.sale_lines set cost_basis = 'recipe', time_minutes = 30
       where id = pg_temp.id('line A') $$),
    (3, 'ok 1', 'and its materials, still without a price', $$
      insert into app.sale_line_materials (id, business_id, sale_id, sale_line_id, material_id,
                                           base_qty)
      values (pg_temp.id('mat A'), pg_temp.id('biz A'), pg_temp.id('sale A'), pg_temp.id('line A'),
              pg_temp.id('milk A'), 400) $$),
    (4, 'ok 1', 'then the sale is posted', $$
      update app.sales set status = 'posted', posted_at = now(), posted_by = pg_temp.id('user A'),
                           vat_registered = false
       where id = pg_temp.id('sale A') $$),
    (5, '23001', 'a posted sale is never edited', $$
      update app.sales set notes = 'changed' where id = pg_temp.id('sale A') $$),
    (6, '23001', 'nor deleted', $$ delete from app.sales where id = pg_temp.id('sale A') $$),
    (7, '23001', 'its lines never change', $$
      update app.sale_lines set qty = 3 where id = pg_temp.id('line A') $$),
    (8, '23001', 'no line is added to it', $$
      insert into app.sale_lines (id, business_id, sale_id, position, kind, product_id, qty, unit_price)
      values (pg_temp.id('late line'), pg_temp.id('biz A'), pg_temp.id('sale A'), 1, 'item',
              pg_temp.id('latte A'), 1, 1) $$),
    (9, '23001', 'nor a material row', $$
      insert into app.sale_line_materials (id, business_id, sale_id, sale_line_id, material_id,
                                           base_qty)
      values (pg_temp.id('late mat'), pg_temp.id('biz A'), pg_temp.id('sale A'),
              pg_temp.id('line A'), pg_temp.id('latte A'), 1) $$),
    (10, 'ok 1', 'a material without a price takes one, once (the first purchase that prices it)', $$
      update app.sale_line_materials set unit_cost = 0.006, cost = 2.4, basis = 'first_purchase'
       where id = pg_temp.id('mat A') $$),
    (11, '23001', 'and never changes after', $$
      update app.sale_line_materials set unit_cost = 0.007, cost = 2.8
       where id = pg_temp.id('mat A') $$),
    (12, '23001', 'nor does what it used', $$
      update app.sale_line_materials set base_qty = 1 where id = pg_temp.id('mat A') $$),
    (13, 'ok 1', 'the line''s cost follows, once', $$
      update app.sale_lines set cost = 2.4 where id = pg_temp.id('line A') $$),
    (14, 'ok 1', 'and the owner''s time once the rate is set', $$
      update app.sale_lines set time_cost = 20 where id = pg_temp.id('line A') $$),
    (15, '23001', 'neither changes after', $$
      update app.sale_lines set cost = 3, time_cost = 25 where id = pg_temp.id('line A') $$),
    (16, 'ok 1', 'the delivery cost is filled once', $$
      update app.sales set delivery_cost = 25 where id = pg_temp.id('sale A') $$)
  ) as v(n, state, what, stmt)
 order by v.n;

-- 7. Its reversal, and the books-closed date (9) ------------------------------------------------

select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', v.stmt)), v.state, v.what)
  from (values
    (1, '23001', 'the delivery cost never changes once set', $$
      update app.sales set delivery_cost = 30 where id = pg_temp.id('sale A') $$),
    (2, '23514', 'a draft is never reversed', $$
      update app.sales set status = 'reversed', reversed_at = now(),
                           reversed_by = pg_temp.id('user A'), reversal_business_date = current_date
       where id = pg_temp.id('c1') $$),
    (3, 'ok 1', 'setup: the books closed up to the sales'' day', $$
      update app.businesses set books_closed_through = date '2026-01-20'
       where id = pg_temp.id('biz A') $$),
    (4, 'BZ412', 'a draft dated in closed books is not posted', $$
      update app.sales set status = 'posted', posted_at = now(), posted_by = pg_temp.id('user A')
       where id = pg_temp.id('c1') $$),
    (5, 'BZ412', 'nor written already posted', pg_temp.sale_sql('closed 1',
      ', status, posted_at, posted_by', ', ''posted'', now(), pg_temp.id(''user A'')')),
    (6, 'BZ412', 'a closed day''s sale is not reversed on a closed day', $$
      update app.sales set status = 'reversed', reversed_at = now(),
                           reversed_by = pg_temp.id('user A'),
                           reversal_business_date = date '2026-01-20'
       where id = pg_temp.id('sale A') $$),
    (7, 'ok 1', 'it is reversed on the first open day', $$
      update app.sales set status = 'reversed', reversed_at = now(),
                           reversed_by = pg_temp.id('user A'),
                           reversal_business_date = date '2026-01-21'
       where id = pg_temp.id('sale A') $$),
    (8, '23001', 'a reversed sale only keeps its reversal', $$
      update app.sales set notes = 'after' where id = pg_temp.id('sale A') $$),
    (9, 'ok 1', 'setup: the books opened again', $$
      update app.businesses set books_closed_through = null where id = pg_temp.id('biz A') $$)
  ) as v(n, state, what, stmt)
 order by v.n;

-- 8. A fill is not a posting: also in a closed month (2) ----------------------------------------

select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', v.stmt)), 'ok 1', v.what)
  from (values
    (1, 'setup: a posted sale with delivery, without its cost, on the sales'' day', pg_temp.sale_sql(
      'filled', ', status, posted_at, posted_by, delivery_needed',
      ', ''posted'', now(), pg_temp.id(''user A''), true')),
    (2, 'its delivery cost is filled with the books closed on its day', $$
      with closed as (
        update app.businesses set books_closed_through = date '2026-01-21'
         where id = pg_temp.id('biz A') returning id)
      update app.sales set delivery_cost = 12 where id = pg_temp.id('filled')
         and exists (select 1 from closed) $$)
  ) as v(n, what, stmt)
 order by v.n;

-- 9. Touch and audit (2) ------------------------------------------------------------------------

select is(
  pg_temp.api_value('user A', 'biz A', $$
    select version::text from app.sales where id = pg_temp.id('sale A') $$),
  '5',
  'every change of a sale bumps its version (touch_row): saved, posted, filled, reversed'
);

select is(
  (select string_agg(action, ',' order by created_at, id) from app.audit_log
    where business_id = pg_temp.id('biz A') and entity = 'sale_line_materials'
      and entity_id = pg_temp.id('mat A')),
  'insert,update',
  'a material row''s snapshot and its fill are in the audit log'
);

select * from finish();
rollback;

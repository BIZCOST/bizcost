-- pgTAP: the first count, counts and stock on hand (M4 Step 2; migrations stock_counts_tables and
-- stock_counts_security; D-339, D-340). As bizcost_api, like the API:
--   - stock_counts and stock_count_lines are isolated between businesses and link only within one
--     (composite foreign keys: a count's branch; a line's count, branch and material; a movement's
--     count line);
--   - their CHECKs: value lists, a first count without a branch and a count with one, a note's length,
--     what was typed (1 to 10 parts) with what it comes to, who counted it and when, all or nothing,
--     never below zero, the results of finalizing together and difference = counted − book;
--   - a material once per branch in a count; a line taken out frees its place; a count's lines are all
--     in its branch;
--   - the ledger rows of a count: their shapes (an opening's value never below zero, a count's value
--     signed as its quantity, both naming their line), one per line, its line's material in its line's
--     branch, written while finalizing (an opening or count row) or while posted (a reversal);
--   - a posted count is never edited: it only becomes reversed (its reversal columns); its lines never
--     change, none is added or deleted; a draft is never reversed;
--   - a material is tracked from the day of a posted first count that has a line of it, once, and only
--     while that count stands;
--   - the books-closed date: no count finalized, written already posted, or reversed on or before it;
--   - touch and audit triggers.
begin;
select plan(82);

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

-- A movement of A on 20 January 2026 naming a count line (its milk in its main branch unless given;
-- more columns given as SQL).
create function pg_temp.movement_sql(p_id text, p_kind text, p_line text, p_qty text, p_value text,
                                     p_material text default 'milk A', p_location text default 'loc A',
                                     p_extra_columns text default '', p_extra_values text default '')
returns text language sql immutable
as $$
  select format($f$
    insert into app.stock_movements (id, business_id, business_date, location_id, material_id, kind,
                                     qty, value, count_line_id %s)
    values (pg_temp.id(%L), pg_temp.id('biz A'), date '2026-01-20', pg_temp.id(%L),
            pg_temp.id(%L), %L, %s, %s, pg_temp.id(%L) %s) $f$,
    p_extra_columns, p_id, p_location, p_material, p_kind, p_qty, p_value, p_line, p_extra_values)
$$;

insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', pg_temp.id('user A'), 'authenticated',
        'authenticated', 'amal-counts@example.test', now(), '{}', '{}', now(), now()),
       ('00000000-0000-0000-0000-000000000000', pg_temp.id('user B'), 'authenticated',
        'authenticated', 'badr-counts@example.test', now(), '{}', '{}', now(), now());

-- 1. Columns (5) --------------------------------------------------------------------------------

select col_type_is('app', 'materials', 'stock_tracked_from', 'date',
                   'a material is tracked from a business day (its first count''s)');
select col_type_is('app', 'stock_count_lines', 'counted_base_qty', 'numeric(24,6)',
                   'a counted line is a stock quantity');
select col_type_is('app', 'stock_count_lines', 'difference_value', 'numeric(28,12)',
                   'a difference''s value is a cost-engine amount');
select has_index('app', 'stock_count_lines', 'stock_count_lines_count_location_material_key',
                 'a material once per branch in a count');
select has_index('app', 'stock_movements', 'stock_movements_count_line_key',
                 'each count line posts once');

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
    (1, 'user A', 'biz A', 'A''s main branch', $$
      insert into app.locations (id, business_id, name, is_default)
      values (pg_temp.id('loc A'), pg_temp.id('biz A'), 'Main', true) $$),
    (2, 'user A', 'biz A', 'A''s second branch', $$
      insert into app.locations (id, business_id, name, is_default)
      values (pg_temp.id('loc A2'), pg_temp.id('biz A'), 'Marina', false) $$),
    (3, 'user A', 'biz A', 'A''s milk', $$
      insert into app.materials (id, business_id, name, dimension, unit)
      values (pg_temp.id('milk A'), pg_temp.id('biz A'), 'Milk', 'volume', 'l') $$),
    (4, 'user A', 'biz A', 'A''s sugar', $$
      insert into app.materials (id, business_id, name, dimension, unit)
      values (pg_temp.id('sugar A'), pg_temp.id('biz A'), 'Sugar', 'mass', 'kg') $$),
    (5, 'user B', 'biz B', 'B''s branch', $$
      insert into app.locations (id, business_id, name, is_default)
      values (pg_temp.id('loc B'), pg_temp.id('biz B'), 'Main', true) $$),
    (6, 'user B', 'biz B', 'B''s milk', $$
      insert into app.materials (id, business_id, name, dimension, unit)
      values (pg_temp.id('milk B'), pg_temp.id('biz B'), 'Milk', 'volume', 'l') $$),
    (7, 'user A', 'biz A', 'A''s first count of its milk, on 20 January', $$
      insert into app.stock_counts (id, business_id, kind, business_date)
      values (pg_temp.id('open A'), pg_temp.id('biz A'), 'opening', date '2026-01-20') $$),
    (8, 'user A', 'biz A', 'its line in the main branch', $$
      insert into app.stock_count_lines (id, business_id, count_id, location_id, material_id)
      values (pg_temp.id('line A1'), pg_temp.id('biz A'), pg_temp.id('open A'), pg_temp.id('loc A'),
              pg_temp.id('milk A')) $$),
    (9, 'user A', 'biz A', 'and at Marina', $$
      insert into app.stock_count_lines (id, business_id, count_id, location_id, material_id)
      values (pg_temp.id('line A2'), pg_temp.id('biz A'), pg_temp.id('open A'), pg_temp.id('loc A2'),
              pg_temp.id('milk A')) $$),
    (10, 'user A', 'biz A', 'a later count of the main branch', $$
      insert into app.stock_counts (id, business_id, kind, location_id, business_date)
      values (pg_temp.id('count A'), pg_temp.id('biz A'), 'count', pg_temp.id('loc A'),
              date '2026-01-25') $$),
    (11, 'user A', 'biz A', 'its line of the milk', $$
      insert into app.stock_count_lines (id, business_id, count_id, location_id, material_id)
      values (pg_temp.id('line C'), pg_temp.id('biz A'), pg_temp.id('count A'), pg_temp.id('loc A'),
              pg_temp.id('milk A')) $$),
    (12, 'user B', 'biz B', 'B''s first count', $$
      insert into app.stock_counts (id, business_id, kind, business_date)
      values (pg_temp.id('open B'), pg_temp.id('biz B'), 'opening', date '2026-01-20') $$),
    (13, 'user B', 'biz B', 'its line', $$
      insert into app.stock_count_lines (id, business_id, count_id, location_id, material_id)
      values (pg_temp.id('line B'), pg_temp.id('biz B'), pg_temp.id('open B'), pg_temp.id('loc B'),
              pg_temp.id('milk B')) $$)
  ) as v(n, u, b, what, stmt)
 order by v.n;

-- 3. Isolation and links (6) --------------------------------------------------------------------

select is(
  pg_temp.api_value('user B', 'biz B', $$
    select (select count(*) from app.stock_counts where business_id = pg_temp.id('biz A'))
         + (select count(*) from app.stock_count_lines where business_id = pg_temp.id('biz A')) $$),
  '0',
  'B sees none of A''s counts or their lines (RLS)'
);

select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', v.stmt)), '23503', v.what)
  from (values
    -- Written, not changed: a count never changes its branch (stock_counts_guards, test 32).
    ('a count never names another business''s branch', $$
      insert into app.stock_counts (id, business_id, kind, location_id, business_date)
      values (pg_temp.id('x count'), pg_temp.id('biz A'), 'count', pg_temp.id('loc B'),
              date '2026-01-25') $$),
    ('a line never names another business''s material', $$
      insert into app.stock_count_lines (id, business_id, count_id, location_id, material_id)
      values (pg_temp.id('x line 1'), pg_temp.id('biz A'), pg_temp.id('open A'), pg_temp.id('loc A'),
              pg_temp.id('milk B')) $$),
    ('nor its branch', $$
      insert into app.stock_count_lines (id, business_id, count_id, location_id, material_id)
      values (pg_temp.id('x line 2'), pg_temp.id('biz A'), pg_temp.id('open A'), pg_temp.id('loc B'),
              pg_temp.id('sugar A')) $$),
    ('nor a count of another business (composite keys from B''s ids)', $$
      insert into app.stock_count_lines (id, business_id, count_id, location_id, material_id)
      values (pg_temp.id('x line 3'), pg_temp.id('biz A'), pg_temp.id('open B'), pg_temp.id('loc A'),
              pg_temp.id('sugar A')) $$),
    ('a movement never names another business''s count line', pg_temp.movement_sql(
      'x move', 'opening', 'line B', '1', '0'))
  ) as v(what, stmt);

-- 4. CHECKs (13) --------------------------------------------------------------------------------

select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', v.stmt)), '23514', v.what)
  from (values
    ('a kind from the list', $$
      update app.stock_counts set kind = 'audit' where id = pg_temp.id('count A') $$),
    ('a first count covers every branch: no branch of its own', $$
      update app.stock_counts set location_id = pg_temp.id('loc A') where id = pg_temp.id('open A') $$),
    ('a count is of one branch', $$
      update app.stock_counts set location_id = null where id = pg_temp.id('count A') $$),
    ('a status from the list', $$
      update app.stock_counts set status = 'final' where id = pg_temp.id('count A') $$),
    ('a note of at most 500 characters', $$
      update app.stock_counts set note = repeat('n', 501) where id = pg_temp.id('count A') $$),
    ('what was typed comes with what it comes to, who counted it and when', $$
      update app.stock_count_lines set parts = '[{"qty":"40","unit":"l"}]'
       where id = pg_temp.id('line C') $$),
    ('what was typed is a list', $$
      update app.stock_count_lines set parts = '{"qty":"40"}', counted_base_qty = 40000,
                                       counted_by = pg_temp.id('user A'), counted_at = now()
       where id = pg_temp.id('line C') $$),
    ('of at most 10 parts', $$
      update app.stock_count_lines
         set parts = (select jsonb_agg(jsonb_build_object('qty', '1', 'unit', 'l'))
                        from generate_series(1, 11)),
             counted_base_qty = 11000, counted_by = pg_temp.id('user A'), counted_at = now()
       where id = pg_temp.id('line C') $$),
    ('a counted line is never below zero', $$
      update app.stock_count_lines set parts = '[{"qty":"1","unit":"l"}]', counted_base_qty = -1,
                                       counted_by = pg_temp.id('user A'), counted_at = now()
       where id = pg_temp.id('line C') $$),
    ('a result needs a counted line', $$
      update app.stock_count_lines set book_base_qty = 0, difference_qty = 0, difference_value = 0
       where id = pg_temp.id('line C') $$),
    ('a finalized count''s results go together', $$
      update app.stock_count_lines set parts = '[{"qty":"40","unit":"l"}]', counted_base_qty = 40000,
                                       counted_by = pg_temp.id('user A'), counted_at = now(),
                                       book_base_qty = 0
       where id = pg_temp.id('line C') $$),
    ('the difference is counted − book', $$
      update app.stock_count_lines set parts = '[{"qty":"40","unit":"l"}]', counted_base_qty = 40000,
                                       counted_by = pg_temp.id('user A'), counted_at = now(),
                                       book_base_qty = 100, difference_qty = 40000,
                                       difference_value = 0
       where id = pg_temp.id('line C') $$),
    ('a count''s lines are in its branch', $$
      insert into app.stock_count_lines (id, business_id, count_id, location_id, material_id)
      values (pg_temp.id('x line 4'), pg_temp.id('biz A'), pg_temp.id('count A'),
              pg_temp.id('loc A2'), pg_temp.id('sugar A')) $$)
  ) as v(what, stmt);

-- 5. A material once per branch in a count (6) --------------------------------------------------

select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', v.stmt)), v.state, v.what)
  from (values
    (1, '23505', 'a second line of the milk in the main branch', $$
      insert into app.stock_count_lines (id, business_id, count_id, location_id, material_id)
      values (pg_temp.id('dup line'), pg_temp.id('biz A'), pg_temp.id('open A'), pg_temp.id('loc A'),
              pg_temp.id('milk A')) $$),
    (2, '23514', 'a line never moves to another material', $$
      update app.stock_count_lines set material_id = pg_temp.id('sugar A')
       where id = pg_temp.id('line A2') $$),
    (3, 'ok 1', 'setup: a sugar line', $$
      insert into app.stock_count_lines (id, business_id, count_id, location_id, material_id)
      values (pg_temp.id('sugar line'), pg_temp.id('biz A'), pg_temp.id('open A'),
              pg_temp.id('loc A'), pg_temp.id('sugar A')) $$),
    (4, 'ok 1', 'setup: taken out (soft-deleted)', $$
      update app.stock_count_lines set deleted_at = now() where id = pg_temp.id('sugar line') $$),
    (5, 'ok 1', 'a line taken out frees its place', $$
      insert into app.stock_count_lines (id, business_id, count_id, location_id, material_id)
      values (pg_temp.id('sugar line 2'), pg_temp.id('biz A'), pg_temp.id('open A'),
              pg_temp.id('loc A'), pg_temp.id('sugar A')) $$),
    (6, 'ok 1', 'setup: and taken out again', $$
      update app.stock_count_lines set deleted_at = now() where id = pg_temp.id('sugar line 2') $$)
  ) as v(n, state, what, stmt)
 order by v.n;

-- 6. A count's ledger rows (10) -----------------------------------------------------------------

select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', v.stmt)), v.state, v.what)
  from (values
    (1, 'ok 1', 'setup: the main branch''s milk counted (40 L)', $$
      update app.stock_count_lines set parts = '[{"qty":"40","unit":"l"}]', counted_base_qty = 40000,
                                       counted_by = pg_temp.id('user A'), counted_at = now()
       where id = pg_temp.id('line A1') $$),
    (2, '23514', 'an opening row names its count line', $$
      insert into app.stock_movements (id, business_id, business_date, location_id, material_id,
                                       kind, qty, value)
      values (pg_temp.id('m 1'), pg_temp.id('biz A'), date '2026-01-20', pg_temp.id('loc A'),
              pg_temp.id('milk A'), 'opening', 40000, 240) $$),
    (3, '23514', 'and is never worth less than nothing',
     pg_temp.movement_sql('m 2', 'opening', 'line A1', '40000', '-1')),
    (4, '23514', 'it is its line''s material', pg_temp.movement_sql('m 3', 'opening', 'line A1',
      '40000', '240', 'sugar A')),
    (5, 'ok 1', 'an opening row of the first count, while it is finalized (still a draft)',
     pg_temp.movement_sql('m open', 'opening', 'line A1', '40000', '240',
                          'milk A', 'loc A', ', adjustment, unit_cost', ', 216, 0.006')),
    (6, '23505', 'a count line posts once', pg_temp.movement_sql('m 4', 'opening', 'line A1',
      '1', '0')),
    (7, '23514', 'a count row is of a count', pg_temp.movement_sql('m 5', 'count', 'line A2',
      '-1', '-0.006', 'milk A', 'loc A2')),
    (8, '23514', 'a count row is a difference, never zero', pg_temp.movement_sql('m 6', 'count',
      'line C', '0', '0')),
    (9, '23514', 'its value signed as its quantity', pg_temp.movement_sql('m 7', 'count', 'line C',
      '-80000', '480')),
    (10, 'ok 1', 'setup: the first count''s results, while it is a draft', $$
      update app.stock_count_lines set book_base_qty = 36000, difference_qty = 4000,
                                       difference_value = 24, unit_cost = 0.006
       where id = pg_temp.id('line A1') $$)
  ) as v(n, state, what, stmt)
 order by v.n;

-- 7. A posted count is never edited (9) ---------------------------------------------------------

select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', v.stmt)), v.state, v.what)
  from (values
    (1, '23514', 'a draft is never reversed', $$
      update app.stock_counts set status = 'reversed', reversed_at = now(),
                                  reversed_by = pg_temp.id('user A'), reversal_date = date '2026-01-20'
       where id = pg_temp.id('count A') $$),
    (2, 'ok 1', 'the first count is finalized', $$
      update app.stock_counts set status = 'posted', posted_at = now(), posted_by = pg_temp.id('user A')
       where id = pg_temp.id('open A') $$),
    (3, '23001', 'a posted count is never edited', $$
      update app.stock_counts set note = 'changed' where id = pg_temp.id('open A') $$),
    (4, '23001', 'nor deleted', $$ delete from app.stock_counts where id = pg_temp.id('open A') $$),
    (5, '23001', 'its lines never change', $$
      update app.stock_count_lines set parts = '[{"qty":"41","unit":"l"}]', counted_base_qty = 41000,
                                       difference_qty = 5000
       where id = pg_temp.id('line A1') $$),
    (6, '23001', 'none is taken out', $$
      update app.stock_count_lines set deleted_at = now() where id = pg_temp.id('line A2') $$),
    (7, '23001', 'none is deleted', $$
      delete from app.stock_count_lines where id = pg_temp.id('line A2') $$),
    (8, '23001', 'none is added', $$
      insert into app.stock_count_lines (id, business_id, count_id, location_id, material_id)
      values (pg_temp.id('late line'), pg_temp.id('biz A'), pg_temp.id('open A'),
              pg_temp.id('loc A2'), pg_temp.id('sugar A')) $$),
    (9, '23514', 'an opening row is written while its count is finalized, never after',
     pg_temp.movement_sql('m 8', 'opening', 'line A2', '0', '0', 'milk A', 'loc A2'))
  ) as v(n, state, what, stmt)
 order by v.n;

-- 8. A material is tracked from its first count, while it stands (5) ----------------------------

select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', v.stmt)), v.state, v.what)
  from (values
    (1, '23514', 'not from another day than its first count''s', $$
      update app.materials set stock_tracked_from = date '2026-01-21' where id = pg_temp.id('milk A') $$),
    (2, '23514', 'not without a first count of it standing', $$
      update app.materials set stock_tracked_from = date '2026-01-20'
       where id = pg_temp.id('sugar A') $$),
    (3, 'ok 1', 'from the day of its first count', $$
      update app.materials set stock_tracked_from = date '2026-01-20' where id = pg_temp.id('milk A') $$),
    (4, '23514', 'once', $$
      update app.materials set stock_tracked_from = date '2026-01-19' where id = pg_temp.id('milk A') $$),
    (5, '23514', 'and never untracked while that count stands', $$
      update app.materials set stock_tracked_from = null where id = pg_temp.id('milk A') $$)
  ) as v(n, state, what, stmt)
 order by v.n;

-- 9. Its reversal, and the books-closed date (11) -----------------------------------------------

select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', v.stmt)), v.state, v.what)
  from (values
    (1, 'ok 1', 'a reversal row of the opening, while the count is posted', pg_temp.movement_sql(
      'm undo', 'reversal', 'line A1', '-40000', '-24', 'milk A', 'loc A', ', reverses_id',
      ', pg_temp.id(''m open'')')),
    (2, '23514', 'a reversal row is in its line''s branch', pg_temp.movement_sql(
      'm 9', 'reversal', 'line A2', '0', '0', 'milk A', 'loc A', ', reverses_id',
      ', pg_temp.id(''m undo'')')),
    (3, 'ok 1', 'setup: the books closed up to the first count''s day', $$
      update app.businesses set books_closed_through = date '2026-01-20'
       where id = pg_temp.id('biz A') $$),
    (4, 'BZ412', 'a closed day''s count is not reversed on a closed day', $$
      update app.stock_counts set status = 'reversed', reversed_at = now(),
                                  reversed_by = pg_temp.id('user A'), reversal_date = date '2026-01-20'
       where id = pg_temp.id('open A') $$),
    (5, 'ok 1', 'it is reversed on the first open day', $$
      update app.stock_counts set status = 'reversed', reversed_at = now(),
                                  reversed_by = pg_temp.id('user A'), reversal_date = date '2026-01-21'
       where id = pg_temp.id('open A') $$),
    (6, '23001', 'a reversed count only keeps its reversal', $$
      update app.stock_counts set note = 'after' where id = pg_temp.id('open A') $$),
    (7, 'ok 1', 'its material is no longer tracked', $$
      update app.materials set stock_tracked_from = null where id = pg_temp.id('milk A') $$),
    (8, 'ok 1', 'setup: a draft count dated in the closed books', $$
      insert into app.stock_counts (id, business_id, kind, location_id, business_date)
      values (pg_temp.id('closed A'), pg_temp.id('biz A'), 'count', pg_temp.id('loc A'),
              date '2026-01-19') $$),
    (9, 'BZ412', 'it is not finalized', $$
      update app.stock_counts set status = 'posted', posted_at = now(), posted_by = pg_temp.id('user A')
       where id = pg_temp.id('closed A') $$),
    (10, 'BZ412', 'nor is a count written already posted on a closed day', $$
      insert into app.stock_counts (id, business_id, kind, location_id, business_date, status,
                                    posted_at, posted_by)
      values (pg_temp.id('closed B'), pg_temp.id('biz A'), 'count', pg_temp.id('loc A'),
              date '2026-01-20', 'posted', now(), pg_temp.id('user A')) $$),
    (11, 'ok 1', 'setup: the books opened again', $$
      update app.businesses set books_closed_through = null where id = pg_temp.id('biz A') $$)
  ) as v(n, state, what, stmt)
 order by v.n;

-- 10. Touch and audit (2) -----------------------------------------------------------------------

select is(
  pg_temp.api_value('user A', 'biz A', $$
    select version::text from app.stock_counts where id = pg_temp.id('open A') $$),
  '3',
  'every change of a count bumps its version (touch_row): finalized, reversed'
);

select is(
  (select string_agg(action, ',' order by created_at, id) from app.audit_log
    where business_id = pg_temp.id('biz A') and entity = 'stock_count_lines'
      and entity_id = pg_temp.id('line A1')),
  'insert,update,update',
  'a line''s count and its result are in the audit log'
);

select * from finish();
rollback;

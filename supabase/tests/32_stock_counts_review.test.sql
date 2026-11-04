-- pgTAP: the database guards of M4 Step 2's review (migration stock_counts_guards). As bizcost_api,
-- like the API. Each was a way around a guard of stock_counts_security, now refused:
--   - a material is never written already tracked (an insert, with no first count);
--   - a count keeps its kind, branch and day, even as a draft (its lines stay where they were);
--   - a count's ledger rows stand only for a count finalized at commit (posted for its own rows,
--     reversed for a reversal row), and a count with ledger rows is never discarded;
--   - a first count that no longer stands leaves no material tracked from it (at commit).
-- The checks made at commit run with pg_temp.api_commit: the statement, then every deferred
-- constraint trigger at once (SET CONSTRAINTS ALL IMMEDIATE), as the transaction's commit would.
begin;
select plan(14);

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
as $$ select md5('review ' || p_name)::uuid $$;
grant execute on function pg_temp.id(text) to bizcost_api;

-- Runs p_sql as bizcost_api in the business; with p_commit, then checks what the commit would check.
create function pg_temp.api_run(p_user text, p_business text, p_sql text, p_commit boolean)
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
    execute p_sql;
    get diagnostics v_rows = row_count;
    if p_commit then
      set constraints all immediate;
      set constraints all deferred;
    end if;
    v_out := 'ok ' || v_rows;
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

create function pg_temp.api_commit(p_user text, p_business text, p_sql text)
returns text language sql
as $$ select pg_temp.api_run(p_user, p_business, p_sql, true) $$;

create function pg_temp.state_of(p_result text)
returns text language sql immutable
as $$ select case when p_result like 'ERROR %' then substr(p_result, 7, 5) else p_result end $$;

insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', pg_temp.id('user R'), 'authenticated',
        'authenticated', 'rana-counts-review@example.test', now(), '{}', '{}', now(), now());

-- Fixtures: a business with two branches, its milk, a draft first count of the milk (one line,
-- counted) and a draft count of the main branch, as the API writes them.
select is(
  (select string_agg(pg_temp.state_of(pg_temp.api_exec('user R', v.b, v.stmt)), ',' order by v.n)
     from (values
       (1, null, $$ select app.create_business(pg_temp.id('biz R'), 'Review Cafe', 'en', 'Owner',
                                               pg_temp.id('owner role'), pg_temp.id('owner member')) $$),
       (2, 'biz R', $$ insert into app.locations (id, business_id, name, is_default)
                       values (pg_temp.id('loc 1'), pg_temp.id('biz R'), 'Main', true) $$),
       (3, 'biz R', $$ insert into app.locations (id, business_id, name, is_default)
                       values (pg_temp.id('loc 2'), pg_temp.id('biz R'), 'Marina', false) $$),
       (4, 'biz R', $$ insert into app.materials (id, business_id, name, dimension, unit)
                       values (pg_temp.id('milk'), pg_temp.id('biz R'), 'Milk', 'volume', 'l') $$),
       (5, 'biz R', $$ insert into app.stock_counts (id, business_id, kind, business_date)
                       values (pg_temp.id('open'), pg_temp.id('biz R'), 'opening', date '2026-01-20') $$),
       (6, 'biz R', $$ insert into app.stock_count_lines (id, business_id, count_id, location_id,
                                                         material_id, parts, counted_base_qty,
                                                         counted_by, counted_at)
                       values (pg_temp.id('line 1'), pg_temp.id('biz R'), pg_temp.id('open'),
                               pg_temp.id('loc 1'), pg_temp.id('milk'), '[{"qty":"40","unit":"l"}]',
                               40000, pg_temp.id('user R'), now()) $$),
       (7, 'biz R', $$ insert into app.stock_counts (id, business_id, kind, location_id, business_date)
                       values (pg_temp.id('count'), pg_temp.id('biz R'), 'count', pg_temp.id('loc 1'),
                               date '2026-01-25') $$),
       (8, 'biz R', $$ insert into app.stock_count_lines (id, business_id, count_id, location_id,
                                                         material_id)
                       values (pg_temp.id('line c'), pg_temp.id('biz R'), pg_temp.id('count'),
                               pg_temp.id('loc 1'), pg_temp.id('milk')) $$)
     ) as v(n, b, stmt)),
  'ok 1,ok 1,ok 1,ok 1,ok 1,ok 1,ok 1,ok 1',
  'setup'
);

-- 1. A material is never written already tracked (keep_tracking_on_insert) ----------------------

select is(
  pg_temp.state_of(pg_temp.api_exec('user R', 'biz R', $$
    insert into app.materials (id, business_id, name, dimension, unit, stock_tracked_from)
    values (pg_temp.id('sugar'), pg_temp.id('biz R'), 'Sugar', 'mass', 'kg', date '2026-01-01') $$)),
  '23514',
  'a material is never inserted already tracked (no first count of it can exist yet)'
);

-- 2. A count keeps its kind, branch and day (guard_head) -----------------------------------------

select is(
  pg_temp.state_of(pg_temp.api_exec('user R', 'biz R', $$
    update app.stock_counts set location_id = pg_temp.id('loc 2') where id = pg_temp.id('count') $$)),
  '23514',
  'a draft count never moves to another branch (its lines stay in the first one)'
);

select is(
  pg_temp.state_of(pg_temp.api_exec('user R', 'biz R', $$
    update app.stock_counts set kind = 'opening', location_id = null where id = pg_temp.id('count') $$)),
  '23514',
  'a draft count never turns into a first count under its lines'
);

select is(
  pg_temp.state_of(pg_temp.api_exec('user R', 'biz R', $$
    update app.stock_counts set business_date = date '2026-01-19' where id = pg_temp.id('count') $$)),
  '23514',
  'a draft count never changes its day (its day order was checked when it started)'
);

-- 3. Ledger rows only of a finalized count (count_finalized), never of a discarded one -----------

select is(
  pg_temp.api_commit('user R', 'biz R', $$
    insert into app.stock_movements (id, business_id, business_date, location_id, material_id, kind,
                                     qty, value, count_line_id)
    values (pg_temp.id('stray'), pg_temp.id('biz R'), date '2026-01-20', pg_temp.id('loc 1'),
            pg_temp.id('milk'), 'opening', 40000, 0, pg_temp.id('line 1')) $$),
  'ERROR 23514: a count''s opening row stands only for a finalized count',
  'an opening row of a first count that is still a draft at commit is refused'
);

select is(
  pg_temp.state_of(pg_temp.api_exec('user R', 'biz R', $$
    insert into app.stock_movements (id, business_id, business_date, location_id, material_id, kind,
                                     qty, value, count_line_id)
    values (pg_temp.id('stray'), pg_temp.id('biz R'), date '2026-01-20', pg_temp.id('loc 1'),
            pg_temp.id('milk'), 'opening', 40000, 0, pg_temp.id('line 1')) $$)),
  'ok 1',
  'setup: an opening row while the first count is a draft, as finalizing writes it (checked at commit)'
);

select is(
  pg_temp.state_of(pg_temp.api_exec('user R', 'biz R', $$
    update app.stock_counts set deleted_at = now() where id = pg_temp.id('open') $$)),
  '23514',
  'a draft whose ledger rows are written is never discarded (its opening would stay in the ledger)'
);

-- 4. A first count that no longer stands leaves no material tracked (keep_tracking) --------------

select is(
  pg_temp.state_of(pg_temp.api_exec('user R', 'biz R', $$
    update app.stock_counts set status = 'posted', posted_at = now(), posted_by = pg_temp.id('user R')
     where id = pg_temp.id('open') $$)),
  'ok 1',
  'setup: the first count is finalized'
);

select is(
  pg_temp.state_of(pg_temp.api_exec('user R', 'biz R', $$
    update app.materials set stock_tracked_from = date '2026-01-20' where id = pg_temp.id('milk') $$)),
  'ok 1',
  'setup: the milk is tracked from it'
);

select is(
  pg_temp.api_commit('user R', 'biz R', $$
    insert into app.stock_movements (id, business_id, business_date, location_id, material_id, kind,
                                     qty, value, count_line_id, reverses_id)
    values (pg_temp.id('stray back'), pg_temp.id('biz R'), date '2026-01-20', pg_temp.id('loc 1'),
            pg_temp.id('milk'), 'reversal', -40000, 0, pg_temp.id('line 1'), pg_temp.id('stray')) $$),
  'ERROR 23514: a count''s reversal row stands only for a finalized count',
  'a reversal row of a first count that is not reversed at commit is refused'
);

select is(
  pg_temp.api_commit('user R', 'biz R', $$
    update app.stock_counts set status = 'reversed', reversed_at = now(),
                                reversed_by = pg_temp.id('user R'), reversal_date = date '2026-01-20'
     where id = pg_temp.id('open') $$),
  'ERROR 23514: a material is tracked only while its first count stands',
  'a first count is never reversed while its materials stay tracked from it'
);

select is(
  pg_temp.state_of(pg_temp.api_commit('user R', 'biz R', $$
    update app.stock_counts set status = 'reversed', reversed_at = now(),
                                reversed_by = pg_temp.id('user R'), reversal_date = date '2026-01-20'
     where id = pg_temp.id('open');
    update app.materials set stock_tracked_from = null where id = pg_temp.id('milk') $$)),
  'ok 1',
  'reversed, and its materials no longer tracked, in one transaction: as the API does'
);

select is(
  (select stock_tracked_from from app.materials where id = pg_temp.id('milk')),
  null,
  'the milk is not tracked any more'
);

select * from finish();
rollback;

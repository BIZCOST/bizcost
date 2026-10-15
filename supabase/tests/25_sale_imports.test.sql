-- pgTAP: importing sales from a file, and a channel's statements (M3 Step 4; migrations
-- sale_imports_tables, sale_imports_security and sale_imports_skipped_days; DECISIONS.md from D-252).
-- As bizcost_api, like the API:
--   - the five tables are isolated between businesses and link only within one (composite foreign
--     keys: an import's channel and location, a staged row's import, an alias's product, a
--     statement's channel and import, an imported sale's import);
--   - their CHECKs: value lists, a file's SHA-256 and fingerprint in hex, an import's days within one
--     month, at most 50 rows left out kept, a sale of source `import` names its import (and a summary
--     over several days may cover them), an alias of a product names it, a statement's amounts never
--     negative and its days in order;
--   - the same file (its hash) once among imports not reversed; one answer per source, kind and key;
--     one layout per source and fingerprint; a discarded or reversed import frees its file;
--   - a finalized import or statement is never edited: it only becomes reversed; nothing deleted;
--   - finalized statements of a channel never cover the same day twice (another channel's may; a
--     reversed one frees its days);
--   - the books-closed date: no statement finalized, written already final or reversed when its first
--     day is on or before it.
begin;
select plan(67);

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

-- An import of A (a draft unless said), its file `p_hash` (one hex digit, repeated), in A's channel
-- at A's location, on 20 January 2026.
create function pg_temp.import_sql(p_id text, p_hash text, p_extra_columns text default '',
                                   p_extra_values text default '')
returns text language sql immutable
as $$
  select format($f$
    insert into app.sale_imports (id, business_id, channel_id, location_id, file_name, file_hash,
                                  fingerprint, shape, period_from, period_to, mapping, rows_read,
                                  row_count %s)
    values (pg_temp.id(%L), pg_temp.id('biz A'), pg_temp.id('chan A'), pg_temp.id('loc A'),
            'sales.csv', repeat(%L, 64), repeat('f', 64), 'lines', date '2026-01-20',
            date '2026-01-20', '{}', 1, 1 %s) $f$,
    p_extra_columns, p_id, p_hash, p_extra_values)
$$;

-- A statement of A's channel `p_channel` over `p_from` … `p_to` (a draft unless said).
create function pg_temp.statement_sql(p_id text, p_channel text, p_from text, p_to text,
                                      p_extra_columns text default '',
                                      p_extra_values text default '')
returns text language sql immutable
as $$
  select format($f$
    insert into app.channel_statements (id, business_id, channel_id, period_from, period_to,
                                        commission %s)
    values (pg_temp.id(%L), pg_temp.id('biz A'), pg_temp.id(%L), date %L, date %L, 180 %s) $f$,
    p_extra_columns, p_id, p_channel, p_from, p_to, p_extra_values)
$$;

insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', pg_temp.id('user A'), 'authenticated',
        'authenticated', 'amal-imports@example.test', now(), '{}', '{}', now(), now()),
       ('00000000-0000-0000-0000-000000000000', pg_temp.id('user B'), 'authenticated',
        'authenticated', 'badr-imports@example.test', now(), '{}', '{}', now(), now());

-- 1. Columns and keys (6) ------------------------------------------------------------------------

select col_type_is('app', 'sale_imports', 'file_hash', 'character(64)',
                   'an import keeps its file''s SHA-256, never the file');
select col_type_is('app', 'sale_imports', 'fees_total', 'numeric(20,4)',
                   'the fee column''s total is a money amount');
select col_type_is('app', 'channel_statements', 'commission', 'numeric(20,4)',
                   'a statement''s commission is a money amount');
select has_index('app', 'sale_imports', 'sale_imports_file_key',
                 'the same file once among imports not reversed');
select has_index('app', 'product_aliases', 'product_aliases_key',
                 'one answer per source, kind and key');
select has_index('app', 'import_profiles', 'import_profiles_fingerprint_key',
                 'one layout per source and fingerprint');

-- 2. Fixtures (14) -------------------------------------------------------------------------------

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
      insert into app.sales_channels (id, business_id, name, kind)
      values (pg_temp.id('chan A'), pg_temp.id('biz A'), 'Talabat', 'delivery_app') $$),
    ('user A', 'biz A', 'another channel of A', $$
      insert into app.sales_channels (id, business_id, name, kind)
      values (pg_temp.id('chan A2'), pg_temp.id('biz A'), 'Deliveroo', 'delivery_app') $$),
    ('user A', 'biz A', 'a product of A', $$
      insert into app.products_services (id, business_id, name, type, unit, default_price)
      values (pg_temp.id('latte A'), pg_temp.id('biz A'), 'Latte', 'product', 'piece', 18) $$),
    ('user A', 'biz A', 'an import of A', pg_temp.import_sql('imp A', 'a')),
    ('user A', 'biz A', 'its staged row', $$
      insert into app.sale_import_rows (id, business_id, import_id, position, business_date, name,
                                        qty, amount, file_rows)
      values (pg_temp.id('row A'), pg_temp.id('biz A'), pg_temp.id('imp A'), 0, date '2026-01-20',
              'Spanish Latte L', 120, 2268, 1) $$),
    ('user A', 'biz A', 'an answer of A', $$
      insert into app.product_aliases (id, business_id, source, kind, key, raw, target, product_id)
      values (pg_temp.id('alias A'), pg_temp.id('biz A'), 'file', 'name', 'spanish latte l',
              'Spanish Latte L', 'product', pg_temp.id('latte A')) $$),
    ('user A', 'biz A', 'a layout of A', $$
      insert into app.import_profiles (id, business_id, source, fingerprint, mapping)
      values (pg_temp.id('profile A'), pg_temp.id('biz A'), 'file', repeat('e', 64), '{}') $$),
    ('user B', 'biz B', 'a location of B', $$
      insert into app.locations (id, business_id, name, is_default)
      values (pg_temp.id('loc B'), pg_temp.id('biz B'), 'Main', true) $$),
    ('user B', 'biz B', 'a product of B', $$
      insert into app.products_services (id, business_id, name, type, unit)
      values (pg_temp.id('latte B'), pg_temp.id('biz B'), 'Latte', 'product', 'piece') $$),
    ('user B', 'biz B', 'a channel of B', $$
      insert into app.sales_channels (id, business_id, name, kind)
      values (pg_temp.id('chan B'), pg_temp.id('biz B'), 'Shop', 'shop') $$),
    ('user B', 'biz B', 'an import of B', $$
      insert into app.sale_imports (id, business_id, channel_id, location_id, file_name, file_hash,
                                    fingerprint, shape, period_from, period_to, mapping, rows_read,
                                    row_count)
      values (pg_temp.id('imp B'), pg_temp.id('biz B'), pg_temp.id('chan B'), pg_temp.id('loc B'),
              'b.csv', repeat('b', 64), repeat('f', 64), 'summary', date '2026-01-20',
              date '2026-01-20', '{}', 1, 1) $$)
  ) as v(u, b, what, stmt);

-- 3. Isolation and links (7) ---------------------------------------------------------------------

select is(
  pg_temp.api_value('user B', 'biz B', $$
    select (select count(*) from app.sale_imports where business_id = pg_temp.id('biz A'))
         + (select count(*) from app.sale_import_rows where business_id = pg_temp.id('biz A'))
         + (select count(*) from app.product_aliases where business_id = pg_temp.id('biz A'))
         + (select count(*) from app.import_profiles where business_id = pg_temp.id('biz A'))
         + (select count(*) from app.channel_statements where business_id = pg_temp.id('biz A')) $$),
  '0',
  'B sees none of A''s imports, rows, answers, layouts or statements (RLS)'
);

select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', v.stmt)), '23503', v.what)
  from (values
    ('an import never names another business''s channel', $$
      update app.sale_imports set channel_id = pg_temp.id('chan B') where id = pg_temp.id('imp A') $$),
    ('nor its location', $$
      update app.sale_imports set location_id = pg_temp.id('loc B') where id = pg_temp.id('imp A') $$),
    ('a staged row never names another business''s import', $$
      insert into app.sale_import_rows (id, business_id, import_id, position, business_date, name,
                                        qty, amount, file_rows)
      values (pg_temp.id('x row'), pg_temp.id('biz A'), pg_temp.id('imp B'), 0, date '2026-01-20',
              'Latte', 1, 1, 1) $$),
    ('an answer never names another business''s product', $$
      update app.product_aliases set product_id = pg_temp.id('latte B')
       where id = pg_temp.id('alias A') $$),
    ('a statement never names another business''s channel', pg_temp.statement_sql('x st', 'chan B',
      '2026-01-01', '2026-01-31')),
    ('a sale never names another business''s import', $$
      insert into app.sales (id, business_id, source, business_date, location_id, channel_id,
                             currency, import_id)
      values (pg_temp.id('x sale'), pg_temp.id('biz A'), 'import', date '2026-01-20',
              pg_temp.id('loc A'), pg_temp.id('chan A'), 'AED', pg_temp.id('imp B')) $$)
  ) as v(what, stmt);

-- 4. CHECKs (12) ---------------------------------------------------------------------------------

select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', v.stmt)), '23514', v.what)
  from (values
    ('an import''s shape from the list', $$
      update app.sale_imports set shape = 'pdf' where id = pg_temp.id('imp A') $$),
    ('its status from the list', $$
      update app.sale_imports set status = 'open' where id = pg_temp.id('imp A') $$),
    ('its file''s hash is a SHA-256 in hex', $$
      update app.sale_imports set file_hash = repeat('Z', 64) where id = pg_temp.id('imp A') $$),
    ('its days within one month', $$
      update app.sale_imports set period_from = date '2025-12-31' where id = pg_temp.id('imp A') $$),
    ('at most 50 rows left out kept', $$
      update app.sale_imports
         set errors = (select jsonb_agg(jsonb_build_object('row', g)) from generate_series(1, 51) g)
       where id = pg_temp.id('imp A') $$),
    ('finalized goes with when and by whom', $$
      update app.sale_imports set status = 'posted' where id = pg_temp.id('imp A') $$),
    ('a sale of source import names its import', $$
      insert into app.sales (id, business_id, source, business_date, location_id, channel_id,
                             currency)
      values (pg_temp.id('y sale'), pg_temp.id('biz A'), 'import', date '2026-01-20',
              pg_temp.id('loc A'), pg_temp.id('chan A'), 'AED') $$),
    ('an answer of a product names it', $$
      update app.product_aliases set product_id = null where id = pg_temp.id('alias A') $$),
    ('an answer''s target from the list', $$
      update app.product_aliases set target = 'maybe', product_id = null
       where id = pg_temp.id('alias A') $$),
    ('a statement''s amounts are never negative', pg_temp.statement_sql('y st', 'chan A',
      '2026-01-01', '2026-01-31', ', ads', ', -1')),
    ('its days in order', pg_temp.statement_sql('z st', 'chan A', '2026-01-31', '2026-01-01')),
    ('a staged row has a name', $$
      update app.sale_import_rows set name = ' ' where id = pg_temp.id('row A') $$)
  ) as v(what, stmt);

-- 5. Keys (6) ------------------------------------------------------------------------------------

select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', v.stmt)), v.state, v.what)
  from (values
    (1, '23505', 'the same file again while its import is not reversed',
      pg_temp.import_sql('imp A again', 'a')),
    (2, '23505', 'a second answer for the same source, kind and key', $$
      insert into app.product_aliases (id, business_id, source, kind, key, raw, target)
      values (pg_temp.id('alias A2'), pg_temp.id('biz A'), 'file', 'name', 'spanish latte l',
              'SPANISH LATTE L', 'skip') $$),
    (3, 'ok 1', 'the same name as an item code is another answer', $$
      insert into app.product_aliases (id, business_id, source, kind, key, raw, target)
      values (pg_temp.id('alias A3'), pg_temp.id('biz A'), 'file', 'code', 'spanish latte l',
              'SPANISH LATTE L', 'skip') $$),
    (4, '23505', 'a second layout for the same fingerprint', $$
      insert into app.import_profiles (id, business_id, source, fingerprint, mapping)
      values (pg_temp.id('profile A2'), pg_temp.id('biz A'), 'file', repeat('e', 64), '{}') $$),
    (5, 'ok 1', 'a discarded import frees its file', $$
      update app.sale_imports set deleted_at = now() where id = pg_temp.id('imp A') $$),
    (6, 'ok 1', 'so the file can be imported again', pg_temp.import_sql('imp A2', 'a'))
  ) as v(n, state, what, stmt)
 order by v.n;

-- 6. A finalized import or statement is never edited (7) ----------------------------------------

select is(pg_temp.api_exec('user A', 'biz A', $$
  update app.sale_imports set status = 'posted', posted_at = now(), posted_by = pg_temp.id('user A')
   where id = pg_temp.id('imp A2') $$), 'ok 1', 'a draft import is finalized');

select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', v.stmt)), v.state, v.what)
  from (values
    (1, '23001', 'a finalized import is never edited', $$
      update app.sale_imports set file_name = 'other.csv' where id = pg_temp.id('imp A2') $$),
    (2, '23001', 'nor deleted', $$
      delete from app.sale_imports where id = pg_temp.id('imp A2') $$),
    (3, 'ok 1', 'it becomes reversed (its reversal columns alone)', $$
      update app.sale_imports set status = 'reversed', reversed_at = now(),
                                  reversed_by = pg_temp.id('user A')
       where id = pg_temp.id('imp A2') $$),
    (4, 'ok 1', 'and its file can be imported again', pg_temp.import_sql('imp A3', 'a')),
    (5, 'ok 1', 'a statement is written', pg_temp.statement_sql('st 1', 'chan A', '2026-02-01',
      '2026-02-28')),
    (6, 'ok 1', 'and finalized', $$
      update app.channel_statements set status = 'posted', posted_at = now(),
                                        posted_by = pg_temp.id('user A')
       where id = pg_temp.id('st 1') $$)
  ) as v(n, state, what, stmt)
 order by v.n;

-- 7. Finalized statements of a channel never cover a day twice (5) ------------------------------

select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', v.stmt)), v.state, v.what)
  from (values
    (1, '23001', 'a finalized statement is never edited', $$
      update app.channel_statements set commission = 1 where id = pg_temp.id('st 1') $$),
    (2, '23P01', 'another finalized statement over some of its days', pg_temp.statement_sql('st 2',
      'chan A', '2026-02-15', '2026-03-15', ', status, posted_at, posted_by',
      ', ''posted'', now(), pg_temp.id(''user A'')')),
    (3, 'ok 1', 'another channel''s may cover them', pg_temp.statement_sql('st 3', 'chan A2',
      '2026-02-15', '2026-03-15', ', status, posted_at, posted_by',
      ', ''posted'', now(), pg_temp.id(''user A'')')),
    (4, 'ok 1', 'a draft over the same days may wait', pg_temp.statement_sql('st 4', 'chan A',
      '2026-02-15', '2026-03-15')),
    (5, 'ok 1', 'once the first is reversed, its days are free', $$
      update app.channel_statements set status = 'reversed', reversed_at = now(),
                                        reversed_by = pg_temp.id('user A')
       where id = pg_temp.id('st 1') $$)
  ) as v(n, state, what, stmt)
 order by v.n;

-- 8. The books-closed date (4) -------------------------------------------------------------------

select is(pg_temp.api_exec('user A', 'biz A', $$
  update app.businesses set books_closed_through = date '2026-02-20'
   where id = pg_temp.id('biz A') $$), 'ok 1', 'A closes its books through 20 February 2026');

select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', v.stmt)), v.state, v.what)
  from (values
    (1, 'BZ412', 'a statement whose first day is closed is not finalized', $$
      update app.channel_statements set status = 'posted', posted_at = now(),
                                        posted_by = pg_temp.id('user A')
       where id = pg_temp.id('st 4') $$),
    (2, 'BZ412', 'nor written already final', pg_temp.statement_sql('st 5', 'chan A', '2026-02-20',
      '2026-02-21', ', status, posted_at, posted_by',
      ', ''posted'', now(), pg_temp.id(''user A'')')),
    (3, 'BZ412', 'nor reversed', $$
      update app.channel_statements set status = 'reversed', reversed_at = now(),
                                        reversed_by = pg_temp.id('user A')
       where id = pg_temp.id('st 3') $$)
  ) as v(n, state, what, stmt)
 order by v.n;

-- 9. Written by the touch and audit triggers (1) -----------------------------------------------

select is(
  (select string_agg(distinct entity, ',' order by entity) from app.audit_log
    where business_id = pg_temp.id('biz A')
      and entity in ('sale_imports', 'sale_import_rows', 'product_aliases', 'import_profiles',
                     'channel_statements')),
  'channel_statements,import_profiles,product_aliases,sale_import_rows,sale_imports',
  'every one of the import tables writes the audit log'
);

-- 10. Staged rows are audited per statement and import, by what their rows come to (D-262) (5) -----

select is(
  pg_temp.api_exec('user A', 'biz A', $$
    with changed as (
      update app.sale_import_rows set qty = 121 where id = pg_temp.id('row A') returning id
    )
    delete from app.sale_import_rows where id = pg_temp.id('row A')
       and not exists (select 1 from changed) $$),
  'ok 0',
  'setup: a staged row is changed'
);

select is(pg_temp.api_exec('user A', 'biz A', $$
  delete from app.sale_import_rows where id = pg_temp.id('row A') $$), 'ok 1',
  'setup: and removed');

select is(
  (select string_agg(
            action || ':' || (actor_user_id = pg_temp.id('user A'))::text || ':'
              || (request_id = pg_temp.id('request'))::text || ':'
              || substr(id::text, 15, 1) || ':'
              || coalesce(changes -> 'before' ->> 'rows', '-') || ' rows '
              || coalesce(changes -> 'before' ->> 'qty', '-') || '>'
              || coalesce(changes -> 'after' ->> 'rows', '-') || ' rows '
              || coalesce(changes -> 'after' ->> 'qty', '-'),
            ',' order by id)
     from app.audit_log
    where business_id = pg_temp.id('biz A') and entity = 'sale_import_rows'
      and entity_id = pg_temp.id('imp A')),
  'insert:true:true:7:- rows ->1 rows 120.000000,update:true:true:7:1 rows 120.000000>1 rows 121.000000,delete:true:true:7:1 rows 121.000000>- rows -',
  'one audit row per statement and import: who, the request, a version-7 id, what the rows came to before and after'
);

select is(
  (select changes::text
     from app.audit_log
    where business_id = pg_temp.id('biz A') and entity = 'sale_import_rows'
      and action = 'insert' and entity_id = pg_temp.id('imp A')),
  jsonb_build_object('after', jsonb_build_object(
    'import_id', pg_temp.id('imp A'), 'rows', 1, 'positions', jsonb_build_array(0, 0),
    'days', jsonb_build_array('2026-01-20', '2026-01-20'), 'qty', 120.000000,
    'amount', 2268.0000, 'refunds', 0.0000, 'file_rows', 1))::text,
  'the rows'' count, first and last position and day, and their totals: never a row of each (the file''s names stay out)'
);

select is(
  (select count(*)::int from pg_trigger g
    where g.tgrelid = 'app.sale_import_rows'::regclass
      and g.tgfoid in (to_regprocedure('app.audit_row()'), to_regprocedure('app.audit_rows()'))),
  0,
  'the staged rows are not audited twice'
);

select * from finish();
rollback;

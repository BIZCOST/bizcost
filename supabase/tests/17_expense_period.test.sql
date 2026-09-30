-- pgTAP: the month an expense is for (the owner's request of 2026-09-30, M2 Step 7). As bizcost_api,
-- like the API: expenses.period_month is required, the first day of a month from 12 months before the
-- bill's month to 1 month after it (expenses_period_month_check); a row written without it gets its
-- bill's month (the trigger default_period_month); an expense under review or final never changes it
-- (guard_expense); a reversal says the month it counts in, never before the expense's, set only with the
-- reversal (expenses_reversal_period_month_check, guard_expense; D-200); categories say whether their
-- bills come the month after, off by default. The
-- function's grants are checked generically by 01_grants.
begin;
select plan(24);

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

-- Runs p_sql as bizcost_api with the given user/business (fixture names). Returns 'ok <row count>',
-- the first column of the first row (p_scalar), or 'ERROR <sqlstate>: <message>'.
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

-- A draft expense of A dated 2026-10-03 (a bill for September's electricity, say), with the month it
-- is for given as SQL (null: left out).
create function pg_temp.expense_sql(p_id text, p_period text)
returns text language sql immutable
as $$
  select format($f$
    insert into app.expenses (id, business_id, category_id, location_id, business_date,
                              document_type, payment_method, currency, amount, vat_rate, net_total,
                              vat_total, total %s)
    values (pg_temp.id(%L), pg_temp.id('biz A'), pg_temp.id('cat A'), pg_temp.id('loc A'),
            date '2026-10-03', 'no_invoice', 'cash', 'AED', 100, 0, 100, 0, 100 %s) $f$,
    case when p_period is null then '' else ', period_month' end,
    p_id,
    case when p_period is null then '' else ', ' || p_period end)
$$;

insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', pg_temp.id('user A'), 'authenticated',
        'authenticated', 'amal@example.test', now(), '{}', '{}', now(), now());

-- 1. Columns (4) --------------------------------------------------------------------------------

select col_type_is('app', 'expenses', 'period_month', 'date',
                   'expenses.period_month is a date (the first day of the month)');
select col_not_null('app', 'expenses', 'period_month', 'expenses.period_month is required');
select col_default_is('app', 'cost_categories', 'billed_next_month', 'false',
                      'a category is billed in its own month unless said otherwise');
select has_trigger('app', 'expenses', 'default_period_month',
                   'a row written without its month gets one (default_period_month)');

-- 2. Fixtures (3) -------------------------------------------------------------------------------

select is(
  pg_temp.api_value('user A', null, $$
    select app.create_business(pg_temp.id('biz A'), 'Alpha Studio', 'en', 'Owner',
                               pg_temp.id('biz A owner role'), pg_temp.id('biz A owner member')) $$),
  pg_temp.id('biz A')::text,
  'setup: user A creates biz A'
);

select is(pg_temp.api_exec('user A', 'biz A', v.stmt), 'ok 1', 'setup: ' || v.what)
  from (values
    ('a location of A', $$
      insert into app.locations (id, business_id, name, is_default)
      values (pg_temp.id('loc A'), pg_temp.id('biz A'), 'Main', true) $$),
    ('the category Electricity of A, billed the month after', $$
      insert into app.cost_categories (id, business_id, name, billed_next_month)
      values (pg_temp.id('cat A'), pg_temp.id('biz A'), 'Electricity', true) $$)
  ) as v(what, stmt);

-- 3. The month and its range (8) ----------------------------------------------------------------

select is(
  pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', pg_temp.expense_sql(v.id, v.period))),
  v.state,
  v.what
)
  from (values
    ('e none', null, 'ok 1', 'left out: written anyway'),
    ('e sep', $$date '2026-09-01'$$, 'ok 1', 'the month before the bill'),
    ('e back', $$date '2025-10-01'$$, 'ok 1', '12 months before the bill''s month'),
    ('e ahead', $$date '2026-11-01'$$, 'ok 1', '1 month after the bill''s month'),
    ('e old', $$date '2025-09-01'$$, '23514', 'not 13 months before'),
    ('e far', $$date '2026-12-01'$$, '23514', 'not 2 months after'),
    ('e mid', $$date '2026-09-15'$$, '23514', 'only the first day of a month')
  ) as v(id, period, state, what);

select is(
  pg_temp.api_value('user A', 'biz A', $$
    select period_month::text from app.expenses where id = pg_temp.id('e none') $$),
  '2026-10-01',
  'left out, the month of the bill''s date (the API says the month before for this category)'
);

-- 4. Frozen under review and once final (2) -----------------------------------------------------

select is(
  pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', $$
    update app.expenses set status = 'submitted', submitted_at = now(),
                            submitted_by = pg_temp.id('user A')
     where id = pg_temp.id('e sep') $$)),
  'ok 1',
  'setup: the September bill is sent for approval'
);

select isnt(
  pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', $$
    update app.expenses set period_month = date '2026-10-01' where id = pg_temp.id('e sep') $$)),
  'ok 1',
  'an expense sent for approval keeps its month'
);

-- 5. The month a reversal counts in (7, D-200) ------------------------------------------------

select col_type_is('app', 'expenses', 'reversal_period_month', 'date',
                   'expenses.reversal_period_month is a date (the first day of the month)');

select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', v.stmt)), v.state, v.what)
  from (values
    ('ok 1', 'setup: the bill for October of last year is final', $$
      update app.expenses set status = 'posted', vat_in_cost = false, cost_total = 100,
                              posted_at = now(), posted_by = pg_temp.id('user A')
       where id = pg_temp.id('e back') $$),
    ('ok 1', 'a final expense is reversed with the month its reversal counts in', $$
      update app.expenses set status = 'reversed', reversed_at = now(),
                              reversed_by = pg_temp.id('user A'), reversal_date = date '2026-10-03',
                              reversal_period_month = date '2026-10-01'
       where id = pg_temp.id('e back') $$),
    ('23001', 'the month of a reversal stays as it is', $$
      update app.expenses set reversal_period_month = date '2026-11-01'
       where id = pg_temp.id('e back') $$),
    ('23514', 'a draft has no reversal month', $$
      update app.expenses set reversal_period_month = date '2026-10-01'
       where id = pg_temp.id('e none') $$),
    ('ok 1', 'setup: the bill for next month is final', $$
      update app.expenses set status = 'posted', vat_in_cost = false, cost_total = 100,
                              posted_at = now(), posted_by = pg_temp.id('user A')
       where id = pg_temp.id('e ahead') $$),
    ('23514', 'a reversal never counts before the month of its expense', $$
      update app.expenses set status = 'reversed', reversed_at = now(),
                              reversed_by = pg_temp.id('user A'), reversal_date = date '2026-10-03',
                              reversal_period_month = date '2026-10-01'
       where id = pg_temp.id('e ahead') $$)
  ) as v(state, what, stmt);

select * from finish();
rollback;

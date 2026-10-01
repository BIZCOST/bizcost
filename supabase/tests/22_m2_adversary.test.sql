-- pgTAP, ADVERSARY (M2 Step 8, fresh eyes over all of M2): the books-closed guard at the database
-- (migration books_closed_guard, D-205) fires only when a document BECOMES posted or reversed by an
-- UPDATE. A purchase, a supplier return or credit note, or an expense written already posted (an
-- INSERT with status 'posted') passes it, so a script, a later procedure or a bug that writes a final
-- document in one statement puts it into closed books, which the migration says no path can do. Each
-- case has a control dated in the open period that is accepted, so the refusal tested is the guard's
-- and not another constraint's. Fixed by migration books_closed_insert (D-211): written already
-- posted, a document is checked by its day (and month); written already reversed, by its posting and
-- by its reversal; as bizcost_api and as the table owner.
begin;
select plan(16);

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

-- The closed day (`d(0)`) and days around it.
create function pg_temp.d(p_offset integer) returns date
language sql stable
as $$ select current_date - 10 + p_offset $$;
grant execute on function pg_temp.d(integer) to bizcost_api;

-- Runs p_sql as bizcost_api, as user A in business A: 'ok <rows>' or 'ERROR <sqlstate>: <message>'.
create function pg_temp.a(p_sql text)
returns text
language plpgsql
as $$
declare
  v_out text;
  v_rows bigint;
begin
  perform set_config('app.user_id', pg_temp.id('user A')::text, true);
  perform set_config('app.business_id', pg_temp.id('biz A')::text, true);
  perform set_config('app.request_id', pg_temp.id('request')::text, true);
  begin
    set local role bizcost_api;
    execute p_sql;
    get diagnostics v_rows = row_count;
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

create function pg_temp.state_of(p_result text)
returns text language sql immutable
as $$ select case when p_result like 'ERROR %' then substr(p_result, 7, 5) else p_result end $$;

-- A purchase of A written already posted, dated p_day.
create function pg_temp.posted_purchase_sql(p_name text, p_day text)
returns text language sql immutable
as $$
  select format($f$
    insert into app.purchases (id, business_id, supplier_id, location_id, business_date, document_type,
                               payment_method, currency, status, posted_at, posted_by, vat_in_cost,
                               cost_total)
    values (pg_temp.id(%L), pg_temp.id('biz A'), pg_temp.id('sup A'), pg_temp.id('loc A'), %s,
            'no_invoice', 'cash', 'AED', 'posted', now(), pg_temp.id('user A'), true, 60) $f$,
    p_name, p_day)
$$;

-- A credit note of the posted purchase `pur base`, written already posted, dated p_day.
create function pg_temp.posted_credit_sql(p_name text, p_day text)
returns text language sql immutable
as $$
  select format($f$
    insert into app.purchase_returns (id, business_id, purchase_id, kind, business_date, currency,
                                      status, posted_at, posted_by, cost_total)
    values (pg_temp.id(%L), pg_temp.id('biz A'), pg_temp.id('pur base'), 'credit_note', %s, 'AED',
            'posted', now(), pg_temp.id('user A'), 5) $f$,
    p_name, p_day)
$$;

-- An expense of A written already posted, dated p_day, for p_month (null: its bill's month).
create function pg_temp.posted_expense_sql(p_name text, p_day text, p_month text)
returns text language sql immutable
as $$
  select format($f$
    insert into app.expenses (id, business_id, category_id, supplier_id, location_id, business_date,
                              period_month, document_type, payment_method, currency, amount, net_total,
                              vat_total, total, status, posted_at, posted_by, vat_in_cost, cost_total)
    values (pg_temp.id(%L), pg_temp.id('biz A'), pg_temp.id('cat A'), pg_temp.id('sup A'),
            pg_temp.id('loc A'), %s, %s, 'no_invoice', 'cash', 'AED', 100, 100, 0, 100, 'posted', now(),
            pg_temp.id('user A'), true, 100) $f$,
    p_name, p_day, coalesce(p_month, 'null'))
$$;

insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', pg_temp.id('user A'), 'authenticated', 'authenticated',
        'adversary-22@example.test', now(), '{}', '{}', now(), now());

-- Fixtures (2) -------------------------------------------------------------------------------------

select is(
  (select pg_temp.a($$
    select app.create_business(pg_temp.id('biz A'), 'Alpha Bakery', 'en', 'Owner',
                               pg_temp.id('biz A owner role'), pg_temp.id('biz A owner member')) $$)),
  'ok 1',
  'setup: user A creates business A'
);

select is(
  array_agg(pg_temp.a(v.stmt) order by v.n),
  array_fill('ok 1'::text, array[6]),
  'setup: a location, a supplier, a category, a purchase posted before the date, the books closed'
)
  from (values
    (1, $$ insert into app.locations (id, business_id, name, is_default)
           values (pg_temp.id('loc A'), pg_temp.id('biz A'), 'Main', true) $$),
    (2, $$ insert into app.suppliers (id, business_id, name)
           values (pg_temp.id('sup A'), pg_temp.id('biz A'), 'Dairy') $$),
    (3, $$ insert into app.cost_categories (id, business_id, name)
           values (pg_temp.id('cat A'), pg_temp.id('biz A'), 'Rent') $$),
    (4, $$ insert into app.purchases (id, business_id, supplier_id, location_id, business_date,
                                      document_type, payment_method, currency)
           values (pg_temp.id('pur base'), pg_temp.id('biz A'), pg_temp.id('sup A'),
                   pg_temp.id('loc A'), pg_temp.d(-5), 'no_invoice', 'cash', 'AED') $$),
    (5, $$ update app.purchases
              set status = 'posted', posted_at = now(), posted_by = pg_temp.id('user A'),
                  vat_in_cost = true, cost_total = 60
            where id = pg_temp.id('pur base') $$),
    (6, $$ update app.businesses set books_closed_through = pg_temp.d(0)
            where id = pg_temp.id('biz A') $$)
  ) as v(n, stmt);

-- Controls: written already posted in the open period, accepted (3) ---------------------------------

select is(pg_temp.a(pg_temp.posted_purchase_sql('pur open', 'pg_temp.d(1)')), 'ok 1',
  'control: a purchase written posted the day after the closed date is accepted');
select is(pg_temp.a(pg_temp.posted_credit_sql('cn open', 'pg_temp.d(1)')), 'ok 1',
  'control: a credit note written posted the day after the closed date is accepted');
select is(pg_temp.a(pg_temp.posted_expense_sql('exp open', 'current_date', null)), 'ok 1',
  'control: an expense written posted today, for this month, is accepted');

-- Written already posted into closed books: refused (4) ---------------------------------------------

select is(pg_temp.state_of(pg_temp.a(pg_temp.posted_purchase_sql('pur closed', 'pg_temp.d(0)'))),
  'BZ412', 'a purchase written posted on the closed date is refused (BZ412)');
select is(pg_temp.state_of(pg_temp.a(pg_temp.posted_credit_sql('cn closed', 'pg_temp.d(-1)'))),
  'BZ412', 'a credit note written posted before the closed date is refused (BZ412)');
select is(pg_temp.state_of(pg_temp.a(pg_temp.posted_expense_sql('exp closed', 'pg_temp.d(0)', null))),
  'BZ412', 'an expense written posted on the closed date is refused (BZ412)');
select is(
  pg_temp.state_of(pg_temp.a(pg_temp.posted_expense_sql(
    'exp closed month', 'current_date',
    $m$(date_trunc('month', pg_temp.d(0)) - interval '1 month')::date$m$))),
  'BZ412', 'an expense written posted today for a closed month is refused (BZ412, D-200)');

-- Written already reversed: its posting and its reversal are both checked (5) -------------------------

-- A purchase of A written already reversed: posted on p_day, reversed on p_reversal.
create function pg_temp.reversed_purchase_sql(p_name text, p_day text, p_reversal text)
returns text language sql immutable
as $$
  select format($f$
    insert into app.purchases (id, business_id, supplier_id, location_id, business_date, document_type,
                               payment_method, currency, status, posted_at, posted_by, vat_in_cost,
                               cost_total, reversed_at, reversed_by, reversal_date)
    values (pg_temp.id(%L), pg_temp.id('biz A'), pg_temp.id('sup A'), pg_temp.id('loc A'), %s,
            'no_invoice', 'cash', 'AED', 'reversed', now(), pg_temp.id('user A'), true, 60, now(),
            pg_temp.id('user A'), %s) $f$,
    p_name, p_day, p_reversal)
$$;

-- An expense of A written already reversed: posted on p_day for p_month, reversed on p_reversal.
create function pg_temp.reversed_expense_sql(p_name text, p_day text, p_month text, p_reversal text)
returns text language sql immutable
as $$
  select format($f$
    insert into app.expenses (id, business_id, category_id, supplier_id, location_id, business_date,
                              period_month, document_type, payment_method, currency, amount, net_total,
                              vat_total, total, status, posted_at, posted_by, vat_in_cost, cost_total,
                              reversed_at, reversed_by, reversal_date)
    values (pg_temp.id(%L), pg_temp.id('biz A'), pg_temp.id('cat A'), pg_temp.id('sup A'),
            pg_temp.id('loc A'), %s, %s, 'no_invoice', 'cash', 'AED', 100, 100, 0, 100, 'reversed',
            now(), pg_temp.id('user A'), true, 100, now(), pg_temp.id('user A'), %s) $f$,
    p_name, p_day, coalesce(p_month, 'null'), p_reversal)
$$;

select is(pg_temp.a(pg_temp.reversed_purchase_sql('pur rev open', 'pg_temp.d(1)', 'pg_temp.d(2)')),
  'ok 1', 'control: a purchase written reversed, posted and reversed after the closed date, is accepted');
select is(
  pg_temp.state_of(pg_temp.a(
    pg_temp.reversed_purchase_sql('pur rev posted closed', 'pg_temp.d(-2)', 'pg_temp.d(2)'))),
  'BZ412', 'a purchase written reversed, posted before the closed date, is refused (BZ412)');
select is(
  pg_temp.state_of(pg_temp.a(
    pg_temp.reversed_purchase_sql('pur rev both closed', 'pg_temp.d(-3)', 'pg_temp.d(0)'))),
  'BZ412', 'a purchase written reversed on the closed date is refused (BZ412)');
select is(
  pg_temp.a(pg_temp.reversed_expense_sql('exp rev open', 'current_date', null, 'current_date')),
  'ok 1', 'control: an expense written reversed today, for this month, is accepted');
select is(
  pg_temp.state_of(pg_temp.a(pg_temp.reversed_expense_sql(
    'exp rev closed month', 'current_date',
    $m$(date_trunc('month', pg_temp.d(0)) - interval '1 month')::date$m$, 'current_date'))),
  'BZ412', 'an expense written reversed today, posted for a closed month, is refused (BZ412)');

-- The table owner (postgres) is held to it too (2) -----------------------------------------------------

-- Runs p_sql as the test's own role (the table owner, not bizcost_api): 'ok' or the SQLSTATE.
create function pg_temp.owner_state(p_sql text)
returns text
language plpgsql
as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate;
end
$$;

select is(pg_temp.owner_state(pg_temp.posted_purchase_sql('pur owner', 'pg_temp.d(0)')), 'BZ412',
  'as the table owner, a purchase written posted on the closed date is refused (BZ412)');
select is(pg_temp.owner_state(pg_temp.posted_expense_sql('exp owner', 'pg_temp.d(-1)', null)),
  'BZ412', 'as the table owner, an expense written posted before the closed date is refused (BZ412)');

select * from finish();
rollback;

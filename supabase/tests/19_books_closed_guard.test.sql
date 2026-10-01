-- pgTAP: the books-closed date at the database (M2 Step 8; D-114 rule 6, D-135, D-200). The API checks
-- the date under the business row's lock before it writes (stock.ts); the trigger books_closed checks it
-- again where the posting is written, so no path that skips the API's check (a script, a later
-- procedure) can post into closed books. As bizcost_api, like the API, and as the table owner: nothing
-- dated on or before the date is posted (purchases, returns, credit notes, expenses, the payments of
-- purchases and expenses, stock movements) or reversed (a reversal is dated the first open day); an
-- expense for a closed month is neither finalized nor reversed into it (D-200); drafts are still
-- edited; moving the date back opens the books again. Refused: SQLSTATE BZ412 (the API's BOOKS_CLOSED).
begin;
select plan(80);

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

-- The day the books are first closed through, and days around it (`d(0)` is that day).
create function pg_temp.d(p_offset integer) returns date
language sql stable
as $$ select current_date - 10 + p_offset $$;
grant execute on function pg_temp.d(integer) to bizcost_api;

-- The last day of last month (closing through it closes last month), and the first day of a month.
create function pg_temp.last_month_end() returns date
language sql stable
as $$ select date_trunc('month', current_date)::date - 1 $$;
grant execute on function pg_temp.last_month_end() to bizcost_api;

create function pg_temp.month_of(p_day date) returns date
language sql immutable
as $$ select date_trunc('month', p_day)::date $$;
grant execute on function pg_temp.month_of(date) to bizcost_api;

-- Runs p_sql as bizcost_api with the given user/business (fixture names; null = unset). Returns
-- 'ok <row count>' or 'ERROR <sqlstate>: <message>'.
create function pg_temp.api_exec(p_user text, p_business text, p_sql text)
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

-- As user A in business A.
create function pg_temp.a(p_sql text)
returns text language sql
as $$ select pg_temp.api_exec('user A', 'biz A', p_sql) $$;

-- The SQLSTATE of a refused statement ('ok …' when it was not refused).
create function pg_temp.state_of(p_result text)
returns text language sql immutable
as $$ select case when p_result like 'ERROR %' then substr(p_result, 7, 5) else p_result end $$;

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

-- A draft purchase of A dated p_day, with one line of 10 L of milk at 6 (`line <name>`).
create function pg_temp.purchase_sql(p_name text, p_day text, p_method text)
returns text language sql immutable
as $$
  select format($f$
    with p as (
      insert into app.purchases (id, business_id, supplier_id, location_id, business_date, document_type,
                                 payment_method, currency)
      values (pg_temp.id(%L), pg_temp.id('biz A'), pg_temp.id('sup A'), pg_temp.id('loc A'), %s,
              'no_invoice', %L, 'AED')
      returning id
    )
    insert into app.purchase_lines (id, business_id, purchase_id, position, kind, material_id, qty, unit,
                                    unit_price)
    select pg_temp.id(%L), pg_temp.id('biz A'), p.id, 0, 'material', pg_temp.id('milk'), 10, 'l', 6
      from p $f$, p_name, p_day, p_method, 'line ' || p_name)
$$;

-- Posts a purchase of A: the line's snapshots, then the document.
create function pg_temp.post_purchase_sql(p_name text)
returns text language sql immutable
as $$
  select format($f$
    with l as (
      update app.purchase_lines set base_qty = 10000, cost = 60 where id = pg_temp.id(%L) returning 1
    )
    update app.purchases
       set status = 'posted', posted_at = now(), posted_by = pg_temp.id('user A'), vat_in_cost = true,
           cost_total = 60
     where id = pg_temp.id(%L) and (select count(*) from l) = 1 $f$, 'line ' || p_name, p_name)
$$;

-- A purchase movement of A for `line <name>`, dated p_day.
create function pg_temp.receipt_sql(p_name text, p_day text)
returns text language sql immutable
as $$
  select format($f$
    insert into app.stock_movements (id, business_id, business_date, location_id, material_id, kind, qty,
                                     value, unit_cost, purchase_line_id)
    values (pg_temp.id(%L), pg_temp.id('biz A'), %s, pg_temp.id('loc A'), pg_temp.id('milk'),
            'purchase', 10000, 60, 0.006, pg_temp.id(%L)) $f$,
    'mov ' || p_name, p_day, 'line ' || p_name)
$$;

-- A draft return or credit note of `pur ret` dated p_day, with one line on its line.
create function pg_temp.return_sql(p_name text, p_kind text, p_day text)
returns text language sql immutable
as $$
  select format($f$
    with r as (
      insert into app.purchase_returns (id, business_id, purchase_id, kind, business_date, currency)
      values (pg_temp.id(%L), pg_temp.id('biz A'), pg_temp.id('pur ret'), %L, %s, 'AED')
      returning id
    )
    insert into app.purchase_return_lines (id, business_id, return_id, purchase_id, purchase_line_id,
                                           position, qty, amount)
    select pg_temp.id(%L), pg_temp.id('biz A'), r.id, pg_temp.id('pur ret'), pg_temp.id('line pur ret'),
           0, %s, %s
      from r $f$,
    p_name, p_kind, p_day, 'line ' || p_name,
    case when p_kind = 'return' then '1' else 'null' end,
    case when p_kind = 'return' then 'null' else '5' end)
$$;

create function pg_temp.post_return_sql(p_name text)
returns text language sql immutable
as $$
  select format($f$
    update app.purchase_returns
       set status = 'posted', posted_at = now(), posted_by = pg_temp.id('user A'), cost_total = 5
     where id = pg_temp.id(%L) $f$, p_name)
$$;

-- A draft expense of A dated p_day for p_month (null: the trigger fills its bill's month).
create function pg_temp.expense_sql(p_name text, p_day text, p_month text, p_method text)
returns text language sql immutable
as $$
  select format($f$
    insert into app.expenses (id, business_id, category_id, supplier_id, location_id, business_date,
                              period_month, document_type, payment_method, currency, amount, net_total,
                              vat_total, total)
    values (pg_temp.id(%L), pg_temp.id('biz A'), pg_temp.id('cat A'), pg_temp.id('sup A'),
            pg_temp.id('loc A'), %s, %s, 'no_invoice', %L, 'AED', 100, 100, 0, 100) $f$,
    p_name, p_day, coalesce(p_month, 'null'), p_method)
$$;

create function pg_temp.post_expense_sql(p_name text)
returns text language sql immutable
as $$
  select format($f$
    update app.expenses
       set status = 'posted', posted_at = now(), posted_by = pg_temp.id('user A'), vat_in_cost = true,
           cost_total = 100
     where id = pg_temp.id(%L) $f$, p_name)
$$;

-- Reverses a document of A on p_day (expenses: counted in p_month, null = its own month).
create function pg_temp.reverse_sql(p_table text, p_name text, p_day text, p_month text default null)
returns text language sql immutable
as $$
  select format($f$
    update app.%I
       set status = 'reversed', reversed_at = now(), reversed_by = pg_temp.id('user A'),
           reversal_date = %s %s
     where id = pg_temp.id(%L) $f$,
    p_table, p_day,
    case when p_month is null then '' else ', reversal_period_month = ' || p_month end,
    p_name)
$$;

-- A payment of A on a purchase or an expense (p_table: purchase_payments or expense_payments).
create function pg_temp.payment_sql(p_table text, p_name text, p_document text, p_day text)
returns text language sql immutable
as $$
  select format($f$
    insert into app.%I (id, business_id, %I, business_date, method, amount, currency)
    values (pg_temp.id(%L), pg_temp.id('biz A'), pg_temp.id(%L), %s, 'cash', 1, 'AED') $f$,
    p_table, case p_table when 'purchase_payments' then 'purchase_id' else 'expense_id' end,
    p_name, p_document, p_day)
$$;

create function pg_temp.reverse_payment_sql(p_table text, p_name text, p_day text)
returns text language sql immutable
as $$
  select format($f$
    update app.%I set reversed_at = now(), reversed_by = pg_temp.id('user A'), reversal_date = %s
     where id = pg_temp.id(%L) $f$, p_table, p_day, p_name)
$$;

create function pg_temp.close_books_sql(p_through text)
returns text language sql immutable
as $$
  select format($f$
    update app.businesses set books_closed_through = %s where id = pg_temp.id('biz A') $f$, p_through)
$$;

insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', pg_temp.id('user A'), 'authenticated', 'authenticated',
        'aisha@example.test', now(), '{}', '{}', now(), now());

-- 1. Fixtures, the books open (37) ------------------------------------------------------------------

select is(
  pg_temp.api_exec('user A', null, $$
    select app.create_business(pg_temp.id('biz A'), 'Alpha Bakery', 'en', 'Owner',
                               pg_temp.id('biz A owner role'), pg_temp.id('biz A owner member')) $$),
  'ok 1',
  'setup: user A creates business A'
);

select is(pg_temp.a(v.stmt), 'ok 1', 'setup: ' || v.what)
  from (values
    ('a location', $$
      insert into app.locations (id, business_id, name, is_default)
      values (pg_temp.id('loc A'), pg_temp.id('biz A'), 'Main', true) $$),
    ('milk', $$
      insert into app.materials (id, business_id, name, dimension, unit)
      values (pg_temp.id('milk'), pg_temp.id('biz A'), 'Milk', 'volume', 'l') $$),
    ('a supplier', $$
      insert into app.suppliers (id, business_id, name)
      values (pg_temp.id('sup A'), pg_temp.id('biz A'), 'Dairy') $$),
    ('a category', $$
      insert into app.cost_categories (id, business_id, name)
      values (pg_temp.id('cat A'), pg_temp.id('biz A'), 'Rent') $$),
    ('a purchase the day before the closed day (to reverse)',
      pg_temp.purchase_sql('pur plain', 'pg_temp.d(-1)', 'cash')),
    ('a purchase on credit the day before (to pay)',
      pg_temp.purchase_sql('pur credit', 'pg_temp.d(-1)', 'supplier_credit')),
    ('a purchase two days before (to return and credit)',
      pg_temp.purchase_sql('pur ret', 'pg_temp.d(-2)', 'cash')),
    ('a draft purchase on the closed day', pg_temp.purchase_sql('pur on', 'pg_temp.d(0)', 'cash')),
    ('a draft purchase three days before it', pg_temp.purchase_sql('pur earlier', 'pg_temp.d(-3)', 'cash')),
    ('a draft purchase the day after it', pg_temp.purchase_sql('pur after', 'pg_temp.d(1)', 'cash')),
    ('the purchase to reverse is posted', pg_temp.post_purchase_sql('pur plain')),
    ('the purchase on credit is posted', pg_temp.post_purchase_sql('pur credit')),
    ('the purchase to return is posted', pg_temp.post_purchase_sql('pur ret')),
    ('its goods come in', pg_temp.receipt_sql('pur plain', 'pg_temp.d(-1)')),
    ('the goods on credit come in', pg_temp.receipt_sql('pur credit', 'pg_temp.d(-1)')),
    ('the goods to return come in', pg_temp.receipt_sql('pur ret', 'pg_temp.d(-2)')),
    ('a return the day before the closed day', pg_temp.return_sql('ret before', 'return', 'pg_temp.d(-1)')),
    ('a credit note the day before', pg_temp.return_sql('cn before', 'credit_note', 'pg_temp.d(-1)')),
    ('a draft return on the closed day', pg_temp.return_sql('ret on', 'return', 'pg_temp.d(0)')),
    ('a draft credit note on the closed day', pg_temp.return_sql('cn on', 'credit_note', 'pg_temp.d(0)')),
    ('a draft return the day after', pg_temp.return_sql('ret after', 'return', 'pg_temp.d(1)')),
    ('a draft credit note the day after', pg_temp.return_sql('cn after', 'credit_note', 'pg_temp.d(1)')),
    ('the return is posted', pg_temp.post_return_sql('ret before')),
    ('the credit note is posted', pg_temp.post_return_sql('cn before')),
    ('an expense the day before', pg_temp.expense_sql('exp before', 'pg_temp.d(-1)', null, 'cash')),
    ('an expense on credit the day before', pg_temp.expense_sql('exp credit', 'pg_temp.d(-1)', null, 'supplier_credit'))
  ) as v(what, stmt);

select is(pg_temp.a(v.stmt), 'ok 1', 'setup: ' || v.what)
  from (values
    ('an expense dated the last day of last month, for last month',
      pg_temp.expense_sql('exp last month', 'pg_temp.last_month_end()', null, 'cash')),
    ('a draft expense on the closed day', pg_temp.expense_sql('exp on', 'pg_temp.d(0)', null, 'cash')),
    ('a draft expense the day after', pg_temp.expense_sql('exp after', 'pg_temp.d(1)', null, 'cash')),
    ('a draft expense billed today for last month',
      pg_temp.expense_sql('exp for last month', 'current_date', 'pg_temp.month_of(pg_temp.last_month_end())', 'cash')),
    ('a draft expense billed today for this month',
      pg_temp.expense_sql('exp for this month', 'current_date', 'pg_temp.month_of(current_date)', 'cash')),
    ('the expense before is finalized', pg_temp.post_expense_sql('exp before')),
    ('the expense on credit is finalized', pg_temp.post_expense_sql('exp credit')),
    ('the expense of last month is finalized', pg_temp.post_expense_sql('exp last month')),
    ('a payment of the purchase the day before',
      pg_temp.payment_sql('purchase_payments', 'pp before', 'pur credit', 'pg_temp.d(-1)')),
    ('a payment of the expense the day before',
      pg_temp.payment_sql('expense_payments', 'ep before', 'exp credit', 'pg_temp.d(-1)'))
  ) as v(what, stmt);

-- 2. Closed through d(0): nothing on or before it is posted or reversed (19) ----------------------

select is(pg_temp.a(pg_temp.close_books_sql('pg_temp.d(0)')), 'ok 1', 'setup: the books are closed through d(0)');

select is(pg_temp.state_of(pg_temp.a(v.stmt)), 'BZ412', v.what)
  from (values
    ('a purchase dated on the closed day is not posted', pg_temp.post_purchase_sql('pur on')),
    ('a purchase dated before it is not posted', pg_temp.post_purchase_sql('pur earlier')),
    ('goods dated on the closed day do not come in', pg_temp.receipt_sql('pur on', 'pg_temp.d(0)')),
    ('goods dated before it do not come in', pg_temp.receipt_sql('pur earlier', 'pg_temp.d(-3)')),
    ('a purchase is not reversed on the closed day', pg_temp.reverse_sql('purchases', 'pur plain', 'pg_temp.d(0)')),
    ('nor on its own (closed) day', pg_temp.reverse_sql('purchases', 'pur plain', 'pg_temp.d(-1)')),
    ('a reversal movement on a closed day is not written', $$
      insert into app.stock_movements (id, business_id, business_date, location_id, material_id, kind, qty,
                                       value, purchase_line_id, reverses_id)
      values (pg_temp.id('rev plain'), pg_temp.id('biz A'), pg_temp.d(-1), pg_temp.id('loc A'),
              pg_temp.id('milk'), 'reversal', -10000, -60, pg_temp.id('line pur plain'),
              pg_temp.id('mov pur plain')) $$),
    ('a return dated on the closed day is not posted', pg_temp.post_return_sql('ret on')),
    ('a credit note dated on the closed day is not posted', pg_temp.post_return_sql('cn on')),
    ('a return is not reversed on a closed day', pg_temp.reverse_sql('purchase_returns', 'ret before', 'pg_temp.d(-1)')),
    ('a credit note is not reversed on a closed day', pg_temp.reverse_sql('purchase_returns', 'cn before', 'pg_temp.d(0)')),
    ('an expense dated on the closed day is not finalized', pg_temp.post_expense_sql('exp on')),
    ('an expense is not reversed on a closed day (even into an open month)',
      pg_temp.reverse_sql('expenses', 'exp before', 'pg_temp.d(0)', 'pg_temp.month_of(pg_temp.d(1))')),
    ('a payment of a purchase is not recorded on a closed day',
      pg_temp.payment_sql('purchase_payments', 'pp on', 'pur credit', 'pg_temp.d(0)')),
    ('a payment of a purchase is not reversed on a closed day',
      pg_temp.reverse_payment_sql('purchase_payments', 'pp before', 'pg_temp.d(0)')),
    ('a payment of an expense is not recorded on a closed day',
      pg_temp.payment_sql('expense_payments', 'ep on', 'exp credit', 'pg_temp.d(0)')),
    ('a payment of an expense is not reversed on a closed day',
      pg_temp.reverse_payment_sql('expense_payments', 'ep before', 'pg_temp.d(-1)'))
  ) as v(what, stmt);

select is(
  pg_temp.owner_state(pg_temp.post_purchase_sql('pur on')),
  'BZ412',
  'the table owner does not post on a closed day either (trigger)'
);

-- 3. After it: posted, and reversals dated the first open day (15) ------------------------------

select is(pg_temp.a(v.stmt), 'ok 1', v.what)
  from (values
    ('a purchase dated the day after is posted', pg_temp.post_purchase_sql('pur after')),
    ('its goods come in that day', pg_temp.receipt_sql('pur after', 'pg_temp.d(1)')),
    ('a purchase of a closed day is reversed on the first open day',
      pg_temp.reverse_sql('purchases', 'pur plain', 'pg_temp.d(1)')),
    ('its reversal movement is written on that day', $$
      insert into app.stock_movements (id, business_id, business_date, location_id, material_id, kind, qty,
                                       value, purchase_line_id, reverses_id)
      values (pg_temp.id('rev plain'), pg_temp.id('biz A'), pg_temp.d(1), pg_temp.id('loc A'),
              pg_temp.id('milk'), 'reversal', -10000, -60, pg_temp.id('line pur plain'),
              pg_temp.id('mov pur plain')) $$),
    ('a return dated after it is posted', pg_temp.post_return_sql('ret after')),
    ('a credit note dated after it is posted', pg_temp.post_return_sql('cn after')),
    ('a return of a closed day is reversed on the first open day',
      pg_temp.reverse_sql('purchase_returns', 'ret before', 'pg_temp.d(1)')),
    ('a credit note of a closed day likewise', pg_temp.reverse_sql('purchase_returns', 'cn before', 'pg_temp.d(1)')),
    ('an expense dated after it is finalized', pg_temp.post_expense_sql('exp after')),
    ('an expense of a closed day is reversed on the first open day',
      pg_temp.reverse_sql('expenses', 'exp before', 'pg_temp.d(1)', 'pg_temp.month_of(pg_temp.d(1))')),
    ('a payment of a purchase is recorded after it',
      pg_temp.payment_sql('purchase_payments', 'pp after', 'pur credit', 'pg_temp.d(1)')),
    ('a payment of a purchase of a closed day is reversed on the first open day',
      pg_temp.reverse_payment_sql('purchase_payments', 'pp before', 'pg_temp.d(1)')),
    ('a payment of an expense is recorded after it',
      pg_temp.payment_sql('expense_payments', 'ep after', 'exp credit', 'pg_temp.d(1)')),
    ('a payment of an expense of a closed day is reversed on the first open day',
      pg_temp.reverse_payment_sql('expense_payments', 'ep before', 'pg_temp.d(1)'))
  ) as v(what, stmt);

select is(
  pg_temp.a($$ update app.purchases set notes = 'checked' where id = pg_temp.id('pur on') $$),
  'ok 1',
  'a draft dated on the closed day is still edited: only posting and reversing are closed'
);

-- 4. Closed through the end of last month: closed months (D-200) (6) -----------------------------

select is(
  pg_temp.a(pg_temp.close_books_sql('pg_temp.last_month_end()')),
  'ok 1',
  'setup: the books are closed through the last day of last month'
);

select is(pg_temp.state_of(pg_temp.a(v.stmt)), v.state, v.what)
  from (values
    ('BZ412', 'an expense for a closed month is not finalized, though its bill is dated in the open period',
      pg_temp.post_expense_sql('exp for last month')),
    ('BZ412', 'an expense of a closed month is not reversed into it (its own month)',
      pg_temp.reverse_sql('expenses', 'exp last month', 'current_date')),
    ('BZ412', 'nor with that month named',
      pg_temp.reverse_sql('expenses', 'exp last month', 'current_date',
                          'pg_temp.month_of(pg_temp.last_month_end())')),
    ('ok 1', 'an expense for an open month is finalized', pg_temp.post_expense_sql('exp for this month')),
    ('ok 1', 'an expense of a closed month is reversed into the first open month',
      pg_temp.reverse_sql('expenses', 'exp last month', 'current_date', 'pg_temp.month_of(current_date)'))
  ) as v(state, what, stmt);

-- 5. Opened again (3) --------------------------------------------------------------------------------

select is(pg_temp.a(pg_temp.close_books_sql('null')), 'ok 1', 'setup: the books are opened again');

select is(pg_temp.a(v.stmt), 'ok 1', v.what)
  from (values
    ('a purchase of a day that was closed is posted once the books open', pg_temp.post_purchase_sql('pur on')),
    ('and an expense for a month that was closed is finalized', pg_temp.post_expense_sql('exp for last month'))
  ) as v(what, stmt);

select * from finish();
rollback;

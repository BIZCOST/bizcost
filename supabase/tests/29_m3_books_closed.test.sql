-- pgTAP: the books-closed date holds for everything Sales & Profit finalizes (M3 Step 10; D-114 rule 6,
-- D-205, D-211, D-230, D-305), as 19_books_closed_guard and 22_m2_adversary do for the Costing Core.
-- With the books closed through a day, as bizcost_api (like the API) and as the table owner (a script,
-- a migration), nothing dated on or before it is finalized, written already finalized or reversed:
--   - a sale of every source (One sale, a refund, an import's day, an order's delivery, an invoice's
--     and a credit note's sale) is posted, written posted or reversed only on an open day;
--   - a channel statement is finalized, written final or reversed only when its first day is open;
--   - a customer payment (on an order, a sale they pay later or an invoice, and money given back) is
--     dated, and reversed, only on an open day.
-- What is not a posting goes on: the fill-once costs (a material row's price, a line's cost, the
-- owner's time, a delivery cost) complete a closed month (Q5, D-230); drafts are still edited; a
-- pending order changes; an invoice whose supply day is closed is issued, its sale posting on the
-- first open day (D-305). Moving the date back opens the books again. Refused: SQLSTATE BZ412 (the
-- API's BOOKS_CLOSED). 24_sales, 25_orders_payments, 25_sale_imports and 27_invoices check parts of
-- this as bizcost_api; this file checks every table and source, also as the table owner.
begin;
select plan(81);

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

-- The day the books are closed through (`d(0)`) and days around it.
create function pg_temp.d(p_offset integer) returns date
language sql stable
as $$ select current_date - 10 + p_offset $$;
grant execute on function pg_temp.d(integer) to bizcost_api;

-- Runs p_sql as bizcost_api in business A as its owner: 'ok <row count>' or 'ERROR <sqlstate>: …'.
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

-- p_sql as the test's own role (the table owner, not bizcost_api): 'ok <row count>' or the SQLSTATE.
create function pg_temp.owner(p_sql text)
returns text
language plpgsql
as $$
declare
  v_rows bigint;
begin
  execute p_sql;
  get diagnostics v_rows = row_count;
  return 'ok ' || v_rows;
exception when others then
  return sqlstate;
end
$$;

-- A sale of A written with p_columns = p_values (its id, day and source given).
create function pg_temp.sale_sql(p_id text, p_source text, p_day integer, p_columns text default '',
                                 p_values text default '')
returns text language sql immutable
as $$
  select format($f$
    insert into app.sales (id, business_id, source, business_date, location_id, channel_id, currency,
                           created_by %s)
    values (pg_temp.id(%L), pg_temp.id('biz A'), %L, pg_temp.d(%s), pg_temp.id('loc'), pg_temp.id('chan'),
            'AED', pg_temp.id('user A') %s) $f$,
    p_columns, p_id, p_source, p_day, p_values)
$$;

-- The columns of a sale written already posted (with p_columns, p_values).
create function pg_temp.posted_sql(p_id text, p_source text, p_day integer, p_columns text default '',
                                   p_values text default '')
returns text language sql immutable
as $$
  select pg_temp.sale_sql(p_id, p_source, p_day, ', status, posted_at, posted_by' || p_columns,
                          ', ''posted'', now(), pg_temp.id(''user A'')' || p_values)
$$;

-- A customer payment of A on a document (p_column) on day p_day.
create function pg_temp.pay_sql(p_id text, p_column text, p_target text, p_day integer,
                                p_kind text default 'payment')
returns text language sql immutable
as $$
  select format($f$
    insert into app.customer_payments (id, business_id, customer_id, %I, kind, business_date, method,
                                       amount, currency, created_by)
    values (pg_temp.id(%L), pg_temp.id('biz A'), pg_temp.id('cust'), pg_temp.id(%L), %L, pg_temp.d(%s),
            'cash', 10, 'AED', pg_temp.id('user A')) $f$,
    p_column, p_id, p_target, p_kind, p_day)
$$;

-- A channel statement of A for days p_from..p_to (written with p_columns, p_values).
create function pg_temp.statement_sql(p_id text, p_from integer, p_to integer,
                                      p_columns text default '', p_values text default '')
returns text language sql immutable
as $$
  select format($f$
    insert into app.channel_statements (id, business_id, channel_id, period_from, period_to, commission,
                                        created_by %s)
    values (pg_temp.id(%L), pg_temp.id('biz A'), pg_temp.id('chan'), pg_temp.d(%s), pg_temp.d(%s), 50,
            pg_temp.id('user A') %s) $f$,
    p_columns, p_id, p_from, p_to, p_values)
$$;

create function pg_temp.finalize_sql(p_table text, p_id text)
returns text language sql immutable
as $$
  select format($f$
    update app.%I set status = 'posted', posted_at = now(), posted_by = pg_temp.id('user A')
     where id = pg_temp.id(%L) $f$, p_table, p_id)
$$;

insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', pg_temp.id('user A'), 'authenticated', 'authenticated',
        'alia-closed@example.test', now(), '{}', '{}', now(), now());

-- 1. Fixtures, while the books are open (1 + 19 = 20) ---------------------------------------------

select is(
  pg_temp.a($$
    select app.create_business(pg_temp.id('biz A'), 'Alpha Bakery', 'en', 'Owner',
                               pg_temp.id('biz A owner role'), pg_temp.id('biz A owner member')) $$),
  'ok 1',
  'setup: user A creates business A'
);

select is(pg_temp.state_of(pg_temp.a(v.stmt)), 'ok 1', 'setup: ' || v.what)
  from (values
    (1, 'a location', $$
      insert into app.locations (id, business_id, name, is_default)
      values (pg_temp.id('loc'), pg_temp.id('biz A'), 'Main', true) $$),
    (2, 'a cake', $$
      insert into app.products_services (id, business_id, name, type, unit)
      values (pg_temp.id('cake'), pg_temp.id('biz A'), 'Cake', 'product', 'piece') $$),
    (3, 'flour', $$
      insert into app.materials (id, business_id, name, dimension, unit)
      values (pg_temp.id('flour'), pg_temp.id('biz A'), 'Flour', 'mass', 'kg') $$),
    (4, 'a channel', $$
      insert into app.sales_channels (id, business_id, name, kind)
      values (pg_temp.id('chan'), pg_temp.id('biz A'), 'Shop', 'shop') $$),
    (5, 'a customer', $$
      insert into app.customers (id, business_id, name)
      values (pg_temp.id('cust'), pg_temp.id('biz A'), 'Gulf Horizon') $$),
    (6, 'a sale delivered on a day to be closed, its delivery cost not known yet', pg_temp.sale_sql(
      'filled', 'single', -2, ', delivery_needed, delivery_area', ', true, ''JLT''')),
    (7, 'its line: no price yet, the owner''s 60 minutes without a rate', $$
      insert into app.sale_lines (id, business_id, sale_id, position, kind, product_id, qty, unit_price,
                                  cost_basis, time_minutes)
      values (pg_temp.id('fline'), pg_temp.id('biz A'), pg_temp.id('filled'), 0, 'item', pg_temp.id('cake'),
              1, 150, 'recipe', 60) $$),
    (8, 'the flour it used, no price yet', $$
      insert into app.sale_line_materials (id, business_id, sale_id, sale_line_id, material_id, base_qty)
      values (pg_temp.id('fmat'), pg_temp.id('biz A'), pg_temp.id('filled'), pg_temp.id('fline'),
              pg_temp.id('flour'), 300) $$),
    (9, 'the sale is finalized', pg_temp.finalize_sql('sales', 'filled')),
    (10, 'a sale finalized on a day to be closed', pg_temp.posted_sql('to reverse', 'single', -2)),
    (11, 'a sale they pay later, finalized', pg_temp.posted_sql('pay later', 'single', -3,
      ', customer_id, pay_later', ', pg_temp.id(''cust''), true')),
    (12, 'a draft import', $$
      insert into app.sale_imports (id, business_id, channel_id, location_id, file_name, file_hash,
                                    fingerprint, shape, period_from, period_to, mapping, rows_read,
                                    row_count)
      values (pg_temp.id('imp'), pg_temp.id('biz A'), pg_temp.id('chan'), pg_temp.id('loc'), 'pos.csv',
              repeat('a', 64), repeat('f', 64), 'lines', pg_temp.d(0), pg_temp.d(0), '{}', 1, 1) $$),
    (13, 'a statement finalized for days to be closed', pg_temp.statement_sql('final', -5, -3,
      ', status, posted_at, posted_by', ', ''posted'', now(), pg_temp.id(''user A'')')),
    (14, 'a pending order', $$
      insert into app.orders (id, business_id, seq, number, customer_id, business_date, location_id,
                              channel_id, currency, total)
      values (pg_temp.id('ord'), pg_temp.id('biz A'), 1001, '#1001', pg_temp.id('cust'), pg_temp.d(-6),
              pg_temp.id('loc'), pg_temp.id('chan'), 'AED', 500) $$),
    (15, 'a deposit on it on a day to be closed', pg_temp.pay_sql('deposit', 'order_id', 'ord', -1)),
    (16, 'an invoice issued with a supply day to be closed', $$
      insert into app.invoices (id, business_id, kind, customer_id, location_id, currency, total, status,
                                seq, number, issue_date, supply_date, issued_at, issued_by, customer_name,
                                seller_name)
      values (pg_temp.id('inv'), pg_temp.id('biz A'), 'invoice', pg_temp.id('cust'), pg_temp.id('loc'),
              'AED', 400, 'issued', 1, 'INV-0001', pg_temp.d(-4), pg_temp.d(-4), now(),
              pg_temp.id('user A'), 'Gulf Horizon', 'Alpha Bakery') $$),
    (17, 'a credit note of it issued', $$
      insert into app.credit_notes (id, business_id, kind, invoice_id, customer_id, location_id,
                                    event_date, reason, reason_text, credit_by, currency, status, seq,
                                    number, issue_date, issued_at, issued_by, value_before, value_after,
                                    customer_name, seller_name, net_total, total)
      values (pg_temp.id('cn'), pg_temp.id('biz A'), 'credit_note', pg_temp.id('inv'), pg_temp.id('cust'),
              pg_temp.id('loc'), pg_temp.d(-1), 'price_changed', 'Price cut', 'amount', 'AED', 'issued', 1,
              'CN-0001', pg_temp.d(-1), now(), pg_temp.id('user A'), 400, 350, 'Gulf Horizon',
              'Alpha Bakery', 50, 50) $$),
    (18, 'a draft invoice whose supply day is to be closed', $$
      insert into app.invoices (id, business_id, kind, customer_id, location_id, currency, total)
      values (pg_temp.id('inv2'), pg_temp.id('biz A'), 'invoice', pg_temp.id('cust'), pg_temp.id('loc'),
              'AED', 100) $$),
    (19, 'the books are closed through d(0)', $$
      update app.businesses set books_closed_through = pg_temp.d(0) where id = pg_temp.id('biz A') $$)
  ) as v(n, what, stmt)
 order by v.n;

-- Drafts entered once the books are closed (5).
select is(pg_temp.state_of(pg_temp.a(v.stmt)), 'ok 1', 'setup: ' || v.what)
  from (values
    (1, 'a draft sale dated the closed day', pg_temp.sale_sql('draft closed', 'single', 0)),
    (2, 'a draft sale dated the first open day', pg_temp.sale_sql('draft open', 'single', 1)),
    (3, 'another, for the table owner', pg_temp.sale_sql('draft open 2', 'single', 1)),
    (4, 'a draft statement whose first day is closed', pg_temp.statement_sql('draft st', 0, 5)),
    (5, 'a draft statement of open days', pg_temp.statement_sql('draft st open', 6, 8))
  ) as v(n, what, stmt)
 order by v.n;

-- 2. Refused on or before the date, as bizcost_api and as the table owner (2 × 18 = 36) ----------

create temp table attempts (n integer, what text, stmt text);
insert into attempts values
  (1, 'a draft sale of the closed day is not finalized', pg_temp.finalize_sql('sales', 'draft closed')),
  (2, 'a sale is not written already finalized on the closed day', pg_temp.posted_sql('x1', 'single', 0)),
  (3, 'nor already reversed when its day is closed', pg_temp.sale_sql('x2', 'single', -1,
    ', status, posted_at, posted_by, reversed_at, reversed_by, reversal_business_date',
    ', ''reversed'', now(), pg_temp.id(''user A''), now(), pg_temp.id(''user A''), pg_temp.d(1)')),
  (4, 'nor reversed on the closed day', pg_temp.sale_sql('x3', 'single', 1,
    ', status, posted_at, posted_by, reversed_at, reversed_by, reversal_business_date',
    ', ''reversed'', now(), pg_temp.id(''user A''), now(), pg_temp.id(''user A''), pg_temp.d(0)')),
  (5, 'a finalized sale is not reversed on the closed day', $$
    update app.sales
       set status = 'reversed', reversed_at = now(), reversed_by = pg_temp.id('user A'),
           reversal_business_date = pg_temp.d(0)
     where id = pg_temp.id('to reverse') $$),
  (6, 'a refund is not finalized on the closed day', pg_temp.posted_sql('x4', 'refund', 0,
    ', customer_id, refund_of_id, refund_by',
    ', pg_temp.id(''cust''), pg_temp.id(''pay later''), ''amount''')),
  (7, 'an import''s day is not finalized when closed', pg_temp.posted_sql('x5', 'import', 0,
    ', import_id', ', pg_temp.id(''imp'')')),
  (8, 'an order is not delivered on the closed day (its sale)', pg_temp.posted_sql('x6', 'order', 0,
    ', customer_id, order_id', ', pg_temp.id(''cust''), pg_temp.id(''ord'')')),
  (9, 'an invoice''s sale is not posted on the closed day', pg_temp.posted_sql('x7', 'invoice', 0,
    ', customer_id, invoice_id', ', pg_temp.id(''cust''), pg_temp.id(''inv'')')),
  (10, 'nor a credit note''s', pg_temp.posted_sql('x8', 'credit_note', 0,
    ', customer_id, credit_note_id, refund_by', ', pg_temp.id(''cust''), pg_temp.id(''cn''), ''amount''')),
  (11, 'a statement whose first day is closed is not finalized', pg_temp.finalize_sql('channel_statements',
    'draft st')),
  (12, 'a statement is not written finalized for closed days', pg_temp.statement_sql('x9', -9, -8,
    ', status, posted_at, posted_by', ', ''posted'', now(), pg_temp.id(''user A'')')),
  (13, 'a finalized statement of closed days is not reversed', $$
    update app.channel_statements
       set status = 'reversed', reversed_at = now(), reversed_by = pg_temp.id('user A')
     where id = pg_temp.id('final') $$),
  (14, 'a payment of an order is not dated the closed day', pg_temp.pay_sql('x10', 'order_id', 'ord', 0)),
  (15, 'nor a payment of an invoice', pg_temp.pay_sql('x11', 'invoice_id', 'inv', 0)),
  (16, 'nor of a sale they pay later', pg_temp.pay_sql('x12', 'sale_id', 'pay later', 0)),
  (17, 'nor money given back', pg_temp.pay_sql('x13', 'order_id', 'ord', -1, 'refund')),
  (18, 'a payment is not reversed on the closed day', $$
    update app.customer_payments
       set reversed_at = now(), reversed_by = pg_temp.id('user A'), reversal_date = pg_temp.d(0)
     where id = pg_temp.id('deposit') $$);

select is(
  case i.who when 'bizcost_api' then pg_temp.state_of(pg_temp.a(t.stmt)) else pg_temp.owner(t.stmt) end,
  'BZ412',
  t.what || ' (' || i.who || ')'
)
  from attempts t
 cross join (values (1, 'bizcost_api'), (2, 'table owner')) as i(k, who)
 order by t.n, i.k;

-- 3. What is not a posting goes on; the first open day is open (as bizcost_api) (17) -------------

select is(pg_temp.state_of(pg_temp.a(v.stmt)), 'ok 1', v.what)
  from (values
    (1, 'the flour''s price completes the closed day''s sale (fill once, Q5)', $$
      update app.sale_line_materials set unit_cost = 0.004, cost = 1.2, basis = 'first_purchase'
       where id = pg_temp.id('fmat') $$),
    (2, 'and so does its line''s cost', $$
      update app.sale_lines set cost = 1.2 where id = pg_temp.id('fline') $$),
    (3, 'and the owner''s time, once the rate is set', $$
      update app.sale_lines set time_cost = 40 where id = pg_temp.id('fline') $$),
    (4, 'and what the delivery cost (D-230)', $$
      update app.sales set delivery_cost = 25 where id = pg_temp.id('filled') $$),
    (5, 'a draft sale of the closed day is still edited', $$
      update app.sales set notes = 'counted again' where id = pg_temp.id('draft closed') $$),
    (6, 'a draft statement of closed days is still edited', $$
      update app.channel_statements set commission = 60 where id = pg_temp.id('draft st') $$),
    (7, 'a pending order of a closed day still changes', $$
      update app.orders set notes = 'Two tiers' where id = pg_temp.id('ord') $$),
    (8, 'an invoice whose supply day is closed is issued (D-305)', $$
      update app.invoices
         set status = 'issued', seq = 2, number = 'INV-0002', issue_date = pg_temp.d(1),
             supply_date = pg_temp.d(0), issued_at = now(), issued_by = pg_temp.id('user A'),
             customer_name = 'Gulf Horizon', seller_name = 'Alpha Bakery'
       where id = pg_temp.id('inv2') $$),
    (9, 'and its sale posts on the first open day', pg_temp.posted_sql('inv2 sale', 'invoice', 1,
      ', customer_id, invoice_id', ', pg_temp.id(''cust''), pg_temp.id(''inv2'')')),
    (10, 'a draft sale of the first open day is finalized', pg_temp.finalize_sql('sales', 'draft open')),
    (11, 'a finalized sale is reversed on the first open day', $$
      update app.sales
         set status = 'reversed', reversed_at = now(), reversed_by = pg_temp.id('user A'),
             reversal_business_date = pg_temp.d(1)
       where id = pg_temp.id('to reverse') $$),
    (12, 'a refund is finalized on the first open day', pg_temp.posted_sql('refund', 'refund', 1,
      ', customer_id, refund_of_id, refund_by',
      ', pg_temp.id(''cust''), pg_temp.id(''pay later''), ''amount''')),
    (13, 'a statement of open days is finalized', pg_temp.finalize_sql('channel_statements',
      'draft st open')),
    (14, 'a payment of the order on the first open day', pg_temp.pay_sql('pay open', 'order_id', 'ord', 1)),
    (15, 'a payment of the invoice on the first open day', pg_temp.pay_sql('pay inv', 'invoice_id', 'inv',
      1)),
    (16, 'a payment of a closed day is reversed on the first open day', $$
      update app.customer_payments
         set reversed_at = now(), reversed_by = pg_temp.id('user A'), reversal_date = pg_temp.d(1)
       where id = pg_temp.id('deposit') $$)
  ) as v(n, what, stmt)
 order by v.n;

select is(pg_temp.owner(pg_temp.finalize_sql('sales', 'draft open 2')), 'ok 1',
          'the table owner finalizes a sale of the first open day too');

-- 4. Moving the date back opens the books again (3) -----------------------------------------------

select is(pg_temp.owner($$
  update app.businesses set books_closed_through = pg_temp.d(-10) where id = pg_temp.id('biz A') $$),
  'ok 1', 'the books are closed through an earlier day');
select is(pg_temp.state_of(pg_temp.a(pg_temp.finalize_sql('sales', 'draft closed'))), 'ok 1',
          'the sale of the day opened again is finalized');
select is(pg_temp.state_of(pg_temp.a(pg_temp.finalize_sql('channel_statements', 'draft st'))), 'ok 1',
          'and so is the statement');

select * from finish();
rollback;

-- pgTAP: Customers, Orders with delivery, customer payments, refunds (M3 Step 5; migrations
-- orders_tables, orders_security and refund_delivery_line; DECISIONS.md from D-263). As bizcost_api,
-- like the API:
--   - the five new tables are isolated between businesses and link only within one (composite
--     foreign keys: an order's customer, location, channel and sale; a line's order and product; a
--     payment's customer, order and sale; a sale's customer, order and the sale it refunds; a refund
--     line's line; an order's file through check_attachment_target);
--   - their CHECKs: value lists, a trade licence only for a business or government, an emirate only in
--     the UAE, a delivered or cancelled order with its columns, a payment on one document, a sale's
--     customer, "they'll pay later", its order and its refund;
--   - numbering: one order per number (UNIQUE business_id, seq), one counter per series, which only
--     moves forward; counters and customers are never deleted (a customer is archived);
--   - an order changes only while pending (its lines likewise); delivered, it only goes back to
--     pending (Undo delivery), taking back the delivery cost filled on its sale when it had none
--     (migration order_undo_keeps_delivery_cost, D-273), and its reversed sale takes no delivery cost
--     after it (undone_order_sale_takes_no_cost, D-273); cancelled, it never changes again; an order
--     with payments keeps its customer; one live sale per order (a reversed one frees it);
--   - customer payments: recorded on what is owed (a pending or delivered order, money given back on
--     any order, a finalized sale they pay later), never edited or deleted, only reversed; a sale with
--     payments or refunds that stand is not reversed;
--   - the books-closed date for customer payments; touch and audit triggers.
-- The template keys given to existing roles (the migration's backfill) are checked by
-- packages/modules (role-templates) and the API suites on fresh businesses.
begin;
select plan(140);

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
-- database never checks a day against today (the API does), so the days here are fixed.
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

-- The same sale, posted by A's owner.
create function pg_temp.posted_sql(p_id text, p_extra_columns text, p_extra_values text,
                                   p_source text default 'single')
returns text language sql immutable
as $$
  select pg_temp.sale_sql(p_id, p_extra_columns || ', status, posted_at, posted_by',
                          p_extra_values || ', ''posted'', now(), pg_temp.id(''user A'')', p_source)
$$;

-- An order of A for A's customer, on 20 January 2026: number '#<seq>'.
create function pg_temp.order_sql(p_id text, p_seq int, p_extra_columns text default '',
                                  p_extra_values text default '')
returns text language sql immutable
as $$
  select format($f$
    insert into app.orders (id, business_id, seq, number, customer_id, business_date, location_id,
                            channel_id, currency %s)
    values (pg_temp.id(%L), pg_temp.id('biz A'), %s, %L, pg_temp.id('cust A'), date '2026-01-20',
            pg_temp.id('loc A'), pg_temp.id('chan A'), 'AED' %s) $f$,
    p_extra_columns, p_id, p_seq, '#' || p_seq, p_extra_values)
$$;

-- A delivers its order with the given sale (its delivery columns, plus p_extra).
create function pg_temp.deliver_sql(p_order text, p_sale text, p_extra text default '')
returns text language sql immutable
as $$
  select format($f$
    update app.orders set status = 'delivered', delivered_on = date '2026-01-20',
                          sale_id = pg_temp.id(%L), delivered_at = now(),
                          delivered_by = pg_temp.id('user A') %s
     where id = pg_temp.id(%L) $f$,
    p_sale, p_extra, p_order)
$$;

-- A payment of 50 in cash by A's customer on an order or a sale (p_column), on the given day.
create function pg_temp.pay_sql(p_id text, p_column text, p_target text,
                                p_kind text default 'payment', p_day text default '2026-01-20',
                                p_extra_columns text default '', p_extra_values text default '')
returns text language sql immutable
as $$
  select format($f$
    insert into app.customer_payments (id, business_id, customer_id, %I, kind, business_date, method,
                                       amount, currency %s)
    values (pg_temp.id(%L), pg_temp.id('biz A'), pg_temp.id('cust A'), pg_temp.id(%L), %L,
            date %L, 'cash', 50, 'AED' %s) $f$,
    p_column, p_extra_columns, p_id, p_target, p_kind, p_day, p_extra_values)
$$;

-- A sale reversed on the given day.
create function pg_temp.reverse_sql(p_sale text, p_day text default '2026-01-20')
returns text language sql immutable
as $$
  select format($f$
    update app.sales set status = 'reversed', reversed_at = now(), reversed_by = pg_temp.id('user A'),
                         reversal_business_date = date %L
     where id = pg_temp.id(%L) $f$,
    p_day, p_sale)
$$;

insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', pg_temp.id('user A'), 'authenticated',
        'authenticated', 'amna-orders@example.test', now(), '{}', '{}', now(), now()),
       ('00000000-0000-0000-0000-000000000000', pg_temp.id('user B'), 'authenticated',
        'authenticated', 'bilal-orders@example.test', now(), '{}', '{}', now(), now());

-- 1. Columns and keys (5) -----------------------------------------------------------------------

select has_index('app', 'orders', 'orders_seq_key', 'one order per number of a business');
select has_index('app', 'document_counters', 'document_counters_series_key',
                 'one counter per series of a business');
select has_index('app', 'sales', 'sales_order_key', 'one live sale per order');
select col_type_is('app', 'customer_payments', 'amount', 'numeric(20,4)',
                   'a customer''s payment is a money amount');
select col_type_is('app', 'orders', 'seq', 'integer', 'an order''s number is a counter''s integer');

-- 2. Fixtures (24) ------------------------------------------------------------------------------

select is(
  pg_temp.api_value(v.u, null, format($f$
    select app.create_business(pg_temp.id(%L), %L, 'en', 'Owner',
                               pg_temp.id(%L), pg_temp.id(%L)) $f$,
    v.b, v.name, v.b || ' owner role', v.b || ' owner member')),
  pg_temp.id(v.b)::text,
  'setup: ' || v.u || ' creates ' || v.b
)
  from (values ('user A', 'biz A', 'Alpha Bakery'), ('user B', 'biz B', 'Beta Bakery')) as v(u, b, name);

select is(pg_temp.api_exec(v.u, v.b, v.stmt), 'ok 1', 'setup: ' || v.what)
  from (values
    (1, 'user A', 'biz A', 'a location of A', $$
      insert into app.locations (id, business_id, name, is_default)
      values (pg_temp.id('loc A'), pg_temp.id('biz A'), 'Main', true) $$),
    (2, 'user A', 'biz A', 'a channel of A', $$
      insert into app.sales_channels (id, business_id, name, kind)
      values (pg_temp.id('chan A'), pg_temp.id('biz A'), 'Shop', 'shop') $$),
    (3, 'user A', 'biz A', 'a product of A', $$
      insert into app.products_services (id, business_id, name, type, unit, default_price)
      values (pg_temp.id('cake A'), pg_temp.id('biz A'), 'Cake', 'product', 'piece', 170) $$),
    (4, 'user A', 'biz A', 'a customer of A', $$
      insert into app.customers (id, business_id, name, phone)
      values (pg_temp.id('cust A'), pg_temp.id('biz A'), 'Mariam', '050 123 4567') $$),
    (5, 'user A', 'biz A', 'another customer of A', $$
      insert into app.customers (id, business_id, name, kind, trn, trade_licence_no, emirate)
      values (pg_temp.id('cust A2'), pg_temp.id('biz A'), 'Gulf Events', 'business',
              '100000000000003', 'TL-881', 'dubai') $$),
    (6, 'user A', 'biz A', 'A''s order counter', $$
      insert into app.document_counters (id, business_id, series, next_no, prefix)
      values (pg_temp.id('ctr A'), pg_temp.id('biz A'), 'order', 1003, '#') $$),
    (7, 'user A', 'biz A', 'order #1001 of A', pg_temp.order_sql('ord A', 1001)),
    (8, 'user A', 'biz A', 'its line', $$
      insert into app.order_lines (id, business_id, order_id, position, kind, product_id, qty, unit,
                                   unit_price)
      values (pg_temp.id('oline A'), pg_temp.id('biz A'), pg_temp.id('ord A'), 0, 'item',
              pg_temp.id('cake A'), 1, 'piece', 170) $$),
    (9, 'user A', 'biz A', 'order #1002 of A', pg_temp.order_sql('ord C', 1002)),
    (10, 'user A', 'biz A', 'its line', $$
      insert into app.order_lines (id, business_id, order_id, position, kind, product_id, qty,
                                   unit_price)
      values (pg_temp.id('oline C'), pg_temp.id('biz A'), pg_temp.id('ord C'), 0, 'item',
              pg_temp.id('cake A'), 2, 170) $$),
    (11, 'user A', 'biz A', 'a finalized sale they pay later', pg_temp.posted_sql('later A',
      ', customer_id, pay_later', ', pg_temp.id(''cust A''), true')),
    (12, 'user A', 'biz A', 'a finalized sale paid at once', pg_temp.posted_sql('cash A', '', '')),
    (13, 'user A', 'biz A', 'a draft sale they will pay later', pg_temp.sale_sql('later draft',
      ', customer_id, pay_later', ', pg_temp.id(''cust A''), true')),
    (14, 'user A', 'biz A', 'a supplier', $$
      insert into app.suppliers (id, business_id, name)
      values (pg_temp.id('sup A'), pg_temp.id('biz A'), 'Dairy') $$),
    (15, 'user A', 'biz A', 'a purchase on credit, posted', $$
      insert into app.purchases (id, business_id, supplier_id, location_id, business_date,
                                 document_type, payment_method, currency, status, posted_at,
                                 posted_by, vat_in_cost, cost_total)
      values (pg_temp.id('pur A'), pg_temp.id('biz A'), pg_temp.id('sup A'), pg_temp.id('loc A'),
              date '2026-01-20', 'no_invoice', 'supplier_credit', 'AED', 'posted', now(),
              pg_temp.id('user A'), true, 50) $$),
    (16, 'user B', 'biz B', 'a location of B', $$
      insert into app.locations (id, business_id, name, is_default)
      values (pg_temp.id('loc B'), pg_temp.id('biz B'), 'Main', true) $$),
    (17, 'user B', 'biz B', 'a channel of B', $$
      insert into app.sales_channels (id, business_id, name, kind)
      values (pg_temp.id('chan B'), pg_temp.id('biz B'), 'Shop', 'shop') $$),
    (18, 'user B', 'biz B', 'a product of B', $$
      insert into app.products_services (id, business_id, name, type, unit)
      values (pg_temp.id('cake B'), pg_temp.id('biz B'), 'Cake', 'product', 'piece') $$),
    (19, 'user B', 'biz B', 'a customer of B', $$
      insert into app.customers (id, business_id, name)
      values (pg_temp.id('cust B'), pg_temp.id('biz B'), 'Badria') $$),
    (20, 'user B', 'biz B', 'B''s own order #1001 (numbers are per business)', $$
      insert into app.orders (id, business_id, seq, number, customer_id, business_date, location_id,
                              channel_id, currency)
      values (pg_temp.id('ord B'), pg_temp.id('biz B'), 1001, '#1001', pg_temp.id('cust B'),
              date '2026-01-20', pg_temp.id('loc B'), pg_temp.id('chan B'), 'AED') $$),
    (21, 'user B', 'biz B', 'a draft sale of B', $$
      insert into app.sales (id, business_id, source, business_date, location_id, channel_id,
                             currency)
      values (pg_temp.id('sale B'), pg_temp.id('biz B'), 'single', date '2026-01-20',
              pg_temp.id('loc B'), pg_temp.id('chan B'), 'AED') $$),
    (22, 'user B', 'biz B', 'a line of it', $$
      insert into app.sale_lines (id, business_id, sale_id, position, kind, product_id, qty,
                                  unit_price)
      values (pg_temp.id('sline B'), pg_temp.id('biz B'), pg_temp.id('sale B'), 0, 'item',
              pg_temp.id('cake B'), 1, 10) $$)
  ) as v(n, u, b, what, stmt)
 order by v.n;

-- 3. Isolation and links (15) -------------------------------------------------------------------

select is(
  pg_temp.api_value('user B', 'biz B', $$
    select (select count(*) from app.customers where business_id = pg_temp.id('biz A'))
         + (select count(*) from app.document_counters where business_id = pg_temp.id('biz A'))
         + (select count(*) from app.orders where business_id = pg_temp.id('biz A'))
         + (select count(*) from app.order_lines where business_id = pg_temp.id('biz A'))
         + (select count(*) from app.customer_payments where business_id = pg_temp.id('biz A')) $$),
  '0',
  'B sees none of A''s customers, counters, orders, lines or payments (RLS)'
);

select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', v.stmt)), '23503', v.what)
  from (values
    (1, 'an order never names another business''s customer', $$
      update app.orders set customer_id = pg_temp.id('cust B') where id = pg_temp.id('ord A') $$),
    (2, 'nor its location', $$
      update app.orders set location_id = pg_temp.id('loc B') where id = pg_temp.id('ord A') $$),
    (3, 'nor its channel', $$
      update app.orders set channel_id = pg_temp.id('chan B') where id = pg_temp.id('ord A') $$),
    (4, 'nor is it delivered by another business''s sale', pg_temp.deliver_sql('ord A', 'sale B')),
    (5, 'an order line never names another business''s product', $$
      insert into app.order_lines (id, business_id, order_id, position, kind, product_id, qty,
                                   unit_price)
      values (pg_temp.id('x line'), pg_temp.id('biz A'), pg_temp.id('ord A'), 1, 'item',
              pg_temp.id('cake B'), 1, 1) $$),
    (6, 'nor another business''s order (composite keys from B''s ids)', $$
      insert into app.order_lines (id, business_id, order_id, position, kind, product_id, qty,
                                   unit_price)
      values (pg_temp.id('x line 2'), pg_temp.id('biz A'), pg_temp.id('ord B'), 0, 'item',
              pg_temp.id('cake A'), 1, 1) $$),
    (7, 'a payment never names another business''s order', pg_temp.pay_sql('x pay', 'order_id',
      'ord B')),
    (8, 'nor its sale', pg_temp.pay_sql('x pay 2', 'sale_id', 'sale B')),
    (9, 'nor its customer', $$
      insert into app.customer_payments (id, business_id, customer_id, order_id, business_date,
                                         method, amount, currency)
      values (pg_temp.id('x pay 3'), pg_temp.id('biz A'), pg_temp.id('cust B'), pg_temp.id('ord A'),
              date '2026-01-20', 'cash', 5, 'AED') $$),
    (10, 'a sale never names another business''s customer', $$
      update app.sales set customer_id = pg_temp.id('cust B') where id = pg_temp.id('later draft') $$),
    (11, 'nor its order', pg_temp.sale_sql('x order sale', ', order_id', ', pg_temp.id(''ord B'')',
      'order')),
    (12, 'a refund never refunds another business''s sale', pg_temp.sale_sql('x refund',
      ', refund_of_id, refund_by', ', pg_temp.id(''sale B''), ''amount''', 'refund')),
    (13, 'a refund line never names another business''s line', $$
      insert into app.sale_lines (id, business_id, sale_id, position, kind, product_id, qty,
                                  unit_price, refund_of_line_id)
      values (pg_temp.id('x sline'), pg_temp.id('biz A'), pg_temp.id('later draft'), 0, 'item',
              pg_temp.id('cake A'), 1, 1, pg_temp.id('sline B')) $$),
    (14, 'an order''s file never names another business''s order (check_target)', $$
      insert into app.attachments (id, business_id, entity, entity_id, path, file_name, content_type,
                                   size_bytes)
      values (pg_temp.id('x file'), pg_temp.id('biz A'), 'order', pg_temp.id('ord B'),
              pg_temp.id('biz A') || '/order/lpo.pdf', 'lpo.pdf', 'application/pdf', 10) $$)
  ) as v(n, what, stmt)
 order by v.n;

-- 4. CHECKs (23) --------------------------------------------------------------------------------

select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', v.stmt)), '23514', v.what)
  from (values
    (1, 'a customer kind from the list', $$
      update app.customers set kind = 'robot' where id = pg_temp.id('cust A') $$),
    (2, 'a trade licence only for a business or a government body', $$
      update app.customers set trade_licence_no = 'TL-1' where id = pg_temp.id('cust A') $$),
    (3, 'an emirate only in the UAE', $$
      update app.customers set country = 'SA' where id = pg_temp.id('cust A2') $$),
    (4, 'a TRN of 15 digits', $$
      update app.customers set trn = '123' where id = pg_temp.id('cust A') $$),
    (5, 'a series from the list', $$
      insert into app.document_counters (id, business_id, series, next_no, prefix)
      values (pg_temp.id('x ctr'), pg_temp.id('biz A'), 'quote', 1, 'Q') $$),
    (6, 'a number''s padding of at most 12 digits', $$
      update app.document_counters set padding = 13 where id = pg_temp.id('ctr A') $$),
    (7, 'an order status from the list', pg_temp.order_sql('x status', 1010, ', status',
      ', ''shipped''')),
    (8, 'an order is due on or after its day', $$
      update app.orders set due_date = date '2026-01-19' where id = pg_temp.id('ord A') $$),
    (9, 'a delivery area only with delivery', $$
      update app.orders set delivery_area = 'JLT' where id = pg_temp.id('ord A') $$),
    (10, 'a delivered order has its day, sale and who delivered it', $$
      update app.orders set status = 'delivered' where id = pg_temp.id('ord A') $$),
    (11, 'a cancel reason only on a cancelled order', $$
      update app.orders set cancel_reason = 'Changed mind' where id = pg_temp.id('ord A') $$),
    (12, 'an ordered quantity is more than 0', $$
      update app.order_lines set qty = 0 where id = pg_temp.id('oline A') $$),
    (13, 'a delivery line is 1, without a unit or discount', $$
      insert into app.order_lines (id, business_id, order_id, position, kind, qty, unit_price)
      values (pg_temp.id('x delivery'), pg_temp.id('biz A'), pg_temp.id('ord A'), 1, 'delivery', 2,
              10) $$),
    (14, 'a payment is more than 0', $$
      insert into app.customer_payments (id, business_id, customer_id, order_id, business_date,
                                         method, amount, currency)
      values (pg_temp.id('x zero'), pg_temp.id('biz A'), pg_temp.id('cust A'), pg_temp.id('ord A'),
              date '2026-01-20', 'cash', 0, 'AED') $$),
    (15, 'a payment is on one document: an order or a sale', pg_temp.pay_sql('x both', 'order_id',
      'ord A', 'payment', '2026-01-20', ', sale_id', ', pg_temp.id(''later A'')')),
    (16, 'a payment method from the list', $$
      insert into app.customer_payments (id, business_id, customer_id, order_id, business_date,
                                         method, amount, currency)
      values (pg_temp.id('x method'), pg_temp.id('biz A'), pg_temp.id('cust A'), pg_temp.id('ord A'),
              date '2026-01-20', 'crypto', 5, 'AED') $$),
    (17, 'a customer only on one sale, an order''s sale or a refund', pg_temp.sale_sql('x sheet',
      ', customer_id', ', pg_temp.id(''cust A'')', 'day_sheet')),
    (18, '"They''ll pay later" only on one sale with its customer', $$
      update app.sales set customer_id = null where id = pg_temp.id('later draft') $$),
    (19, 'an order''s sale names its order', pg_temp.sale_sql('x order', '', '', 'order')),
    (20, 'a refund names the sale it refunds and how', pg_temp.sale_sql('x refund 2',
      ', refund_of_id', ', pg_temp.id(''cash A'')', 'refund')),
    (21, 'a refund never refunds itself', pg_temp.sale_sql('x self', ', refund_of_id, refund_by',
      ', pg_temp.id(''x self''), ''amount''', 'refund')),
    (22, 'only money back from a supplier names the member who received it', $$
      insert into app.purchase_payments (id, business_id, purchase_id, business_date, method, amount,
                                         currency, kind, received_by_member_id)
      values (pg_temp.id('x pp'), pg_temp.id('biz A'), pg_temp.id('pur A'), date '2026-01-20',
              'cash', 1, 'AED', 'payment', pg_temp.id('biz A owner member')) $$),
    (23, 'a supplier payment''s kind from the list', $$
      insert into app.purchase_payments (id, business_id, purchase_id, business_date, method, amount,
                                         currency, kind)
      values (pg_temp.id('x pp 2'), pg_temp.id('biz A'), pg_temp.id('pur A'), date '2026-01-20',
              'cash', 1, 'AED', 'gift') $$)
  ) as v(n, what, stmt)
 order by v.n;

-- 5. Numbering; counters and customers are never deleted (12) ------------------------------------

select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', v.stmt)), v.state, v.what)
  from (values
    (1, '23505', 'one order per number', pg_temp.order_sql('x dup', 1001)),
    (2, '23505', 'one counter per series', $$
      insert into app.document_counters (id, business_id, series, next_no, prefix)
      values (pg_temp.id('x ctr 2'), pg_temp.id('biz A'), 'order', 1, '#') $$),
    (3, '23514', 'a counter never goes back (a number given is never given again)', $$
      update app.document_counters set next_no = 1000 where id = pg_temp.id('ctr A') $$),
    (4, 'ok 1', 'it moves forward', $$
      update app.document_counters set next_no = next_no + 1 where id = pg_temp.id('ctr A') $$),
    (5, '23001', 'a counter is never deleted', $$
      delete from app.document_counters where id = pg_temp.id('ctr A') $$),
    (6, '23001', 'nor soft-deleted', $$
      update app.document_counters set deleted_at = now() where id = pg_temp.id('ctr A') $$),
    (7, '23001', 'a customer is never deleted', $$
      delete from app.customers where id = pg_temp.id('cust A2') $$),
    (8, '23001', 'nor soft-deleted', $$
      update app.customers set deleted_at = now() where id = pg_temp.id('cust A2') $$),
    (9, 'ok 1', 'a customer is archived', $$
      update app.customers set archived_at = now() where id = pg_temp.id('cust A2') $$),
    (10, '23514', 'an order keeps its number', $$
      update app.orders set number = '#9' where id = pg_temp.id('ord C') $$),
    (11, '23514', 'an order is never soft-deleted', $$
      update app.orders set deleted_at = now() where id = pg_temp.id('ord C') $$),
    (12, '23001', 'nor deleted (a pending order is cancelled)', $$
      delete from app.orders where id = pg_temp.id('ord C') $$)
  ) as v(n, state, what, stmt)
 order by v.n;

-- 6. An order changes only while pending (39) ----------------------------------------------------

select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', v.stmt)), v.state, v.what)
  from (values
    (1, 'ok 1', 'a pending order changes', $$
      update app.orders set notes = 'Birthday, blue icing', delivery_needed = true
       where id = pg_temp.id('ord A') $$),
    (2, 'ok 1', 'its lines change', $$
      update app.order_lines set qty = 2 where id = pg_temp.id('oline A') $$),
    (3, 'ok 1', 'a line is added', $$
      insert into app.order_lines (id, business_id, order_id, position, kind, qty, unit_price)
      values (pg_temp.id('oline A2'), pg_temp.id('biz A'), pg_temp.id('ord A'), 1, 'delivery', 1,
              10) $$),
    (4, '23514', 'a line never moves to another order', $$
      update app.order_lines set order_id = pg_temp.id('ord C') where id = pg_temp.id('oline A2') $$),
    (5, '23001', 'a line is never deleted (it is taken out)', $$
      delete from app.order_lines where id = pg_temp.id('oline A2') $$),
    (6, 'ok 1', 'setup: a deposit on it', pg_temp.pay_sql('dep A', 'order_id', 'ord A')),
    (7, '23514', 'an order with payments keeps its customer', $$
      update app.orders set customer_id = pg_temp.id('cust A2') where id = pg_temp.id('ord A') $$),
    (8, 'ok 1', 'setup: its sale, posted (what the delivery cost filled on it later: 25)',
      pg_temp.posted_sql('osale A', ', order_id, customer_id, delivery_needed, delivery_cost',
        ', pg_temp.id(''ord A''), pg_temp.id(''cust A''), true, 25', 'order')),
    (9, '23001', 'becoming delivered changes nothing else (its amounts were saved while pending)',
      pg_temp.deliver_sql('ord A', 'osale A', ', total = 999')),
    (10, 'ok 1', 'it is delivered', pg_temp.deliver_sql('ord A', 'osale A')),
    (11, '23001', 'a delivered order is never edited', $$
      update app.orders set notes = 'changed' where id = pg_temp.id('ord A') $$),
    (12, '23001', 'its lines never change', $$
      update app.order_lines set qty = 3 where id = pg_temp.id('oline A') $$),
    (13, '23001', 'no line is added to it', $$
      insert into app.order_lines (id, business_id, order_id, position, kind, product_id, qty,
                                   unit_price)
      values (pg_temp.id('late line'), pg_temp.id('biz A'), pg_temp.id('ord A'), 2, 'item',
              pg_temp.id('cake A'), 1, 1) $$),
    (14, '23505', 'one live sale per order', pg_temp.sale_sql('osale dup', ', order_id',
      ', pg_temp.id(''ord A'')', 'order')),
    (15, 'ok 1', 'setup: its sale reversed (Undo delivery)', pg_temp.reverse_sql('osale A')),
    (16, '23001', 'undoing the delivery changes nothing else', $$
      update app.orders set status = 'pending', delivered_on = null, sale_id = null,
                            delivered_at = null, delivered_by = null, notes = 'changed'
       where id = pg_temp.id('ord A') $$),
    (17, '23001', 'undoing never takes a delivery cost other than its sale''s', $$
      update app.orders set status = 'pending', delivered_on = null, sale_id = null,
                            delivered_at = null, delivered_by = null, delivery_cost = 7
       where id = pg_temp.id('ord A') $$),
    (18, 'ok 1', 'pending again: delivery columns cleared, its sale''s delivery cost taken back', $$
      update app.orders set status = 'pending', delivered_on = null, sale_id = null,
                            delivered_at = null, delivered_by = null, delivery_cost = 25
       where id = pg_temp.id('ord A') $$),
    (19, 'ok 1', 'the reversed sale frees the order: a new sale of it', pg_temp.posted_sql('osale A2',
      ', order_id, customer_id', ', pg_temp.id(''ord A''), pg_temp.id(''cust A'')', 'order')),
    (20, 'ok 1', 'delivered again', pg_temp.deliver_sql('ord A', 'osale A2')),
    (21, 'ok 1', 'a refund of what was delivered (by amount)', pg_temp.posted_sql('refund A',
      ', order_id, customer_id, refund_of_id, refund_by',
      ', pg_temp.id(''ord A''), pg_temp.id(''cust A''), pg_temp.id(''osale A2''), ''amount''',
      'refund')),
    (22, '23514', 'a sale with refunds is not reversed', pg_temp.reverse_sql('osale A2')),
    (23, 'ok 1', 'setup: a deposit on the other order', pg_temp.pay_sql('dep C', 'order_id',
      'ord C')),
    (24, '23001', 'cancelling changes nothing else', $$
      update app.orders set status = 'cancelled', cancelled_at = now(),
                            cancelled_by = pg_temp.id('user A'), notes = 'changed'
       where id = pg_temp.id('ord C') $$),
    (25, 'ok 1', 'it is cancelled', $$
      update app.orders set status = 'cancelled', cancelled_at = now(),
                            cancelled_by = pg_temp.id('user A'), cancel_reason = 'Event moved'
       where id = pg_temp.id('ord C') $$),
    (26, '23001', 'a cancelled order never changes again', $$
      update app.orders set status = 'pending', cancelled_at = null, cancelled_by = null,
                            cancel_reason = null
       where id = pg_temp.id('ord C') $$),
    (27, '23001', 'nor its lines', $$
      update app.order_lines set qty = 5 where id = pg_temp.id('oline C') $$),
    (28, '23514', 'no payment towards a cancelled order', pg_temp.pay_sql('pay C', 'order_id',
      'ord C')),
    (29, 'ok 1', 'its deposit is given back', pg_temp.pay_sql('back C', 'order_id', 'ord C',
      'refund')),
    (30, 'ok 1', 'setup: an order with delivery, what it costs not known yet',
      pg_temp.order_sql('ord D', 1004, ', delivery_needed', ', true')),
    (31, 'ok 1', 'setup: its sale, posted without a delivery cost',
      pg_temp.posted_sql('osale D', ', order_id, customer_id, delivery_needed',
        ', pg_temp.id(''ord D''), pg_temp.id(''cust A''), true', 'order')),
    (32, 'ok 1', 'setup: delivered', pg_temp.deliver_sql('ord D', 'osale D')),
    (33, 'ok 1', 'setup: its sale reversed (Undo delivery)', pg_temp.reverse_sql('osale D')),
    (34, 'ok 1', 'setup: pending again, still without a delivery cost', $$
      update app.orders set status = 'pending', delivered_on = null, sale_id = null,
                            delivered_at = null, delivered_by = null
       where id = pg_temp.id('ord D') $$),
    (35, '23001', 'an order''s reversed sale takes no delivery cost (it would count nowhere)', $$
      update app.sales set delivery_cost = 25 where id = pg_temp.id('osale D') $$),
    (36, 'ok 1', 'its order takes it instead', $$
      update app.orders set delivery_cost = 25 where id = pg_temp.id('ord D') $$),
    (37, 'ok 1', 'setup: a sale of its own with delivery, without its cost', pg_temp.posted_sql(
      'own D', ', delivery_needed', ', true')),
    (38, 'ok 1', 'setup: reversed', pg_temp.reverse_sql('own D')),
    (39, 'ok 1', 'a reversed sale that is no order''s still takes its delivery cost once (D-230)', $$
      update app.sales set delivery_cost = 12 where id = pg_temp.id('own D') $$)
  ) as v(n, state, what, stmt)
 order by v.n;

-- 7. Customer payments: never edited, only reversed; the books-closed date (19) --------------------

select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', v.stmt)), v.state, v.what)
  from (values
    (1, 'ok 1', 'a payment on a finalized sale they pay later', pg_temp.pay_sql('pay L', 'sale_id',
      'later A')),
    (2, '23001', 'a payment is never edited', $$
      update app.customer_payments set amount = 60 where id = pg_temp.id('pay L') $$),
    (3, '23001', 'nor deleted', $$ delete from app.customer_payments where id = pg_temp.id('pay L') $$),
    (4, '23001', 'nor soft-deleted', $$
      update app.customer_payments set deleted_at = now() where id = pg_temp.id('pay L') $$),
    (5, '23514', 'a new payment stands', pg_temp.pay_sql('x reversed', 'sale_id', 'later A',
      'payment', '2026-01-20', ', reversed_at, reversed_by, reversal_date',
      ', now(), pg_temp.id(''user A''), date ''2026-01-20''')),
    (6, '23514', 'no payment on a sale paid at once', pg_temp.pay_sql('x cash', 'sale_id', 'cash A')),
    (7, '23514', 'nor on a draft', pg_temp.pay_sql('x draft', 'sale_id', 'later draft')),
    (8, '23514', 'nor on an order''s sale (its order owes)', pg_temp.pay_sql('x osale', 'sale_id',
      'osale A2')),
    (9, '23514', 'a sale with payments is not reversed', pg_temp.reverse_sql('later A')),
    (10, 'ok 1', 'the payment is reversed', $$
      update app.customer_payments set reversed_at = now(), reversed_by = pg_temp.id('user A'),
                                       reversal_date = date '2026-01-20'
       where id = pg_temp.id('pay L') $$),
    (11, '23001', 'a reversal is never changed', $$
      update app.customer_payments set reversal_date = date '2026-01-21'
       where id = pg_temp.id('pay L') $$),
    (12, 'ok 1', 'then the sale is reversed', pg_temp.reverse_sql('later A')),
    (13, '23514', 'nothing is recorded on a reversed sale', pg_temp.pay_sql('x late', 'sale_id',
      'later A')),
    (14, 'ok 1', 'setup: a payment on the delivered order, on the 21st', pg_temp.pay_sql('pay O',
      'order_id', 'ord A', 'payment', '2026-01-21')),
    (15, 'ok 1', 'setup: the books closed up to the 21st', $$
      update app.businesses set books_closed_through = date '2026-01-21'
       where id = pg_temp.id('biz A') $$),
    (16, 'BZ412', 'no payment recorded on or before that day', pg_temp.pay_sql('x closed',
      'order_id', 'ord A', 'payment', '2026-01-21')),
    (17, 'BZ412', 'nor reversed on such a day', $$
      update app.customer_payments set reversed_at = now(), reversed_by = pg_temp.id('user A'),
                                       reversal_date = date '2026-01-21'
       where id = pg_temp.id('pay O') $$),
    (18, 'ok 1', 'it is reversed on the first open day', $$
      update app.customer_payments set reversed_at = now(), reversed_by = pg_temp.id('user A'),
                                       reversal_date = date '2026-01-22'
       where id = pg_temp.id('pay O') $$),
    (19, 'ok 1', 'setup: the books opened again', $$
      update app.businesses set books_closed_through = null where id = pg_temp.id('biz A') $$)
  ) as v(n, state, what, stmt)
 order by v.n;

-- 8. An order's file (1) ------------------------------------------------------------------------

select is(
  pg_temp.api_exec('user A', 'biz A', $$
    insert into app.attachments (id, business_id, entity, entity_id, path, file_name, content_type,
                                 size_bytes)
    values (pg_temp.id('lpo A'), pg_temp.id('biz A'), 'order', pg_temp.id('ord A'),
            pg_temp.id('biz A') || '/order/lpo.pdf', 'lpo.pdf', 'application/pdf', 10) $$),
  'ok 1',
  'an order keeps its files (the customer''s LPO)'
);

-- 9. Touch and audit (2) ------------------------------------------------------------------------

select is(
  pg_temp.api_value('user A', 'biz A', $$
    select version::text from app.orders where id = pg_temp.id('ord A') $$),
  '5',
  'every change of an order bumps its version (touch_row): edited, delivered, undone, delivered'
);

select is(
  (select string_agg(action, ',' order by created_at, id) from app.audit_log
    where business_id = pg_temp.id('biz A') and entity = 'customer_payments'
      and entity_id = pg_temp.id('pay L')),
  'insert,update',
  'a payment and its reversal are in the audit log'
);

select * from finish();
rollback;

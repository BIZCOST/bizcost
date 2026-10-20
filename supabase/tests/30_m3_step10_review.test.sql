-- pgTAP: the M3 Step 10 security review of the database's guards (each finding kept as its test, fixed
-- by migration step10_review_guards, D-335; §4 by step10_second_review, D-338). Each guard below holds "for every path" (D-205's and
-- D-211's rule, restated by D-330: no path puts into the books what the API's checks keep out), and
-- each let one through, as bizcost_api (the API's role, as the business's owner), because it read a
-- discarded (soft-deleted) draft as if it did not exist and left it "to the foreign key", which accepts
-- it (the row is still there):
--   1. orders_keep_their_sale (D-330): an order is delivered naming a discarded draft sale, its own or
--      another order's, so it is delivered with a sale that counts nowhere;
--   2. guard_customer_payment (D-160, D-313): a payment is recorded on a discarded draft invoice and
--      on a discarded draft One sale "they'll pay later", though a live draft of each is refused.
-- And one the guards never held:
--   3. gapless numbering (D-304, Q25: one gapless series each for invoices and credit notes): the
--      invoice counter jumps forward once started, and an invoice is issued with a number the series
--      never reached (INV-0001, then INV-0003): the gap the UAE rules forbid is written without the
--      API (the counter only refuses going back);
--   4. (the second review of the fixes) the number a document prints: seq had no gap, but INV-0003
--      could still be printed on the second invoice, and CN-0007 on the first credit note.
-- Each refusal is expected as check_violation (23514), the code of the guard it belongs to; the live
-- drafts (the controls) were refused before the fix too. Every attempt is rolled back whatever its outcome, so each
-- is tried against the same fixtures.
begin;
select plan(34);

do $$
begin
  if not pg_has_role(current_user, 'bizcost_api', 'SET') then
    execute format('grant bizcost_api to %I', current_user);
  end if;
exception when others then
  raise warning 'cannot let % SET ROLE: %', current_user, sqlerrm;
end
$$ language plpgsql;

create function pg_temp.id(p_name text) returns uuid
language sql immutable
as $$ select md5('m3-step10-review ' || p_name)::uuid $$;
grant execute on function pg_temp.id(text) to bizcost_api;

-- Runs p_sql as bizcost_api in business A as its owner; p_keep false rolls it back whatever happens.
-- 'ok <row count>', or the SQLSTATE it was refused with.
create function pg_temp.a(p_sql text, p_keep boolean default true)
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
    if not p_keep then
      raise exception 'm3-step10-review: roll back' using errcode = 'P0001';
    end if;
  exception when others then
    if v_out is null or sqlerrm <> 'm3-step10-review: roll back' then
      v_out := sqlstate;
    end if;
  end;
  reset role;
  perform set_config('app.user_id', '', true);
  perform set_config('app.business_id', '', true);
  perform set_config('app.request_id', '', true);
  return v_out;
end
$$;

-- An attempt: p_sql as bizcost_api, always rolled back.
create function pg_temp.try(p_sql text)
returns text
language sql
as $$ select pg_temp.a(p_sql, false) $$;

insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', pg_temp.id('user A'), 'authenticated', 'authenticated',
        'm3-step10-review@example.test', now(), '{}', '{}', now(), now());

-- 0. Fixtures (1 + 15 + 1 = 17) ---------------------------------------------------------------------

select is(
  pg_temp.a($$
    select app.create_business(pg_temp.id('biz A'), 'Review Kitchen', 'en', 'Owner',
                               pg_temp.id('biz A owner role'), pg_temp.id('biz A owner member')) $$),
  'ok 1',
  'setup: user A creates business A'
);

select is(pg_temp.a(v.stmt), 'ok 1', 'setup: ' || v.what)
  from (values
    (1, 'a location', $$
      insert into app.locations (id, business_id, name, is_default)
      values (pg_temp.id('loc'), pg_temp.id('biz A'), 'Main', true) $$),
    (2, 'a channel', $$
      insert into app.sales_channels (id, business_id, name, kind)
      values (pg_temp.id('chan'), pg_temp.id('biz A'), 'Shop', 'shop') $$),
    (3, 'a customer', $$
      insert into app.customers (id, business_id, name)
      values (pg_temp.id('cust'), pg_temp.id('biz A'), 'Gulf Horizon') $$),
    (4, 'a pending order', $$
      insert into app.orders (id, business_id, seq, number, customer_id, business_date, location_id,
                              channel_id, currency, net_total, total)
      values (pg_temp.id('ord1'), pg_temp.id('biz A'), 1001, '#1001', pg_temp.id('cust'),
              current_date - 5, pg_temp.id('loc'), pg_temp.id('chan'), 'AED', 150, 150) $$),
    (5, 'a draft of its sale on delivery', $$
      insert into app.sales (id, business_id, source, business_date, location_id, channel_id, currency,
                             customer_id, order_id, net_total, total)
      values (pg_temp.id('dsale'), pg_temp.id('biz A'), 'order', current_date - 4, pg_temp.id('loc'),
              pg_temp.id('chan'), 'AED', pg_temp.id('cust'), pg_temp.id('ord1'), 150, 150) $$),
    (6, 'that draft discarded', $$
      update app.sales set deleted_at = now() where id = pg_temp.id('dsale') $$),
    (7, 'a live draft of its sale', $$
      insert into app.sales (id, business_id, source, business_date, location_id, channel_id, currency,
                             customer_id, order_id, net_total, total)
      values (pg_temp.id('live osale'), pg_temp.id('biz A'), 'order', current_date - 4,
              pg_temp.id('loc'), pg_temp.id('chan'), 'AED', pg_temp.id('cust'), pg_temp.id('ord1'), 150,
              150) $$),
    (8, 'a draft invoice', $$
      insert into app.invoices (id, business_id, kind, customer_id, location_id, currency, net_total,
                                total)
      values (pg_temp.id('xinv'), pg_temp.id('biz A'), 'invoice', pg_temp.id('cust'), pg_temp.id('loc'),
              'AED', 1000, 1000) $$),
    (9, 'that draft discarded', $$
      update app.invoices set deleted_at = now() where id = pg_temp.id('xinv') $$),
    (10, 'a draft One sale they pay later', $$
      insert into app.sales (id, business_id, source, business_date, location_id, channel_id, currency,
                             customer_id, pay_later, net_total, total)
      values (pg_temp.id('xsale'), pg_temp.id('biz A'), 'single', current_date - 1, pg_temp.id('loc'),
              pg_temp.id('chan'), 'AED', pg_temp.id('cust'), true, 100, 100) $$),
    (11, 'that draft discarded', $$
      update app.sales set deleted_at = now() where id = pg_temp.id('xsale') $$),
    (12, 'a live draft One sale they pay later', $$
      insert into app.sales (id, business_id, source, business_date, location_id, channel_id, currency,
                             customer_id, pay_later, net_total, total)
      values (pg_temp.id('live sale'), pg_temp.id('biz A'), 'single', current_date - 1,
              pg_temp.id('loc'), pg_temp.id('chan'), 'AED', pg_temp.id('cust'), true, 100, 100) $$),
    (13, 'the invoice counter, at INV-0002 (INV-0001 taken)', $$
      insert into app.document_counters (id, business_id, series, next_no, prefix, padding, first_no)
      values (pg_temp.id('counter'), pg_temp.id('biz A'), 'invoice', 2, 'INV-', 4, 1) $$),
    (14, 'a draft invoice with its line, to be INV-0001', $$
      with i as (
        insert into app.invoices (id, business_id, kind, customer_id, location_id, currency, net_total,
                                  total)
        values (pg_temp.id('inv1'), pg_temp.id('biz A'), 'invoice', pg_temp.id('cust'),
                pg_temp.id('loc'), 'AED', 1000, 1000)
        returning id
      )
      insert into app.invoice_lines (id, business_id, invoice_id, position, kind, description, qty,
                                     unit_price, net, total)
      select pg_temp.id('iline1'), pg_temp.id('biz A'), i.id, 0, 'item', 'Shelves', 10, 100, 1000, 1000
        from i $$),
    (15, 'a second draft invoice with its line', $$
      with i as (
        insert into app.invoices (id, business_id, kind, customer_id, location_id, currency, net_total,
                                  total)
        values (pg_temp.id('inv2'), pg_temp.id('biz A'), 'invoice', pg_temp.id('cust'),
                pg_temp.id('loc'), 'AED', 500, 500)
        returning id
      )
      insert into app.invoice_lines (id, business_id, invoice_id, position, kind, description, qty,
                                     unit_price, net, total)
      select pg_temp.id('iline2'), pg_temp.id('biz A'), i.id, 0, 'item', 'Doors', 5, 100, 500, 500
        from i $$)
  ) as v(n, what, stmt)
 order by v.n;

select is(
  pg_temp.a($$
    update app.invoices
       set status = 'issued', seq = 1, number = 'INV-0001', issue_date = current_date,
           supply_date = current_date, issued_at = now(), issued_by = pg_temp.id('user A'),
           customer_name = 'Gulf Horizon', seller_name = 'Review Kitchen'
     where id = pg_temp.id('inv1') $$),
  'ok 1',
  'setup: INV-0001 is issued'
);

-- 1. orders_keep_their_sale and a discarded draft (control 1 + 2 = 3) -------------------------------

select is(
  pg_temp.try($$
    update app.orders
       set status = 'delivered', delivered_on = current_date - 4, sale_id = pg_temp.id('live osale'),
           delivered_at = now(), delivered_by = pg_temp.id('user A')
     where id = pg_temp.id('ord1') $$),
  '23514',
  'control: an order is not delivered with a live draft of its sale (D-330)'
);

select is(
  pg_temp.try($$
    update app.orders
       set status = 'delivered', delivered_on = current_date - 4, sale_id = pg_temp.id('dsale'),
           delivered_at = now(), delivered_by = pg_temp.id('user A')
     where id = pg_temp.id('ord1') $$),
  '23514',
  'an order is not delivered with a discarded draft of its sale either: it would count nowhere (D-330)'
);

select is(
  pg_temp.try($$
    insert into app.orders (id, business_id, seq, number, business_date, location_id, channel_id,
                            currency, status, delivered_on, sale_id, delivered_at, delivered_by)
    values (pg_temp.id('ord2'), pg_temp.id('biz A'), 1002, '#1002', current_date - 5, pg_temp.id('loc'),
            pg_temp.id('chan'), 'AED', 'delivered', current_date - 4, pg_temp.id('dsale'), now(),
            pg_temp.id('user A')) $$),
  '23514',
  'an order written already delivered does not name a discarded draft sale (another order''s) (D-330)'
);

-- 2. guard_customer_payment and a discarded draft (controls 2 + 2 = 4) -----------------------------

select is(
  pg_temp.try($$
    insert into app.customer_payments (id, business_id, customer_id, invoice_id, business_date, method,
                                       amount, currency)
    values (pg_temp.id('pay c1'), pg_temp.id('biz A'), pg_temp.id('cust'), pg_temp.id('inv2'),
            current_date, 'cash', 300, 'AED') $$),
  '23514',
  'control: a payment is not recorded on a live draft invoice'
);

select is(
  pg_temp.try($$
    insert into app.customer_payments (id, business_id, customer_id, invoice_id, business_date, method,
                                       amount, currency)
    values (pg_temp.id('pay 1'), pg_temp.id('biz A'), pg_temp.id('cust'), pg_temp.id('xinv'),
            current_date, 'cash', 300, 'AED') $$),
  '23514',
  'nor on a discarded draft invoice: a payment is recorded only on a live issued invoice'
);

select is(
  pg_temp.try($$
    insert into app.customer_payments (id, business_id, customer_id, sale_id, business_date, method,
                                       amount, currency)
    values (pg_temp.id('pay c2'), pg_temp.id('biz A'), pg_temp.id('cust'), pg_temp.id('live sale'),
            current_date, 'cash', 40, 'AED') $$),
  '23514',
  'control: a payment is not recorded on a live draft sale they pay later'
);

select is(
  pg_temp.try($$
    insert into app.customer_payments (id, business_id, customer_id, sale_id, business_date, method,
                                       amount, currency)
    values (pg_temp.id('pay 2'), pg_temp.id('biz A'), pg_temp.id('cust'), pg_temp.id('xsale'),
            current_date, 'cash', 40, 'AED') $$),
  '23514',
  'nor on a discarded draft sale: a payment is recorded only on a finalized sale they pay later'
);

-- 3. Gapless invoice numbers (4 + controls 1 = 5) ---------------------------------------------------

select is(
  pg_temp.try($$
    update app.document_counters set next_no = next_no + 10 where id = pg_temp.id('counter') $$),
  '23514',
  'the invoice counter, once started, never jumps: that is a gap in the series (D-304)'
);

select is(
  pg_temp.try($$
    update app.invoices
       set status = 'issued', seq = 3, number = 'INV-0003', issue_date = current_date,
           supply_date = current_date, issued_at = now(), issued_by = pg_temp.id('user A'),
           customer_name = 'Gulf Horizon', seller_name = 'Review Kitchen'
     where id = pg_temp.id('inv2') $$),
  '23514',
  'an invoice is not issued as INV-0003 after INV-0001: the series has no gap (D-304)'
);

select is(
  pg_temp.try($$
    with c as (
      update app.document_counters set next_no = next_no + 1 where id = pg_temp.id('counter')
      returning next_no - 1 as seq
    )
    update app.invoices
       set status = 'issued', seq = (select seq from c), number = 'INV-0002',
           issue_date = current_date, supply_date = current_date, issued_at = now(),
           issued_by = pg_temp.id('user A'), customer_name = 'Gulf Horizon',
           seller_name = 'Review Kitchen'
     where id = pg_temp.id('inv2') $$),
  'ok 1',
  'control: INV-0002 after INV-0001 is issued, its number taken from the counter'
);

select is(
  pg_temp.try($$
    insert into app.invoices (id, business_id, kind, customer_id, location_id, currency, net_total,
                              total, status, seq, number, issue_date, supply_date, issued_at,
                              issued_by, customer_name, seller_name)
    values (pg_temp.id('inv999'), pg_temp.id('biz A'), 'invoice', pg_temp.id('cust'),
            pg_temp.id('loc'), 'AED', 0, 0, 'issued', 999, 'INV-0999', current_date, current_date,
            now(), pg_temp.id('user A'), 'Gulf Horizon', 'Review Kitchen') $$),
  '23514',
  'nor is an invoice written already issued with a number the series never reached (D-304)'
);

select is(
  pg_temp.try($$
    update app.document_counters set next_no = next_no + 2 where id = pg_temp.id('counter') $$),
  '23514',
  'a gapless counter moves one number at a time: two at once is a gap too (D-304)'
);

-- 4. The printed number is the series' own (3 + controls 2 = 5) -------------------------------------
-- The second review of the fixes: only seq was kept without a gap, and the number printed on the
-- document (the PDF prints invoices.number) was any text, so the gap of INV-0001, INV-0003 was still
-- written on paper. Fixed by migration step10_second_review (D-338).

select is(
  pg_temp.try($$
    with c as (
      update app.document_counters set next_no = next_no + 1 where id = pg_temp.id('counter')
      returning next_no - 1 as seq
    )
    update app.invoices
       set status = 'issued', seq = (select seq from c), number = 'INV-0003',
           issue_date = current_date, supply_date = current_date, issued_at = now(),
           issued_by = pg_temp.id('user A'), customer_name = 'Gulf Horizon',
           seller_name = 'Review Kitchen'
     where id = pg_temp.id('inv2') $$),
  '23514',
  'the second invoice, seq 2 from the counter, is not printed INV-0003: that is the gap on paper (D-304)'
);

select is(
  pg_temp.try($$
    update app.invoices
       set status = 'issued', seq = 2, number = 'INV-0003', issue_date = current_date,
           supply_date = current_date, issued_at = now(), issued_by = pg_temp.id('user A'),
           customer_name = 'Gulf Horizon', seller_name = 'Review Kitchen'
     where id = pg_temp.id('inv2') $$),
  '23514',
  'nor without moving the counter: seq 2 prints INV-0002'
);

select is(
  pg_temp.try($$
    insert into app.credit_notes (id, business_id, kind, invoice_id, customer_id, location_id,
                                  event_date, reason, reason_text, credit_by, currency, status, seq,
                                  number, issue_date, issued_at, issued_by, value_before, value_after,
                                  customer_name, seller_name, net_total, total)
    values (pg_temp.id('cn1'), pg_temp.id('biz A'), 'credit_note', pg_temp.id('inv1'),
            pg_temp.id('cust'), pg_temp.id('loc'), current_date, 'price_changed', 'Price cut',
            'amount', 'AED', 'issued', 1, 'CN-0007', current_date, now(), pg_temp.id('user A'), 1000,
            900, 'Gulf Horizon', 'Review Kitchen', 100, 100) $$),
  '23514',
  'the first credit note is not written already issued as CN-0007 (D-304)'
);

select is(
  pg_temp.try($$
    insert into app.credit_notes (id, business_id, kind, invoice_id, customer_id, location_id,
                                  event_date, reason, reason_text, credit_by, currency, status, seq,
                                  number, issue_date, issued_at, issued_by, value_before, value_after,
                                  customer_name, seller_name, net_total, total)
    values (pg_temp.id('cn1'), pg_temp.id('biz A'), 'credit_note', pg_temp.id('inv1'),
            pg_temp.id('cust'), pg_temp.id('loc'), current_date, 'price_changed', 'Price cut',
            'amount', 'AED', 'issued', 1, 'CN-0001', current_date, now(), pg_temp.id('user A'), 1000,
            900, 'Gulf Horizon', 'Review Kitchen', 100, 100) $$),
  'ok 1',
  'control: written already issued as CN-0001 (no counter yet: the series'' own prefix and 4 digits)'
);

select is(
  pg_temp.try($$
    with c as (
      update app.document_counters set next_no = next_no + 1, prefix = 'INV/', padding = 5
       where id = pg_temp.id('counter')
      returning next_no - 1 as seq
    )
    update app.invoices
       set status = 'issued', seq = (select seq from c), number = 'INV/00002',
           issue_date = current_date, supply_date = current_date, issued_at = now(),
           issued_by = pg_temp.id('user A'), customer_name = 'Gulf Horizon',
           seller_name = 'Review Kitchen'
     where id = pg_temp.id('inv2') $$),
  'ok 1',
  'control: the number follows the counter''s prefix and padding as they are at issue (INV/00002)'
);

select * from finish();
rollback;

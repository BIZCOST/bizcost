-- pgTAP: Invoices, credit notes, payments on invoices (M3 Step 8; migrations invoices_tables and
-- invoices_security; DECISIONS.md from D-301). As bizcost_api, like the API:
--   - the four new tables are isolated between businesses and link only within one (composite
--     foreign keys: an invoice's customer, location, channel, quotation, order, sale and stored PDF; a
--     line's invoice, product, deposit invoice and counted sale line; a credit note's invoice; a
--     credit note line's invoice line; a payment's invoice; a sale's invoice and credit note);
--   - their CHECKs: value lists, the kind with the VAT registration, the issued columns together, the
--     supply and due dates against the issue date, billing in parts and deposits, at most one source,
--     a deduction's line, a credit note's values and amounts;
--   - numbering: one number per business and series, a business's numbers its own;
--   - an issued invoice or credit note is frozen (guard_issued_document): only its stored PDF is
--     linked, once; it is never discarded or deleted; its lines never change;
--   - payments: on an issued invoice only; an invoiced order is paid through its invoices;
--   - an invoice's sale is never reversed, nor a sale or an order's delivery an issued invoice refers
--     to; an order an issued invoice refers to is not cancelled;
--   - files: an invoice line's picture only while its invoice is a draft; an invoice's own files once
--     issued too; the counters' and PDFs' new kinds; the sales' new sources;
--   - an order cancelled once its issued invoices are fully credited (invoices_order_cancel); the
--     books-closed date on a credit note's sale and an invoice's payment;
--   - the review's guards (invoices_review_guards, D-313–D-316): an order its invoices bill in part
--     still takes payments, in full it is paid through them; an order an issued invoice refers to
--     keeps its branch; a quotation an issued invoice bills is never made an order; an invoice is
--     issued from its source's branch; a stage it bills is a quotation's.
begin;
select plan(99);

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

-- A draft invoice of A for A's customer (plain: A is not VAT-registered), with extra columns.
create function pg_temp.inv_sql(p_id text, p_extra_columns text default '',
                                p_extra_values text default '')
returns text language sql immutable
as $$
  select format($f$
    insert into app.invoices (id, business_id, kind, customer_id, location_id, currency %s)
    values (pg_temp.id(%L), pg_temp.id('biz A'), 'invoice', pg_temp.id('cust A'),
            pg_temp.id('loc A'), 'AED' %s) $f$,
    p_extra_columns, p_id, p_extra_values)
$$;

-- A typed line of an invoice.
create function pg_temp.inv_line_sql(p_id text, p_invoice text)
returns text language sql immutable
as $$
  select format($f$
    insert into app.invoice_lines (id, business_id, invoice_id, position, kind, description, qty,
                                   unit_price, net, total)
    values (pg_temp.id(%L), pg_temp.id('biz A'), pg_temp.id(%L), 0, 'item', 'Shelves', 1, 100,
            100, 100) $f$,
    p_id, p_invoice)
$$;

-- Issues a draft invoice with the number `p_seq` (its issued columns, all at once).
create function pg_temp.issue_sql(p_invoice text, p_seq int)
returns text language sql immutable
as $$
  select format($f$
    update app.invoices
       set status = 'issued', seq = %s, number = %L, issue_date = date '2026-01-20',
           supply_date = date '2026-01-20', issued_at = now(), issued_by = pg_temp.id('user A'),
           customer_name = 'Gulf Horizon', seller_name = 'Alpha Joinery'
     where id = pg_temp.id(%L) $f$,
    p_seq, 'INV-' || lpad(p_seq::text, 4, '0'), p_invoice)
$$;

-- A sale of A (source, extra columns), posted.
create function pg_temp.posted_sale_sql(p_id text, p_source text, p_extra_columns text default '',
                                        p_extra_values text default '')
returns text language sql immutable
as $$
  select format($f$
    insert into app.sales (id, business_id, source, business_date, location_id, channel_id, currency,
                           status, posted_at, posted_by %s)
    values (pg_temp.id(%L), pg_temp.id('biz A'), %L, date '2026-01-20', pg_temp.id('loc A'),
            pg_temp.id('chan A'), 'AED', 'posted', now(), pg_temp.id('user A') %s) $f$,
    p_extra_columns, p_id, p_source, p_extra_values)
$$;

-- A payment of 50 in cash by A's customer on an order or an invoice (p_column).
create function pg_temp.pay_sql(p_id text, p_column text, p_target text,
                                p_kind text default 'payment')
returns text language sql immutable
as $$
  select format($f$
    insert into app.customer_payments (id, business_id, customer_id, %I, kind, business_date, method,
                                       amount, currency)
    values (pg_temp.id(%L), pg_temp.id('biz A'), pg_temp.id('cust A'), pg_temp.id(%L), %L,
            date '2026-01-21', 'cash', 50, 'AED') $f$,
    p_column, p_id, p_target, p_kind)
$$;

-- A credit note of an invoice, a draft.
create function pg_temp.credit_sql(p_id text, p_invoice text, p_extra_columns text default '',
                                   p_extra_values text default '')
returns text language sql immutable
as $$
  select format($f$
    insert into app.credit_notes (id, business_id, kind, invoice_id, customer_id, location_id,
                                  event_date, reason, reason_text, credit_by, currency %s)
    values (pg_temp.id(%L), pg_temp.id('biz A'), 'credit_note', pg_temp.id(%L), pg_temp.id('cust A'),
            pg_temp.id('loc A'), date '2026-01-20', 'price_changed', 'Price cut', 'amount', 'AED' %s) $f$,
    p_extra_columns, p_id, p_invoice, p_extra_values)
$$;

insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', pg_temp.id('user A'), 'authenticated',
        'authenticated', 'amna-invoices@example.test', now(), '{}', '{}', now(), now()),
       ('00000000-0000-0000-0000-000000000000', pg_temp.id('user B'), 'authenticated',
        'authenticated', 'bilal-invoices@example.test', now(), '{}', '{}', now(), now());

-- 1. Fixtures (14) ------------------------------------------------------------------------------

select is(
  pg_temp.api_value(v.u, null, format($f$
    select app.create_business(pg_temp.id(%L), %L, 'en', 'Owner',
                               pg_temp.id(%L), pg_temp.id(%L)) $f$,
    v.b, v.name, v.b || ' owner role', v.b || ' owner member')),
  pg_temp.id(v.b)::text,
  'setup: ' || v.u || ' creates ' || v.b
)
  from (values ('user A', 'biz A', 'Alpha Joinery'), ('user B', 'biz B', 'Beta Fit-Out')) as v(u, b, name);

select is(pg_temp.api_exec(v.u, v.b, v.stmt), 'ok 1', 'setup: ' || v.what)
  from (values
    (1, 'user A', 'biz A', 'a location of A', $$
      insert into app.locations (id, business_id, name, is_default)
      values (pg_temp.id('loc A'), pg_temp.id('biz A'), 'Main', true) $$),
    (2, 'user A', 'biz A', 'a channel of A', $$
      insert into app.sales_channels (id, business_id, name, kind)
      values (pg_temp.id('chan A'), pg_temp.id('biz A'), 'Shop', 'shop') $$),
    (3, 'user A', 'biz A', 'a customer of A', $$
      insert into app.customers (id, business_id, name)
      values (pg_temp.id('cust A'), pg_temp.id('biz A'), 'Gulf Horizon') $$),
    (4, 'user A', 'biz A', 'invoice 1 of A, a draft', pg_temp.inv_sql('inv1')),
    (5, 'user A', 'biz A', 'its line', pg_temp.inv_line_sql('inv1 line', 'inv1')),
    (6, 'user A', 'biz A', 'invoice 2 of A, a draft', pg_temp.inv_sql('inv2')),
    (7, 'user A', 'biz A', 'an order of A, pending', $$
      insert into app.orders (id, business_id, seq, number, customer_id, business_date,
                              location_id, channel_id, currency)
      values (pg_temp.id('order A'), pg_temp.id('biz A'), 1001, '#1001', pg_temp.id('cust A'),
              date '2026-01-20', pg_temp.id('loc A'), pg_temp.id('chan A'), 'AED') $$),
    (8, 'user A', 'biz A', 'a One sale of A, posted', pg_temp.posted_sale_sql('sale A', 'single',
      ', customer_id', ', pg_temp.id(''cust A'')')),
    (9, 'user B', 'biz B', 'a location of B', $$
      insert into app.locations (id, business_id, name, is_default)
      values (pg_temp.id('loc B'), pg_temp.id('biz B'), 'Main', true) $$),
    (10, 'user B', 'biz B', 'a customer of B', $$
      insert into app.customers (id, business_id, name)
      values (pg_temp.id('cust B'), pg_temp.id('biz B'), 'Badria') $$),
    (11, 'user B', 'biz B', 'an invoice of B, a draft', $$
      insert into app.invoices (id, business_id, kind, customer_id, location_id, currency)
      values (pg_temp.id('invB'), pg_temp.id('biz B'), 'invoice', pg_temp.id('cust B'),
              pg_temp.id('loc B'), 'AED') $$),
    (12, 'user B', 'biz B', 'B''s own INV-0001 (numbers are per business)', $$
      update app.invoices
         set status = 'issued', seq = 1, number = 'INV-0001', issue_date = date '2026-01-20',
             supply_date = date '2026-01-20', issued_at = now(), issued_by = pg_temp.id('user B'),
             customer_name = 'Badria', seller_name = 'Beta Fit-Out'
       where id = pg_temp.id('invB') $$)
  ) as v(n, u, b, what, stmt)
 order by v.n;

-- 2. Isolation and links (6) ----------------------------------------------------------------------

select is(pg_temp.api_value('user B', 'biz B', 'select count(*)::text from app.invoices'), '1',
          'B sees its own invoices only');
select is(pg_temp.api_exec('user B', 'biz B', $$
  update app.invoices set notes = 'x' where id = pg_temp.id('inv1') $$), 'ok 0',
          'B cannot change A''s invoice');
select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', $$
  insert into app.invoices (id, business_id, kind, customer_id, location_id, currency)
  values (pg_temp.id('x cust'), pg_temp.id('biz A'), 'invoice', pg_temp.id('cust B'),
          pg_temp.id('loc A'), 'AED') $$)), '23503',
          'an invoice names a customer of its own business only');
select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A',
  pg_temp.inv_line_sql('x line', 'invB'))), '23503',
          'a line belongs to an invoice of its own business only');
select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A',
  pg_temp.credit_sql('x credit', 'invB'))), '23503',
          'a credit note corrects an invoice of its own business only');
select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A',
  pg_temp.pay_sql('x pay', 'invoice_id', 'invB'))), '23503',
          'a payment is recorded on an invoice of its own business only');

-- 3. CHECKs (16) --------------------------------------------------------------------------------

select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', v.stmt)), '23514', 'check: ' || v.what)
  from (values
    (1, 'an invoice''s kind from the list', $$
      insert into app.invoices (id, business_id, kind, customer_id, location_id, currency)
      values (pg_temp.id('c1'), pg_temp.id('biz A'), 'receipt', pg_temp.id('cust A'),
              pg_temp.id('loc A'), 'AED') $$),
    (2, 'a status from the list', pg_temp.inv_sql('c2', ', status', ', ''sent''')),
    (3, 'what it bills from the list', pg_temp.inv_sql('c3', ', bills', ', ''half''')),
    (4, 'a tax invoice only with VAT registration', $$
      insert into app.invoices (id, business_id, kind, customer_id, location_id, currency)
      values (pg_temp.id('c4'), pg_temp.id('biz A'), 'tax_invoice', pg_temp.id('cust A'),
              pg_temp.id('loc A'), 'AED') $$),
    (5, 'an issued invoice has its number and particulars', pg_temp.inv_sql('c5', ', status',
      ', ''issued''')),
    (6, 'a part bills a % or an amount', pg_temp.inv_sql('c6', ', bills, order_id',
      ', ''part'', pg_temp.id(''order A'')')),
    (7, 'a deposit is a part', pg_temp.inv_sql('c7', ', is_deposit, order_id',
      ', true, pg_temp.id(''order A'')')),
    (8, 'a part bills a source', pg_temp.inv_sql('c8', ', bills, bill_percent', ', ''part'', 30')),
    (9, 'one source at most', pg_temp.inv_sql('c9', ', order_id, sale_id',
      ', pg_temp.id(''order A''), pg_temp.id(''sale A'')')),
    (10, 'a recorded sale is billed whole', pg_temp.inv_sql('c10', ', sale_id, bills, bill_percent',
      ', pg_temp.id(''sale A''), ''part'', 50')),
    (11, 'a stored PDF only once issued', pg_temp.inv_sql('c11', ', pdf_upload_id',
      ', pg_temp.id(''nope'')')),
    (12, 'a deduction is qty −1 naming its deposit invoice', $$
      insert into app.invoice_lines (id, business_id, invoice_id, position, kind, description, qty,
                                     unit_price)
      values (pg_temp.id('c12'), pg_temp.id('biz A'), pg_temp.id('inv2'), 0, 'deduction',
              'Less deposit', 1, 100) $$),
    (13, 'a delivery line is qty 1', $$
      insert into app.invoice_lines (id, business_id, invoice_id, position, kind, description, qty,
                                     unit_price)
      values (pg_temp.id('c13'), pg_temp.id('biz A'), pg_temp.id('inv2'), 0, 'delivery',
              'Delivery', 2, 20) $$),
    (14, 'a credit note''s reason from the list', $$
      insert into app.credit_notes (id, business_id, kind, invoice_id, customer_id, location_id,
                                    event_date, reason, reason_text, credit_by, currency)
      values (pg_temp.id('c14'), pg_temp.id('biz A'), 'credit_note', pg_temp.id('inv1'),
              pg_temp.id('cust A'), pg_temp.id('loc A'), date '2026-01-20', 'goodwill', 'Kind',
              'amount', 'AED') $$),
    (15, 'a credit note''s kind with VAT registration', pg_temp.credit_sql('c15', 'inv1',
      ', vat_registered', ', true')),
    (16, 'a sale of an invoice names it', pg_temp.posted_sale_sql('c16', 'invoice'))
  ) as v(n, what, stmt)
 order by v.n;

-- 4. Numbers and the freeze (12) ------------------------------------------------------------------

select is(pg_temp.api_exec('user A', 'biz A', $$
  update app.invoices set notes = 'Draft note' where id = pg_temp.id('inv1') $$), 'ok 1',
          'a draft changes freely');
select is(pg_temp.api_exec('user A', 'biz A', pg_temp.issue_sql('inv1', 1)), 'ok 1',
          'a draft is issued with its number and particulars');
select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', pg_temp.issue_sql('inv2', 1))),
          '23505', 'one invoice per number of a business');
select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', $$
  update app.invoices set notes = 'Changed' where id = pg_temp.id('inv1') $$)), '23001',
          'an issued invoice is never edited');
select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', $$
  update app.invoices set deleted_at = now() where id = pg_temp.id('inv1') $$)), '23001',
          'an issued invoice is never discarded');
select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', $$
  delete from app.invoices where id = pg_temp.id('inv1') $$)), '23001',
          'an invoice is never deleted');
select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A',
  pg_temp.inv_line_sql('late line', 'inv1'))), '23001',
          'an issued invoice takes no new line');
select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', $$
  update app.invoice_lines set description = 'Other' where id = pg_temp.id('inv1 line') $$)),
          '23001', 'an issued invoice''s line never changes');
select is(pg_temp.api_exec('user A', 'biz A', $$
  insert into app.file_uploads (id, business_id, path, purpose, content_type, expires_at, status)
  values (pg_temp.id('pdf 1'), pg_temp.id('biz A'),
          pg_temp.id('biz A')::text || '/document/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b.pdf',
          'document', 'application/pdf', now() + interval '10 minutes', 'used') $$), 'ok 1',
          'setup: an issued PDF stored for A');
select is(pg_temp.api_exec('user A', 'biz A', $$
  update app.invoices set pdf_upload_id = pg_temp.id('pdf 1') where id = pg_temp.id('inv1') $$),
          'ok 1', 'its stored PDF is linked once');
select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', $$
  update app.invoices set pdf_upload_id = null where id = pg_temp.id('inv1') $$)), '23001',
          'and never changes after');
select is(pg_temp.api_exec('user A', 'biz A', $$
  update app.invoices set deleted_at = now() where id = pg_temp.id('inv2') $$), 'ok 1',
          'a draft is discarded (it never had a number)');

-- 5. Credit notes (6) ---------------------------------------------------------------------------

select is(pg_temp.api_exec('user A', 'biz A', pg_temp.credit_sql('cn1', 'inv1')), 'ok 1',
          'a credit note of an issued invoice, a draft');
select is(pg_temp.api_exec('user A', 'biz A', $$
  insert into app.credit_note_lines (id, business_id, credit_note_id, position, invoice_line_id,
                                     description, qty, unit_price, net, total)
  values (pg_temp.id('cn1 line'), pg_temp.id('biz A'), pg_temp.id('cn1'), 0,
          pg_temp.id('inv1 line'), 'Shelves', 1, 20, 20, 20) $$), 'ok 1', 'its line');
select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', $$
  insert into app.credit_note_lines (id, business_id, credit_note_id, position, invoice_line_id,
                                     description, qty, unit_price, net, vat, total)
  values (pg_temp.id('cn1 bad'), pg_temp.id('biz A'), pg_temp.id('cn1'), 1,
          pg_temp.id('inv1 line'), 'Shelves', 1, 20, 20, 1, 20) $$)), '23514',
          'check: a credit line''s total is its net and VAT');
select is(pg_temp.api_exec('user A', 'biz A', $$
  update app.credit_notes
     set status = 'issued', seq = 1, number = 'CN-0001', issue_date = date '2026-01-21',
         issued_at = now(), issued_by = pg_temp.id('user A'), value_before = 100, value_after = 80,
         net_total = 20, total = 20, customer_name = 'Gulf Horizon', seller_name = 'Alpha Joinery'
   where id = pg_temp.id('cn1') $$), 'ok 1', 'issued with its own number CN-0001 and its values');
select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', $$
  update app.credit_notes set reason_text = 'Other' where id = pg_temp.id('cn1') $$)), '23001',
          'an issued credit note is never edited');
select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', pg_temp.credit_sql('cn bad', 'inv1',
  ', status, seq, number, issue_date, issued_at, issued_by, value_before, value_after, customer_name, seller_name',
  ', ''issued'', 2, ''CN-0002'', date ''2026-01-21'', now(), pg_temp.id(''user A''), 10, 20, ''X'', ''Y'''))),
          '23514', 'check: the value after a credit note is never above the value before');

-- 6. Payments and what an invoice refers to (8) -------------------------------------------------

select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', pg_temp.inv_sql('inv3'))), 'ok 1',
          'setup: invoice 3 of A, a draft');
select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A',
  pg_temp.pay_sql('pay draft', 'invoice_id', 'inv3'))), '23514',
          'a payment is recorded only on an issued invoice');
select is(pg_temp.api_exec('user A', 'biz A', pg_temp.pay_sql('pay inv1', 'invoice_id', 'inv1')),
          'ok 1', 'a payment on an issued invoice');
select is(pg_temp.api_exec('user A', 'biz A', $$
  update app.invoices set order_id = pg_temp.id('order A'), net_total = 100, total = 100,
                          payable = 100
   where id = pg_temp.id('inv3') $$), 'ok 1',
          'setup: invoice 3 bills the order (100)');
select is(pg_temp.api_exec('user A', 'biz A', pg_temp.issue_sql('inv3', 2)), 'ok 1',
          'setup: invoice 3 issued');
select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A',
  pg_temp.pay_sql('pay order', 'order_id', 'order A'))), '23514',
          'an invoiced order is paid through its invoices');
select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', $$
  update app.orders set status = 'cancelled', cancelled_at = now(),
                        cancelled_by = pg_temp.id('user A')
   where id = pg_temp.id('order A') $$)), '23514',
          'an order an issued invoice refers to is not cancelled');
select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', $$
  insert into app.customer_payments (id, business_id, customer_id, order_id, invoice_id, kind,
                                     business_date, method, amount, currency)
  values (pg_temp.id('pay two'), pg_temp.id('biz A'), pg_temp.id('cust A'),
          pg_temp.id('order A'), pg_temp.id('inv1'), 'payment', date '2026-01-21', 'cash', 1,
          'AED') $$)), '23514', 'a payment names one document');

-- 7. Sales of invoices and credit notes (6) -------------------------------------------------------

select is(pg_temp.api_exec('user A', 'biz A', pg_temp.posted_sale_sql('inv1 sale', 'invoice',
  ', invoice_id, customer_id', ', pg_temp.id(''inv1''), pg_temp.id(''cust A'')')), 'ok 1',
          'the sale an issued invoice posted');
select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', $$
  update app.sales set status = 'reversed', reversed_at = now(), reversed_by = pg_temp.id('user A'),
                       reversal_business_date = date '2026-01-21'
   where id = pg_temp.id('inv1 sale') $$)), '23514', 'an invoice''s sale is never reversed');
select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', pg_temp.posted_sale_sql('inv1 sale 2',
  'invoice', ', invoice_id', ', pg_temp.id(''inv1'')'))), '23505', 'one live sale per invoice');
select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', pg_temp.posted_sale_sql('cn1 sale',
  'credit_note', ', credit_note_id', ', pg_temp.id(''cn1'')'))), '23514',
          'check: a credit note''s sale says how it credits');
select is(pg_temp.api_exec('user A', 'biz A', pg_temp.inv_sql('inv4', ', sale_id',
  ', pg_temp.id(''sale A'')')), 'ok 1', 'setup: invoice 4 bills the recorded sale');
select is(pg_temp.api_exec('user A', 'biz A', pg_temp.issue_sql('inv4', 3)), 'ok 1',
          'setup: invoice 4 issued');

-- 8. A sale an invoice was made from, files, counters, PDFs (12) ---------------------------------

select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', $$
  update app.sales set status = 'reversed', reversed_at = now(), reversed_by = pg_temp.id('user A'),
                       reversal_business_date = date '2026-01-21'
   where id = pg_temp.id('sale A') $$)), '23514',
          'a sale an issued invoice was made from is never reversed');
select is(pg_temp.api_exec('user A', 'biz A', pg_temp.inv_sql('inv5')), 'ok 1',
          'setup: invoice 5, a draft');
select is(pg_temp.api_exec('user A', 'biz A', pg_temp.inv_line_sql('inv5 line', 'inv5')), 'ok 1',
          'setup: its line');
select is(pg_temp.api_exec('user A', 'biz A', $$
  insert into app.attachments (id, business_id, entity, entity_id, path, file_name, content_type,
                               size_bytes)
  values (pg_temp.id('pic 5'), pg_temp.id('biz A'), 'invoice_line', pg_temp.id('inv5 line'),
          pg_temp.id('biz A')::text || '/invoice_line/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c.png',
          'shelf.png', 'image/png', 1000) $$), 'ok 1', 'a draft invoice line''s picture');
select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', $$
  insert into app.attachments (id, business_id, entity, entity_id, path, file_name, content_type,
                               size_bytes)
  values (pg_temp.id('pdf pic'), pg_temp.id('biz A'), 'invoice_line', pg_temp.id('inv5 line'),
          pg_temp.id('biz A')::text || '/invoice_line/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d.pdf',
          'plan.pdf', 'application/pdf', 1000) $$)), '23514', 'an invoice line''s picture is an image');
select is(pg_temp.api_exec('user A', 'biz A', pg_temp.issue_sql('inv5', 4)), 'ok 1',
          'setup: invoice 5 issued');
select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', $$
  insert into app.attachments (id, business_id, entity, entity_id, path, file_name, content_type,
                               size_bytes)
  values (pg_temp.id('pic late'), pg_temp.id('biz A'), 'invoice_line', pg_temp.id('inv5 line'),
          pg_temp.id('biz A')::text || '/invoice_line/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5e.png',
          'late.png', 'image/png', 1000) $$)), '23001',
          'an issued invoice''s line takes no new picture');
select is(pg_temp.api_exec('user A', 'biz A', $$
  insert into app.attachments (id, business_id, entity, entity_id, path, file_name, content_type,
                               size_bytes)
  values (pg_temp.id('signed 5'), pg_temp.id('biz A'), 'invoice', pg_temp.id('inv5'),
          pg_temp.id('biz A')::text || '/invoice/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5f.pdf',
          'signed.pdf', 'application/pdf', 1000) $$), 'ok 1',
          'an issued invoice''s own file (a signed delivery note)');
select is(pg_temp.api_exec('user A', 'biz A', $$
  insert into app.document_counters (id, business_id, series, next_no, first_no, prefix, padding)
  values (pg_temp.id('counter inv'), pg_temp.id('biz A'), 'invoice', 5, 1, 'INV-', 4),
         (pg_temp.id('counter cn'), pg_temp.id('biz A'), 'credit_note', 2, 1, 'CN-', 4) $$), 'ok 2',
          'the invoice and credit note series');
select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', $$
  insert into app.document_counters (id, business_id, series, next_no, first_no, prefix)
  values (pg_temp.id('counter x'), pg_temp.id('biz A'), 'receipt', 1, 1, 'R-') $$)), '23514',
          'check: a series from the list');
select is(pg_temp.api_exec('user A', 'biz A', $$
  insert into app.document_renders (id, business_id, kind, document_id)
  values (pg_temp.id('render inv'), pg_temp.id('biz A'), 'invoice', pg_temp.id('inv1')),
         (pg_temp.id('render cn'), pg_temp.id('biz A'), 'credit_note', pg_temp.id('cn1')),
         (pg_temp.id('render st'), pg_temp.id('biz A'), 'statement', pg_temp.id('cust A')) $$),
          'ok 3', 'PDFs of invoices, credit notes and statements are counted');
select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', $$
  insert into app.document_renders (id, business_id, kind, document_id)
  values (pg_temp.id('render x'), pg_temp.id('biz A'), 'receipt', pg_temp.id('inv1')) $$)),
          '23514', 'check: a PDF''s kind from the list');

-- 9. An order cancelled once its invoices are credited; the books-closed date (9) -------------------

select is(pg_temp.api_exec('user A', 'biz A', pg_temp.credit_sql('cn3a', 'inv3')), 'ok 1',
          'setup: a credit note of invoice 3');
select is(pg_temp.api_exec('user A', 'biz A', $$
  update app.credit_notes
     set status = 'issued', seq = 2, number = 'CN-0002', issue_date = date '2026-01-21',
         issued_at = now(), issued_by = pg_temp.id('user A'), value_before = 100, value_after = 40,
         net_total = 60, total = 60, customer_name = 'Gulf Horizon', seller_name = 'Alpha Joinery'
   where id = pg_temp.id('cn3a') $$), 'ok 1', 'setup: it credits 60 of its 100');
select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', $$
  update app.orders set status = 'cancelled', cancelled_at = now(),
                        cancelled_by = pg_temp.id('user A')
   where id = pg_temp.id('order A') $$)), '23514',
          'an order is not cancelled while its invoice is credited in part');
select is(pg_temp.api_exec('user A', 'biz A', pg_temp.credit_sql('cn3b', 'inv3',
  ', status, seq, number, issue_date, issued_at, issued_by, value_before, value_after, net_total, total, customer_name, seller_name',
  ', ''issued'', 3, ''CN-0003'', date ''2026-01-21'', now(), pg_temp.id(''user A''), 40, 0, 40, 40, ''Gulf Horizon'', ''Alpha Joinery''')),
          'ok 1', 'setup: a second credit note takes the rest');
select is(pg_temp.api_exec('user A', 'biz A', $$
  update app.orders set status = 'cancelled', cancelled_at = now(),
                        cancelled_by = pg_temp.id('user A')
   where id = pg_temp.id('order A') $$), 'ok 1',
          'an order whose invoices are fully credited is cancelled');
select is(pg_temp.api_exec('user A', 'biz A', $$
  update app.businesses set books_closed_through = date '2026-01-25'
   where id = pg_temp.id('biz A') $$), 'ok 1', 'setup: the books closed up to the 25th');
select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', pg_temp.posted_sale_sql('cn1 sale 2',
  'credit_note', ', credit_note_id, refund_by', ', pg_temp.id(''cn1''), ''amount'''))), 'BZ412',
          'no credit note''s sale on or before that day');
select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A',
  pg_temp.pay_sql('pay closed', 'invoice_id', 'inv1'))), 'BZ412',
          'no payment on an invoice on or before that day');
select is(pg_temp.api_exec('user A', 'biz A', $$
  update app.businesses set books_closed_through = null where id = pg_temp.id('biz A') $$), 'ok 1',
          'setup: the books opened again');

-- 10. The review's guards (10) -----------------------------------------------------------------------

select is(pg_temp.api_exec('user A', 'biz A', $$
  insert into app.orders (id, business_id, seq, number, customer_id, business_date, location_id,
                          channel_id, currency, net_total, total)
  values (pg_temp.id('order P'), pg_temp.id('biz A'), 1002, '#1002', pg_temp.id('cust A'),
          date '2026-01-20', pg_temp.id('loc A'), pg_temp.id('chan A'), 'AED', 1000, 1000) $$),
          'ok 1', 'setup: a pending order of 1,000');
select is(pg_temp.api_exec('user A', 'biz A', pg_temp.inv_sql('inv6',
  ', order_id, net_total, total, payable', ', pg_temp.id(''order P''), 300, 300, 300')), 'ok 1',
          'setup: an invoice of 300 of it');
select is(pg_temp.api_exec('user A', 'biz A', pg_temp.issue_sql('inv6', 5)), 'ok 1',
          'setup: issued');
select is(pg_temp.api_exec('user A', 'biz A', pg_temp.pay_sql('pay part', 'order_id', 'order P')),
          'ok 1', 'an order its invoices bill in part still takes a payment');
select is(pg_temp.api_exec('user A', 'biz A', pg_temp.inv_sql('inv7',
  ', order_id, net_total, total, payable', ', pg_temp.id(''order P''), 700, 700, 700')) || ' / ' ||
  pg_temp.api_exec('user A', 'biz A', pg_temp.issue_sql('inv7', 6)), 'ok 1 / ok 1',
          'setup: the rest invoiced');
select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A',
  pg_temp.pay_sql('pay full', 'order_id', 'order P'))), '23514',
          'an order its invoices bill in full is paid through them');
select is(pg_temp.api_exec('user A', 'biz A', $$
  insert into app.locations (id, business_id, name, is_default)
  values (pg_temp.id('loc A2'), pg_temp.id('biz A'), 'Marina', false) $$), 'ok 1',
          'setup: a second branch of A');
select is(pg_temp.api_exec('user A', 'biz A', $$
  update app.orders set location_id = pg_temp.id('loc A2') where id = pg_temp.id('order P') $$),
          'ERROR 23514: an order an issued invoice refers to keeps its branch',
          'an order an issued invoice refers to keeps its branch');
select is(pg_temp.api_exec('user A', 'biz A', $$
  insert into app.quotations (id, business_id, seq, number, root_id, customer_id, location_id,
                              business_date, currency, status, sent_at, sent_by, accepted_at,
                              accepted_by)
  values (pg_temp.id('q1'), pg_temp.id('biz A'), 1, 'Q-0001', pg_temp.id('q1'), pg_temp.id('cust A'),
          pg_temp.id('loc A'), date '2026-01-20', 'AED', 'accepted', now(), pg_temp.id('user A'),
          now(), pg_temp.id('user A')) $$) || ' / ' ||
  pg_temp.api_exec('user A', 'biz A', pg_temp.inv_sql('inv8',
    ', quotation_id, bills, bill_amount, bill_stage, net_total, total, payable',
    ', pg_temp.id(''q1''), ''part'', 100, 0, 100, 100, 100')) || ' / ' ||
  pg_temp.api_exec('user A', 'biz A', pg_temp.issue_sql('inv8', 7)) || ' / ' ||
  pg_temp.api_exec('user A', 'biz A', $$
    update app.quotations set order_id = pg_temp.id('order A') where id = pg_temp.id('q1') $$),
          'ok 1 / ok 1 / ok 1 / ERROR 23514: a quotation an issued invoice bills is not made an order',
          'a quotation an issued invoice bills is never made an order');
select is(pg_temp.api_exec('user A', 'biz A', pg_temp.inv_sql('inv9', ', order_id',
    ', pg_temp.id(''order P'')')) || ' / ' ||
  pg_temp.api_exec('user A', 'biz A', $$
    update app.invoices set location_id = pg_temp.id('loc A2') where id = pg_temp.id('inv9') $$) ||
  ' / ' || pg_temp.api_exec('user A', 'biz A', pg_temp.issue_sql('inv9', 8)),
          'ok 1 / ok 1 / ERROR 23514: an invoice made from a source is issued from its branch',
          'an invoice made from an order is issued from its branch');

select * from finish();
rollback;

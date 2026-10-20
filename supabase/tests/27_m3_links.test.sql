-- pgTAP: the tables of Sales & Profit never link across businesses (M3 Step 10; DATA_MODEL.md §1.2,
-- §6, D-047), as 21_m2_links does for the Costing Core. Two businesses, A and B, each with a full set of
-- M3 rows (a sale and its line, a sale they pay later, an import, an order and its line, a quotation and
-- its line, invoices and credit notes, draft and issued, a stored PDF). As bizcost_api in business A,
-- every cross-table link of every M3 table is tried twice: naming A's own row (accepted; the attempt is
-- rolled back) and naming B's row (refused, 23503: the composite foreign key; for the polymorphic links,
-- an attachment's record and a PDF's document, the check_target and check_render_target triggers). A
-- catalog check makes the list complete: every foreign key of an M3 table (other than business_id →
-- businesses) is tried here, and nothing tried is missing from the catalog. Then the structure: the M3
-- tables are exactly the app tables M1 and M2 did not make; each has business_id NOT NULL, ENABLE +
-- FORCE row level security and only the standard InitPlan-safe tenant_isolation policy for bizcost_api;
-- the SECURITY DEFINER functions of schema app are exactly the known ones (M3 added the two audits per
-- statement, D-259, D-262), each with search_path '' and owned by postgres, callable only by
-- bizcost_api; and every trigger on an M3 table runs as the caller (so row level security holds inside
-- it) but the audit triggers, which only write the audit log. 00_catalog_coverage, 01_grants and
-- 03_rls_initplan check the same rules generically for every table and function.
begin;
select plan(190);

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

-- Runs p_sql as bizcost_api with the given user/business: 'ok <row count>' or 'ERROR <sqlstate>: …'.
-- With p_undo, a statement that succeeds is rolled back (the attempt leaves nothing behind).
create function pg_temp.api_run(p_user text, p_business text, p_sql text, p_undo boolean)
returns text
language plpgsql
as $$
declare
  v_out text;
  v_rows bigint;
begin
  perform set_config('app.user_id', pg_temp.id(p_user)::text, true);
  perform set_config('app.business_id', coalesce(pg_temp.id(p_business)::text, ''), true);
  perform set_config('app.request_id', pg_temp.id('request')::text, true);
  begin
    set local role bizcost_api;
    execute p_sql;
    get diagnostics v_rows = row_count;
    v_out := 'ok ' || v_rows;
    if p_undo then
      raise exception using errcode = 'P0001', message = 'undo';
    end if;
  exception when others then
    if not (p_undo and sqlstate = 'P0001' and sqlerrm = 'undo') then
      v_out := 'ERROR ' || sqlstate || ': ' || sqlerrm;
    end if;
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

-- Fixture rows of business `p_side` ('A' or 'B'), as its owner.
create function pg_temp.setup(p_side text, p_sql text)
returns text language sql
as $$ select pg_temp.api_run('user ' || p_side, 'biz ' || p_side,
                             replace(replace(p_sql, '{biz}', 'biz ' || p_side), '{x}', p_side), false) $$;

insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', pg_temp.id(u.name), 'authenticated', 'authenticated',
       u.email, now(), '{}', '{}', now(), now()
  from (values ('user A', 'amal-links@example.test'), ('user B', 'badr-links@example.test')) as u(name, email);

-- 1. Fixtures: the same rows in A and B (2 + 2 × 24 = 50) -----------------------------------------

select is(
  pg_temp.state_of(pg_temp.api_run('user ' || s.x, null, format(
    $$ select app.create_business(pg_temp.id(%L), %L, 'en', 'Owner', pg_temp.id(%L), pg_temp.id(%L)) $$,
    'biz ' || s.x, 'Business ' || s.x, 'biz ' || s.x || ' owner role', 'biz ' || s.x || ' owner member'),
    false)),
  'ok 1',
  'setup: user ' || s.x || ' creates business ' || s.x
)
  from (values ('A'), ('B')) as s(x);

select is(pg_temp.setup(s.x, f.stmt), 'ok 1', 'setup ' || s.x || ': ' || f.what)
  from (values ('A'), ('B')) as s(x)
 cross join (values
    (1, 'a location', $$
      insert into app.locations (id, business_id, name, is_default)
      values (pg_temp.id('loc {x}'), pg_temp.id('{biz}'), 'Main', true) $$),
    (2, 'a material', $$
      insert into app.materials (id, business_id, name, dimension, unit)
      values (pg_temp.id('mat {x}'), pg_temp.id('{biz}'), 'Beans', 'mass', 'kg') $$),
    (3, 'a product', $$
      insert into app.products_services (id, business_id, name, type, unit)
      values (pg_temp.id('prod {x}'), pg_temp.id('{biz}'), 'Latte', 'product', 'piece') $$),
    (4, 'a sales channel', $$
      insert into app.sales_channels (id, business_id, name, kind)
      values (pg_temp.id('chan {x}'), pg_temp.id('{biz}'), 'Shop', 'shop') $$),
    (5, 'a customer', $$
      insert into app.customers (id, business_id, name)
      values (pg_temp.id('cust {x}'), pg_temp.id('{biz}'), 'Gulf Horizon') $$),
    (6, 'a draft import', $$
      insert into app.sale_imports (id, business_id, channel_id, location_id, file_name, file_hash,
                                    fingerprint, shape, period_from, period_to, mapping, rows_read,
                                    row_count)
      values (pg_temp.id('imp {x}'), pg_temp.id('{biz}'), pg_temp.id('chan {x}'), pg_temp.id('loc {x}'),
              'sales.csv', md5('imp {x}') || md5('imp {x}'), repeat('f', 64), 'lines', current_date,
              current_date, '{}', 1, 1) $$),
    (7, 'a draft sale', $$
      insert into app.sales (id, business_id, source, business_date, location_id, channel_id, currency)
      values (pg_temp.id('sale {x}'), pg_temp.id('{biz}'), 'single', current_date, pg_temp.id('loc {x}'),
              pg_temp.id('chan {x}'), 'AED') $$),
    (8, 'its line', $$
      insert into app.sale_lines (id, business_id, sale_id, position, kind, product_id, qty, unit_price)
      values (pg_temp.id('sline {x}'), pg_temp.id('{biz}'), pg_temp.id('sale {x}'), 0, 'item',
              pg_temp.id('prod {x}'), 1, 10) $$),
    (9, 'a sale they pay later, finalized', $$
      insert into app.sales (id, business_id, source, business_date, location_id, channel_id, currency,
                             status, posted_at, posted_by, customer_id, pay_later)
      values (pg_temp.id('psale {x}'), pg_temp.id('{biz}'), 'single', current_date,
              pg_temp.id('loc {x}'), pg_temp.id('chan {x}'), 'AED', 'posted', now(),
              pg_temp.id('user {x}'), pg_temp.id('cust {x}'), true) $$),
    (10, 'a pending order', $$
      insert into app.orders (id, business_id, seq, number, customer_id, business_date, location_id,
                              channel_id, currency)
      values (pg_temp.id('order {x}'), pg_temp.id('{biz}'), 1001, '#1001', pg_temp.id('cust {x}'),
              current_date, pg_temp.id('loc {x}'), pg_temp.id('chan {x}'), 'AED') $$),
    (11, 'its line', $$
      insert into app.order_lines (id, business_id, order_id, position, kind, product_id, qty, unit_price)
      values (pg_temp.id('oline {x}'), pg_temp.id('{biz}'), pg_temp.id('order {x}'), 0, 'item',
              pg_temp.id('prod {x}'), 1, 10) $$),
    (12, 'a draft quotation', $$
      insert into app.quotations (id, business_id, seq, number, root_id, customer_id, location_id,
                                  business_date, currency)
      values (pg_temp.id('quote {x}'), pg_temp.id('{biz}'), 1, 'Q-0001', pg_temp.id('quote {x}'),
              pg_temp.id('cust {x}'), pg_temp.id('loc {x}'), current_date, 'AED') $$),
    (13, 'its line', $$
      insert into app.quotation_lines (id, business_id, quotation_id, position, description, qty,
                                       unit_price)
      values (pg_temp.id('qline {x}'), pg_temp.id('{biz}'), pg_temp.id('quote {x}'), 0, 'Wall cladding',
              1, 100) $$),
    (14, 'a draft invoice', $$
      insert into app.invoices (id, business_id, kind, customer_id, location_id, currency)
      values (pg_temp.id('inv {x}'), pg_temp.id('{biz}'), 'invoice', pg_temp.id('cust {x}'),
              pg_temp.id('loc {x}'), 'AED') $$),
    (15, 'its line', $$
      insert into app.invoice_lines (id, business_id, invoice_id, position, kind, description, qty,
                                     unit_price, net, total)
      values (pg_temp.id('iline {x}'), pg_temp.id('{biz}'), pg_temp.id('inv {x}'), 0, 'item', 'Shelves',
              1, 100, 100, 100) $$),
    (16, 'a second invoice', $$
      insert into app.invoices (id, business_id, kind, customer_id, location_id, currency)
      values (pg_temp.id('issued {x}'), pg_temp.id('{biz}'), 'invoice', pg_temp.id('cust {x}'),
              pg_temp.id('loc {x}'), 'AED') $$),
    (17, 'its line', $$
      insert into app.invoice_lines (id, business_id, invoice_id, position, kind, description, qty,
                                     unit_price, net, total)
      values (pg_temp.id('iline2 {x}'), pg_temp.id('{biz}'), pg_temp.id('issued {x}'), 0, 'item',
              'Doors', 1, 100, 100, 100) $$),
    (18, 'the second invoice issued', $$
      update app.invoices
         set status = 'issued', seq = 1, number = 'INV-0001', issue_date = current_date,
             supply_date = current_date, issued_at = now(), issued_by = pg_temp.id('user {x}'),
             customer_name = 'Gulf Horizon', seller_name = 'Business {x}'
       where id = pg_temp.id('issued {x}') $$),
    (19, 'a draft credit note of it', $$
      insert into app.credit_notes (id, business_id, kind, invoice_id, customer_id, location_id,
                                    event_date, reason, reason_text, credit_by, currency)
      values (pg_temp.id('cn {x}'), pg_temp.id('{biz}'), 'credit_note', pg_temp.id('issued {x}'),
              pg_temp.id('cust {x}'), pg_temp.id('loc {x}'), current_date, 'price_changed', 'Price cut',
              'amount', 'AED') $$),
    (20, 'a second credit note of it', $$
      insert into app.credit_notes (id, business_id, kind, invoice_id, customer_id, location_id,
                                    event_date, reason, reason_text, credit_by, currency)
      values (pg_temp.id('cn2 {x}'), pg_temp.id('{biz}'), 'credit_note', pg_temp.id('issued {x}'),
              pg_temp.id('cust {x}'), pg_temp.id('loc {x}'), current_date, 'price_changed', 'Price cut',
              'amount', 'AED') $$),
    (21, 'the second credit note issued', $$
      update app.credit_notes
         set status = 'issued', seq = 1, number = 'CN-0001', issue_date = current_date,
             issued_at = now(), issued_by = pg_temp.id('user {x}'), value_before = 100,
             value_after = 90, customer_name = 'Gulf Horizon', seller_name = 'Business {x}'
       where id = pg_temp.id('cn2 {x}') $$),
    (22, 'a stored PDF', $$
      insert into app.file_uploads (id, business_id, path, purpose, content_type, expires_at)
      values (pg_temp.id('pdf {x}'), pg_temp.id('{biz}'), pg_temp.id('{biz}')::text || '/document/x.pdf',
              'document', 'application/pdf', now() + interval '1 hour') $$),
    (23, 'a second order, pending', $$
      insert into app.orders (id, business_id, seq, number, business_date, location_id, channel_id,
                              currency)
      values (pg_temp.id('order2 {x}'), pg_temp.id('{biz}'), 1002, '#1002', current_date,
              pg_temp.id('loc {x}'), pg_temp.id('chan {x}'), 'AED') $$),
    (24, 'the sale of its delivery, finalized', $$
      insert into app.sales (id, business_id, source, business_date, location_id, channel_id, currency,
                             order_id, status, posted_at, posted_by)
      values (pg_temp.id('osale {x}'), pg_temp.id('{biz}'), 'order', current_date, pg_temp.id('loc {x}'),
              pg_temp.id('chan {x}'), 'AED', pg_temp.id('order2 {x}'), 'posted', now(),
              pg_temp.id('user {x}')) $$)
  ) as f(n, what, stmt)
 order by s.x, f.n;

-- 2. Every link: A's own row is accepted, B's refused (2 × 66 = 132, then 1) ----------------------
-- `:t` in a statement is the target: A's row named `<target> A`, or B's named `<target> B`.

create temp table links (n integer, child text, cols text, target text, what text, stmt text);
insert into links values
  (1, 'channel_statements', 'channel_id', 'chan', 'a statement and its channel', $$
    insert into app.channel_statements (id, business_id, channel_id, period_from, period_to)
    values (pg_temp.id('t'), pg_temp.id('biz A'), :t, current_date, current_date) $$),
  (2, 'channel_statements', 'import_id', 'imp', 'a statement and the file whose fees it holds', $$
    insert into app.channel_statements (id, business_id, channel_id, period_from, period_to, import_id)
    values (pg_temp.id('t'), pg_temp.id('biz A'), pg_temp.id('chan A'), current_date, current_date, :t) $$),
  (3, 'credit_note_lines', 'credit_note_id', 'cn', 'a credit note line and its credit note', $$
    insert into app.credit_note_lines (id, business_id, credit_note_id, position, invoice_line_id,
                                       description, qty, unit_price)
    values (pg_temp.id('t'), pg_temp.id('biz A'), :t, 0, pg_temp.id('iline2 A'), 'Doors', 1, 10) $$),
  (4, 'credit_note_lines', 'invoice_line_id', 'iline2', 'a credit note line and the invoice line it credits', $$
    insert into app.credit_note_lines (id, business_id, credit_note_id, position, invoice_line_id,
                                       description, qty, unit_price)
    values (pg_temp.id('t'), pg_temp.id('biz A'), pg_temp.id('cn A'), 0, :t, 'Doors', 1, 10) $$),
  (5, 'credit_notes', 'customer_id', 'cust', 'a credit note and its customer', $$
    insert into app.credit_notes (id, business_id, kind, invoice_id, customer_id, location_id, event_date,
                                  reason, reason_text, credit_by, currency)
    values (pg_temp.id('t'), pg_temp.id('biz A'), 'credit_note', pg_temp.id('issued A'), :t,
            pg_temp.id('loc A'), current_date, 'price_changed', 'Price cut', 'amount', 'AED') $$),
  (6, 'credit_notes', 'invoice_id', 'issued', 'a credit note and the invoice it credits', $$
    insert into app.credit_notes (id, business_id, kind, invoice_id, customer_id, location_id, event_date,
                                  reason, reason_text, credit_by, currency)
    values (pg_temp.id('t'), pg_temp.id('biz A'), 'credit_note', :t, pg_temp.id('cust A'),
            pg_temp.id('loc A'), current_date, 'price_changed', 'Price cut', 'amount', 'AED') $$),
  (7, 'credit_notes', 'location_id', 'loc', 'a credit note and its branch', $$
    insert into app.credit_notes (id, business_id, kind, invoice_id, customer_id, location_id, event_date,
                                  reason, reason_text, credit_by, currency)
    values (pg_temp.id('t'), pg_temp.id('biz A'), 'credit_note', pg_temp.id('issued A'),
            pg_temp.id('cust A'), :t, current_date, 'price_changed', 'Price cut', 'amount', 'AED') $$),
  (8, 'credit_notes', 'pdf_upload_id', 'pdf', 'an issued credit note and its stored PDF', $$
    update app.credit_notes set pdf_upload_id = :t where id = pg_temp.id('cn2 A') $$),
  (9, 'customer_payments', 'customer_id', 'cust', 'a customer payment and its customer', $$
    insert into app.customer_payments (id, business_id, customer_id, sale_id, business_date, method,
                                       amount, currency)
    values (pg_temp.id('t'), pg_temp.id('biz A'), :t, pg_temp.id('psale A'), current_date, 'cash', 5,
            'AED') $$),
  (10, 'customer_payments', 'invoice_id', 'issued', 'a payment and the invoice it pays', $$
    insert into app.customer_payments (id, business_id, customer_id, invoice_id, business_date, method,
                                       amount, currency)
    values (pg_temp.id('t'), pg_temp.id('biz A'), pg_temp.id('cust A'), :t, current_date, 'cash', 5,
            'AED') $$),
  (11, 'customer_payments', 'order_id', 'order', 'a payment and the order it pays', $$
    insert into app.customer_payments (id, business_id, customer_id, order_id, business_date, method,
                                       amount, currency)
    values (pg_temp.id('t'), pg_temp.id('biz A'), pg_temp.id('cust A'), :t, current_date, 'cash', 5,
            'AED') $$),
  (12, 'customer_payments', 'sale_id', 'psale', 'a payment and the sale they pay later', $$
    insert into app.customer_payments (id, business_id, customer_id, sale_id, business_date, method,
                                       amount, currency)
    values (pg_temp.id('t'), pg_temp.id('biz A'), pg_temp.id('cust A'), :t, current_date, 'cash', 5,
            'AED') $$),
  (13, 'invoice_lines', 'deposit_invoice_id', 'issued', 'a final invoice''s deduction and its deposit invoice', $$
    insert into app.invoice_lines (id, business_id, invoice_id, position, kind, description, qty,
                                   unit_price, deposit_invoice_id)
    values (pg_temp.id('t'), pg_temp.id('biz A'), pg_temp.id('inv A'), 1, 'deduction', 'Deposit', -1, 50,
            :t) $$),
  (14, 'invoice_lines', 'invoice_id', 'inv', 'an invoice line and its invoice', $$
    insert into app.invoice_lines (id, business_id, invoice_id, position, kind, description, qty, unit_price)
    values (pg_temp.id('t'), pg_temp.id('biz A'), :t, 1, 'item', 'Shelves', 1, 100) $$),
  (15, 'invoice_lines', 'product_id', 'prod', 'an invoice line and its product', $$
    insert into app.invoice_lines (id, business_id, invoice_id, position, kind, product_id, description,
                                   qty, unit_price)
    values (pg_temp.id('t'), pg_temp.id('biz A'), pg_temp.id('inv A'), 1, 'item', :t, 'Latte', 1, 10) $$),
  (16, 'invoice_lines', 'sale_line_id', 'sline', 'an invoice line and the sale line it counts', $$
    insert into app.invoice_lines (id, business_id, invoice_id, position, kind, description, qty,
                                   unit_price, sale_line_id)
    values (pg_temp.id('t'), pg_temp.id('biz A'), pg_temp.id('inv A'), 1, 'item', 'Latte', 1, 10, :t) $$),
  (17, 'invoices', 'channel_id', 'chan', 'an invoice and its channel', $$
    insert into app.invoices (id, business_id, kind, customer_id, location_id, currency, channel_id)
    values (pg_temp.id('t'), pg_temp.id('biz A'), 'invoice', pg_temp.id('cust A'), pg_temp.id('loc A'),
            'AED', :t) $$),
  (18, 'invoices', 'customer_id', 'cust', 'an invoice and its customer', $$
    insert into app.invoices (id, business_id, kind, customer_id, location_id, currency)
    values (pg_temp.id('t'), pg_temp.id('biz A'), 'invoice', :t, pg_temp.id('loc A'), 'AED') $$),
  (19, 'invoices', 'location_id', 'loc', 'an invoice and its branch', $$
    insert into app.invoices (id, business_id, kind, customer_id, location_id, currency)
    values (pg_temp.id('t'), pg_temp.id('biz A'), 'invoice', pg_temp.id('cust A'), :t, 'AED') $$),
  (20, 'invoices', 'order_id', 'order', 'an invoice and the order it bills', $$
    insert into app.invoices (id, business_id, kind, customer_id, location_id, currency, order_id)
    values (pg_temp.id('t'), pg_temp.id('biz A'), 'invoice', pg_temp.id('cust A'), pg_temp.id('loc A'),
            'AED', :t) $$),
  (21, 'invoices', 'pdf_upload_id', 'pdf', 'an issued invoice and its stored PDF', $$
    update app.invoices set pdf_upload_id = :t where id = pg_temp.id('issued A') $$),
  (22, 'invoices', 'quotation_id', 'quote', 'an invoice and the quotation it bills', $$
    insert into app.invoices (id, business_id, kind, customer_id, location_id, currency, quotation_id)
    values (pg_temp.id('t'), pg_temp.id('biz A'), 'invoice', pg_temp.id('cust A'), pg_temp.id('loc A'),
            'AED', :t) $$),
  (23, 'invoices', 'sale_id', 'psale', 'an invoice and the sale it is made from', $$
    insert into app.invoices (id, business_id, kind, customer_id, location_id, currency, sale_id)
    values (pg_temp.id('t'), pg_temp.id('biz A'), 'invoice', pg_temp.id('cust A'), pg_temp.id('loc A'),
            'AED', :t) $$),
  (24, 'order_lines', 'order_id', 'order', 'an order line and its order', $$
    insert into app.order_lines (id, business_id, order_id, position, kind, product_id, qty, unit_price)
    values (pg_temp.id('t'), pg_temp.id('biz A'), :t, 1, 'item', pg_temp.id('prod A'), 1, 10) $$),
  (25, 'order_lines', 'product_id', 'prod', 'an order line and its product', $$
    insert into app.order_lines (id, business_id, order_id, position, kind, product_id, qty, unit_price)
    values (pg_temp.id('t'), pg_temp.id('biz A'), pg_temp.id('order A'), 1, 'item', :t, 1, 10) $$),
  (26, 'orders', 'channel_id', 'chan', 'an order and its channel', $$
    insert into app.orders (id, business_id, seq, number, business_date, location_id, channel_id, currency)
    values (pg_temp.id('t'), pg_temp.id('biz A'), 1003, '#1003', current_date, pg_temp.id('loc A'), :t,
            'AED') $$),
  (27, 'orders', 'customer_id', 'cust', 'an order and its customer', $$
    insert into app.orders (id, business_id, seq, number, customer_id, business_date, location_id,
                            channel_id, currency)
    values (pg_temp.id('t'), pg_temp.id('biz A'), 1003, '#1003', :t, current_date, pg_temp.id('loc A'),
            pg_temp.id('chan A'), 'AED') $$),
  (28, 'orders', 'location_id', 'loc', 'an order and its branch', $$
    insert into app.orders (id, business_id, seq, number, business_date, location_id, channel_id, currency)
    values (pg_temp.id('t'), pg_temp.id('biz A'), 1003, '#1003', current_date, :t, pg_temp.id('chan A'),
            'AED') $$),
  (29, 'orders', 'sale_id', 'osale', 'an order delivered and the sale of its delivery', $$
    update app.orders
       set status = 'delivered', delivered_on = current_date, sale_id = :t, delivered_at = now(),
           delivered_by = pg_temp.id('user A')
     where id = pg_temp.id('order2 A') $$),
  (30, 'product_aliases', 'product_id', 'prod', 'a remembered answer and its product', $$
    insert into app.product_aliases (id, business_id, source, kind, key, raw, target, product_id)
    values (pg_temp.id('t'), pg_temp.id('biz A'), 'file', 'name', 'latte l', 'Latte L', 'product', :t) $$),
  (31, 'quotation_lines', 'product_id', 'prod', 'a quotation line and its product', $$
    insert into app.quotation_lines (id, business_id, quotation_id, position, product_id, description,
                                     qty, unit_price)
    values (pg_temp.id('t'), pg_temp.id('biz A'), pg_temp.id('quote A'), 1, :t, 'Latte', 1, 10) $$),
  (32, 'quotation_lines', 'quotation_id', 'quote', 'a quotation line and its quotation', $$
    insert into app.quotation_lines (id, business_id, quotation_id, position, description, qty, unit_price)
    values (pg_temp.id('t'), pg_temp.id('biz A'), :t, 1, 'Wall cladding', 1, 100) $$),
  (33, 'quotation_stages', 'quotation_id', 'quote', 'a stage and its quotation', $$
    insert into app.quotation_stages (id, business_id, quotation_id, position, due, percent, amount)
    values (pg_temp.id('t'), pg_temp.id('biz A'), :t, 0, 'Now', 100, 100) $$),
  (34, 'quotations', 'copied_from_id', 'quote', 'a quotation and the one it was copied from', $$
    insert into app.quotations (id, business_id, seq, number, root_id, customer_id, location_id,
                                business_date, currency, copied_from_id)
    values (pg_temp.id('t'), pg_temp.id('biz A'), 2, 'Q-0002', pg_temp.id('t'), pg_temp.id('cust A'),
            pg_temp.id('loc A'), current_date, 'AED', :t) $$),
  (35, 'quotations', 'customer_id', 'cust', 'a quotation and its customer', $$
    insert into app.quotations (id, business_id, seq, number, root_id, customer_id, location_id,
                                business_date, currency)
    values (pg_temp.id('t'), pg_temp.id('biz A'), 2, 'Q-0002', pg_temp.id('t'), :t, pg_temp.id('loc A'),
            current_date, 'AED') $$),
  (36, 'quotations', 'invoice_id', 'issued', 'a quotation and the invoice made from it', $$
    insert into app.quotations (id, business_id, seq, number, root_id, customer_id, location_id,
                                business_date, currency, invoice_id)
    values (pg_temp.id('t'), pg_temp.id('biz A'), 2, 'Q-0002', pg_temp.id('t'), pg_temp.id('cust A'),
            pg_temp.id('loc A'), current_date, 'AED', :t) $$),
  (37, 'quotations', 'location_id', 'loc', 'a quotation and its branch', $$
    insert into app.quotations (id, business_id, seq, number, root_id, customer_id, location_id,
                                business_date, currency)
    values (pg_temp.id('t'), pg_temp.id('biz A'), 2, 'Q-0002', pg_temp.id('t'), pg_temp.id('cust A'), :t,
            current_date, 'AED') $$),
  (38, 'quotations', 'order_id', 'order', 'an accepted quotation and the order made from it', $$
    insert into app.quotations (id, business_id, seq, number, root_id, customer_id, location_id,
                                business_date, currency, status, sent_at, sent_by, accepted_at,
                                accepted_by, order_id)
    values (pg_temp.id('t'), pg_temp.id('biz A'), 2, 'Q-0002', pg_temp.id('t'), pg_temp.id('cust A'),
            pg_temp.id('loc A'), current_date, 'AED', 'accepted', now(), pg_temp.id('user A'), now(),
            pg_temp.id('user A'), :t) $$),
  (39, 'quotations', 'root_id', 'quote', 'a revision and its first revision', $$
    insert into app.quotations (id, business_id, seq, number, root_id, revision, customer_id, location_id,
                                business_date, currency, status, sent_at, sent_by)
    values (pg_temp.id('t'), pg_temp.id('biz A'), 1, 'Q-0001', :t, 2, pg_temp.id('cust A'),
            pg_temp.id('loc A'), current_date, 'AED', 'sent', now(), pg_temp.id('user A')) $$),
  (40, 'sale_import_rows', 'import_id', 'imp', 'a staged row and its import', $$
    insert into app.sale_import_rows (id, business_id, import_id, position, business_date, name, qty,
                                      amount, file_rows)
    values (pg_temp.id('t'), pg_temp.id('biz A'), :t, 0, current_date, 'Latte', 1, 10, 1) $$),
  (41, 'sale_imports', 'channel_id', 'chan', 'an import and its channel', $$
    insert into app.sale_imports (id, business_id, channel_id, location_id, file_name, file_hash,
                                  fingerprint, shape, period_from, period_to, mapping, rows_read, row_count)
    values (pg_temp.id('t'), pg_temp.id('biz A'), :t, pg_temp.id('loc A'), 'b.csv', repeat('c', 64),
            repeat('f', 64), 'lines', current_date, current_date, '{}', 1, 1) $$),
  (42, 'sale_imports', 'location_id', 'loc', 'an import and its branch', $$
    insert into app.sale_imports (id, business_id, channel_id, location_id, file_name, file_hash,
                                  fingerprint, shape, period_from, period_to, mapping, rows_read, row_count)
    values (pg_temp.id('t'), pg_temp.id('biz A'), pg_temp.id('chan A'), :t, 'b.csv', repeat('c', 64),
            repeat('f', 64), 'lines', current_date, current_date, '{}', 1, 1) $$),
  (43, 'sale_line_materials', 'material_id', 'mat', 'what a sale line used and its material', $$
    insert into app.sale_line_materials (id, business_id, sale_id, sale_line_id, material_id, base_qty)
    values (pg_temp.id('t'), pg_temp.id('biz A'), pg_temp.id('sale A'), pg_temp.id('sline A'), :t, 1) $$),
  (44, 'sale_line_materials', 'sale_id', 'sale', 'what a sale line used and its sale', $$
    insert into app.sale_line_materials (id, business_id, sale_id, sale_line_id, material_id, base_qty)
    values (pg_temp.id('t'), pg_temp.id('biz A'), :t, pg_temp.id('sline A'), pg_temp.id('mat A'), 1) $$),
  (45, 'sale_line_materials', 'sale_id,sale_line_id', 'sline', 'what a sale line used and its line', $$
    insert into app.sale_line_materials (id, business_id, sale_id, sale_line_id, material_id, base_qty)
    values (pg_temp.id('t'), pg_temp.id('biz A'), pg_temp.id('sale A'), :t, pg_temp.id('mat A'), 1) $$),
  (46, 'sale_lines', 'product_id', 'prod', 'a sale line and its product', $$
    insert into app.sale_lines (id, business_id, sale_id, position, kind, product_id, qty, unit_price)
    values (pg_temp.id('t'), pg_temp.id('biz A'), pg_temp.id('sale A'), 1, 'item', :t, 1, 10) $$),
  (47, 'sale_lines', 'refund_of_line_id', 'sline', 'a refund''s line and the line it takes back', $$
    insert into app.sale_lines (id, business_id, sale_id, position, kind, product_id, qty, unit_price,
                                refund_of_line_id)
    values (pg_temp.id('t'), pg_temp.id('biz A'), pg_temp.id('sale A'), 1, 'item', pg_temp.id('prod A'),
            1, 10, :t) $$),
  (48, 'sale_lines', 'sale_id', 'sale', 'a sale line and its sale', $$
    insert into app.sale_lines (id, business_id, sale_id, position, kind, product_id, qty, unit_price)
    values (pg_temp.id('t'), pg_temp.id('biz A'), :t, 1, 'item', pg_temp.id('prod A'), 1, 10) $$),
  (49, 'sales', 'channel_id', 'chan', 'a sale and its channel', $$
    insert into app.sales (id, business_id, source, business_date, location_id, channel_id, currency)
    values (pg_temp.id('t'), pg_temp.id('biz A'), 'single', current_date, pg_temp.id('loc A'), :t, 'AED') $$),
  (50, 'sales', 'copied_from_id', 'sale', 'a corrected copy and the sale it replaces', $$
    insert into app.sales (id, business_id, source, business_date, location_id, channel_id, currency,
                           copied_from_id)
    values (pg_temp.id('t'), pg_temp.id('biz A'), 'single', current_date, pg_temp.id('loc A'),
            pg_temp.id('chan A'), 'AED', :t) $$),
  (51, 'sales', 'credit_note_id', 'cn2', 'a credit note''s sale and its credit note', $$
    insert into app.sales (id, business_id, source, business_date, location_id, channel_id, currency,
                           refund_by, credit_note_id)
    values (pg_temp.id('t'), pg_temp.id('biz A'), 'credit_note', current_date, pg_temp.id('loc A'),
            pg_temp.id('chan A'), 'AED', 'amount', :t) $$),
  (52, 'sales', 'customer_id', 'cust', 'a sale and its customer', $$
    insert into app.sales (id, business_id, source, business_date, location_id, channel_id, currency,
                           customer_id)
    values (pg_temp.id('t'), pg_temp.id('biz A'), 'single', current_date, pg_temp.id('loc A'),
            pg_temp.id('chan A'), 'AED', :t) $$),
  (53, 'sales', 'import_id', 'imp', 'an imported sale and its import', $$
    insert into app.sales (id, business_id, source, business_date, location_id, channel_id, currency,
                           import_id)
    values (pg_temp.id('t'), pg_temp.id('biz A'), 'import', current_date, pg_temp.id('loc A'),
            pg_temp.id('chan A'), 'AED', :t) $$),
  (54, 'sales', 'invoice_id', 'issued', 'an invoice''s sale and its invoice', $$
    insert into app.sales (id, business_id, source, business_date, location_id, channel_id, currency,
                           invoice_id)
    values (pg_temp.id('t'), pg_temp.id('biz A'), 'invoice', current_date, pg_temp.id('loc A'),
            pg_temp.id('chan A'), 'AED', :t) $$),
  (55, 'sales', 'location_id', 'loc', 'a sale and its branch', $$
    insert into app.sales (id, business_id, source, business_date, location_id, channel_id, currency)
    values (pg_temp.id('t'), pg_temp.id('biz A'), 'single', current_date, :t, pg_temp.id('chan A'), 'AED') $$),
  (56, 'sales', 'order_id', 'order', 'an order''s sale and its order', $$
    insert into app.sales (id, business_id, source, business_date, location_id, channel_id, currency,
                           order_id)
    values (pg_temp.id('t'), pg_temp.id('biz A'), 'order', current_date, pg_temp.id('loc A'),
            pg_temp.id('chan A'), 'AED', :t) $$),
  (57, 'sales', 'refund_of_id', 'psale', 'a refund and the sale it takes back', $$
    insert into app.sales (id, business_id, source, business_date, location_id, channel_id, currency,
                           refund_by, refund_of_id)
    values (pg_temp.id('t'), pg_temp.id('biz A'), 'refund', current_date, pg_temp.id('loc A'),
            pg_temp.id('chan A'), 'AED', 'amount', :t) $$),
  (58, 'attachments', 'entity_id', 'order', 'a file and its order (check_target)', $$
    insert into app.attachments (id, business_id, entity, entity_id, path, file_name, content_type, size_bytes)
    values (pg_temp.id('t'), pg_temp.id('biz A'), 'order', :t, pg_temp.id('biz A') || '/order/t.pdf',
            'lpo.pdf', 'application/pdf', 10) $$),
  (59, 'attachments', 'entity_id', 'quote', 'a file and its quotation (check_target)', $$
    insert into app.attachments (id, business_id, entity, entity_id, path, file_name, content_type, size_bytes)
    values (pg_temp.id('t'), pg_temp.id('biz A'), 'quotation', :t, pg_temp.id('biz A') || '/quotation/t.pdf',
            'drawing.pdf', 'application/pdf', 10) $$),
  (60, 'attachments', 'entity_id', 'qline', 'a picture and its quotation line (check_target)', $$
    insert into app.attachments (id, business_id, entity, entity_id, path, file_name, content_type, size_bytes)
    values (pg_temp.id('t'), pg_temp.id('biz A'), 'quotation_line', :t,
            pg_temp.id('biz A') || '/quotation_line/t.png', 'panel.png', 'image/png', 10) $$),
  (61, 'attachments', 'entity_id', 'inv', 'a file and its invoice (check_target)', $$
    insert into app.attachments (id, business_id, entity, entity_id, path, file_name, content_type, size_bytes)
    values (pg_temp.id('t'), pg_temp.id('biz A'), 'invoice', :t, pg_temp.id('biz A') || '/invoice/t.pdf',
            'lpo.pdf', 'application/pdf', 10) $$),
  (62, 'attachments', 'entity_id', 'iline', 'a picture and its invoice line (check_target)', $$
    insert into app.attachments (id, business_id, entity, entity_id, path, file_name, content_type, size_bytes)
    values (pg_temp.id('t'), pg_temp.id('biz A'), 'invoice_line', :t,
            pg_temp.id('biz A') || '/invoice_line/t.png', 'door.png', 'image/png', 10) $$),
  (63, 'document_renders', 'document_id', 'quote', 'a PDF made and its quotation (check_render_target)', $$
    insert into app.document_renders (id, business_id, kind, document_id)
    values (pg_temp.id('t'), pg_temp.id('biz A'), 'quotation', :t) $$),
  (64, 'document_renders', 'document_id', 'inv', 'a PDF made and its invoice (check_render_target)', $$
    insert into app.document_renders (id, business_id, kind, document_id)
    values (pg_temp.id('t'), pg_temp.id('biz A'), 'invoice', :t) $$),
  (65, 'document_renders', 'document_id', 'cn', 'a PDF made and its credit note (check_render_target)', $$
    insert into app.document_renders (id, business_id, kind, document_id)
    values (pg_temp.id('t'), pg_temp.id('biz A'), 'credit_note', :t) $$),
  (66, 'document_renders', 'document_id', 'cust', 'a statement made and its customer (check_render_target)', $$
    insert into app.document_renders (id, business_id, kind, document_id)
    values (pg_temp.id('t'), pg_temp.id('biz A'), 'statement', :t) $$);

select is(
  pg_temp.state_of(pg_temp.api_run('user A', 'biz A',
    replace(l.stmt, ':t', format('pg_temp.id(%L)', l.target || ' ' || s.side)), true)),
  case s.side when 'A' then 'ok 1' else '23503' end,
  l.child || '.' || l.cols || ' — ' || l.what || case s.side when 'A' then ': its own business''s row' else ': never another business''s row' end
)
  from links l
 cross join (values (1, 'A'), (2, 'B')) as s(k, side)
 order by l.n, s.k;

-- The M3 tables: every app table that Milestone 1 and M2 did not make.
create temp view m3_tables as
  select c.relname::text as table_name
    from pg_class c
   where c.relnamespace = 'app'::regnamespace and c.relkind in ('r', 'p')
     and c.relname::text <> all (array[
       'profiles', 'businesses', 'business_capabilities', 'business_modules', 'locations',
       'roles', 'role_permissions', 'business_members', 'member_permission_overrides',
       'member_locations', 'business_invitations', 'setup_answers', 'file_uploads', 'audit_log',
       'materials', 'material_units', 'products_services', 'product_locations',
       'suppliers', 'purchases', 'purchase_lines', 'purchase_returns', 'purchase_return_lines',
       'stock_movements', 'material_costs', 'stock_balances', 'attachments',
       'recipes', 'recipe_lines', 'purchase_payments',
       'cost_categories', 'expenses', 'expense_payments', 'running_costs'
     ]);

-- Every foreign key of an M3 table (but business_id → businesses) is tried above, and nothing else.
select is_empty(
  $$ (select c.conrelid::regclass::text as child,
             (select string_agg(a.attname, ',' order by k.i)
                from unnest(c.conkey) with ordinality as k(attnum, i)
                join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
               where a.attname <> 'business_id') as cols
        from pg_constraint c
       where c.contype = 'f'
         and c.conrelid in (select to_regclass('app.' || table_name) from m3_tables)
         and c.confrelid <> 'app.businesses'::regclass
      except
      select 'app.' || child, cols from links)
     union all
     (select 'app.' || child, cols from links where child not in ('attachments', 'document_renders')
      except
      select c.conrelid::regclass::text,
             (select string_agg(a.attname, ',' order by k.i)
                from unnest(c.conkey) with ordinality as k(attnum, i)
                join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
               where a.attname <> 'business_id')
        from pg_constraint c
       where c.contype = 'f' and c.confrelid <> 'app.businesses'::regclass) $$,
  'every foreign key of an M3 table is tried across businesses above, and every link tried is a foreign key'
);

-- 3. Structure of the M3 tables, the SECURITY DEFINER functions and the triggers (7) ----------------

select is(
  (select array_agg(table_name order by table_name) from m3_tables),
  array[
    'channel_statements', 'credit_note_lines', 'credit_notes', 'customer_payments', 'customers',
    'document_counters', 'document_renders', 'import_profiles', 'invoice_lines', 'invoices',
    'order_lines', 'orders', 'product_aliases', 'quotation_lines', 'quotation_stages', 'quotations',
    'sale_import_rows', 'sale_imports', 'sale_line_materials', 'sale_lines', 'sales', 'sales_channels'
  ],
  'the M3 tables are the 22 of Sales & Profit (a new one joins this list and the links above)'
);

select is_empty(
  $$ select m.table_name
       from m3_tables m
       left join pg_class c on c.oid = to_regclass('app.' || m.table_name)
       left join pg_attribute a on a.attrelid = c.oid and a.attname = 'business_id' and not a.attisdropped
      where c.oid is null or a.attnum is null or not a.attnotnull
         or not c.relrowsecurity or not c.relforcerowsecurity $$,
  'every M3 table has business_id NOT NULL and ENABLE + FORCE row level security'
);

select is_empty(
  $$ select m.table_name, p.polname
       from m3_tables m
       left join pg_policy p on p.polrelid = to_regclass('app.' || m.table_name)
      where p.polname is distinct from 'tenant_isolation'
         or p.polcmd <> '*' or not p.polpermissive
         or p.polroles <> array[(select oid from pg_roles where rolname = 'bizcost_api')]
         or (select count(*) from pg_policy q where q.polrelid = p.polrelid) <> 1 $$,
  'every M3 table has exactly one policy: tenant_isolation, permissive FOR ALL, for bizcost_api only'
);

select is_empty(
  $$ select m.table_name
       from m3_tables m
      where not exists (
        select 1 from pg_policies p
         where p.schemaname = 'app' and p.tablename = m.table_name
           and strpos(coalesce(p.qual, ''), 'business_id = ( SELECT app.current_business_id()') > 0
           and strpos(coalesce(p.qual, ''), '( SELECT app.is_active_member(app.current_business_id())') > 0
           and coalesce(p.qual, '') !~ 'is_active_member\(business_id'
           and coalesce(p.with_check, p.qual) = p.qual) $$,
  'the M3 policies use the InitPlan predicate (no row column passed to a function) for USING and WITH CHECK'
);

select is(
  (select array_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text)
     from pg_proc p
    where p.pronamespace = 'app'::regnamespace and p.prosecdef),
  array[
    'app.accept_invitation(text,uuid)',
    'app.anonymize_my_memberships(text)',
    'app.audit_row()',
    'app.audit_rows()',
    'app.audit_staged_rows()',
    'app.create_business(uuid,text,text,text,uuid,uuid)',
    'app.enforce_active_owner()',
    'app.file_upload_limits()',
    'app.guard_business_file()',
    'app.invitation_limits()',
    'app.is_active_member(uuid)',
    'app.my_business_ids()',
    'app.preview_invitation(text)'
  ],
  'the SECURITY DEFINER functions of app are exactly the known ones: M3 added only the audits per statement (D-259, D-262); its guards, limits and links run as the caller'
);

select is_empty(
  $$ select p.oid::regprocedure::text
       from pg_proc p
      where p.pronamespace = 'app'::regnamespace
        and p.prosecdef
        and (not ('search_path=""' = any(coalesce(p.proconfig, '{}'::text[])))
             or pg_get_userbyid(p.proowner) <> 'postgres'
             or has_function_privilege('anon', p.oid, 'EXECUTE')
             or has_function_privilege('authenticated', p.oid, 'EXECUTE')
             or has_function_privilege('service_role', p.oid, 'EXECUTE')
             or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
                         where x.grantee = 0)) $$,
  'every SECURITY DEFINER function has search_path '''', is owned by postgres and is not executable by PUBLIC, anon, authenticated or service_role'
);

select is_empty(
  $$ select c.relname, g.tgname, g.tgfoid::regprocedure::text
       from pg_trigger g
       join pg_class c on c.oid = g.tgrelid
       join pg_proc p on p.oid = g.tgfoid
      where not g.tgisinternal
        and c.relname in (select table_name from m3_tables)
        and c.relnamespace = 'app'::regnamespace
        and (p.prosecdef
               and g.tgfoid not in (to_regprocedure('app.audit_row()'), to_regprocedure('app.audit_rows()'),
                                    to_regprocedure('app.audit_staged_rows()'))
             or not ('search_path=""' = any(coalesce(p.proconfig, '{}'::text[])))) $$,
  'every trigger on an M3 table runs as the caller with search_path '''' (row level security holds inside it), but the audit triggers'
);

select * from finish();
rollback;

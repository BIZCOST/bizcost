-- pgTAP: what Sales & Profit finalizes is immutable (M3 Step 10; D-036, D-219, D-222, D-230, D-284,
-- D-303), as 20_ledger_immutability is for the Costing Core. A posted sale, its lines and the
-- materials each used; a finalized import (and its staged rows) and channel statement; a delivered or
-- cancelled order and its lines; customer payments; a sent quotation, its lines and stages; an issued
-- invoice and credit note and their lines; the document counters, the PDFs made and the customers are
-- never edited, taken out (soft delete) or deleted, and nothing joins them, by any identity that
-- reaches the database:
--   - bizcost_api, the API's role (as the business's owner): the guard triggers refuse it (23001; a
--     number, a revision or a move to another document is 23514);
--   - authenticated (a user's token through the Data API, here as the owner's claims), anon and
--     service_role (the secret key): no privilege on schema app at all (42501);
--   - the table owner (postgres, migrations and scripts): the guard triggers refuse it too.
-- The refused attempts change nothing (row digests). Then the designed paths: the fill-once values (a
-- material row's price, a line's cost, the owner's time, a sale's delivery cost) are written once,
-- each while null, also on a reversed sale, and a statement that fills one row and changes another is
-- refused whole (the guard per statement, D-328); a sale, an import and a statement only become
-- reversed; a payment is reversed once; an issued invoice takes its stored PDF once; a sent quotation
-- is answered once; an order goes back to pending (Undo delivery) only once its sale is reversed, and
-- is delivered only with its own finalized sale (D-330).
begin;
select plan(386);

do $$
declare
  v_role text;
begin
  if not pg_has_role(current_user, 'bizcost_api', 'SET') then
    execute format('grant bizcost_api to %I', current_user);
  end if;
  foreach v_role in array array['authenticated', 'anon', 'service_role'] loop
    if not pg_has_role(current_user, v_role, 'SET') then
      execute format('grant %I to %I', v_role, current_user);
    end if;
  end loop;
exception when others then
  raise warning 'cannot let % SET ROLE: %', current_user, sqlerrm;
end
$$ language plpgsql;

create function pg_temp.id(p_name text) returns uuid
language sql immutable
as $$ select md5(p_name)::uuid $$;
grant execute on function pg_temp.id(text) to bizcost_api, authenticated, anon, service_role;

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

-- p_sql as an identity: 'ok' or the SQLSTATE it was refused with. The Data API roles carry the
-- owner's claims, as PostgREST sets them from a token.
create function pg_temp.as_identity(p_who text, p_sql text)
returns text
language plpgsql
as $$
declare
  v_out text;
begin
  if p_who = 'bizcost_api' then
    v_out := pg_temp.state_of(pg_temp.a(p_sql));
    return case when v_out like 'ok %' then 'ok' else v_out end;
  end if;
  if p_who = 'table owner' then
    begin
      execute p_sql;
      v_out := 'ok';
    exception when others then
      v_out := sqlstate;
    end;
    return v_out;
  end if;
  perform set_config('request.jwt.claims', json_build_object(
    'sub', pg_temp.id('user A'), 'role', p_who, 'aud', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', pg_temp.id('user A')::text, true);
  begin
    execute format('set local role %I', p_who);
    execute p_sql;
    v_out := 'ok';
  exception when others then
    v_out := sqlstate;
  end;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  return v_out;
end
$$;

-- A digest of every row of business A in the tables Sales & Profit finalizes.
create function pg_temp.digest()
returns text
language sql
as $$
  select md5(string_agg(t.row_text, '|' order by t.row_text))
    from (
      select to_jsonb(r)::text as row_text from app.sales r where business_id = pg_temp.id('biz A')
      union all select to_jsonb(r)::text from app.sale_lines r where business_id = pg_temp.id('biz A')
      union all select to_jsonb(r)::text from app.sale_line_materials r where business_id = pg_temp.id('biz A')
      union all select to_jsonb(r)::text from app.sale_imports r where business_id = pg_temp.id('biz A')
      union all select to_jsonb(r)::text from app.sale_import_rows r where business_id = pg_temp.id('biz A')
      union all select to_jsonb(r)::text from app.channel_statements r where business_id = pg_temp.id('biz A')
      union all select to_jsonb(r)::text from app.orders r where business_id = pg_temp.id('biz A')
      union all select to_jsonb(r)::text from app.order_lines r where business_id = pg_temp.id('biz A')
      union all select to_jsonb(r)::text from app.customer_payments r where business_id = pg_temp.id('biz A')
      union all select to_jsonb(r)::text from app.quotations r where business_id = pg_temp.id('biz A')
      union all select to_jsonb(r)::text from app.quotation_lines r where business_id = pg_temp.id('biz A')
      union all select to_jsonb(r)::text from app.quotation_stages r where business_id = pg_temp.id('biz A')
      union all select to_jsonb(r)::text from app.invoices r where business_id = pg_temp.id('biz A')
      union all select to_jsonb(r)::text from app.invoice_lines r where business_id = pg_temp.id('biz A')
      union all select to_jsonb(r)::text from app.credit_notes r where business_id = pg_temp.id('biz A')
      union all select to_jsonb(r)::text from app.credit_note_lines r where business_id = pg_temp.id('biz A')
      union all select to_jsonb(r)::text from app.document_counters r where business_id = pg_temp.id('biz A')
      union all select to_jsonb(r)::text from app.document_renders r where business_id = pg_temp.id('biz A')
      union all select to_jsonb(r)::text from app.customers r where business_id = pg_temp.id('biz A')
    ) t
$$;

insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', pg_temp.id('user A'), 'authenticated', 'authenticated',
        'amira-frozen@example.test', now(), '{}', '{}', now(), now());

-- 1. Fixtures: everything finalized, as the API writes it (1 + 46 = 47) ----------------------------

select is(
  pg_temp.a($$
    select app.create_business(pg_temp.id('biz A'), 'Alpha Kitchen', 'en', 'Owner',
                               pg_temp.id('biz A owner role'), pg_temp.id('biz A owner member')) $$),
  'ok 1',
  'setup: user A creates business A'
);

select is(pg_temp.a(v.stmt), 'ok 1', 'setup: ' || v.what)
  from (values
    (1, 'a location', $$
      insert into app.locations (id, business_id, name, is_default)
      values (pg_temp.id('loc'), pg_temp.id('biz A'), 'Main', true) $$),
    (2, 'beans', $$
      insert into app.materials (id, business_id, name, dimension, unit)
      values (pg_temp.id('beans'), pg_temp.id('biz A'), 'Beans', 'mass', 'kg') $$),
    (3, 'milk', $$
      insert into app.materials (id, business_id, name, dimension, unit)
      values (pg_temp.id('milk'), pg_temp.id('biz A'), 'Milk', 'volume', 'l') $$),
    (4, 'a latte', $$
      insert into app.products_services (id, business_id, name, type, unit)
      values (pg_temp.id('latte'), pg_temp.id('biz A'), 'Latte', 'product', 'piece') $$),
    (5, 'a channel', $$
      insert into app.sales_channels (id, business_id, name, kind)
      values (pg_temp.id('chan'), pg_temp.id('biz A'), 'Shop', 'shop') $$),
    (6, 'a customer', $$
      insert into app.customers (id, business_id, name)
      values (pg_temp.id('cust'), pg_temp.id('biz A'), 'Gulf Horizon') $$),
    (7, 'a sale delivered to the customer, its delivery cost not known yet', $$
      insert into app.sales (id, business_id, source, business_date, location_id, channel_id, currency,
                             delivery_needed, delivery_area, net_total, total)
      values (pg_temp.id('sale'), pg_temp.id('biz A'), 'single', current_date - 3, pg_temp.id('loc'),
              pg_temp.id('chan'), 'AED', true, 'Al Barsha', 35, 35) $$),
    (8, 'its first line: priced, the owner''s 30 minutes without an hourly rate yet', $$
      insert into app.sale_lines (id, business_id, sale_id, position, kind, product_id, qty, unit_price,
                                  net, total, cost_basis, cost, time_minutes)
      values (pg_temp.id('line1'), pg_temp.id('biz A'), pg_temp.id('sale'), 0, 'item',
              pg_temp.id('latte'), 2, 10, 20, 20, 'recipe', 1.5, 30) $$),
    (9, 'its second line: no price yet', $$
      insert into app.sale_lines (id, business_id, sale_id, position, kind, product_id, qty, unit_price,
                                  net, total, cost_basis)
      values (pg_temp.id('line2'), pg_temp.id('biz A'), pg_temp.id('sale'), 1, 'item',
              pg_temp.id('latte'), 1, 10, 10, 10, 'recipe') $$),
    (10, 'its delivery charged', $$
      insert into app.sale_lines (id, business_id, sale_id, position, kind, qty, unit_price, net, total)
      values (pg_temp.id('line3'), pg_temp.id('biz A'), pg_temp.id('sale'), 2, 'delivery', 1, 5, 5, 5) $$),
    (11, 'the beans the first line used, priced', $$
      insert into app.sale_line_materials (id, business_id, sale_id, sale_line_id, material_id, base_qty,
                                           unit_cost, cost, basis)
      values (pg_temp.id('m1'), pg_temp.id('biz A'), pg_temp.id('sale'), pg_temp.id('line1'),
              pg_temp.id('beans'), 10, 0.15, 1.5, 'last_purchase') $$),
    (12, 'the milk the second line used, no price yet', $$
      insert into app.sale_line_materials (id, business_id, sale_id, sale_line_id, material_id, base_qty)
      values (pg_temp.id('m2'), pg_temp.id('biz A'), pg_temp.id('sale'), pg_temp.id('line2'),
              pg_temp.id('milk'), 200) $$),
    (13, 'the sale is finalized', $$
      update app.sales set status = 'posted', posted_at = now(), posted_by = pg_temp.id('user A')
       where id = pg_temp.id('sale') $$),
    (14, 'a second sale with two lines waiting for a price', $$
      insert into app.sales (id, business_id, source, business_date, location_id, channel_id, currency)
      values (pg_temp.id('sale2'), pg_temp.id('biz A'), 'single', current_date - 2, pg_temp.id('loc'),
              pg_temp.id('chan'), 'AED') $$),
    (15, 'its first line', $$
      insert into app.sale_lines (id, business_id, sale_id, position, kind, product_id, qty, unit_price,
                                  cost_basis)
      values (pg_temp.id('line4'), pg_temp.id('biz A'), pg_temp.id('sale2'), 0, 'item',
              pg_temp.id('latte'), 1, 10, 'recipe') $$),
    (15.1, 'its second line', $$
      insert into app.sale_lines (id, business_id, sale_id, position, kind, product_id, qty, unit_price,
                                  cost_basis)
      values (pg_temp.id('line5'), pg_temp.id('biz A'), pg_temp.id('sale2'), 1, 'item',
              pg_temp.id('latte'), 1, 10, 'recipe') $$),
    (16, 'the milk the first used', $$
      insert into app.sale_line_materials (id, business_id, sale_id, sale_line_id, material_id, base_qty)
      values (pg_temp.id('m4'), pg_temp.id('biz A'), pg_temp.id('sale2'), pg_temp.id('line4'),
              pg_temp.id('milk'), 200) $$),
    (16.1, 'the milk the second used', $$
      insert into app.sale_line_materials (id, business_id, sale_id, sale_line_id, material_id, base_qty)
      values (pg_temp.id('m5'), pg_temp.id('biz A'), pg_temp.id('sale2'), pg_temp.id('line5'),
              pg_temp.id('milk'), 200) $$),
    (17, 'the second sale is finalized', $$
      update app.sales set status = 'posted', posted_at = now(), posted_by = pg_temp.id('user A')
       where id = pg_temp.id('sale2') $$),
    (18, 'a sale they pay later, finalized', $$
      insert into app.sales (id, business_id, source, business_date, location_id, channel_id, currency,
                             status, posted_at, posted_by, customer_id, pay_later, net_total, total)
      values (pg_temp.id('psale'), pg_temp.id('biz A'), 'single', current_date - 2, pg_temp.id('loc'),
              pg_temp.id('chan'), 'AED', 'posted', now(), pg_temp.id('user A'), pg_temp.id('cust'), true,
              100, 100) $$),
    (19, 'an import with two staged rows', $$
      insert into app.sale_imports (id, business_id, channel_id, location_id, file_name, file_hash,
                                    fingerprint, shape, period_from, period_to, mapping, rows_read,
                                    row_count)
      values (pg_temp.id('imp'), pg_temp.id('biz A'), pg_temp.id('chan'), pg_temp.id('loc'), 'pos.csv',
              repeat('a', 64), repeat('f', 64), 'lines', current_date - 1, current_date - 1, '{}', 2, 2) $$),
    (20, 'its first staged row', $$
      insert into app.sale_import_rows (id, business_id, import_id, position, business_date, name, qty,
                                        amount, file_rows)
      values (pg_temp.id('row'), pg_temp.id('biz A'), pg_temp.id('imp'), 0, current_date - 1, 'Latte',
              12, 120, 1) $$),
    (20.1, 'its second staged row', $$
      insert into app.sale_import_rows (id, business_id, import_id, position, business_date, name, qty,
                                        amount, file_rows)
      values (pg_temp.id('row2'), pg_temp.id('biz A'), pg_temp.id('imp'), 1, current_date - 1, 'Mocha',
              5, 60, 1) $$),
    (21, 'the import is finalized', $$
      update app.sale_imports set status = 'posted', posted_at = now(), posted_by = pg_temp.id('user A')
       where id = pg_temp.id('imp') $$),
    (22, 'and a staged row cleared', $$
      delete from app.sale_import_rows where id = pg_temp.id('row2') $$),
    (23, 'a channel statement, finalized', $$
      insert into app.channel_statements (id, business_id, channel_id, period_from, period_to, commission,
                                          status, posted_at, posted_by)
      values (pg_temp.id('stmt'), pg_temp.id('biz A'), pg_temp.id('chan'), current_date - 40,
              current_date - 35, 180, 'posted', now(), pg_temp.id('user A')) $$),
    (24, 'an order with its line', $$
      with o as (
        insert into app.orders (id, business_id, seq, number, customer_id, business_date, location_id,
                                channel_id, currency, net_total, total)
        values (pg_temp.id('ord1'), pg_temp.id('biz A'), 1001, '#1001', pg_temp.id('cust'),
                current_date - 5, pg_temp.id('loc'), pg_temp.id('chan'), 'AED', 150, 150)
        returning id
      )
      insert into app.order_lines (id, business_id, order_id, position, kind, product_id, qty, unit_price,
                                   net, total)
      select pg_temp.id('oline1'), pg_temp.id('biz A'), o.id, 0, 'item', pg_temp.id('latte'), 15, 10, 150,
             150
        from o $$),
    (25, 'its sale on delivery, with its line', $$
      with s as (
        insert into app.sales (id, business_id, source, business_date, location_id, channel_id, currency,
                               customer_id, order_id, net_total, total)
        values (pg_temp.id('osale'), pg_temp.id('biz A'), 'order', current_date - 4, pg_temp.id('loc'),
                pg_temp.id('chan'), 'AED', pg_temp.id('cust'), pg_temp.id('ord1'), 150, 150)
        returning id
      )
      insert into app.sale_lines (id, business_id, sale_id, position, kind, product_id, qty, unit_price,
                                  net, total, cost_basis)
      select pg_temp.id('osline'), pg_temp.id('biz A'), s.id, 0, 'item', pg_temp.id('latte'), 15, 10, 150,
             150, 'none'
        from s $$),
    (26, 'the sale is finalized', $$
      update app.sales set status = 'posted', posted_at = now(), posted_by = pg_temp.id('user A')
       where id = pg_temp.id('osale') $$),
    (27, 'the order is delivered', $$
      update app.orders
         set status = 'delivered', delivered_on = current_date - 4, sale_id = pg_temp.id('osale'),
             delivered_at = now(), delivered_by = pg_temp.id('user A')
       where id = pg_temp.id('ord1') $$),
    (28, 'a second order with its line', $$
      with o as (
        insert into app.orders (id, business_id, seq, number, business_date, location_id, channel_id,
                                currency)
        values (pg_temp.id('ord2'), pg_temp.id('biz A'), 1002, '#1002', current_date - 5,
                pg_temp.id('loc'), pg_temp.id('chan'), 'AED')
        returning id
      )
      insert into app.order_lines (id, business_id, order_id, position, kind, product_id, qty, unit_price)
      select pg_temp.id('oline2'), pg_temp.id('biz A'), o.id, 0, 'item', pg_temp.id('latte'), 1, 10
        from o $$),
    (29, 'the second order is cancelled', $$
      update app.orders
         set status = 'cancelled', cancelled_at = now(), cancelled_by = pg_temp.id('user A'),
             cancel_reason = 'Changed their mind'
       where id = pg_temp.id('ord2') $$),
    (30, 'a third order, pending', $$
      insert into app.orders (id, business_id, seq, number, business_date, location_id, channel_id,
                              currency)
      values (pg_temp.id('ord3'), pg_temp.id('biz A'), 1003, '#1003', current_date - 5,
              pg_temp.id('loc'), pg_temp.id('chan'), 'AED') $$),
    (31, 'a deposit on the delivered order', $$
      insert into app.customer_payments (id, business_id, customer_id, order_id, business_date, method,
                                         amount, currency)
      values (pg_temp.id('pay1'), pg_temp.id('biz A'), pg_temp.id('cust'), pg_temp.id('ord1'),
              current_date - 5, 'bank_transfer', 50, 'AED') $$),
    (32, 'a payment of the sale they pay later', $$
      insert into app.customer_payments (id, business_id, customer_id, sale_id, business_date, method,
                                         amount, currency)
      values (pg_temp.id('pay2'), pg_temp.id('biz A'), pg_temp.id('cust'), pg_temp.id('psale'),
              current_date - 1, 'cash', 40, 'AED') $$),
    (33, 'a quotation with its line and stage', $$
      with q as (
        insert into app.quotations (id, business_id, seq, number, root_id, customer_id, location_id,
                                    business_date, currency)
        values (pg_temp.id('quote'), pg_temp.id('biz A'), 1, 'Q-0001', pg_temp.id('quote'),
                pg_temp.id('cust'), pg_temp.id('loc'), current_date - 6, 'AED')
        returning id
      ), l as (
        insert into app.quotation_lines (id, business_id, quotation_id, position, description, qty,
                                         unit_price)
        select pg_temp.id('qline'), pg_temp.id('biz A'), q.id, 0, 'Wall cladding', 10, 45 from q
        returning 1
      )
      insert into app.quotation_stages (id, business_id, quotation_id, position, due, percent, amount)
      select pg_temp.id('qstage'), pg_temp.id('biz A'), q.id, 0, 'On signing', 100, 450
        from q where (select count(*) from l) = 1 $$),
    (34, 'the quotation is sent', $$
      update app.quotations set status = 'sent', sent_at = now(), sent_by = pg_temp.id('user A')
       where id = pg_temp.id('quote') $$),
    (35, 'an invoice with its line', $$
      with i as (
        insert into app.invoices (id, business_id, kind, customer_id, location_id, currency, net_total,
                                  total)
        values (pg_temp.id('inv'), pg_temp.id('biz A'), 'invoice', pg_temp.id('cust'), pg_temp.id('loc'),
                'AED', 1000, 1000)
        returning id
      )
      insert into app.invoice_lines (id, business_id, invoice_id, position, kind, description, qty,
                                     unit_price, net, total)
      select pg_temp.id('iline'), pg_temp.id('biz A'), i.id, 0, 'item', 'Shelves', 10, 100, 1000, 1000
        from i $$),
    (36, 'the invoice is issued', $$
      update app.invoices
         set status = 'issued', seq = 1, number = 'INV-0001', issue_date = current_date - 1,
             supply_date = current_date - 1, issued_at = now(), issued_by = pg_temp.id('user A'),
             customer_name = 'Gulf Horizon', seller_name = 'Alpha Kitchen'
       where id = pg_temp.id('inv') $$),
    (37, 'a payment of the invoice', $$
      insert into app.customer_payments (id, business_id, customer_id, invoice_id, business_date, method,
                                         amount, currency)
      values (pg_temp.id('pay3'), pg_temp.id('biz A'), pg_temp.id('cust'), pg_temp.id('inv'),
              current_date, 'cheque', 300, 'AED') $$),
    (38, 'a credit note of the invoice with its line', $$
      with c as (
        insert into app.credit_notes (id, business_id, kind, invoice_id, customer_id, location_id,
                                      event_date, reason, reason_text, credit_by, currency, net_total,
                                      total)
        values (pg_temp.id('cn'), pg_temp.id('biz A'), 'credit_note', pg_temp.id('inv'),
                pg_temp.id('cust'), pg_temp.id('loc'), current_date, 'goods_returned', 'Two shelves back',
                'quantity', 'AED', 200, 200)
        returning id
      )
      insert into app.credit_note_lines (id, business_id, credit_note_id, position, invoice_line_id,
                                         description, qty, unit_price, net, total)
      select pg_temp.id('cnline'), pg_temp.id('biz A'), c.id, 0, pg_temp.id('iline'), 'Shelves', 2, 100,
             200, 200
        from c $$),
    (39, 'the credit note is issued', $$
      update app.credit_notes
         set status = 'issued', seq = 1, number = 'CN-0001', issue_date = current_date,
             issued_at = now(), issued_by = pg_temp.id('user A'), value_before = 1000, value_after = 800,
             customer_name = 'Gulf Horizon', seller_name = 'Alpha Kitchen'
       where id = pg_temp.id('cn') $$),
    (40, 'the invoice counter, at INV-0002', $$
      insert into app.document_counters (id, business_id, series, next_no, prefix, padding, first_no)
      values (pg_temp.id('counter'), pg_temp.id('biz A'), 'invoice', 2, 'INV-', 4, 1) $$),
    (41, 'a PDF of the invoice made', $$
      insert into app.document_renders (id, business_id, kind, document_id)
      values (pg_temp.id('render'), pg_temp.id('biz A'), 'invoice', pg_temp.id('inv')) $$),
    (42, 'the invoice''s PDF stored', $$
      insert into app.file_uploads (id, business_id, path, purpose, content_type, expires_at)
      values (pg_temp.id('pdf'), pg_temp.id('biz A'), pg_temp.id('biz A')::text || '/document/inv.pdf',
              'document', 'application/pdf', now() + interval '1 hour') $$),
    (43, 'another stored file', $$
      insert into app.file_uploads (id, business_id, path, purpose, content_type, expires_at)
      values (pg_temp.id('pdf2'), pg_temp.id('biz A'), pg_temp.id('biz A')::text || '/document/inv2.pdf',
              'document', 'application/pdf', now() + interval '1 hour') $$)
  ) as v(n, what, stmt)
 order by v.n;

create temp table digest_before as select pg_temp.digest() as digest;

-- The Data API roles are really switched to (3): a failed SET ROLE is 42501 too, so without these the
-- refusals below would prove nothing for them.
select is(
  pg_temp.as_identity(r.who, format('select 1 / (current_user = %L)::int', r.who)),
  'ok',
  'the test runs as ' || r.who || ' when it says so'
)
  from (values (1, 'authenticated'), (2, 'anon'), (3, 'service_role')) as r(k, who)
 order by r.k;

-- 2. Every identity, every change: refused (5 × 61 = 305, then 1) --------------------------------
-- `state` is what bizcost_api and the table owner are refused with; the Data API roles get 42501.

create temp table attempts (n integer, what text, state text, stmt text);
insert into attempts values
  (1, 'a posted sale is not edited', '23001',
   $$ update app.sales set notes = 'changed' where id = pg_temp.id('sale') $$),
  (2, 'a posted sale keeps its total', '23001',
   $$ update app.sales set net_total = 1, total = 1 where id = pg_temp.id('sale') $$),
  (3, 'a posted sale is not taken out', '23001',
   $$ update app.sales set deleted_at = now() where id = pg_temp.id('sale') $$),
  (4, 'a posted sale is not deleted', '23001',
   $$ delete from app.sales where id = pg_temp.id('sale') $$),
  (5, 'a posted sale does not go back to draft', '23001',
   $$ update app.sales set status = 'draft', posted_at = null, posted_by = null where id = pg_temp.id('sale') $$),
  (6, 'a line of a posted sale keeps its quantity', '23001',
   $$ update app.sale_lines set qty = 3 where id = pg_temp.id('line1') $$),
  (7, 'a line''s cost, once there, never changes', '23001',
   $$ update app.sale_lines set cost = 2 where id = pg_temp.id('line1') $$),
  (8, 'a line of a posted sale is not taken out', '23001',
   $$ update app.sale_lines set deleted_at = now() where id = pg_temp.id('line2') $$),
  (9, 'a line of a posted sale is not deleted', '23001',
   $$ delete from app.sale_lines where id = pg_temp.id('line3') $$),
  (10, 'no line joins a posted sale', '23001',
   $$ insert into app.sale_lines (id, business_id, sale_id, position, kind, product_id, qty, unit_price, created_by)
      values (pg_temp.id('line new'), pg_temp.id('biz A'), pg_temp.id('sale'), 9, 'item', pg_temp.id('latte'), 1, 1, pg_temp.id('user A')) $$),
  (11, 'a line never moves to another sale', '23514',
   $$ update app.sale_lines set sale_id = pg_temp.id('psale') where id = pg_temp.id('line3') $$),
  (12, 'a priced material row keeps its price', '23001',
   $$ update app.sale_line_materials set unit_cost = 1, cost = 10 where id = pg_temp.id('m1') $$),
  (13, 'a material row keeps its quantity', '23001',
   $$ update app.sale_line_materials set base_qty = 400 where id = pg_temp.id('m2') $$),
  (14, 'a material row is not taken out', '23001',
   $$ update app.sale_line_materials set deleted_at = now() where id = pg_temp.id('m2') $$),
  (15, 'a material row is not deleted', '23001',
   $$ delete from app.sale_line_materials where id = pg_temp.id('m1') $$),
  (16, 'no material row joins a posted sale', '23001',
   $$ insert into app.sale_line_materials (id, business_id, sale_id, sale_line_id, material_id, base_qty, created_by)
      values (pg_temp.id('m new'), pg_temp.id('biz A'), pg_temp.id('sale'), pg_temp.id('line2'), pg_temp.id('beans'), 5, pg_temp.id('user A')) $$),
  (17, 'a finalized import is not edited', '23001',
   $$ update app.sale_imports set file_name = 'other.csv' where id = pg_temp.id('imp') $$),
  (18, 'a finalized import is not deleted', '23001',
   $$ delete from app.sale_imports where id = pg_temp.id('imp') $$),
  (19, 'no staged row joins a finalized import', '23001',
   $$ insert into app.sale_import_rows (id, business_id, import_id, position, business_date, name, qty, amount, file_rows, created_by)
      values (pg_temp.id('row new'), pg_temp.id('biz A'), pg_temp.id('imp'), 1, current_date - 1, 'Tea', 1, 8, 1, pg_temp.id('user A')) $$),
  (20, 'a staged row of a finalized import is not changed', '23001',
   $$ update app.sale_import_rows set qty = 120, amount = 1200 where id = pg_temp.id('row') $$),
  (21, 'a finalized statement keeps its fees', '23001',
   $$ update app.channel_statements set commission = 1 where id = pg_temp.id('stmt') $$),
  (22, 'a finalized statement is not deleted', '23001',
   $$ delete from app.channel_statements where id = pg_temp.id('stmt') $$),
  (23, 'a delivered order is not edited', '23001',
   $$ update app.orders set notes = 'changed' where id = pg_temp.id('ord1') $$),
  (24, 'a delivered order keeps its total', '23001',
   $$ update app.orders set net_total = 1, total = 1 where id = pg_temp.id('ord1') $$),
  (25, 'a cancelled order never changes', '23001',
   $$ update app.orders set notes = 'changed' where id = pg_temp.id('ord2') $$),
  (26, 'a cancelled order does not come back', '23001',
   $$ update app.orders set status = 'pending', cancelled_at = null, cancelled_by = null, cancel_reason = null
       where id = pg_temp.id('ord2') $$),
  (27, 'an order keeps its number', '23514',
   $$ update app.orders set number = '#9999' where id = pg_temp.id('ord1') $$),
  (28, 'an order is never deleted', '23001',
   $$ delete from app.orders where id = pg_temp.id('ord2') $$),
  (29, 'a line of a delivered order is not changed', '23001',
   $$ update app.order_lines set qty = 1 where id = pg_temp.id('oline1') $$),
  (30, 'no line joins a delivered order', '23001',
   $$ insert into app.order_lines (id, business_id, order_id, position, kind, product_id, qty, unit_price, created_by)
      values (pg_temp.id('oline new'), pg_temp.id('biz A'), pg_temp.id('ord1'), 1, 'item', pg_temp.id('latte'), 1, 1, pg_temp.id('user A')) $$),
  (31, 'a line of a cancelled order is not changed', '23001',
   $$ update app.order_lines set unit_price = 1 where id = pg_temp.id('oline2') $$),
  (32, 'an order line is never deleted', '23001',
   $$ delete from app.order_lines where id = pg_temp.id('oline1') $$),
  (33, 'a customer payment keeps its amount', '23001',
   $$ update app.customer_payments set amount = 1 where id = pg_temp.id('pay1') $$),
  (34, 'a customer payment never moves to another document', '23001',
   $$ update app.customer_payments set order_id = pg_temp.id('ord3') where id = pg_temp.id('pay1') $$),
  (35, 'a customer payment is not taken out', '23001',
   $$ update app.customer_payments set deleted_at = now() where id = pg_temp.id('pay2') $$),
  (36, 'a customer payment is not deleted', '23001',
   $$ delete from app.customer_payments where id = pg_temp.id('pay3') $$),
  (37, 'a sent quotation is not edited', '23001',
   $$ update app.quotations set notes = 'changed' where id = pg_temp.id('quote') $$),
  (38, 'a sent quotation is not discarded', '23001',
   $$ update app.quotations set deleted_at = now() where id = pg_temp.id('quote') $$),
  (39, 'a sent quotation keeps its number', '23514',
   $$ update app.quotations set number = 'Q-0099' where id = pg_temp.id('quote') $$),
  (40, 'a quotation is never deleted', '23001',
   $$ delete from app.quotations where id = pg_temp.id('quote') $$),
  (41, 'a line of a sent quotation keeps its price', '23001',
   $$ update app.quotation_lines set unit_price = 1 where id = pg_temp.id('qline') $$),
  (42, 'no line joins a sent quotation', '23001',
   $$ insert into app.quotation_lines (id, business_id, quotation_id, position, description, qty, unit_price, created_by)
      values (pg_temp.id('qline new'), pg_temp.id('biz A'), pg_temp.id('quote'), 1, 'Paint', 1, 1, pg_temp.id('user A')) $$),
  (43, 'a stage of a sent quotation keeps its share', '23001',
   $$ update app.quotation_stages set percent = 50, amount = 225 where id = pg_temp.id('qstage') $$),
  (44, 'a quotation line is never deleted', '23001',
   $$ delete from app.quotation_lines where id = pg_temp.id('qline') $$),
  (45, 'an issued invoice is not edited', '23001',
   $$ update app.invoices set notes = 'changed' where id = pg_temp.id('inv') $$),
  (46, 'an issued invoice keeps its total', '23001',
   $$ update app.invoices set net_total = 1, total = 1 where id = pg_temp.id('inv') $$),
  (47, 'an issued invoice keeps its number', '23001',
   $$ update app.invoices set number = 'INV-0099', seq = 99 where id = pg_temp.id('inv') $$),
  (48, 'an issued invoice is not discarded', '23001',
   $$ update app.invoices set deleted_at = now() where id = pg_temp.id('inv') $$),
  (49, 'an issued invoice does not go back to draft', '23001',
   $$ update app.invoices
         set status = 'draft', seq = null, number = null, issue_date = null, supply_date = null,
             issued_at = null, issued_by = null, customer_name = null, seller_name = null
       where id = pg_temp.id('inv') $$),
  (50, 'an invoice is never deleted', '23001',
   $$ delete from app.invoices where id = pg_temp.id('inv') $$),
  (51, 'a line of an issued invoice is not changed', '23001',
   $$ update app.invoice_lines set qty = 1, net = 100, total = 100 where id = pg_temp.id('iline') $$),
  (52, 'no line joins an issued invoice', '23001',
   $$ insert into app.invoice_lines (id, business_id, invoice_id, position, kind, description, qty, unit_price, created_by)
      values (pg_temp.id('iline new'), pg_temp.id('biz A'), pg_temp.id('inv'), 1, 'item', 'Doors', 1, 1, pg_temp.id('user A')) $$),
  (53, 'an invoice line is never deleted', '23001',
   $$ delete from app.invoice_lines where id = pg_temp.id('iline') $$),
  (54, 'an issued credit note is not edited', '23001',
   $$ update app.credit_notes set reason_text = 'changed' where id = pg_temp.id('cn') $$),
  (55, 'a credit note is never deleted', '23001',
   $$ delete from app.credit_notes where id = pg_temp.id('cn') $$),
  (56, 'a line of an issued credit note is not changed', '23001',
   $$ update app.credit_note_lines set qty = 1, net = 100, total = 100 where id = pg_temp.id('cnline') $$),
  (57, 'no line joins an issued credit note', '23001',
   $$ insert into app.credit_note_lines (id, business_id, credit_note_id, position, invoice_line_id, description, qty, unit_price, created_by)
      values (pg_temp.id('cnline new'), pg_temp.id('biz A'), pg_temp.id('cn'), 1, pg_temp.id('iline'), 'Shelves', 1, 1, pg_temp.id('user A')) $$),
  (58, 'a document counter never goes back', '23514',
   $$ update app.document_counters set next_no = 1 where id = pg_temp.id('counter') $$),
  (59, 'a document counter is never deleted', '23001',
   $$ delete from app.document_counters where id = pg_temp.id('counter') $$),
  (60, 'a PDF made stays counted as it was', '23001',
   $$ update app.document_renders set kind = 'quotation' where id = pg_temp.id('render') $$),
  (61, 'a customer is never deleted (an archived one stays)', '23001',
   $$ delete from app.customers where id = pg_temp.id('cust') $$);

select is(
  pg_temp.as_identity(i.who, t.stmt),
  case when i.who in ('authenticated', 'anon', 'service_role') then '42501' else t.state end,
  t.what || ' (' || i.who || ')'
)
  from attempts t
 cross join (values (1, 'bizcost_api'), (2, 'authenticated'), (3, 'anon'), (4, 'service_role'),
                    (5, 'table owner')) as i(k, who)
 order by t.n, i.k;

select is(
  pg_temp.digest(),
  (select digest from digest_before),
  'the refused attempts changed nothing: every finalized row is as it was'
);

-- 3. The designed paths (as bizcost_api) (1 + 27 = 28, then 1 + 1) --------------------------------

select is(pg_temp.state_of(pg_temp.a(v.stmt)), v.state, v.what)
  from (values
    (1, 'ok 1', 'a material row without a price takes it once (unit cost, cost and basis together)', $$
      update app.sale_line_materials set unit_cost = 0.005, cost = 1, basis = 'first_purchase'
       where id = pg_temp.id('m2') $$),
    (2, '23001', 'and never again', $$
      update app.sale_line_materials set unit_cost = 0.006, cost = 1.2 where id = pg_temp.id('m2') $$),
    (3, 'ok 1', 'a line without a cost takes it once every material is priced', $$
      update app.sale_lines set cost = 1 where id = pg_temp.id('line2') $$),
    (4, '23001', 'and never again', $$
      update app.sale_lines set cost = 2 where id = pg_temp.id('line2') $$),
    (5, 'ok 1', 'the owner''s time takes its cost once the hourly rate is set', $$
      update app.sale_lines set time_cost = 20 where id = pg_temp.id('line1') $$),
    (6, '23001', 'and never again', $$
      update app.sale_lines set time_cost = 25 where id = pg_temp.id('line1') $$),
    (7, 'ok 1', 'a posted sale takes its delivery cost once', $$
      update app.sales set delivery_cost = 25 where id = pg_temp.id('sale') $$),
    (8, '23001', 'and never again', $$
      update app.sales set delivery_cost = 30 where id = pg_temp.id('sale') $$),
    (9, '23001', 'one statement that fills a row and changes another is refused whole', $$
      update app.sale_line_materials
         set unit_cost = case when id = pg_temp.id('m4') then 0.005 end,
             cost = case when id = pg_temp.id('m4') then 1 end,
             basis = case when id = pg_temp.id('m4') then 'first_purchase' end,
             base_qty = case when id = pg_temp.id('m5') then 999 else base_qty end
       where id in (pg_temp.id('m4'), pg_temp.id('m5')) $$),
    (10, '23001', 'and so is one that fills a line and changes another line''s quantity', $$
      update app.sale_lines
         set cost = case when id = pg_temp.id('line4') then 1 end,
             qty = case when id = pg_temp.id('line5') then 2 else qty end
       where id in (pg_temp.id('line4'), pg_temp.id('line5')) $$),
    (11, 'ok 1', 'a posted sale becomes reversed: only its reversal columns change', $$
      update app.sales
         set status = 'reversed', reversed_at = now(), reversed_by = pg_temp.id('user A'),
             reversal_business_date = current_date
       where id = pg_temp.id('sale2') $$),
    (12, 'ok 2', 'its rows without a price still take it, in one statement (a fill is not a posting)', $$
      update app.sale_line_materials set unit_cost = 0.005, cost = 1, basis = 'first_purchase'
       where id in (pg_temp.id('m4'), pg_temp.id('m5')) $$),
    (13, 'ok 2', 'and its lines their cost', $$
      update app.sale_lines set cost = 1 where id in (pg_temp.id('line4'), pg_temp.id('line5')) $$),
    (14, '23001', 'a reversed sale does not come back', $$
      update app.sales
         set status = 'posted', reversed_at = null, reversed_by = null, reversal_business_date = null
       where id = pg_temp.id('sale2') $$),
    (15, '23001', 'a reversed sale keeps its reversal day', $$
      update app.sales set reversal_business_date = current_date - 1 where id = pg_temp.id('sale2') $$),
    (16, 'ok 1', 'a finalized import becomes reversed', $$
      update app.sale_imports set status = 'reversed', reversed_at = now(), reversed_by = pg_temp.id('user A')
       where id = pg_temp.id('imp') $$),
    (17, '23001', 'and does not come back', $$
      update app.sale_imports set status = 'posted', reversed_at = null, reversed_by = null
       where id = pg_temp.id('imp') $$),
    (18, 'ok 1', 'a finalized statement becomes reversed', $$
      update app.channel_statements
         set status = 'reversed', reversed_at = now(), reversed_by = pg_temp.id('user A')
       where id = pg_temp.id('stmt') $$),
    (19, 'ok 1', 'a customer payment is reversed', $$
      update app.customer_payments
         set reversed_at = now(), reversed_by = pg_temp.id('user A'), reversal_date = current_date
       where id = pg_temp.id('pay1') $$),
    (20, '23001', 'once', $$
      update app.customer_payments set reversal_date = current_date - 1 where id = pg_temp.id('pay1') $$),
    (21, 'ok 1', 'an issued invoice takes its stored PDF once', $$
      update app.invoices set pdf_upload_id = pg_temp.id('pdf') where id = pg_temp.id('inv') $$),
    (22, '23001', 'and keeps it', $$
      update app.invoices set pdf_upload_id = pg_temp.id('pdf2') where id = pg_temp.id('inv') $$),
    (23, 'ok 1', 'a sent quotation is answered', $$
      update app.quotations set status = 'accepted', accepted_at = now(), accepted_by = pg_temp.id('user A')
       where id = pg_temp.id('quote') $$),
    (24, '23001', 'once', $$
      update app.quotations
         set status = 'declined', accepted_at = null, accepted_by = null, declined_at = now(),
             declined_by = pg_temp.id('user A')
       where id = pg_temp.id('quote') $$),
    (25, '23001', 'a delivered order goes back to pending only once its sale is reversed (D-330)', $$
      update app.orders
         set status = 'pending', delivered_on = null, sale_id = null, delivered_at = null,
             delivered_by = null
       where id = pg_temp.id('ord1') $$),
    (26, 'ok 1', 'Undo delivery: its sale is reversed', $$
      update app.sales
         set status = 'reversed', reversed_at = now(), reversed_by = pg_temp.id('user A'),
             reversal_business_date = current_date - 4
       where id = pg_temp.id('osale') $$),
    (27, 'ok 1', 'then the order is pending again', $$
      update app.orders
         set status = 'pending', delivered_on = null, sale_id = null, delivered_at = null,
             delivered_by = null
       where id = pg_temp.id('ord1') $$)
  ) as v(n, state, what, stmt)
 order by v.n;

select is(
  (select count(*)::int from app.sale_line_materials
    where id in (pg_temp.id('m4'), pg_temp.id('m5')) and base_qty = 200 and cost = 1),
  2,
  'the refused statements wrote nothing: each row was filled once, by the statement allowed'
);

select is(pg_temp.state_of(pg_temp.a(v.stmt)), v.state, v.what)
  from (values
    (1, '23514', 'an order is delivered only with its own finalized sale, not another (D-330)', $$
      update app.orders
         set status = 'delivered', delivered_on = current_date - 2, sale_id = pg_temp.id('psale'),
             delivered_at = now(), delivered_by = pg_temp.id('user A')
       where id = pg_temp.id('ord3') $$),
    (2, '23514', 'nor with its own reversed one', $$
      update app.orders
         set status = 'delivered', delivered_on = current_date - 4, sale_id = pg_temp.id('osale'),
             delivered_at = now(), delivered_by = pg_temp.id('user A')
       where id = pg_temp.id('ord1') $$)
  ) as v(n, state, what, stmt)
 order by v.n;

select * from finish();
rollback;

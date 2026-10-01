-- pgTAP: posted documents and the ledger are immutable (M2 Step 8; D-036, D-110 rule 2, D-134, D-160,
-- D-166, D-168). A posted purchase, supplier return and credit note (and their lines), a posted
-- expense, the payments of purchases and expenses and every stock movement are never updated, taken
-- out (soft delete) or deleted, and no line joins a posted document, by any identity that reaches the
-- database:
--   - bizcost_api, the API's role (as the business's owner): the guard triggers refuse it (23001), and
--     the ledger has no UPDATE or DELETE grant (42501);
--   - authenticated (a user's token through the Data API, here as the owner's claims), anon and
--     service_role (the secret key): no privilege on schema app at all (42501), so nothing reaches the
--     triggers (09_hardening_data_api pins that app is not exposed; the HTTP suite tries it);
--   - the table owner (postgres, migrations and scripts): the guard triggers refuse it too (23001).
-- The refused attempts change nothing (row digests). Then the designed path: a document only becomes
-- reversed, changing only its reversal columns, and stays so; a payment is reversed once; the ledger
-- takes a reversal movement, once per movement. 12_purchasing, 14_purchase_payments and 15_expenses test
-- the same rules for purchases, payments and expenses as bizcost_api; this file adds returns, credit
-- notes and their lines, and every identity.
begin;
select plan(150);

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

-- A digest of every row of business A in the tables a posting writes (posted documents, lines,
-- payments, the ledger).
create function pg_temp.digest()
returns text
language sql
as $$
  select md5(string_agg(t.row_text, '|' order by t.row_text))
    from (
      select to_jsonb(r)::text as row_text from app.purchases r where business_id = pg_temp.id('biz A')
      union all select to_jsonb(r)::text from app.purchase_lines r where business_id = pg_temp.id('biz A')
      union all select to_jsonb(r)::text from app.purchase_returns r where business_id = pg_temp.id('biz A')
      union all select to_jsonb(r)::text from app.purchase_return_lines r where business_id = pg_temp.id('biz A')
      union all select to_jsonb(r)::text from app.stock_movements r where business_id = pg_temp.id('biz A')
      union all select to_jsonb(r)::text from app.expenses r where business_id = pg_temp.id('biz A')
      union all select to_jsonb(r)::text from app.purchase_payments r where business_id = pg_temp.id('biz A')
      union all select to_jsonb(r)::text from app.expense_payments r where business_id = pg_temp.id('biz A')
    ) t
$$;

insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', pg_temp.id('user A'), 'authenticated', 'authenticated',
        'amna@example.test', now(), '{}', '{}', now(), now());

-- 1. Fixtures: everything posted, as the API posts it (17) -------------------------------------------

select is(
  pg_temp.a($$
    select app.create_business(pg_temp.id('biz A'), 'Alpha Roastery', 'en', 'Owner',
                               pg_temp.id('biz A owner role'), pg_temp.id('biz A owner member')) $$),
  'ok 1',
  'setup: user A creates business A'
);

select is(pg_temp.a(v.stmt), 'ok 1', 'setup: ' || v.what)
  from (values
    ('a location', $$
      insert into app.locations (id, business_id, name, is_default)
      values (pg_temp.id('loc'), pg_temp.id('biz A'), 'Main', true) $$),
    ('milk', $$
      insert into app.materials (id, business_id, name, dimension, unit)
      values (pg_temp.id('milk'), pg_temp.id('biz A'), 'Milk', 'volume', 'l') $$),
    ('a supplier', $$
      insert into app.suppliers (id, business_id, name)
      values (pg_temp.id('sup'), pg_temp.id('biz A'), 'Dairy') $$),
    ('a category', $$
      insert into app.cost_categories (id, business_id, name)
      values (pg_temp.id('cat'), pg_temp.id('biz A'), 'Rent') $$),
    ('a purchase on credit with its line', $$
      with p as (
        insert into app.purchases (id, business_id, supplier_id, location_id, business_date,
                                   document_type, payment_method, currency, total)
        values (pg_temp.id('pur'), pg_temp.id('biz A'), pg_temp.id('sup'), pg_temp.id('loc'),
                current_date, 'no_invoice', 'supplier_credit', 'AED', 600)
        returning id
      )
      insert into app.purchase_lines (id, business_id, purchase_id, position, kind, material_id, qty,
                                      unit, unit_price, base_qty, cost)
      select pg_temp.id('line pur'), pg_temp.id('biz A'), p.id, 0, 'material', pg_temp.id('milk'),
             100, 'l', 6, 100000, 600
        from p $$),
    ('the purchase is posted', $$
      update app.purchases
         set status = 'posted', posted_at = now(), posted_by = pg_temp.id('user A'),
             vat_in_cost = true, cost_total = 600
       where id = pg_temp.id('pur') $$),
    ('its goods come in', $$
      insert into app.stock_movements (id, business_id, business_date, location_id, material_id, kind, qty,
                                       value, unit_cost, purchase_line_id)
      values (pg_temp.id('mov pur'), pg_temp.id('biz A'), current_date, pg_temp.id('loc'),
              pg_temp.id('milk'), 'purchase', 100000, 600, 0.006, pg_temp.id('line pur')) $$),
    ('a return of 10 L with its line', $$
      with r as (
        insert into app.purchase_returns (id, business_id, purchase_id, kind, business_date, currency)
        values (pg_temp.id('ret'), pg_temp.id('biz A'), pg_temp.id('pur'), 'return', current_date, 'AED')
        returning id
      )
      insert into app.purchase_return_lines (id, business_id, return_id, purchase_id, purchase_line_id,
                                             position, qty, base_qty, cost)
      select pg_temp.id('line ret'), pg_temp.id('biz A'), r.id, pg_temp.id('pur'), pg_temp.id('line pur'),
             0, 10, 10000, 60
        from r $$),
    ('a credit note of 30 with its line', $$
      with r as (
        insert into app.purchase_returns (id, business_id, purchase_id, kind, business_date, currency)
        values (pg_temp.id('cn'), pg_temp.id('biz A'), pg_temp.id('pur'), 'credit_note', current_date, 'AED')
        returning id
      )
      insert into app.purchase_return_lines (id, business_id, return_id, purchase_id, purchase_line_id,
                                             position, amount, cost)
      select pg_temp.id('line cn'), pg_temp.id('biz A'), r.id, pg_temp.id('pur'), pg_temp.id('line pur'),
             0, 30, 30
        from r $$),
    ('the return is posted', $$
      update app.purchase_returns
         set status = 'posted', posted_at = now(), posted_by = pg_temp.id('user A'), cost_total = 60
       where id = pg_temp.id('ret') $$),
    ('the credit note is posted', $$
      update app.purchase_returns
         set status = 'posted', posted_at = now(), posted_by = pg_temp.id('user A'), cost_total = 30
       where id = pg_temp.id('cn') $$),
    ('the returned goods go out', $$
      insert into app.stock_movements (id, business_id, business_date, location_id, material_id, kind, qty,
                                       value, unit_cost, purchase_line_id, return_line_id, receipt_id)
      values (pg_temp.id('mov ret'), pg_temp.id('biz A'), current_date, pg_temp.id('loc'),
              pg_temp.id('milk'), 'purchase_return', -10000, -60, 0.006, pg_temp.id('line pur'),
              pg_temp.id('line ret'), pg_temp.id('mov pur')) $$),
    ('the credited value goes out', $$
      insert into app.stock_movements (id, business_id, business_date, location_id, material_id, kind, qty,
                                       value, unit_cost, purchase_line_id, return_line_id, receipt_id)
      values (pg_temp.id('mov cn'), pg_temp.id('biz A'), current_date, pg_temp.id('loc'),
              pg_temp.id('milk'), 'purchase_credit', 0, -30, null, pg_temp.id('line pur'),
              pg_temp.id('line cn'), pg_temp.id('mov pur')) $$),
    ('an expense on credit, finalized', $$
      insert into app.expenses (id, business_id, category_id, supplier_id, location_id, business_date,
                                document_type, payment_method, currency, amount, net_total, vat_total,
                                total, status, vat_in_cost, cost_total, posted_at, posted_by)
      values (pg_temp.id('exp'), pg_temp.id('biz A'), pg_temp.id('cat'), pg_temp.id('sup'),
              pg_temp.id('loc'), current_date, 'no_invoice', 'supplier_credit', 'AED', 500, 500, 0, 500,
              'posted', true, 500, now(), pg_temp.id('user A')) $$),
    ('a payment of the purchase', $$
      insert into app.purchase_payments (id, business_id, purchase_id, business_date, method, amount, currency)
      values (pg_temp.id('pp'), pg_temp.id('biz A'), pg_temp.id('pur'), current_date, 'cash', 100, 'AED') $$),
    ('a payment of the expense', $$
      insert into app.expense_payments (id, business_id, expense_id, business_date, method, amount, currency)
      values (pg_temp.id('ep'), pg_temp.id('biz A'), pg_temp.id('exp'), current_date, 'cash', 100, 'AED') $$)
  ) as v(what, stmt);

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

-- 2. Every identity, every change: refused (5 × 23 = 115) -------------------------------------------

create temp table attempts (n integer, what text, tbl text, stmt text);
insert into attempts values
  (1, 'a posted purchase is not edited', 'purchases',
   $$ update app.purchases set notes = 'changed' where id = pg_temp.id('pur') $$),
  (2, 'a posted purchase is not taken out', 'purchases',
   $$ update app.purchases set deleted_at = now() where id = pg_temp.id('pur') $$),
  (3, 'a posted purchase is not deleted', 'purchases',
   $$ delete from app.purchases where id = pg_temp.id('pur') $$),
  (4, 'a line of a posted purchase is not changed', 'purchase_lines',
   $$ update app.purchase_lines set qty = 1000 where id = pg_temp.id('line pur') $$),
  (5, 'a line of a posted purchase is not deleted', 'purchase_lines',
   $$ delete from app.purchase_lines where id = pg_temp.id('line pur') $$),
  (6, 'no line joins a posted purchase', 'purchase_lines',
   $$ insert into app.purchase_lines (id, business_id, purchase_id, position, kind, material_id, qty, unit, unit_price)
      values (pg_temp.id('line new'), pg_temp.id('biz A'), pg_temp.id('pur'), 1, 'material', pg_temp.id('milk'), 1, 'l', 1) $$),
  (7, 'a posted return is not edited', 'purchase_returns',
   $$ update app.purchase_returns set notes = 'changed' where id = pg_temp.id('ret') $$),
  (8, 'a posted return is not deleted', 'purchase_returns',
   $$ delete from app.purchase_returns where id = pg_temp.id('ret') $$),
  (9, 'a posted credit note is not edited', 'purchase_returns',
   $$ update app.purchase_returns set reference = 'CN-2' where id = pg_temp.id('cn') $$),
  (10, 'a posted credit note is not taken out', 'purchase_returns',
   $$ update app.purchase_returns set deleted_at = now() where id = pg_temp.id('cn') $$),
  (11, 'a line of a posted return keeps its quantity', 'purchase_return_lines',
   $$ update app.purchase_return_lines set qty = 1 where id = pg_temp.id('line ret') $$),
  (12, 'a line of a posted credit note keeps its amount', 'purchase_return_lines',
   $$ update app.purchase_return_lines set amount = 1 where id = pg_temp.id('line cn') $$),
  (13, 'a line of a posted return is not deleted', 'purchase_return_lines',
   $$ delete from app.purchase_return_lines where id = pg_temp.id('line ret') $$),
  (14, 'no line joins a posted credit note', 'purchase_return_lines',
   $$ insert into app.purchase_return_lines (id, business_id, return_id, purchase_id, purchase_line_id, position, amount)
      values (pg_temp.id('line cn 2'), pg_temp.id('biz A'), pg_temp.id('cn'), pg_temp.id('pur'), pg_temp.id('line pur'), 1, 1) $$),
  (15, 'a stock movement is not changed', 'stock_movements',
   $$ update app.stock_movements set value = 1 where id = pg_temp.id('mov pur') $$),
  (16, 'a stock movement is not deleted', 'stock_movements',
   $$ delete from app.stock_movements where id = pg_temp.id('mov ret') $$),
  (17, 'a posted expense keeps its amount', 'expenses',
   $$ update app.expenses set amount = 1, net_total = 1, total = 1 where id = pg_temp.id('exp') $$),
  (18, 'a posted expense is not taken out', 'expenses',
   $$ update app.expenses set deleted_at = now() where id = pg_temp.id('exp') $$),
  (19, 'a posted expense is not deleted', 'expenses',
   $$ delete from app.expenses where id = pg_temp.id('exp') $$),
  (20, 'a payment of a purchase keeps its amount', 'purchase_payments',
   $$ update app.purchase_payments set amount = 1 where id = pg_temp.id('pp') $$),
  (21, 'a payment of a purchase is not deleted', 'purchase_payments',
   $$ delete from app.purchase_payments where id = pg_temp.id('pp') $$),
  (22, 'a payment of an expense keeps its amount', 'expense_payments',
   $$ update app.expense_payments set amount = 1 where id = pg_temp.id('ep') $$),
  (23, 'a payment of an expense is not deleted', 'expense_payments',
   $$ delete from app.expense_payments where id = pg_temp.id('ep') $$);

select is(
  pg_temp.as_identity(i.who, t.stmt),
  case
    when i.who in ('authenticated', 'anon', 'service_role') then '42501'
    when i.who = 'bizcost_api' and t.tbl = 'stock_movements' then '42501'
    else '23001'
  end,
  t.what || ' (' || i.who || ')'
)
  from attempts t
 cross join (values (1, 'bizcost_api'), (2, 'authenticated'), (3, 'anon'), (4, 'service_role'),
                    (5, 'table owner')) as i(k, who)
 order by t.n, i.k;

select is(
  pg_temp.digest(),
  (select digest from digest_before),
  'the refused attempts changed nothing: every posted row is as it was'
);

-- 3. Only reversed, as designed (as bizcost_api) (14) ----------------------------------------------

select is(pg_temp.state_of(pg_temp.a(v.stmt)), v.state, v.what)
  from (values
    (1, '23001', 'a reversal that also changes something else is refused', $$
      update app.purchase_returns
         set status = 'reversed', reversed_at = now(), reversed_by = pg_temp.id('user A'),
             reversal_date = current_date, notes = 'changed'
       where id = pg_temp.id('ret') $$),
    (2, 'ok 1', 'a posted return becomes reversed: only its reversal columns change', $$
      update app.purchase_returns
         set status = 'reversed', reversed_at = now(), reversed_by = pg_temp.id('user A'),
             reversal_date = current_date
       where id = pg_temp.id('ret') $$),
    (3, 'ok 1', 'its movement is undone by a reversal movement', $$
      insert into app.stock_movements (id, business_id, business_date, location_id, material_id, kind, qty,
                                       value, purchase_line_id, return_line_id, reverses_id)
      values (pg_temp.id('rev ret'), pg_temp.id('biz A'), current_date, pg_temp.id('loc'),
              pg_temp.id('milk'), 'reversal', 10000, 60, pg_temp.id('line pur'), pg_temp.id('line ret'),
              pg_temp.id('mov ret')) $$),
    (4, '23505', 'a movement is reversed once', $$
      insert into app.stock_movements (id, business_id, business_date, location_id, material_id, kind, qty,
                                       value, purchase_line_id, return_line_id, reverses_id)
      values (pg_temp.id('rev ret 2'), pg_temp.id('biz A'), current_date, pg_temp.id('loc'),
              pg_temp.id('milk'), 'reversal', 10000, 60, pg_temp.id('line pur'), pg_temp.id('line ret'),
              pg_temp.id('mov ret')) $$),
    (5, '23001', 'a reversed return is not changed again', $$
      update app.purchase_returns set reversal_date = current_date - 1 where id = pg_temp.id('ret') $$),
    (6, '23001', 'a reversed return does not come back', $$
      update app.purchase_returns
         set status = 'posted', reversed_at = null, reversed_by = null, reversal_date = null
       where id = pg_temp.id('ret') $$),
    (7, 'ok 1', 'a posted credit note becomes reversed', $$
      update app.purchase_returns
         set status = 'reversed', reversed_at = now(), reversed_by = pg_temp.id('user A'),
             reversal_date = current_date
       where id = pg_temp.id('cn') $$),
    (8, '23514', 'a purchase whose payment stands is not reversed', $$
      update app.purchases
         set status = 'reversed', reversed_at = now(), reversed_by = pg_temp.id('user A'),
             reversal_date = current_date
       where id = pg_temp.id('pur') $$),
    (9, 'ok 1', 'a payment of a purchase is reversed', $$
      update app.purchase_payments
         set reversed_at = now(), reversed_by = pg_temp.id('user A'), reversal_date = current_date
       where id = pg_temp.id('pp') $$),
    (10, '23001', 'a reversed payment is not changed again', $$
      update app.purchase_payments set reversal_date = current_date - 1 where id = pg_temp.id('pp') $$),
    (11, 'ok 1', 'then the purchase becomes reversed', $$
      update app.purchases
         set status = 'reversed', reversed_at = now(), reversed_by = pg_temp.id('user A'),
             reversal_date = current_date
       where id = pg_temp.id('pur') $$),
    (12, 'ok 1', 'a payment of an expense is reversed', $$
      update app.expense_payments
         set reversed_at = now(), reversed_by = pg_temp.id('user A'), reversal_date = current_date
       where id = pg_temp.id('ep') $$),
    (13, 'ok 1', 'then the expense becomes reversed', $$
      update app.expenses
         set status = 'reversed', reversed_at = now(), reversed_by = pg_temp.id('user A'),
             reversal_date = current_date
       where id = pg_temp.id('exp') $$),
    (14, '23001', 'a reversed expense does not come back', $$
      update app.expenses
         set status = 'posted', reversed_at = null, reversed_by = null, reversal_date = null
       where id = pg_temp.id('exp') $$)
  ) as v(n, state, what, stmt)
 order by v.n;

select * from finish();
rollback;

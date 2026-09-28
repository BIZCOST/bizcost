-- pgTAP: Suppliers and Purchases, posted with WAC (M2 Step 3; docs/DATA_MODEL.md §6, D-110, D-114,
-- D-120). Two businesses, each with its owner. As bizcost_api, like the API: the rows of each business
-- are invisible to the other; composite FKs (and the attachments trigger) refuse every link across
-- businesses, and a pack of another material or a line of another purchase; the CHECKs hold the value
-- lists and shapes; a posted purchase and its lines are never changed (only reversed), a draft is never
-- reversed; the stock ledger is append-only for everyone, each purchase line comes in once and each
-- movement is reversed once; attachments never move; logo and attachment uploads are counted apart;
-- the touch and audit triggers run. RLS, the policy, the triggers and the grants of every tenant table
-- are also checked generically by 00_catalog_coverage, 01_grants and 03_rls_initplan.
begin;
select plan(73);

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

-- Runs p_sql as bizcost_api with the given user/business (fixture names; null = unset). Returns
-- 'ok <row count>', the first column of the first row (p_scalar), or 'ERROR <sqlstate>: <message>'.
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

insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', pg_temp.id(u.name), 'authenticated', 'authenticated',
       u.email, now(), '{}', '{}', now(), now()
  from (values ('user A', 'amira@example.test'), ('user B', 'badr@example.test')) as u(name, email);

-- 1. Column types (6) ------------------------------------------------------------------------

select col_type_is('app', 'purchase_lines', 'unit_price', 'numeric(20,4)',
                   'purchase_lines.unit_price is numeric(20,4): a document amount');
select col_type_is('app', 'purchase_lines', 'qty', 'numeric(24,6)',
                   'purchase_lines.qty is numeric(24,6): a quantity as typed');
select col_type_is('app', 'stock_movements', 'value', 'numeric(28,12)',
                   'stock_movements.value is numeric(28,12): never rounded to the currency');
select col_type_is('app', 'material_costs', 'avg_cost', 'numeric(28,12)',
                   'material_costs.avg_cost is numeric(28,12): the unrounded weighted average');
select col_type_is('app', 'purchase_return_lines', 'cost', 'numeric(28,12)',
                   'purchase_return_lines.cost is numeric(28,12): what a return took off the goods');
select col_type_is('app', 'businesses', 'books_closed_through', 'date',
                   'businesses.books_closed_through is a date ("books closed up to", D-114 rule 6)');

-- 2. Fixtures (14) ------------------------------------------------------------------------------

select is(
  pg_temp.api_value(v.who, null, format(
    $$ select app.create_business(pg_temp.id(%L), %L, 'en', 'Owner', pg_temp.id(%L), pg_temp.id(%L)) $$,
    v.biz, v.name, v.biz || ' owner role', v.biz || ' owner member')),
  pg_temp.id(v.biz)::text,
  'setup: ' || v.who || ' creates ' || v.biz
)
  from (values ('user A', 'biz A', 'Alpha Cafe'), ('user B', 'biz B', 'Beta Cafe')) as v(who, biz, name);

select is(pg_temp.api_exec(v.who, v.biz, v.stmt), 'ok 1', 'setup: ' || v.what)
  from (values
    ('user A', 'biz A', 'a location of A', $$
      insert into app.locations (id, business_id, name, is_default)
      values (pg_temp.id('loc A'), pg_temp.id('biz A'), 'Main', true) $$),
    ('user B', 'biz B', 'a location of B', $$
      insert into app.locations (id, business_id, name, is_default)
      values (pg_temp.id('loc B'), pg_temp.id('biz B'), 'Main', true) $$),
    ('user A', 'biz A', 'milk in A', $$
      insert into app.materials (id, business_id, name, dimension, unit)
      values (pg_temp.id('mat A'), pg_temp.id('biz A'), 'Milk', 'volume', 'l') $$),
    ('user A', 'biz A', 'beans in A, with a bag', $$
      with m as (
        insert into app.materials (id, business_id, name, dimension, unit)
        values (pg_temp.id('mat A2'), pg_temp.id('biz A'), 'Beans', 'mass', 'kg')
        returning id
      )
      insert into app.material_units (id, business_id, material_id, kind, name, qty, of_unit)
      select pg_temp.id('bag A2'), pg_temp.id('biz A'), m.id, 'pack', 'bag', 1000, 'g' from m $$),
    ('user B', 'biz B', 'milk in B', $$
      insert into app.materials (id, business_id, name, dimension, unit)
      values (pg_temp.id('mat B'), pg_temp.id('biz B'), 'Milk', 'volume', 'l') $$),
    ('user A', 'biz A', 'a supplier of A', $$
      insert into app.suppliers (id, business_id, name, trn)
      values (pg_temp.id('sup A'), pg_temp.id('biz A'), 'Al Ain Dairy', '100200300400500') $$),
    ('user B', 'biz B', 'a supplier of B with the same name: names are per business', $$
      insert into app.suppliers (id, business_id, name)
      values (pg_temp.id('sup B'), pg_temp.id('biz B'), 'al ain dairy') $$),
    ('user A', 'biz A', 'a draft purchase of A', $$
      insert into app.purchases (id, business_id, supplier_id, location_id, business_date, document_type, currency)
      values (pg_temp.id('pur A'), pg_temp.id('biz A'), pg_temp.id('sup A'), pg_temp.id('loc A'),
              current_date, 'no_invoice', 'AED') $$),
    ('user A', 'biz A', 'a second draft purchase of A', $$
      insert into app.purchases (id, business_id, location_id, business_date, document_type, currency)
      values (pg_temp.id('pur A2'), pg_temp.id('biz A'), pg_temp.id('loc A'), current_date, 'tax_invoice', 'AED') $$),
    ('user B', 'biz B', 'a draft purchase of B', $$
      insert into app.purchases (id, business_id, location_id, business_date, document_type, currency)
      values (pg_temp.id('pur B'), pg_temp.id('biz B'), pg_temp.id('loc B'), current_date, 'no_invoice', 'AED') $$),
    ('user A', 'biz A', '50 L of milk at 6 on A''s purchase', $$
      insert into app.purchase_lines (id, business_id, purchase_id, position, kind, material_id, qty, unit, unit_price)
      values (pg_temp.id('line A'), pg_temp.id('biz A'), pg_temp.id('pur A'), 0, 'material', pg_temp.id('mat A'), 50, 'l', 6) $$),
    ('user A', 'biz A', 'a bag of beans on A''s second purchase', $$
      insert into app.purchase_lines (id, business_id, purchase_id, position, kind, material_id, qty, pack_id, unit_price)
      values (pg_temp.id('line A2'), pg_temp.id('biz A'), pg_temp.id('pur A2'), 0, 'material', pg_temp.id('mat A2'), 1, pg_temp.id('bag A2'), 40) $$)
  ) as v(who, biz, what, stmt);

-- 3. Isolation (2) ----------------------------------------------------------------------------

select is(
  pg_temp.api_value('user A', 'biz A', $$
    select string_agg(t.n, ',' order by t.tbl collate "C") from (
      select 'purchase_lines' as tbl, count(*) filter (where business_id = pg_temp.id('biz A')) || '/'
             || count(*) filter (where business_id <> pg_temp.id('biz A')) as n from app.purchase_lines
      union all
      select 'purchases', count(*) filter (where business_id = pg_temp.id('biz A')) || '/'
             || count(*) filter (where business_id <> pg_temp.id('biz A')) from app.purchases
      union all
      select 'suppliers', count(*) filter (where business_id = pg_temp.id('biz A')) || '/'
             || count(*) filter (where business_id <> pg_temp.id('biz A')) from app.suppliers
    ) t $$),
  '2/0,2/0,1/0',
  'user A in business A sees only A''s purchase lines, purchases and suppliers'
);

select is(
  pg_temp.api_value('user A', 'biz B', $$
    select (select count(*) from app.suppliers) + (select count(*) from app.purchases)
         + (select count(*) from app.purchase_lines) + (select count(*) from app.purchase_returns)
         + (select count(*) from app.purchase_return_lines) + (select count(*) from app.stock_movements)
         + (select count(*) from app.material_costs) + (select count(*) from app.stock_balances)
         + (select count(*) from app.attachments) $$),
  '0',
  'user A naming business B (not a member) sees no row of the purchasing tables'
);

-- 4. No link across businesses, materials or purchases (12) ----------------------------------

select is(
  pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', v.stmt)),
  v.state,
  v.what
)
  from (values
    ('a purchase of A cannot name B''s supplier', '23503', $$
      insert into app.purchases (id, business_id, supplier_id, location_id, business_date, document_type, currency)
      values (pg_temp.id('x1'), pg_temp.id('biz A'), pg_temp.id('sup B'), pg_temp.id('loc A'), current_date, 'no_invoice', 'AED') $$),
    ('a purchase of A cannot come in at B''s location', '23503', $$
      insert into app.purchases (id, business_id, location_id, business_date, document_type, currency)
      values (pg_temp.id('x2'), pg_temp.id('biz A'), pg_temp.id('loc B'), current_date, 'no_invoice', 'AED') $$),
    ('a line of A cannot buy B''s material', '23503', $$
      insert into app.purchase_lines (id, business_id, purchase_id, position, kind, material_id, qty, unit, unit_price)
      values (pg_temp.id('x3'), pg_temp.id('biz A'), pg_temp.id('pur A'), 1, 'material', pg_temp.id('mat B'), 1, 'l', 1) $$),
    ('a line buys a pack of its own material only', '23503', $$
      insert into app.purchase_lines (id, business_id, purchase_id, position, kind, material_id, qty, pack_id, unit_price)
      values (pg_temp.id('x4'), pg_temp.id('biz A'), pg_temp.id('pur A'), 1, 'material', pg_temp.id('mat A'), 1, pg_temp.id('bag A2'), 1) $$),
    ('a line of A cannot join B''s purchase', '23503', $$
      insert into app.purchase_lines (id, business_id, purchase_id, position, kind, material_id, qty, unit, unit_price)
      values (pg_temp.id('x5'), pg_temp.id('biz A'), pg_temp.id('pur B'), 0, 'material', pg_temp.id('mat A'), 1, 'l', 1) $$),
    ('a return of A cannot be for B''s purchase', '23503', $$
      insert into app.purchase_returns (id, business_id, purchase_id, kind, business_date, currency)
      values (pg_temp.id('x6'), pg_temp.id('biz A'), pg_temp.id('pur B'), 'return', current_date, 'AED') $$),
    ('a stock movement of A cannot move B''s material', '23503', $$
      insert into app.stock_movements (id, business_id, business_date, location_id, material_id, kind, qty, value, purchase_line_id)
      values (pg_temp.id('x7'), pg_temp.id('biz A'), current_date, pg_temp.id('loc A'), pg_temp.id('mat B'), 'purchase', 1, 1, pg_temp.id('line A')) $$),
    ('a cost row of A cannot be for B''s material', '23503', $$
      insert into app.material_costs (id, business_id, material_id)
      values (pg_temp.id('x8'), pg_temp.id('biz A'), pg_temp.id('mat B')) $$),
    ('a balance of A cannot be at B''s location', '23503', $$
      insert into app.stock_balances (id, business_id, location_id, material_id)
      values (pg_temp.id('x9'), pg_temp.id('biz A'), pg_temp.id('loc B'), pg_temp.id('mat A')) $$),
    ('an attachment of A cannot name B''s purchase (trigger)', '23503', $$
      insert into app.attachments (id, business_id, entity, entity_id, path, file_name, content_type, size_bytes)
      values (pg_temp.id('x10'), pg_temp.id('biz A'), 'purchase', pg_temp.id('pur B'),
              pg_temp.id('biz A') || '/purchase/x10.png', 'x.png', 'image/png', 10) $$),
    ('a supplier row of business B written with A''s context breaks the policy', '42501', $$
      insert into app.suppliers (id, business_id, name) values (pg_temp.id('x11'), pg_temp.id('biz B'), 'Other') $$)
  ) as v(what, state, stmt);

select is(
  pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', $$
    with r as (
      insert into app.purchase_returns (id, business_id, purchase_id, kind, business_date, currency)
      values (pg_temp.id('x12'), pg_temp.id('biz A'), pg_temp.id('pur A'), 'return', current_date, 'AED')
      returning id
    )
    insert into app.purchase_return_lines (id, business_id, return_id, purchase_id, purchase_line_id, position, qty)
    select pg_temp.id('x12 line'), pg_temp.id('biz A'), r.id, pg_temp.id('pur A'), pg_temp.id('line A2'), 0, 1 from r $$)),
  '23503',
  'a return line names a line of its own return''s purchase only'
);

-- 5. Value lists and shapes (12) ---------------------------------------------------------------

select is(
  pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', v.stmt)),
  '23514',
  v.what
)
  from (values
    ('a document is a tax invoice, a non-tax invoice or none ("receipt" is not one)', $$
      insert into app.purchases (id, business_id, location_id, business_date, document_type, currency)
      values (pg_temp.id('c1'), pg_temp.id('biz A'), pg_temp.id('loc A'), current_date, 'receipt', 'AED') $$),
    ('payment methods are cash, card, bank transfer, cheque or other', $$
      insert into app.purchases (id, business_id, location_id, business_date, document_type, currency, payment_method)
      values (pg_temp.id('c2'), pg_temp.id('biz A'), pg_temp.id('loc A'), current_date, 'no_invoice', 'AED', 'crypto') $$),
    ('a document discount is a percentage or an amount, not both', $$
      insert into app.purchases (id, business_id, location_id, business_date, document_type, currency, discount_percent, discount_amount)
      values (pg_temp.id('c3'), pg_temp.id('biz A'), pg_temp.id('loc A'), current_date, 'no_invoice', 'AED', 5, 1) $$),
    ('a currency is three capital letters', $$
      insert into app.purchases (id, business_id, location_id, business_date, document_type, currency)
      values (pg_temp.id('c4'), pg_temp.id('biz A'), pg_temp.id('loc A'), current_date, 'no_invoice', 'aed') $$),
    ('a new purchase is not born posted without who and when', $$
      insert into app.purchases (id, business_id, location_id, business_date, document_type, currency, status)
      values (pg_temp.id('c5'), pg_temp.id('biz A'), pg_temp.id('loc A'), current_date, 'no_invoice', 'AED', 'posted') $$),
    ('a material line has a standard unit or a pack', $$
      insert into app.purchase_lines (id, business_id, purchase_id, position, kind, material_id, qty, unit_price)
      values (pg_temp.id('c6'), pg_temp.id('biz A'), pg_temp.id('pur A'), 1, 'material', pg_temp.id('mat A'), 1, 1) $$),
    ('a delivery line names no material', $$
      insert into app.purchase_lines (id, business_id, purchase_id, position, kind, material_id, qty, unit_price)
      values (pg_temp.id('c7'), pg_temp.id('biz A'), pg_temp.id('pur A'), 1, 'delivery', pg_temp.id('mat A'), 1, 10) $$),
    ('a quantity bought is more than zero', $$
      insert into app.purchase_lines (id, business_id, purchase_id, position, kind, material_id, qty, unit, unit_price)
      values (pg_temp.id('c8'), pg_temp.id('biz A'), pg_temp.id('pur A'), 1, 'material', pg_temp.id('mat A'), 0, 'l', 1) $$),
    ('a return is a return or a credit note; only a credit note is split', $$
      insert into app.purchase_returns (id, business_id, purchase_id, kind, business_date, currency, split_amount)
      values (pg_temp.id('c9'), pg_temp.id('biz A'), pg_temp.id('pur A'), 'return', current_date, 'AED', 10) $$),
    ('a purchase movement brings a quantity in', $$
      insert into app.stock_movements (id, business_id, business_date, location_id, material_id, kind, qty, value, purchase_line_id)
      values (pg_temp.id('c10'), pg_temp.id('biz A'), current_date, pg_temp.id('loc A'), pg_temp.id('mat A'), 'purchase', -1, 1, pg_temp.id('line A')) $$),
    ('a supplier''s TRN has 15 digits', $$
      insert into app.suppliers (id, business_id, name, trn)
      values (pg_temp.id('c11'), pg_temp.id('biz A'), 'Short TRN', '12345678901234') $$)
  ) as v(what, stmt);

select is(
  pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', $$
    insert into app.suppliers (id, business_id, name) values (pg_temp.id('n1'), pg_temp.id('biz A'), 'AL AIN DAIRY') $$)),
  '23505',
  'a second supplier with the same name in business A is refused, whatever the case'
);

-- 6. Posting: a posted purchase is never changed, only reversed (11) -------------------------

select is(
  pg_temp.api_exec('user A', 'biz A', $$
    update app.purchase_lines set base_qty = 50000, cost = 300 where id = pg_temp.id('line A') $$),
  'ok 1',
  'posting: a draft''s line takes its snapshots (base quantity and cost)'
);

select is(
  pg_temp.api_exec('user A', 'biz A', $$
    update app.purchases
       set status = 'posted', posted_at = now(), posted_by = pg_temp.id('user A'),
           vat_in_cost = true, cost_total = 300
     where id = pg_temp.id('pur A') $$),
  'ok 1',
  'posting: the draft becomes posted'
);

select is(
  pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', v.stmt)),
  '23001',
  v.what
)
  from (values
    ('a posted purchase is never edited', $$
      update app.purchases set notes = 'changed' where id = pg_temp.id('pur A') $$),
    ('a posted purchase is never discarded (soft-deleted)', $$
      update app.purchases set deleted_at = now() where id = pg_temp.id('pur A') $$),
    ('a posted purchase is never deleted', $$
      delete from app.purchases where id = pg_temp.id('pur A') $$),
    ('a line of a posted purchase is never changed', $$
      update app.purchase_lines set qty = 60 where id = pg_temp.id('line A') $$),
    ('a posted purchase gets no new line', $$
      insert into app.purchase_lines (id, business_id, purchase_id, position, kind, material_id, qty, unit, unit_price)
      values (pg_temp.id('p1'), pg_temp.id('biz A'), pg_temp.id('pur A'), 1, 'material', pg_temp.id('mat A'), 1, 'l', 1) $$)
  ) as v(what, stmt);

select is(
  pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', $$
    update app.purchases
       set status = 'reversed', reversed_at = now(), reversed_by = pg_temp.id('user A'),
           reversal_date = current_date
     where id = pg_temp.id('pur A2') $$)),
  '23514',
  'a draft is never reversed (it is edited or discarded)'
);

select is(
  pg_temp.api_exec('user A', 'biz A', $$
    update app.purchases
       set status = 'reversed', reversed_at = now(), reversed_by = pg_temp.id('user A'),
           reversal_date = current_date
     where id = pg_temp.id('pur A') $$),
  'ok 1',
  'a posted purchase becomes reversed: only its status and reversal columns change'
);

select is(
  pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', $$
    update app.purchases
       set status = 'posted', reversed_at = null, reversed_by = null, reversal_date = null
     where id = pg_temp.id('pur A') $$)),
  '23001',
  'a reversed purchase never comes back'
);

select is(
  pg_temp.api_value('user A', 'biz A', $$
    select version || '/' || (updated_by = pg_temp.id('user A')) from app.purchases where id = pg_temp.id('pur A') $$),
  '3/true',
  'posting and reversing bump the purchase''s version and record who (touch_row)'
);

-- 7. The stock ledger is append-only (9) ---------------------------------------------------------

select is(
  pg_temp.api_exec('user A', 'biz A', $$
    insert into app.stock_movements (id, business_id, business_date, location_id, material_id, kind, qty, value, unit_cost, purchase_line_id)
    values (pg_temp.id('mov A'), pg_temp.id('biz A'), current_date, pg_temp.id('loc A'), pg_temp.id('mat A'),
            'purchase', 50000, 300, 0.006, pg_temp.id('line A')) $$),
  'ok 1',
  'the API adds a movement: 50 L of milk come in for 300'
);

select is(
  pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', $$
    insert into app.stock_movements (id, business_id, business_date, location_id, material_id, kind, qty, value, purchase_line_id)
    values (pg_temp.id('mov A dup'), pg_temp.id('biz A'), current_date, pg_temp.id('loc A'), pg_temp.id('mat A'),
            'purchase', 50000, 300, pg_temp.id('line A')) $$)),
  '23505',
  'a purchase line comes into stock once (a second posting cannot write twice)'
);

select is(
  pg_temp.api_exec('user A', 'biz A', $$
    insert into app.stock_movements (id, business_id, business_date, location_id, material_id, kind, qty, value, purchase_line_id, reverses_id)
    values (pg_temp.id('rev A'), pg_temp.id('biz A'), current_date, pg_temp.id('loc A'), pg_temp.id('mat A'),
            'reversal', -50000, -300, pg_temp.id('line A'), pg_temp.id('mov A')) $$),
  'ok 1',
  'a reversal names the movement it reverses'
);

select is(
  pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', $$
    insert into app.stock_movements (id, business_id, business_date, location_id, material_id, kind, qty, value, purchase_line_id, reverses_id)
    values (pg_temp.id('rev A dup'), pg_temp.id('biz A'), current_date, pg_temp.id('loc A'), pg_temp.id('mat A'),
            'reversal', -50000, -300, pg_temp.id('line A'), pg_temp.id('mov A')) $$)),
  '23505',
  'a movement is reversed at most once'
);

select is(
  pg_temp.api_value('user A', 'biz A', $$
    select string_agg(seq_order::text, ',') from (
      select (seq > lag(seq) over (order by seq))::int as seq_order
        from app.stock_movements where business_id = pg_temp.id('biz A')
    ) s where seq_order is not null $$),
  '1',
  'movements get their posting sequence on insert, in order'
);

select is(
  pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', v.stmt)),
  '42501',
  v.what
)
  from (values
    ('bizcost_api may not update a movement', $$
      update app.stock_movements set value = 1 where id = pg_temp.id('mov A') $$),
    ('bizcost_api may not delete a movement', $$
      delete from app.stock_movements where id = pg_temp.id('mov A') $$)
  ) as v(what, stmt);

select is(
  pg_temp.owner_state(format($$ update app.stock_movements set value = 1 where id = %L $$, pg_temp.id('mov A'))),
  '23001',
  'nobody else updates a movement either (trigger)'
);

select is(
  pg_temp.owner_state(format($$ delete from app.stock_movements where id = %L $$, pg_temp.id('mov A'))),
  '23001',
  'nobody else deletes a movement either (trigger)'
);

-- 8. Attachments and uploads (5) ------------------------------------------------------------------

select is(
  pg_temp.api_exec('user A', 'biz A', $$
    insert into app.attachments (id, business_id, entity, entity_id, path, file_name, content_type, size_bytes)
    values (pg_temp.id('att A'), pg_temp.id('biz A'), 'purchase', pg_temp.id('pur A'),
            pg_temp.id('biz A') || '/purchase/att.png', 'receipt.png', 'image/png', 1234) $$),
  'ok 1',
  'a receipt is attached to A''s purchase'
);

select is(
  pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', $$
    update app.attachments set entity_id = pg_temp.id('pur A2') where id = pg_temp.id('att A') $$)),
  '23514',
  'an attachment never moves to another record'
);

select is(
  pg_temp.api_exec('user A', 'biz A', $$
    insert into app.file_uploads (id, business_id, path, purpose, content_type, expires_at)
    select pg_temp.id('logo ' || n), pg_temp.id('biz A'),
           pg_temp.id('biz A') || '/logo/' || pg_temp.id('logo ' || n) || '.png', 'logo', 'image/png',
           now() + interval '2 hours'
      from generate_series(1, 10) as n $$),
  'ok 10',
  'setup: ten logo uploads in an hour'
);

select is(
  pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', $$
    insert into app.file_uploads (id, business_id, path, purpose, content_type, expires_at)
    values (pg_temp.id('logo 11'), pg_temp.id('biz A'), pg_temp.id('biz A') || '/logo/11.png', 'logo', 'image/png',
            now() + interval '2 hours') $$)),
  'BZ429',
  'an eleventh logo upload in an hour is refused'
);

select is(
  pg_temp.api_exec('user A', 'biz A', $$
    insert into app.file_uploads (id, business_id, path, purpose, content_type, expires_at)
    values (pg_temp.id('receipt 1'), pg_temp.id('biz A'), pg_temp.id('biz A') || '/purchase/r1.pdf', 'attachment',
            'application/pdf', now() + interval '2 hours') $$),
  'ok 1',
  'attachment uploads are counted apart from logos (100 an hour)'
);

-- 9. Touch and audit triggers (2) ------------------------------------------------------------------

select is(
  pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', $$
    update app.suppliers set business_id = pg_temp.id('biz B') where id = pg_temp.id('sup A') $$)),
  '23514',
  'a supplier cannot move to another business (touch_row)'
);

select is(
  (select string_agg(e.entity, ',' order by e.entity collate "C")
     from (select distinct entity
             from app.audit_log
            where business_id = pg_temp.id('biz A')
              and actor_user_id = pg_temp.id('user A')
              and entity in ('suppliers', 'purchases', 'purchase_lines', 'purchase_returns',
                             'stock_movements', 'attachments', 'file_uploads')) as e),
  'attachments,file_uploads,purchase_lines,purchases,stock_movements,suppliers',
  'writes of the purchasing tables are in the audit log, with their actor'
);

select * from finish();
rollback;

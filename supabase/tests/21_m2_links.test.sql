-- pgTAP: the Costing Core's tables never link across businesses (M2 Step 8; DATA_MODEL.md §1.2, D-047).
-- Two businesses, A and B, each with a full set of Costing Core rows. As bizcost_api in business A,
-- every cross-table link of every M2 table is tried twice: naming A's own row (accepted; the attempt is
-- rolled back) and naming B's row (refused, 23503: the composite foreign key, or for attachments the
-- check_target trigger). A catalog check makes the list complete: every foreign key of an M2 table
-- (other than business_id → businesses) is tried here, and nothing tried is missing from the catalog.
-- Then the structure: every M2 tenant table has business_id NOT NULL, ENABLE + FORCE row level security
-- and only the standard InitPlan-safe tenant_isolation policy for bizcost_api; and the SECURITY DEFINER
-- functions of schema app are exactly the known ones (M2 added none), each with search_path '' and
-- owned by postgres, callable only by bizcost_api. 00_catalog_coverage, 01_grants and 03_rls_initplan
-- check the same rules generically for every table and function.
begin;
select plan(128);

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
  from (values ('user A', 'asma@example.test'), ('user B', 'basil@example.test')) as u(name, email);

-- 1. Fixtures: the same rows in A and B (2 + 2 × 19 = 40) -----------------------------------------

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
    (2, 'milk', $$
      insert into app.materials (id, business_id, name, dimension, unit)
      values (pg_temp.id('mat {x}'), pg_temp.id('{biz}'), 'Milk', 'volume', 'l') $$),
    (3, 'a bottle of milk', $$
      insert into app.material_units (id, business_id, material_id, kind, name, qty, of_unit)
      values (pg_temp.id('pack {x}'), pg_temp.id('{biz}'), pg_temp.id('mat {x}'), 'pack', 'bottle', 1, 'l') $$),
    (4, 'sugar', $$
      insert into app.materials (id, business_id, name, dimension, unit)
      values (pg_temp.id('mat2 {x}'), pg_temp.id('{biz}'), 'Sugar', 'mass', 'kg') $$),
    (5, 'a latte', $$
      insert into app.products_services (id, business_id, name, type, unit)
      values (pg_temp.id('prod {x}'), pg_temp.id('{biz}'), 'Latte', 'product', 'piece') $$),
    (6, 'a cake (no recipe yet)', $$
      insert into app.products_services (id, business_id, name, type, unit)
      values (pg_temp.id('prod2 {x}'), pg_temp.id('{biz}'), 'Cake', 'product', 'piece') $$),
    (7, 'the latte''s recipe', $$
      insert into app.recipes (id, business_id, product_id)
      values (pg_temp.id('recipe {x}'), pg_temp.id('{biz}'), pg_temp.id('prod {x}')) $$),
    (8, 'a supplier', $$
      insert into app.suppliers (id, business_id, name)
      values (pg_temp.id('sup {x}'), pg_temp.id('{biz}'), 'Dairy') $$),
    (9, 'a draft purchase with a line of milk', $$
      with p as (
        insert into app.purchases (id, business_id, supplier_id, location_id, business_date,
                                   document_type, payment_method, currency)
        values (pg_temp.id('pur {x}'), pg_temp.id('{biz}'), pg_temp.id('sup {x}'), pg_temp.id('loc {x}'),
                current_date, 'no_invoice', 'cash', 'AED')
        returning id
      )
      insert into app.purchase_lines (id, business_id, purchase_id, position, kind, material_id, qty, unit,
                                      unit_price)
      select pg_temp.id('line {x}'), pg_temp.id('{biz}'), p.id, 0, 'material', pg_temp.id('mat {x}'), 10,
             'l', 5
        from p $$),
    (10, 'its second line', $$
      insert into app.purchase_lines (id, business_id, purchase_id, position, kind, material_id, qty, unit,
                                      unit_price)
      values (pg_temp.id('line2 {x}'), pg_temp.id('{biz}'), pg_temp.id('pur {x}'), 1, 'material',
              pg_temp.id('mat2 {x}'), 10, 'kg', 5) $$),
    (11, 'a purchase on credit, posted', $$
      insert into app.purchases (id, business_id, supplier_id, location_id, business_date, document_type,
                                 payment_method, currency, status, posted_at, posted_by, vat_in_cost,
                                 cost_total)
      values (pg_temp.id('pur credit {x}'), pg_temp.id('{biz}'), pg_temp.id('sup {x}'),
              pg_temp.id('loc {x}'), current_date, 'no_invoice', 'supplier_credit', 'AED', 'posted', now(),
              pg_temp.id('user {x}'), true, 50) $$),
    (12, 'a draft return of the first line', $$
      with r as (
        insert into app.purchase_returns (id, business_id, purchase_id, kind, business_date, currency)
        values (pg_temp.id('ret {x}'), pg_temp.id('{biz}'), pg_temp.id('pur {x}'), 'return', current_date, 'AED')
        returning id
      )
      insert into app.purchase_return_lines (id, business_id, return_id, purchase_id, purchase_line_id,
                                             position, qty)
      select pg_temp.id('ret line {x}'), pg_temp.id('{biz}'), r.id, pg_temp.id('pur {x}'),
             pg_temp.id('line {x}'), 0, 1
        from r $$),
    (13, 'the first line''s goods in the ledger', $$
      insert into app.stock_movements (id, business_id, business_date, location_id, material_id, kind, qty,
                                       value, purchase_line_id)
      values (pg_temp.id('mov {x}'), pg_temp.id('{biz}'), current_date, pg_temp.id('loc {x}'),
              pg_temp.id('mat {x}'), 'purchase', 10000, 50, pg_temp.id('line {x}')) $$),
    (14, 'a category', $$
      insert into app.cost_categories (id, business_id, name)
      values (pg_temp.id('cat {x}'), pg_temp.id('{biz}'), 'Rent') $$),
    (15, 'a draft expense', $$
      insert into app.expenses (id, business_id, category_id, location_id, business_date, document_type,
                                payment_method, currency, amount, net_total, vat_total, total)
      values (pg_temp.id('exp {x}'), pg_temp.id('{biz}'), pg_temp.id('cat {x}'), pg_temp.id('loc {x}'),
              current_date, 'no_invoice', 'cash', 'AED', 10, 10, 0, 10) $$),
    (16, 'an expense on credit, finalized', $$
      insert into app.expenses (id, business_id, category_id, supplier_id, location_id, business_date,
                                document_type, payment_method, currency, amount, net_total, vat_total,
                                total, status, posted_at, posted_by, vat_in_cost, cost_total)
      values (pg_temp.id('exp credit {x}'), pg_temp.id('{biz}'), pg_temp.id('cat {x}'),
              pg_temp.id('sup {x}'), pg_temp.id('loc {x}'), current_date, 'no_invoice', 'supplier_credit',
              'AED', 10, 10, 0, 10, 'posted', now(), pg_temp.id('user {x}'), true, 10) $$),
    (17, 'a second location', $$
      insert into app.locations (id, business_id, name)
      values (pg_temp.id('loc2 {x}'), pg_temp.id('{biz}'), 'Branch') $$),
    (18, 'a running cost', $$
      insert into app.running_costs (id, business_id, name, category_id, amount, starts_on)
      values (pg_temp.id('run {x}'), pg_temp.id('{biz}'), 'Rent', pg_temp.id('cat {x}'), 1000, current_date) $$),
    (19, 'a sales channel (M3: an expense may pay its app fees)', $$
      insert into app.sales_channels (id, business_id, name, kind)
      values (pg_temp.id('chan {x}'), pg_temp.id('{biz}'), 'Talabat', 'delivery_app') $$)
  ) as f(n, what, stmt)
 order by s.x, f.n;

-- 2. Every link: A's own row is accepted, B's refused (2 × 41 = 82, then 1) ----------------------
-- `:t` in a statement is the target: A's row named `<target> A`, or B's named `<target> B`.

create temp table links (n integer, child text, cols text, target text, what text, stmt text);
insert into links values
  (1, 'material_units', 'material_id', 'mat', 'a pack of a material', $$
    insert into app.material_units (id, business_id, material_id, kind, name, qty, of_unit)
    values (pg_temp.id('t'), pg_temp.id('biz A'), :t, 'pack', 'box', 2, 'l') $$),
  (2, 'material_units', 'material_id,of_pack_id', 'pack', 'a pack made of another pack', $$
    insert into app.material_units (id, business_id, material_id, kind, name, qty, of_pack_id)
    values (pg_temp.id('t'), pg_temp.id('biz A'), pg_temp.id('mat A'), 'pack', 'crate', 6, :t) $$),
  (3, 'products_services', 'resale_material_id', 'mat', 'an item bought ready to sell and its material', $$
    insert into app.products_services (id, business_id, name, type, unit, resale_material_id)
    values (pg_temp.id('t'), pg_temp.id('biz A'), 'Bottled milk', 'product', 'l', :t) $$),
  (4, 'product_locations', 'product_id', 'prod', 'where a product is sold: the product', $$
    insert into app.product_locations (id, business_id, product_id, location_id)
    values (pg_temp.id('t'), pg_temp.id('biz A'), :t, pg_temp.id('loc A')) $$),
  (5, 'product_locations', 'location_id', 'loc', 'where a product is sold: the location', $$
    insert into app.product_locations (id, business_id, product_id, location_id)
    values (pg_temp.id('t'), pg_temp.id('biz A'), pg_temp.id('prod A'), :t) $$),
  (6, 'recipes', 'product_id', 'prod2', 'a recipe and its product', $$
    insert into app.recipes (id, business_id, product_id) values (pg_temp.id('t'), pg_temp.id('biz A'), :t) $$),
  (7, 'recipe_lines', 'recipe_id', 'recipe', 'a recipe line and its recipe', $$
    insert into app.recipe_lines (id, business_id, recipe_id, position, material_id, qty, unit, base_qty)
    values (pg_temp.id('t'), pg_temp.id('biz A'), :t, 0, pg_temp.id('mat A'), 1, 'l', 1000) $$),
  (8, 'recipe_lines', 'material_id', 'mat', 'a recipe line and its material', $$
    insert into app.recipe_lines (id, business_id, recipe_id, position, material_id, qty, unit, base_qty)
    values (pg_temp.id('t'), pg_temp.id('biz A'), pg_temp.id('recipe A'), 0, :t, 1, 'l', 1000) $$),
  (9, 'recipe_lines', 'material_id,pack_id', 'pack', 'a recipe line and its pack', $$
    insert into app.recipe_lines (id, business_id, recipe_id, position, material_id, qty, pack_id, base_qty)
    values (pg_temp.id('t'), pg_temp.id('biz A'), pg_temp.id('recipe A'), 0, pg_temp.id('mat A'), 1, :t, 1000) $$),
  (10, 'purchases', 'supplier_id', 'sup', 'a purchase and its supplier', $$
    insert into app.purchases (id, business_id, supplier_id, location_id, business_date, document_type, currency)
    values (pg_temp.id('t'), pg_temp.id('biz A'), :t, pg_temp.id('loc A'), current_date, 'no_invoice', 'AED') $$),
  (11, 'purchases', 'location_id', 'loc', 'a purchase and its location', $$
    insert into app.purchases (id, business_id, location_id, business_date, document_type, currency)
    values (pg_temp.id('t'), pg_temp.id('biz A'), :t, current_date, 'no_invoice', 'AED') $$),
  (12, 'purchases', 'copied_from_id', 'pur', 'a corrected copy and the purchase it replaces', $$
    insert into app.purchases (id, business_id, location_id, business_date, document_type, currency, copied_from_id)
    values (pg_temp.id('t'), pg_temp.id('biz A'), pg_temp.id('loc A'), current_date, 'no_invoice', 'AED', :t) $$),
  (13, 'purchases', 'paid_by_member_id', 'biz owner member', 'a purchase and the member who paid', $$
    insert into app.purchases (id, business_id, location_id, business_date, document_type, currency,
                               payment_method, paid_by_member_id)
    values (pg_temp.id('t'), pg_temp.id('biz A'), pg_temp.id('loc A'), current_date, 'no_invoice', 'AED',
            'paid_by_member', :t) $$),
  (14, 'purchase_lines', 'purchase_id', 'pur', 'a purchase line and its purchase', $$
    insert into app.purchase_lines (id, business_id, purchase_id, position, kind, material_id, qty, unit, unit_price)
    values (pg_temp.id('t'), pg_temp.id('biz A'), :t, 5, 'material', pg_temp.id('mat A'), 1, 'l', 1) $$),
  (15, 'purchase_lines', 'material_id', 'mat', 'a purchase line and its material', $$
    insert into app.purchase_lines (id, business_id, purchase_id, position, kind, material_id, qty, unit, unit_price)
    values (pg_temp.id('t'), pg_temp.id('biz A'), pg_temp.id('pur A'), 5, 'material', :t, 1, 'l', 1) $$),
  (16, 'purchase_lines', 'material_id,pack_id', 'pack', 'a purchase line and its pack', $$
    insert into app.purchase_lines (id, business_id, purchase_id, position, kind, material_id, qty, pack_id, unit_price)
    values (pg_temp.id('t'), pg_temp.id('biz A'), pg_temp.id('pur A'), 5, 'material', pg_temp.id('mat A'), 1, :t, 1) $$),
  (17, 'purchase_returns', 'purchase_id', 'pur', 'a return and its purchase', $$
    insert into app.purchase_returns (id, business_id, purchase_id, kind, business_date, currency)
    values (pg_temp.id('t'), pg_temp.id('biz A'), :t, 'return', current_date, 'AED') $$),
  (18, 'purchase_return_lines', 'purchase_id', 'pur', 'a return line and its purchase', $$
    insert into app.purchase_return_lines (id, business_id, return_id, purchase_id, purchase_line_id, position, qty)
    values (pg_temp.id('t'), pg_temp.id('biz A'), pg_temp.id('ret A'), :t, pg_temp.id('line2 A'), 1, 1) $$),
  (19, 'purchase_return_lines', 'purchase_id,purchase_line_id', 'line2', 'a return line and the purchase line it takes back', $$
    insert into app.purchase_return_lines (id, business_id, return_id, purchase_id, purchase_line_id, position, qty)
    values (pg_temp.id('t'), pg_temp.id('biz A'), pg_temp.id('ret A'), pg_temp.id('pur A'), :t, 1, 1) $$),
  (20, 'purchase_return_lines', 'purchase_id,return_id', 'ret', 'a return line and its return', $$
    insert into app.purchase_return_lines (id, business_id, return_id, purchase_id, purchase_line_id, position, qty)
    values (pg_temp.id('t'), pg_temp.id('biz A'), :t, pg_temp.id('pur A'), pg_temp.id('line2 A'), 1, 1) $$),
  (21, 'stock_movements', 'location_id', 'loc', 'a movement and its location', $$
    insert into app.stock_movements (id, business_id, business_date, location_id, material_id, kind, qty, value, purchase_line_id)
    values (pg_temp.id('t'), pg_temp.id('biz A'), current_date, :t, pg_temp.id('mat2 A'), 'purchase', 1, 1, pg_temp.id('line2 A')) $$),
  (22, 'stock_movements', 'material_id', 'mat', 'a movement and its material', $$
    insert into app.stock_movements (id, business_id, business_date, location_id, material_id, kind, qty, value, purchase_line_id)
    values (pg_temp.id('t'), pg_temp.id('biz A'), current_date, pg_temp.id('loc A'), :t, 'purchase', 1, 1, pg_temp.id('line2 A')) $$),
  (23, 'stock_movements', 'purchase_line_id', 'line2', 'a movement and its purchase line', $$
    insert into app.stock_movements (id, business_id, business_date, location_id, material_id, kind, qty, value, purchase_line_id)
    values (pg_temp.id('t'), pg_temp.id('biz A'), current_date, pg_temp.id('loc A'), pg_temp.id('mat2 A'), 'purchase', 1, 1, :t) $$),
  (24, 'stock_movements', 'receipt_id', 'mov', 'a return''s movement and the receipt it takes from', $$
    insert into app.stock_movements (id, business_id, business_date, location_id, material_id, kind, qty, value,
                                     purchase_line_id, return_line_id, receipt_id)
    values (pg_temp.id('t'), pg_temp.id('biz A'), current_date, pg_temp.id('loc A'), pg_temp.id('mat A'),
            'purchase_return', -1000, -5, pg_temp.id('line A'), pg_temp.id('ret line A'), :t) $$),
  (25, 'stock_movements', 'return_line_id', 'ret line', 'a return''s movement and its return line', $$
    insert into app.stock_movements (id, business_id, business_date, location_id, material_id, kind, qty, value,
                                     purchase_line_id, return_line_id, receipt_id)
    values (pg_temp.id('t'), pg_temp.id('biz A'), current_date, pg_temp.id('loc A'), pg_temp.id('mat A'),
            'purchase_return', -1000, -5, pg_temp.id('line A'), :t, pg_temp.id('mov A')) $$),
  (26, 'stock_movements', 'reverses_id', 'mov', 'a reversal and the movement it reverses', $$
    insert into app.stock_movements (id, business_id, business_date, location_id, material_id, kind, qty, value,
                                     purchase_line_id, reverses_id)
    values (pg_temp.id('t'), pg_temp.id('biz A'), current_date, pg_temp.id('loc A'), pg_temp.id('mat A'),
            'reversal', -10000, -50, pg_temp.id('line A'), :t) $$),
  (27, 'material_costs', 'material_id', 'mat', 'a cost row and its material', $$
    insert into app.material_costs (id, business_id, material_id) values (pg_temp.id('t'), pg_temp.id('biz A'), :t) $$),
  (28, 'stock_balances', 'location_id', 'loc', 'a balance and its location', $$
    insert into app.stock_balances (id, business_id, location_id, material_id)
    values (pg_temp.id('t'), pg_temp.id('biz A'), :t, pg_temp.id('mat A')) $$),
  (29, 'stock_balances', 'material_id', 'mat', 'a balance and its material', $$
    insert into app.stock_balances (id, business_id, location_id, material_id)
    values (pg_temp.id('t'), pg_temp.id('biz A'), pg_temp.id('loc A'), :t) $$),
  (30, 'purchase_payments', 'purchase_id', 'pur credit', 'a payment and its purchase', $$
    insert into app.purchase_payments (id, business_id, purchase_id, business_date, method, amount, currency)
    values (pg_temp.id('t'), pg_temp.id('biz A'), :t, current_date, 'cash', 1, 'AED') $$),
  (31, 'expenses', 'category_id', 'cat', 'an expense and its category', $$
    insert into app.expenses (id, business_id, category_id, location_id, business_date, document_type,
                              payment_method, currency, amount, net_total, vat_total, total)
    values (pg_temp.id('t'), pg_temp.id('biz A'), :t, pg_temp.id('loc A'), current_date, 'no_invoice', 'cash',
            'AED', 10, 10, 0, 10) $$),
  (32, 'expenses', 'supplier_id', 'sup', 'an expense and its supplier', $$
    insert into app.expenses (id, business_id, category_id, supplier_id, location_id, business_date,
                              document_type, payment_method, currency, amount, net_total, vat_total, total)
    values (pg_temp.id('t'), pg_temp.id('biz A'), pg_temp.id('cat A'), :t, pg_temp.id('loc A'), current_date,
            'no_invoice', 'cash', 'AED', 10, 10, 0, 10) $$),
  (33, 'expenses', 'location_id', 'loc', 'an expense and its location', $$
    insert into app.expenses (id, business_id, category_id, location_id, business_date, document_type,
                              payment_method, currency, amount, net_total, vat_total, total)
    values (pg_temp.id('t'), pg_temp.id('biz A'), pg_temp.id('cat A'), :t, current_date, 'no_invoice', 'cash',
            'AED', 10, 10, 0, 10) $$),
  (34, 'expenses', 'paid_by_member_id', 'biz owner member', 'an expense and the member who paid', $$
    insert into app.expenses (id, business_id, category_id, location_id, business_date, document_type,
                              payment_method, paid_by_member_id, currency, amount, net_total, vat_total, total)
    values (pg_temp.id('t'), pg_temp.id('biz A'), pg_temp.id('cat A'), pg_temp.id('loc A'), current_date,
            'no_invoice', 'paid_by_member', :t, 'AED', 10, 10, 0, 10) $$),
  (35, 'expenses', 'copied_from_id', 'exp', 'a corrected copy and the expense it replaces', $$
    insert into app.expenses (id, business_id, category_id, location_id, business_date, document_type,
                              payment_method, currency, amount, net_total, vat_total, total, copied_from_id)
    values (pg_temp.id('t'), pg_temp.id('biz A'), pg_temp.id('cat A'), pg_temp.id('loc A'), current_date,
            'no_invoice', 'cash', 'AED', 10, 10, 0, 10, :t) $$),
  (36, 'expense_payments', 'expense_id', 'exp credit', 'a payment and its expense', $$
    insert into app.expense_payments (id, business_id, expense_id, business_date, method, amount, currency)
    values (pg_temp.id('t'), pg_temp.id('biz A'), :t, current_date, 'cash', 1, 'AED') $$),
  (37, 'running_costs', 'category_id', 'cat', 'a running cost and its category', $$
    insert into app.running_costs (id, business_id, name, category_id, amount, starts_on)
    values (pg_temp.id('t'), pg_temp.id('biz A'), 'Water', :t, 100, current_date) $$),
  (38, 'attachments', 'entity_id', 'pur', 'a receipt and its purchase (check_target)', $$
    insert into app.attachments (id, business_id, entity, entity_id, path, file_name, content_type, size_bytes)
    values (pg_temp.id('t'), pg_temp.id('biz A'), 'purchase', :t, pg_temp.id('biz A') || '/purchase/t.png',
            'r.png', 'image/png', 10) $$),
  (39, 'attachments', 'entity_id', 'exp', 'a receipt and its expense (check_target)', $$
    insert into app.attachments (id, business_id, entity, entity_id, path, file_name, content_type, size_bytes)
    values (pg_temp.id('t'), pg_temp.id('biz A'), 'expense', :t, pg_temp.id('biz A') || '/expense/t.png',
            'r.png', 'image/png', 10) $$),
  (40, 'expenses', 'running_cost_id', 'run', 'an expense and the running cost it pays (D-216)', $$
    insert into app.expenses (id, business_id, category_id, location_id, business_date, document_type,
                              payment_method, currency, amount, net_total, vat_total, total, pays,
                              running_cost_id)
    values (pg_temp.id('t'), pg_temp.id('biz A'), pg_temp.id('cat A'), pg_temp.id('loc A'), current_date,
            'no_invoice', 'cash', 'AED', 10, 10, 0, 10, 'running_cost', :t) $$),
  (41, 'expenses', 'channel_id', 'chan', 'an expense and the channel whose app fees it pays (M3 Step 3)', $$
    insert into app.expenses (id, business_id, category_id, location_id, business_date, document_type,
                              payment_method, currency, amount, net_total, vat_total, total, pays,
                              channel_id)
    values (pg_temp.id('t'), pg_temp.id('biz A'), pg_temp.id('cat A'), pg_temp.id('loc A'), current_date,
            'no_invoice', 'cash', 'AED', 10, 10, 0, 10, 'channel_fees', :t) $$);

-- The target's id: `<target> A` / `<target> B` ('biz owner member' becomes 'biz A owner member').
create function pg_temp.target(p_target text, p_side text)
returns text language sql immutable
as $$
  select format('pg_temp.id(%L)',
                case when p_target like 'biz %' then replace(p_target, 'biz ', 'biz ' || p_side || ' ')
                     else p_target || ' ' || p_side end)
$$;

select is(
  pg_temp.state_of(pg_temp.api_run('user A', 'biz A', replace(l.stmt, ':t', pg_temp.target(l.target, s.side)), true)),
  case s.side when 'A' then 'ok 1' else '23503' end,
  l.child || '.' || l.cols || ' — ' || l.what || case s.side when 'A' then ': its own business''s row' else ': never another business''s row' end
)
  from links l
 cross join (values (1, 'A'), (2, 'B')) as s(k, side)
 order by l.n, s.k;

-- Every foreign key of an M2 table (but business_id → businesses) is tried above, and nothing else.
create temp view m2_tables as
  select unnest(array[
    'materials', 'material_units', 'products_services', 'product_locations', 'suppliers', 'purchases',
    'purchase_lines', 'purchase_returns', 'purchase_return_lines', 'stock_movements', 'material_costs',
    'stock_balances', 'attachments', 'recipes', 'recipe_lines', 'purchase_payments', 'cost_categories',
    'expenses', 'expense_payments', 'running_costs'
  ]) as table_name;

select is_empty(
  $$ (select c.conrelid::regclass::text as child,
             (select string_agg(a.attname, ',' order by k.i)
                from unnest(c.conkey) with ordinality as k(attnum, i)
                join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
               where a.attname <> 'business_id') as cols
        from pg_constraint c
       where c.contype = 'f'
         and c.conrelid in (select to_regclass('app.' || table_name) from m2_tables)
         and c.confrelid <> 'app.businesses'::regclass
      except
      select 'app.' || child, cols from links)
     union all
     (select 'app.' || child, cols from links where child <> 'attachments'
      except
      select c.conrelid::regclass::text,
             (select string_agg(a.attname, ',' order by k.i)
                from unnest(c.conkey) with ordinality as k(attnum, i)
                join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
               where a.attname <> 'business_id')
        from pg_constraint c
       where c.contype = 'f' and c.confrelid <> 'app.businesses'::regclass) $$,
  'every foreign key of an M2 table is tried across businesses above, and every link tried is a foreign key'
);

-- 3. Structure of the M2 tables and the SECURITY DEFINER functions (5) ----------------------------

select is_empty(
  $$ select m.table_name
       from m2_tables m
       left join pg_class c on c.oid = to_regclass('app.' || m.table_name)
       left join pg_attribute a on a.attrelid = c.oid and a.attname = 'business_id' and not a.attisdropped
      where c.oid is null or a.attnum is null or not a.attnotnull
         or not c.relrowsecurity or not c.relforcerowsecurity $$,
  'every M2 table has business_id NOT NULL and ENABLE + FORCE row level security'
);

select is_empty(
  $$ select m.table_name, p.polname
       from m2_tables m
       left join pg_policy p on p.polrelid = to_regclass('app.' || m.table_name)
      where p.polname is distinct from 'tenant_isolation'
         or p.polcmd <> '*' or not p.polpermissive
         or p.polroles <> array[(select oid from pg_roles where rolname = 'bizcost_api')]
         or (select count(*) from pg_policy q where q.polrelid = p.polrelid) <> 1 $$,
  'every M2 table has exactly one policy: tenant_isolation, permissive FOR ALL, for bizcost_api only'
);

select is_empty(
  $$ select tablename
       from pg_policies
      where schemaname = 'app'
        and tablename in (select table_name from m2_tables)
        and not (strpos(coalesce(qual, ''), 'business_id = ( SELECT app.current_business_id()') > 0
                 and strpos(coalesce(qual, ''), '( SELECT app.is_active_member(app.current_business_id())') > 0
                 and coalesce(qual, '') !~ 'is_active_member\(business_id'
                 and coalesce(with_check, qual) = qual) $$,
  'the M2 policies use the InitPlan predicate (no row column passed to a function) for USING and WITH CHECK'
);

select is(
  (select array_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text)
     from pg_proc p
    where p.pronamespace = 'app'::regnamespace and p.prosecdef),
  array[
    'app.accept_invitation(text,uuid)',
    'app.anonymize_my_memberships(text)',
    'app.audit_row()',
    'app.create_business(uuid,text,text,text,uuid,uuid)',
    'app.enforce_active_owner()',
    'app.file_upload_limits()',
    'app.guard_business_file()',
    'app.invitation_limits()',
    'app.is_active_member(uuid)',
    'app.my_business_ids()',
    'app.preview_invitation(text)'
  ],
  'the SECURITY DEFINER functions of app are exactly the known ones: the Costing Core added none (its triggers run as the caller)'
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

select * from finish();
rollback;

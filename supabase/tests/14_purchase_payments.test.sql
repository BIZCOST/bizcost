-- pgTAP: how purchases are paid, what they leave owed and its payments, and material names compared
-- the way people read them (the owner's requests of 2026-09-29). Two businesses, each with its owner.
-- As bizcost_api, like the API: app.name_key gives the key of @bizcost/domain's nameKey and the unique
-- index of material names is on it; a purchase bought on credit names its supplier, one paid by a
-- member names a member of its own business; a payment is recorded only on a posted purchase that is
-- owed, is never edited or deleted (only reversed, once), never crosses businesses, and a purchase
-- with payments that stand is not reversed; the audit trigger runs. RLS, the policy, the triggers and
-- the grants of purchase_payments are also checked generically by 00_catalog_coverage, 01_grants and
-- 03_rls_initplan.
begin;
select plan(49);

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

insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', pg_temp.id(u.name), 'authenticated', 'authenticated',
       u.email, now(), '{}', '{}', now(), now()
  from (values ('user A', 'amal@example.test'), ('user B', 'bilal@example.test')) as u(name, email);

-- 1. Columns (3) --------------------------------------------------------------------------------

select col_type_is('app', 'purchase_payments', 'amount', 'numeric(20,4)',
                   'purchase_payments.amount is numeric(20,4): a document amount');
select col_default_is('app', 'purchases', 'prices_include_vat', 'false',
                      'purchases.prices_include_vat is off unless the prices were typed with VAT');
select col_is_null('app', 'purchases', 'payment_method',
                   'purchases.payment_method may be null: purchases posted before it was required');

-- 2. app.name_key (11) --------------------------------------------------------------------------

select is(app.name_key(v.name), v.key, 'name_key(' || v.name || ') = ' || v.key)
  from (values
    ('  Brown   SUGAR ', 'brown sugar'),
    ('سُكَّر', 'سكر'),
    ('إسفنج', 'اسفنج'),
    ('قهوة', 'قهوه'),
    ('حلوى', 'حلوي'),
    ('طحيـــنة', 'طحينه'),
    ('كوب ١٢ ۱۲', 'كوب 12 12'),
    -- migration name_key_unicode: a bidi mark inside, presentation forms, Persian letters, NFKC
    (U&'Sug\200Ear', 'sugar'),
    (U&'\FEB3\FEDC\FEAE', 'سكر'),
    (U&'\0628\06CC\062A \06A9\0631\064A\0645', 'بيت كريم'),
    (U&'Cafe\0301', U&'caf\00E9')
  ) as v(name, key);

-- 3. Fixtures (11) ------------------------------------------------------------------------------

select is(
  pg_temp.api_value(v.who, null, format(
    $$ select app.create_business(pg_temp.id(%L), %L, 'en', 'Owner', pg_temp.id(%L), pg_temp.id(%L)) $$,
    v.biz, v.name, v.biz || ' owner role', v.biz || ' owner member')),
  pg_temp.id(v.biz)::text,
  'setup: ' || v.who || ' creates ' || v.biz
)
  from (values ('user A', 'biz A', 'Alpha Bakery'), ('user B', 'biz B', 'Beta Bakery')) as v(who, biz, name);

select is(pg_temp.api_exec(v.who, v.biz, v.stmt), 'ok 1', 'setup: ' || v.what)
  from (values
    ('user A', 'biz A', 'a location of A', $$
      insert into app.locations (id, business_id, name, is_default)
      values (pg_temp.id('loc A'), pg_temp.id('biz A'), 'Main', true) $$),
    ('user B', 'biz B', 'a location of B', $$
      insert into app.locations (id, business_id, name, is_default)
      values (pg_temp.id('loc B'), pg_temp.id('biz B'), 'Main', true) $$),
    ('user A', 'biz A', 'a supplier of A', $$
      insert into app.suppliers (id, business_id, name)
      values (pg_temp.id('sup A'), pg_temp.id('biz A'), 'Mill') $$),
    ('user A', 'biz A', 'sugar in A', $$
      insert into app.materials (id, business_id, name, dimension, unit)
      values (pg_temp.id('mat A'), pg_temp.id('biz A'), 'سكر', 'mass', 'kg') $$),
    ('user A', 'biz A', 'a final purchase of A bought on credit (105)', $$
      insert into app.purchases (id, business_id, supplier_id, location_id, business_date,
                                 document_type, payment_method, currency, status, total,
                                 vat_in_cost, cost_total, posted_at, posted_by)
      values (pg_temp.id('pur credit'), pg_temp.id('biz A'), pg_temp.id('sup A'), pg_temp.id('loc A'),
              current_date, 'tax_invoice', 'supplier_credit', 'AED', 'posted', 105,
              false, 100, now(), pg_temp.id('user A')) $$),
    ('user A', 'biz A', 'a second one, paid by the owner from their own money', $$
      insert into app.purchases (id, business_id, location_id, business_date, document_type,
                                 payment_method, paid_by_member_id, currency, status, total,
                                 vat_in_cost, cost_total, posted_at, posted_by)
      values (pg_temp.id('pur member'), pg_temp.id('biz A'), pg_temp.id('loc A'), current_date,
              'no_invoice', 'paid_by_member', pg_temp.id('biz A owner member'), 'AED', 'posted', 50,
              true, 50, now(), pg_temp.id('user A')) $$),
    ('user A', 'biz A', 'a final purchase of A paid in cash', $$
      insert into app.purchases (id, business_id, location_id, business_date, document_type,
                                 payment_method, currency, status, total, vat_in_cost, cost_total,
                                 posted_at, posted_by)
      values (pg_temp.id('pur cash'), pg_temp.id('biz A'), pg_temp.id('loc A'), current_date,
              'no_invoice', 'cash', 'AED', 'posted', 20, true, 20, now(), pg_temp.id('user A')) $$),
    ('user A', 'biz A', 'a draft of A bought on credit', $$
      insert into app.purchases (id, business_id, supplier_id, location_id, business_date,
                                 document_type, payment_method, currency)
      values (pg_temp.id('pur draft'), pg_temp.id('biz A'), pg_temp.id('sup A'), pg_temp.id('loc A'),
              current_date, 'no_invoice', 'supplier_credit', 'AED') $$),
    ('user A', 'biz A', 'a payment of 40 on the purchase bought on credit', $$
      insert into app.purchase_payments (id, business_id, purchase_id, business_date, method, amount, currency)
      values (pg_temp.id('pay 1'), pg_temp.id('biz A'), pg_temp.id('pur credit'), current_date,
              'bank_transfer', 40, 'AED') $$)
  ) as v(who, biz, what, stmt);

-- 4. One material name per business, the way people read it (3) -------------------------------

select is(
  pg_temp.state_of(pg_temp.api_exec(v.who, v.biz, format($$
    insert into app.materials (id, business_id, name, dimension, unit)
    values (pg_temp.id(%L), pg_temp.id(%L), %L, 'mass', 'kg') $$, v.id, v.biz, v.name))),
  v.state,
  v.what
)
  from (values
    ('user A', 'biz A', 'm1', 'سُكَّر', '23505', 'sugar with its marks is the same name as sugar'),
    ('user A', 'biz A', 'm2', '  سكر ', '23505', 'sugar with spaces around is the same name'),
    ('user B', 'biz B', 'm3', 'سُكَّر', 'ok 1', 'another business may have the name')
  ) as v(who, biz, id, name, state, what);

-- 5. Who paid goes with how it was paid (5) ---------------------------------------------------

select is(
  pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', format($$
    insert into app.purchases (id, business_id, supplier_id, location_id, business_date,
                               document_type, payment_method, paid_by_member_id, currency)
    values (pg_temp.id(%L), pg_temp.id('biz A'), %s, pg_temp.id('loc A'), current_date,
            'no_invoice', %L, %s, 'AED') $$, v.id, v.supplier, v.method, v.member))),
  v.state,
  v.what
)
  from (values
    ('p1', 'null', 'supplier_credit', 'null', '23514', 'bought on credit needs its supplier'),
    ('p2', 'null', 'paid_by_member', 'null', '23514', 'paid by a member names the member'),
    ('p3', 'null', 'cash', $x$pg_temp.id('biz A owner member')$x$, '23514',
     'a member is named only when the member paid'),
    ('p4', 'null', 'paid_by_member', $x$pg_temp.id('biz B owner member')$x$, '23503',
     'the member who paid is a member of the purchase''s own business'),
    ('p5', 'null', 'bitcoin', 'null', '23514', 'the payment method is one of the list')
  ) as v(id, supplier, method, member, state, what);

-- 6. Payments: recorded on a final purchase that is owed, never edited, only reversed (13) ------

select is(
  pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', format($$
    insert into app.purchase_payments (id, business_id, purchase_id, business_date, method, amount,
                                       currency, reversed_at, reversed_by, reversal_date)
    values (pg_temp.id(%L), pg_temp.id('biz A'), pg_temp.id(%L), current_date, %L, %s, 'AED',
            %s, %s, %s) $$, v.id, v.purchase, v.method, v.amount, v.reversed, v.reversed_by,
            v.reversal_date))),
  v.state,
  v.what
)
  from (values
    ('q1', 'pur member', 'cash', '10', 'null', 'null', 'null', 'ok 1',
     'a payment to the member who paid'),
    ('q2', 'pur cash', 'cash', '1', 'null', 'null', 'null', '23514',
     'nothing is owed on a purchase paid in cash'),
    ('q3', 'pur draft', 'cash', '1', 'null', 'null', 'null', '23514',
     'nothing is owed on a draft'),
    ('q4', 'pur credit', 'cash', '1', 'now()', $x$pg_temp.id('user A')$x$, 'current_date', '23514',
     'a new payment stands (it is not recorded reversed)'),
    ('q5', 'pur credit', 'other', '1', 'null', 'null', 'null', '23514',
     'a payment is cash, card, bank transfer or cheque'),
    ('q6', 'pur credit', 'cash', '0', 'null', 'null', 'null', '23514', 'a payment is more than zero')
  ) as v(id, purchase, method, amount, reversed, reversed_by, reversal_date, state, what);

select is(
  pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', v.stmt)),
  v.state,
  v.what
)
  from (values
    ('23001', 'a payment''s amount never changes', $$
      update app.purchase_payments set amount = 1 where id = pg_temp.id('pay 1') $$),
    ('23001', 'a payment is never taken out by soft delete', $$
      update app.purchase_payments set deleted_at = now() where id = pg_temp.id('pay 1') $$),
    ('23001', 'a payment is never deleted', $$
      delete from app.purchase_payments where id = pg_temp.id('pay 1') $$),
    ('23514', 'a purchase with a payment that stands is not reversed', $$
      update app.purchases set status = 'reversed', reversed_at = now(),
             reversed_by = pg_temp.id('user A'), reversal_date = current_date
       where id = pg_temp.id('pur credit') $$),
    ('ok 1', 'a payment is reversed (recorded by mistake)', $$
      update app.purchase_payments
         set reversed_at = now(), reversed_by = pg_temp.id('user A'), reversal_date = current_date
       where id = pg_temp.id('pay 1') $$),
    ('23001', 'a reversed payment stays as it is', $$
      update app.purchase_payments set reversal_date = current_date + 1 where id = pg_temp.id('pay 1') $$)
  ) as v(state, what, stmt);

select is(
  pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', $$
    update app.purchases set status = 'reversed', reversed_at = now(),
           reversed_by = pg_temp.id('user A'), reversal_date = current_date
     where id = pg_temp.id('pur credit') $$)),
  'ok 1',
  'once its payments are reversed, the purchase is'
);

-- 7. Across businesses (2) ----------------------------------------------------------------------

select is(
  pg_temp.state_of(pg_temp.api_exec('user B', 'biz B', $$
    insert into app.purchase_payments (id, business_id, purchase_id, business_date, method, amount, currency)
    values (pg_temp.id('x1'), pg_temp.id('biz B'), pg_temp.id('pur member'), current_date, 'cash', 1, 'AED') $$)),
  '23503',
  'a payment of B cannot be for a purchase of A'
);

select is(
  pg_temp.api_value('user B', 'biz B', $$ select count(*)::text from app.purchase_payments $$),
  '0',
  'user B sees none of A''s payments'
);

-- 8. The audit (1) ----------------------------------------------------------------------------------

select ok(
  (select count(*) from app.audit_log
    where business_id = pg_temp.id('biz A') and entity = 'purchase_payments'
      and entity_id = pg_temp.id('pay 1')) = 2,
  'the payment and its reversal are in the audit log'
);

select * from finish();
rollback;

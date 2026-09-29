-- pgTAP: expenses, their payments, running costs and the categories they share (M2 Step 5). Two
-- businesses, each with its owner. As bizcost_api, like the API: one category name per business the
-- way people read it; an expense names a category, supplier, location and member of its own business,
-- says how it was paid (on credit with its supplier, paid by a member naming them) and keeps its
-- totals whole; an expense under review is frozen and a posted one only becomes reversed (the
-- approval rules, D-164); a payment is recorded only on a posted expense that is owed, is never edited
-- or deleted, and an expense with payments that stand is not reversed; a running cost's dates run
-- forward; receipts attach to a live expense of the same business; nothing crosses businesses; the
-- audit trigger runs. RLS, the policy, the triggers and the grants of the new tables are also checked
-- generically by 00_catalog_coverage, 01_grants and 03_rls_initplan.
begin;
select plan(74);

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

-- An expense of A with the given id, status and columns (a posted one has its posting columns).
create function pg_temp.expense_sql(p_id text, p_status text, p_method text, p_extra text)
returns text language sql immutable
as $$
  select format($f$
    insert into app.expenses (id, business_id, category_id, supplier_id, location_id, business_date,
                              document_type, payment_method, currency, amount, vat_rate, net_total,
                              vat_total, total, status, submitted_at, submitted_by, approved_at,
                              approved_by, vat_in_cost, cost_total, posted_at, posted_by %s)
    values (pg_temp.id(%L), pg_temp.id('biz A'), pg_temp.id('cat rent A'), pg_temp.id('sup A'),
            pg_temp.id('loc A'), current_date, 'tax_invoice', %L, 'AED', 105, 5, 100, 5, 105, %L,
            %s, %s, %s, %s, %s, %s, %s, %s %s) $f$,
    case when p_extra = '' then '' else ', notes' end,
    p_id, p_method, p_status,
    case when p_status in ('submitted', 'approved', 'posted') then 'now()' else 'null' end,
    case when p_status in ('submitted', 'approved', 'posted') then $x$pg_temp.id('user A')$x$ else 'null' end,
    case when p_status in ('approved', 'posted') then 'now()' else 'null' end,
    case when p_status in ('approved', 'posted') then $x$pg_temp.id('user A')$x$ else 'null' end,
    case when p_status = 'posted' then 'false' else 'null' end,
    case when p_status = 'posted' then '100' else 'null' end,
    case when p_status = 'posted' then 'now()' else 'null' end,
    case when p_status = 'posted' then $x$pg_temp.id('user A')$x$ else 'null' end,
    case when p_extra = '' then '' else ', ' || quote_literal(p_extra) end)
$$;

insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', pg_temp.id(u.name), 'authenticated', 'authenticated',
       u.email, now(), '{}', '{}', now(), now()
  from (values ('user A', 'amal@example.test'), ('user B', 'bilal@example.test')) as u(name, email);

-- 1. Columns (4) --------------------------------------------------------------------------------

select col_type_is('app', 'expenses', 'amount', 'numeric(20,4)',
                   'expenses.amount is numeric(20,4): a document amount');
select col_type_is('app', 'running_costs', 'amount', 'numeric(20,4)',
                   'running_costs.amount is numeric(20,4)');
select col_default_is('app', 'businesses', 'expense_approval', 'false',
                      'businesses.expense_approval is off by default');
select col_not_null('app', 'expenses', 'payment_method',
                    'expenses.payment_method is required from the start');

-- 2. Fixtures (12) ------------------------------------------------------------------------------

select is(
  pg_temp.api_value(v.who, null, format(
    $$ select app.create_business(pg_temp.id(%L), %L, 'en', 'Owner', pg_temp.id(%L), pg_temp.id(%L)) $$,
    v.biz, v.name, v.biz || ' owner role', v.biz || ' owner member')),
  pg_temp.id(v.biz)::text,
  'setup: ' || v.who || ' creates ' || v.biz
)
  from (values ('user A', 'biz A', 'Alpha Studio'), ('user B', 'biz B', 'Beta Studio')) as v(who, biz, name);

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
      values (pg_temp.id('sup A'), pg_temp.id('biz A'), 'Landlord') $$),
    ('user A', 'biz A', 'the category Rent of A, in Arabic', $$
      insert into app.cost_categories (id, business_id, name)
      values (pg_temp.id('cat rent A'), pg_temp.id('biz A'), 'الإيجار') $$),
    ('user B', 'biz B', 'a category of B', $$
      insert into app.cost_categories (id, business_id, name)
      values (pg_temp.id('cat B'), pg_temp.id('biz B'), 'Rent') $$),
    ('user A', 'biz A', 'a draft expense of A', pg_temp.expense_sql('exp draft', 'draft', 'cash', '')),
    ('user A', 'biz A', 'an expense of A sent for approval', pg_temp.expense_sql('exp sent', 'submitted', 'cash', '')),
    ('user A', 'biz A', 'an approved expense of A', pg_temp.expense_sql('exp approved', 'approved', 'cash', '')),
    ('user A', 'biz A', 'a posted expense of A bought on credit', pg_temp.expense_sql('exp credit', 'posted', 'supplier_credit', '')),
    ('user A', 'biz A', 'a posted expense of A paid in cash', pg_temp.expense_sql('exp cash', 'posted', 'cash', ''))
  ) as v(who, biz, what, stmt);

-- 3. One category name per business, the way people read it (4) --------------------------------

select is(
  pg_temp.state_of(pg_temp.api_exec(v.who, v.biz, format($$
    insert into app.cost_categories (id, business_id, name, archived_at)
    values (pg_temp.id(%L), pg_temp.id(%L), %L, %s) $$, v.id, v.biz, v.name, v.archived))),
  v.state,
  v.what
)
  from (values
    ('user A', 'biz A', 'c1', 'الايجار', 'null', '23505', 'rent without its hamza is the same name'),
    ('user A', 'biz A', 'c2', ' الإيجار ', 'null', '23505', 'rent with spaces around is the same name'),
    ('user A', 'biz A', 'c3', 'Electricity', 'now()', 'ok 1', 'an archived category'),
    ('user A', 'biz A', 'c4', 'ELECTRICITY', 'null', '23505', 'an archived name still counts')
  ) as v(who, biz, id, name, archived, state, what);

-- 4. What an expense names and says (11) --------------------------------------------------------

select is(
  pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', v.stmt)),
  v.state,
  v.what
)
  from (values
    ('23514', 'bought on credit needs its supplier', $$
      insert into app.expenses (id, business_id, category_id, location_id, business_date,
                                document_type, payment_method, currency, amount, net_total,
                                vat_total, total)
      values (pg_temp.id('e1'), pg_temp.id('biz A'), pg_temp.id('cat rent A'), pg_temp.id('loc A'),
              current_date, 'no_invoice', 'supplier_credit', 'AED', 10, 10, 0, 10) $$),
    ('23514', 'paid by a member names the member', $$
      insert into app.expenses (id, business_id, category_id, location_id, business_date,
                                document_type, payment_method, currency, amount, net_total,
                                vat_total, total)
      values (pg_temp.id('e2'), pg_temp.id('biz A'), pg_temp.id('cat rent A'), pg_temp.id('loc A'),
              current_date, 'no_invoice', 'paid_by_member', 'AED', 10, 10, 0, 10) $$),
    ('23503', 'the member who paid is a member of its own business', $$
      insert into app.expenses (id, business_id, category_id, location_id, business_date,
                                document_type, payment_method, paid_by_member_id, currency, amount,
                                net_total, vat_total, total)
      values (pg_temp.id('e3'), pg_temp.id('biz A'), pg_temp.id('cat rent A'), pg_temp.id('loc A'),
              current_date, 'no_invoice', 'paid_by_member', pg_temp.id('biz B owner member'), 'AED',
              10, 10, 0, 10) $$),
    ('23503', 'its category is one of its own business', $$
      insert into app.expenses (id, business_id, category_id, location_id, business_date,
                                document_type, payment_method, currency, amount, net_total,
                                vat_total, total)
      values (pg_temp.id('e4'), pg_temp.id('biz A'), pg_temp.id('cat B'), pg_temp.id('loc A'),
              current_date, 'no_invoice', 'cash', 'AED', 10, 10, 0, 10) $$),
    ('23503', 'its location is one of its own business', $$
      insert into app.expenses (id, business_id, category_id, location_id, business_date,
                                document_type, payment_method, currency, amount, net_total,
                                vat_total, total)
      values (pg_temp.id('e5'), pg_temp.id('biz A'), pg_temp.id('cat rent A'), pg_temp.id('loc B'),
              current_date, 'no_invoice', 'cash', 'AED', 10, 10, 0, 10) $$),
    ('23514', 'its total is its net and its VAT', $$
      insert into app.expenses (id, business_id, category_id, location_id, business_date,
                                document_type, payment_method, currency, amount, net_total,
                                vat_total, total)
      values (pg_temp.id('e6'), pg_temp.id('biz A'), pg_temp.id('cat rent A'), pg_temp.id('loc A'),
              current_date, 'no_invoice', 'cash', 'AED', 10, 10, 1, 10) $$),
    ('23514', 'its amount is more than zero', $$
      insert into app.expenses (id, business_id, category_id, location_id, business_date,
                                document_type, payment_method, currency, amount, net_total,
                                vat_total, total)
      values (pg_temp.id('e7'), pg_temp.id('biz A'), pg_temp.id('cat rent A'), pg_temp.id('loc A'),
              current_date, 'no_invoice', 'cash', 'AED', 0, 0, 0, 0) $$),
    ('23514', 'a status of the list', $$
      insert into app.expenses (id, business_id, category_id, location_id, business_date,
                                document_type, payment_method, currency, amount, net_total,
                                vat_total, total, status)
      values (pg_temp.id('e8'), pg_temp.id('biz A'), pg_temp.id('cat rent A'), pg_temp.id('loc A'),
              current_date, 'no_invoice', 'cash', 'AED', 10, 10, 0, 10, 'paid') $$),
    ('23514', 'sent for approval says when and by whom', $$
      insert into app.expenses (id, business_id, category_id, location_id, business_date,
                                document_type, payment_method, currency, amount, net_total,
                                vat_total, total, status)
      values (pg_temp.id('e9'), pg_temp.id('biz A'), pg_temp.id('cat rent A'), pg_temp.id('loc A'),
              current_date, 'no_invoice', 'cash', 'AED', 10, 10, 0, 10, 'submitted') $$),
    ('23514', 'posted says when, by whom and what it cost', $$
      insert into app.expenses (id, business_id, category_id, location_id, business_date,
                                document_type, payment_method, currency, amount, net_total,
                                vat_total, total, status, posted_at, posted_by)
      values (pg_temp.id('e10'), pg_temp.id('biz A'), pg_temp.id('cat rent A'), pg_temp.id('loc A'),
              current_date, 'no_invoice', 'cash', 'AED', 10, 10, 0, 10, 'posted', now(),
              pg_temp.id('user A')) $$),
    ('23514', 'a rejection reason goes with a rejection', $$
      insert into app.expenses (id, business_id, category_id, location_id, business_date,
                                document_type, payment_method, currency, amount, net_total,
                                vat_total, total, rejection_reason)
      values (pg_temp.id('e11'), pg_temp.id('biz A'), pg_temp.id('cat rent A'), pg_temp.id('loc A'),
              current_date, 'no_invoice', 'cash', 'AED', 10, 10, 0, 10, 'no receipt') $$)
  ) as v(state, what, stmt);

-- 5. The approval rules and a posted expense (16) ------------------------------------------------

select is(
  pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', v.stmt)),
  v.state,
  v.what
)
  from (values
    ('23514', 'a draft is not approved without being sent', $$
      update app.expenses set status = 'approved', approved_at = now(), approved_by = pg_temp.id('user A')
       where id = pg_temp.id('exp draft') $$),
    ('23514', 'a draft is not reversed', $$
      update app.expenses set status = 'reversed', reversed_at = now(),
             reversed_by = pg_temp.id('user A'), reversal_date = current_date
       where id = pg_temp.id('exp draft') $$),
    ('ok 1', 'a draft changes', $$
      update app.expenses set amount = 210, net_total = 200, vat_total = 10, total = 210
       where id = pg_temp.id('exp draft') $$),
    ('23001', 'an expense sent for approval keeps its amounts', $$
      update app.expenses set amount = 1, net_total = 1, vat_total = 0, total = 1
       where id = pg_temp.id('exp sent') $$),
    ('23001', 'an expense sent for approval keeps what it says', $$
      update app.expenses set description = 'changed' where id = pg_temp.id('exp sent') $$),
    ('23001', 'an expense sent for approval is not discarded', $$
      update app.expenses set deleted_at = now() where id = pg_temp.id('exp sent') $$),
    ('ok 1', 'an expense sent for approval is approved', $$
      update app.expenses set status = 'approved', approved_at = now(), approved_by = pg_temp.id('user A')
       where id = pg_temp.id('exp sent') $$),
    ('23001', 'an approved expense keeps its amounts', $$
      update app.expenses set amount = 1, net_total = 1, vat_total = 0, total = 1
       where id = pg_temp.id('exp approved') $$),
    ('23001', 'an approved expense is not sent back to approval', $$
      update app.expenses set status = 'submitted' where id = pg_temp.id('exp approved') $$),
    ('ok 1', 'an approved expense is rejected (sent back)', $$
      update app.expenses set status = 'rejected', rejected_at = now(), rejected_by = pg_temp.id('user A'),
             rejection_reason = 'wrong month', approved_at = null, approved_by = null
       where id = pg_temp.id('exp approved') $$),
    ('ok 1', 'a rejected expense is edited like a draft', $$
      update app.expenses set status = 'draft', amount = 52.5, net_total = 50, vat_total = 2.5,
             total = 52.5
       where id = pg_temp.id('exp approved') $$),
    ('ok 1', 'an approved expense is posted', $$
      update app.expenses set status = 'posted', vat_in_cost = false, cost_total = 100,
             posted_at = now(), posted_by = pg_temp.id('user A')
       where id = pg_temp.id('exp sent') $$),
    ('23001', 'a posted expense keeps its amounts', $$
      update app.expenses set amount = 1, net_total = 1, vat_total = 0, total = 1
       where id = pg_temp.id('exp cash') $$),
    ('ok 1', 'a posted expense is reversed', $$
      update app.expenses set status = 'reversed', reversed_at = now(),
             reversed_by = pg_temp.id('user A'), reversal_date = current_date
       where id = pg_temp.id('exp cash') $$),
    ('23001', 'a reversed expense stays as it is', $$
      update app.expenses set notes = 'x' where id = pg_temp.id('exp cash') $$),
    ('23001', 'an expense is never deleted', $$
      delete from app.expenses where id = pg_temp.id('exp draft') $$)
  ) as v(state, what, stmt);

-- 6. Payments: on a posted expense that is owed, never edited, only reversed (12) ---------------

select is(
  pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', format($$
    insert into app.expense_payments (id, business_id, expense_id, business_date, method, amount,
                                      currency, reversed_at, reversed_by, reversal_date)
    values (pg_temp.id(%L), pg_temp.id('biz A'), pg_temp.id(%L), current_date, %L, %s, 'AED',
            %s, %s, %s) $$, v.id, v.expense, v.method, v.amount, v.reversed, v.reversed_by,
            v.reversal_date))),
  v.state,
  v.what
)
  from (values
    ('pay 1', 'exp credit', 'bank_transfer', '40', 'null', 'null', 'null', 'ok 1',
     'a payment to the supplier of an expense bought on credit'),
    ('q2', 'exp cash', 'cash', '1', 'null', 'null', 'null', '23514',
     'nothing is owed on an expense paid in cash'),
    ('q3', 'exp draft', 'cash', '1', 'null', 'null', 'null', '23514',
     'nothing is owed on a draft'),
    ('q4', 'exp credit', 'cash', '1', 'now()', $x$pg_temp.id('user A')$x$, 'current_date', '23514',
     'a new payment stands (it is not recorded reversed)'),
    ('q5', 'exp credit', 'other', '1', 'null', 'null', 'null', '23514',
     'a payment is cash, card, bank transfer or cheque')
  ) as v(id, expense, method, amount, reversed, reversed_by, reversal_date, state, what);

select is(
  pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', v.stmt)),
  v.state,
  v.what
)
  from (values
    ('23001', 'a payment''s amount never changes', $$
      update app.expense_payments set amount = 1 where id = pg_temp.id('pay 1') $$),
    ('23001', 'a payment is never taken out by soft delete', $$
      update app.expense_payments set deleted_at = now() where id = pg_temp.id('pay 1') $$),
    ('23001', 'a payment is never deleted', $$
      delete from app.expense_payments where id = pg_temp.id('pay 1') $$),
    ('23514', 'an expense with a payment that stands is not reversed', $$
      update app.expenses set status = 'reversed', reversed_at = now(),
             reversed_by = pg_temp.id('user A'), reversal_date = current_date
       where id = pg_temp.id('exp credit') $$),
    ('ok 1', 'a payment is reversed (recorded by mistake)', $$
      update app.expense_payments
         set reversed_at = now(), reversed_by = pg_temp.id('user A'), reversal_date = current_date
       where id = pg_temp.id('pay 1') $$),
    ('23001', 'a reversed payment stays as it is', $$
      update app.expense_payments set reversal_date = current_date + 1 where id = pg_temp.id('pay 1') $$),
    ('ok 1', 'once its payments are reversed, the expense is', $$
      update app.expenses set status = 'reversed', reversed_at = now(),
             reversed_by = pg_temp.id('user A'), reversal_date = current_date
       where id = pg_temp.id('exp credit') $$)
  ) as v(state, what, stmt);

-- 7. Running costs (6) ----------------------------------------------------------------------------

select is(
  pg_temp.state_of(pg_temp.api_exec(v.who, v.biz, format($$
    insert into app.running_costs (id, business_id, name, category_id, amount, frequency,
                                   starts_on, ends_on)
    values (pg_temp.id(%L), pg_temp.id(%L), 'Shop rent', pg_temp.id(%L), %s, %L, %L, %s) $$,
    v.id, v.biz, v.category, v.amount, v.frequency, v.starts, v.ends))),
  v.state,
  v.what
)
  from (values
    ('user A', 'biz A', 'r1', 'cat rent A', '15000', 'monthly', '2026-01-01', 'null', 'ok 1',
     'a monthly rent, still paid'),
    ('user A', 'biz A', 'r2', 'cat rent A', '15000', 'monthly', '2026-01-01', $x$'2025-12-31'$x$, '23514',
     'it cannot end before it starts'),
    ('user A', 'biz A', 'r3', 'cat rent A', '0', 'monthly', '2026-01-01', 'null', '23514',
     'its amount is more than zero'),
    ('user A', 'biz A', 'r4', 'cat rent A', '100', 'daily', '2026-01-01', 'null', '23514',
     'weekly, monthly, quarterly or yearly'),
    ('user A', 'biz A', 'r5', 'cat B', '100', 'yearly', '2026-01-01', 'null', '23503',
     'its category is one of its own business'),
    ('user A', 'biz A', 'r6', 'cat rent A', '1200', 'yearly', '2026-01-01', $x$'2026-01-01'$x$, 'ok 1',
     'it may start and end on the same day')
  ) as v(who, biz, id, category, amount, frequency, starts, ends, state, what);

-- 8. Receipts attach to a live expense of the same business (3) -------------------------------

select is(
  pg_temp.state_of(pg_temp.api_exec(v.who, v.biz, format($$
    insert into app.attachments (id, business_id, entity, entity_id, path, file_name, content_type,
                                 size_bytes)
    values (pg_temp.id(%L), pg_temp.id(%L), 'expense', pg_temp.id(%L),
            pg_temp.id(%L)::text || '/expense/' || pg_temp.id(%L)::text || '.png', 'bill.png',
            'image/png', 10) $$, v.id, v.biz, v.expense, v.biz, v.id))),
  v.state,
  v.what
)
  from (values
    ('user A', 'biz A', 'att 1', 'exp draft', 'ok 1', 'a receipt on an expense'),
    ('user B', 'biz B', 'att 2', 'exp draft', '23503', 'never on an expense of another business')
  ) as v(who, biz, id, expense, state, what);

select is(
  pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', $$
    update app.expenses set deleted_at = now() where id = pg_temp.id('exp approved') $$)),
  'ok 1',
  'a rejected expense edited back to a draft is discarded'
);

-- 9. Across businesses (4) ---------------------------------------------------------------------

select is(
  pg_temp.api_value('user B', 'biz B', format($$ select count(*)::text from app.%I $$, v.tbl)),
  '0',
  'user B sees none of A''s ' || v.tbl
)
  from (values ('expenses'), ('expense_payments'), ('running_costs')) as v(tbl);

select is(
  pg_temp.api_value('user B', 'biz B', $$ select count(*)::text from app.cost_categories $$),
  '1',
  'user B sees only its own category'
);

-- 10. The audit (2) -------------------------------------------------------------------------------

select ok(
  (select count(*) from app.audit_log
    where business_id = pg_temp.id('biz A') and entity = 'expenses'
      and entity_id = pg_temp.id('exp sent')) = 3,
  'the expense sent, approved and posted are in the audit log'
);

select ok(
  (select count(*) from app.audit_log
    where business_id = pg_temp.id('biz A') and entity = 'expense_payments'
      and entity_id = pg_temp.id('pay 1')) = 2,
  'the payment and its reversal are in the audit log'
);

select * from finish();
rollback;

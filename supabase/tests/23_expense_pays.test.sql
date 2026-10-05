-- pgTAP: what an expense pays (the owner's decision of 2026-10-01, D-216; migration
-- expense_running_cost; M3 Step 3, Q8: migrations expense_channel_fees and reports_access). As bizcost_api, like the API: `expenses.pays` is 'running_cost' (with the
-- running cost it pays, `running_cost_id`, a composite foreign key to a running cost of the same
-- business) or 'extra' (naming none), or null (not said: naming none) (expenses_pays_check); what it
-- pays may be said while the expense is a draft, or by its review while it is sent for approval or
-- approved, and is kept once it is final: a posted expense never changes it, and its reversal keeps
-- it (guard_expense). Every change is in the audit log. The cross-business link is also tried by
-- 21_m2_links; the backfill of the expenses already final is run on its own fixtures by
-- packages/db/test/expense-pays.db.test.ts (it executes the migration's own statement). M3 Step 3:
-- 'channel_fees' names a sales channel of the same business (`channel_id`, a composite foreign key)
-- and 'delivery' names nothing; the channel goes with what it pays through the review and is kept
-- once final.
begin;
select plan(40);

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

-- A draft expense of A in Electricity dated today, with `pays` and `running_cost_id` given as SQL.
create function pg_temp.expense_sql(p_id text, p_pays text, p_running_cost text)
returns text language sql immutable
as $$
  select format($f$
    insert into app.expenses (id, business_id, category_id, location_id, business_date,
                              document_type, payment_method, currency, amount, vat_rate, net_total,
                              vat_total, total, pays, running_cost_id)
    values (pg_temp.id(%L), pg_temp.id('biz A'), pg_temp.id('cat A'), pg_temp.id('loc A'),
            current_date, 'no_invoice', 'cash', 'AED', 100, 0, 100, 0, 100, %s, %s) $f$,
    p_id, p_pays, p_running_cost)
$$;

insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', pg_temp.id('user A'), 'authenticated',
        'authenticated', 'amal-pays@example.test', now(), '{}', '{}', now(), now()),
       ('00000000-0000-0000-0000-000000000000', pg_temp.id('user B'), 'authenticated',
        'authenticated', 'badr-pays@example.test', now(), '{}', '{}', now(), now());

-- 1. Columns (4) --------------------------------------------------------------------------------

select col_type_is('app', 'expenses', 'pays', 'text', 'expenses.pays is text');
select col_type_is('app', 'expenses', 'running_cost_id', 'uuid',
                   'expenses.running_cost_id is a uuid (the running cost it pays)');
select has_index('app', 'expenses', 'expenses_running_cost_idx', array['business_id', 'running_cost_id'],
                 'the bills of a running cost are found by (business_id, running_cost_id)');
select col_has_check('app', 'expenses', array['pays', 'running_cost_id', 'channel_id'],
                     'what an expense pays is checked (expenses_pays_check)');

-- 2. Fixtures (7) -------------------------------------------------------------------------------

select is(
  pg_temp.api_value(v.u, null, format($f$
    select app.create_business(pg_temp.id(%L), %L, 'en', 'Owner',
                               pg_temp.id(%L), pg_temp.id(%L)) $f$,
    v.b, v.name, v.b || ' owner role', v.b || ' owner member')),
  pg_temp.id(v.b)::text,
  'setup: ' || v.u || ' creates ' || v.b
)
  from (values ('user A', 'biz A', 'Alpha Cafe'), ('user B', 'biz B', 'Beta Cafe')) as v(u, b, name);

select is(pg_temp.api_exec(v.u, v.b, v.stmt), 'ok 1', 'setup: ' || v.what)
  from (values
    ('user A', 'biz A', 'a location of A', $$
      insert into app.locations (id, business_id, name, is_default)
      values (pg_temp.id('loc A'), pg_temp.id('biz A'), 'Main', true) $$),
    ('user A', 'biz A', 'the category Electricity of A', $$
      insert into app.cost_categories (id, business_id, name)
      values (pg_temp.id('cat A'), pg_temp.id('biz A'), 'Electricity') $$),
    ('user A', 'biz A', 'A''s electricity, a running cost', $$
      insert into app.running_costs (id, business_id, name, category_id, amount, starts_on)
      values (pg_temp.id('run A'), pg_temp.id('biz A'), 'DEWA', pg_temp.id('cat A'), 3000,
              date '2026-01-01') $$),
    ('user B', 'biz B', 'the category Electricity of B', $$
      insert into app.cost_categories (id, business_id, name)
      values (pg_temp.id('cat B'), pg_temp.id('biz B'), 'Electricity') $$),
    ('user B', 'biz B', 'B''s electricity, a running cost', $$
      insert into app.running_costs (id, business_id, name, category_id, amount, starts_on)
      values (pg_temp.id('run B'), pg_temp.id('biz B'), 'DEWA', pg_temp.id('cat B'), 2000,
              date '2026-01-01') $$)
  ) as v(u, b, what, stmt);

-- 3. What it pays, and the running cost it names (8) --------------------------------------------

select is(
  pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', pg_temp.expense_sql(v.id, v.pays, v.run))),
  v.state,
  v.what
)
  from (values
    ('e bill', $$'running_cost'$$, $$pg_temp.id('run A')$$, 'ok 1',
     'the bill of a running cost of its business'),
    ('e extra', $$'extra'$$, 'null', 'ok 1', 'an extra names no running cost'),
    ('e none', 'null', 'null', 'ok 1', 'not said: names no running cost'),
    ('e no run', $$'running_cost'$$, 'null', '23514', 'a bill names the running cost it pays'),
    ('e extra run', $$'extra'$$, $$pg_temp.id('run A')$$, '23514', 'an extra names no running cost'),
    ('e silent run', 'null', $$pg_temp.id('run A')$$, '23514',
     'a running cost is named only by a bill of it'),
    ('e other', $$'salary'$$, 'null', '23514', 'only running_cost or extra'),
    ('e theirs', $$'running_cost'$$, $$pg_temp.id('run B')$$, '23503',
     'never the running cost of another business (the composite foreign key)')
  ) as v(id, pays, run, state, what);

-- 4. Said with the review, kept once final (7) --------------------------------------------------

select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', v.stmt)), v.state, v.what)
  from (values
    (1, 'ok 1', 'a draft changes what it pays', $$
      update app.expenses set pays = 'extra' where id = pg_temp.id('e none') $$),
    (2, 'ok 1', 'setup: the draft is sent for approval, not said yet', $$
      update app.expenses set status = 'submitted', submitted_at = now(),
                              submitted_by = pg_temp.id('user A'), pays = null
       where id = pg_temp.id('e none') $$),
    (3, 'ok 1', 'the one who approves says what it pays, with the approval', $$
      update app.expenses set status = 'approved', approved_at = now(),
                              approved_by = pg_temp.id('user A'), pays = 'running_cost',
                              running_cost_id = pg_temp.id('run A')
       where id = pg_temp.id('e none') $$),
    (4, '23001', 'nothing else of an approved expense changes with it', $$
      update app.expenses set pays = 'extra', running_cost_id = null, amount = 200, net_total = 200,
                              total = 200
       where id = pg_temp.id('e none') $$),
    (5, 'ok 1', 'the one who finalizes may still say it, with the posting', $$
      update app.expenses set status = 'posted', posted_at = now(), posted_by = pg_temp.id('user A'),
                              vat_in_cost = false, cost_total = 100, pays = 'extra',
                              running_cost_id = null
       where id = pg_temp.id('e none') $$),
    (6, '23001', 'a final expense keeps what it pays', $$
      update app.expenses set pays = 'running_cost', running_cost_id = pg_temp.id('run A')
       where id = pg_temp.id('e none') $$),
    (7, '23001', 'its reversal keeps it too', $$
      update app.expenses set status = 'reversed', reversed_at = now(),
                              reversed_by = pg_temp.id('user A'), reversal_date = current_date,
                              pays = null
       where id = pg_temp.id('e none') $$)
  ) as v(n, state, what, stmt)
 order by v.n;

-- 5. Reversed as it is, and audited (2) ---------------------------------------------------------

select is(
  pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', $$
    update app.expenses set status = 'reversed', reversed_at = now(),
                            reversed_by = pg_temp.id('user A'), reversal_date = current_date
     where id = pg_temp.id('e none') $$)),
  'ok 1',
  'a final expense is reversed with what it pays'
);

select is(
  (select string_agg(coalesce(changes -> 'after' ->> 'pays', '-'), ',' order by created_at, id)
     from app.audit_log
    where business_id = pg_temp.id('biz A') and entity = 'expenses'
      and entity_id = pg_temp.id('e none')),
  '-,extra,-,running_cost,extra,extra',
  'every change of what it pays is in the audit log'
);

-- 6. A channel's app fees and delivery already on the sales (M3 Step 3, Q8) (12) ----------------

select col_type_is('app', 'expenses', 'channel_id', 'uuid',
                   'expenses.channel_id is a uuid (the channel whose app fees it pays)');
select has_index('app', 'expenses', 'expenses_channel_idx', array['business_id', 'channel_id'],
                 'the fees expenses of a channel are found by (business_id, channel_id)');

select is(pg_temp.api_exec(v.u, v.b, v.stmt), 'ok 1', 'setup: ' || v.what)
  from (values
    ('user A', 'biz A', 'Talabat, a channel of A', $$
      insert into app.sales_channels (id, business_id, name, kind)
      values (pg_temp.id('chan A'), pg_temp.id('biz A'), 'Talabat', 'delivery_app') $$),
    ('user B', 'biz B', 'Talabat, a channel of B', $$
      insert into app.sales_channels (id, business_id, name, kind)
      values (pg_temp.id('chan B'), pg_temp.id('biz B'), 'Talabat', 'delivery_app') $$)
  ) as v(u, b, what, stmt);

create function pg_temp.fees_sql(p_id text, p_pays text, p_channel text, p_run text)
returns text language sql immutable
as $$
  select format($f$
    insert into app.expenses (id, business_id, category_id, location_id, business_date,
                              document_type, payment_method, currency, amount, vat_rate, net_total,
                              vat_total, total, pays, channel_id, running_cost_id)
    values (pg_temp.id(%L), pg_temp.id('biz A'), pg_temp.id('cat A'), pg_temp.id('loc A'),
            current_date, 'no_invoice', 'cash', 'AED', 100, 0, 100, 0, 100, %s, %s, %s) $f$,
    p_id, p_pays, p_channel, p_run)
$$;

select is(
  pg_temp.state_of(pg_temp.api_exec('user A', 'biz A',
    pg_temp.fees_sql(v.id, v.pays, v.chan, v.run))),
  v.state,
  v.what
)
  from (values
    ('f fees', $$'channel_fees'$$, $$pg_temp.id('chan A')$$, 'null', 'ok 1',
     'the app fees of a channel of its business'),
    ('f delivery', $$'delivery'$$, 'null', 'null', 'ok 1', 'delivery names no channel'),
    ('f no chan', $$'channel_fees'$$, 'null', 'null', '23514', 'app fees name their channel'),
    ('f del chan', $$'delivery'$$, $$pg_temp.id('chan A')$$, 'null', '23514',
     'delivery names no channel'),
    ('f run chan', $$'running_cost'$$, $$pg_temp.id('chan A')$$, $$pg_temp.id('run A')$$, '23514',
     'a bill names no channel'),
    ('f theirs', $$'channel_fees'$$, $$pg_temp.id('chan B')$$, 'null', '23503',
     'never the channel of another business (the composite foreign key)')
  ) as v(id, pays, chan, run, state, what);

select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', $$
  update app.expenses set status = 'posted', posted_at = now(), posted_by = pg_temp.id('user A'),
                          vat_in_cost = false, cost_total = 100
   where id = pg_temp.id('f fees') $$)), 'ok 1', 'setup: the fees expense is finalized');

select is(pg_temp.state_of(pg_temp.api_exec('user A', 'biz A', $$
  update app.expenses set pays = 'delivery', channel_id = null where id = pg_temp.id('f fees') $$)),
  '23001', 'a final expense keeps the channel whose app fees it pays');

select * from finish();
rollback;

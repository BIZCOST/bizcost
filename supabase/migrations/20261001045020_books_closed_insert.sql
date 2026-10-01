-- BizCost: the books-closed date also for a document written already posted or reversed (M2 Step 8;
-- D-205, D-211). The trigger books_closed (migration books_closed_guard) fires when a purchase, a
-- supplier return or credit note, or an expense BECOMES posted or reversed by an UPDATE, which is how
-- the API posts. A row inserted with status 'posted' or 'reversed' passed it, so a script, a later
-- procedure or a bug that writes a final document in one statement could put it into closed books.
-- Now the same check runs on such an INSERT: a posted one by its day (an expense: and its month), a
-- reversed one by its posting AND its reversal (it would put both into the books). Drafts and
-- expenses under review are inserted as before.
--
-- The INSERT trigger is named insert_books_closed so that it fires after an expense's
-- default_period_month (triggers of one event fire in name order): it checks the month the row gets.
-- Rules as in tenancy_security: SET search_path = '' with schema-qualified names, owner postgres,
-- EXECUTE revoked from PUBLIC/anon/authenticated.

create or replace function app.guard_books_closed()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_closed date;
  v_open_month date;
  v_days date[] := '{}';
  v_months date[] := '{}';
begin
  select b.books_closed_through into v_closed
  from app.businesses b
  where b.id = new.business_id
  for share;
  if v_closed is null then
    return new;
  end if;
  -- The first month left open: the month of the day after the date (a month closed only in part
  -- stays open; its closed days are checked by the day).
  v_open_month := pg_catalog.date_trunc('month', v_closed + 1)::date;

  if tg_table_name in ('purchases', 'purchase_returns', 'expenses') then
    -- Its posting: when it becomes posted, or when it is written already posted or reversed.
    if new.status = 'posted' or tg_op = 'INSERT' then
      v_days := v_days || new.business_date;
      if tg_table_name = 'expenses' then
        v_months := v_months || new.period_month;
      end if;
    end if;
    -- Its reversal: its own month, or `reversal_period_month` for an expense (D-200).
    if new.status = 'reversed' then
      v_days := v_days || new.reversal_date;
      if tg_table_name = 'expenses' then
        v_months := v_months || coalesce(new.reversal_period_month, new.period_month);
      end if;
    end if;
  elsif tg_table_name in ('purchase_payments', 'expense_payments') then
    v_days := array[case when tg_op = 'INSERT' then new.business_date else new.reversal_date end];
  else
    -- stock_movements
    v_days := array[new.business_date];
  end if;

  if exists (select 1 from unnest(v_days) as d(v) where d.v <= v_closed)
     or exists (select 1 from unnest(v_months) as m(v) where m.v < v_open_month) then
    raise exception 'books_closed: %.% cannot be posted or reversed on or before %',
      tg_table_schema, tg_table_name, v_closed
      using errcode = 'BZ412';
  end if;
  return new;
end
$$;

-- Documents written already posted or reversed.
create trigger insert_books_closed before insert on app.purchases
  for each row
  when (new.status in ('posted', 'reversed'))
  execute function app.guard_books_closed();
create trigger insert_books_closed before insert on app.purchase_returns
  for each row
  when (new.status in ('posted', 'reversed'))
  execute function app.guard_books_closed();
create trigger insert_books_closed before insert on app.expenses
  for each row
  when (new.status in ('posted', 'reversed'))
  execute function app.guard_books_closed();

alter function app.guard_books_closed() owner to postgres;
revoke all on function app.guard_books_closed() from public, anon, authenticated;
grant execute on function app.guard_books_closed() to bizcost_api;

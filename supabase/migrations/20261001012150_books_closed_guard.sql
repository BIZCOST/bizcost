-- BizCost: the books-closed date at the database too (M2 Step 8; D-114 rule 6, D-135, D-200). Until
-- now only the API refused to post or reverse on or before `businesses.books_closed_through`
-- (stock.ts: assertPostable and reversalDateOf, with the business row locked FOR SHARE). The trigger
-- books_closed refuses it where the posting is written, so no path that skips the API's check (a
-- script, a later procedure, a bug) can put anything into closed books:
--   - purchases, supplier returns and credit notes: posted only when dated after the date, reversed
--     only on a day after it (the API dates a reversal of a closed day on the first open day);
--   - expenses: the same by day, and never for a closed month (closed once the books are closed
--     through its last day): finalized only for an open month, reversed only into one (its own month,
--     or `reversal_period_month`, D-200);
--   - the payments of purchases and expenses: recorded only after the date, reversed only on a day
--     after it;
--   - the stock ledger: no movement is dated on or before it.
-- Drafts dated in the closed period are still saved and edited (only posting and reversing are
-- closed). The business row is read FOR SHARE, as the API's postings lock it first (lock 2 of D-135),
-- so a change of the date waits for a posting in flight and a posting never reads a date being
-- changed. Refused: SQLSTATE BZ412, which the API answers with BOOKS_CLOSED.
--
-- Rules as in tenancy_security: SET search_path = '' with schema-qualified names, owner postgres,
-- EXECUTE revoked from PUBLIC/anon/authenticated (trigger functions run as the trigger fires).

create function app.guard_books_closed()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_closed date;
  v_open_month date;
  v_day date;
  v_month date;
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
    if new.status = 'posted' then
      v_day := new.business_date;
      if tg_table_name = 'expenses' then
        v_month := new.period_month;
      end if;
    else
      v_day := new.reversal_date;
      if tg_table_name = 'expenses' then
        v_month := coalesce(new.reversal_period_month, new.period_month);
      end if;
    end if;
  elsif tg_table_name in ('purchase_payments', 'expense_payments') then
    v_day := case when tg_op = 'INSERT' then new.business_date else new.reversal_date end;
  else
    -- stock_movements
    v_day := new.business_date;
  end if;

  if v_day <= v_closed or v_month < v_open_month then
    raise exception 'books_closed: %.% cannot be posted or reversed on or before %',
      tg_table_schema, tg_table_name, v_closed
      using errcode = 'BZ412';
  end if;
  return new;
end
$$;

-- Documents: when they become posted or reversed (a draft's edits and an expense's review are not
-- postings).
create trigger books_closed before update on app.purchases
  for each row
  when (new.status is distinct from old.status and new.status in ('posted', 'reversed'))
  execute function app.guard_books_closed();
create trigger books_closed before update on app.purchase_returns
  for each row
  when (new.status is distinct from old.status and new.status in ('posted', 'reversed'))
  execute function app.guard_books_closed();
create trigger books_closed before update on app.expenses
  for each row
  when (new.status is distinct from old.status and new.status in ('posted', 'reversed'))
  execute function app.guard_books_closed();

-- Payments: when recorded, and when reversed.
create trigger books_closed before insert on app.purchase_payments
  for each row execute function app.guard_books_closed();
create trigger books_closed_reversal before update on app.purchase_payments
  for each row
  when (old.reversed_at is null and new.reversed_at is not null)
  execute function app.guard_books_closed();
create trigger books_closed before insert on app.expense_payments
  for each row execute function app.guard_books_closed();
create trigger books_closed_reversal before update on app.expense_payments
  for each row
  when (old.reversed_at is null and new.reversed_at is not null)
  execute function app.guard_books_closed();

-- The ledger: every movement (append-only, so only inserts).
create trigger books_closed before insert on app.stock_movements
  for each row execute function app.guard_books_closed();

alter function app.guard_books_closed() owner to postgres;
revoke all on function app.guard_books_closed() from public, anon, authenticated;
grant execute on function app.guard_books_closed() to bizcost_api;

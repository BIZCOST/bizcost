-- BizCost: the month an expense is for, when a row is written without it (the owner's request of
-- 2026-09-30). The API always writes expenses.period_month (a category billed the month after defaults
-- to the month before the bill's date, else the bill's month; services/expenses.ts). A row inserted
-- without it (a direct write by a test, a script or a later import) gets its bill's month, so the
-- column stays NOT NULL without a way round the check on its range (expenses_period_month_check).

create function app.default_period_month()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.period_month is null then
    new.period_month := pg_catalog.date_trunc('month', new.business_date)::date;
  end if;
  return new;
end;
$$;

create trigger default_period_month before insert on app.expenses
  for each row execute function app.default_period_month();

revoke all on function app.default_period_month() from public, anon, authenticated;
grant execute on function app.default_period_month() to bizcost_api;

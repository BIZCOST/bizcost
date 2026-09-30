-- BizCost: the month an expense's reversal counts in (D-200; drizzle-kit generated, then edited).
-- Closed books close months too: an expense for a month the books are closed through (to its last
-- day) is never finalized (the API refuses it, BOOKS_CLOSED), and reversing one that was finalized
-- before the close counts in the first open month, as a reversal is dated on the first open day
-- (D-114 rule 3). The API writes the month on every reversal; null (a row reversed before this
-- migration, or written directly) is the expense's own month.
ALTER TABLE "app"."expenses" ADD COLUMN "reversal_period_month" date;--> statement-breakpoint
-- Every expense reversed so far was reversed in its own month (no month was closed by its month
-- before). A final expense never changes (guard_expense), and this is not an edit of it: the guard
-- and touch_row are off for this one statement, so versions and "changed by" stay as they were.
ALTER TABLE "app"."expenses" DISABLE TRIGGER "guard_expense";--> statement-breakpoint
ALTER TABLE "app"."expenses" DISABLE TRIGGER "touch_row";--> statement-breakpoint
UPDATE "app"."expenses" SET "reversal_period_month" = "period_month" WHERE "status" = 'reversed' AND "reversal_period_month" IS NULL;--> statement-breakpoint
ALTER TABLE "app"."expenses" ENABLE TRIGGER "touch_row";--> statement-breakpoint
ALTER TABLE "app"."expenses" ENABLE TRIGGER "guard_expense";--> statement-breakpoint
ALTER TABLE "app"."expenses" ADD CONSTRAINT "expenses_reversal_period_month_check" CHECK (reversal_period_month is null
        or (status = 'reversed'
          and reversal_period_month = date_trunc('month', reversal_period_month)::date
          and reversal_period_month >= period_month));--> statement-breakpoint
-- A posted expense changes only to reversed, with its reversal columns: the month it counts in is
-- one of them now (the rest of the guard as in expenses_security).
create or replace function app.guard_expense()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_review text[] := array[
    'status', 'submitted_at', 'submitted_by', 'approved_at', 'approved_by', 'rejected_at',
    'rejected_by', 'rejection_reason', 'vat_in_cost', 'cost_total', 'posted_at', 'posted_by',
    'updated_at', 'updated_by', 'version'
  ];
  v_reversal text[] := array[
    'status', 'reversed_at', 'reversed_by', 'reversal_date', 'reversal_period_month',
    'updated_at', 'updated_by', 'version'
  ];
begin
  if tg_op = 'DELETE' then
    raise exception 'app.expenses rows are never deleted (a draft is discarded, a posted one reversed)'
      using errcode = 'restrict_violation';
  end if;
  if old.status in ('draft', 'rejected') then
    if new.status in ('approved', 'reversed') then
      raise exception 'an expense is approved only once sent for approval, reversed only once posted'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if old.status in ('submitted', 'approved') then
    if new.status in ('submitted', 'approved', 'rejected', 'posted')
      and not (old.status = 'approved' and new.status = 'submitted')
      and (pg_catalog.to_jsonb(old) - v_review) = (pg_catalog.to_jsonb(new) - v_review)
    then
      return new;
    end if;
    raise exception 'an expense sent for approval is not changed: reject it first'
      using errcode = 'restrict_violation';
  end if;
  if old.status = 'posted'
    and new.status = 'reversed'
    and (pg_catalog.to_jsonb(old) - v_reversal) = (pg_catalog.to_jsonb(new) - v_reversal)
  then
    return new;
  end if;
  raise exception 'a posted expense is never edited: reverse it instead'
    using errcode = 'restrict_violation';
end
$$;

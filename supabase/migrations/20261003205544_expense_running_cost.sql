-- BizCost: what an expense pays (the owner's decision of 2026-10-01, D-216; drizzle-kit generated,
-- then edited). An expense in a category that has running costs says which one it pays (`pays`
-- 'running_cost' with `running_cost_id`: its bill takes the place of that running cost's regular
-- amount alone over the period it pays for), or that it is an extra (`pays` 'extra': it counts as
-- itself, on top). Null: not said yet (a draft, or one sent for approval), or its category has no
-- running cost for its month. The API asks for it before an expense is finalized whenever its
-- category has a running cost a bill for its month can pay, checks that the running cost is the
-- business's, in the expense's category and payable in its month, and lets the one who approves or
-- finalizes say it for a member who may not see running costs.
ALTER TABLE "app"."expenses" ADD COLUMN "pays" text;--> statement-breakpoint
ALTER TABLE "app"."expenses" ADD COLUMN "running_cost_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."expenses" ADD CONSTRAINT "expenses_running_cost_fk" FOREIGN KEY ("business_id","running_cost_id") REFERENCES "app"."running_costs"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expenses_running_cost_idx" ON "app"."expenses" USING btree ("business_id","running_cost_id");--> statement-breakpoint
ALTER TABLE "app"."expenses" ADD CONSTRAINT "expenses_pays_check" CHECK ((pays is null or pays in ('running_cost', 'extra'))
        and (running_cost_id is null) = (pays is distinct from 'running_cost'));--> statement-breakpoint
-- The expenses already final (local and demo data only: nothing is hosted) say what they paid, so
-- the month's costs stay what D-203 counted where it could tell: one in a category with exactly one
-- running cost a bill for its month can pay (billPeriodOf in @bizcost/domain: a weekly or monthly one
-- that ran a day of the month; a quarterly or yearly one whose quarter or year holding the month,
-- counted from the month it started, began before it stopped) is that running cost's bill; one in a
-- category with two or more is an extra (which one it paid cannot be told); one in a category with
-- none says nothing. Drafts and expenses under review are asked when they are finalized. A final
-- expense never changes (guard_expense), and this is not an edit of it: the guard and touch_row are
-- off for this one statement, so versions and "changed by" stay as they were.
ALTER TABLE "app"."expenses" DISABLE TRIGGER "guard_expense";--> statement-breakpoint
ALTER TABLE "app"."expenses" DISABLE TRIGGER "touch_row";--> statement-breakpoint
WITH "payable" AS (
  SELECT e.id AS expense_id, r.id AS running_cost_id
    FROM app.expenses e
    JOIN app.running_costs r
      ON r.business_id = e.business_id AND r.category_id = e.category_id AND r.deleted_at IS NULL
   CROSS JOIN LATERAL (
     SELECT (extract(year FROM e.period_month)::int * 12 + extract(month FROM e.period_month)::int)
          - (extract(year FROM r.starts_on)::int * 12 + extract(month FROM r.starts_on)::int) AS gone,
            CASE r.frequency WHEN 'quarterly' THEN 3 WHEN 'yearly' THEN 12 ELSE 1 END AS months
   ) p
   WHERE e.status IN ('posted', 'reversed') AND e.deleted_at IS NULL AND e.pays IS NULL
     AND CASE
       WHEN p.months = 1 THEN
         greatest(e.period_month, r.starts_on)
           < least((e.period_month + interval '1 month')::date, coalesce(r.ends_on, 'infinity'::date))
       ELSE
         p.gone >= 0
         AND (r.ends_on IS NULL
           OR r.ends_on > greatest(
             (date_trunc('month', r.starts_on) + make_interval(months => p.gone - p.gone % p.months))::date,
             r.starts_on))
     END
), "counted" AS (
  SELECT expense_id, count(*) AS n, (array_agg(running_cost_id))[1] AS only_one
    FROM "payable"
   GROUP BY expense_id
)
UPDATE "app"."expenses" e
   SET "pays" = CASE WHEN c.n = 1 THEN 'running_cost' ELSE 'extra' END,
       "running_cost_id" = CASE WHEN c.n = 1 THEN c.only_one END
  FROM "counted" c
 WHERE e.id = c.expense_id;--> statement-breakpoint
ALTER TABLE "app"."expenses" ENABLE TRIGGER "touch_row";--> statement-breakpoint
ALTER TABLE "app"."expenses" ENABLE TRIGGER "guard_expense";--> statement-breakpoint
-- What an expense pays is part of its review: the one who approves or finalizes an expense sent for
-- approval may say it (a member who may not see running costs never does), so it may change with the
-- review and posting columns while the expense is submitted or approved. A posted expense keeps it:
-- it only becomes reversed (the rest of the guard as in expense_reversal_month).
create or replace function app.guard_expense()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_review text[] := array[
    'status', 'submitted_at', 'submitted_by', 'approved_at', 'approved_by', 'rejected_at',
    'rejected_by', 'rejection_reason', 'vat_in_cost', 'cost_total', 'posted_at', 'posted_by',
    'pays', 'running_cost_id', 'updated_at', 'updated_by', 'version'
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

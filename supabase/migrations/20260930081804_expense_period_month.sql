-- BizCost: the month an expense is for (the owner's request of 2026-09-30), and the categories whose
-- bills come the month after (drizzle-kit generated, then edited: the column is added empty, filled
-- for the expenses that exist, then made NOT NULL).
ALTER TABLE "app"."cost_categories" ADD COLUMN "billed_next_month" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."expenses" ADD COLUMN "period_month" date;--> statement-breakpoint
-- Every expense that exists is for the month of its bill's date. A posted or reviewed expense never
-- changes (guard_expense), and this is not an edit of it: the guard and touch_row are off for this
-- one statement, so versions and "changed by" stay as they were (the audit trigger records it).
ALTER TABLE "app"."expenses" DISABLE TRIGGER "guard_expense";--> statement-breakpoint
ALTER TABLE "app"."expenses" DISABLE TRIGGER "touch_row";--> statement-breakpoint
UPDATE "app"."expenses" SET "period_month" = date_trunc('month', "business_date")::date WHERE "period_month" IS NULL;--> statement-breakpoint
ALTER TABLE "app"."expenses" ENABLE TRIGGER "touch_row";--> statement-breakpoint
ALTER TABLE "app"."expenses" ENABLE TRIGGER "guard_expense";--> statement-breakpoint
ALTER TABLE "app"."expenses" ALTER COLUMN "period_month" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "expenses_period_month_idx" ON "app"."expenses" USING btree ("business_id","period_month");--> statement-breakpoint
ALTER TABLE "app"."expenses" ADD CONSTRAINT "expenses_period_month_check" CHECK (period_month = date_trunc('month', period_month)::date
        and period_month >= (date_trunc('month', business_date) - interval '12 months')::date
        and period_month <= (date_trunc('month', business_date) + interval '1 month')::date);

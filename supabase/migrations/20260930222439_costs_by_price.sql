-- BizCost: running costs reach products by their price (the owner's decision of 2026-09-30, D-202;
-- drizzle-kit generated). The owner's estimate of monthly material purchases (D-116, D-186) is no
-- longer asked or used: a product's share of the running costs is its price before VAT × the month's
-- costs ÷ the month's sales, worked out on read once sales are recorded (Phase 3). The column and its
-- check go in one migration rather than expand → contract: nothing is deployed yet (local and demo
-- data only), and no code reads it any more.
ALTER TABLE "app"."businesses" DROP CONSTRAINT "businesses_estimated_monthly_purchases_check";--> statement-breakpoint
ALTER TABLE "app"."businesses" DROP COLUMN "estimated_monthly_purchases";

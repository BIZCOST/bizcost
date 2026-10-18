-- BizCost: an order made from a quotation keeps its "Round the total" (M3 Step 7, D-221): the total
-- wanted, the adjustment before VAT and the rounding difference (generated). Existing orders have none.
ALTER TABLE "app"."orders" ADD COLUMN "round_to" numeric(20, 4);--> statement-breakpoint
ALTER TABLE "app"."orders" ADD COLUMN "adjustment" numeric(20, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."orders" ADD COLUMN "rounding_difference" numeric(20, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."orders" ADD CONSTRAINT "orders_round_check" CHECK (round_to >= 0 and (round_to is not null or (adjustment = 0 and rounding_difference = 0)));
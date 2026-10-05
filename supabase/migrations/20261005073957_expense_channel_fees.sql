-- BizCost: what an expense pays gains a channel's app fees and delivery already on the sales (M3
-- Step 3, the owner's answer Q8 = A, D-218; drizzle-kit generated, then commented). While Sales is
-- served, any expense may say `channel_fees` ("App fees of [channel]", `channel_id` naming one of the
-- business's sales channels: that channel's fees for the month it is for, when no statement covers
-- it) or `delivery` ("Delivery already on my sales and orders": a courier's bill whose deliveries
-- the sales already carry as their delivery cost). Neither ever counts in the month's costs
-- (costPool in @bizcost/domain), so nothing is counted twice. Who may say it, and when: the API
-- (services/expenses.ts); the guard lets it change with the review columns (reports_access).
ALTER TABLE "app"."expenses" DROP CONSTRAINT "expenses_pays_check";--> statement-breakpoint
ALTER TABLE "app"."expenses" ADD COLUMN "channel_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."expenses" ADD CONSTRAINT "expenses_channel_fk" FOREIGN KEY ("business_id","channel_id") REFERENCES "app"."sales_channels"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expenses_channel_idx" ON "app"."expenses" USING btree ("business_id","channel_id");--> statement-breakpoint
ALTER TABLE "app"."expenses" ADD CONSTRAINT "expenses_pays_check" CHECK ((pays is null or pays in ('running_cost', 'extra', 'channel_fees', 'delivery'))
        and (running_cost_id is null) = (pays is distinct from 'running_cost')
        and (channel_id is null) = (pays is distinct from 'channel_fees'));

-- BizCost: a material's stock value and average are numeric(38,12) (M2 Step 8, D-209; drizzle-kit
-- generated). One purchase line is at most numeric(20,4) and one movement numeric(28,12), but what
-- all the postings of a material add up to had the same limit (10^16): a posting then failed (the
-- database's overflow) exactly when the hidden stock value plus the poster's amount reached it, so a
-- member who may not see costs could tell the value apart by trying amounts. The limit is now 10^26:
-- ten billion postings of the largest amount, out of reach.

ALTER TABLE "app"."material_costs" ALTER COLUMN "value" SET DATA TYPE numeric(38, 12);--> statement-breakpoint
ALTER TABLE "app"."material_costs" ALTER COLUMN "value" SET DEFAULT '0';--> statement-breakpoint
ALTER TABLE "app"."material_costs" ALTER COLUMN "avg_cost" SET DATA TYPE numeric(38, 12);
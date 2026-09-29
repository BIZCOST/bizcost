ALTER TABLE "app"."recipes" ADD COLUMN "yield_qty" numeric(24, 6) DEFAULT '1' NOT NULL;--> statement-breakpoint
CREATE INDEX "expenses_created_by_idx" ON "app"."expenses" USING btree ("business_id","created_by");--> statement-breakpoint
ALTER TABLE "app"."recipes" ADD CONSTRAINT "recipes_yield_qty_check" CHECK (yield_qty > 0);
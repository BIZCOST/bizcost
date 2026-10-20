ALTER TABLE "app"."invoices" ADD COLUMN "bill_stage" integer;--> statement-breakpoint
ALTER TABLE "app"."invoices" ADD COLUMN "site" text;--> statement-breakpoint
ALTER TABLE "app"."invoices" ADD COLUMN "customer_phone" text;--> statement-breakpoint
ALTER TABLE "app"."invoices" ADD CONSTRAINT "invoices_bill_stage_check" CHECK (bill_stage is null
        or (bill_stage between 0 and 9 and quotation_id is not null and not is_deposit));--> statement-breakpoint
ALTER TABLE "app"."invoices" ADD CONSTRAINT "invoices_site_check" CHECK (btrim(site) <> '' and char_length(site) <= 200);--> statement-breakpoint
ALTER TABLE "app"."invoices" ADD CONSTRAINT "invoices_customer_phone_check" CHECK (btrim(customer_phone) <> '' and char_length(customer_phone) <= 30);
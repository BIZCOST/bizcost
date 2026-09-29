ALTER TABLE "app"."businesses" ADD COLUMN "estimated_monthly_purchases" numeric(20, 4);--> statement-breakpoint
ALTER TABLE "app"."businesses" ADD COLUMN "owner_hourly_rate" numeric(20, 4);--> statement-breakpoint
ALTER TABLE "app"."products_services" ADD COLUMN "owner_minutes" numeric(24, 6);--> statement-breakpoint
ALTER TABLE "app"."businesses" ADD CONSTRAINT "businesses_estimated_monthly_purchases_check" CHECK (estimated_monthly_purchases > 0);--> statement-breakpoint
ALTER TABLE "app"."businesses" ADD CONSTRAINT "businesses_owner_hourly_rate_check" CHECK (owner_hourly_rate > 0);--> statement-breakpoint
ALTER TABLE "app"."products_services" ADD CONSTRAINT "products_services_owner_minutes_check" CHECK (owner_minutes > 0);
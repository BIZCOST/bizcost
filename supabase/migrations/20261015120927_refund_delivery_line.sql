ALTER TABLE "app"."sale_lines" DROP CONSTRAINT "sale_lines_delivery_check";--> statement-breakpoint
ALTER TABLE "app"."sale_lines" ADD CONSTRAINT "sale_lines_delivery_check" CHECK (kind <> 'delivery' or (abs(qty) = 1 and unit is null
        and discount_percent is null and discount_amount is null));
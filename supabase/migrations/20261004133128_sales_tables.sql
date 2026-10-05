CREATE TABLE "app"."sale_line_materials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"sale_id" uuid NOT NULL,
	"sale_line_id" uuid NOT NULL,
	"material_id" uuid NOT NULL,
	"base_qty" numeric NOT NULL,
	"unit_cost" numeric,
	"cost" numeric,
	"basis" text,
	"created_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"request_hash" text,
	CONSTRAINT "sale_line_materials_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "sale_line_materials_basis_check" CHECK (basis in ('purchases_90_days', 'last_purchase', 'first_purchase')),
	CONSTRAINT "sale_line_materials_priced_check" CHECK ((cost is null) = (unit_cost is null) and (cost is null) = (basis is null)),
	CONSTRAINT "sale_line_materials_scale_check" CHECK (scale(base_qty) <= 6 and scale(unit_cost) <= 12 and scale(cost) <= 12)
);
--> statement-breakpoint
CREATE TABLE "app"."sale_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"sale_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"kind" text NOT NULL,
	"product_id" uuid,
	"description" text,
	"qty" numeric(24, 6) NOT NULL,
	"unit" text,
	"unit_price" numeric(20, 4) NOT NULL,
	"price_includes_vat" boolean DEFAULT false NOT NULL,
	"discount_percent" numeric(9, 6),
	"discount_amount" numeric(20, 4),
	"vat_category" text,
	"vat_rate" numeric(9, 6),
	"subtotal" numeric(20, 4) DEFAULT '0' NOT NULL,
	"discount" numeric(20, 4) DEFAULT '0' NOT NULL,
	"net" numeric(20, 4) DEFAULT '0' NOT NULL,
	"vat" numeric(20, 4) DEFAULT '0' NOT NULL,
	"total" numeric(20, 4) DEFAULT '0' NOT NULL,
	"cost_basis" text,
	"cost" numeric,
	"time_minutes" numeric,
	"time_cost" numeric,
	"created_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"request_hash" text,
	CONSTRAINT "sale_lines_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "sale_lines_sale_id_key" UNIQUE("business_id","sale_id","id"),
	CONSTRAINT "sale_lines_kind_check" CHECK (kind in ('item', 'delivery', 'charge')),
	CONSTRAINT "sale_lines_product_check" CHECK ((kind = 'item') = (product_id is not null)),
	CONSTRAINT "sale_lines_delivery_check" CHECK (kind <> 'delivery' or (qty = 1 and unit is null
        and discount_percent is null and discount_amount is null)),
	CONSTRAINT "sale_lines_unit_check" CHECK (unit in ('mg', 'g', 'kg', 'ml', 'l', 'piece', 'mm', 'cm', 'm', 'mm2', 'cm2', 'm2', 's', 'min', 'h')),
	CONSTRAINT "sale_lines_position_check" CHECK (position >= 0),
	CONSTRAINT "sale_lines_qty_check" CHECK (qty <> 0),
	CONSTRAINT "sale_lines_unit_price_check" CHECK (unit_price >= 0),
	CONSTRAINT "sale_lines_discount_check" CHECK (num_nonnulls(discount_percent, discount_amount) <= 1
        and discount_percent between 0 and 100 and discount_amount >= 0),
	CONSTRAINT "sale_lines_vat_category_check" CHECK (vat_category in ('standard', 'zero_rated', 'exempt')),
	CONSTRAINT "sale_lines_vat_rate_check" CHECK (vat_rate between 0 and 100),
	CONSTRAINT "sale_lines_vat_check" CHECK ((vat_category is null) = (vat_rate is null)),
	CONSTRAINT "sale_lines_description_check" CHECK (btrim(description) <> '' and char_length(description) <= 200),
	CONSTRAINT "sale_lines_cost_basis_check" CHECK (cost_basis in ('recipe', 'resale', 'none')),
	CONSTRAINT "sale_lines_cost_check" CHECK (cost is null or (cost_basis is not null and scale(cost) <= 12)),
	CONSTRAINT "sale_lines_time_check" CHECK (scale(time_minutes) <= 12 and scale(time_cost) <= 12
        and (time_cost is null or time_minutes is not null))
);
--> statement-breakpoint
CREATE TABLE "app"."sales" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"source" text NOT NULL,
	"business_date" date NOT NULL,
	"period_from" date,
	"location_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"vat_registered" boolean DEFAULT false NOT NULL,
	"currency" char(3) NOT NULL,
	"subtotal" numeric(20, 4) DEFAULT '0' NOT NULL,
	"discount_total" numeric(20, 4) DEFAULT '0' NOT NULL,
	"net_total" numeric(20, 4) DEFAULT '0' NOT NULL,
	"vat_total" numeric(20, 4) DEFAULT '0' NOT NULL,
	"total" numeric(20, 4) DEFAULT '0' NOT NULL,
	"delivery_needed" boolean DEFAULT false NOT NULL,
	"delivery_area" text,
	"delivery_cost" numeric(20, 4),
	"notes" text,
	"posted_at" timestamp with time zone,
	"posted_by" uuid,
	"reversed_at" timestamp with time zone,
	"reversed_by" uuid,
	"reversal_business_date" date,
	"copied_from_id" uuid,
	"created_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"request_hash" text,
	CONSTRAINT "sales_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "sales_source_check" CHECK (source in ('day_sheet', 'single')),
	CONSTRAINT "sales_status_check" CHECK (status in ('draft', 'posted', 'reversed')),
	CONSTRAINT "sales_currency_check" CHECK (currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "sales_period_check" CHECK (period_from is null or (source = 'day_sheet' and period_from < business_date
        and date_trunc('month', period_from) = date_trunc('month', business_date))),
	CONSTRAINT "sales_delivery_check" CHECK (delivery_needed or (delivery_area is null and delivery_cost is null)),
	CONSTRAINT "sales_delivery_cost_check" CHECK (delivery_cost >= 0),
	CONSTRAINT "sales_delivery_area_check" CHECK (btrim(delivery_area) <> '' and char_length(delivery_area) <= 200),
	CONSTRAINT "sales_notes_check" CHECK (char_length(notes) <= 1000),
	CONSTRAINT "sales_posted_check" CHECK ((status = 'draft') = (posted_at is null) and (status = 'draft') = (posted_by is null)),
	CONSTRAINT "sales_reversed_check" CHECK ((status = 'reversed') = (reversed_at is not null)
        and (status = 'reversed') = (reversed_by is not null)
        and (status = 'reversed') = (reversal_business_date is not null)),
	CONSTRAINT "sales_copied_from_check" CHECK (copied_from_id <> id)
);
--> statement-breakpoint
CREATE TABLE "app"."sales_channels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"fee_percent" numeric(9, 6),
	"archived_at" timestamp with time zone,
	"created_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"request_hash" text,
	CONSTRAINT "sales_channels_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "sales_channels_name_check" CHECK (btrim(name) <> '' and char_length(name) <= 100),
	CONSTRAINT "sales_channels_kind_check" CHECK (kind in ('shop', 'messages', 'website', 'delivery_app', 'marketplace', 'other')),
	CONSTRAINT "sales_channels_fee_percent_check" CHECK (fee_percent between 0 and 100)
);
--> statement-breakpoint
ALTER TABLE "app"."sale_line_materials" ADD CONSTRAINT "sale_line_materials_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sale_line_materials" ADD CONSTRAINT "sale_line_materials_line_fk" FOREIGN KEY ("business_id","sale_id","sale_line_id") REFERENCES "app"."sale_lines"("business_id","sale_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sale_line_materials" ADD CONSTRAINT "sale_line_materials_sale_fk" FOREIGN KEY ("business_id","sale_id") REFERENCES "app"."sales"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sale_line_materials" ADD CONSTRAINT "sale_line_materials_material_fk" FOREIGN KEY ("business_id","material_id") REFERENCES "app"."materials"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sale_lines" ADD CONSTRAINT "sale_lines_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sale_lines" ADD CONSTRAINT "sale_lines_sale_fk" FOREIGN KEY ("business_id","sale_id") REFERENCES "app"."sales"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sale_lines" ADD CONSTRAINT "sale_lines_product_fk" FOREIGN KEY ("business_id","product_id") REFERENCES "app"."products_services"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sales" ADD CONSTRAINT "sales_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sales" ADD CONSTRAINT "sales_location_fk" FOREIGN KEY ("business_id","location_id") REFERENCES "app"."locations"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sales" ADD CONSTRAINT "sales_channel_fk" FOREIGN KEY ("business_id","channel_id") REFERENCES "app"."sales_channels"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sales" ADD CONSTRAINT "sales_copied_from_fk" FOREIGN KEY ("business_id","copied_from_id") REFERENCES "app"."sales"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sales_channels" ADD CONSTRAINT "sales_channels_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sale_line_materials_line_material_key" ON "app"."sale_line_materials" USING btree ("business_id","sale_line_id","material_id") WHERE deleted_at is null;--> statement-breakpoint
CREATE INDEX "sale_line_materials_material_idx" ON "app"."sale_line_materials" USING btree ("business_id","material_id");--> statement-breakpoint
CREATE INDEX "sale_line_materials_unpriced_idx" ON "app"."sale_line_materials" USING btree ("business_id","material_id") WHERE cost is null and deleted_at is null;--> statement-breakpoint
CREATE INDEX "sale_lines_product_idx" ON "app"."sale_lines" USING btree ("business_id","product_id");--> statement-breakpoint
CREATE INDEX "sales_business_date_idx" ON "app"."sales" USING btree ("business_id","business_date","id");--> statement-breakpoint
CREATE INDEX "sales_created_by_idx" ON "app"."sales" USING btree ("business_id","created_by","business_date");--> statement-breakpoint
CREATE INDEX "sales_channel_idx" ON "app"."sales" USING btree ("business_id","channel_id");--> statement-breakpoint
CREATE INDEX "sales_location_idx" ON "app"."sales" USING btree ("business_id","location_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_day_sheet_key" ON "app"."sales" USING btree ("business_id","created_by","location_id","channel_id","business_date",coalesce(period_from, business_date)) WHERE source = 'day_sheet' and status <> 'reversed' and deleted_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "sales_channels_name_key" ON "app"."sales_channels" USING btree ("business_id",app.name_key(name)) WHERE deleted_at is null;
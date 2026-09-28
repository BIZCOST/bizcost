CREATE TABLE "app"."material_units" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"material_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text,
	"unit" text,
	"qty" numeric(28, 12) NOT NULL,
	"of_unit" text,
	"of_pack_id" uuid,
	"created_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"request_hash" text,
	CONSTRAINT "material_units_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "material_units_material_id_key" UNIQUE("business_id","material_id","id"),
	CONSTRAINT "material_units_kind_check" CHECK (kind in ('pack', 'cross')),
	CONSTRAINT "material_units_pack_name_check" CHECK ((kind = 'pack') = (name is not null)),
	CONSTRAINT "material_units_cross_unit_check" CHECK ((kind = 'cross') = (unit is not null)),
	CONSTRAINT "material_units_of_check" CHECK (num_nonnulls(of_unit, of_pack_id) = 1),
	CONSTRAINT "material_units_of_pack_check" CHECK (kind = 'pack' or of_pack_id is null),
	CONSTRAINT "material_units_qty_check" CHECK (qty > 0),
	CONSTRAINT "material_units_name_check" CHECK (btrim(name) <> '' and char_length(name) <= 50),
	CONSTRAINT "material_units_unit_check" CHECK (unit in ('mg', 'g', 'kg', 'ml', 'l', 'piece', 'mm', 'cm', 'm', 'mm2', 'cm2', 'm2', 's', 'min', 'h')),
	CONSTRAINT "material_units_of_unit_check" CHECK (of_unit in ('mg', 'g', 'kg', 'ml', 'l', 'piece', 'mm', 'cm', 'm', 'mm2', 'cm2', 'm2', 's', 'min', 'h'))
);
--> statement-breakpoint
CREATE TABLE "app"."materials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"dimension" text NOT NULL,
	"unit" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"request_hash" text,
	CONSTRAINT "materials_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "materials_name_check" CHECK (btrim(name) <> '' and char_length(name) <= 100),
	CONSTRAINT "materials_dimension_check" CHECK (dimension in ('mass', 'volume', 'count', 'length', 'area', 'time')),
	CONSTRAINT "materials_unit_check" CHECK ((dimension, unit) in (('mass', 'mg'), ('mass', 'g'), ('mass', 'kg'), ('volume', 'ml'), ('volume', 'l'), ('count', 'piece'), ('length', 'mm'), ('length', 'cm'), ('length', 'm'), ('area', 'mm2'), ('area', 'cm2'), ('area', 'm2'), ('time', 's'), ('time', 'min'), ('time', 'h')))
);
--> statement-breakpoint
CREATE TABLE "app"."product_locations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"request_hash" text,
	CONSTRAINT "product_locations_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "product_locations_product_location_key" UNIQUE("business_id","product_id","location_id")
);
--> statement-breakpoint
CREATE TABLE "app"."products_services" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"type" text NOT NULL,
	"unit" text NOT NULL,
	"default_price" numeric(20, 4),
	"vat_category" text DEFAULT 'standard' NOT NULL,
	"price_includes_vat" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"request_hash" text,
	CONSTRAINT "products_services_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "products_services_name_check" CHECK (btrim(name) <> '' and char_length(name) <= 100),
	CONSTRAINT "products_services_description_check" CHECK (char_length(description) <= 1000),
	CONSTRAINT "products_services_type_check" CHECK (type in ('product', 'service')),
	CONSTRAINT "products_services_unit_check" CHECK (unit in ('mg', 'g', 'kg', 'ml', 'l', 'piece', 'mm', 'cm', 'm', 'mm2', 'cm2', 'm2', 's', 'min', 'h')),
	CONSTRAINT "products_services_default_price_check" CHECK (default_price >= 0),
	CONSTRAINT "products_services_vat_category_check" CHECK (vat_category in ('standard', 'zero_rated', 'exempt'))
);
--> statement-breakpoint
ALTER TABLE "app"."material_units" ADD CONSTRAINT "material_units_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."material_units" ADD CONSTRAINT "material_units_material_fk" FOREIGN KEY ("business_id","material_id") REFERENCES "app"."materials"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."material_units" ADD CONSTRAINT "material_units_of_pack_fk" FOREIGN KEY ("business_id","material_id","of_pack_id") REFERENCES "app"."material_units"("business_id","material_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."materials" ADD CONSTRAINT "materials_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."product_locations" ADD CONSTRAINT "product_locations_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."product_locations" ADD CONSTRAINT "product_locations_product_fk" FOREIGN KEY ("business_id","product_id") REFERENCES "app"."products_services"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."product_locations" ADD CONSTRAINT "product_locations_location_fk" FOREIGN KEY ("business_id","location_id") REFERENCES "app"."locations"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."products_services" ADD CONSTRAINT "products_services_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "materials_name_key" ON "app"."materials" USING btree ("business_id",lower(name)) WHERE deleted_at is null;--> statement-breakpoint
CREATE INDEX "product_locations_location_idx" ON "app"."product_locations" USING btree ("business_id","location_id");--> statement-breakpoint
CREATE UNIQUE INDEX "products_services_name_key" ON "app"."products_services" USING btree ("business_id",lower(name)) WHERE deleted_at is null;
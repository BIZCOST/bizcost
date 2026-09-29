CREATE TABLE "app"."recipe_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"recipe_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"material_id" uuid NOT NULL,
	"qty" numeric(24, 6) NOT NULL,
	"unit" text,
	"pack_id" uuid,
	"base_qty" numeric(24, 6) NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"request_hash" text,
	CONSTRAINT "recipe_lines_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "recipe_lines_unit_check" CHECK (num_nonnulls(unit, pack_id) = 1),
	CONSTRAINT "recipe_lines_unit_code_check" CHECK (unit in ('mg', 'g', 'kg', 'ml', 'l', 'piece', 'mm', 'cm', 'm', 'mm2', 'cm2', 'm2', 's', 'min', 'h')),
	CONSTRAINT "recipe_lines_position_check" CHECK (position >= 0),
	CONSTRAINT "recipe_lines_qty_check" CHECK (qty > 0),
	CONSTRAINT "recipe_lines_base_qty_check" CHECK (base_qty > 0)
);
--> statement-breakpoint
CREATE TABLE "app"."recipes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"request_hash" text,
	CONSTRAINT "recipes_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "recipes_product_key" UNIQUE("business_id","product_id")
);
--> statement-breakpoint
ALTER TABLE "app"."products_services" ADD COLUMN "resale_material_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."recipe_lines" ADD CONSTRAINT "recipe_lines_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."recipe_lines" ADD CONSTRAINT "recipe_lines_recipe_fk" FOREIGN KEY ("business_id","recipe_id") REFERENCES "app"."recipes"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."recipe_lines" ADD CONSTRAINT "recipe_lines_material_fk" FOREIGN KEY ("business_id","material_id") REFERENCES "app"."materials"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."recipe_lines" ADD CONSTRAINT "recipe_lines_pack_fk" FOREIGN KEY ("business_id","material_id","pack_id") REFERENCES "app"."material_units"("business_id","material_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."recipes" ADD CONSTRAINT "recipes_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."recipes" ADD CONSTRAINT "recipes_product_fk" FOREIGN KEY ("business_id","product_id") REFERENCES "app"."products_services"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recipe_lines_material_key" ON "app"."recipe_lines" USING btree ("business_id","recipe_id","material_id") WHERE deleted_at is null;--> statement-breakpoint
CREATE INDEX "recipe_lines_material_idx" ON "app"."recipe_lines" USING btree ("business_id","material_id");--> statement-breakpoint
ALTER TABLE "app"."products_services" ADD CONSTRAINT "products_services_resale_material_fk" FOREIGN KEY ("business_id","resale_material_id") REFERENCES "app"."materials"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "products_services_resale_material_key" ON "app"."products_services" USING btree ("business_id","resale_material_id") WHERE resale_material_id is not null;--> statement-breakpoint
ALTER TABLE "app"."products_services" ADD CONSTRAINT "products_services_resale_check" CHECK (resale_material_id is null or type = 'product');
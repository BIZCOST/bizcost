CREATE TABLE "app"."attachments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"entity" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"path" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"request_hash" text,
	CONSTRAINT "attachments_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "attachments_business_id_path_key" UNIQUE("business_id","path"),
	CONSTRAINT "attachments_entity_check" CHECK (entity in ('purchase')),
	CONSTRAINT "attachments_path_check" CHECK (starts_with(path, business_id::text || '/')),
	CONSTRAINT "attachments_file_name_check" CHECK (btrim(file_name) <> '' and char_length(file_name) <= 200),
	CONSTRAINT "attachments_size_check" CHECK (size_bytes > 0)
);
--> statement-breakpoint
CREATE TABLE "app"."purchase_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"purchase_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"kind" text NOT NULL,
	"material_id" uuid,
	"description" text,
	"qty" numeric(24, 6) NOT NULL,
	"unit" text,
	"pack_id" uuid,
	"unit_price" numeric(20, 4) NOT NULL,
	"discount_percent" numeric(9, 6),
	"discount_amount" numeric(20, 4),
	"vat_rate" numeric(9, 6) DEFAULT '0' NOT NULL,
	"subtotal" numeric(20, 4) DEFAULT '0' NOT NULL,
	"discount" numeric(20, 4) DEFAULT '0' NOT NULL,
	"net" numeric(20, 4) DEFAULT '0' NOT NULL,
	"document_discount" numeric(20, 4) DEFAULT '0' NOT NULL,
	"taxable" numeric(20, 4) DEFAULT '0' NOT NULL,
	"vat" numeric(20, 4) DEFAULT '0' NOT NULL,
	"total" numeric(20, 4) DEFAULT '0' NOT NULL,
	"base_qty" numeric(24, 6),
	"delivery_share" numeric(20, 4),
	"cost" numeric(20, 4),
	"created_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"request_hash" text,
	CONSTRAINT "purchase_lines_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "purchase_lines_purchase_id_key" UNIQUE("business_id","purchase_id","id"),
	CONSTRAINT "purchase_lines_kind_check" CHECK (kind in ('material', 'delivery')),
	CONSTRAINT "purchase_lines_material_check" CHECK ((kind = 'material') = (material_id is not null)),
	CONSTRAINT "purchase_lines_unit_check" CHECK (case kind when 'material' then num_nonnulls(unit, pack_id) = 1
        else unit is null and pack_id is null and qty = 1
          and discount_percent is null and discount_amount is null end),
	CONSTRAINT "purchase_lines_unit_code_check" CHECK (unit in ('mg', 'g', 'kg', 'ml', 'l', 'piece', 'mm', 'cm', 'm', 'mm2', 'cm2', 'm2', 's', 'min', 'h')),
	CONSTRAINT "purchase_lines_position_check" CHECK (position >= 0),
	CONSTRAINT "purchase_lines_qty_check" CHECK (qty > 0),
	CONSTRAINT "purchase_lines_unit_price_check" CHECK (unit_price >= 0),
	CONSTRAINT "purchase_lines_discount_check" CHECK (num_nonnulls(discount_percent, discount_amount) <= 1
        and discount_percent between 0 and 100 and discount_amount >= 0),
	CONSTRAINT "purchase_lines_vat_rate_check" CHECK (vat_rate between 0 and 100),
	CONSTRAINT "purchase_lines_description_check" CHECK (btrim(description) <> '' and char_length(description) <= 200),
	CONSTRAINT "purchase_lines_base_qty_check" CHECK (base_qty > 0)
);
--> statement-breakpoint
CREATE TABLE "app"."purchase_return_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"return_id" uuid NOT NULL,
	"purchase_id" uuid NOT NULL,
	"purchase_line_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"qty" numeric(24, 6),
	"amount" numeric(20, 4),
	"net" numeric(20, 4) DEFAULT '0' NOT NULL,
	"vat" numeric(20, 4) DEFAULT '0' NOT NULL,
	"base_qty" numeric(24, 6),
	"cost" numeric(28, 12),
	"created_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"request_hash" text,
	CONSTRAINT "purchase_return_lines_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "purchase_return_lines_what_check" CHECK (num_nonnulls(qty, amount) = 1),
	CONSTRAINT "purchase_return_lines_qty_check" CHECK (qty > 0),
	CONSTRAINT "purchase_return_lines_amount_check" CHECK (amount > 0),
	CONSTRAINT "purchase_return_lines_position_check" CHECK (position >= 0),
	CONSTRAINT "purchase_return_lines_base_qty_check" CHECK (base_qty > 0)
);
--> statement-breakpoint
CREATE TABLE "app"."purchase_returns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"purchase_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"business_date" date NOT NULL,
	"reference" text,
	"notes" text,
	"currency" char(3) NOT NULL,
	"split_amount" numeric(20, 4),
	"net_total" numeric(20, 4) DEFAULT '0' NOT NULL,
	"vat_total" numeric(20, 4) DEFAULT '0' NOT NULL,
	"total" numeric(20, 4) DEFAULT '0' NOT NULL,
	"cost_total" numeric(28, 12),
	"posted_at" timestamp with time zone,
	"posted_by" uuid,
	"reversed_at" timestamp with time zone,
	"reversed_by" uuid,
	"reversal_date" date,
	"created_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"request_hash" text,
	CONSTRAINT "purchase_returns_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "purchase_returns_purchase_id_key" UNIQUE("business_id","purchase_id","id"),
	CONSTRAINT "purchase_returns_kind_check" CHECK (kind in ('return', 'credit_note')),
	CONSTRAINT "purchase_returns_status_check" CHECK (status in ('draft', 'posted', 'reversed')),
	CONSTRAINT "purchase_returns_currency_check" CHECK (currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "purchase_returns_split_amount_check" CHECK (split_amount is null or (kind = 'credit_note' and split_amount > 0)),
	CONSTRAINT "purchase_returns_reference_check" CHECK (btrim(reference) <> '' and char_length(reference) <= 100),
	CONSTRAINT "purchase_returns_notes_check" CHECK (char_length(notes) <= 1000),
	CONSTRAINT "purchase_returns_posted_check" CHECK ((status = 'draft') = (posted_at is null)
        and (status = 'draft') = (posted_by is null)
        and (status = 'draft') = (cost_total is null)),
	CONSTRAINT "purchase_returns_reversed_check" CHECK ((status = 'reversed') = (reversed_at is not null)
        and (status = 'reversed') = (reversed_by is not null)
        and (status = 'reversed') = (reversal_date is not null))
);
--> statement-breakpoint
CREATE TABLE "app"."purchases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"supplier_id" uuid,
	"location_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"document_type" text NOT NULL,
	"reference" text,
	"payment_method" text,
	"vat_not_reclaimable" boolean DEFAULT false NOT NULL,
	"currency" char(3) NOT NULL,
	"discount_percent" numeric(9, 6),
	"discount_amount" numeric(20, 4),
	"notes" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"subtotal" numeric(20, 4) DEFAULT '0' NOT NULL,
	"document_discount" numeric(20, 4) DEFAULT '0' NOT NULL,
	"discount_total" numeric(20, 4) DEFAULT '0' NOT NULL,
	"net_total" numeric(20, 4) DEFAULT '0' NOT NULL,
	"vat_total" numeric(20, 4) DEFAULT '0' NOT NULL,
	"total" numeric(20, 4) DEFAULT '0' NOT NULL,
	"vat_in_cost" boolean,
	"cost_total" numeric(20, 4),
	"posted_at" timestamp with time zone,
	"posted_by" uuid,
	"reversed_at" timestamp with time zone,
	"reversed_by" uuid,
	"reversal_date" date,
	"copied_from_id" uuid,
	"created_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"request_hash" text,
	CONSTRAINT "purchases_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "purchases_document_type_check" CHECK (document_type in ('tax_invoice', 'non_tax_invoice', 'no_invoice')),
	CONSTRAINT "purchases_payment_method_check" CHECK (payment_method in ('cash', 'card', 'bank_transfer', 'cheque', 'other')),
	CONSTRAINT "purchases_status_check" CHECK (status in ('draft', 'posted', 'reversed')),
	CONSTRAINT "purchases_currency_check" CHECK (currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "purchases_discount_check" CHECK (num_nonnulls(discount_percent, discount_amount) <= 1
        and discount_percent between 0 and 100 and discount_amount >= 0),
	CONSTRAINT "purchases_reference_check" CHECK (btrim(reference) <> '' and char_length(reference) <= 100),
	CONSTRAINT "purchases_notes_check" CHECK (char_length(notes) <= 1000),
	CONSTRAINT "purchases_posted_check" CHECK ((status = 'draft') = (posted_at is null)
        and (status = 'draft') = (posted_by is null)
        and (status = 'draft') = (vat_in_cost is null)
        and (status = 'draft') = (cost_total is null)),
	CONSTRAINT "purchases_reversed_check" CHECK ((status = 'reversed') = (reversed_at is not null)
        and (status = 'reversed') = (reversed_by is not null)
        and (status = 'reversed') = (reversal_date is not null)),
	CONSTRAINT "purchases_copied_from_check" CHECK (copied_from_id <> id)
);
--> statement-breakpoint
CREATE TABLE "app"."material_costs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"material_id" uuid NOT NULL,
	"qty" numeric(24, 6) DEFAULT '0' NOT NULL,
	"value" numeric(28, 12) DEFAULT '0' NOT NULL,
	"avg_cost" numeric(28, 12),
	"last_seq" bigint,
	"created_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"request_hash" text,
	CONSTRAINT "material_costs_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "material_costs_material_key" UNIQUE("business_id","material_id")
);
--> statement-breakpoint
CREATE TABLE "app"."stock_balances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"material_id" uuid NOT NULL,
	"qty" numeric(24, 6) DEFAULT '0' NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"request_hash" text,
	CONSTRAINT "stock_balances_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "stock_balances_location_material_key" UNIQUE("business_id","location_id","material_id")
);
--> statement-breakpoint
CREATE TABLE "app"."stock_movements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "app"."stock_movements_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"business_date" date NOT NULL,
	"location_id" uuid NOT NULL,
	"material_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"qty" numeric(24, 6) NOT NULL,
	"value" numeric(28, 12) NOT NULL,
	"adjustment" numeric(28, 12) DEFAULT '0' NOT NULL,
	"unit_cost" numeric(28, 12),
	"purchase_line_id" uuid,
	"return_line_id" uuid,
	"receipt_id" uuid,
	"reverses_id" uuid,
	"created_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"request_hash" text,
	CONSTRAINT "stock_movements_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "stock_movements_kind_check" CHECK (kind in ('purchase', 'purchase_return', 'purchase_credit', 'reversal')),
	CONSTRAINT "stock_movements_shape_check" CHECK (case kind
        when 'purchase' then qty > 0 and value >= 0 and purchase_line_id is not null
          and return_line_id is null and receipt_id is null and reverses_id is null
        when 'purchase_return' then qty < 0 and value <= 0 and purchase_line_id is not null
          and return_line_id is not null and receipt_id is not null and reverses_id is null
        when 'purchase_credit' then qty = 0 and value < 0 and purchase_line_id is not null
          and return_line_id is not null and receipt_id is not null and reverses_id is null
        else reverses_id is not null and receipt_id is null
      end)
);
--> statement-breakpoint
CREATE TABLE "app"."suppliers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"email" text,
	"trn" text,
	"notes" text,
	"archived_at" timestamp with time zone,
	"created_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"request_hash" text,
	CONSTRAINT "suppliers_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "suppliers_name_check" CHECK (btrim(name) <> '' and char_length(name) <= 100),
	CONSTRAINT "suppliers_phone_check" CHECK (btrim(phone) <> '' and char_length(phone) <= 30),
	CONSTRAINT "suppliers_email_check" CHECK (btrim(email) <> '' and char_length(email) <= 254),
	CONSTRAINT "suppliers_trn_check" CHECK (trn ~ '^[0-9]{15}$'),
	CONSTRAINT "suppliers_notes_check" CHECK (char_length(notes) <= 1000)
);
--> statement-breakpoint
ALTER TABLE "app"."file_uploads" DROP CONSTRAINT "file_uploads_purpose_check";--> statement-breakpoint
ALTER TABLE "app"."businesses" ADD COLUMN "books_closed_through" date;--> statement-breakpoint
ALTER TABLE "app"."attachments" ADD CONSTRAINT "attachments_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."purchase_lines" ADD CONSTRAINT "purchase_lines_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."purchase_lines" ADD CONSTRAINT "purchase_lines_purchase_fk" FOREIGN KEY ("business_id","purchase_id") REFERENCES "app"."purchases"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."purchase_lines" ADD CONSTRAINT "purchase_lines_material_fk" FOREIGN KEY ("business_id","material_id") REFERENCES "app"."materials"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."purchase_lines" ADD CONSTRAINT "purchase_lines_pack_fk" FOREIGN KEY ("business_id","material_id","pack_id") REFERENCES "app"."material_units"("business_id","material_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."purchase_return_lines" ADD CONSTRAINT "purchase_return_lines_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."purchase_return_lines" ADD CONSTRAINT "purchase_return_lines_return_fk" FOREIGN KEY ("business_id","purchase_id","return_id") REFERENCES "app"."purchase_returns"("business_id","purchase_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."purchase_return_lines" ADD CONSTRAINT "purchase_return_lines_purchase_line_fk" FOREIGN KEY ("business_id","purchase_id","purchase_line_id") REFERENCES "app"."purchase_lines"("business_id","purchase_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."purchase_return_lines" ADD CONSTRAINT "purchase_return_lines_purchase_fk" FOREIGN KEY ("business_id","purchase_id") REFERENCES "app"."purchases"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."purchase_returns" ADD CONSTRAINT "purchase_returns_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."purchase_returns" ADD CONSTRAINT "purchase_returns_purchase_fk" FOREIGN KEY ("business_id","purchase_id") REFERENCES "app"."purchases"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."purchases" ADD CONSTRAINT "purchases_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."purchases" ADD CONSTRAINT "purchases_supplier_fk" FOREIGN KEY ("business_id","supplier_id") REFERENCES "app"."suppliers"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."purchases" ADD CONSTRAINT "purchases_location_fk" FOREIGN KEY ("business_id","location_id") REFERENCES "app"."locations"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."purchases" ADD CONSTRAINT "purchases_copied_from_fk" FOREIGN KEY ("business_id","copied_from_id") REFERENCES "app"."purchases"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."material_costs" ADD CONSTRAINT "material_costs_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."material_costs" ADD CONSTRAINT "material_costs_material_fk" FOREIGN KEY ("business_id","material_id") REFERENCES "app"."materials"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."stock_balances" ADD CONSTRAINT "stock_balances_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."stock_balances" ADD CONSTRAINT "stock_balances_location_fk" FOREIGN KEY ("business_id","location_id") REFERENCES "app"."locations"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."stock_balances" ADD CONSTRAINT "stock_balances_material_fk" FOREIGN KEY ("business_id","material_id") REFERENCES "app"."materials"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."stock_movements" ADD CONSTRAINT "stock_movements_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."stock_movements" ADD CONSTRAINT "stock_movements_location_fk" FOREIGN KEY ("business_id","location_id") REFERENCES "app"."locations"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."stock_movements" ADD CONSTRAINT "stock_movements_material_fk" FOREIGN KEY ("business_id","material_id") REFERENCES "app"."materials"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."stock_movements" ADD CONSTRAINT "stock_movements_purchase_line_fk" FOREIGN KEY ("business_id","purchase_line_id") REFERENCES "app"."purchase_lines"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."stock_movements" ADD CONSTRAINT "stock_movements_return_line_fk" FOREIGN KEY ("business_id","return_line_id") REFERENCES "app"."purchase_return_lines"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."stock_movements" ADD CONSTRAINT "stock_movements_receipt_fk" FOREIGN KEY ("business_id","receipt_id") REFERENCES "app"."stock_movements"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."stock_movements" ADD CONSTRAINT "stock_movements_reverses_fk" FOREIGN KEY ("business_id","reverses_id") REFERENCES "app"."stock_movements"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."suppliers" ADD CONSTRAINT "suppliers_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_entity_idx" ON "app"."attachments" USING btree ("business_id","entity","entity_id");--> statement-breakpoint
CREATE INDEX "purchase_lines_material_idx" ON "app"."purchase_lines" USING btree ("business_id","material_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_return_lines_line_key" ON "app"."purchase_return_lines" USING btree ("business_id","return_id","purchase_line_id") WHERE deleted_at is null;--> statement-breakpoint
CREATE INDEX "purchase_return_lines_purchase_line_idx" ON "app"."purchase_return_lines" USING btree ("business_id","purchase_line_id");--> statement-breakpoint
CREATE INDEX "purchase_returns_business_date_idx" ON "app"."purchase_returns" USING btree ("business_id","business_date","id");--> statement-breakpoint
CREATE INDEX "purchases_business_date_idx" ON "app"."purchases" USING btree ("business_id","business_date","id");--> statement-breakpoint
CREATE INDEX "purchases_supplier_idx" ON "app"."purchases" USING btree ("business_id","supplier_id");--> statement-breakpoint
CREATE INDEX "stock_balances_material_idx" ON "app"."stock_balances" USING btree ("business_id","material_id");--> statement-breakpoint
CREATE INDEX "stock_movements_material_seq_idx" ON "app"."stock_movements" USING btree ("business_id","material_id","seq");--> statement-breakpoint
CREATE INDEX "stock_movements_material_date_idx" ON "app"."stock_movements" USING btree ("business_id","material_id","business_date");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_movements_purchase_line_key" ON "app"."stock_movements" USING btree ("business_id","purchase_line_id") WHERE kind = 'purchase';--> statement-breakpoint
CREATE UNIQUE INDEX "stock_movements_return_line_key" ON "app"."stock_movements" USING btree ("business_id","return_line_id") WHERE kind in ('purchase_return', 'purchase_credit');--> statement-breakpoint
CREATE UNIQUE INDEX "stock_movements_reverses_key" ON "app"."stock_movements" USING btree ("business_id","reverses_id") WHERE reverses_id is not null;--> statement-breakpoint
CREATE INDEX "stock_movements_receipt_idx" ON "app"."stock_movements" USING btree ("business_id","receipt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_name_key" ON "app"."suppliers" USING btree ("business_id",lower(name)) WHERE deleted_at is null;--> statement-breakpoint
ALTER TABLE "app"."file_uploads" ADD CONSTRAINT "file_uploads_purpose_check" CHECK (purpose in ('logo', 'attachment'));
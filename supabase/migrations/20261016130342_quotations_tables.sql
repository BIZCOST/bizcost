-- BizCost: Quotations, document numbers and PDFs (M3 Step 7; drizzle-kit generated, then edited: the
-- counters' first number is added empty, filled for the order series that exist, then made NOT NULL).
CREATE TABLE "app"."document_renders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"document_id" uuid NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"request_hash" text,
	CONSTRAINT "document_renders_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "document_renders_kind_check" CHECK (kind in ('quotation'))
);
--> statement-breakpoint
CREATE TABLE "app"."quotation_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"quotation_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"product_id" uuid,
	"area" text,
	"description" text NOT NULL,
	"details" text,
	"note" text,
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
	"created_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"request_hash" text,
	CONSTRAINT "quotation_lines_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "quotation_lines_position_check" CHECK (position >= 0),
	CONSTRAINT "quotation_lines_area_check" CHECK (btrim(area) <> '' and char_length(area) <= 60),
	CONSTRAINT "quotation_lines_description_check" CHECK (btrim(description) <> '' and char_length(description) <= 200),
	CONSTRAINT "quotation_lines_details_check" CHECK (btrim(details) <> '' and char_length(details) <= 2000),
	CONSTRAINT "quotation_lines_note_check" CHECK (btrim(note) <> '' and char_length(note) <= 500),
	CONSTRAINT "quotation_lines_qty_check" CHECK (qty > 0),
	CONSTRAINT "quotation_lines_unit_check" CHECK (unit in ('mg', 'g', 'kg', 'ml', 'l', 'piece', 'mm', 'cm', 'm', 'mm2', 'cm2', 'm2', 's', 'min', 'h')),
	CONSTRAINT "quotation_lines_unit_price_check" CHECK (unit_price >= 0),
	CONSTRAINT "quotation_lines_discount_check" CHECK (num_nonnulls(discount_percent, discount_amount) <= 1
        and discount_percent between 0 and 100 and discount_amount >= 0),
	CONSTRAINT "quotation_lines_vat_category_check" CHECK (vat_category in ('standard', 'zero_rated', 'exempt')),
	CONSTRAINT "quotation_lines_vat_rate_check" CHECK (vat_rate between 0 and 100),
	CONSTRAINT "quotation_lines_vat_check" CHECK ((vat_category is null) = (vat_rate is null))
);
--> statement-breakpoint
CREATE TABLE "app"."quotation_stages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"quotation_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"label" text,
	"due" text NOT NULL,
	"percent" numeric(9, 6) NOT NULL,
	"amount" numeric(20, 4) NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"request_hash" text,
	CONSTRAINT "quotation_stages_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "quotation_stages_position_check" CHECK (position >= 0),
	CONSTRAINT "quotation_stages_label_check" CHECK (btrim(label) <> '' and char_length(label) <= 100),
	CONSTRAINT "quotation_stages_due_check" CHECK (btrim(due) <> '' and char_length(due) <= 100),
	CONSTRAINT "quotation_stages_percent_check" CHECK (percent > 0 and percent <= 100),
	CONSTRAINT "quotation_stages_amount_check" CHECK (amount >= 0)
);
--> statement-breakpoint
CREATE TABLE "app"."quotations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"number" text NOT NULL,
	"root_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"customer_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"valid_until" date,
	"customer_ref" text,
	"site" text,
	"vat_registered" boolean DEFAULT false NOT NULL,
	"currency" char(3) NOT NULL,
	"discount_percent" numeric(9, 6),
	"discount_amount" numeric(20, 4),
	"round_to" numeric(20, 4),
	"adjustment" numeric(20, 4) DEFAULT '0' NOT NULL,
	"rounding_difference" numeric(20, 4) DEFAULT '0' NOT NULL,
	"subtotal" numeric(20, 4) DEFAULT '0' NOT NULL,
	"discount_total" numeric(20, 4) DEFAULT '0' NOT NULL,
	"net_total" numeric(20, 4) DEFAULT '0' NOT NULL,
	"vat_total" numeric(20, 4) DEFAULT '0' NOT NULL,
	"total" numeric(20, 4) DEFAULT '0' NOT NULL,
	"payable" numeric(20, 4) DEFAULT '0' NOT NULL,
	"vat_rates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"intro" text,
	"terms" text,
	"notes" text,
	"sent_at" timestamp with time zone,
	"sent_by" uuid,
	"accepted_at" timestamp with time zone,
	"accepted_by" uuid,
	"accept_note" text,
	"declined_at" timestamp with time zone,
	"declined_by" uuid,
	"decline_reason" text,
	"superseded_at" timestamp with time zone,
	"order_id" uuid,
	"invoice_id" uuid,
	"copied_from_id" uuid,
	"created_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"request_hash" text,
	CONSTRAINT "quotations_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "quotations_seq_key" UNIQUE("business_id","seq","revision"),
	CONSTRAINT "quotations_revision_key" UNIQUE("business_id","root_id","revision"),
	CONSTRAINT "quotations_status_check" CHECK (status in ('draft', 'sent', 'accepted', 'declined', 'superseded')),
	CONSTRAINT "quotations_seq_check" CHECK (seq >= 1),
	CONSTRAINT "quotations_revision_check" CHECK (revision >= 1 and (revision = 1) = (root_id = id)),
	CONSTRAINT "quotations_number_check" CHECK (btrim(number) <> '' and char_length(number) <= 40),
	CONSTRAINT "quotations_customer_ref_check" CHECK (btrim(customer_ref) <> '' and char_length(customer_ref) <= 100),
	CONSTRAINT "quotations_site_check" CHECK (btrim(site) <> '' and char_length(site) <= 200),
	CONSTRAINT "quotations_valid_until_check" CHECK (valid_until >= business_date),
	CONSTRAINT "quotations_currency_check" CHECK (currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "quotations_discount_check" CHECK (num_nonnulls(discount_percent, discount_amount) <= 1
        and discount_percent between 0 and 100 and discount_amount >= 0),
	CONSTRAINT "quotations_round_check" CHECK (round_to >= 0 and (round_to is not null or (adjustment = 0 and rounding_difference = 0))),
	CONSTRAINT "quotations_vat_rates_check" CHECK (jsonb_typeof(vat_rates) = 'array'),
	CONSTRAINT "quotations_intro_check" CHECK (btrim(intro) <> '' and char_length(intro) <= 1000),
	CONSTRAINT "quotations_terms_check" CHECK (btrim(terms) <> '' and char_length(terms) <= 4000),
	CONSTRAINT "quotations_notes_check" CHECK (btrim(notes) <> '' and char_length(notes) <= 1000),
	CONSTRAINT "quotations_sent_check" CHECK ((status <> 'draft') = (sent_at is not null) and (sent_at is null) = (sent_by is null)),
	CONSTRAINT "quotations_accepted_check" CHECK ((accepted_at is null) = (accepted_by is null)
        and (status <> 'accepted' or accepted_at is not null)
        and (accept_note is null or accepted_at is not null)),
	CONSTRAINT "quotations_declined_check" CHECK ((declined_at is null) = (declined_by is null)
        and (status <> 'declined' or declined_at is not null)
        and (decline_reason is null or declined_at is not null)
        and (accepted_at is null or declined_at is null)),
	CONSTRAINT "quotations_superseded_check" CHECK ((status = 'superseded') = (superseded_at is not null)),
	CONSTRAINT "quotations_order_check" CHECK (order_id is null or accepted_at is not null),
	CONSTRAINT "quotations_accept_note_check" CHECK (btrim(accept_note) <> '' and char_length(accept_note) <= 500),
	CONSTRAINT "quotations_decline_reason_check" CHECK (btrim(decline_reason) <> '' and char_length(decline_reason) <= 500),
	CONSTRAINT "quotations_copied_from_check" CHECK (copied_from_id <> id)
);
--> statement-breakpoint
ALTER TABLE "app"."document_counters" DROP CONSTRAINT "document_counters_series_check";--> statement-breakpoint
ALTER TABLE "app"."document_counters" DROP CONSTRAINT "document_counters_next_no_check";--> statement-breakpoint
ALTER TABLE "app"."attachments" DROP CONSTRAINT "attachments_entity_check";--> statement-breakpoint
ALTER TABLE "app"."file_uploads" DROP CONSTRAINT "file_uploads_purpose_check";--> statement-breakpoint
ALTER TABLE "app"."order_lines" DROP CONSTRAINT "order_lines_product_check";--> statement-breakpoint
ALTER TABLE "app"."sale_lines" DROP CONSTRAINT "sale_lines_product_check";--> statement-breakpoint
ALTER TABLE "app"."businesses" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "app"."businesses" ADD COLUMN "phone_2" text;--> statement-breakpoint
ALTER TABLE "app"."businesses" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "app"."businesses" ADD COLUMN "address_line" text;--> statement-breakpoint
ALTER TABLE "app"."businesses" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "app"."businesses" ADD COLUMN "emirate" text;--> statement-breakpoint
ALTER TABLE "app"."businesses" ADD COLUMN "trade_licence_no" text;--> statement-breakpoint
ALTER TABLE "app"."businesses" ADD COLUMN "trade_licence_authority" text;--> statement-breakpoint
ALTER TABLE "app"."businesses" ADD COLUMN "document_footer" text;--> statement-breakpoint
ALTER TABLE "app"."businesses" ADD COLUMN "quotation_terms" text;--> statement-breakpoint
ALTER TABLE "app"."businesses" ADD COLUMN "quotation_valid_days" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."businesses" ADD COLUMN "document_accent" text DEFAULT 'navy' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."businesses" ADD COLUMN "document_watermark" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."businesses" ADD COLUMN "document_whole_amounts" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."businesses" ADD COLUMN "document_signatory" text;--> statement-breakpoint
ALTER TABLE "app"."businesses" ADD COLUMN "document_signature_path" text;--> statement-breakpoint
ALTER TABLE "app"."businesses" ADD COLUMN "document_stamp_path" text;--> statement-breakpoint
ALTER TABLE "app"."document_counters" ADD COLUMN "first_no" integer;--> statement-breakpoint
-- Each counter that exists is an order series, which always started at 1001 (Step 5 had no settings
-- yet). touch_row is off for this one statement, so versions and "changed by" stay as they were (the
-- audit trigger records it).
ALTER TABLE "app"."document_counters" DISABLE TRIGGER "touch_row";--> statement-breakpoint
UPDATE "app"."document_counters" SET "first_no" = 1001 WHERE "first_no" IS NULL;--> statement-breakpoint
ALTER TABLE "app"."document_counters" ENABLE TRIGGER "touch_row";--> statement-breakpoint
ALTER TABLE "app"."document_counters" ALTER COLUMN "first_no" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."document_renders" ADD CONSTRAINT "document_renders_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."quotation_lines" ADD CONSTRAINT "quotation_lines_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."quotation_lines" ADD CONSTRAINT "quotation_lines_quotation_fk" FOREIGN KEY ("business_id","quotation_id") REFERENCES "app"."quotations"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."quotation_lines" ADD CONSTRAINT "quotation_lines_product_fk" FOREIGN KEY ("business_id","product_id") REFERENCES "app"."products_services"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."quotation_stages" ADD CONSTRAINT "quotation_stages_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."quotation_stages" ADD CONSTRAINT "quotation_stages_quotation_fk" FOREIGN KEY ("business_id","quotation_id") REFERENCES "app"."quotations"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."quotations" ADD CONSTRAINT "quotations_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."quotations" ADD CONSTRAINT "quotations_root_fk" FOREIGN KEY ("business_id","root_id") REFERENCES "app"."quotations"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."quotations" ADD CONSTRAINT "quotations_copied_from_fk" FOREIGN KEY ("business_id","copied_from_id") REFERENCES "app"."quotations"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."quotations" ADD CONSTRAINT "quotations_customer_fk" FOREIGN KEY ("business_id","customer_id") REFERENCES "app"."customers"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."quotations" ADD CONSTRAINT "quotations_location_fk" FOREIGN KEY ("business_id","location_id") REFERENCES "app"."locations"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."quotations" ADD CONSTRAINT "quotations_order_fk" FOREIGN KEY ("business_id","order_id") REFERENCES "app"."orders"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_renders_created_idx" ON "app"."document_renders" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE INDEX "document_renders_created_by_idx" ON "app"."document_renders" USING btree ("business_id","created_by","created_at");--> statement-breakpoint
CREATE INDEX "quotation_lines_quotation_idx" ON "app"."quotation_lines" USING btree ("business_id","quotation_id");--> statement-breakpoint
CREATE INDEX "quotation_lines_product_idx" ON "app"."quotation_lines" USING btree ("business_id","product_id");--> statement-breakpoint
CREATE INDEX "quotation_stages_quotation_idx" ON "app"."quotation_stages" USING btree ("business_id","quotation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quotations_draft_key" ON "app"."quotations" USING btree ("business_id","root_id") WHERE status = 'draft' and deleted_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "quotations_root_order_key" ON "app"."quotations" USING btree ("business_id","root_id") WHERE order_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "quotations_order_key" ON "app"."quotations" USING btree ("business_id","order_id") WHERE order_id is not null;--> statement-breakpoint
CREATE INDEX "quotations_list_idx" ON "app"."quotations" USING btree ("business_id","business_date","seq");--> statement-breakpoint
CREATE INDEX "quotations_status_idx" ON "app"."quotations" USING btree ("business_id","status");--> statement-breakpoint
CREATE INDEX "quotations_customer_idx" ON "app"."quotations" USING btree ("business_id","customer_id");--> statement-breakpoint
CREATE INDEX "quotations_root_idx" ON "app"."quotations" USING btree ("business_id","root_id");--> statement-breakpoint
CREATE INDEX "quotations_created_by_idx" ON "app"."quotations" USING btree ("business_id","created_by");--> statement-breakpoint
CREATE INDEX "quotations_location_idx" ON "app"."quotations" USING btree ("business_id","location_id");--> statement-breakpoint
CREATE INDEX "quotations_copied_from_idx" ON "app"."quotations" USING btree ("business_id","copied_from_id");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "app"."audit_log" USING btree ("business_id","entity_id","created_at");--> statement-breakpoint
ALTER TABLE "app"."businesses" ADD CONSTRAINT "businesses_phone_check" CHECK (btrim(phone) <> '' and char_length(phone) <= 30);--> statement-breakpoint
ALTER TABLE "app"."businesses" ADD CONSTRAINT "businesses_phone_2_check" CHECK (btrim(phone_2) <> '' and char_length(phone_2) <= 30);--> statement-breakpoint
ALTER TABLE "app"."businesses" ADD CONSTRAINT "businesses_email_check" CHECK (btrim(email) <> '' and char_length(email) <= 254);--> statement-breakpoint
ALTER TABLE "app"."businesses" ADD CONSTRAINT "businesses_address_check" CHECK (btrim(address_line) <> '' and char_length(address_line) <= 200);--> statement-breakpoint
ALTER TABLE "app"."businesses" ADD CONSTRAINT "businesses_city_check" CHECK (btrim(city) <> '' and char_length(city) <= 100);--> statement-breakpoint
ALTER TABLE "app"."businesses" ADD CONSTRAINT "businesses_emirate_check" CHECK (emirate is null or (emirate in ('abu_dhabi', 'dubai', 'sharjah', 'ajman', 'umm_al_quwain', 'ras_al_khaimah', 'fujairah') and country = 'AE'));--> statement-breakpoint
ALTER TABLE "app"."businesses" ADD CONSTRAINT "businesses_trade_licence_check" CHECK (btrim(trade_licence_no) <> '' and char_length(trade_licence_no) <= 50);--> statement-breakpoint
ALTER TABLE "app"."businesses" ADD CONSTRAINT "businesses_licence_authority_check" CHECK (btrim(trade_licence_authority) <> '' and char_length(trade_licence_authority) <= 100);--> statement-breakpoint
ALTER TABLE "app"."businesses" ADD CONSTRAINT "businesses_document_footer_check" CHECK (btrim(document_footer) <> '' and char_length(document_footer) <= 1000);--> statement-breakpoint
ALTER TABLE "app"."businesses" ADD CONSTRAINT "businesses_quotation_terms_check" CHECK (btrim(quotation_terms) <> '' and char_length(quotation_terms) <= 4000);--> statement-breakpoint
ALTER TABLE "app"."businesses" ADD CONSTRAINT "businesses_quotation_valid_days_check" CHECK (quotation_valid_days between 1 and 365);--> statement-breakpoint
ALTER TABLE "app"."businesses" ADD CONSTRAINT "businesses_document_accent_check" CHECK (document_accent in ('navy', 'black', 'teal', 'green', 'maroon', 'brown', 'slate'));--> statement-breakpoint
ALTER TABLE "app"."businesses" ADD CONSTRAINT "businesses_document_signatory_check" CHECK (btrim(document_signatory) <> '' and char_length(document_signatory) <= 100);--> statement-breakpoint
ALTER TABLE "app"."document_counters" ADD CONSTRAINT "document_counters_series_check" CHECK (series in ('order', 'quotation'));--> statement-breakpoint
ALTER TABLE "app"."document_counters" ADD CONSTRAINT "document_counters_next_no_check" CHECK (next_no >= 1 and first_no >= 1 and next_no >= first_no);--> statement-breakpoint
ALTER TABLE "app"."attachments" ADD CONSTRAINT "attachments_line_image_check" CHECK (entity <> 'quotation_line' or content_type in ('image/png', 'image/jpeg', 'image/webp'));--> statement-breakpoint
ALTER TABLE "app"."attachments" ADD CONSTRAINT "attachments_entity_check" CHECK (entity in ('purchase', 'expense', 'order', 'quotation', 'quotation_line'));--> statement-breakpoint
ALTER TABLE "app"."file_uploads" ADD CONSTRAINT "file_uploads_purpose_check" CHECK (purpose in ('logo', 'attachment', 'signature', 'stamp', 'document'));--> statement-breakpoint
ALTER TABLE "app"."order_lines" ADD CONSTRAINT "order_lines_product_check" CHECK ((kind = 'item' or product_id is null)
        and (product_id is not null or kind <> 'item' or description is not null));--> statement-breakpoint
ALTER TABLE "app"."sale_lines" ADD CONSTRAINT "sale_lines_product_check" CHECK ((kind = 'item' or product_id is null)
        and (product_id is not null or kind <> 'item' or description is not null));
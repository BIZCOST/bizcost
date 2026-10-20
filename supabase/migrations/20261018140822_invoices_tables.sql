CREATE TABLE "app"."credit_note_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"credit_note_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"invoice_line_id" uuid NOT NULL,
	"description" text NOT NULL,
	"qty" numeric(24, 6) NOT NULL,
	"unit" text,
	"unit_price" numeric(20, 4) NOT NULL,
	"price_includes_vat" boolean DEFAULT false NOT NULL,
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
	CONSTRAINT "credit_note_lines_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "credit_note_lines_position_check" CHECK (position >= 0),
	CONSTRAINT "credit_note_lines_description_check" CHECK (btrim(description) <> '' and char_length(description) <= 200),
	CONSTRAINT "credit_note_lines_qty_check" CHECK (qty > 0),
	CONSTRAINT "credit_note_lines_unit_check" CHECK (unit in ('mg', 'g', 'kg', 'ml', 'l', 'piece', 'mm', 'cm', 'm', 'mm2', 'cm2', 'm2', 's', 'min', 'h')),
	CONSTRAINT "credit_note_lines_unit_price_check" CHECK (unit_price >= 0),
	CONSTRAINT "credit_note_lines_discount_check" CHECK (discount_amount >= 0),
	CONSTRAINT "credit_note_lines_amounts_check" CHECK (net >= 0 and vat >= 0 and total >= 0 and total = net + vat),
	CONSTRAINT "credit_note_lines_vat_category_check" CHECK (vat_category in ('standard', 'zero_rated', 'exempt')),
	CONSTRAINT "credit_note_lines_vat_rate_check" CHECK (vat_rate between 0 and 100),
	CONSTRAINT "credit_note_lines_vat_check" CHECK ((vat_category is null) = (vat_rate is null))
);
--> statement-breakpoint
CREATE TABLE "app"."credit_notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"seq" integer,
	"number" text,
	"kind" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"invoice_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"issue_date" date,
	"event_date" date NOT NULL,
	"reason" text NOT NULL,
	"reason_text" text NOT NULL,
	"credit_by" text NOT NULL,
	"counted_elsewhere" boolean,
	"vat_registered" boolean DEFAULT false NOT NULL,
	"currency" char(3) NOT NULL,
	"net_total" numeric(20, 4) DEFAULT '0' NOT NULL,
	"vat_total" numeric(20, 4) DEFAULT '0' NOT NULL,
	"total" numeric(20, 4) DEFAULT '0' NOT NULL,
	"vat_rates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"value_before" numeric(20, 4),
	"value_after" numeric(20, 4),
	"notes" text,
	"counted_on" date,
	"issued_at" timestamp with time zone,
	"issued_by" uuid,
	"customer_name" text,
	"customer_kind" text,
	"customer_trn" text,
	"customer_trade_licence" text,
	"customer_address_line" text,
	"customer_city" text,
	"customer_emirate" text,
	"customer_country" char(2),
	"seller_name" text,
	"seller_name_ar" text,
	"seller_trn" text,
	"seller_trade_licence" text,
	"seller_trade_licence_authority" text,
	"seller_address_line" text,
	"seller_city" text,
	"seller_emirate" text,
	"letterhead" jsonb,
	"pdf_upload_id" uuid,
	"created_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"request_hash" text,
	CONSTRAINT "credit_notes_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "credit_notes_kind_check" CHECK (kind in ('tax_credit_note', 'credit_note')),
	CONSTRAINT "credit_notes_status_check" CHECK (status in ('draft', 'issued')),
	CONSTRAINT "credit_notes_reason_check" CHECK (reason in ('cancelled', 'tax_treatment_changed', 'price_changed', 'goods_returned', 'tax_charged_in_error')),
	CONSTRAINT "credit_notes_credit_by_check" CHECK (credit_by in ('quantity', 'amount')),
	CONSTRAINT "credit_notes_kind_vat_check" CHECK ((kind = 'tax_credit_note') = vat_registered),
	CONSTRAINT "credit_notes_issued_check" CHECK ((status = 'issued') = (seq is not null)
        and (status = 'issued') = (number is not null)
        and (status = 'issued') = (issue_date is not null)
        and (status = 'issued') = (issued_at is not null)
        and (status = 'issued') = (issued_by is not null)
        and (status = 'issued') = (value_before is not null)
        and (status = 'issued') = (value_after is not null)
        and (status = 'issued') = (customer_name is not null)
        and (status = 'issued') = (seller_name is not null)),
	CONSTRAINT "credit_notes_seq_check" CHECK (seq >= 1),
	CONSTRAINT "credit_notes_number_check" CHECK (btrim(number) <> '' and char_length(number) <= 40),
	CONSTRAINT "credit_notes_event_check" CHECK (event_date <= issue_date),
	CONSTRAINT "credit_notes_reason_text_check" CHECK (btrim(reason_text) <> '' and char_length(reason_text) <= 500),
	CONSTRAINT "credit_notes_currency_check" CHECK (currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "credit_notes_amounts_check" CHECK (net_total >= 0 and vat_total >= 0 and total >= 0
        and value_before >= 0 and value_after >= 0 and value_after <= value_before),
	CONSTRAINT "credit_notes_vat_rates_check" CHECK (jsonb_typeof(vat_rates) = 'array'),
	CONSTRAINT "credit_notes_letterhead_check" CHECK (jsonb_typeof(letterhead) = 'object'),
	CONSTRAINT "credit_notes_notes_check" CHECK (btrim(notes) <> '' and char_length(notes) <= 1000),
	CONSTRAINT "credit_notes_customer_kind_check" CHECK (customer_kind in ('individual', 'business', 'government')),
	CONSTRAINT "credit_notes_customer_emirate_check" CHECK (customer_emirate in ('abu_dhabi', 'dubai', 'sharjah', 'ajman', 'umm_al_quwain', 'ras_al_khaimah', 'fujairah')),
	CONSTRAINT "credit_notes_seller_emirate_check" CHECK (seller_emirate in ('abu_dhabi', 'dubai', 'sharjah', 'ajman', 'umm_al_quwain', 'ras_al_khaimah', 'fujairah')),
	CONSTRAINT "credit_notes_customer_trn_check" CHECK (customer_trn ~ '^[0-9]{15}$'),
	CONSTRAINT "credit_notes_seller_trn_check" CHECK (seller_trn ~ '^[0-9]{15}$'),
	CONSTRAINT "credit_notes_pdf_check" CHECK (pdf_upload_id is null or status = 'issued')
);
--> statement-breakpoint
CREATE TABLE "app"."invoice_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"kind" text NOT NULL,
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
	"deposit_invoice_id" uuid,
	"sale_line_id" uuid,
	"created_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"request_hash" text,
	CONSTRAINT "invoice_lines_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "invoice_lines_kind_check" CHECK (kind in ('item', 'delivery', 'deduction')),
	CONSTRAINT "invoice_lines_position_check" CHECK (position >= 0),
	CONSTRAINT "invoice_lines_product_check" CHECK (kind = 'item' or product_id is null),
	CONSTRAINT "invoice_lines_deduction_check" CHECK ((kind = 'deduction') = (deposit_invoice_id is not null)
        and (kind = 'deduction') = (qty < 0)
        and (kind <> 'deduction' or (qty = -1 and discount_percent is null
          and discount_amount is null))),
	CONSTRAINT "invoice_lines_delivery_check" CHECK (kind <> 'delivery' or (qty = 1 and unit is null
        and discount_percent is null and discount_amount is null)),
	CONSTRAINT "invoice_lines_area_check" CHECK (btrim(area) <> '' and char_length(area) <= 40),
	CONSTRAINT "invoice_lines_description_check" CHECK (btrim(description) <> '' and char_length(description) <= 200),
	CONSTRAINT "invoice_lines_details_check" CHECK (btrim(details) <> '' and char_length(details) <= 2000),
	CONSTRAINT "invoice_lines_note_check" CHECK (btrim(note) <> '' and char_length(note) <= 500),
	CONSTRAINT "invoice_lines_qty_check" CHECK (qty <> 0),
	CONSTRAINT "invoice_lines_unit_check" CHECK (unit in ('mg', 'g', 'kg', 'ml', 'l', 'piece', 'mm', 'cm', 'm', 'mm2', 'cm2', 'm2', 's', 'min', 'h')),
	CONSTRAINT "invoice_lines_unit_price_check" CHECK (unit_price >= 0),
	CONSTRAINT "invoice_lines_discount_check" CHECK (num_nonnulls(discount_percent, discount_amount) <= 1
        and discount_percent between 0 and 100 and discount_amount >= 0),
	CONSTRAINT "invoice_lines_vat_category_check" CHECK (vat_category in ('standard', 'zero_rated', 'exempt')),
	CONSTRAINT "invoice_lines_vat_rate_check" CHECK (vat_rate between 0 and 100),
	CONSTRAINT "invoice_lines_vat_check" CHECK ((vat_category is null) = (vat_rate is null))
);
--> statement-breakpoint
CREATE TABLE "app"."invoices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"seq" integer,
	"number" text,
	"kind" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"customer_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"channel_id" uuid,
	"issue_date" date,
	"supply_date" date,
	"due_date" date,
	"lpo_reference" text,
	"vat_registered" boolean DEFAULT false NOT NULL,
	"currency" char(3) NOT NULL,
	"quotation_id" uuid,
	"order_id" uuid,
	"sale_id" uuid,
	"bills" text DEFAULT 'everything' NOT NULL,
	"bill_percent" numeric(9, 6),
	"bill_amount" numeric(20, 4),
	"is_deposit" boolean DEFAULT false NOT NULL,
	"counted_elsewhere" boolean,
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
	"terms" text,
	"notes" text,
	"counted_on" date,
	"issued_at" timestamp with time zone,
	"issued_by" uuid,
	"customer_name" text,
	"customer_kind" text,
	"customer_trn" text,
	"customer_trade_licence" text,
	"customer_address_line" text,
	"customer_city" text,
	"customer_emirate" text,
	"customer_country" char(2),
	"seller_name" text,
	"seller_name_ar" text,
	"seller_trn" text,
	"seller_trade_licence" text,
	"seller_trade_licence_authority" text,
	"seller_address_line" text,
	"seller_city" text,
	"seller_emirate" text,
	"letterhead" jsonb,
	"pdf_upload_id" uuid,
	"created_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"request_hash" text,
	CONSTRAINT "invoices_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "invoices_kind_check" CHECK (kind in ('tax_invoice', 'invoice')),
	CONSTRAINT "invoices_status_check" CHECK (status in ('draft', 'issued')),
	CONSTRAINT "invoices_bills_check" CHECK (bills in ('everything', 'part', 'rest')),
	CONSTRAINT "invoices_kind_vat_check" CHECK ((kind = 'tax_invoice') = vat_registered),
	CONSTRAINT "invoices_tax_currency_check" CHECK (status <> 'issued' or kind <> 'tax_invoice' or currency = 'AED'),
	CONSTRAINT "invoices_issued_check" CHECK ((status = 'issued') = (seq is not null)
        and (status = 'issued') = (number is not null)
        and (status = 'issued') = (issue_date is not null)
        and (status <> 'issued' or supply_date is not null)
        and (status = 'issued') = (issued_at is not null)
        and (status = 'issued') = (issued_by is not null)
        and (status = 'issued') = (customer_name is not null)
        and (status = 'issued') = (seller_name is not null)),
	CONSTRAINT "invoices_seq_check" CHECK (seq >= 1),
	CONSTRAINT "invoices_number_check" CHECK (btrim(number) <> '' and char_length(number) <= 40),
	CONSTRAINT "invoices_supply_check" CHECK (supply_date <= issue_date),
	CONSTRAINT "invoices_due_check" CHECK (due_date >= issue_date),
	CONSTRAINT "invoices_counted_on_check" CHECK (counted_on >= supply_date),
	CONSTRAINT "invoices_lpo_check" CHECK (btrim(lpo_reference) <> '' and char_length(lpo_reference) <= 100),
	CONSTRAINT "invoices_currency_check" CHECK (currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "invoices_source_check" CHECK (num_nonnulls(quotation_id, order_id, sale_id) <= 1),
	CONSTRAINT "invoices_bill_check" CHECK ((bills = 'part') = (num_nonnulls(bill_percent, bill_amount) = 1)
        and num_nonnulls(bill_percent, bill_amount) <= 1
        and bill_percent > 0 and bill_percent <= 100 and bill_amount > 0
        and (bills = 'everything' or quotation_id is not null or order_id is not null)
        and (not is_deposit or bills = 'part')
        and (sale_id is null or (bills = 'everything' and not is_deposit))),
	CONSTRAINT "invoices_discount_check" CHECK (num_nonnulls(discount_percent, discount_amount) <= 1
        and discount_percent between 0 and 100 and discount_amount >= 0),
	CONSTRAINT "invoices_round_check" CHECK (round_to >= 0 and (round_to is not null or (adjustment = 0 and rounding_difference = 0))),
	CONSTRAINT "invoices_vat_rates_check" CHECK (jsonb_typeof(vat_rates) = 'array'),
	CONSTRAINT "invoices_letterhead_check" CHECK (jsonb_typeof(letterhead) = 'object'),
	CONSTRAINT "invoices_terms_check" CHECK (btrim(terms) <> '' and char_length(terms) <= 4000),
	CONSTRAINT "invoices_notes_check" CHECK (btrim(notes) <> '' and char_length(notes) <= 1000),
	CONSTRAINT "invoices_customer_kind_check" CHECK (customer_kind in ('individual', 'business', 'government')),
	CONSTRAINT "invoices_customer_emirate_check" CHECK (customer_emirate in ('abu_dhabi', 'dubai', 'sharjah', 'ajman', 'umm_al_quwain', 'ras_al_khaimah', 'fujairah')),
	CONSTRAINT "invoices_seller_emirate_check" CHECK (seller_emirate in ('abu_dhabi', 'dubai', 'sharjah', 'ajman', 'umm_al_quwain', 'ras_al_khaimah', 'fujairah')),
	CONSTRAINT "invoices_customer_trn_check" CHECK (customer_trn ~ '^[0-9]{15}$'),
	CONSTRAINT "invoices_seller_trn_check" CHECK (seller_trn ~ '^[0-9]{15}$'),
	CONSTRAINT "invoices_pdf_check" CHECK (pdf_upload_id is null or status = 'issued')
);
--> statement-breakpoint
ALTER TABLE "app"."document_counters" DROP CONSTRAINT "document_counters_series_check";--> statement-breakpoint
ALTER TABLE "app"."attachments" DROP CONSTRAINT "attachments_entity_check";--> statement-breakpoint
ALTER TABLE "app"."attachments" DROP CONSTRAINT "attachments_line_image_check";--> statement-breakpoint
ALTER TABLE "app"."customer_payments" DROP CONSTRAINT "customer_payments_document_check";--> statement-breakpoint
ALTER TABLE "app"."document_renders" DROP CONSTRAINT "document_renders_kind_check";--> statement-breakpoint
ALTER TABLE "app"."sales" DROP CONSTRAINT "sales_refund_check";--> statement-breakpoint
ALTER TABLE "app"."sales" DROP CONSTRAINT "sales_customer_check";--> statement-breakpoint
ALTER TABLE "app"."sales" DROP CONSTRAINT "sales_source_check";--> statement-breakpoint
ALTER TABLE "app"."customer_payments" ADD COLUMN "invoice_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."sales" ADD COLUMN "invoice_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."sales" ADD COLUMN "credit_note_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."credit_note_lines" ADD CONSTRAINT "credit_note_lines_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."credit_note_lines" ADD CONSTRAINT "credit_note_lines_credit_note_fk" FOREIGN KEY ("business_id","credit_note_id") REFERENCES "app"."credit_notes"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."credit_note_lines" ADD CONSTRAINT "credit_note_lines_invoice_line_fk" FOREIGN KEY ("business_id","invoice_line_id") REFERENCES "app"."invoice_lines"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."credit_notes" ADD CONSTRAINT "credit_notes_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."credit_notes" ADD CONSTRAINT "credit_notes_invoice_fk" FOREIGN KEY ("business_id","invoice_id") REFERENCES "app"."invoices"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."credit_notes" ADD CONSTRAINT "credit_notes_customer_fk" FOREIGN KEY ("business_id","customer_id") REFERENCES "app"."customers"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."credit_notes" ADD CONSTRAINT "credit_notes_location_fk" FOREIGN KEY ("business_id","location_id") REFERENCES "app"."locations"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."credit_notes" ADD CONSTRAINT "credit_notes_pdf_upload_fk" FOREIGN KEY ("business_id","pdf_upload_id") REFERENCES "app"."file_uploads"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."invoice_lines" ADD CONSTRAINT "invoice_lines_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_fk" FOREIGN KEY ("business_id","invoice_id") REFERENCES "app"."invoices"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."invoice_lines" ADD CONSTRAINT "invoice_lines_product_fk" FOREIGN KEY ("business_id","product_id") REFERENCES "app"."products_services"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."invoice_lines" ADD CONSTRAINT "invoice_lines_deposit_fk" FOREIGN KEY ("business_id","deposit_invoice_id") REFERENCES "app"."invoices"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."invoice_lines" ADD CONSTRAINT "invoice_lines_sale_line_fk" FOREIGN KEY ("business_id","sale_line_id") REFERENCES "app"."sale_lines"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."invoices" ADD CONSTRAINT "invoices_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."invoices" ADD CONSTRAINT "invoices_customer_fk" FOREIGN KEY ("business_id","customer_id") REFERENCES "app"."customers"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."invoices" ADD CONSTRAINT "invoices_location_fk" FOREIGN KEY ("business_id","location_id") REFERENCES "app"."locations"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."invoices" ADD CONSTRAINT "invoices_channel_fk" FOREIGN KEY ("business_id","channel_id") REFERENCES "app"."sales_channels"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."invoices" ADD CONSTRAINT "invoices_quotation_fk" FOREIGN KEY ("business_id","quotation_id") REFERENCES "app"."quotations"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."invoices" ADD CONSTRAINT "invoices_order_fk" FOREIGN KEY ("business_id","order_id") REFERENCES "app"."orders"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."invoices" ADD CONSTRAINT "invoices_sale_fk" FOREIGN KEY ("business_id","sale_id") REFERENCES "app"."sales"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."invoices" ADD CONSTRAINT "invoices_pdf_upload_fk" FOREIGN KEY ("business_id","pdf_upload_id") REFERENCES "app"."file_uploads"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_note_lines_credit_note_idx" ON "app"."credit_note_lines" USING btree ("business_id","credit_note_id");--> statement-breakpoint
CREATE INDEX "credit_note_lines_invoice_line_idx" ON "app"."credit_note_lines" USING btree ("business_id","invoice_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_notes_seq_key" ON "app"."credit_notes" USING btree ("business_id","seq") WHERE seq is not null;--> statement-breakpoint
CREATE INDEX "credit_notes_invoice_idx" ON "app"."credit_notes" USING btree ("business_id","invoice_id");--> statement-breakpoint
CREATE INDEX "credit_notes_customer_idx" ON "app"."credit_notes" USING btree ("business_id","customer_id");--> statement-breakpoint
CREATE INDEX "credit_notes_location_idx" ON "app"."credit_notes" USING btree ("business_id","location_id");--> statement-breakpoint
CREATE INDEX "credit_notes_list_idx" ON "app"."credit_notes" USING btree ("business_id","issue_date","seq");--> statement-breakpoint
CREATE INDEX "credit_notes_created_by_idx" ON "app"."credit_notes" USING btree ("business_id","created_by");--> statement-breakpoint
CREATE INDEX "invoice_lines_invoice_idx" ON "app"."invoice_lines" USING btree ("business_id","invoice_id");--> statement-breakpoint
CREATE INDEX "invoice_lines_product_idx" ON "app"."invoice_lines" USING btree ("business_id","product_id");--> statement-breakpoint
CREATE INDEX "invoice_lines_deposit_idx" ON "app"."invoice_lines" USING btree ("business_id","deposit_invoice_id");--> statement-breakpoint
CREATE INDEX "invoice_lines_sale_line_idx" ON "app"."invoice_lines" USING btree ("business_id","sale_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_seq_key" ON "app"."invoices" USING btree ("business_id","seq") WHERE seq is not null;--> statement-breakpoint
CREATE INDEX "invoices_list_idx" ON "app"."invoices" USING btree ("business_id","issue_date","seq");--> statement-breakpoint
CREATE INDEX "invoices_status_idx" ON "app"."invoices" USING btree ("business_id","status");--> statement-breakpoint
CREATE INDEX "invoices_customer_idx" ON "app"."invoices" USING btree ("business_id","customer_id");--> statement-breakpoint
CREATE INDEX "invoices_quotation_idx" ON "app"."invoices" USING btree ("business_id","quotation_id");--> statement-breakpoint
CREATE INDEX "invoices_order_idx" ON "app"."invoices" USING btree ("business_id","order_id");--> statement-breakpoint
CREATE INDEX "invoices_sale_idx" ON "app"."invoices" USING btree ("business_id","sale_id");--> statement-breakpoint
CREATE INDEX "invoices_location_idx" ON "app"."invoices" USING btree ("business_id","location_id");--> statement-breakpoint
CREATE INDEX "invoices_channel_idx" ON "app"."invoices" USING btree ("business_id","channel_id");--> statement-breakpoint
CREATE INDEX "invoices_created_by_idx" ON "app"."invoices" USING btree ("business_id","created_by");--> statement-breakpoint
ALTER TABLE "app"."customer_payments" ADD CONSTRAINT "customer_payments_invoice_fk" FOREIGN KEY ("business_id","invoice_id") REFERENCES "app"."invoices"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."quotations" ADD CONSTRAINT "quotations_invoice_fk" FOREIGN KEY ("business_id","invoice_id") REFERENCES "app"."invoices"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sales" ADD CONSTRAINT "sales_invoice_fk" FOREIGN KEY ("business_id","invoice_id") REFERENCES "app"."invoices"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sales" ADD CONSTRAINT "sales_credit_note_fk" FOREIGN KEY ("business_id","credit_note_id") REFERENCES "app"."credit_notes"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_payments_invoice_idx" ON "app"."customer_payments" USING btree ("business_id","invoice_id");--> statement-breakpoint
CREATE INDEX "quotations_invoice_idx" ON "app"."quotations" USING btree ("business_id","invoice_id");--> statement-breakpoint
CREATE INDEX "sales_invoice_idx" ON "app"."sales" USING btree ("business_id","invoice_id");--> statement-breakpoint
CREATE INDEX "sales_credit_note_idx" ON "app"."sales" USING btree ("business_id","credit_note_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_invoice_key" ON "app"."sales" USING btree ("business_id","invoice_id") WHERE invoice_id is not null and status <> 'reversed' and deleted_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "sales_credit_note_key" ON "app"."sales" USING btree ("business_id","credit_note_id") WHERE credit_note_id is not null and status <> 'reversed' and deleted_at is null;--> statement-breakpoint
ALTER TABLE "app"."document_counters" ADD CONSTRAINT "document_counters_series_check" CHECK (series in ('order', 'quotation', 'invoice', 'credit_note'));--> statement-breakpoint
ALTER TABLE "app"."attachments" ADD CONSTRAINT "attachments_entity_check" CHECK (entity in ('purchase', 'expense', 'order', 'quotation', 'quotation_line', 'invoice', 'invoice_line'));--> statement-breakpoint
ALTER TABLE "app"."attachments" ADD CONSTRAINT "attachments_line_image_check" CHECK (entity not in ('quotation_line', 'invoice_line')
        or content_type in ('image/png', 'image/jpeg', 'image/webp'));--> statement-breakpoint
ALTER TABLE "app"."customer_payments" ADD CONSTRAINT "customer_payments_document_check" CHECK (num_nonnulls(order_id, sale_id, invoice_id) = 1);--> statement-breakpoint
ALTER TABLE "app"."document_renders" ADD CONSTRAINT "document_renders_kind_check" CHECK (kind in ('quotation', 'invoice', 'credit_note', 'statement'));--> statement-breakpoint
ALTER TABLE "app"."sales" ADD CONSTRAINT "sales_invoice_check" CHECK ((source = 'invoice') = (invoice_id is not null)
        and (source = 'credit_note') = (credit_note_id is not null));--> statement-breakpoint
ALTER TABLE "app"."sales" ADD CONSTRAINT "sales_refund_check" CHECK ((source = 'refund') = (refund_of_id is not null)
        and (source in ('refund', 'credit_note')) = (refund_by is not null)
        and refund_by in ('quantity', 'amount') and refund_of_id <> id);--> statement-breakpoint
ALTER TABLE "app"."sales" ADD CONSTRAINT "sales_customer_check" CHECK (customer_id is null or source in ('single', 'order', 'refund', 'invoice', 'credit_note'));--> statement-breakpoint
ALTER TABLE "app"."sales" ADD CONSTRAINT "sales_source_check" CHECK (source in ('day_sheet', 'single', 'import', 'order', 'refund', 'invoice', 'credit_note'));
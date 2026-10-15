CREATE TABLE "app"."customers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'individual' NOT NULL,
	"phone" text,
	"email" text,
	"trn" text,
	"trade_licence_no" text,
	"address_line" text,
	"city" text,
	"emirate" text,
	"country" char(2) DEFAULT 'AE' NOT NULL,
	"notes" text,
	"archived_at" timestamp with time zone,
	"created_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"request_hash" text,
	CONSTRAINT "customers_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "customers_name_check" CHECK (btrim(name) <> '' and char_length(name) <= 100),
	CONSTRAINT "customers_kind_check" CHECK (kind in ('individual', 'business', 'government')),
	CONSTRAINT "customers_phone_check" CHECK (btrim(phone) <> '' and char_length(phone) <= 30),
	CONSTRAINT "customers_email_check" CHECK (btrim(email) <> '' and char_length(email) <= 254),
	CONSTRAINT "customers_trn_check" CHECK (trn ~ '^[0-9]{15}$'),
	CONSTRAINT "customers_trade_licence_check" CHECK (trade_licence_no is null or (kind in ('business', 'government')
        and btrim(trade_licence_no) <> '' and char_length(trade_licence_no) <= 50)),
	CONSTRAINT "customers_address_check" CHECK (btrim(address_line) <> '' and char_length(address_line) <= 200),
	CONSTRAINT "customers_city_check" CHECK (btrim(city) <> '' and char_length(city) <= 100),
	CONSTRAINT "customers_emirate_check" CHECK (emirate is null or (emirate in ('abu_dhabi', 'dubai', 'sharjah', 'ajman', 'umm_al_quwain', 'ras_al_khaimah', 'fujairah') and country = 'AE')),
	CONSTRAINT "customers_country_check" CHECK (country ~ '^[A-Z]{2}$'),
	CONSTRAINT "customers_notes_check" CHECK (char_length(notes) <= 1000)
);
--> statement-breakpoint
CREATE TABLE "app"."document_counters" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"series" text NOT NULL,
	"next_no" integer NOT NULL,
	"prefix" text NOT NULL,
	"padding" integer DEFAULT 0 NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"request_hash" text,
	CONSTRAINT "document_counters_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "document_counters_series_key" UNIQUE("business_id","series"),
	CONSTRAINT "document_counters_series_check" CHECK (series in ('order')),
	CONSTRAINT "document_counters_next_no_check" CHECK (next_no >= 1),
	CONSTRAINT "document_counters_padding_check" CHECK (padding between 0 and 12),
	CONSTRAINT "document_counters_prefix_check" CHECK (char_length(prefix) <= 20 and prefix !~ '[[:cntrl:]]')
);
--> statement-breakpoint
CREATE TABLE "app"."customer_payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"customer_id" uuid,
	"order_id" uuid,
	"sale_id" uuid,
	"kind" text DEFAULT 'payment' NOT NULL,
	"business_date" date NOT NULL,
	"method" text NOT NULL,
	"amount" numeric(20, 4) NOT NULL,
	"currency" char(3) NOT NULL,
	"note" text,
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
	CONSTRAINT "customer_payments_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "customer_payments_document_check" CHECK (num_nonnulls(order_id, sale_id) = 1),
	CONSTRAINT "customer_payments_kind_check" CHECK (kind in ('payment', 'refund')),
	CONSTRAINT "customer_payments_method_check" CHECK (method in ('cash', 'card', 'bank_transfer', 'cheque')),
	CONSTRAINT "customer_payments_amount_check" CHECK (amount > 0),
	CONSTRAINT "customer_payments_currency_check" CHECK (currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "customer_payments_note_check" CHECK (btrim(note) <> '' and char_length(note) <= 500),
	CONSTRAINT "customer_payments_reversed_check" CHECK ((reversed_at is null) = (reversed_by is null)
        and (reversed_at is null) = (reversal_date is null))
);
--> statement-breakpoint
CREATE TABLE "app"."order_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
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
	"created_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"request_hash" text,
	CONSTRAINT "order_lines_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "order_lines_kind_check" CHECK (kind in ('item', 'delivery')),
	CONSTRAINT "order_lines_product_check" CHECK ((kind = 'item') = (product_id is not null)),
	CONSTRAINT "order_lines_delivery_check" CHECK (kind <> 'delivery' or (qty = 1 and unit is null
        and discount_percent is null and discount_amount is null)),
	CONSTRAINT "order_lines_unit_check" CHECK (unit in ('mg', 'g', 'kg', 'ml', 'l', 'piece', 'mm', 'cm', 'm', 'mm2', 'cm2', 'm2', 's', 'min', 'h')),
	CONSTRAINT "order_lines_position_check" CHECK (position >= 0),
	CONSTRAINT "order_lines_qty_check" CHECK (qty > 0),
	CONSTRAINT "order_lines_unit_price_check" CHECK (unit_price >= 0),
	CONSTRAINT "order_lines_discount_check" CHECK (num_nonnulls(discount_percent, discount_amount) <= 1
        and discount_percent between 0 and 100 and discount_amount >= 0),
	CONSTRAINT "order_lines_vat_category_check" CHECK (vat_category in ('standard', 'zero_rated', 'exempt')),
	CONSTRAINT "order_lines_vat_rate_check" CHECK (vat_rate between 0 and 100),
	CONSTRAINT "order_lines_vat_check" CHECK ((vat_category is null) = (vat_rate is null)),
	CONSTRAINT "order_lines_description_check" CHECK (btrim(description) <> '' and char_length(description) <= 200)
);
--> statement-breakpoint
CREATE TABLE "app"."orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"number" text NOT NULL,
	"customer_id" uuid,
	"customer_ref" text,
	"business_date" date NOT NULL,
	"due_date" date,
	"location_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"vat_registered" boolean DEFAULT false NOT NULL,
	"currency" char(3) NOT NULL,
	"discount_percent" numeric(9, 6),
	"discount_amount" numeric(20, 4),
	"subtotal" numeric(20, 4) DEFAULT '0' NOT NULL,
	"discount_total" numeric(20, 4) DEFAULT '0' NOT NULL,
	"net_total" numeric(20, 4) DEFAULT '0' NOT NULL,
	"vat_total" numeric(20, 4) DEFAULT '0' NOT NULL,
	"total" numeric(20, 4) DEFAULT '0' NOT NULL,
	"delivery_needed" boolean DEFAULT false NOT NULL,
	"delivery_area" text,
	"delivery_cost" numeric(20, 4),
	"notes" text,
	"delivered_on" date,
	"sale_id" uuid,
	"delivered_at" timestamp with time zone,
	"delivered_by" uuid,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	"created_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"request_hash" text,
	CONSTRAINT "orders_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "orders_seq_key" UNIQUE("business_id","seq"),
	CONSTRAINT "orders_status_check" CHECK (status in ('pending', 'delivered', 'cancelled')),
	CONSTRAINT "orders_seq_check" CHECK (seq >= 1),
	CONSTRAINT "orders_number_check" CHECK (btrim(number) <> '' and char_length(number) <= 40),
	CONSTRAINT "orders_customer_ref_check" CHECK (btrim(customer_ref) <> '' and char_length(customer_ref) <= 100),
	CONSTRAINT "orders_currency_check" CHECK (currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "orders_due_date_check" CHECK (due_date >= business_date),
	CONSTRAINT "orders_discount_check" CHECK (num_nonnulls(discount_percent, discount_amount) <= 1
        and discount_percent between 0 and 100 and discount_amount >= 0),
	CONSTRAINT "orders_delivery_check" CHECK (delivery_needed or (delivery_area is null and delivery_cost is null)),
	CONSTRAINT "orders_delivery_cost_check" CHECK (delivery_cost >= 0),
	CONSTRAINT "orders_delivery_area_check" CHECK (btrim(delivery_area) <> '' and char_length(delivery_area) <= 200),
	CONSTRAINT "orders_notes_check" CHECK (char_length(notes) <= 1000),
	CONSTRAINT "orders_delivered_check" CHECK ((status = 'delivered') = (delivered_on is not null)
        and (status = 'delivered') = (sale_id is not null)
        and (status = 'delivered') = (delivered_at is not null)
        and (status = 'delivered') = (delivered_by is not null)),
	CONSTRAINT "orders_delivered_on_check" CHECK (delivered_on >= business_date),
	CONSTRAINT "orders_cancelled_check" CHECK ((status = 'cancelled') = (cancelled_at is not null)
        and (status = 'cancelled') = (cancelled_by is not null)
        and (cancel_reason is null or status = 'cancelled')),
	CONSTRAINT "orders_cancel_reason_check" CHECK (btrim(cancel_reason) <> '' and char_length(cancel_reason) <= 500)
);
--> statement-breakpoint
ALTER TABLE "app"."attachments" DROP CONSTRAINT "attachments_entity_check";--> statement-breakpoint
ALTER TABLE "app"."sales" DROP CONSTRAINT "sales_source_check";--> statement-breakpoint
ALTER TABLE "app"."purchase_payments" ADD COLUMN "kind" text DEFAULT 'payment' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."purchase_payments" ADD COLUMN "received_by_member_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."sale_lines" ADD COLUMN "refund_of_line_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."sales" ADD COLUMN "customer_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."sales" ADD COLUMN "order_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."sales" ADD COLUMN "refund_of_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."sales" ADD COLUMN "refund_by" text;--> statement-breakpoint
ALTER TABLE "app"."sales" ADD COLUMN "pay_later" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."customers" ADD CONSTRAINT "customers_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."document_counters" ADD CONSTRAINT "document_counters_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."customer_payments" ADD CONSTRAINT "customer_payments_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."customer_payments" ADD CONSTRAINT "customer_payments_customer_fk" FOREIGN KEY ("business_id","customer_id") REFERENCES "app"."customers"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."customer_payments" ADD CONSTRAINT "customer_payments_order_fk" FOREIGN KEY ("business_id","order_id") REFERENCES "app"."orders"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."customer_payments" ADD CONSTRAINT "customer_payments_sale_fk" FOREIGN KEY ("business_id","sale_id") REFERENCES "app"."sales"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."order_lines" ADD CONSTRAINT "order_lines_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."order_lines" ADD CONSTRAINT "order_lines_order_fk" FOREIGN KEY ("business_id","order_id") REFERENCES "app"."orders"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."order_lines" ADD CONSTRAINT "order_lines_product_fk" FOREIGN KEY ("business_id","product_id") REFERENCES "app"."products_services"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."orders" ADD CONSTRAINT "orders_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."orders" ADD CONSTRAINT "orders_customer_fk" FOREIGN KEY ("business_id","customer_id") REFERENCES "app"."customers"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."orders" ADD CONSTRAINT "orders_location_fk" FOREIGN KEY ("business_id","location_id") REFERENCES "app"."locations"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."orders" ADD CONSTRAINT "orders_channel_fk" FOREIGN KEY ("business_id","channel_id") REFERENCES "app"."sales_channels"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."orders" ADD CONSTRAINT "orders_sale_fk" FOREIGN KEY ("business_id","sale_id") REFERENCES "app"."sales"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customers_name_key_idx" ON "app"."customers" USING btree ("business_id",app.name_key(name));--> statement-breakpoint
CREATE INDEX "customers_list_idx" ON "app"."customers" USING btree ("business_id",lower(name),"id");--> statement-breakpoint
CREATE INDEX "customer_payments_order_idx" ON "app"."customer_payments" USING btree ("business_id","order_id");--> statement-breakpoint
CREATE INDEX "customer_payments_sale_idx" ON "app"."customer_payments" USING btree ("business_id","sale_id");--> statement-breakpoint
CREATE INDEX "customer_payments_customer_idx" ON "app"."customer_payments" USING btree ("business_id","customer_id","business_date");--> statement-breakpoint
CREATE INDEX "order_lines_order_idx" ON "app"."order_lines" USING btree ("business_id","order_id");--> statement-breakpoint
CREATE INDEX "order_lines_product_idx" ON "app"."order_lines" USING btree ("business_id","product_id");--> statement-breakpoint
CREATE INDEX "orders_status_idx" ON "app"."orders" USING btree ("business_id","status","due_date");--> statement-breakpoint
CREATE INDEX "orders_customer_idx" ON "app"."orders" USING btree ("business_id","customer_id");--> statement-breakpoint
CREATE INDEX "orders_created_by_idx" ON "app"."orders" USING btree ("business_id","created_by");--> statement-breakpoint
CREATE INDEX "orders_location_idx" ON "app"."orders" USING btree ("business_id","location_id");--> statement-breakpoint
CREATE INDEX "orders_channel_idx" ON "app"."orders" USING btree ("business_id","channel_id");--> statement-breakpoint
CREATE INDEX "orders_sale_idx" ON "app"."orders" USING btree ("business_id","sale_id");--> statement-breakpoint
ALTER TABLE "app"."purchase_payments" ADD CONSTRAINT "purchase_payments_received_by_fk" FOREIGN KEY ("business_id","received_by_member_id") REFERENCES "app"."business_members"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sale_lines" ADD CONSTRAINT "sale_lines_refund_of_line_fk" FOREIGN KEY ("business_id","refund_of_line_id") REFERENCES "app"."sale_lines"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sales" ADD CONSTRAINT "sales_customer_fk" FOREIGN KEY ("business_id","customer_id") REFERENCES "app"."customers"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sales" ADD CONSTRAINT "sales_order_fk" FOREIGN KEY ("business_id","order_id") REFERENCES "app"."orders"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sales" ADD CONSTRAINT "sales_refund_of_fk" FOREIGN KEY ("business_id","refund_of_id") REFERENCES "app"."sales"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "purchase_payments_received_by_idx" ON "app"."purchase_payments" USING btree ("business_id","received_by_member_id");--> statement-breakpoint
CREATE INDEX "sale_lines_refund_of_line_idx" ON "app"."sale_lines" USING btree ("business_id","refund_of_line_id");--> statement-breakpoint
CREATE INDEX "sales_customer_idx" ON "app"."sales" USING btree ("business_id","customer_id");--> statement-breakpoint
CREATE INDEX "sales_order_idx" ON "app"."sales" USING btree ("business_id","order_id");--> statement-breakpoint
CREATE INDEX "sales_refund_of_idx" ON "app"."sales" USING btree ("business_id","refund_of_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_order_key" ON "app"."sales" USING btree ("business_id","order_id") WHERE order_id is not null and refund_of_id is null and status <> 'reversed'
          and deleted_at is null;--> statement-breakpoint
ALTER TABLE "app"."attachments" ADD CONSTRAINT "attachments_entity_check" CHECK (entity in ('purchase', 'expense', 'order'));--> statement-breakpoint
ALTER TABLE "app"."purchase_payments" ADD CONSTRAINT "purchase_payments_kind_check" CHECK (kind in ('payment', 'refund'));--> statement-breakpoint
ALTER TABLE "app"."purchase_payments" ADD CONSTRAINT "purchase_payments_received_by_check" CHECK (kind = 'refund' or received_by_member_id is null);--> statement-breakpoint
ALTER TABLE "app"."sales" ADD CONSTRAINT "sales_order_check" CHECK ((source = 'order') = (order_id is not null and refund_of_id is null)
        and (order_id is null or source in ('order', 'refund')));--> statement-breakpoint
ALTER TABLE "app"."sales" ADD CONSTRAINT "sales_refund_check" CHECK ((source = 'refund') = (refund_of_id is not null)
        and (refund_of_id is null) = (refund_by is null)
        and refund_by in ('quantity', 'amount') and refund_of_id <> id);--> statement-breakpoint
ALTER TABLE "app"."sales" ADD CONSTRAINT "sales_customer_check" CHECK (customer_id is null or source in ('single', 'order', 'refund'));--> statement-breakpoint
ALTER TABLE "app"."sales" ADD CONSTRAINT "sales_pay_later_check" CHECK (not pay_later or (source = 'single' and customer_id is not null));--> statement-breakpoint
ALTER TABLE "app"."sales" ADD CONSTRAINT "sales_source_check" CHECK (source in ('day_sheet', 'single', 'import', 'order', 'refund'));
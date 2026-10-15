-- BizCost: import sales from a file, and app fees by channel (M3 Step 4, the owner's answers Q8 and
-- Q15 of D-218; drizzle-kit generated, then commented). sale_imports keeps what is kept of a file
-- (its hash, its headers' fingerprint, the columns chosen, the counts; never the file), its staged
-- rows sale_import_rows (cleared at posting), import_profiles a layout's columns, product_aliases the
-- answers given for names and item codes, channel_statements a delivery app's or a marketplace's
-- statements (their fees are `cost`). sales gains `import` as a source with `import_id`, and an
-- import's summary over several days posts one sale on its last day with `period_from` (Q9). The
-- security part is sale_imports_security.
CREATE TABLE "app"."channel_statements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"period_from" date NOT NULL,
	"period_to" date NOT NULL,
	"sales" numeric(20, 4),
	"commission" numeric(20, 4) DEFAULT '0' NOT NULL,
	"payment_fees" numeric(20, 4) DEFAULT '0' NOT NULL,
	"other_fees" numeric(20, 4) DEFAULT '0' NOT NULL,
	"ads" numeric(20, 4) DEFAULT '0' NOT NULL,
	"refunds_charged" numeric(20, 4) DEFAULT '0' NOT NULL,
	"payout" numeric(20, 4),
	"notes" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"posted_at" timestamp with time zone,
	"posted_by" uuid,
	"reversed_at" timestamp with time zone,
	"reversed_by" uuid,
	"import_id" uuid,
	"created_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"request_hash" text,
	CONSTRAINT "channel_statements_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "channel_statements_status_check" CHECK (status in ('draft', 'posted', 'reversed')),
	CONSTRAINT "channel_statements_period_check" CHECK (period_from <= period_to and period_to - period_from < 366),
	CONSTRAINT "channel_statements_amounts_check" CHECK (sales >= 0 and commission >= 0 and payment_fees >= 0 and other_fees >= 0 and ads >= 0
        and refunds_charged >= 0),
	CONSTRAINT "channel_statements_notes_check" CHECK (char_length(notes) <= 1000),
	CONSTRAINT "channel_statements_posted_check" CHECK ((status = 'draft') = (posted_at is null) and (status = 'draft') = (posted_by is null)),
	CONSTRAINT "channel_statements_reversed_check" CHECK ((status = 'reversed') = (reversed_at is not null)
        and (status = 'reversed') = (reversed_by is not null))
);
--> statement-breakpoint
CREATE TABLE "app"."import_profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"source" text NOT NULL,
	"fingerprint" char(64) NOT NULL,
	"mapping" jsonb NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"request_hash" text,
	CONSTRAINT "import_profiles_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "import_profiles_source_check" CHECK (source ~ '^[a-z][a-z0-9_]{0,39}$'),
	CONSTRAINT "import_profiles_fingerprint_check" CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "import_profiles_mapping_check" CHECK (jsonb_typeof(mapping) = 'object')
);
--> statement-breakpoint
CREATE TABLE "app"."product_aliases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"source" text NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"raw" text NOT NULL,
	"target" text NOT NULL,
	"product_id" uuid,
	"created_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"request_hash" text,
	CONSTRAINT "product_aliases_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "product_aliases_source_check" CHECK (source ~ '^[a-z][a-z0-9_]{0,39}$'),
	CONSTRAINT "product_aliases_kind_check" CHECK (kind in ('name', 'code')),
	CONSTRAINT "product_aliases_target_check" CHECK (target in ('product', 'skip', 'charge', 'delivery')),
	CONSTRAINT "product_aliases_product_check" CHECK ((target = 'product') = (product_id is not null)),
	CONSTRAINT "product_aliases_key_check" CHECK (key <> '' and char_length(key) <= 300),
	CONSTRAINT "product_aliases_raw_check" CHECK (btrim(raw) <> '' and char_length(raw) <= 300)
);
--> statement-breakpoint
CREATE TABLE "app"."sale_import_rows" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"import_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"business_date" date NOT NULL,
	"name" text NOT NULL,
	"code" text,
	"qty" numeric(24, 6) NOT NULL,
	"amount" numeric(20, 4) NOT NULL,
	"refunds" numeric(20, 4) DEFAULT '0' NOT NULL,
	"file_rows" integer NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"request_hash" text,
	CONSTRAINT "sale_import_rows_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "sale_import_rows_position_check" CHECK (position >= 0),
	CONSTRAINT "sale_import_rows_name_check" CHECK (btrim(name) <> '' and char_length(name) <= 300),
	CONSTRAINT "sale_import_rows_code_check" CHECK (btrim(code) <> '' and char_length(code) <= 100),
	CONSTRAINT "sale_import_rows_refunds_check" CHECK (refunds >= 0),
	CONSTRAINT "sale_import_rows_file_rows_check" CHECK (file_rows >= 1)
);
--> statement-breakpoint
CREATE TABLE "app"."sale_imports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"file_hash" char(64) NOT NULL,
	"fingerprint" char(64) NOT NULL,
	"shape" text NOT NULL,
	"period_from" date NOT NULL,
	"period_to" date NOT NULL,
	"mapping" jsonb NOT NULL,
	"amounts_include_vat" boolean DEFAULT false NOT NULL,
	"rows_read" integer NOT NULL,
	"rows_left_out" integer DEFAULT 0 NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fees_total" numeric(20, 4),
	"row_count" integer NOT NULL,
	"overlap" text DEFAULT 'skip' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"posted_at" timestamp with time zone,
	"posted_by" uuid,
	"reversed_at" timestamp with time zone,
	"reversed_by" uuid,
	"replaced_days" date[],
	"created_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"request_hash" text,
	CONSTRAINT "sale_imports_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "sale_imports_shape_check" CHECK (shape in ('lines', 'summary')),
	CONSTRAINT "sale_imports_status_check" CHECK (status in ('draft', 'posted', 'reversed')),
	CONSTRAINT "sale_imports_overlap_check" CHECK (overlap in ('skip', 'replace')),
	CONSTRAINT "sale_imports_file_hash_check" CHECK (file_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "sale_imports_fingerprint_check" CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "sale_imports_file_name_check" CHECK (btrim(file_name) <> '' and char_length(file_name) <= 255),
	CONSTRAINT "sale_imports_period_check" CHECK (period_from <= period_to
        and date_trunc('month', period_from) = date_trunc('month', period_to)),
	CONSTRAINT "sale_imports_mapping_check" CHECK (jsonb_typeof(mapping) = 'object'),
	CONSTRAINT "sale_imports_errors_check" CHECK (jsonb_typeof(errors) = 'array' and jsonb_array_length(errors) <= 50),
	CONSTRAINT "sale_imports_counts_check" CHECK (rows_read >= 0 and rows_left_out >= 0 and row_count between 1 and 100000),
	CONSTRAINT "sale_imports_posted_check" CHECK ((status = 'draft') = (posted_at is null) and (status = 'draft') = (posted_by is null)),
	CONSTRAINT "sale_imports_reversed_check" CHECK ((status = 'reversed') = (reversed_at is not null)
        and (status = 'reversed') = (reversed_by is not null))
);
--> statement-breakpoint
ALTER TABLE "app"."sales" DROP CONSTRAINT "sales_source_check";--> statement-breakpoint
ALTER TABLE "app"."sales" DROP CONSTRAINT "sales_period_check";--> statement-breakpoint
ALTER TABLE "app"."sales" ADD COLUMN "import_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."channel_statements" ADD CONSTRAINT "channel_statements_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."channel_statements" ADD CONSTRAINT "channel_statements_channel_fk" FOREIGN KEY ("business_id","channel_id") REFERENCES "app"."sales_channels"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."channel_statements" ADD CONSTRAINT "channel_statements_import_fk" FOREIGN KEY ("business_id","import_id") REFERENCES "app"."sale_imports"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."import_profiles" ADD CONSTRAINT "import_profiles_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."product_aliases" ADD CONSTRAINT "product_aliases_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."product_aliases" ADD CONSTRAINT "product_aliases_product_fk" FOREIGN KEY ("business_id","product_id") REFERENCES "app"."products_services"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sale_import_rows" ADD CONSTRAINT "sale_import_rows_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sale_import_rows" ADD CONSTRAINT "sale_import_rows_import_fk" FOREIGN KEY ("business_id","import_id") REFERENCES "app"."sale_imports"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sale_imports" ADD CONSTRAINT "sale_imports_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sale_imports" ADD CONSTRAINT "sale_imports_channel_fk" FOREIGN KEY ("business_id","channel_id") REFERENCES "app"."sales_channels"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sale_imports" ADD CONSTRAINT "sale_imports_location_fk" FOREIGN KEY ("business_id","location_id") REFERENCES "app"."locations"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_statements_channel_idx" ON "app"."channel_statements" USING btree ("business_id","channel_id","period_from");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_statements_import_key" ON "app"."channel_statements" USING btree ("business_id","import_id") WHERE import_id is not null and deleted_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "import_profiles_fingerprint_key" ON "app"."import_profiles" USING btree ("business_id","source","fingerprint") WHERE deleted_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "product_aliases_key" ON "app"."product_aliases" USING btree ("business_id","source","kind","key") WHERE deleted_at is null;--> statement-breakpoint
CREATE INDEX "product_aliases_product_idx" ON "app"."product_aliases" USING btree ("business_id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sale_import_rows_position_key" ON "app"."sale_import_rows" USING btree ("business_id","import_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "sale_imports_file_key" ON "app"."sale_imports" USING btree ("business_id","file_hash") WHERE status <> 'reversed' and deleted_at is null;--> statement-breakpoint
CREATE INDEX "sale_imports_list_idx" ON "app"."sale_imports" USING btree ("business_id","created_at","id");--> statement-breakpoint
CREATE INDEX "sale_imports_channel_idx" ON "app"."sale_imports" USING btree ("business_id","channel_id");--> statement-breakpoint
CREATE INDEX "sale_imports_location_idx" ON "app"."sale_imports" USING btree ("business_id","location_id");--> statement-breakpoint
ALTER TABLE "app"."sales" ADD CONSTRAINT "sales_import_fk" FOREIGN KEY ("business_id","import_id") REFERENCES "app"."sale_imports"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sales_import_idx" ON "app"."sales" USING btree ("business_id","import_id");--> statement-breakpoint
ALTER TABLE "app"."sales" ADD CONSTRAINT "sales_import_check" CHECK ((source = 'import') = (import_id is not null));--> statement-breakpoint
ALTER TABLE "app"."sales" ADD CONSTRAINT "sales_source_check" CHECK (source in ('day_sheet', 'single', 'import'));--> statement-breakpoint
ALTER TABLE "app"."sales" ADD CONSTRAINT "sales_period_check" CHECK (period_from is null or (source in ('day_sheet', 'import') and period_from < business_date
        and date_trunc('month', period_from) = date_trunc('month', business_date)));
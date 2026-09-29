CREATE TABLE "app"."cost_categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"request_hash" text,
	CONSTRAINT "cost_categories_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "cost_categories_name_check" CHECK (btrim(name) <> '' and char_length(name) <= 100)
);
--> statement-breakpoint
CREATE TABLE "app"."expense_payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"expense_id" uuid NOT NULL,
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
	CONSTRAINT "expense_payments_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "expense_payments_method_check" CHECK (method in ('cash', 'card', 'bank_transfer', 'cheque')),
	CONSTRAINT "expense_payments_amount_check" CHECK (amount > 0),
	CONSTRAINT "expense_payments_currency_check" CHECK (currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "expense_payments_note_check" CHECK (btrim(note) <> '' and char_length(note) <= 500),
	CONSTRAINT "expense_payments_reversed_check" CHECK ((reversed_at is null) = (reversed_by is null)
        and (reversed_at is null) = (reversal_date is null))
);
--> statement-breakpoint
CREATE TABLE "app"."expenses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"supplier_id" uuid,
	"location_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"document_type" text NOT NULL,
	"reference" text,
	"description" text,
	"payment_method" text NOT NULL,
	"paid_by_member_id" uuid,
	"prices_include_vat" boolean DEFAULT false NOT NULL,
	"vat_not_reclaimable" boolean DEFAULT false NOT NULL,
	"currency" char(3) NOT NULL,
	"amount" numeric(20, 4) NOT NULL,
	"vat_rate" numeric(9, 6) DEFAULT '0' NOT NULL,
	"net_total" numeric(20, 4) NOT NULL,
	"vat_total" numeric(20, 4) NOT NULL,
	"total" numeric(20, 4) NOT NULL,
	"notes" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"submitted_at" timestamp with time zone,
	"submitted_by" uuid,
	"approved_at" timestamp with time zone,
	"approved_by" uuid,
	"rejected_at" timestamp with time zone,
	"rejected_by" uuid,
	"rejection_reason" text,
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
	CONSTRAINT "expenses_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "expenses_document_type_check" CHECK (document_type in ('tax_invoice', 'non_tax_invoice', 'no_invoice')),
	CONSTRAINT "expenses_payment_method_check" CHECK (payment_method in ('cash', 'card', 'bank_transfer', 'cheque', 'supplier_credit', 'paid_by_member', 'other')),
	CONSTRAINT "expenses_paid_by_member_check" CHECK ((payment_method = 'paid_by_member') = (paid_by_member_id is not null)),
	CONSTRAINT "expenses_supplier_credit_check" CHECK (payment_method <> 'supplier_credit' or supplier_id is not null),
	CONSTRAINT "expenses_status_check" CHECK (status in ('draft', 'submitted', 'approved', 'rejected', 'posted', 'reversed')),
	CONSTRAINT "expenses_currency_check" CHECK (currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "expenses_amount_check" CHECK (amount > 0),
	CONSTRAINT "expenses_vat_rate_check" CHECK (vat_rate between 0 and 100),
	CONSTRAINT "expenses_totals_check" CHECK (net_total >= 0 and vat_total >= 0 and total = net_total + vat_total),
	CONSTRAINT "expenses_reference_check" CHECK (btrim(reference) <> '' and char_length(reference) <= 100),
	CONSTRAINT "expenses_description_check" CHECK (btrim(description) <> '' and char_length(description) <= 200),
	CONSTRAINT "expenses_notes_check" CHECK (char_length(notes) <= 1000),
	CONSTRAINT "expenses_rejection_reason_check" CHECK (btrim(rejection_reason) <> '' and char_length(rejection_reason) <= 500),
	CONSTRAINT "expenses_review_check" CHECK ((submitted_at is null) = (submitted_by is null)
        and (approved_at is null) = (approved_by is null)
        and (rejected_at is null) = (rejected_by is null)
        and (rejected_at is not null or rejection_reason is null)
        and (status <> 'submitted' or submitted_at is not null)
        and (status <> 'approved' or approved_at is not null)
        and (status <> 'rejected' or rejected_at is not null)),
	CONSTRAINT "expenses_posted_check" CHECK ((status in ('posted', 'reversed')) = (posted_at is not null)
        and (posted_at is null) = (posted_by is null)
        and (posted_at is null) = (vat_in_cost is null)
        and (posted_at is null) = (cost_total is null)),
	CONSTRAINT "expenses_reversed_check" CHECK ((status = 'reversed') = (reversed_at is not null)
        and (status = 'reversed') = (reversed_by is not null)
        and (status = 'reversed') = (reversal_date is not null)),
	CONSTRAINT "expenses_copied_from_check" CHECK (copied_from_id <> id)
);
--> statement-breakpoint
CREATE TABLE "app"."running_costs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category_id" uuid NOT NULL,
	"amount" numeric(20, 4) NOT NULL,
	"frequency" text DEFAULT 'monthly' NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"notes" text,
	"created_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"request_hash" text,
	CONSTRAINT "running_costs_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "running_costs_name_check" CHECK (btrim(name) <> '' and char_length(name) <= 100),
	CONSTRAINT "running_costs_amount_check" CHECK (amount > 0),
	CONSTRAINT "running_costs_frequency_check" CHECK (frequency in ('weekly', 'monthly', 'quarterly', 'yearly')),
	CONSTRAINT "running_costs_dates_check" CHECK (ends_on >= starts_on),
	CONSTRAINT "running_costs_notes_check" CHECK (char_length(notes) <= 1000)
);
--> statement-breakpoint
ALTER TABLE "app"."attachments" DROP CONSTRAINT "attachments_entity_check";--> statement-breakpoint
ALTER TABLE "app"."businesses" ADD COLUMN "expense_approval" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."cost_categories" ADD CONSTRAINT "cost_categories_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."expense_payments" ADD CONSTRAINT "expense_payments_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."expense_payments" ADD CONSTRAINT "expense_payments_expense_fk" FOREIGN KEY ("business_id","expense_id") REFERENCES "app"."expenses"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."expenses" ADD CONSTRAINT "expenses_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."expenses" ADD CONSTRAINT "expenses_category_fk" FOREIGN KEY ("business_id","category_id") REFERENCES "app"."cost_categories"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."expenses" ADD CONSTRAINT "expenses_supplier_fk" FOREIGN KEY ("business_id","supplier_id") REFERENCES "app"."suppliers"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."expenses" ADD CONSTRAINT "expenses_location_fk" FOREIGN KEY ("business_id","location_id") REFERENCES "app"."locations"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."expenses" ADD CONSTRAINT "expenses_paid_by_member_fk" FOREIGN KEY ("business_id","paid_by_member_id") REFERENCES "app"."business_members"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."expenses" ADD CONSTRAINT "expenses_copied_from_fk" FOREIGN KEY ("business_id","copied_from_id") REFERENCES "app"."expenses"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."running_costs" ADD CONSTRAINT "running_costs_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."running_costs" ADD CONSTRAINT "running_costs_category_fk" FOREIGN KEY ("business_id","category_id") REFERENCES "app"."cost_categories"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cost_categories_name_key" ON "app"."cost_categories" USING btree ("business_id",app.name_key(name)) WHERE deleted_at is null;--> statement-breakpoint
CREATE INDEX "expense_payments_expense_idx" ON "app"."expense_payments" USING btree ("business_id","expense_id");--> statement-breakpoint
CREATE INDEX "expenses_business_date_idx" ON "app"."expenses" USING btree ("business_id","business_date","id");--> statement-breakpoint
CREATE INDEX "expenses_category_idx" ON "app"."expenses" USING btree ("business_id","category_id");--> statement-breakpoint
CREATE INDEX "expenses_supplier_idx" ON "app"."expenses" USING btree ("business_id","supplier_id");--> statement-breakpoint
CREATE INDEX "expenses_paid_by_member_idx" ON "app"."expenses" USING btree ("business_id","paid_by_member_id");--> statement-breakpoint
CREATE INDEX "running_costs_category_idx" ON "app"."running_costs" USING btree ("business_id","category_id");--> statement-breakpoint
ALTER TABLE "app"."attachments" ADD CONSTRAINT "attachments_entity_check" CHECK (entity in ('purchase', 'expense'));
CREATE TABLE "app"."purchase_payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"purchase_id" uuid NOT NULL,
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
	CONSTRAINT "purchase_payments_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "purchase_payments_method_check" CHECK (method in ('cash', 'card', 'bank_transfer', 'cheque')),
	CONSTRAINT "purchase_payments_amount_check" CHECK (amount > 0),
	CONSTRAINT "purchase_payments_currency_check" CHECK (currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "purchase_payments_note_check" CHECK (btrim(note) <> '' and char_length(note) <= 500),
	CONSTRAINT "purchase_payments_reversed_check" CHECK ((reversed_at is null) = (reversed_by is null)
        and (reversed_at is null) = (reversal_date is null))
);
--> statement-breakpoint
ALTER TABLE "app"."purchases" DROP CONSTRAINT "purchases_payment_method_check";--> statement-breakpoint
DROP INDEX "app"."materials_name_key";--> statement-breakpoint
ALTER TABLE "app"."purchases" ADD COLUMN "paid_by_member_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."purchases" ADD COLUMN "prices_include_vat" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."purchase_payments" ADD CONSTRAINT "purchase_payments_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."purchase_payments" ADD CONSTRAINT "purchase_payments_purchase_fk" FOREIGN KEY ("business_id","purchase_id") REFERENCES "app"."purchases"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "purchase_payments_purchase_idx" ON "app"."purchase_payments" USING btree ("business_id","purchase_id");--> statement-breakpoint
ALTER TABLE "app"."purchases" ADD CONSTRAINT "purchases_paid_by_member_fk" FOREIGN KEY ("business_id","paid_by_member_id") REFERENCES "app"."business_members"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "purchases_paid_by_member_idx" ON "app"."purchases" USING btree ("business_id","paid_by_member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "materials_name_key" ON "app"."materials" USING btree ("business_id",app.name_key(name)) WHERE deleted_at is null;--> statement-breakpoint
ALTER TABLE "app"."purchases" ADD CONSTRAINT "purchases_paid_by_member_check" CHECK ((payment_method is not distinct from 'paid_by_member') = (paid_by_member_id is not null));--> statement-breakpoint
ALTER TABLE "app"."purchases" ADD CONSTRAINT "purchases_supplier_credit_check" CHECK (payment_method is distinct from 'supplier_credit' or supplier_id is not null);--> statement-breakpoint
ALTER TABLE "app"."purchases" ADD CONSTRAINT "purchases_payment_method_check" CHECK (payment_method in ('cash', 'card', 'bank_transfer', 'cheque', 'supplier_credit', 'paid_by_member', 'other'));
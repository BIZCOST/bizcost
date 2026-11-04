CREATE TABLE "app"."stock_count_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"count_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"material_id" uuid NOT NULL,
	"parts" jsonb,
	"counted_base_qty" numeric(24, 6),
	"counted_by" uuid,
	"counted_at" timestamp with time zone,
	"book_base_qty" numeric(24, 6),
	"difference_qty" numeric(24, 6),
	"difference_value" numeric(28, 12),
	"unit_cost" numeric(28, 12),
	"created_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"request_hash" text,
	CONSTRAINT "stock_count_lines_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "stock_count_lines_counted_check" CHECK ((parts is null) = (counted_base_qty is null)
        and (parts is null) = (counted_by is null)
        and (parts is null) = (counted_at is null)
        and counted_base_qty >= 0),
	CONSTRAINT "stock_count_lines_parts_check" CHECK (jsonb_typeof(parts) = 'array' and jsonb_array_length(parts) between 1 and 10),
	CONSTRAINT "stock_count_lines_result_check" CHECK ((book_base_qty is null) = (difference_qty is null)
        and (book_base_qty is null) = (difference_value is null)
        and (book_base_qty is null or counted_base_qty is not null)
        and difference_qty = counted_base_qty - book_base_qty)
);
--> statement-breakpoint
CREATE TABLE "app"."stock_counts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"location_id" uuid,
	"business_date" date NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"note" text,
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
	CONSTRAINT "stock_counts_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "stock_counts_kind_check" CHECK (kind in ('opening', 'count')),
	CONSTRAINT "stock_counts_location_check" CHECK ((kind = 'opening') = (location_id is null)),
	CONSTRAINT "stock_counts_status_check" CHECK (status in ('draft', 'posted', 'reversed')),
	CONSTRAINT "stock_counts_note_check" CHECK (char_length(note) <= 500),
	CONSTRAINT "stock_counts_posted_check" CHECK ((status = 'draft') = (posted_at is null) and (status = 'draft') = (posted_by is null)),
	CONSTRAINT "stock_counts_reversed_check" CHECK ((status = 'reversed') = (reversed_at is not null)
        and (status = 'reversed') = (reversed_by is not null)
        and (status = 'reversed') = (reversal_date is not null))
);
--> statement-breakpoint
ALTER TABLE "app"."stock_movements" DROP CONSTRAINT "stock_movements_kind_check";--> statement-breakpoint
ALTER TABLE "app"."stock_movements" DROP CONSTRAINT "stock_movements_shape_check";--> statement-breakpoint
ALTER TABLE "app"."materials" ADD COLUMN "stock_tracked_from" date;--> statement-breakpoint
ALTER TABLE "app"."stock_movements" ADD COLUMN "count_line_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."stock_count_lines" ADD CONSTRAINT "stock_count_lines_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."stock_count_lines" ADD CONSTRAINT "stock_count_lines_count_fk" FOREIGN KEY ("business_id","count_id") REFERENCES "app"."stock_counts"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."stock_count_lines" ADD CONSTRAINT "stock_count_lines_location_fk" FOREIGN KEY ("business_id","location_id") REFERENCES "app"."locations"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."stock_count_lines" ADD CONSTRAINT "stock_count_lines_material_fk" FOREIGN KEY ("business_id","material_id") REFERENCES "app"."materials"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."stock_counts" ADD CONSTRAINT "stock_counts_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."stock_counts" ADD CONSTRAINT "stock_counts_location_fk" FOREIGN KEY ("business_id","location_id") REFERENCES "app"."locations"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stock_count_lines_count_location_material_key" ON "app"."stock_count_lines" USING btree ("business_id","count_id","location_id","material_id") WHERE deleted_at is null;--> statement-breakpoint
CREATE INDEX "stock_count_lines_material_location_idx" ON "app"."stock_count_lines" USING btree ("business_id","material_id","location_id");--> statement-breakpoint
CREATE INDEX "stock_counts_business_date_idx" ON "app"."stock_counts" USING btree ("business_id","business_date","id");--> statement-breakpoint
CREATE INDEX "stock_counts_location_idx" ON "app"."stock_counts" USING btree ("business_id","location_id");--> statement-breakpoint
ALTER TABLE "app"."stock_movements" ADD CONSTRAINT "stock_movements_count_line_fk" FOREIGN KEY ("business_id","count_line_id") REFERENCES "app"."stock_count_lines"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stock_movements_count_line_key" ON "app"."stock_movements" USING btree ("business_id","count_line_id") WHERE kind in ('opening', 'count');--> statement-breakpoint
ALTER TABLE "app"."stock_movements" ADD CONSTRAINT "stock_movements_kind_check" CHECK (kind in ('purchase', 'purchase_return', 'purchase_credit', 'reversal', 'opening', 'count'));--> statement-breakpoint
ALTER TABLE "app"."stock_movements" ADD CONSTRAINT "stock_movements_shape_check" CHECK (case kind
        when 'purchase' then qty > 0 and value >= 0 and purchase_line_id is not null
          and return_line_id is null and receipt_id is null and reverses_id is null
          and count_line_id is null
        when 'purchase_return' then qty < 0 and value <= 0 and purchase_line_id is not null
          and return_line_id is not null and receipt_id is not null and reverses_id is null
          and count_line_id is null
        when 'purchase_credit' then qty = 0 and value < 0 and purchase_line_id is not null
          and return_line_id is not null and receipt_id is not null and reverses_id is null
          and count_line_id is null
        when 'opening' then value >= 0 and count_line_id is not null and purchase_line_id is null
          and return_line_id is null and receipt_id is null and reverses_id is null
        when 'count' then ((qty > 0 and value >= 0) or (qty < 0 and value <= 0))
          and count_line_id is not null and purchase_line_id is null
          and return_line_id is null and receipt_id is null and reverses_id is null
        else reverses_id is not null and receipt_id is null
      end);
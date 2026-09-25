CREATE TABLE "app"."file_uploads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"path" text NOT NULL,
	"purpose" text NOT NULL,
	"content_type" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'issued' NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"request_hash" text,
	CONSTRAINT "file_uploads_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "file_uploads_business_id_path_key" UNIQUE("business_id","path"),
	CONSTRAINT "file_uploads_purpose_check" CHECK (purpose in ('logo')),
	CONSTRAINT "file_uploads_status_check" CHECK (status in ('issued', 'used', 'discarded')),
	CONSTRAINT "file_uploads_path_check" CHECK (starts_with(path, business_id::text || '/'))
);
--> statement-breakpoint
ALTER TABLE "app"."file_uploads" ADD CONSTRAINT "file_uploads_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "file_uploads_created_idx" ON "app"."file_uploads" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE INDEX "business_invitations_email_idx" ON "app"."business_invitations" USING btree ("business_id",lower((email)::text));--> statement-breakpoint
CREATE INDEX "business_invitations_created_by_idx" ON "app"."business_invitations" USING btree ("created_by","created_at");
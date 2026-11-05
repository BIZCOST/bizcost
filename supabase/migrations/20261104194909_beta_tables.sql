CREATE TABLE "app"."beta_list" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" "citext" NOT NULL,
	"note" text,
	"added_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by" uuid,
	CONSTRAINT "beta_list_email_check" CHECK ((email)::text = lower(btrim((email)::text)) and position('@' in (email)::text) > 1 and char_length((email)::text) <= 254),
	CONSTRAINT "beta_list_note_check" CHECK (note is null or char_length(note) <= 200)
);
--> statement-breakpoint
CREATE TABLE "app"."feedback" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"from_business_id" uuid,
	"from_member_id" uuid,
	"page_path" text NOT NULL,
	"message" text NOT NULL,
	"image_path" text,
	"image_content_type" text,
	"image_size_bytes" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_message_check" CHECK (btrim(message) <> '' and char_length(message) <= 4000),
	CONSTRAINT "feedback_page_path_check" CHECK (page_path ~ '^/[A-Za-z0-9._~%/-]*$' and char_length(page_path) <= 300),
	CONSTRAINT "feedback_member_check" CHECK ((from_business_id is null) = (from_member_id is null)),
	CONSTRAINT "feedback_image_check" CHECK ((image_path is null) = (image_content_type is null)
        and (image_path is null) = (image_size_bytes is null)
        and (image_path is null or starts_with(image_path, 'feedback/' || user_id::text || '/'))
        and (image_content_type is null or image_content_type in ('image/png', 'image/jpeg', 'image/webp'))
        and (image_size_bytes is null or image_size_bytes > 0))
);
--> statement-breakpoint
CREATE TABLE "app"."feedback_uploads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"path" text NOT NULL,
	"content_type" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'issued' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_uploads_status_check" CHECK (status in ('issued', 'used', 'discarded')),
	CONSTRAINT "feedback_uploads_path_check" CHECK (starts_with(path, 'feedback/' || user_id::text || '/')),
	CONSTRAINT "feedback_uploads_type_check" CHECK (content_type in ('image/png', 'image/jpeg', 'image/webp'))
);
--> statement-breakpoint
ALTER TABLE "app"."profiles" ADD COLUMN "terms_version" text;--> statement-breakpoint
ALTER TABLE "app"."profiles" ADD COLUMN "terms_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."feedback" ADD CONSTRAINT "feedback_business_fk" FOREIGN KEY ("from_business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."feedback" ADD CONSTRAINT "feedback_member_fk" FOREIGN KEY ("from_business_id","from_member_id") REFERENCES "app"."business_members"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "beta_list_active_email_key" ON "app"."beta_list" USING btree (lower((email)::text)) WHERE removed_at is null;--> statement-breakpoint
CREATE INDEX "feedback_user_idx" ON "app"."feedback" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_image_path_key" ON "app"."feedback" USING btree ("image_path") WHERE image_path is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_uploads_path_key" ON "app"."feedback_uploads" USING btree ("path");--> statement-breakpoint
CREATE INDEX "feedback_uploads_user_idx" ON "app"."feedback_uploads" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "business_invitations_pending_email_idx" ON "app"."business_invitations" USING btree (lower((email)::text)) WHERE status = 'pending' and deleted_at is null;--> statement-breakpoint
ALTER TABLE "app"."profiles" ADD CONSTRAINT "profiles_terms_check" CHECK ((terms_version is null) = (terms_accepted_at is null));
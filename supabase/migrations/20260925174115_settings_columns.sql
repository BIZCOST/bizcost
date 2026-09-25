ALTER TABLE "app"."business_invitations" ADD COLUMN "locale" text DEFAULT 'ar' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."business_invitations" ADD COLUMN "preview_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."business_invitations" ADD COLUMN "preview_window_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."business_members" ADD COLUMN "email" "citext";--> statement-breakpoint
CREATE INDEX "business_invitations_created_idx" ON "app"."business_invitations" USING btree ("business_id","created_at");--> statement-breakpoint
ALTER TABLE "app"."business_invitations" ADD CONSTRAINT "business_invitations_locale_check" CHECK (locale in ('en', 'ar'));--> statement-breakpoint
ALTER TABLE "app"."business_invitations" ADD CONSTRAINT "business_invitations_preview_count_check" CHECK (preview_count >= 0);
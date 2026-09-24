CREATE TABLE "app"."business_invitations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"email" "citext" NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"role_id" uuid NOT NULL,
	"overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"location_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"send_count" integer DEFAULT 0 NOT NULL,
	"last_sent_at" timestamp with time zone,
	"created_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"request_hash" text,
	CONSTRAINT "business_invitations_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "business_invitations_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "business_invitations_status_check" CHECK (status in ('pending', 'accepted', 'revoked', 'expired')),
	CONSTRAINT "business_invitations_overrides_check" CHECK (jsonb_typeof(overrides) = 'object'),
	CONSTRAINT "business_invitations_send_count_check" CHECK (send_count >= 0)
);
--> statement-breakpoint
CREATE TABLE "app"."business_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"user_id" uuid,
	"kind" text NOT NULL,
	"display_name" text NOT NULL,
	"status" text NOT NULL,
	"role_id" uuid NOT NULL,
	"permissions_version" integer DEFAULT 1 NOT NULL,
	"pin_hash" text,
	"created_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"request_hash" text,
	CONSTRAINT "business_members_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "business_members_kind_check" CHECK (kind in ('account', 'pin_only')),
	CONSTRAINT "business_members_kind_user_check" CHECK ((kind = 'pin_only') = (user_id is null)),
	CONSTRAINT "business_members_status_check" CHECK (status in ('invited', 'active', 'suspended', 'removed'))
);
--> statement-breakpoint
CREATE TABLE "app"."member_locations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"request_hash" text,
	CONSTRAINT "member_locations_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "member_locations_member_location_key" UNIQUE("business_id","member_id","location_id")
);
--> statement-breakpoint
CREATE TABLE "app"."member_permission_overrides" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"permission_key" text NOT NULL,
	"effect" text NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"request_hash" text,
	CONSTRAINT "member_permission_overrides_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "member_permission_overrides_member_permission_key" UNIQUE("business_id","member_id","permission_key"),
	CONSTRAINT "member_permission_overrides_effect_check" CHECK (effect in ('allow', 'deny'))
);
--> statement-breakpoint
CREATE TABLE "app"."role_permissions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"permission_key" text NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"request_hash" text,
	CONSTRAINT "role_permissions_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "role_permissions_business_id_role_id_permission_key_key" UNIQUE("business_id","role_id","permission_key")
);
--> statement-breakpoint
CREATE TABLE "app"."roles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"template_key" text,
	"created_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"request_hash" text,
	CONSTRAINT "roles_business_id_id_key" UNIQUE("business_id","id")
);
--> statement-breakpoint
CREATE TABLE "app"."audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"request_id" uuid,
	"changes" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_log_action_check" CHECK (action in ('insert', 'update', 'delete'))
);
--> statement-breakpoint
CREATE TABLE "app"."businesses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"legal_name" text NOT NULL,
	"legal_name_ar" text,
	"business_type" text,
	"terminology_profile" text DEFAULT 'general' NOT NULL,
	"country" char(2) DEFAULT 'AE' NOT NULL,
	"currency" char(3) DEFAULT 'AED' NOT NULL,
	"vat_registered" boolean DEFAULT false NOT NULL,
	"trn" text,
	"timezone" text DEFAULT 'Asia/Dubai' NOT NULL,
	"default_locale" text DEFAULT 'en' NOT NULL,
	"plan" text,
	"setup_completed_at" timestamp with time zone,
	"logo_path" text,
	"created_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "businesses_trn_check" CHECK (trn ~ '^[0-9]{15}$'),
	CONSTRAINT "businesses_default_locale_check" CHECK (default_locale in ('en', 'ar'))
);
--> statement-breakpoint
CREATE TABLE "app"."locations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"request_hash" text,
	CONSTRAINT "locations_business_id_id_key" UNIQUE("business_id","id")
);
--> statement-breakpoint
CREATE TABLE "app"."profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"display_name" text,
	"locale" text DEFAULT 'en' NOT NULL,
	"last_business_id" uuid,
	"anonymized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profiles_locale_check" CHECK (locale in ('en', 'ar'))
);
--> statement-breakpoint
CREATE TABLE "app"."business_capabilities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"key" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"value" jsonb,
	"source" text NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"request_hash" text,
	CONSTRAINT "business_capabilities_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "business_capabilities_business_id_key_key" UNIQUE("business_id","key"),
	CONSTRAINT "business_capabilities_key_check" CHECK (key <> 'vat_registered'),
	CONSTRAINT "business_capabilities_source_check" CHECK (source in ('setup', 'user'))
);
--> statement-breakpoint
CREATE TABLE "app"."business_modules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"module_key" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"enabled_at" timestamp with time zone,
	"enabled_by" uuid,
	"created_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"request_hash" text,
	CONSTRAINT "business_modules_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "business_modules_business_id_module_key_key" UNIQUE("business_id","module_key")
);
--> statement-breakpoint
CREATE TABLE "app"."setup_answers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"question_set_version" integer NOT NULL,
	"answers" jsonb NOT NULL,
	"created_by" uuid DEFAULT app.current_user_id() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"request_hash" text,
	CONSTRAINT "setup_answers_business_id_id_key" UNIQUE("business_id","id"),
	CONSTRAINT "setup_answers_answers_check" CHECK (jsonb_typeof(answers) = 'object')
);
--> statement-breakpoint
ALTER TABLE "app"."business_invitations" ADD CONSTRAINT "business_invitations_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."business_invitations" ADD CONSTRAINT "business_invitations_role_fk" FOREIGN KEY ("business_id","role_id") REFERENCES "app"."roles"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."business_members" ADD CONSTRAINT "business_members_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."business_members" ADD CONSTRAINT "business_members_role_fk" FOREIGN KEY ("business_id","role_id") REFERENCES "app"."roles"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."member_locations" ADD CONSTRAINT "member_locations_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."member_locations" ADD CONSTRAINT "member_locations_member_fk" FOREIGN KEY ("business_id","member_id") REFERENCES "app"."business_members"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."member_locations" ADD CONSTRAINT "member_locations_location_fk" FOREIGN KEY ("business_id","location_id") REFERENCES "app"."locations"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."member_permission_overrides" ADD CONSTRAINT "member_permission_overrides_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."member_permission_overrides" ADD CONSTRAINT "member_permission_overrides_member_fk" FOREIGN KEY ("business_id","member_id") REFERENCES "app"."business_members"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."role_permissions" ADD CONSTRAINT "role_permissions_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."role_permissions" ADD CONSTRAINT "role_permissions_role_fk" FOREIGN KEY ("business_id","role_id") REFERENCES "app"."roles"("business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."roles" ADD CONSTRAINT "roles_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."audit_log" ADD CONSTRAINT "audit_log_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."locations" ADD CONSTRAINT "locations_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."business_capabilities" ADD CONSTRAINT "business_capabilities_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."business_modules" ADD CONSTRAINT "business_modules_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."setup_answers" ADD CONSTRAINT "setup_answers_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "app"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "business_invitations_one_pending_key" ON "app"."business_invitations" USING btree ("business_id",lower((email)::text)) WHERE status = 'pending' and deleted_at is null;--> statement-breakpoint
CREATE INDEX "business_invitations_role_idx" ON "app"."business_invitations" USING btree ("business_id","role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "business_members_user_key" ON "app"."business_members" USING btree ("business_id","user_id") WHERE user_id is not null and deleted_at is null;--> statement-breakpoint
CREATE INDEX "business_members_user_idx" ON "app"."business_members" USING btree ("user_id") WHERE user_id is not null;--> statement-breakpoint
CREATE INDEX "business_members_role_idx" ON "app"."business_members" USING btree ("business_id","role_id");--> statement-breakpoint
CREATE INDEX "member_locations_location_idx" ON "app"."member_locations" USING btree ("business_id","location_id");--> statement-breakpoint
CREATE INDEX "audit_log_business_created_idx" ON "app"."audit_log" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "locations_one_default_key" ON "app"."locations" USING btree ("business_id") WHERE is_default and deleted_at is null;
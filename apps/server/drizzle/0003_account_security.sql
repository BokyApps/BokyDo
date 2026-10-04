CREATE TABLE "auth_flows" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"user_id" uuid,
	"session_id" text,
	"challenge" text,
	"secret" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recovery_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"ref" uuid DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"user_id" uuid,
	"email" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "user_tokens_ref_unique" UNIQUE("ref")
);
--> statement-breakpoint
CREATE TABLE "webauthn_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"public_key" text NOT NULL,
	"counter" bigint DEFAULT 0 NOT NULL,
	"transports" text[] DEFAULT '{}'::text[] NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean NOT NULL,
	"aaguid" text,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "public_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "auth_method" text DEFAULT 'password' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "reauthenticated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_secret" jsonb;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_enabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_last_step" integer;--> statement-breakpoint
ALTER TABLE "auth_flows" ADD CONSTRAINT "auth_flows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_flows" ADD CONSTRAINT "auth_flows_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_tokens" ADD CONSTRAINT "user_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_tokens" ADD CONSTRAINT "user_tokens_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_flows_session_idx" ON "auth_flows" USING btree ("session_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_codes_hash_idx" ON "recovery_codes" USING btree ("user_id","code_hash");--> statement-breakpoint
CREATE INDEX "user_tokens_user_idx" ON "user_tokens" USING btree ("user_id","kind");--> statement-breakpoint
CREATE INDEX "webauthn_credentials_user_idx" ON "webauthn_credentials" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_public_id_unique" UNIQUE("public_id");
CREATE TABLE "ai_credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid,
	"provider" text NOT NULL,
	"label" text NOT NULL,
	"base_url" text,
	"secret" jsonb,
	"has_key" boolean DEFAULT false NOT NULL,
	"header_names" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"credential_id" uuid,
	"billing" text NOT NULL,
	"feature" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"status" text NOT NULL,
	"reserved_tokens" integer DEFAULT 0 NOT NULL,
	"reserved_audio_seconds" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"audio_seconds" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "ai_usage_billing_check" CHECK (billing in ('own', 'instance')),
	CONSTRAINT "ai_usage_status_check" CHECK (status in ('reserved', 'done', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "ai_routing" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_credentials" ADD CONSTRAINT "ai_credentials_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_credentials" ADD CONSTRAINT "ai_credentials_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_credential_id_ai_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."ai_credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_credentials_owner_idx" ON "ai_credentials" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "ai_usage_user_started_idx" ON "ai_usage" USING btree ("user_id","started_at");
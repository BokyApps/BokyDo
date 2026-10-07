CREATE TABLE "calendar_feeds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_id" text NOT NULL,
	"kind" text NOT NULL,
	"project_id" uuid,
	"filter_id" uuid,
	"show_descriptions" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "calendar_feeds_token_id_unique" UNIQUE("token_id"),
	CONSTRAINT "calendar_feeds_target_check" CHECK ((kind = 'project' and project_id is not null and filter_id is null) or (kind = 'filter' and filter_id is not null and project_id is null))
);
--> statement-breakpoint
ALTER TABLE "calendar_feeds" ADD CONSTRAINT "calendar_feeds_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_feeds" ADD CONSTRAINT "calendar_feeds_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_feeds" ADD CONSTRAINT "calendar_feeds_filter_id_filters_id_fk" FOREIGN KEY ("filter_id") REFERENCES "public"."filters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calendar_feeds_user_idx" ON "calendar_feeds" USING btree ("user_id");
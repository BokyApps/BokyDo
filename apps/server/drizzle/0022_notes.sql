CREATE TABLE "note_files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"note_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"referenced" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "note_files_size_check" CHECK ("note_files"."size" >= 0)
);
--> statement-breakpoint
CREATE TABLE "note_links" (
	"from_note_id" uuid NOT NULL,
	"to_note_id" uuid NOT NULL,
	CONSTRAINT "note_links_from_note_id_to_note_id_pk" PRIMARY KEY("from_note_id","to_note_id")
);
--> statement-breakpoint
CREATE TABLE "note_task_links" (
	"note_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "note_task_links_note_id_task_id_source_pk" PRIMARY KEY("note_id","task_id","source"),
	CONSTRAINT "note_task_links_source_check" CHECK ("note_task_links"."source" in ('body', 'manual'))
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"trashed_at" timestamp with time zone,
	"search_text" text DEFAULT '' NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', "search_text")) STORED,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notes_title_check" CHECK (char_length("notes"."title") <= 200),
	CONSTRAINT "notes_body_check" CHECK (octet_length("notes"."body") <= 524288),
	CONSTRAINT "notes_tags_check" CHECK (cardinality("notes"."tags") <= 20),
	CONSTRAINT "notes_state_check" CHECK ("notes"."state" in ('active', 'archived'))
);
--> statement-breakpoint
ALTER TABLE "note_files" ADD CONSTRAINT "note_files_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_files" ADD CONSTRAINT "note_files_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_links" ADD CONSTRAINT "note_links_from_note_id_notes_id_fk" FOREIGN KEY ("from_note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_links" ADD CONSTRAINT "note_links_to_note_id_notes_id_fk" FOREIGN KEY ("to_note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_task_links" ADD CONSTRAINT "note_task_links_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_task_links" ADD CONSTRAINT "note_task_links_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "note_files_note_idx" ON "note_files" USING btree ("note_id");--> statement-breakpoint
CREATE INDEX "note_files_owner_idx" ON "note_files" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "note_files_pending_idx" ON "note_files" USING btree ("created_at") WHERE not "note_files"."referenced";--> statement-breakpoint
CREATE INDEX "note_links_to_idx" ON "note_links" USING btree ("to_note_id");--> statement-breakpoint
CREATE INDEX "note_task_links_task_idx" ON "note_task_links" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "notes_owner_updated_idx" ON "notes" USING btree ("owner_user_id","updated_at" desc);--> statement-breakpoint
CREATE INDEX "notes_tags_idx" ON "notes" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "notes_search_idx" ON "notes" USING gin ("search");
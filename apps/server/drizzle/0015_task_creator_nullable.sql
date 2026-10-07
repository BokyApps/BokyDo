ALTER TABLE "tasks" DROP CONSTRAINT "tasks_created_by_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "created_by_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
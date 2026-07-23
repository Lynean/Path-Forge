CREATE TABLE "project_environments" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"language" text,
	"base_image" text NOT NULL,
	"setup_commands" jsonb NOT NULL,
	"run_command" text NOT NULL,
	"dockerfile" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_environments_project_id_unique" UNIQUE("project_id")
);
--> statement-breakpoint
ALTER TABLE "project_environments" ADD CONSTRAINT "project_environments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
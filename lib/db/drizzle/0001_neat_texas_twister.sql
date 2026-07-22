CREATE TABLE "project_workspaces" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"path" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_workspaces_project_id_unique" UNIQUE("project_id")
);
--> statement-breakpoint
ALTER TABLE "project_workspaces" ADD CONSTRAINT "project_workspaces_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
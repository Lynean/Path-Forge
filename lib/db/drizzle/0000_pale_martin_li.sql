CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"clerk_user_id" text NOT NULL,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_clerk_user_id_unique" UNIQUE("clerk_user_id")
);
--> statement-breakpoint
CREATE TABLE "learner_profiles" (
	"id" serial PRIMARY KEY NOT NULL,
	"clerk_user_id" text NOT NULL,
	"age" integer,
	"education_level" text,
	"major" text,
	"profile_summary" text DEFAULT '' NOT NULL,
	"preferred_language" text,
	"is_complete" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learner_profiles_clerk_user_id_unique" UNIQUE("clerk_user_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" serial PRIMARY KEY NOT NULL,
	"clerk_user_id" text NOT NULL,
	"title" text NOT NULL,
	"idea_prompt" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "node_edges" (
	"id" serial PRIMARY KEY NOT NULL,
	"from_node_id" integer NOT NULL,
	"to_node_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "node_maps" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"raw_json" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "node_maps_project_id_unique" UNIQUE("project_id")
);
--> statement-breakpoint
CREATE TABLE "nodes" (
	"id" serial PRIMARY KEY NOT NULL,
	"map_id" integer NOT NULL,
	"title" text NOT NULL,
	"brief" text NOT NULL,
	"status" text DEFAULT 'locked' NOT NULL,
	"is_extra" boolean DEFAULT false NOT NULL,
	"summary" text,
	"position_x" real,
	"position_y" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" integer NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"node_id" integer NOT NULL,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_sessions_node_id_unique" UNIQUE("node_id")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" integer NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_code_context" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"files" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_code_context_project_id_unique" UNIQUE("project_id")
);
--> statement-breakpoint
CREATE TABLE "learner_recommendations" (
	"id" serial PRIMARY KEY NOT NULL,
	"clerk_user_id" text NOT NULL,
	"recommendations" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learner_recommendations_clerk_user_id_unique" UNIQUE("clerk_user_id")
);
--> statement-breakpoint
CREATE TABLE "agent_run_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"clerk_user_id" text NOT NULL,
	"project_id" integer,
	"node_id" integer,
	"runtime" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"user_message" text NOT NULL,
	"response" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "agent_runs_run_id_unique" UNIQUE("run_id")
);
--> statement-breakpoint
ALTER TABLE "node_edges" ADD CONSTRAINT "node_edges_from_node_id_nodes_id_fk" FOREIGN KEY ("from_node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_edges" ADD CONSTRAINT "node_edges_to_node_id_nodes_id_fk" FOREIGN KEY ("to_node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_maps" ADD CONSTRAINT "node_maps_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_map_id_node_maps_id_fk" FOREIGN KEY ("map_id") REFERENCES "public"."node_maps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_code_context" ADD CONSTRAINT "project_code_context_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "projects_clerk_user_id_idx" ON "projects" USING btree ("clerk_user_id");--> statement-breakpoint
CREATE INDEX "node_edges_from_node_id_idx" ON "node_edges" USING btree ("from_node_id");--> statement-breakpoint
CREATE INDEX "node_edges_to_node_id_idx" ON "node_edges" USING btree ("to_node_id");--> statement-breakpoint
CREATE INDEX "nodes_map_id_idx" ON "nodes" USING btree ("map_id");
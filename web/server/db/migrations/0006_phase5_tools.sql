CREATE TABLE "plugins" (
	"id" text PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"bundle_key" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_servers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"spec_url" text,
	"base_url" text NOT NULL,
	"operations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"auth_cipher" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- pgvector: the vector extension ships in pgvector/pgvector:pg16 and is loaded by PGlite
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "app_config" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

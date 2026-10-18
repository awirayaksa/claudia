-- The text a message node shows (its "text" parts), for the full-text index.
-- IMMUTABLE so a generated column can use it.
CREATE OR REPLACE FUNCTION claudia_parts_text(parts jsonb) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(string_agg(p->>'text', ' '), '')
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(parts) = 'array' THEN parts ELSE '[]'::jsonb END) AS p
  WHERE p->>'type' = 'text'
$$;
--> statement-breakpoint
CREATE TABLE "shares" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"chat_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "tags" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "meta" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, claudia_parts_text(parts))) STORED;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shares_token_idx" ON "shares" USING btree ("token");--> statement-breakpoint
CREATE UNIQUE INDEX "shares_chat_idx" ON "shares" USING btree ("chat_id");--> statement-breakpoint
CREATE INDEX "chats_tags_idx" ON "chats" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "messages_search_idx" ON "messages" USING gin ("search");
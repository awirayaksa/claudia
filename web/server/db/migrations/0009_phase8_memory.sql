CREATE TABLE "memory_changes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"memory_id" uuid NOT NULL,
	"action" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"message_id" uuid,
	"undone_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "topic" text DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "source" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "folder_id" uuid;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "chat_id" uuid;--> statement-breakpoint
ALTER TABLE "memory_changes" ADD CONSTRAINT "memory_changes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_changes" ADD CONSTRAINT "memory_changes_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_changes_user_idx" ON "memory_changes" USING btree ("user_id","created_at");--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memories_folder_idx" ON "memories" USING btree ("folder_id");
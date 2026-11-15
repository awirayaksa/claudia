CREATE TABLE "conversation_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid,
	"user_email" text,
	"source" text NOT NULL,
	"chat_id" uuid,
	"chat_title" text,
	"message_id" uuid,
	"model_id" text NOT NULL,
	"prompt" text NOT NULL,
	"reply" text NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" text
);
--> statement-breakpoint
ALTER TABLE "conversation_log" ADD CONSTRAINT "conversation_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_log_created_idx" ON "conversation_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "conversation_log_user_created_idx" ON "conversation_log" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "conversation_log_chat_idx" ON "conversation_log" USING btree ("chat_id");
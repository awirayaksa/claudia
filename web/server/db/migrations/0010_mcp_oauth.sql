CREATE TABLE "mcp_oauth" (
	"server_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"cipher" text NOT NULL,
	"pending_state" text,
	"pending_expires_at" timestamp with time zone,
	"connected_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_oauth" ADD CONSTRAINT "mcp_oauth_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth" ADD CONSTRAINT "mcp_oauth_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_oauth_state_idx" ON "mcp_oauth" USING btree ("pending_state");
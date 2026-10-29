CREATE TABLE "azdo_connections" (
	"user_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"pat_cipher" text NOT NULL,
	"display_name" text,
	"default_project" text,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "azdo_connections_user_id_server_id_pk" PRIMARY KEY("user_id","server_id")
);
--> statement-breakpoint
ALTER TABLE "azdo_connections" ADD CONSTRAINT "azdo_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
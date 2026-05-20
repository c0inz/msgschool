CREATE TABLE "ms_code_redemptions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ms_code_redemptions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer NOT NULL,
	"code" text NOT NULL,
	"period_days" integer NOT NULL,
	"redeemed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ms_messages" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ms_messages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer,
	"telegram_user_id" bigint NOT NULL,
	"direction" text NOT NULL,
	"text" text NOT NULL,
	"meta" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ms_users" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ms_users_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"telegram_user_id" bigint NOT NULL,
	"telegram_username" text,
	"telegram_first_name" text,
	"state" text DEFAULT 'new' NOT NULL,
	"free_uses_remaining" integer DEFAULT 3 NOT NULL,
	"workspace_path" text,
	"activated_at" timestamp,
	"expires_at" timestamp,
	"first_seen_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ms_code_redemptions" ADD CONSTRAINT "ms_code_redemptions_user_id_ms_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."ms_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ms_messages" ADD CONSTRAINT "ms_messages_user_id_ms_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."ms_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ms_users_telegram_user_id_unique" ON "ms_users" USING btree ("telegram_user_id");
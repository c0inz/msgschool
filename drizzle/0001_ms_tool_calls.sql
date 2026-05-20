-- Drift catch-up: ms_users.pending_delete_at was added manually in prod
-- before drizzle tracked it. Idempotent ADD so this migration is a no-op
-- on hosts that already have the column.
ALTER TABLE "ms_users" ADD COLUMN IF NOT EXISTS "pending_delete_at" timestamp;
--> statement-breakpoint

-- New: ms_tool_calls — audit log for msgschool-toolsd RPC calls.
-- See docs/TOOLSD_SPEC.md §10.
CREATE TABLE IF NOT EXISTS "ms_tool_calls" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ms_tool_calls_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"telegram_user_id" bigint NOT NULL,
	"tool" text NOT NULL,
	"args_summary" text,
	"result_size_bytes" integer,
	"cache_hit" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer,
	"error_code" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- Lookup index for the admin panel's "tool calls per user" queries
-- (planned in ADMIN_PANEL_SPEC.md). created_at separately for time-range
-- aggregations.
CREATE INDEX IF NOT EXISTS "ms_tool_calls_tg_idx" ON "ms_tool_calls" ("telegram_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ms_tool_calls_created_idx" ON "ms_tool_calls" ("created_at");

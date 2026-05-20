import {
  bigint,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * All msgschool tables live in the default `public` schema (same as
 * OCMarketplace's tables) but are prefixed `ms_` to avoid collisions on
 * common names like `users` and `messages`.
 *
 * When OCMarketplace is retired, a single rename migration drops the prefix
 * (ms_users → users, etc.) and msgschool owns the schema outright.
 *
 * Why new tables at all: OCM's `public.users` is better-auth (email/password/
 * sessions). MsgSchool users are Telegram-only — no email, no password. The
 * columns barely overlap, so extending the existing table would be worse than
 * a dedicated one.
 */

/**
 * ms_users — one row per Telegram account that has ever messaged the bot.
 *
 * Primary identity is the Telegram numeric user_id (stable, unforgeable).
 * Telegram username is a display hint (mutable; never used for auth).
 */
export const users = pgTable(
  "ms_users",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    telegramUserId: bigint("telegram_user_id", { mode: "number" }).notNull(),
    telegramUsername: text("telegram_username"),
    telegramFirstName: text("telegram_first_name"),

    // Onboarding state — drives the bot's next reply.
    // 'new'       → just said hello, hasn't entered a code yet
    // 'active'    → unlocked (via free code today; paid later)
    // 'expired'   → previously active, beyond expires_at
    state: text("state").notNull().default("new"),

    // Free-tier metering (CleanRelay-style soft cap for pre-code users).
    freeUsesRemaining: integer("free_uses_remaining").notNull().default(3),

    // Filesystem path of their provisioned workspace. Null until activation.
    workspacePath: text("workspace_path"),

    // Activation + expiry — null when 'new'.
    activatedAt: timestamp("activated_at"),
    expiresAt: timestamp("expires_at"),

    // Set when the user issues /delete. If they confirm with the exact phrase
    // within 5 minutes, deletion runs. Any other message or a timeout clears
    // this back to null.
    pendingDeleteAt: timestamp("pending_delete_at"),

    firstSeenAt: timestamp("first_seen_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    telegramUserIdUnique: uniqueIndex("ms_users_telegram_user_id_unique").on(t.telegramUserId),
  })
);

/**
 * ms_code_redemptions — audit log of unlock-code uses.
 */
export const codeRedemptions = pgTable("ms_code_redemptions", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  periodDays: integer("period_days").notNull(),
  redeemedAt: timestamp("redeemed_at").notNull().defaultNow(),
});

/**
 * ms_messages — inbound + outbound log for debug, abuse review, and audit.
 *
 * We don't rely on this for conversation context; the agent keeps its own
 * memory inside the per-user workspace. This is the platform's audit trail.
 */
export const messages = pgTable("ms_messages", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
  telegramUserId: bigint("telegram_user_id", { mode: "number" }).notNull(),
  direction: text("direction").notNull(), // 'in' | 'out'
  text: text("text").notNull(),
  meta: text("meta"), // JSON string for anything structured
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/**
 * ms_tool_calls — audit log for every msgschool-toolsd RPC.
 *
 * Each row is one call from an agent to the platform-owned tool daemon.
 * See docs/TOOLSD_SPEC.md §10. Holds *no* credential value, *no* response
 * body — only metadata sufficient to answer "is the agent using the tools
 * we built and is the daemon healthy". args_summary contains scrubbed,
 * non-sensitive keys only (course_id, term, since) — never a token, URL,
 * username, or password.
 */
export const toolCalls = pgTable("ms_tool_calls", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  telegramUserId: bigint("telegram_user_id", { mode: "number" }).notNull(),
  tool: text("tool").notNull(),
  argsSummary: text("args_summary"), // JSON string; non-sensitive keys only
  resultSizeBytes: integer("result_size_bytes"),
  cacheHit: integer("cache_hit").notNull().default(0), // 0/1; pg-typed as int for portability
  latencyMs: integer("latency_ms"),
  errorCode: text("error_code"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type CodeRedemption = typeof codeRedemptions.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type ToolCall = typeof toolCalls.$inferSelect;

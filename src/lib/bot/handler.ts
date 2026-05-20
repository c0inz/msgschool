/**
 * Telegram bot handler — state machine driven by the `users.state` column.
 *
 * States:
 *   new           → sent hello, hasn't entered a code yet. free-tier nudges.
 *   provisioning  → redeemed code just now; workspace + binding being set up.
 *                   DROP inbound messages (user shouldn't be talking — agent
 *                   is about to greet them).
 *   active        → paired. msgschool is SILENT. forward every message to
 *                   the user's OpenClaw agent via the gateway.
 *   expired       → access window elapsed. renewal nudge.
 *
 * After `active`, msgschool never speaks in its own voice again. The user's
 * agent owns the Telegram conversation end to end.
 */

import { and, eq, sql } from "drizzle-orm";
import { db, users, codeRedemptions, messages as messagesTable } from "../db";
import { deleteMessage, sendChatAction, sendMessage, sendPhoto, TelegramUpdate } from "../telegram";
import { copy } from "./messages";
import { provisionAgent, runAgentTurn, resetWorkspaceMemory, rotateSessionNonce } from "./provision";
import { detect as detectCreds, groupByService, type DetectionResult } from "./credential-detector";
import { mergeCreds, fieldsPresent, ensureUserHydrated, type CanvasCreds, type SkywardCreds } from "./credential-store";
import { validate as validateProcedure, type HardFail } from "../agent/validator";
import { extractEnvelope, appendSoftWarnings, detectForbiddenNarration, detectFreelanceOnboarding, isOpenclawNoReply } from "../agent/envelope";

const FREE_CODE = (process.env.FREE_CODE || "FreeAgent2026").trim();
const FREE_CODE_PERIOD_DAYS = Number(process.env.FREE_CODE_PERIOD_DAYS || 30);
const DAILY_MSG_LIMIT = Number(process.env.DAILY_MSG_LIMIT || 15);
const MONTHLY_MSG_LIMIT = Number(process.env.MONTHLY_MSG_LIMIT || 60);

/**
 * Telegram user IDs that bypass daily + monthly rate limits and never see
 * the expiry block. Operators (us) — keep this list short and hardcoded so
 * "who has unlimited access" is reviewable in source control instead of
 * scattered through the DB. Also keep ms_users.expires_at = NULL for
 * these users so the DB tells the same story.
 */
const UNLIMITED_TELEGRAM_USER_IDS: ReadonlySet<number> = new Set([
  100000001,  // John (JohnnyCoin / @JohnTDavenport)
  100000002,  // Sarah
]);
/**
 * CREDENTIAL_CAPTURE feature flag, per docs/CREDENTIAL_CAPTURE_SPEC.md §migration.
 *   off      — current pass-through behavior. Platform does nothing. (default)
 *   shadow   — detect, log what WOULD happen. No write, no delete, no receipt.
 *              Used to validate the classifier against real traffic for 24h
 *              before flipping to authoritative.
 *   on       — authoritative. Detect → write encrypted → delete paste from
 *              Telegram → send receipt → notify agent via [SYSTEM].
 */
const CREDENTIAL_CAPTURE = (process.env.CREDENTIAL_CAPTURE || "off").toLowerCase() as "off" | "shadow" | "on";

export async function handleUpdate(update: TelegramUpdate): Promise<void> {
  const msg = update.message ?? update.edited_message;
  if (!msg) return;
  if (!msg.from || msg.from.is_bot) return;

  const tgUserId = msg.from.id;
  const chatId = msg.chat.id;
  const text = (msg.text ?? "").trim();

  // 1. Find or create user row.
  let user = await db.query.users.findFirst({
    where: eq(users.telegramUserId, tgUserId),
  });

  if (!user) {
    const [created] = await db
      .insert(users)
      .values({
        telegramUserId: tgUserId,
        telegramUsername: msg.from.username ?? null,
        telegramFirstName: msg.from.first_name ?? null,
      })
      .returning();
    user = created;
    await logMessage(user.id, tgUserId, "in", text);
    await sendMessage(chatId, copy.greeting(msg.from.first_name), { parseMode: "Markdown" });
    await logMessage(user.id, tgUserId, "out", "<greeting>");
    return;
  }

  // Refresh Telegram display fields if they changed on their side.
  if (
    msg.from.username !== user.telegramUsername ||
    msg.from.first_name !== user.telegramFirstName
  ) {
    await db
      .update(users)
      .set({
        telegramUsername: msg.from.username ?? null,
        telegramFirstName: msg.from.first_name ?? null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));
  }

  // 1a. Platform-owned credential capture (behind CREDENTIAL_CAPTURE flag).
  //     Runs BEFORE logging the inbound so we can log the scrubbed label
  //     instead of the raw paste. See docs/CREDENTIAL_CAPTURE_SPEC.md.
  let detection: DetectionResult | null = null;
  let scrubbedLabel: string | null = null;
  if (user.state === "active" && CREDENTIAL_CAPTURE !== "off") {
    const recentAgentText = await fetchRecentAgentText(tgUserId, 10);
    detection = detectCreds(text, { recentAgentText });
    if (detection.hasAnyCredential) {
      scrubbedLabel = `[scrubbed: ${(detection.fields.map((f) => f.field).join(",")) || "unclassified"}]`;
    }
  }

  await logMessage(user.id, tgUserId, "in", scrubbedLabel ?? text);

  // 1b. Daily + monthly rate limit — count inbound messages in the last
  //     rolling 24 hours AND 30 days. Credential captures DO count toward the
  //     limit (they're still user activity we ran code against); /help etc.
  //     are exempt. FREE_CODE redemption exempt so onboarding isn't blocked.
  if (
    user.state === "active" &&
    !isRateLimitExempt(text) &&
    text !== FREE_CODE &&
    !UNLIMITED_TELEGRAM_USER_IDS.has(tgUserId)
  ) {
    const limited = await checkAndEnforceRateLimit(user.id, tgUserId, chatId);
    if (limited) return;
  }

  // 1c. Authoritative credential capture. If the flag is "on" AND we detected
  //     anything credential-shaped (classified OR unclassified), short-circuit
  //     the normal dispatch: write encrypted (when classified), delete from
  //     Telegram, send receipt, nudge the agent. Agent never sees the raw
  //     paste.
  //
  //     Branching on `hasAnyCredential` (rather than `fields.length > 0`)
  //     fixes the 2026-04-30 bug where a credential-shaped message that the
  //     classifier couldn't pin to a specific service was redacted in DB
  //     but left in Telegram chat AND forwarded to the agent in plaintext.
  //     See docs/TOOLSD_SPEC.md §1.
  if (
    user.state === "active" &&
    CREDENTIAL_CAPTURE === "on" &&
    detection &&
    detection.hasAnyCredential
  ) {
    if (detection.fields.length > 0) {
      await handleCapturedCredentials(user.id, tgUserId, chatId, msg.message_id, detection);
    } else {
      // Unclassified but credential-shaped. Delete from chat, do NOT write
      // anything to disk (service unknown), and hand off to the agent so
      // *the agent* asks the user — not the platform. The agent owns the
      // conversation; the platform stays out of the user's voice channel.
      await handleUnclassifiedCredentialPaste(user.id, tgUserId, chatId, msg.message_id);
    }
    return;
  }
  // Shadow mode: log what we WOULD have captured but let the agent keep
  // handling credentials as it does today. Safe to run for 24h to validate
  // classifier accuracy before flipping authoritative.
  if (detection && detection.hasAnyCredential && CREDENTIAL_CAPTURE === "shadow") {
    console.log(
      `[creds/shadow] tg=${tgUserId} fields=${JSON.stringify(
        detection.fields.map((f) => ({ field: f.field, confidence: f.confidence, why: f.why })),
      )} ambiguous=${detection.ambiguous.length}`,
    );
  }

  // 2. Auto-expire past-due active users on next message.
  //    Unlimited users (operator list) are exempt — they never expire.
  if (
    user.state === "active" &&
    user.expiresAt &&
    user.expiresAt.getTime() < Date.now() &&
    !UNLIMITED_TELEGRAM_USER_IDS.has(tgUserId)
  ) {
    await db
      .update(users)
      .set({ state: "expired", updatedAt: new Date() })
      .where(eq(users.id, user.id));
    user.state = "expired";
  }

  // 3. Redemption attempt — any state may try a code.
  //    (An active user retyping the code hits the "already redeemed" branch.)
  if (text === FREE_CODE) {
    await redeemAndHandOff(user.id, tgUserId, chatId);
    return;
  }

  // 3b. /reset handled at platform layer — don't trust agent compliance.
  //     Truncate MEMORY.md + memory/*.md, rotate session nonce, reply.
  //     Only active users can reset meaningfully (they have a workspace).
  if (/^\s*\/reset\s*$/i.test(text) && user.state === "active") {
    await resetWorkspaceMemory(tgUserId);
    const newNonce = await rotateSessionNonce(tgUserId);
    await sendMessage(chatId, "🧠 Memory cleared. Next question starts fresh.");
    await logMessage(user.id, tgUserId, "out", `<reset: session=${newNonce}>`);
    return;
  }

  // 3c. /delete — two-step platform-owned account deletion. Step 1 sets a
  //     pending_delete_at timestamp and replies with the confirmation prompt.
  //     Step 2 (next message) must be exactly YES-DELETE-MY-ACCOUNT within
  //     5 minutes. Any other message cancels. Works regardless of user state.
  if (await handleDeleteFlow(user, tgUserId, chatId, text)) return;

  // 4. Dispatch by state.
  switch (user.state) {
    case "provisioning":
      // User's typing while we're spinning up their agent. Drop silently;
      // the agent's greeting is on its way.
      await logMessage(user.id, tgUserId, "out", "<drop: provisioning>");
      return;

    case "active":
      await dispatchActiveToAgent(user.id, tgUserId, chatId, text);
      return;

    case "expired":
      await sendMessage(chatId, copy.expired, { parseMode: "Markdown" });
      await logMessage(user.id, tgUserId, "out", "<expired>");
      return;

    case "new":
    default:
      await handleNewPreReg(user.id, tgUserId, chatId, user.freeUsesRemaining ?? 0);
      return;
  }
}

/**
 * Flip 'new' → 'provisioning', tell the user we're configuring, run the
 * provision script, flip to 'active', seed the agent greeting.
 *
 * If provisioning fails, we flip back to 'new' and tell the user (the only
 * failure path where msgschool still speaks to a post-code user).
 */
async function redeemAndHandOff(userId: number, tgUserId: number, chatId: number) {
  const existing = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!existing) return;

  const now = new Date();

  // If already active and not expired, don't re-run provision.
  if (
    existing.state === "active" &&
    existing.expiresAt &&
    existing.expiresAt.getTime() > now.getTime()
  ) {
    await sendMessage(chatId, copy.codeAlreadyRedeemed(existing.expiresAt), {
      parseMode: "Markdown",
    });
    return;
  }

  // Flag provisioning BEFORE any work, so any concurrent inbound gets dropped.
  await db
    .update(users)
    .set({ state: "provisioning", updatedAt: now })
    .where(eq(users.id, userId));

  await sendMessage(chatId, copy.configuring);
  await logMessage(userId, tgUserId, "out", "<configuring>");

  const displayName =
    existing.telegramFirstName ||
    existing.telegramUsername ||
    null;

  const result = await provisionAgent(tgUserId, displayName);

  if (!result.ok) {
    // Roll back state so they can try again. Surface a soft error.
    await db
      .update(users)
      .set({ state: existing.state, updatedAt: new Date() })
      .where(eq(users.id, userId));
    await sendMessage(chatId, copy.provisioningFailed);
    await logMessage(userId, tgUserId, "out", "<provision failed>");
    return;
  }

  const expiresAt = new Date(now.getTime() + FREE_CODE_PERIOD_DAYS * 24 * 60 * 60 * 1000);
  const workspacePath = `/opt/msgschool/users/${result.agentId}/workspace`;

  await db
    .update(users)
    .set({
      state: "active",
      activatedAt: existing.activatedAt ?? now,
      expiresAt,
      workspacePath,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));

  await db.insert(codeRedemptions).values({
    userId,
    code: FREE_CODE,
    periodDays: FREE_CODE_PERIOD_DAYS,
  });

  // Seed the agent with a "Hello" turn; its response is the onboarding
  // greeting defined in PERSONA.md. We send it via our own Bot API helper
  // (the gateway's telegram channel is disabled — msgschool owns the wire).
  const turn = await runAgentTurn(tgUserId, "Hello", result.agentId!);
  if (!turn.ok || !turn.text) {
    console.error("[seed-hello] no reply:", turn.error);
    await sendMessage(chatId, copy.provisioningFailed);
    await logMessage(userId, tgUserId, "out", "<seed hello failed>");
    return;
  }
  await sendAgentReplyWithImages(chatId, tgUserId, turn.text);
  await logMessage(userId, tgUserId, "out", "<agent greeting>");
}

/**
 * Active user sent a normal message. Shell out to their OpenClaw agent,
 * parse the reply text, send it via Bot API. msgschool never speaks in
 * its own voice for active users; this is the agent's mouth.
 */
/** Max validator-driven retries before we give up and surface honest failure. */
const VALIDATOR_MAX_RETRIES = 2;

/**
 * Master gate switch. When MSGSCHOOL_GATE_ENABLED=false the dispatcher
 * skips the entire validator-retry chain (envelope check, narration
 * detector, NO_REPLY sentinel, freelance-onboarding detector). Strips the
 * <msgschool-validate> tag from the text and ships the agent's reply
 * unchanged — same as msgschool behavior pre-validator (2026-04-28).
 *
 * Used to test whether a model (e.g. Qwen 3.6-35B-A3B) produces good
 * enough output on its own that the gate isn't pulling its weight.
 *
 * Default ON — gate behavior is the current production contract.
 * Set MSGSCHOOL_GATE_ENABLED=false in the service env to disable.
 */
const GATE_ENABLED = (process.env.MSGSCHOOL_GATE_ENABLED ?? "true").toLowerCase() !== "false";

async function dispatchActiveToAgent(
  userId: number,
  tgUserId: number,
  chatId: number,
  text: string,
) {
  const agentId = `canvasagent-${tgUserId}`;

  // Before dispatching, make sure this user's encrypted credentials are
  // decrypted into tmpfs so the agent's file-read through the workspace
  // symlink returns plaintext. No-op if already hot.
  await ensureUserHydrated(tgUserId);

  // Keep Telegram's typing indicator alive across the (potentially slow) turn.
  // Telegram expires chat action after ~5s, so refresh every 4s until done.
  void sendChatAction(chatId, "typing");
  const typingInterval = setInterval(() => {
    void sendChatAction(chatId, "typing");
  }, 4000);

  let turn;
  let attempt = 0;
  let lastHardFails: HardFail[] = [];

  // Gate-disabled fast path: skip the entire validator-retry chain. Run
  // one agent turn, strip any envelope tag for cleanliness, ship.
  if (!GATE_ENABLED) {
    try {
      turn = await runAgentTurn(tgUserId, text, agentId);
      if (turn.ok && turn.text) {
        const { text: stripped } = extractEnvelope(turn.text);
        turn = { ...turn, text: stripped };
      }
    } finally {
      clearInterval(typingInterval);
    }
    if (!turn.ok || !turn.text) {
      console.error("[dispatch] no reply (gate-off):", turn.error);
      await logMessage(userId, tgUserId, "out", `<dispatch failed: ${turn.error ?? "no text"}>`);
      return;
    }
    await sendAgentReplyWithImages(chatId, tgUserId, turn.text);
    await logMessage(userId, tgUserId, "out", "<agent reply (gate-off)>");
    return;
  }

  // Validator-driven retry loop. The agent emits a <msgschool-validate>...</msgschool-validate>
  // envelope alongside its user-facing reply when it has structured data
  // (PULSE / ASSIGNMENT_STATUS / CURRICULUM_LOOKUP). When the envelope is
  // present we run validator.ts on it; on hard fails we re-prompt the agent
  // with the violated rule explicit. When the envelope is absent we ship
  // the reply unchanged — same behavior as today.
  try {
    while (true) {
      const promptForThisAttempt = attempt === 0
        ? text
        : buildRetryPrompt(text, lastHardFails);

      turn = await runAgentTurn(tgUserId, promptForThisAttempt, agentId);

      if (!turn.ok || !turn.text) break;

      const { text: stripped, envelope, parseError } = extractEnvelope(turn.text);

      // OpenClaw NO_REPLY sentinel — the gateway's own "no-op" convention
      // (used in pre-compaction memory-flush prompts). NEVER ship to user.
      // If we got it, the previous prompt collided with OpenClaw's internal
      // channels; treat as a hard fail with a unique rule name and retry.
      const isNoReply = isOpenclawNoReply(stripped);
      // Forbidden-narration detection — the model is supposed to ship one
      // final reply per turn (no "pulling now…", "one moment", etc., per
      // AGENTS.md §"One reply per turn"). A reply that's just narration is
      // useless to the user; force a retry asking for the actual answer.
      const narration = !isNoReply ? detectForbiddenNarration(stripped) : null;
      // Freelance-onboarding detection — Sonnet ignores AGENTS.md HARD RULES
      // during onboarding even with thinking=off (regression observed
      // 2026-04-29). Force retry with explicit "use the scope-picker
      // template verbatim" instruction.
      const freelance = (!isNoReply && !narration) ? detectFreelanceOnboarding(stripped) : null;

      if (!envelope) {
        if (parseError) {
          console.warn("[dispatch] tg=%d malformed envelope: %s", tgUserId, parseError);
        }
        if (isNoReply && attempt < VALIDATOR_MAX_RETRIES) {
          console.warn(
            "[dispatch] tg=%d attempt=%d NO_REPLY sentinel, retrying",
            tgUserId, attempt,
          );
          lastHardFails = [{
            rule: "OPENCLAW_NO_REPLY_SENTINEL",
            message: `The previous response was the literal string "NO_REPLY" — that is OpenClaw's no-op sentinel and must NEVER be sent to the user. Produce the actual answer to the user's question, or report a real failure with a specific tool error.`,
          }];
          attempt += 1;
          continue;
        }
        if (isNoReply) {
          // Out of retries — agent kept emitting NO_REPLY. Honest failure.
          turn = { ...turn, text: composeHonestFailure([{
            rule: "OPENCLAW_NO_REPLY_SENTINEL",
            message: "NO_REPLY sentinel",
          }]) };
          break;
        }
        if (narration && attempt < VALIDATOR_MAX_RETRIES) {
          console.warn(
            "[dispatch] tg=%d attempt=%d narration detected, retrying: %s",
            tgUserId, attempt, narration,
          );
          lastHardFails = [{
            rule: "FORBIDDEN_NARRATION",
            message: `The previous response was process narration ("${narration}"), not the actual answer. Produce the data the user asked for, or report a real failure with a specific tool error. Do not narrate.`,
          }];
          attempt += 1;
          continue;
        }
        if (narration) {
          // Out of retries — ship an honest failure rather than narration.
          turn = { ...turn, text: composeHonestFailure([{
            rule: "FORBIDDEN_NARRATION",
            message: "process narration",
          }]) };
          break;
        }
        if (freelance && attempt < VALIDATOR_MAX_RETRIES) {
          console.warn(
            "[dispatch] tg=%d attempt=%d freelance onboarding detected, retrying: %s",
            tgUserId, attempt, freelance,
          );
          lastHardFails = [{
            rule: "FREELANCE_ONBOARDING",
            message: `Your previous response went off-script ("${freelance}") and violated AGENTS.md HARD RULES. Re-read AGENTS.md "Onboarding — the FIRST 3 TURNS" section and the HARD RULES list. On the very next turn, produce the verbatim scope-picker template (three colored scope cards + role/name ask). Do NOT ask "which system does your school use" (the answer is Canvas + Skyward — it's in our name). Do NOT label options "Option A / Option B" — name the scopes Scope 1, Scope 2, Scope 3. Do NOT use placeholder URLs. Do NOT say "I keep these secure" or other helper-bot reassurance.`,
          }];
          attempt += 1;
          continue;
        }
        if (freelance) {
          // Out of retries — ship the AGENTS.md scope-picker text directly,
          // bypassing the agent. Better to give the user the right thing
          // straight from the platform than ship more drift.
          turn = { ...turn, text: composeHonestFailure([{
            rule: "FREELANCE_ONBOARDING",
            message: "agent kept going off-script during onboarding",
          }]) };
          break;
        }
        // No envelope, no narration, not NO_REPLY, no freelance drift —
        // short conversational reply ("Hello!", "got it", etc.). Ship unchanged.
        turn = { ...turn, text: stripped };
        break;
      }

      const result = validateProcedure(envelope);
      if (result.passed) {
        // Attach any soft warnings to the user-facing text.
        const finalText = appendSoftWarnings(stripped, result.soft_warnings);
        turn = { ...turn, text: finalText };
        if (result.soft_warnings.length > 0) {
          console.log(
            "[dispatch] tg=%d shipped with %d soft warnings: %s",
            tgUserId,
            result.soft_warnings.length,
            result.soft_warnings.map(w => w.rule).join(","),
          );
        }
        break;
      }

      // Hard fail — log it, decide whether to retry.
      lastHardFails = result.hard_fails;
      console.warn(
        "[dispatch] tg=%d attempt=%d hard fails: %s",
        tgUserId,
        attempt,
        lastHardFails.map(f => f.rule).join(","),
      );
      if (attempt >= VALIDATOR_MAX_RETRIES) {
        turn = { ...turn, text: composeHonestFailure(lastHardFails) };
        break;
      }
      attempt += 1;
    }
  } finally {
    clearInterval(typingInterval);
  }

  if (!turn.ok || !turn.text) {
    console.error("[dispatch] no reply:", turn.error);
    await logMessage(userId, tgUserId, "out", `<dispatch failed: ${turn.error ?? "no text"}>`);
    return;
  }

  await sendAgentReplyWithImages(chatId, tgUserId, turn.text);
  await logMessage(userId, tgUserId, "out", "<agent reply>");
}

/**
 * Build a retry prompt that re-issues the user's original message PLUS the
 * specific validator failures, so the agent can correct course on the next
 * attempt. The retry prompt is internal — the user never sees it.
 *
 * Important: do NOT prefix this with "[SYSTEM]". OpenClaw's gateway uses
 * `[SYSTEM]`-prefixed prompts for its own pre-compaction memory-flush
 * channel, which has a "reply NO_REPLY if nothing to store" convention.
 * On 2026-04-28 a [SYSTEM]-prefixed validator retry collided with that
 * channel and the model emitted NO_REPLY back to a real user question.
 * We use an explicit "RETRY REQUIRED" header instead so the model treats
 * it as a directive, not a memory-flush opt-out.
 */
function buildRetryPrompt(originalUserText: string, fails: HardFail[]): string {
  const failLines = fails
    .map(f => `- ${f.rule}: ${f.message}`)
    .join("\n");
  return [
    "RETRY REQUIRED — your previous response failed validation and was discarded.",
    "Do not apologize. Do not narrate. Do not reply NO_REPLY. Re-run the procedure correcting these specific issues:",
    failLines,
    "Then re-emit the <msgschool-validate>…</msgschool-validate> envelope at the end of your reply.",
    "The user is still waiting on this question:",
    "",
    originalUserText,
  ].join("\n");
}

/**
 * After exhausting retries, produce an honest failure message instead of a
 * probably-wrong report. The text is what gets sent to Telegram; no envelope.
 */
function composeHonestFailure(fails: HardFail[]): string {
  const ruleSummary = [...new Set(fails.map(f => f.rule))].join(", ");
  return [
    "I couldn't get a verified answer this time.",
    "",
    `Validation kept failing on: ${ruleSummary}.`,
    "",
    "Want me to retry, or do you want to check yourself?",
  ].join("\n");
}

/**
 * Agent replies can embed `[IMG:name]` sentinels to attach a pre-hosted
 * help image. `name` maps to `https://msgschool.com/help/<name>.jpg` (files
 * live under `public/help/` in the Next.js app).
 *
 * Strips the sentinels from the text body, sends the text first, then sends
 * each photo after.
 */
const IMG_BASE_URL = (process.env.NEXT_PUBLIC_SITE_URL || "https://msgschool.com").replace(/\/+$/, "");
const IMG_ALLOWLIST = new Set(["canvas-token"]);

/**
 * Heuristic: is the agent obviously talking about a help topic we have an
 * image for? Used to auto-attach the image when the agent forgot to emit the
 * [IMG:] sentinel. Kimi k2.6 regularly writes "here are screenshots" + a prose
 * description and doesn't emit the sentinel even when PERSONA says to — the
 * fallback catches that case.
 *
 * Keep each topic's test tight. False positives attach an irrelevant image
 * to a normal reply, which is worse than a missed attach.
 */
function impliedHelpImages(reply: string): string[] {
  const out: string[] = [];
  const lower = reply.toLowerCase();
  // Canvas token generation flow — look for the specific phrase cluster
  if (
    /approved integrations/.test(lower) &&
    (/new access token|\+ new access token|generate token/.test(lower) ||
      /screenshot|picture|image|walkthrough/.test(lower))
  ) {
    out.push("canvas-token");
  }
  return out;
}

async function sendAgentReplyWithImages(
  chatId: number,
  tgUserId: number,
  reply: string,
): Promise<void> {
  const imgNames: string[] = [];
  let text = reply.replace(/\[IMG:([a-z0-9_\-]+)\]/gi, (_, name) => {
    const normalized = String(name).toLowerCase();
    if (IMG_ALLOWLIST.has(normalized)) imgNames.push(normalized);
    return "";
  }).replace(/\n{3,}/g, "\n\n").trim();

  // Heuristic fallback: if the agent talks about help topics but didn't emit
  // the sentinel, auto-attach what it was clearly referring to.
  if (imgNames.length === 0) {
    for (const name of impliedHelpImages(text)) {
      if (IMG_ALLOWLIST.has(name)) imgNames.push(name);
    }
  }

  // Outbound credential scrubber. Defense-in-depth — even if the agent
  // (or a tool result it pasted into chat) contains a literal credential
  // value, we replace it with [redacted] before it lands in Telegram.
  // See docs/TOOLSD_SPEC.md §1 + the 2026-04-30 incident on tg=100000001.
  try {
    const { scrubOutbound } = await import("../toolsd/scrub.ts");
    const scrubbed = await scrubOutbound(tgUserId, text);
    if (scrubbed.redactions > 0) {
      console.warn(
        `[scrub] OUTBOUND redactions=${scrubbed.redactions} tg=${tgUserId} ` +
          `chat=${chatId} — agent attempted to echo a credential value`,
      );
    }
    text = scrubbed.text;
  } catch (err) {
    console.error("[scrub] outbound scrubber failed:", (err as Error).message);
    // Fail-closed-ish: if we can't scrub, send anyway. Better to deliver
    // a possibly-leaky message than to swallow agent output entirely.
  }

  if (text.length > 0) await sendMessage(chatId, text);
  for (const name of imgNames) {
    await sendPhoto(chatId, `${IMG_BASE_URL}/help/${name}.jpg`);
  }
}

async function handleNewPreReg(
  userId: number,
  tgUserId: number,
  chatId: number,
  freeUsesRemaining: number,
) {
  if (freeUsesRemaining <= 0) {
    await sendMessage(chatId, copy.preRegExhausted, { parseMode: "Markdown" });
    await logMessage(userId, tgUserId, "out", "<preReg exhausted>");
    return;
  }

  await db
    .update(users)
    .set({
      freeUsesRemaining: sql`${users.freeUsesRemaining} - 1`,
      updatedAt: new Date(),
    })
    .where(and(eq(users.id, userId)));

  const newRemaining = freeUsesRemaining - 1;
  await sendMessage(
    chatId,
    `Send me the code \`FreeAgent2026\` to register and unlock the full agent.\n\n` +
      copy.preRegRemaining(newRemaining),
    { parseMode: "Markdown" },
  );
  await logMessage(userId, tgUserId, "out", "<preReg nudge>");
}

async function logMessage(
  userId: number | null,
  tgUserId: number,
  direction: "in" | "out",
  text: string,
) {
  try {
    await db.insert(messagesTable).values({
      userId,
      telegramUserId: tgUserId,
      direction,
      text,
    });
  } catch (err) {
    console.error("[log] failed to write message row:", err);
  }
}

/**
 * Cheap platform-owned commands that bypass the daily rate limit.
 *
 * /help, /commands, /status — cheap, zero LLM cost, users shouldn't be locked
 *   out of help while rate-limited.
 * /reset — platform-owned; shouldn't be blocked by a limit.
 */
function isRateLimitExempt(text: string): boolean {
  return /^\s*\/(help|commands|status|reset|delete)\b/i.test(text) ||
    /^\s*delete\s*$/i.test(text);
}

/**
 * Platform-owned /delete flow. Two steps — intentional friction so a
 * typo or tap doesn't wipe an account.
 *
 *   Step 1. User sends /delete (any state).
 *           → platform sets pending_delete_at = NOW(), replies with the
 *             confirmation prompt. Next message must be the exact phrase.
 *   Step 2. User's next message is YES-DELETE-MY-ACCOUNT within 5 min.
 *           → platform runs deprovision.sh, deletes ms_messages +
 *             ms_code_redemptions + ms_users rows for this user,
 *             replies with a deletion receipt.
 *   Anything else, or a timeout → pending_delete_at cleared, processing
 *           continues as normal.
 *
 * Returns true if the flow handled the message (caller short-circuits).
 */
async function handleDeleteFlow(
  user: { id: number; pendingDeleteAt: Date | null; workspacePath: string | null },
  tgUserId: number,
  chatId: number,
  text: string,
): Promise<boolean> {
  const DELETE_WINDOW_MS = 5 * 60 * 1000;
  // Confirmation phrase: case-insensitive, the literal word "Delete"
  // alone (whitespace-stripped). Earlier versions used the more onerous
  // YES-DELETE-MY-ACCOUNT; simpler phrase is the friction we want.
  const CONFIRM_PHRASE_RE = /^\s*delete\s*$/i;
  const now = Date.now();

  // Case 1: user is mid-confirmation (pendingDeleteAt set, within window).
  if (user.pendingDeleteAt && now - user.pendingDeleteAt.getTime() < DELETE_WINDOW_MS) {
    // Special-case: if the user types /delete again while a deletion is
    // already pending, re-issue the prompt rather than treating it as a
    // cancel. Common cause: Telegram failed to deliver the first prompt
    // (we observed ECONNRESET in prod 2026-04-29 19:00:31), or the user
    // didn't see/missed it and is trying again.
    if (/^\s*\/delete\b/i.test(text)) {
      try {
        await sendMessage(
          chatId,
          `⚠️ Still waiting on your confirmation. Type *Delete* (just that word) within 5 minutes to remove your account. Anything else cancels.\n\n` +
            `You can rejoin anytime by sending a fresh message + registration code.`,
          { parseMode: "Markdown" },
        );
        // Refresh the pending window so the 5-min timer restarts.
        await db
          .update(users)
          .set({ pendingDeleteAt: new Date(), updatedAt: new Date() })
          .where(eq(users.id, user.id));
        await logMessage(user.id, tgUserId, "out", "<delete pending confirmation re-issued>");
      } catch (err) {
        console.error(`[delete] re-issue prompt failed for tg=${tgUserId}:`, err);
      }
      return true;
    }

    if (CONFIRM_PHRASE_RE.test(text)) {
      // Execute deletion.
      try {
        await runDeprovision(tgUserId);
        await db.transaction(async (tx) => {
          await tx.execute(sql`DELETE FROM ${codeRedemptions} WHERE user_id = ${user.id}`);
          await tx.execute(sql`DELETE FROM ${messagesTable} WHERE telegram_user_id = ${tgUserId}`);
          await tx.execute(sql`DELETE FROM ${users} WHERE id = ${user.id}`);
        });
        // Honest deletion-success message: state plainly what we removed,
        // what's outside our control (Telegram, DO snapshots, third-party
        // LLM provider logs), what their option is on each, and that they
        // can come back anytime.
        await sendMessage(
          chatId,
          `🗑️ Done.\n\n` +
            `**Permanently deleted (gone, no recovery):**\n` +
            `• The agent's full conversation history (every LLM prompt, response, tool call, and tool result)\n` +
            `• Every Telegram message we logged (in + out)\n` +
            `• Your account record\n\n` +
            `**Archived 30 days then auto-purged:**\n` +
            `• Your stored Canvas and Skyward credentials\n` +
            `• Your workspace files and the agent's memory notes\n` +
            `*(retained briefly so an operator can restore your account if you /delete'd by mistake — DM @johntdavenport within 30 days if so)*\n\n` +
            `**Three things outside our direct control — being honest about what's true:**\n\n` +
            `• *Telegram's servers* still have your bot chat. Telegram encrypts messages in transit but bot-storage at-rest encryption isn't yet implemented on their side. To remove your copy, delete the chat in your Telegram app — that also signals Telegram to drop their copy after a delay.\n\n` +
            `• *Server snapshots* — DigitalOcean takes nightly snapshots of our server, encrypted at rest with DO's keys. They auto-purge on a 7-day rotation. After that they're gone.\n\n` +
            `• *AI model providers* — your conversation gets processed by third-party AI servers we route to. The active set of providers can change over time. Each provider keeps prompts and responses on its own short retention window for abuse detection (typically a few days to a few weeks). None of them train models on our commercial-API data. After each provider's retention window, deleted on their side too.\n\n` +
            `If anything feels off, DM @johntdavenport on Telegram.\n\n` +
            `You can come back anytime — just send any message and a fresh registration code.`,
          { parseMode: "Markdown" },
        );
      } catch (err) {
        console.error(`[delete] failed for tg=${tgUserId}:`, err);
        await sendMessage(
          chatId,
          `⚠️ Something went wrong during deletion (code CRED0006). DM @johntdavenport on Telegram and he'll finish it manually.`,
        );
      }
      return true;
    }
    // Different message — treat as implicit cancel.
    await db
      .update(users)
      .set({ pendingDeleteAt: null, updatedAt: new Date() })
      .where(eq(users.id, user.id));
    await sendMessage(chatId, `Deletion cancelled. Your account is unchanged.`);
    await logMessage(user.id, tgUserId, "out", "<delete cancelled>");
    return true;
  }

  // Case 2: user invokes /delete fresh.
  // Critical ordering: send the confirmation prompt FIRST. Only after
  // Telegram acknowledges the send do we set pendingDeleteAt in the DB.
  // If sendMessage throws (transient ECONNRESET to api.telegram.org —
  // observed 2026-04-29), the user is left in their original state with
  // no stale pending — they can /delete again cleanly.
  if (/^\s*\/delete\b/i.test(text)) {
    try {
      await sendMessage(
        chatId,
        `⚠️ Type *Delete* (just that word) within 5 minutes to remove your account from MsgSchool. Anything else cancels.\n\n` +
          `This will remove:\n` +
          `• Stored Canvas and Skyward credentials\n` +
          `• Your workspace, memory, and conversation history with your agent\n` +
          `• Every Telegram message we logged\n` +
          `• Your account\n\n` +
          `You can rejoin anytime by sending a fresh message + registration code.`,
        { parseMode: "Markdown" },
      );
    } catch (err) {
      console.error(`[delete] confirmation-prompt send failed for tg=${tgUserId}:`, err);
      // Don't set pendingDeleteAt — Telegram didn't deliver the prompt,
      // so the user has no idea anything is pending. Return true so the
      // dispatcher doesn't fall through to the agent on /delete.
      return true;
    }
    // Prompt delivered → now safe to record the pending state.
    await db
      .update(users)
      .set({ pendingDeleteAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, user.id));
    await logMessage(user.id, tgUserId, "out", "<delete pending confirmation>");
    return true;
  }

  // Case 3: stale pendingDeleteAt (past 5 min window) — clear and continue.
  if (user.pendingDeleteAt) {
    await db
      .update(users)
      .set({ pendingDeleteAt: null, updatedAt: new Date() })
      .where(eq(users.id, user.id));
  }
  return false;
}

async function runDeprovision(tgUserId: number): Promise<void> {
  const script = process.env.DEPROVISION_SCRIPT || "/var/www/msgschool/scripts/deprovision.sh";
  const { spawn } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => {
    const p = spawn("sudo", [script, "--telegram-id", String(tgUserId)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderr: string[] = [];
    p.stderr.on("data", (c: Buffer) => stderr.push(c.toString()));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`deprovision exit=${code}: ${stderr.join("").slice(0, 400)}`));
    });
  });
}

/**
 * Fetch the last N outbound agent messages for a telegram user, newest
 * first. Used by the credential detector to resolve ambiguous bare-label
 * pastes against the agent's recent asks. Cheap read; indexed on
 * telegram_user_id + direction.
 */
async function fetchRecentAgentText(tgUserId: number, limit: number): Promise<string[]> {
  try {
    // drizzle's db.execute returns a pg QueryResult object, not an array —
    // use .rows to get the rows array.
    const res = await db.execute(sql`
      SELECT text FROM ${messagesTable}
      WHERE telegram_user_id = ${tgUserId}
        AND direction = 'out'
      ORDER BY id DESC LIMIT ${limit}
    `);
    const rows = (res as unknown as { rows: { text: string }[] }).rows ?? [];
    return rows.map((r) => r.text ?? "");
  } catch (err) {
    console.error("[creds] fetchRecentAgentText failed:", err);
    return [];
  }
}

/**
 * Authoritative credential capture path. Called when CREDENTIAL_CAPTURE=on
 * and the detector classified at least one field in the inbound message.
 *
 * Order of operations is important:
 *   1. Write encrypted creds FIRST (atomic; source of truth gets populated).
 *   2. Delete the paste from Telegram (best-effort; we do it AFTER the write
 *      because a write failure should not leave the user's paste lingering
 *      in chat with no corresponding store).
 *   3. Send a terse receipt to the user.
 *   4. Dispatch a [SYSTEM] nudge to the agent so it can continue the flow
 *      (run a probe if readiness reached, or ask for the next missing field).
 */
async function handleCapturedCredentials(
  userId: number,
  tgUserId: number,
  chatId: number,
  telegramMessageId: number,
  detection: DetectionResult,
): Promise<void> {
  const grouped = groupByService(detection.fields);
  const storedFields: string[] = [];

  try {
    if (grouped.canvas) {
      const { fields_stored } = await mergeCreds<CanvasCreds>(tgUserId, "canvas", grouped.canvas);
      storedFields.push(...fields_stored);
    }
    if (grouped.skyward) {
      const { fields_stored } = await mergeCreds<SkywardCreds>(tgUserId, "skyward", grouped.skyward);
      storedFields.push(...fields_stored);
    }
  } catch (err) {
    // Write failed — don't delete the paste (the store is our source of
    // truth; if we couldn't write, the user's paste is the only copy left).
    console.error("[creds] mergeCreds failed tg=" + tgUserId + ":", err);
    await sendMessage(chatId, `⚠️ Message lost — code CRED0001. Please resend.`);
    await logMessage(userId, tgUserId, "out", "<cred-capture-fail: CRED0001>");
    return;
  }

  // Delete the user's paste from chat. Best-effort; log but don't abort.
  // On success we send a short status note ("credentials identified —
  // encrypting…back in a minute") so the user knows something is happening
  // during the gap between paste-vanishing and agent reply (which can take
  // a few seconds). On failure the user has to manually delete; that path
  // sends a different note.
  const del = await deleteMessage(chatId, telegramMessageId);
  if (!del.ok) {
    await sendMessage(
      chatId,
      `⚠️ I couldn't remove your paste from this chat — please delete it manually (CRED0004). ` +
        `Your credential is stored on our side regardless.`,
    );
  } else {
    await sendMessage(
      chatId,
      `🔐 Credentials identified — encrypting now… back in a minute.`,
    );
    void sendChatAction(chatId, "typing");
  }
  await logMessage(userId, tgUserId, "out", `<captured: ${storedFields.join(",")}>`);

  // Compute readiness state and tell the agent what's still needed. The
  // agent's reply is what the user sees as the response to their paste.
  const canvasPresent = await fieldsPresent(tgUserId, "canvas");
  const skywardPresent = await fieldsPresent(tgUserId, "skyward");
  const canvasRequired = ["url", "username", "password", "token"];
  const skywardRequired = ["url", "username", "password"];
  const canvasMissing = canvasRequired.filter((k) => !canvasPresent.includes(k));
  const skywardMissing = skywardRequired.filter((k) => !skywardPresent.includes(k));
  const readyForProbe = canvasMissing.length === 0 && skywardMissing.length === 0;

  // Tools enabled per service: which ms_call tools become useful now that
  // the corresponding creds are in place. Tells the agent what to confirm.
  const canvasReady = canvasPresent.includes("token") && canvasPresent.includes("url");
  const skywardReady =
    skywardPresent.includes("username") &&
    skywardPresent.includes("password") &&
    skywardPresent.includes("url");
  const toolsEnabled: string[] = [];
  if (canvasReady) toolsEnabled.push("canvas.list_courses", "canvas.get_pulse", "canvas.list_missing");
  if (skywardReady) toolsEnabled.push("skyward.get_grades", "skyward.get_attendance", "skyward.get_pulse");
  if (canvasReady && skywardReady) toolsEnabled.push("pulse.combined");

  const systemNote =
    `[SYSTEM]\nevent: credential_stored\n` +
    `fields_just_stored: ${JSON.stringify(storedFields)}\n` +
    `canvas_fields_present: ${JSON.stringify(canvasPresent)}\n` +
    `canvas_fields_missing: ${JSON.stringify(canvasMissing)}\n` +
    `skyward_fields_present: ${JSON.stringify(skywardPresent)}\n` +
    `skyward_fields_missing: ${JSON.stringify(skywardMissing)}\n` +
    `tools_enabled_now: ${JSON.stringify(toolsEnabled)}\n` +
    `ready_for_probe: ${readyForProbe}\n` +
    `next_step: ${
      readyForProbe
        ? "Run ms_call canvas.connectivity_probe and ms_call skyward.connectivity_probe. If both ok, confirm to the user in your own voice that everything is connected and list the tools you can now run for them. Do NOT echo the stored credential values — never. Keep the reply to 2-3 short sentences."
        : (toolsEnabled.length > 0
            ? "Confirm receipt in your own voice in ONE short sentence (e.g. 'Canvas connected — I can now pull grades, missing assignments, and announcements.'). Then ask for the next missing field by name. Do NOT echo the stored values."
            : "Acknowledge receipt in ONE short sentence and ask for the next missing field by name. Do NOT echo the stored values.")
    }\n`;

  // Dispatch as a regular turn — the agent's PERSONA+AGENTS now reference
  // [SYSTEM] envelopes; it'll react and produce a short user-facing reply.
  await dispatchActiveToAgent(userId, tgUserId, chatId, systemNote);
}

/**
 * Unclassified credential-shaped paste handler.
 *
 * The platform deleted the message from chat (per security policy), did not
 * write anything to disk (no service to assign it to), and now hands off
 * to the agent with a [SYSTEM] turn. The agent voices the follow-up — asks
 * the user, in its own conversational tone, which service that was for.
 *
 * The agent never receives the credential value itself (we don't pass it
 * through). It only knows that something credential-shaped came in and was
 * removed. Re-paste with a clear label is the recovery path.
 */
async function handleUnclassifiedCredentialPaste(
  userId: number,
  tgUserId: number,
  chatId: number,
  telegramMessageId: number,
): Promise<void> {
  const del = await deleteMessage(chatId, telegramMessageId);
  if (!del.ok) {
    // Chat-delete failed — user has to clean it up themselves. This is an
    // action item, hence a sterile platform note. Skip the agent dispatch
    // because the agent has nothing useful to add when the value is still
    // sitting in the user's chat history.
    await sendMessage(
      chatId,
      `⚠️ I detected something credential-shaped but couldn't determine which service it was for, ` +
        `and I couldn't remove it from this chat (CRED0004). Please delete that message manually, ` +
        `then re-send it with a label like *Canvas token: <value>* or *Skyward password: <value>*.`,
      { parseMode: "Markdown" },
    );
    await logMessage(userId, tgUserId, "out", "<unclassified-cred: chat-delete failed>");
    return;
  }

  await logMessage(userId, tgUserId, "out", "<unclassified-cred: handed to agent>");

  const systemNote =
    `[SYSTEM]\nevent: unclassified_credential_paste\n` +
    `note: User just pasted something the platform classifier flagged as credential-shaped, ` +
    `but the platform could NOT determine which service it was for. The value has been removed ` +
    `from chat. The platform did NOT write it to disk — it is gone. The agent never received ` +
    `the value (do not look for it; it's not in your input).\n` +
    `next_step: In ONE or TWO short sentences in your own voice, tell the user something ` +
    `credential-looking came through but you couldn't tell which service it was for, and ask ` +
    `which it was — Canvas token, Canvas password, Skyward password, or something else. ` +
    `Suggest re-pasting with a clear label like 'Canvas token: <value>' or 'Skyward password: ` +
    `<value>'. Be friendly, not bureaucratic. Do NOT apologize at length. Do NOT lecture about ` +
    `security. Do NOT reveal that there's a regex classifier; just say you couldn't tell which ` +
    `service.\n`;

  await dispatchActiveToAgent(userId, tgUserId, chatId, systemNote);
}

/**
 * Count inbound messages from this Telegram user in the last rolling 24 hours
 * and the last rolling 30 days. If either count is at or over its limit,
 * send a single friendly block-message and a log row; caller uses the
 * boolean to skip dispatch.
 *
 * We count inbound only — our own rate-limit reply doesn't count against
 * the user. The message that triggered the check was just logged above the
 * caller, so the count INCLUDES the current message.
 */
async function checkAndEnforceRateLimit(
  userId: number,
  tgUserId: number,
  chatId: number,
): Promise<boolean> {
  try {
    const res = await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')::int AS day_count,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::int AS month_count
      FROM ${messagesTable}
      WHERE telegram_user_id = ${tgUserId}
        AND direction = 'in'
    `);
    // drizzle+pg: .rows is where the actual array lives
    const rows = (res as unknown as { rows: { day_count: number; month_count: number }[] }).rows ?? [];
    const r = rows[0];
    const dayCount = Number(r?.day_count ?? 0);
    const monthCount = Number(r?.month_count ?? 0);
    if (dayCount <= DAILY_MSG_LIMIT && monthCount <= MONTHLY_MSG_LIMIT) return false;

    // At or over limit. We already logged the inbound; don't log the same
    // block-reply more than once per hour to avoid spamming the user if they
    // keep pinging.
    const blocksRes = await db.execute(sql`
      SELECT COUNT(*)::int AS n
      FROM ${messagesTable}
      WHERE telegram_user_id = ${tgUserId}
        AND direction = 'out'
        AND text = '<rate-limited>'
        AND created_at >= NOW() - INTERVAL '1 hour'
    `);
    const blockRows = (blocksRes as unknown as { rows: { n: number }[] }).rows ?? [];
    const blocksThisHour = Number(blockRows[0]?.n ?? 0);
    if (blocksThisHour === 0) {
      await sendMessage(
        chatId,
        `You are part of free MSGSchool, to setup higher limits or discuss ` +
          `other ways AI can help students, message @Johntdavenport`,
      );
    }
    await logMessage(userId, tgUserId, "out", "<rate-limited>");
    return true;
  } catch (err) {
    // DB hiccup — fail open (let the message through). A rate-limit fail-
    // closed would silence the user for an unknown reason, worse UX than
    // briefly letting them exceed 15.
    console.error("[rate-limit] DB query failed, failing open:", err);
    return false;
  }
}

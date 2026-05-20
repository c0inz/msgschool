/**
 * Provisioning + agent-dispatch shell-outs.
 *
 * Architecture: msgschool owns Telegram I/O exclusively.
 *   - Inbound: Telegram webhook → /api/bot/webhook → handler.ts
 *   - Outbound: msgschool calls Bot API sendMessage directly
 *
 * The gateway's Telegram channel is disabled (channels.telegram.enabled=false
 * in openclaw.json). `openclaw agent` is called with --json, we parse the
 * agent's reply text out of `finalAssistantVisibleText`, and we send it via
 * msgschool's own Telegram helper. No --deliver, no --channel.
 */

import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const execP = promisify(exec);
const execFileP = promisify(execFile);

const SCRIPTS_DIR = path.join(process.cwd(), "scripts");
const PROVISION_SCRIPT = process.env.PROVISION_SCRIPT || path.join(SCRIPTS_DIR, "provision.sh");
const DEPROVISION_SCRIPT = process.env.DEPROVISION_SCRIPT || path.join(SCRIPTS_DIR, "deprovision.sh");
const OPENCLAW_BIN = process.env.OPENCLAW_BIN || "openclaw";

// Agent turns can take a while. Observed ceilings across models:
//   - Normal turn: 5-15s
//   - /pulse: 60-120s (multiple Canvas REST calls + Skyward scrape)
//   - /pulse during primary 'overloaded' → fallback: 3-5 minutes
//     (~25s of primary retries, then fallback, then 60-90s on fallback model)
// 2026-04-21 incident: /pulse stranded because 150s CLI timeout fired mid-
// failover; gateway produced the report 60s later but no one was listening.
// 300s ceiling covers the observed worst case with headroom; handler is
// already fire-and-forget from Telegram's pov.
const AGENT_TIMEOUT_MS = 330_000;          // 5.5 min — outer guardrail
const AGENT_CLI_TIMEOUT_SECONDS = 300;     // 5 min — passed through to openclaw

export interface ProvisionResult {
  ok: boolean;
  agentId?: string;
  error?: string;
}

export interface AgentReply {
  ok: boolean;
  text?: string;
  error?: string;
  raw?: unknown;
}

export async function provisionAgent(
  telegramUserId: number,
  displayName?: string | null,
): Promise<ProvisionResult> {
  const agentId = `canvasagent-${telegramUserId}`;
  const args = ["--telegram-id", String(telegramUserId)];
  if (displayName) {
    args.push("--name", displayName);
  }

  try {
    const { stdout } = await execFileP(PROVISION_SCRIPT, args, { timeout: 45_000 });
    console.log("[provision]", stdout.trim());
    return { ok: true, agentId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[provision] failed:", telegramUserId, msg);
    return { ok: false, error: msg };
  }
}

export async function deprovisionAgent(telegramUserId: number): Promise<ProvisionResult> {
  try {
    const { stdout } = await execFileP(
      DEPROVISION_SCRIPT,
      ["--telegram-id", String(telegramUserId)],
      { timeout: 30_000 },
    );
    console.log("[deprovision]", stdout.trim());
    return { ok: true, agentId: `canvasagent-${telegramUserId}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[deprovision] failed:", telegramUserId, msg);
    return { ok: false, error: msg };
  }
}

/**
 * Per-user session nonce — stored as a plain file inside the workspace.
 * Included in --session-id so that /reset can rotate it and the gateway
 * starts a clean session (no multi-turn history bleed-through).
 *
 * File: /opt/msgschool/users/canvasagent-<tg_id>/workspace/state/session-nonce
 */
async function workspaceRoot(telegramUserId: number): Promise<string> {
  return `/opt/msgschool/users/canvasagent-${telegramUserId}/workspace`;
}

async function getSessionNonce(telegramUserId: number): Promise<string> {
  const stateDir = path.join(await workspaceRoot(telegramUserId), "state");
  const noncePath = path.join(stateDir, "session-nonce");
  try {
    const existing = (await fs.readFile(noncePath, "utf8")).trim();
    if (existing) return existing;
  } catch {
    // file missing; create it below
  }
  await fs.mkdir(stateDir, { recursive: true, mode: 0o755 });
  const fresh = crypto.randomBytes(6).toString("hex");
  await fs.writeFile(noncePath, fresh, { mode: 0o644 });
  return fresh;
}

/**
 * Force-rotate the session nonce. Called from /reset. Next agent turn picks
 * up the new nonce automatically via getSessionNonce → sessionId.
 */
export async function rotateSessionNonce(telegramUserId: number): Promise<string> {
  const stateDir = path.join(await workspaceRoot(telegramUserId), "state");
  const noncePath = path.join(stateDir, "session-nonce");
  await fs.mkdir(stateDir, { recursive: true, mode: 0o755 });
  const fresh = crypto.randomBytes(6).toString("hex");
  await fs.writeFile(noncePath, fresh, { mode: 0o644 });
  return fresh;
}

/**
 * Truncate MEMORY.md and wipe memory/*.md — the workspace-level memory files.
 * Does NOT touch USER.md (per-user facts worth keeping) or credentials/ or
 * any platform file. Called from /reset.
 */
export async function resetWorkspaceMemory(telegramUserId: number): Promise<void> {
  const ws = await workspaceRoot(telegramUserId);
  // Truncate MEMORY.md
  try {
    await fs.writeFile(path.join(ws, "MEMORY.md"), "", { mode: 0o644 });
  } catch (err) {
    console.error("[reset] failed to truncate MEMORY.md:", err);
  }
  // Remove memory/*.md
  const memoryDir = path.join(ws, "memory");
  try {
    const entries = await fs.readdir(memoryDir).catch(() => []);
    for (const f of entries) {
      if (f.endsWith(".md")) {
        await fs.unlink(path.join(memoryDir, f)).catch(() => {});
      }
    }
  } catch (err) {
    console.error("[reset] failed to clear memory/:", err);
  }
}

/**
 * Extract every top-level balanced-brace JSON object from a text blob.
 * Handles interleaved banner text, multiple objects in a single stream,
 * string-literal braces/quotes correctly. Skips any object that fails to
 * parse; returns the list of successfully-parsed objects in stream order.
 */
function findAllJsonObjects(text: string): unknown[] {
  const out: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) { escape = false; continue; }
      if (ch === "\\") { escape = true; continue; }
      if (ch === '"') { inString = false; }
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth === 0) continue; // stray closing brace from banner text
      depth--;
      if (depth === 0 && start >= 0) {
        const candidate = text.slice(start, i + 1);
        try {
          out.push(JSON.parse(candidate));
        } catch {
          // ignore unparseable objects — banners with escaped-ish braces etc.
        }
        start = -1;
      }
    }
  }
  return out;
}

/**
 * Run one agent turn and return its reply text. Does NOT send to Telegram —
 * caller is expected to do that via msgschool's sendMessage helper.
 *
 * agentId is optional — bindings in openclaw.json already route by --to,
 * so in steady state we can omit it. Specifying it is useful for the first
 * turn right after provisioning (extra safety against the gateway default).
 */
export async function runAgentTurn(
  telegramUserId: number,
  message: string,
  agentId?: string,
): Promise<AgentReply> {
  const nonce = await getSessionNonce(telegramUserId);
  const sessionId = `msgschool-${telegramUserId}-${nonce}`;

  const args = [
    "agent",
    "--to", String(telegramUserId),
    "--session-id", sessionId,
    "--message", message,
    "--timeout", String(AGENT_CLI_TIMEOUT_SECONDS),
    "--json",
  ];
  if (agentId) {
    args.push("--agent", agentId);
  }

  let stdout = "";
  let stderr = "";
  try {
    const r = await execFileP(OPENCLAW_BIN, args, {
      timeout: AGENT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    stdout = r.stdout || "";
    stderr = r.stderr || "";
  } catch (err) {
    // execFile may throw (non-zero exit) while still producing stdout/stderr
    // on the error object. Keep going so we can rescue the JSON if it's in
    // either stream (gateway-fallback-to-embedded writes it to stderr).
    const e = err as { stdout?: string; stderr?: string; message?: string };
    stdout = e.stdout || "";
    stderr = e.stderr || "";
    if (!stdout && !stderr) {
      return { ok: false, error: e.message ?? String(err) };
    }
  }

  // `openclaw agent --json` emits multiple top-level JSON objects + plain-text
  // banners on both stdout and stderr, especially when the gateway WebSocket
  // closes abnormally and the CLI falls back to embedded mode. We scan both
  // streams for every top-level balanced-brace JSON object, parse each, and
  // pick the one that matches our expected reply shape (has result.payloads).
  const combined = (stdout || "") + "\n" + (stderr || "");
  const objects = findAllJsonObjects(combined);

  if (objects.length === 0) {
    console.error(
      "[agent-turn] no parseable JSON for tg=%d; stdout=%d stderr=%d stderr head:",
      telegramUserId,
      stdout.length,
      stderr.length,
      stderr.slice(0, 400),
    );
    return { ok: false, error: "no JSON in stdout or stderr" };
  }

  // Prefer the object with {result: {payloads: [...]}} (normal gateway shape),
  // then {payloads: [...]} at top level (embedded-fallback shape), then fall
  // back to the last object in the stream. Both reply shapes produce usable
  // text via extractReplyText.
  const hasArrayPayloads = (x: unknown): boolean =>
    Array.isArray(x) && x.length > 0;
  const parsed: unknown =
    objects.find(
      (o) => o && typeof o === "object" &&
        hasArrayPayloads(
          ((o as { result?: { payloads?: unknown } }).result ?? {}).payloads,
        ),
    )
    ?? objects.find(
      (o) => o && typeof o === "object" &&
        hasArrayPayloads((o as { payloads?: unknown }).payloads),
    )
    ?? objects[objects.length - 1];

  if (stderr.toLowerCase().includes("falling back to embedded")) {
    console.warn("[agent-turn] used gateway-embedded fallback for tg=%d (gateway ws was flaky)", telegramUserId);
  }
  const text = extractReplyText(parsed);
  if (!text) {
    console.error(
      "[agent-turn] no reply text for tg=%d; JSON keys at top:",
      telegramUserId,
      Object.keys(parsed as Record<string, unknown>),
      "result keys:",
      (parsed as { result?: Record<string, unknown> })?.result
        ? Object.keys((parsed as { result: Record<string, unknown> }).result)
        : "(no .result)",
    );
    return { ok: false, error: "agent returned no text", raw: parsed };
  }
  return { ok: true, text, raw: parsed };
}

/**
 * Pull the agent's visible reply text out of the --json result.
 *
 * Actual shape (openclaw 2026.4.15):
 *   {
 *     runId, status, summary,
 *     result: {
 *       payloads: [ { text: "...", mediaUrl: null }, ... ],
 *       meta: { finalAssistantVisibleText, finalAssistantRawText, ... }
 *     }
 *   }
 *
 * Prefer payloads (what the gateway would have delivered); fall back to
 * meta.finalAssistantVisibleText/RawText; then a few generic keys.
 */
function extractReplyText(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== "object") return undefined;
  const top = parsed as Record<string, unknown>;
  const result = top.result as Record<string, unknown> | undefined;

  // PRIORITY 1: meta.finalAssistantVisibleText — the gateway's own notion of
  // "the final user-facing reply". This is specifically what the gateway would
  // have sent to the main channel if its telegram integration were active.
  // Using this field instead of the raw payloads array suppresses intermediate
  // narration ("On it...", "Let me reopen...", "hang tight") that the agent
  // emits during long agentic-tool loops. See 2026-04-21 incident where a
  // /pulse concatenated 5 narration chunks + the actual report into one
  // 3KB Telegram message.
  const metaCandidates = [
    result?.meta as Record<string, unknown> | undefined,
    top.meta as Record<string, unknown> | undefined,
  ];
  for (const meta of metaCandidates) {
    if (!meta) continue;
    for (const key of ["finalAssistantVisibleText", "finalAssistantRawText"]) {
      const v = meta[key];
      if (typeof v === "string" && v.trim().length > 0) return v;
    }
  }

  // PRIORITY 2: the LAST payload only (not all joined). If the agent emitted
  // intermediate assistant messages, each becomes its own payload; the last
  // one is the final reply. Joining them all would re-introduce the narration
  // we just suppressed.
  const payloadsCandidates: unknown[] = [result?.payloads, top.payloads];
  for (const payloads of payloadsCandidates) {
    if (Array.isArray(payloads) && payloads.length > 0) {
      const texts = payloads
        .map((p) => (p && typeof p === "object" ? (p as { text?: unknown }).text : undefined))
        .filter((t): t is string => typeof t === "string" && t.trim().length > 0);
      if (texts.length > 0) return texts[texts.length - 1];
    }
  }

  // Generic fallbacks at various nesting depths.
  for (const host of [top, result, ...metaCandidates]) {
    if (!host) continue;
    for (const key of ["text", "reply", "replyText", "message"]) {
      const v = (host as Record<string, unknown>)[key];
      if (typeof v === "string" && v.trim().length > 0) return v;
    }
  }

  return undefined;
}

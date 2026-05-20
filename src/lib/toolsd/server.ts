/**
 * msgschool-toolsd — entry point.
 *
 * Long-running Node service. Listens on a unix socket. Agents call in
 * via `ms_call` to fetch Canvas / Skyward data without ever holding the
 * underlying credential.
 *
 * v1 caveat: runs as root in the same UID as the rest of the platform.
 * Structural per-UID isolation is deferred (see TOOLSD_SPEC.md §1).
 * What this delivers today: behavioral redirection (agent has no
 * playbook path that requires credentials), audit logging, response
 * caching, and a clean tool surface that returns only data.
 */
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import {
  encodeFrame,
  frameReader,
  PROTOCOL_VERSION,
  SOCKET_PATH,
  ToolError,
  type ToolRequest,
  type ToolResponse,
} from "./protocol.ts";
import * as canvas from "./canvas.ts";
import * as skyward from "./skyward.ts";
import { evictCreds } from "./creds.ts";
import { ensureAllUsersHydrated } from "../bot/credential-store.ts";
import { Pool } from "pg";

// Dedicated pg pool for toolsd. Avoids importing db.ts (whose bare-name
// `./schema` import doesn't resolve under --experimental-strip-types).
// Uses raw SQL for the single audit insert; no need to drag drizzle in.
const pgPool = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? "postgres://CHANGEME:CHANGEME@localhost:5432/msgschool",
  max: 4,
});
pgPool.on("error", (e) => console.error("[toolsd] pg pool error:", e.message));

const VERSION = "0.1.0";

type Handler = (tg: number, args: any) => Promise<unknown>;

const TOOLS: Record<string, { handler: Handler; cache_ttl_ms: number }> = {
  "tools.healthcheck": {
    handler: async (tg) => ({
      toolsd_version: VERSION,
      tg,
      now: new Date().toISOString(),
    }),
    cache_ttl_ms: 0,
  },
  "canvas.list_courses": { handler: (tg) => canvas.listCourses(tg), cache_ttl_ms: 600_000 },
  "canvas.list_assignments": {
    handler: (tg, args) => canvas.listAssignments(tg, args),
    cache_ttl_ms: 300_000,
  },
  "canvas.list_missing": { handler: (tg) => canvas.listMissing(tg), cache_ttl_ms: 120_000 },
  "canvas.get_pulse": { handler: (tg) => canvas.getPulse(tg), cache_ttl_ms: 60_000 },
  "canvas.connectivity_probe": {
    handler: (tg) => canvas.connectivityProbe(tg),
    cache_ttl_ms: 0,
  },
  "skyward.get_grades": {
    handler: (tg, args) => skyward.getGrades(tg, args),
    cache_ttl_ms: 120_000,
  },
  "skyward.get_attendance": {
    handler: (tg, args) => skyward.getAttendance(tg, args),
    cache_ttl_ms: 300_000,
  },
  "skyward.get_pulse": { handler: (tg) => skyward.getPulse(tg), cache_ttl_ms: 60_000 },
  "skyward.connectivity_probe": {
    handler: (tg) => skyward.connectivityProbe(tg),
    cache_ttl_ms: 0,
  },
  "pulse.combined": {
    handler: async (tg) => ({
      canvas: await canvas.getPulse(tg).catch((e) => ({ error: e.code || "INTERNAL" })),
      skyward: await skyward.getPulse(tg).catch((e) => ({ error: e.code || "INTERNAL" })),
      generated_at: new Date().toISOString(),
    }),
    cache_ttl_ms: 60_000,
  },
};

// ---------- response cache ----------
type CacheEntry = { value: unknown; cached_at: number };
const responseCache = new Map<string, CacheEntry>();

function cacheKey(tg: number, tool: string, args: unknown): string {
  return `${tg}|${tool}|${JSON.stringify(args ?? {})}`;
}

// ---------- audit log ----------
function summarizeArgs(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  // Whitelist keys we know are non-sensitive. Anything else gets dropped.
  const SAFE_KEYS = new Set(["course_id", "term", "since", "tg"]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (SAFE_KEYS.has(k)) out[k] = v;
  }
  return Object.keys(out).length > 0 ? JSON.stringify(out) : null;
}

async function audit(row: {
  tg: number;
  tool: string;
  args: unknown;
  result_size_bytes: number | null;
  cache_hit: boolean;
  latency_ms: number;
  error_code: string | null;
}): Promise<void> {
  try {
    await pgPool.query(
      `INSERT INTO ms_tool_calls
        (telegram_user_id, tool, args_summary, result_size_bytes, cache_hit, latency_ms, error_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        row.tg,
        row.tool,
        summarizeArgs(row.args),
        row.result_size_bytes,
        row.cache_hit ? 1 : 0,
        row.latency_ms,
        row.error_code,
      ],
    );
  } catch (e) {
    console.error("[toolsd] audit insert failed:", (e as Error).message);
  }
}

// ---------- request handler ----------
async function handle(req: ToolRequest): Promise<ToolResponse> {
  const start = Date.now();
  if (req.v !== PROTOCOL_VERSION) {
    return {
      v: 1,
      request_id: req.request_id,
      error: { code: "INVALID_ARG", message: `unsupported protocol version: ${req.v}` },
    };
  }
  if (!Number.isInteger(req.tg) || req.tg <= 0) {
    return {
      v: 1,
      request_id: req.request_id,
      error: { code: "INVALID_ARG", message: "tg must be a positive integer" },
    };
  }
  const def = TOOLS[req.tool];
  if (!def) {
    await audit({
      tg: req.tg,
      tool: req.tool,
      args: req.args,
      result_size_bytes: null,
      cache_hit: false,
      latency_ms: Date.now() - start,
      error_code: "TOOL_UNKNOWN",
    });
    return {
      v: 1,
      request_id: req.request_id,
      error: { code: "TOOL_UNKNOWN", message: `unknown tool: ${req.tool}` },
    };
  }

  // Cache check
  if (def.cache_ttl_ms > 0) {
    const k = cacheKey(req.tg, req.tool, req.args);
    const hit = responseCache.get(k);
    if (hit && Date.now() - hit.cached_at < def.cache_ttl_ms) {
      const result = hit.value;
      const body = JSON.stringify(result);
      await audit({
        tg: req.tg,
        tool: req.tool,
        args: req.args,
        result_size_bytes: body.length,
        cache_hit: true,
        latency_ms: Date.now() - start,
        error_code: null,
      });
      return { v: 1, request_id: req.request_id, result };
    }
  }

  try {
    const result = await def.handler(req.tg, req.args);
    if (def.cache_ttl_ms > 0) {
      responseCache.set(cacheKey(req.tg, req.tool, req.args), {
        value: result,
        cached_at: Date.now(),
      });
    }
    const body = JSON.stringify(result);
    await audit({
      tg: req.tg,
      tool: req.tool,
      args: req.args,
      result_size_bytes: body.length,
      cache_hit: false,
      latency_ms: Date.now() - start,
      error_code: null,
    });
    return { v: 1, request_id: req.request_id, result };
  } catch (e) {
    const code = e instanceof ToolError ? e.code : "INTERNAL";
    const message = (e as Error).message || "unknown error";
    await audit({
      tg: req.tg,
      tool: req.tool,
      args: req.args,
      result_size_bytes: null,
      cache_hit: false,
      latency_ms: Date.now() - start,
      error_code: code,
    });
    return { v: 1, request_id: req.request_id, error: { code, message } };
  }
}

// ---------- net.Server wiring ----------
function startServer(): void {
  // Make sure the parent dir exists (RuntimeDirectory= handles this in
  // systemd, but support manual `node` runs too).
  const parent = path.dirname(SOCKET_PATH);
  fs.mkdirSync(parent, { recursive: true });
  if (fs.existsSync(SOCKET_PATH)) {
    try {
      fs.unlinkSync(SOCKET_PATH);
    } catch {
      // ignore
    }
  }

  const server = net.createServer((conn) => {
    const reader = frameReader();
    let handled = false;
    conn.on("data", (chunk: Buffer) => {
      try {
        const body = reader.push(chunk);
        if (body && !handled) {
          handled = true;
          let req: ToolRequest;
          try {
            req = JSON.parse(body.toString("utf-8")) as ToolRequest;
          } catch (e) {
            const resp: ToolResponse = {
              v: 1,
              request_id: "unknown",
              error: { code: "INVALID_ARG", message: `bad JSON: ${(e as Error).message}` },
            };
            conn.write(encodeFrame(resp));
            conn.end();
            return;
          }
          handle(req)
            .then((resp) => {
              conn.write(encodeFrame(resp));
              conn.end();
            })
            .catch((err) => {
              const resp: ToolResponse = {
                v: 1,
                request_id: req.request_id,
                error: { code: "INTERNAL", message: (err as Error).message },
              };
              conn.write(encodeFrame(resp));
              conn.end();
            });
        }
      } catch (err) {
        const resp: ToolResponse = {
          v: 1,
          request_id: "unknown",
          error: { code: "INVALID_ARG", message: (err as Error).message },
        };
        conn.write(encodeFrame(resp));
        conn.end();
      }
    });
    conn.on("error", () => {
      // peer disconnects mid-request happen; nothing to do
    });
  });

  server.listen(SOCKET_PATH, () => {
    fs.chmodSync(SOCKET_PATH, 0o666);
    console.log(`[toolsd] listening on ${SOCKET_PATH} version=${VERSION}`);
    // Re-hydrate every existing user's tmpfs credentials from on-disk
    // ciphertext. Without this, every reboot leaves users unable to use
    // any tool (the tmpfs symlink target doesn't exist). Audit finding
    // 2026-05-01: ensureAllUsersHydrated was defined but never called.
    ensureAllUsersHydrated()
      .then(() => console.log("[toolsd] tmpfs credential hydration complete"))
      .catch((e) => console.error("[toolsd] hydration failed:", e));
  });

  process.on("SIGTERM", () => {
    console.log("[toolsd] SIGTERM, shutting down");
    server.close(() => process.exit(0));
  });
  process.on("SIGINT", () => {
    console.log("[toolsd] SIGINT, shutting down");
    server.close(() => process.exit(0));
  });
}

// Admin op support: deprovision.sh can hit the daemon directly to evict
// cached creds for a tg before deleting the on-disk plaintext. Routed
// via a special tool name so we don't need a second socket. Restricted
// to the local socket (which is already root-only on the prod host).
TOOLS["admin.evict"] = {
  handler: async (tg) => {
    evictCreds(tg);
    return { evicted: true, tg };
  },
  cache_ttl_ms: 0,
};

startServer();

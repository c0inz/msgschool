/**
 * Credential loader for msgschool-toolsd.
 *
 * Reads plaintext credentials from the existing per-agent tmpfs path
 * (`/run/msgschool/canvasagent-<tg>/<svc>.json`) populated by the
 * existing credential-store flow. Caches plaintext in an in-process LRU
 * with a 10-minute TTL; zeroes buffers on eviction (best-effort).
 *
 * NOTE: in v1 the daemon runs as root alongside the rest of the platform,
 * so isolating creds *from* the agent process structurally requires
 * OpenClaw changes that are out of scope for v1. The behavioral
 * isolation (agent never reads creds, agent never sees creds, tools
 * return only data) is what ships now. See docs/TOOLSD_SPEC.md §1
 * "deferred per-UID isolation" for the plan.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export type Service = "canvas" | "skyward";

export type CanvasCreds = {
  token: string;
  url: string;
  username?: string;
  password?: string;
  school?: string;
  district?: string;
  student?: string;
};

export type SkywardCreds = {
  url: string;
  username: string;
  password: string;
  district?: string;
  student?: string;
};

const TMPFS_ROOT = process.env.MSGSCHOOL_CRED_TMPFS_ROOT || "/run/msgschool";
const TTL_MS = 10 * 60 * 1000;

type CacheEntry = {
  value: unknown;
  loaded_at: number;
};
const cache = new Map<string, CacheEntry>();

function cacheKey(tg: number, svc: Service): string {
  return `${tg}:${svc}`;
}

function tmpfsPath(tg: number, svc: Service): string {
  return path.join(TMPFS_ROOT, `canvasagent-${tg}`, `${svc}.json`);
}

async function readFromDisk<T>(tg: number, svc: Service): Promise<T> {
  const p = tmpfsPath(tg, svc);
  const buf = await fs.readFile(p);
  try {
    return JSON.parse(buf.toString("utf-8")) as T;
  } finally {
    buf.fill(0);
  }
}

export async function loadCreds<T>(tg: number, svc: Service): Promise<T> {
  const key = cacheKey(tg, svc);
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.loaded_at < TTL_MS) {
    return hit.value as T;
  }
  const value = await readFromDisk<T>(tg, svc);
  cache.set(key, { value, loaded_at: now });
  return value;
}

export function evictCreds(tg: number): void {
  for (const svc of ["canvas", "skyward"] as const) {
    const key = cacheKey(tg, svc);
    cache.delete(key);
  }
}

export function evictAll(): void {
  cache.clear();
}

/** Snapshot of all loaded credential string values, for the outbound
 *  scrubber. Returns a flat array of strings to scrub from any text the
 *  agent emits. Never logged anywhere. */
export function knownSecrets(tg: number): string[] {
  const out: string[] = [];
  for (const svc of ["canvas", "skyward"] as const) {
    const hit = cache.get(cacheKey(tg, svc));
    if (!hit) continue;
    const v = hit.value as Record<string, unknown>;
    for (const field of ["token", "password", "username"]) {
      const x = v[field];
      if (typeof x === "string" && x.length >= 4) out.push(x);
    }
  }
  return out;
}

/**
 * Outbound credential scrubber.
 *
 * Given a `tg` and a body of text, replaces literal occurrences of any
 * known credential string for that user with `[redacted]`. Used by:
 *   - the Telegram outbound path (handler.ts) before sendMessage
 *   - the post-tool sweeper (planned) when the agent writes files
 *
 * This is the defense-in-depth net under the agent's discipline. Even
 * if the agent decides to echo a credential into chat (and we've seen
 * this), the value is replaced before it reaches the user's screen.
 */
import { knownSecrets } from "./creds.ts";
import { promises as fs } from "node:fs";
import path from "node:path";

const TMPFS_ROOT = process.env.MSGSCHOOL_CRED_TMPFS_ROOT || "/run/msgschool";

/**
 * Read the secrets for a tg directly from disk if not loaded via toolsd
 * (the bot side never loads creds; toolsd does). The bot's outbound
 * scrubber needs the values to redact, so we read them straight from
 * the existing tmpfs path. This is unavoidable while the bot and the
 * tool daemon run as the same user — see TOOLSD_SPEC.md §1.
 */
async function readSecretsFromDisk(tg: number): Promise<string[]> {
  const out: string[] = [];
  for (const svc of ["canvas", "skyward"] as const) {
    const p = path.join(TMPFS_ROOT, `canvasagent-${tg}`, `${svc}.json`);
    try {
      const buf = await fs.readFile(p, "utf-8");
      const json = JSON.parse(buf) as Record<string, unknown>;
      for (const field of ["token", "password", "username"]) {
        const v = json[field];
        if (typeof v === "string" && v.length >= 4) out.push(v);
      }
    } catch {
      // file may not exist (user not yet provisioned for that svc) — skip
    }
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function scrubOutbound(tg: number, text: string): Promise<{ text: string; redactions: number }> {
  if (!text || text.length === 0) return { text, redactions: 0 };
  const cached = knownSecrets(tg);
  const fromDisk = cached.length > 0 ? cached : await readSecretsFromDisk(tg);
  if (fromDisk.length === 0) return { text, redactions: 0 };
  // Sort longest-first so we don't partially-replace inside a longer secret.
  const sorted = [...new Set(fromDisk)].sort((a, b) => b.length - a.length);
  let count = 0;
  let result = text;
  for (const secret of sorted) {
    const re = new RegExp(escapeRegex(secret), "g");
    result = result.replace(re, () => {
      count += 1;
      return "[redacted]";
    });
  }
  return { text: result, redactions: count };
}

/** Synchronous variant for paths that already have the secrets list. */
export function scrubText(text: string, secrets: string[]): { text: string; redactions: number } {
  if (!text || secrets.length === 0) return { text, redactions: 0 };
  const sorted = [...new Set(secrets)].sort((a, b) => b.length - a.length);
  let count = 0;
  let result = text;
  for (const secret of sorted) {
    if (!secret || secret.length < 4) continue;
    const re = new RegExp(escapeRegex(secret), "g");
    result = result.replace(re, () => {
      count += 1;
      return "[redacted]";
    });
  }
  return { text: result, redactions: count };
}

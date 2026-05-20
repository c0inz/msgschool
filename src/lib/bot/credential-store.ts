/**
 * Platform-owned credential storage for msgschool.
 *
 * Two layers:
 *   (1) At rest on disk: ciphertext in <workspace>/credentials/<svc>.json.enc,
 *       encrypted with `systemd-creds encrypt` (machine-bound key).
 *   (2) In running memory: plaintext in /run/msgschool/<agent-id>/<svc>.json
 *       (tmpfs), exposed to the agent via a symlink from
 *       <workspace>/credentials/<svc>.json → /run/msgschool/.../<svc>.json.
 *
 * Disk never holds plaintext credentials. A disk image stolen while the VM
 * is off has only ciphertext. While the VM is running, anyone with read
 * access to /run can still read plaintext — this matches our honest threat
 * model: we defend against offline disk/backup reads, not running-process
 * compromise.
 *
 * On service start, `ensureAllUsersHydrated()` walks the users directory
 * and re-hydrates tmpfs plaintext for every agent. /run is tmpfs so this
 * runs on every reboot.
 */

import { promises as fs, constants as fsConstants } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const USERS_DIR = process.env.USER_WORKSPACE_ROOT || "/opt/msgschool/users";
const TMPFS_ROOT = "/run/msgschool";
const CRED_NAME_PREFIX = "msgschool"; // systemd-creds --name= for key binding

export type Service = "canvas" | "skyward";

export interface CanvasCreds {
  url?: string;
  login_url?: string;
  username?: string;
  password?: string;
  token?: string;
  school?: string;
  district?: string;
  student?: string;
  stored_at?: Record<string, string>;
  verified?: string;
}

export interface SkywardCreds {
  url?: string;
  username?: string;
  password?: string;
  stored_at?: Record<string, string>;
  verified?: string;
}

export type Creds = CanvasCreds | SkywardCreds;

function agentIdFromTg(tgUserId: number): string {
  return `canvasagent-${tgUserId}`;
}

function workspaceFor(tgUserId: number): string {
  return path.join(USERS_DIR, agentIdFromTg(tgUserId), "workspace");
}

function credDir(tgUserId: number): string {
  return path.join(workspaceFor(tgUserId), "credentials");
}

function encPath(tgUserId: number, svc: Service): string {
  return path.join(credDir(tgUserId), `${svc}.json.enc`);
}

function symlinkPath(tgUserId: number, svc: Service): string {
  return path.join(credDir(tgUserId), `${svc}.json`);
}

function tmpfsDir(tgUserId: number): string {
  return path.join(TMPFS_ROOT, agentIdFromTg(tgUserId));
}

function tmpfsPath(tgUserId: number, svc: Service): string {
  return path.join(tmpfsDir(tgUserId), `${svc}.json`);
}

function credName(tgUserId: number, svc: Service): string {
  return `${CRED_NAME_PREFIX}-${svc}-${tgUserId}`;
}

/** Run a subprocess with stdin piped in, capture stdout + stderr. */
function runWithStdin(cmd: string, args: string[], stdin: Buffer): Promise<{ stdout: Buffer; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: string[] = [];
    p.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
    p.stderr.on("data", (c: Buffer) => stderrChunks.push(c.toString("utf8")));
    p.on("error", reject);
    p.on("close", (code) => {
      resolve({ stdout: Buffer.concat(stdoutChunks), stderr: stderrChunks.join(""), code: code ?? -1 });
    });
    p.stdin.end(stdin);
  });
}

async function atomicWrite(target: string, data: Buffer | string, mode = 0o600): Promise<void> {
  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(target)}.tmp-${crypto.randomBytes(6).toString("hex")}`);
  await fs.writeFile(tmp, data, { mode });
  await fs.rename(tmp, target);
}

async function fileExists(p: string): Promise<boolean> {
  try { await fs.access(p, fsConstants.F_OK); return true; } catch { return false; }
}

/**
 * Encrypt plaintext with systemd-creds (machine-bound key) and atomically
 * write the ciphertext to disk. Returns the ciphertext bytes (for testing).
 */
async function encryptToDisk(tgUserId: number, svc: Service, plaintext: Buffer): Promise<void> {
  const name = credName(tgUserId, svc);
  const { stdout, stderr, code } = await runWithStdin(
    "systemd-creds",
    ["encrypt", `--name=${name}`, "-", "-"],
    plaintext,
  );
  if (code !== 0) {
    throw new Error(`systemd-creds encrypt failed (code=${code}): ${stderr.slice(0, 400)}`);
  }
  await atomicWrite(encPath(tgUserId, svc), stdout, 0o600);
}

/**
 * Decrypt the on-disk .enc file with systemd-creds and return plaintext.
 * Throws if the .enc file doesn't exist or decryption fails.
 */
async function decryptFromDisk(tgUserId: number, svc: Service): Promise<Buffer> {
  const name = credName(tgUserId, svc);
  const ciphertext = await fs.readFile(encPath(tgUserId, svc));
  const { stdout, stderr, code } = await runWithStdin(
    "systemd-creds",
    ["decrypt", `--name=${name}`, "-", "-"],
    ciphertext,
  );
  if (code !== 0) {
    throw new Error(`systemd-creds decrypt failed (code=${code}): ${stderr.slice(0, 400)}`);
  }
  return stdout;
}

/**
 * Publish plaintext to tmpfs so the agent's symlink read resolves. Idempotent.
 */
async function publishPlaintext(tgUserId: number, svc: Service, plaintext: Buffer): Promise<void> {
  const target = tmpfsPath(tgUserId, svc);
  await fs.mkdir(tmpfsDir(tgUserId), { recursive: true, mode: 0o700 });
  await atomicWrite(target, plaintext, 0o600);
  await ensureSymlink(tgUserId, svc);
}

/**
 * Ensure workspace/credentials/<svc>.json is a symlink pointing at the
 * tmpfs plaintext file. Idempotent; replaces any stale regular file or
 * wrong-target symlink.
 */
async function ensureSymlink(tgUserId: number, svc: Service): Promise<void> {
  const link = symlinkPath(tgUserId, svc);
  const want = tmpfsPath(tgUserId, svc);
  try {
    const current = await fs.readlink(link);
    if (current === want) return;
    await fs.unlink(link);
  } catch (e: unknown) {
    // Not a symlink — may be a regular file from the old plaintext-on-disk
    // era. Remove it so the new symlink points at tmpfs.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      try { await fs.unlink(link); } catch { /* tolerate */ }
    }
  }
  await fs.symlink(want, link);
}

/**
 * Read credentials for a service. Reads the tmpfs plaintext if present,
 * otherwise decrypts from disk and publishes to tmpfs first. Returns the
 * parsed object, or null if neither the tmpfs nor the .enc file exists.
 */
export async function readCreds<T extends Creds>(tgUserId: number, svc: Service): Promise<T | null> {
  const tmp = tmpfsPath(tgUserId, svc);
  if (await fileExists(tmp)) {
    try {
      const raw = await fs.readFile(tmp, "utf8");
      return JSON.parse(raw) as T;
    } catch (err) {
      console.error(`[cred-store] tmpfs read failed for ${svc} tg=${tgUserId}:`, err);
      // Fall through to decrypt-from-disk
    }
  }
  if (!(await fileExists(encPath(tgUserId, svc)))) return null;
  const plaintext = await decryptFromDisk(tgUserId, svc);
  await publishPlaintext(tgUserId, svc, plaintext);
  return JSON.parse(plaintext.toString("utf8")) as T;
}

/**
 * Merge the given partial fields into the on-disk credentials for a service,
 * atomically. Encrypts to disk, republishes plaintext to tmpfs, refreshes
 * the symlink. Adds a per-field `stored_at` ISO-8601 timestamp for every
 * field touched.
 *
 * This is the only supported write path. Callers (handler + detector) pass
 * partial field sets from a single user message and the function merges
 * them into the full record.
 */
export async function mergeCreds<T extends Creds>(
  tgUserId: number,
  svc: Service,
  partial: Partial<T>,
): Promise<{ fields_stored: string[]; full: T }> {
  const existing = (await readCreds<T>(tgUserId, svc)) ?? ({} as T);
  const now = new Date().toISOString();
  const stored_at: Record<string, string> = { ...(existing.stored_at ?? {}) };

  const fields_stored: string[] = [];
  for (const [k, v] of Object.entries(partial)) {
    if (k === "stored_at" || k === "verified") continue;
    if (v === undefined || v === null || v === "") continue;
    (existing as Record<string, unknown>)[k] = v;
    stored_at[k] = now;
    fields_stored.push(`${svc}.${k}`);
  }
  existing.stored_at = stored_at;

  const plaintext = Buffer.from(JSON.stringify(existing, null, 2), "utf8");
  await encryptToDisk(tgUserId, svc, plaintext);
  await publishPlaintext(tgUserId, svc, plaintext);
  return { fields_stored, full: existing };
}

/**
 * Write a freshly-verified timestamp onto a service's creds after a probe
 * succeeded. Kept atomic through mergeCreds's write path.
 */
export async function markVerified(tgUserId: number, svc: Service): Promise<void> {
  const existing = await readCreds<Creds>(tgUserId, svc);
  if (!existing) return;
  existing.verified = new Date().toISOString();
  const plaintext = Buffer.from(JSON.stringify(existing, null, 2), "utf8");
  await encryptToDisk(tgUserId, svc, plaintext);
  await publishPlaintext(tgUserId, svc, plaintext);
}

/**
 * Return which fields are currently populated for a service. Used by the
 * handler to tell the agent "you still need X and Y".
 */
export async function fieldsPresent(tgUserId: number, svc: Service): Promise<string[]> {
  const c = await readCreds<Creds>(tgUserId, svc);
  if (!c) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(c)) {
    if (k === "stored_at" || k === "verified") continue;
    if (typeof v === "string" && v.length > 0) out.push(k);
  }
  return out;
}

/**
 * Lazy per-user hydration: if the tmpfs plaintext is missing but the .enc
 * exists, decrypt and publish. Call this from the handler at the start of
 * every active-user dispatch to guarantee the agent's symlink read works
 * even after a msgschool.service restart cleared /run/msgschool/. O(fs.access)
 * when already hot — negligible overhead.
 */
export async function ensureUserHydrated(tgUserId: number): Promise<void> {
  for (const svc of ["canvas", "skyward"] as const) {
    try {
      if (!(await fileExists(encPath(tgUserId, svc)))) continue;
      if (await fileExists(tmpfsPath(tgUserId, svc))) {
        await ensureSymlink(tgUserId, svc);
        continue;
      }
      const plaintext = await decryptFromDisk(tgUserId, svc);
      await publishPlaintext(tgUserId, svc, plaintext);
    } catch (err) {
      console.error(`[cred-store] ensureUserHydrated fail tg=${tgUserId} svc=${svc}:`, err);
    }
  }
}

/**
 * Call on msgschool.service startup (and after any deploy that changes the
 * store's schema). For each active agent workspace, if <svc>.json.enc
 * exists but tmpfs is empty, decrypt and publish; replaces the legacy
 * plaintext-on-disk file with the tmpfs symlink if needed.
 */
export async function ensureAllUsersHydrated(): Promise<void> {
  let agents: string[] = [];
  try {
    agents = await fs.readdir(USERS_DIR);
  } catch (err) {
    console.error(`[cred-store] cannot read ${USERS_DIR}:`, err);
    return;
  }
  for (const agent of agents) {
    if (!agent.startsWith("canvasagent-")) continue;
    const tg = Number(agent.slice("canvasagent-".length));
    if (!Number.isFinite(tg)) continue;
    for (const svc of ["canvas", "skyward"] as const) {
      try {
        if (!(await fileExists(encPath(tg, svc)))) continue;
        if (await fileExists(tmpfsPath(tg, svc))) {
          await ensureSymlink(tg, svc);
          continue;
        }
        const plaintext = await decryptFromDisk(tg, svc);
        await publishPlaintext(tg, svc, plaintext);
      } catch (err) {
        console.error(`[cred-store] hydrate fail for ${agent}/${svc}:`, err);
      }
    }
  }
}

/**
 * One-time migration helper: if <svc>.json exists as a regular file
 * (plaintext from the pre-encryption era), read it, encrypt to .enc,
 * publish to tmpfs, and replace the regular file with the symlink.
 *
 * Safe to re-run; skips users already on the new layout.
 */
export async function migrateLegacyPlaintextIfPresent(tgUserId: number, svc: Service): Promise<{ migrated: boolean; reason?: string }> {
  const link = symlinkPath(tgUserId, svc);
  let stat;
  try {
    stat = await fs.lstat(link);
  } catch {
    return { migrated: false, reason: "no existing file" };
  }
  if (stat.isSymbolicLink()) {
    return { migrated: false, reason: "already symlinked" };
  }
  const plaintext = await fs.readFile(link);
  await encryptToDisk(tgUserId, svc, plaintext);
  await publishPlaintext(tgUserId, svc, plaintext); // writes to tmpfs
  // Replace the regular file with the symlink (publishPlaintext already set it)
  return { migrated: true };
}

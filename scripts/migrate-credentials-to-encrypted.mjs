#!/usr/bin/env node
//
// One-time migration: walk every canvasagent-<id>/workspace/credentials/
// directory, encrypt any plaintext canvas.json / skyward.json using
// systemd-creds, replace the plaintext file with a symlink to a tmpfs
// plaintext copy, leave the .enc on disk.
//
// Safe to re-run. Idempotent. Reports per-user before/after.
//
// Usage (on the msgschool VM, as root since /opt/msgschool/users is
// root-owned and systemd-creds needs root to read its secret file):
//
//   sudo node /var/www/msgschool/scripts/migrate-credentials-to-encrypted.mjs
//

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const USERS_DIR = process.env.USER_WORKSPACE_ROOT || "/opt/msgschool/users";

// Dynamically import the TypeScript source via tsx if available, else the
// compiled .next output. The simpler option: shell out the heavy lifting
// to a tsx-launched helper. For now, do the work inline in JavaScript that
// mirrors credential-store.ts semantics — same functions, same file paths,
// no dependency on the Next.js build tree.
import { spawn } from "node:child_process";
import crypto from "node:crypto";

const TMPFS_ROOT = "/run/msgschool";

function agentId(tg) { return `canvasagent-${tg}`; }
function workspaceFor(tg) { return path.join(USERS_DIR, agentId(tg), "workspace"); }
function credDir(tg) { return path.join(workspaceFor(tg), "credentials"); }
function encPath(tg, svc) { return path.join(credDir(tg), `${svc}.json.enc`); }
function linkPath(tg, svc) { return path.join(credDir(tg), `${svc}.json`); }
function tmpfsDir(tg) { return path.join(TMPFS_ROOT, agentId(tg)); }
function tmpfsPath(tg, svc) { return path.join(tmpfsDir(tg), `${svc}.json`); }
function credName(tg, svc) { return `msgschool-${svc}-${tg}`; }

function runWithStdin(cmd, args, stdin) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out = []; const err = [];
    p.stdout.on("data", (c) => out.push(c));
    p.stderr.on("data", (c) => err.push(c.toString()));
    p.on("error", reject);
    p.on("close", (code) => resolve({ stdout: Buffer.concat(out), stderr: err.join(""), code: code ?? -1 }));
    p.stdin.end(stdin);
  });
}

async function atomicWrite(target, data, mode = 0o600) {
  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(target)}.tmp-${crypto.randomBytes(6).toString("hex")}`);
  await fs.writeFile(tmp, data, { mode });
  await fs.rename(tmp, target);
}

async function fileExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function encryptToDisk(tg, svc, plaintext) {
  const { stdout, stderr, code } = await runWithStdin(
    "systemd-creds",
    ["encrypt", `--name=${credName(tg, svc)}`, "-", "-"],
    plaintext,
  );
  if (code !== 0) throw new Error(`systemd-creds encrypt failed: ${stderr}`);
  await atomicWrite(encPath(tg, svc), stdout, 0o600);
}

async function publishPlaintext(tg, svc, plaintext) {
  await fs.mkdir(tmpfsDir(tg), { recursive: true, mode: 0o700 });
  await atomicWrite(tmpfsPath(tg, svc), plaintext, 0o600);
  try { await fs.unlink(linkPath(tg, svc)); } catch {}
  await fs.symlink(tmpfsPath(tg, svc), linkPath(tg, svc));
}

async function migrateOne(tg, svc) {
  const link = linkPath(tg, svc);
  let stat;
  try { stat = await fs.lstat(link); }
  catch { return { status: "no-file" }; }

  if (stat.isSymbolicLink()) return { status: "already-symlinked" };

  const plaintext = await fs.readFile(link);
  await encryptToDisk(tg, svc, plaintext);
  await publishPlaintext(tg, svc, plaintext);
  return { status: "migrated", size: plaintext.length };
}

async function main() {
  const agents = await fs.readdir(USERS_DIR).catch(() => []);
  const report = [];
  for (const name of agents) {
    if (!name.startsWith("canvasagent-")) continue;
    const tg = Number(name.slice("canvasagent-".length));
    if (!Number.isFinite(tg)) continue;
    const row = { agent: name, canvas: null, skyward: null };
    for (const svc of ["canvas", "skyward"]) {
      try {
        row[svc] = await migrateOne(tg, svc);
      } catch (e) {
        row[svc] = { status: "error", error: e.message };
      }
    }
    report.push(row);
    console.log(JSON.stringify(row));
  }
  console.error(`\nDone. ${report.length} agents processed.`);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });

#!/usr/bin/env node
/**
 * ms_call — agent-facing CLI wrapper for msgschool-toolsd.
 *
 * Usage from inside an agent's bash tool:
 *   ms_call <tool_name> '<json_args>'
 *
 * Derives the calling user's `tg` from the workspace path
 * (`/opt/msgschool/users/canvasagent-<tg>/workspace`). Returns the JSON
 * response on stdout. Exit codes:
 *   0   success
 *   1   tool returned an error (response.error in stdout)
 *   2   transport failure (cannot connect to daemon)
 *   3   bad input (no tool, bad json args, no tg derivable)
 */
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";

const SOCKET_PATH = process.env.MSGSCHOOL_TOOLSD_SOCKET || "/run/msgschool/toolsd.sock";

function deriveTg() {
  // Agent always invokes from inside its workspace dir.
  const explicit = process.env.MSGSCHOOL_TG_USER_ID;
  if (explicit && /^\d+$/.test(explicit)) return Number(explicit);
  const cwd = process.cwd();
  const m = cwd.match(/canvasagent-(\d+)/);
  if (m) return Number(m[1]);
  return null;
}

function usage() {
  process.stderr.write(
    "usage: ms_call <tool_name> '<json_args>'\n" +
      "       ms_call canvas.list_courses '{}'\n" +
      "       ms_call canvas.get_pulse '{}'\n" +
      "       ms_call skyward.get_grades '{}'\n" +
      "       ms_call skyward.get_attendance '{\"since\":\"2026-04-01T00:00:00Z\"}'\n" +
      "       ms_call pulse.combined '{}'\n",
  );
}

function encodeFrame(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf-8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

function readOneFrame(socket) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let expected = null;
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (expected === null && buf.length >= 4) {
        expected = buf.readUInt32BE(0);
      }
      if (expected !== null && buf.length >= 4 + expected) {
        resolve(buf.subarray(4, 4 + expected).toString("utf-8"));
      }
    });
    socket.on("error", reject);
    socket.on("end", () => {
      if (expected === null) reject(new Error("connection closed before response"));
    });
  });
}

async function main() {
  const [tool, argsRaw] = process.argv.slice(2);
  if (!tool) {
    usage();
    process.exit(3);
  }
  let args = {};
  if (argsRaw) {
    try {
      args = JSON.parse(argsRaw);
    } catch (e) {
      process.stderr.write(`ms_call: bad JSON args: ${e.message}\n`);
      process.exit(3);
    }
  }
  const tg = deriveTg();
  if (tg === null) {
    process.stderr.write(
      "ms_call: cannot derive tg from cwd or MSGSCHOOL_TG_USER_ID env. " +
        "Run from inside an agent workspace dir, e.g. /opt/msgschool/users/canvasagent-<id>/workspace\n",
    );
    process.exit(3);
  }
  const req = {
    v: 1,
    tg,
    tool,
    args,
    request_id: randomUUID(),
  };
  const socket = net.createConnection(SOCKET_PATH);
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  }).catch((e) => {
    process.stderr.write(`ms_call: cannot connect to ${SOCKET_PATH}: ${e.message}\n`);
    process.exit(2);
  });
  socket.write(encodeFrame(req));
  let body;
  try {
    body = await readOneFrame(socket);
  } catch (e) {
    process.stderr.write(`ms_call: transport error: ${e.message}\n`);
    process.exit(2);
  } finally {
    socket.destroy();
  }
  process.stdout.write(body + "\n");
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    process.exit(0); // unparseable but we got a body — let the caller handle
  }
  if (parsed.error) process.exit(1);
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`ms_call: ${e.message}\n`);
  process.exit(2);
});

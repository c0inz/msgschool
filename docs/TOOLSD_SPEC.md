# MsgSchool ToolsD — Specification

Status: **implementation live in production** (`msgschool-toolsd.service` running
under `systemd-toolsd-spec/0.1.0`; source at `src/lib/toolsd/`). This document is
maintained as the architectural reference for the data flow, privilege model,
and the path the agent's `ms_call` tool takes through the unix socket. Note
that the v1 daemon runs as root alongside the rest of the platform; structural
per-UID isolation between agent and daemon is the next hardening step (see §1).

The intent is structural: after this lands, the agent process **cannot**
obtain the raw value of a Canvas API token or Skyward password by any
sequence of file reads, tool calls, or shell commands available to it.
The credentials physically do not live in any file the agent's UID can
read.

---

## 1. Why this exists

Today (verified 2026-05-01 against tg=100000001's workspace):

- Encryption at rest works as designed — `credentials/*.json.enc` are
  ciphertext on disk, plaintext exists only on tmpfs.
- The agent reads plaintext through a workspace symlink because
  `CANVAS_PLAYBOOK.md` and `SKYWARD_PLAYBOOK.md` instruct it to.
- The agent then writes JS scripts (`fetch_canvas.mjs`,
  `skyward_final.js`, etc.) where it **inlines the credential values as
  string literals** into the script source. Those script files live on
  persistent disk inside the workspace.
- The agent has also been observed echoing the values into Telegram chat
  replies (the user-reported leak on tg=100000001, 2026-04-30).
- Backups archive workspace files. Plaintext credentials in agent-written
  scripts therefore land in backups regardless of what the credential
  store does.

The fix surface for *this class of leak* is not "tell the model harder."
It is making the credential value unreachable from inside the agent's
process. That requires:

- Removing the agent's filesystem read access to `credentials/*.json`.
- Replacing the affordance the agent loses (writing playwright scripts
  that authenticate against Canvas/Skyward) with a higher-level RPC
  surface where the agent says *what* it wants and the platform answers
  with the data — never the credential.

That RPC surface is `msgschool-toolsd`.

---

## 2. Threat model

### What becomes impossible

| Scenario | Today | After ToolsD |
|---|---|---|
| Agent `cat credentials/canvas.json` | succeeds, returns plaintext | fails — file unreadable to agent UID |
| Agent `cat /run/msgschool/<id>/canvas.json` | succeeds | fails — directory unreadable to agent UID |
| Agent writes a playwright script with `page.fill('#password', 'examplepass2')` | possible | not possible — agent has no source for the literal |
| Agent echoes a credential to Telegram | possible (literal in chat output) | not possible — the agent never holds the value |
| Bad actor with a foothold inside the agent process | walks away with creds | walks away with course names + grades only |
| Backup tarball contains plaintext credentials in workspace | yes (in agent-written scripts) | no |

### What this does NOT solve

| Risk | Mitigation (separate work) |
|---|---|
| Bad actor with a foothold as `mstoolsd` user | restricted user, no shell, no writable code paths; full-system compromise is out of scope here |
| Bad actor with root on the VM | game over; no app-level fix |
| Telegram message-history server-side retention | already disclosed in `/privacy` |
| Inbound credential paste arriving in Telegram before scrubber fires | covered by separate inbound-scrubber bug fix; orthogonal |
| Agent leaking *grade* data to a wrong audience | not in scope — that's a behavioral problem, not a credential problem |

### Trust boundary diagram

```
  ┌────────────────────────────────────────────────────────────────┐
  │  Linux VM (<vm-ip>)                                    │
  │                                                                │
  │  ┌─────────────────────┐   unix socket    ┌────────────────┐   │
  │  │  agent process      │   /run/msgschool │  toolsd        │   │
  │  │  UID = msagent-<id> │ ───────────────► │  UID = mstoolsd│   │
  │  │                     │   JSON-RPC       │                │   │
  │  │  has: workspace/    │                  │  has: tmpfs    │   │
  │  │  cannot read:       │                  │  creds, can    │   │
  │  │  - /run/msgschool/* │                  │  call Canvas / │   │
  │  │  - credentials/*    │                  │  Skyward APIs  │   │
  │  └─────────────────────┘                  └────────────────┘   │
  │           ▲                                       │            │
  │           │ tool result (data only, no creds)     │            │
  │           └───────────────────────────────────────┘            │
  └────────────────────────────────────────────────────────────────┘
```

The trust boundary is the unix socket. Agent UID writes a request frame;
toolsd authenticates the peer via `SO_PEERCRED`, looks up the
corresponding `telegram_user_id`, and answers from credentials it loads
on-demand into its own process memory. The request and response cross
the boundary; the credential never does.

---

## 3. Component inventory

### 3.1 New components

| Component | Type | Owner | Path |
|---|---|---|---|
| `msgschool-toolsd` | long-running Node service | `mstoolsd:mstoolsd` | `/usr/local/lib/msgschool/toolsd/` |
| `ms_call` | thin client wrapper (Node, ~80 LoC) | `root:root`, mode 0755 | `/usr/local/bin/ms_call` |
| `msgschool-toolsd.service` | systemd unit | system | `/etc/systemd/system/msgschool-toolsd.service` |
| `msagent-<tg_id>` Linux user | per-agent, no shell, no sudo | system | created by `provision.sh` |
| `mstoolsd` Linux user | service account | system | created by `bootstrap-droplet.sh` |
| `ms_tool_calls` table | audit log | DB | new drizzle migration |

### 3.2 Components removed

- The workspace symlink `credentials/<svc>.json → /run/msgschool/.../<svc>.json`
  — agent no longer has read access; symlink is removed.
- The workspace symlink `credentials/<svc>.json.enc` — moved out of the
  agent-visible workspace entirely (lives at
  `/var/lib/msgschool/agents/<tg_id>/credentials/<svc>.json.enc` instead).
- `<workspace>/credentials/` directory — deleted from the agent's view.
- `CANVAS_PLAYBOOK.md` and `SKYWARD_PLAYBOOK.md` sections that show
  `await page.fill('#login', '<from credentials/skyward.json>')` — replaced
  with `ms_call` examples.
- `fetch_canvas.mjs`, `skyward_*.js` scripts that the agent has written:
  the playbooks no longer instruct the agent to write these. Existing
  copies in the 3 live workspaces are removed during migration (§9).

---

## 4. Tool surface (v1)

All tools accept JSON args and return JSON results. Args and returns are
pure data — no credential, no URL, no internal id from the credential
store ever appears in either direction.

The agent invokes a tool by running:

```
ms_call <tool_name> '<json_args>'
```

`ms_call` writes one JSON request to the unix socket and prints the JSON
response on stdout. Exit code: 0 on success, 1 on tool error, 2 on
transport error.

### 4.1 Canvas tools

| Tool | Args | Returns | Cache TTL |
|---|---|---|---|
| `canvas.list_courses` | `{}` | `[{course_id, name, term, course_code, enrollment_state}]` | 600s |
| `canvas.list_assignments` | `{course_id: int, since?: ISO8601}` | `[{id, name, due_at, points_possible, submission: {grade, score, workflow_state, submitted_at}}]` | 300s |
| `canvas.list_missing` | `{}` | `[{course_id, course_name, name, due_at}]` | 120s |
| `canvas.list_announcements` | `{course_id?: int, since?: ISO8601}` | `[{course_id, posted_at, title, body_text}]` | 300s |
| `canvas.get_pulse` | `{}` | `{courses: [...], recent_grades: [...], missing: [...], this_week: [...], generated_at}` | 60s |
| `canvas.connectivity_probe` | `{}` | `{ok: bool, http_status, latency_ms, error_class?}` | none |

### 4.2 Skyward tools

| Tool | Args | Returns | Cache TTL |
|---|---|---|---|
| `skyward.get_grades` | `{term?: "T1"\|"T2"\|"T3"\|"T4"}` | `[{course, letter, percent, term, last_changed_at, data_gid}]` | 120s |
| `skyward.get_attendance` | `{since?: ISO8601}` | `[{date, period, code, course}]` | 300s |
| `skyward.get_pulse` | `{}` | `{grades: [...], attendance: [...], recent_changes: [...], generated_at}` | 60s |
| `skyward.connectivity_probe` | `{}` | `{ok: bool, login_succeeded, latency_ms, error_class?}` | none |

### 4.3 Cross-service tools

| Tool | Args | Returns | Cache TTL |
|---|---|---|---|
| `pulse.combined` | `{}` | composite of `canvas.get_pulse` + `skyward.get_pulse`, with cell-level cross-system reconciliation (Skyward = system of record) | 60s |
| `tools.healthcheck` | `{}` | `{toolsd_version, canvas_ok, skyward_ok, last_credentials_loaded_at, peer_uid}` | none — for the agent's own use during onboarding |

### 4.4 Argument and return discipline

- All timestamps are ISO 8601 UTC strings. No epoch ints, no local zones.
- No credential, URL, or auth token ever appears in args or returns.
- `course_id` is the Canvas integer; `data_gid` is the Skyward grade-link
  id. Neither is sensitive.
- Errors are always `{error: {code, message}}` with `code` from a closed
  enum (`AUTH_FAILED`, `UPSTREAM_TIMEOUT`, `UPSTREAM_HTTP_<n>`,
  `IP_BLOCKED`, `RATE_LIMITED`, `INVALID_ARG`, `INTERNAL`). The model
  reasons against codes, not free-text strings.

### 4.5 Out of scope — permanently, not just v1

- **No write-side tools, ever** (no "send Canvas message", no "update
  Skyward emergency contact"). Read-only is the project posture, not a
  v1 limitation. Adding any write-side tool requires a fresh threat
  model and explicit re-approval — it is not a "v2 scope expansion."
- No tool that returns the credential, even in obfuscated form.
- No tool that returns a Canvas-side URL containing a session token.
- No agent-controlled cache invalidation; cache TTLs are enforced by
  toolsd alone.

---

## 5. Wire protocol

### 5.1 Transport

- Unix domain socket at `/run/msgschool/toolsd.sock`, mode `0666`,
  owned `mstoolsd:mstoolsd`.
- Length-prefixed JSON frames: `<u32 BE byte_length><utf-8 JSON body>`.
  One request → one response per connection. No multiplexing in v1.

### 5.2 Request shape

```json
{
  "v": 1,
  "tool": "canvas.list_courses",
  "args": {},
  "request_id": "<client-supplied uuid>"
}
```

`tg` is **not** in the request — it is derived server-side from peer
credentials (§6).

### 5.3 Response shape

```json
{
  "v": 1,
  "request_id": "<echo of request_id>",
  "result": { ... }
}
```

or

```json
{
  "v": 1,
  "request_id": "<echo>",
  "error": {
    "code": "UPSTREAM_HTTP_401",
    "message": "Canvas returned 401 — token revoked or expired."
  }
}
```

### 5.4 Versioning

- `v: 1` on both sides for v1.
- A future v2 negotiates capabilities on connect; v1 hard-fails on `v: 2`
  requests with `INVALID_ARG`.

---

## 6. Authentication and authorization

### 6.1 Peer authentication

- toolsd reads `SO_PEERCRED` on every accepted connection.
- The peer UID must be in the form `msagent-<digits>` (looked up by name).
- The UID-to-`telegram_user_id` mapping comes from a single source of
  truth: the Linux username `msagent-<tg_id>` is the only way to derive
  the tg_id. There is no lookup table; the username encodes the binding.

### 6.2 Authorization rule

- Each tool call operates on **the caller's own** Telegram-user data.
  There is no cross-user tool. There is no admin-impersonation tool.
  Removing this surface entirely removes a class of authz bugs.
- toolsd loads credentials for `tg = peer_tg` only, never for any other
  user, regardless of args.

### 6.3 What an exploited agent can ask for

The worst the agent can do over toolsd is repeatedly call its own
`pulse.combined` (rate-limited, §7.4) — i.e., the same data it already
has the right to see. No path to escalate to another user, no path to
write data, no path to obtain the credential.

---

## 7. Process and privilege model

### 7.1 User accounts

| Account | Created by | Shell | Purpose |
|---|---|---|---|
| `mstoolsd` | `bootstrap-droplet.sh` (one-time) | `/usr/sbin/nologin` | runs the daemon |
| `msagent-<tg_id>` | `provision.sh` (per user) | `/usr/sbin/nologin` | runs that user's OpenClaw agent |
| `readystack` | existing | normal | unchanged; not touched |
| `root` | existing | normal | provisions, deprovisions, runs migrations |

### 7.2 Filesystem layout (post-migration)

```
/var/lib/msgschool/
├── agents/
│   └── <tg_id>/
│       └── credentials/
│           ├── canvas.json.enc         mode 0640  mstoolsd:mstoolsd
│           └── skyward.json.enc        mode 0640  mstoolsd:mstoolsd
└── toolsd/
    └── cache/                          mode 0700  mstoolsd:mstoolsd

/run/msgschool/
└── toolsd.sock                         mode 0666  mstoolsd:mstoolsd
   (no per-user tmpfs credential files anymore — toolsd holds plaintext
    in its process memory only, decrypts on demand, never writes to disk.)

/opt/msgschool/users/<agent>/workspace/
├── (same as today)
└── (no credentials/ directory — removed during migration)
```

### 7.3 OpenClaw agent execution

- The agent process is launched by the OpenClaw gateway with
  `Setuid=msagent-<tg_id>` in its systemd unit (or equivalent
  `runuser`/`setpriv` invocation if launched outside systemd).
- `umask 077`, no inherited capabilities, no `PATH` containing setuid
  binaries except `/usr/local/bin/ms_call`.
- The agent's `workspace/` is owned `msagent-<tg_id>:msagent-<tg_id>`,
  mode 0700.

### 7.4 Rate limits inside toolsd

- Per-tg, per-tool: token bucket. 30 calls/min steady, burst 60.
- Per-tg, global: 200 calls/min steady, burst 400.
- Exceeded → `RATE_LIMITED`. Bucket refill is ½-rate during the next
  60s as a soft penalty.

These limits exist to bound the cost of a runaway agent loop, not to
defend against a malicious peer (the peer is locally authenticated; its
worst case is its own data).

---

## 8. Credential lifecycle

### 8.1 Capture (unchanged from `CREDENTIAL_CAPTURE_SPEC.md`)

- User pastes credential into Telegram.
- Inbound scrubber redacts the message in chat + DB.
- Encrypted ciphertext written to
  `/var/lib/msgschool/agents/<tg_id>/credentials/<svc>.json.enc`.

### 8.2 Use

- toolsd, on receiving a tool request from peer `msagent-<tg_id>`:
  1. Looks up `<tg_id>` from the peer's username.
  2. Checks an in-process LRU keyed on `(tg, svc)` for cached plaintext
     decrypted within the last 10 minutes. Cache is a `Buffer` zeroed on
     eviction.
  3. On miss: spawns `systemd-creds decrypt --name=msgschool-<svc>-<tg>`
     against the on-disk `.enc` file, parses JSON into a struct, stores
     in LRU.
  4. Calls Canvas / Skyward with the credential, captures only the
     response data.
  5. Returns the response data over the socket; the credential value
     never leaves toolsd's process memory.

### 8.3 Eviction

- Plaintext LRU TTL: 10 minutes since last use.
- On eviction, the buffer is overwritten with zeros before being released
  (best-effort; Node `Buffer.fill(0)`).
- On `SIGTERM` (e.g. `systemctl restart`), all LRU entries are zeroed
  before exit.
- The OS-level guarantee on tmpfs (cleared on reboot) is no longer
  needed because plaintext never lands on tmpfs in the first place.

### 8.4 Deprovision

- `deprovision.sh` calls toolsd's admin socket
  (`/run/msgschool/toolsd.admin.sock`, root-only, mode 0600) with
  `{op: "evict", tg: <id>}`. toolsd zeroes the LRU entry immediately.
- `deprovision.sh` then deletes
  `/var/lib/msgschool/agents/<tg_id>/`.
- `deprovision.sh` then `userdel msagent-<tg_id>` so any subsequent
  toolsd connection from that UID is rejected with `PEER_UNKNOWN`.

---

## 9. Migration plan

There are 3 live agents today: tg=100000001, tg=100000002, tg=100000003.
Migration runs once, scripted, with the gateway briefly stopped.

### 9.1 Steps (run as root, in order)

1. **Stop the OpenClaw gateway** (`systemctl stop openclaw-gateway`) so
   no agent is mid-call.
2. **Create `mstoolsd` user**: `useradd -r -s /usr/sbin/nologin mstoolsd`.
3. **Move credential ciphertexts** out of each workspace:
   - For each of the 3 tg_ids, `mv
     /opt/msgschool/users/canvasagent-<tg>/workspace/credentials/<svc>.json.enc
     /var/lib/msgschool/agents/<tg>/credentials/`
   - Re-encrypt under a `mstoolsd`-readable path/key if `systemd-creds`'s
     bound key changes (it does not, but verify with a decrypt cycle).
4. **Create per-user agent accounts**:
   `useradd -r -s /usr/sbin/nologin msagent-<tg>` for each tg_id.
5. **Re-chown workspaces** to the new agent user:
   `chown -R msagent-<tg>:msagent-<tg> /opt/msgschool/users/canvasagent-<tg>/workspace/`,
   then `chmod 0700` the workspace root.
6. **Delete the leftover `credentials/` directory** in each workspace
   (the agent must not see even the empty directory; it would imply the
   capability still exists).
7. **Sweep agent-written credential leaks** — for each workspace, scan
   `*.js`, `*.mjs`, `USER.md`, `MEMORY.md` for the literal credential
   values currently on file (read them once from the just-moved
   ciphertexts, decrypt in a one-shot script, grep, replace literals
   with `[redacted-pre-migration]`, re-encrypt the workspace files in
   place — or just delete the agent-written script files entirely; they
   are regeneratable). Decision: **delete the agent-written script files**
   — they are not load-bearing, they exist because the playbooks said
   the agent should write them. After migration the playbooks no longer
   say that.
8. **Install toolsd** (`/usr/local/lib/msgschool/toolsd/`),
   `ms_call` (`/usr/local/bin/ms_call`), and the systemd unit. Start
   `msgschool-toolsd.service`.
9. **Update the agent-template playbooks** — remove all
   `page.fill('#login', '<from credentials/...>')` examples; replace
   with `ms_call` invocations. Re-deploy templates so subsequent
   `provision.sh` runs ship the new playbooks. (Existing workspaces
   pick up changes automatically since `CANVAS_PLAYBOOK.md`,
   `SKYWARD_PLAYBOOK.md` are symlinks into the deployed templates dir
   per `provision.sh`.)
10. **Update `provision.sh`** to:
    - `useradd msagent-<tg>` before workspace creation.
    - Skip writing a `credentials/` symlink (none needed).
    - Set workspace ownership to the new user.
11. **Update `deprovision.sh`** to:
    - Hit toolsd's admin socket with an evict op.
    - `userdel msagent-<tg>` after workspace archive.
12. **Restart the OpenClaw gateway**, configured to launch each agent
    under its `msagent-<tg>` UID.
13. **Smoke test** each of the 3 live agents:
    `ms_call tools.healthcheck '{}'` from inside the agent's bash tool;
    expect `{toolsd_version: "...", canvas_ok: true, skyward_ok: true,
    peer_uid: "msagent-100000001"}`.
14. **Verify the negative path**:
    `cat /run/msgschool/toolsd.sock` and
    `cat /var/lib/msgschool/agents/100000001/credentials/canvas.json.enc`
    from inside the agent's bash tool — both must fail with EACCES.

### 9.2 Rollback

If toolsd is broken at smoke-test time:
- Stop `msgschool-toolsd.service`.
- Restore the workspace `credentials/` symlinks from a per-step backup
  taken before step 6.
- Revert the playbook edits.
- Restart the gateway.

Time window when the bot is offline: ~5 minutes (steps 1–13).
Acceptable for our scale (4 users, ~3 of them family).

### 9.3 Rollback after users have been on toolsd for >24h

- Skip — at that point, the agent-written scripts no longer exist, the
  `credentials/` directory no longer exists, and rolling back would
  require regenerating both. Forward fixes only.

---

## 10. Logging and audit

### 10.1 New table: `ms_tool_calls`

| Column | Type | Notes |
|---|---|---|
| `id` | int (PK) | |
| `telegram_user_id` | bigint | derived from peer UID |
| `tool` | text | e.g. `canvas.list_courses` |
| `args_summary` | text (JSON) | scrubbed args — only **non-sensitive** keys, never values that could echo a credential. Example: `{"course_id": 12345}`; never `{"token": "..."}` |
| `result_size_bytes` | int | size of the response body |
| `cache_hit` | boolean | |
| `latency_ms` | int | wall time inside toolsd |
| `error_code` | text (nullable) | from §4.4 closed enum |
| `created_at` | timestamp default `now()` | |

This table is what feeds the admin panel's "real tokens" cross-check
(token data lives in `ms_token_usage`, but `ms_tool_calls` is the source
of truth for "is the agent actually using the tools we built").

### 10.2 What toolsd never logs

- Request bodies whose args contain a value that could be a credential
  (none should — see §4.4).
- Response bodies (only `result_size_bytes`).
- Decrypted credential plaintext (never logged anywhere, ever, including
  on errors).

### 10.3 stderr/journalctl

toolsd's stderr goes to `journalctl -u msgschool-toolsd`. Lines are
structured: `level=INFO ts=... tg=<id> tool=<name> latency_ms=<n>
result=ok|error code=<code>`. No credential, no response data.

---

## 11. Failure modes

| Failure | Visible effect | Detected by |
|---|---|---|
| toolsd crashes | every `ms_call` returns exit 2 + stderr "transport error" | systemd auto-restart; gateway-side liveness ping every 30s |
| socket file missing on startup | toolsd creates it; if `/run/msgschool/` doesn't exist, `RuntimeDirectory=msgschool` in the unit handles it | unit test in CI |
| Canvas token revoked | tool returns `UPSTREAM_HTTP_401` | agent prompts user to re-issue token |
| Skyward password changed | tool returns `AUTH_FAILED` | agent prompts user to re-paste password |
| District IP-blocks the VM | tool returns `IP_BLOCKED` | hooks into the IP-blacklist Phase 1 work already discussed |
| Agent UID is unknown to system (race during deprovision) | `PEER_UNKNOWN` | tool returns clean error; no leak |
| Disk full on `/var/lib/msgschool/` | new captures fail with `INTERNAL` | systemd alert + admin panel healthcheck |

---

## 12. Observability

### 12.1 Metrics (logged once per minute to `journalctl`)

- `tool_calls_total` per `tool` per `tg`
- `cache_hit_ratio` per `tool`
- `upstream_latency_p50/p95/p99` per `service` (`canvas`/`skyward`)
- `decrypt_calls_total` (should be ~`tool_calls / cache_hit_ratio`)
- `lru_evictions_total`

### 12.2 Healthcheck endpoint

The admin panel's `/admin/healthcheck` (per `ADMIN_PANEL_SPEC.md` §6)
gains one more row: "toolsd reachable" — verifies `tools.healthcheck`
returns within 500ms when called as the panel's own UID against an
admin-only test path on toolsd.

---

## 13. Out of scope for v1

- Write-side tools (Canvas conversations, Skyward updates).
- Push notifications from toolsd to the agent (proactive "your kid was
  marked absent" nudges).
- Token-based auth for cross-host calls (toolsd is local-only in v1).
- Multi-VM deployment (single-VM only; if we go multi-VM, toolsd needs
  network-accessible auth — out of scope).
- Per-tool fine-grained privilege (e.g. an agent that can read grades
  but not attendance). v1 is "all-or-nothing per Telegram user".
- Hardware-backed credential sealing (TPM, HSM). The systemd-creds
  machine-bound key is sufficient for a residential-VM threat model;
  HSM is a separate workstream when we go multi-VM.

---

## 14. Implementation order

Each step is independently shippable; we don't build the next until the
previous is in production and observed working.

1. **`ms_tool_calls` table migration**.
2. **toolsd skeleton**: socket server, `tools.healthcheck`,
   `canvas.list_courses` only. Wired to `mstoolsd` user via systemd.
3. **Per-user `msagent-<tg>` accounts** in `provision.sh`.
   `deprovision.sh` learns to clean them up.
4. **Migration script** for the 3 existing workspaces (manual run, root,
   gateway stopped). Verify negative path (agent can't read creds).
5. **`ms_call` wrapper** + agent-side smoke test from inside an existing
   agent's bash tool.
6. **Port Canvas tools** one at a time, with each tool's port verified
   against an end-to-end agent call before moving to the next.
7. **Port Skyward tools** (longer because of Skyward's playwright
   complexity).
8. **Update `CANVAS_PLAYBOOK.md` + `SKYWARD_PLAYBOOK.md`** to use
   `ms_call` and explicitly forbid writing playwright scripts.
   Re-deploy templates.
9. **Outbound chat scrubber + inbound bug fix** — defense-in-depth, in
   case toolsd ever leaks something we didn't anticipate.
10. **Privacy page edit** — add a paragraph: "Your Skyward password and
    Canvas API token are decrypted only inside an isolated daemon
    process the agent cannot read from. The agent receives data, not
    credentials."

Total estimate: ~1,500 LoC of code + ~300 lines of doc/playbook diff,
~3.5 focused days of work.

---

## 15. Decisions (locked 2026-05-01)

- [x] **Trust boundary**: agent UID `msagent-<tg>`, daemon UID `mstoolsd`,
      no shared filesystem read access to credentials. **Approved.**
- [x] **`credentials/` directory removed from the agent's workspace
      entirely.** Its continued presence would imply a capability that
      no longer exists. **Approved.**
- [x] **Read-only tools only — not just v1, project-level posture.**
      Write-side tools (Canvas message send, Skyward updates) are
      explicitly **never** part of the planned tool surface, regardless
      of version. If a future need arises it requires a fresh threat
      model and re-approval, not a v2 scope expansion. **Approved.**
- [x] **In-process LRU credential caching with a 10-minute TTL.**
      **Approved.**
- [x] **Delete the agent-written `*.js`/`*.mjs` scripts in each existing
      workspace during migration.** **Approved.**

---

## Appendix A — example `ms_call` invocation from inside an agent

The agent today writes a 50-line `fetch_canvas.mjs` and runs `node fetch_canvas.mjs`.

After ToolsD, the agent runs:

```
ms_call canvas.get_pulse '{}'
```

and receives:

```json
{
  "courses": [
    {"course_id": 12345, "name": "Math 1", "term": "T3", "course_code": "MATH-1-3"},
    ...
  ],
  "recent_grades": [...],
  "missing": [...],
  "this_week": [...],
  "generated_at": "2026-05-01T22:14:00Z"
}
```

No credential, no API URL, no token — the agent never had any of it,
the agent never gets any of it.

---

## Appendix B — relationship to existing specs

- `CREDENTIAL_CAPTURE_SPEC.md` — capture flow is unchanged. Storage
  location moves from per-workspace to `/var/lib/msgschool/agents/<tg>/`.
  Ownership changes from `root` to `mstoolsd`.
- `PRIVACY_DEFENSIBILITY_WORKPLAN.md` — the row "credentials live in
  isolated per-user workspace" is amended: credentials live in an
  isolated per-user *daemon-only directory*, not in the workspace.
  Public privacy page (`/privacy`) gets the new sentence in §10 step 10.
- `ADMIN_PANEL_SPEC.md` — the admin healthcheck gains the toolsd
  reachability row (§12.2).
- `LLM_BEHAVIOR_MITIGATIONS.md` — gains a section: "credential leaks
  through agent-written scripts are no longer possible because the
  agent can't write a script that contains a credential it can't read."

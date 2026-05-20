# MsgSchool — Architecture

## One-line summary

**One Telegram bot. One agent persona. One workspace per user. Zero web signup.**

## Why this exists

Harvested from [OCMarketplace](https://github.com/c0inz/OCMarketplace) (generic agent marketplace) and narrowed into a single vertical: Canvas + Skyward monitoring for students/parents. OCMarketplace had multi-agent registration, email-code pairing, Stripe subscriptions, and per-user OpenClaw agent IDs. All of that is overkill for a single-purpose product. What we keep: per-user workspace isolation, the user schema pattern, the Telegram webhook entry.

## Surfaces

| Surface | Role |
|---|---|
| `msgschool.com` | Marketing landing + legal. Three routes: `/`, `/privacy`, `/terms`. No auth. No signup. No dashboard. |
| `@MsgSchoolBot` on Telegram | The entire product surface. Onboarding, billing, day-to-day chat — all through this one bot. |
| `api/bot/webhook` | Single endpoint Telegram POSTs updates to. |
| Per-user workspace | `/opt/msgschool/users/<telegram_user_id>/` — filesystem isolation only. |

## Onboarding flow (CleanRelay-style waterfall, simplified)

Every inbound Telegram message hits one handler (`src/lib/bot/handler.ts`). State machine:

1. **Unknown user sends anything** → create `users` row (`state='new'`, `free_uses_remaining=3`). Reply with greeting + capability pitch + ask for code.
2. **User sends `FreeAgent2026`** → redeem (audit trail in `code_redemptions`), provision workspace, set `state='active'`, set `expires_at = now + 30 days`. Reply with confirmation.
3. **Active user sends anything** → (currently stubbed; dispatch to OpenClaw agent planned).
4. **Active user past `expires_at`** → auto-flip to `state='expired'` on next message. Reply with renewal nudge.
5. **`new` user keeps chatting without a code** → decrement `free_uses_remaining`, nudge each time. At 0, send "exhausted" message.

Identity is the Telegram numeric user_id. Unforgeable, stable, doesn't require an email.

## Data model

See `src/lib/schema.ts`. Three tables:
- `users` — one per Telegram account, keyed on `telegram_user_id`.
- `code_redemptions` — audit log of unlock codes used.
- `messages` — inbound + outbound platform log (not agent conversation memory; the agent keeps its own).

## Provisioning model (vs. OCMarketplace)

We port OCMarketplace's `server-scripts/provision.sh` end-to-end (adapted to msgschool templates, `canvasagent-<tg_id>` id pattern). Provisioning runs when an active user redeems the registration code and is idempotent.

`scripts/provision.sh` per-user steps:
1. Create `/opt/msgschool/users/canvasagent-<tg_id>/workspace/` plus `credentials/`, `memory/`, `logs/` subdirs.
2. **Copy** the mutable platform + per-user seeds in: `PERSONA.md`, `USER.md`, `MEMORY.md`. These become the user's own files; the agent may edit `USER.md` and `memory/*.md` over time.
3. **Symlink** the immutable platform skills: `SOUL.md`, `AGENTS.md`, `TOOLS.md`, `SKYWARD_PLAYBOOK.md`, `CANVAS_PLAYBOOK.md` (when it exists), `CANVAS_ACCESS_TOKEN_REFERENCE.jpg`, pointing at `/var/www/msgschool/templates/agent/*`. Edits to the central copies propagate to every live user without re-provisioning.
4. Append the subscriber's info (name, Telegram id, provisioning timestamp) to the copied `USER.md`.
5. Add an **agent entry** to `/root/.openclaw/openclaw.json` under `agents.list[]` with `id: canvasagent-<tg_id>`, `workspace: <path>`, `model.primary` + `model.fallbacks` (inherited from `agents.defaults.model` unless overridden — see [Model-provider configuration](#model-provider-configuration)), `sandbox.workspaceAccess: rw`, and a narrowed tool allowlist (`read, write, edit, web_fetch, web_search, memory_*`).
6. Add a Telegram peer binding to `bindings[]` keyed on `{channel: "telegram", peer: {kind: "direct", id: "<tg_id>"}} → agentId: canvasagent-<tg_id>`.
7. Send `SIGUSR1` to the running gateway so it hot-reloads the config. No restart.

`scripts/deprovision.sh` is the exact inverse: archives the workspace under `/opt/msgschool/archived/<agent-id>-<ts>/`, removes the agent + binding from `openclaw.json`, `SIGUSR1`s the gateway.

### Per-user container layout (what EVERY user workspace contains)

```
/opt/msgschool/users/canvasagent-<tg_id>/
└── workspace/
    ├── PERSONA.md                         [copy]     platform prompt — scope, tone, /commands, credential-handling
    ├── USER.md                            [copy]     per-user facts agent updates over time
    ├── MEMORY.md                          [copy]     short rolling notes
    ├── SOUL.md                            [symlink]  mission + values
    ├── AGENTS.md                          [symlink]  workspace conventions / file index
    ├── TOOLS.md                           [symlink]  capabilities contract + integration instructions
    ├── SKYWARD_PLAYBOOK.md                [symlink]  authoritative Skyward scraping pattern (core skill)
    ├── CANVAS_PLAYBOOK.md                 [symlink]  Canvas equivalent (pending — file doesn't exist yet)
    ├── CANVAS_ACCESS_TOKEN_REFERENCE.jpg  [symlink]  screenshot shown during /connect canvas
    ├── credentials/
    │   ├── inbox.jsonl                    append-only capture of scrubbed credential pastes
    │   ├── canvas.json                    agent-maintained; written after agent sorts from inbox
    │   └── skyward.json                   same
    ├── memory/                            agent-managed dated notes (memory/2026-04-19.md etc.)
    └── logs/                              platform writes; agent doesn't touch
```

**Everyone gets the playbooks and our PERSONA/SOUL/TOOLS/AGENTS set.** When we update a symlinked file (SOUL, AGENTS, TOOLS, playbooks, reference images), every live user's workspace sees the change on next read, zero migration. When we update a copied file (PERSONA), the deploy step explicitly re-copies it into every existing workspace — I do this manually today; automation is a roadmap item.

### Agent sandboxing

Each user's OpenClaw agent entry has `sandbox.workspaceAccess: rw` scoped to `/opt/msgschool/users/canvasagent-<tg_id>/workspace`. Agent tools `read`/`write`/`edit` can touch anything inside that directory and nothing outside. Cross-user leakage isn't possible through the tool surface; the only shared state is the symlinked templates (read-only from the agent's perspective — writes would attempt to modify `/var/www/msgschool/templates/*` which is owned by `readystack` while the agent runs as `root` on the droplet; write would succeed but that's a platform-level concern, not a cross-user leak).

No OS-level containers (no Docker, no LXC) — isolation is filesystem+config-level only. The `agents.defaults.sandbox.docker` entry in `openclaw.json` is inherited configuration noise from OCMarketplace; per-agent override sets `sandbox.mode: off`.

## Dispatch (wired)

Inbound Telegram message for an **active** user:
1. msgschool webhook receives POST (`/api/bot/webhook`), validates shared-secret header, `queueMicrotask`s the handler and returns 200 immediately.
2. Handler runs credential detection first (see [Credential handling](#credential-handling) below). If credential-shaped, the platform short-circuits dispatch — encrypts, deletes the paste from Telegram, sends a receipt, notifies the agent of the *kind* of credential stored, returns. The agent never sees the raw value.
3. Otherwise, `handler.ts:dispatchActiveToAgent()` shells:
   ```bash
   openclaw agent \
     --agent canvasagent-<tg_id> \
     --to <tg_id> \
     --message "<text>" \
     --timeout 150 \
     --json
   ```
4. Gateway routes via the Telegram peer binding to the user's provisioned agent, runs a turn against the configured primary model (with automatic failover to listed fallbacks on overload or 5xx; current routing lives in `/root/.openclaw/openclaw.json` and is intentionally out of this doc to stay accurate across swaps), returns `{ runId, status, summary, result: { payloads: [{text}], meta: {...} } }`.
5. msgschool extracts reply text from `result.payloads[*].text` (fallback `result.meta.finalAssistantVisibleText`), sends to Telegram via our own `sendMessage` Bot API call.

Gateway's telegram channel is disabled (`channels.telegram.enabled: false`) — msgschool exclusively owns both directions of the Telegram wire. Agent never sees Bot-API tokens or webhooks.

## Model-provider configuration

The OpenClaw gateway is multi-provider. msgschool itself is **not** an LLM client — `handler.ts` shells out to `openclaw agent`, and the gateway picks the model based on its own configuration (`/root/.openclaw/openclaw.json` on the msgschool VM).

### Provider block (`models.providers`)

Each provider declares its OpenAI- or Anthropic-compatible endpoint, an API key, and the list of models it serves. We rotate the active set as the field evolves (and prices/quality move); the authoritative current set lives in `/root/.openclaw/openclaw.json` on the home VM. The schema:

```jsonc
"models": {
  "providers": {
    "<provider-key>": {
      "baseUrl": "https://api.example.com/v1",
      "apiKey":  "...",
      "api":     "openai-completions" | "anthropic-messages",
      "models":  [{ "id": "<model-id>", "name": "...", "contextWindow": ..., "maxTokens": ... }]
    }
  }
}
```

Provider keys are referenced from other config sections as `<provider>/<model-id>`. Adding a new provider is a JSON edit + key in `auth.profiles` + gateway hot-reload.

### Model selection (`agents.defaults.model`)

```jsonc
"agents": {
  "defaults": {
    "model": {
      "primary":   "<provider>/<model-id>",
      "fallbacks": ["<provider>/<model-id>", "..."]
    },
    "thinkingDefault": "off",
    "contextTokens":   100000,
    "compaction":      { "mode": "safeguard", "reserveTokensFloor": 20000 },
    "timeoutSeconds":  180
  }
}
```

- **`primary`** — what every agent calls by default.
- **`fallbacks`** — ordered list. The gateway falls over automatically when the primary is overloaded, returns 5xx, or trips one of the configured cooldowns. msgschool relies on this for reliability under provider hiccups.
- **`thinkingDefault`** — off in prod. Re-test per model bump (see `LLM_BEHAVIOR_MITIGATIONS.md` notes-for-future-you).
- **`compaction.safeguard`** — preserves a tail of the conversation while compacting older context to fit `contextTokens`.

### Per-agent override (`agents.list[*].model`)

A single agent can override the global default. Useful for A/B testing one user against a candidate model without flipping the whole fleet:

```jsonc
{
  "id":    "canvasagent-<tg_id>",
  "name":  "<display name>",
  "workspace": "/opt/msgschool/users/canvasagent-<tg_id>/workspace",
  "model": { "primary": "<provider>/<model-id>", "fallbacks": ["<provider>/<model-id>"] }
}
```

`scripts/switch-model.sh` updates **both** `agents.defaults.model.primary` AND every `canvasagent-*` agent's `model.primary`, keeping the global and per-agent settings synchronized. To override only one agent (A/B testing), edit that agent's entry directly and skip `switch-model.sh`.

### The hot-reload contract

The gateway watches `openclaw.json` and re-reads it on most changes (model, fallback, thinking). `switch-model.sh` bounces the gateway by default for belt-and-suspenders; `--no-bounce` trusts the watcher (faster, but risks silent drift on a malformed JSON edit). Provisioning (`provision.sh`) sends `SIGUSR1` for the same purpose.

### Adding a new provider — checklist

1. Add `models.providers.<key>` block with `baseUrl`, `apiKey`, `api`, and `models[]`.
2. Add `auth.profiles.<key>:default` block with `provider: <key>`, `mode: api_key`.
3. Decide deployment shape:
   - **Test only**: leave `agents.defaults.model.primary` alone. Use per-agent override on one canvasagent for A/B.
   - **Add as failover**: append `<key>/<model-id>` to `agents.defaults.model.fallbacks`.
   - **Switch primary**: run `scripts/switch-model.sh <key>/<model-id> off`.
4. Restart or hot-reload the gateway. Confirm `journalctl --user -u openclaw-gateway` is clean.

## Credential handling

The platform owns the credential lifecycle. The agent never sees a raw credential paste. The full spec is in [`docs/CREDENTIAL_CAPTURE_SPEC.md`](CREDENTIAL_CAPTURE_SPEC.md); the short version:

**Inbound.** Every active-user message goes through `detectCreds()` (`src/lib/bot/credential-detector.ts`). If the message looks credential-shaped, the platform short-circuits the normal dispatch path:

1. Encrypted-merge into the user's workspace (`mergeCreds()`, see below)
2. `deleteMessage` against Telegram to remove the paste from chat history
3. Send a tiny receipt (`🔐 Credentials identified — encrypting now…`)
4. Notify the agent via a `[SYSTEM]` event with the *kind* of credential stored — never the value

The DB log (`ms_messages.text`) stores `[scrubbed: <fields>]` instead of the raw paste, so platform logs never carry plaintext either.

The flag is `CREDENTIAL_CAPTURE` (`off | shadow | on`). Production runs `on`. `shadow` was used during the 2026-04-22 cutover to validate the classifier against real traffic.

**At rest.** `mergeCreds()` (`src/lib/bot/credential-store.ts`) encrypts the merged credential JSON with `systemd-creds encrypt --name=msgschool-<svc>-<tg>` and writes ciphertext to `<workspace>/credentials/<svc>.json.enc`. The decryption key is bound to the host kernel; an offline disk image holds only ciphertext.

Plaintext is published to a per-user tmpfs path (`/run/msgschool/<agent>/<svc>.json`) and `<workspace>/credentials/<svc>.json` is a symlink to it. The agent reads through the symlink for verification probes; the running tool daemon (`msgschool-toolsd`) reads from tmpfs directly. tmpfs is wiped on every boot.

**Outbound.** Every reply text from the agent runs through `scrubOutbound()` (`src/lib/toolsd/scrub.ts`) before reaching Telegram. Literal occurrences of any known credential string for that user are replaced with `[redacted]`. This is the defense-in-depth layer under the agent's behavioral discipline (PERSONA forbids echoing credentials, but the scrubber catches what slips).

**At-rest sweep.** `msgschool-credscan.timer` fires every 2 minutes and greps the workspace for plaintext occurrences of any user's known credentials, replacing with `[redacted-credscan]`. Catches anything that bypassed all three live layers and would otherwise persist on disk.

**Honest threat model.** This defends against offline disk/backup theft, errant agent echoes, and DB-log leakage. It does **not** defend against in-memory compromise of `msgschool-toolsd` or root on the running VM. Per-user OS-level UID isolation between the agent process and the credential daemon is on the roadmap (blocked on an OpenClaw setuid hook); today the isolation between agent and creds is behavioral (PERSONA rules + the four layers above), not structural.

## Browser tool requirements — load-bearing for the whole product

The agent uses OpenClaw's `browser` tool to hit Canvas REST with an `Authorization: Bearer` header (via `page.evaluate(fetch)`) and to drive the Skyward web portal per `SKYWARD_PLAYBOOK.md`. Two platform-level requirements MUST be in place or the tool silently times out with a Mac-flavored error (*"Restart OpenClaw.app menubar…"*) on every single call.

### 1. Chromium binary + system libraries

OpenClaw ships a bundled `playwright-core` but doesn't auto-install the chromium binary or its Linux shared-lib prerequisites. Required on a fresh droplet:

```bash
# chromium binary
cd /usr/lib/node_modules/openclaw/node_modules/playwright-core
PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright node cli.js install chromium

# shared libs (libatk-1.0, libxkbcommon, libasound, etc.)
PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright node cli.js install-deps chromium
```

### 2. Top-level `browser` block in `/root/.openclaw/openclaw.json`

Without this, OpenClaw has no idea what binary to launch and falls back to driving a desktop OpenClaw app — which doesn't exist on a headless droplet. **This was the root cause of every "browser tool unavailable" failure** before it got diagnosed.

```json
{
  "browser": {
    "enabled": true,
    "executablePath": "/root/.cache/ms-playwright/chromium_headless_shell-<rev>/chrome-headless-shell-linux64/chrome-headless-shell",
    "headless": true,
    "noSandbox": true,
    "defaultProfile": "openclaw"
  }
}
```

Reference: confirmed identical to a known-working chromium setup.

### 3. No per-agent sandbox / tools overrides

OCMarketplace's original `provision.sh` wrote `sandbox: {mode: off, ...}` and explicit `tools.allow / tools.deny` lists to each agent entry. Those overrides push OpenClaw into a code path that assumes a desktop app is available and breaks the `browser` tool on headless deploys. **Leave agent entries minimal** — just `{id, name, workspace, model}`. The gateway's built-in defaults cover everything else correctly.

Our `scripts/provision.sh` now writes only the minimum and includes a preflight that fails loudly if the `browser` block is missing from `openclaw.json`.

### The bootstrap script

`scripts/bootstrap-droplet.sh` idempotently does all of the above — run once on any new droplet (as root) before the first msgschool provision. Safe to re-run after an OpenClaw upgrade or if `openclaw.json` got reset.

## Content moderation (not yet wired)

Planned: port CleanRelay's `src/scanner.ts` — regex injection patterns, length cap, Unicode sanity. Placed between "active user sent something" and "invoke agent". Rejected inputs never reach the LLM. Not in scope for this initial scaffold.

## Access model

- Access is unlocked via a registration code. Current code: `FreeAgent2026` (configured in `.env` via `FREE_CODE`).
- Access window: **30 days** from redemption (`FREE_CODE_PERIOD_DAYS`).
- Billing: not yet in scope. Env var `PRICE_USD_PER_MONTH` is a placeholder only; nothing in the app references it.

## Infrastructure reuse

MsgSchool shares infrastructure with OCMarketplace rather than spinning up anything new:

- **Droplet:** Same `marketplace` DO droplet (`<droplet-ip>`) that serves `msgschool.com`. MsgSchool will run as a separate pm2 process on a different port; nginx routes picked later (subdomain for beta, then a full cutover).
- **Postgres:** Same local Postgres on the droplet, same database (`msgschool`), same `public` schema. Our tables are prefixed `ms_` (`ms_users`, `ms_code_redemptions`, `ms_messages`) to avoid colliding with OCMarketplace's `users`, `messages`, etc. When OCM is retired, a single rename migration drops the prefix.
- **OpenClaw:** Same `/usr/bin/openclaw` daemon that OCM already uses. We invoke it at dispatch time with `--workspace` + `--to`; no per-user config entry.

Plan: run alongside OCMarketplace during beta. Once MsgSchool proves out and we want the `msgschool.com` apex for it, swap nginx over, turn off the OCM pm2 process, and eventually drop OCM's tables from `public`. MsgSchool data stays intact in `msgschool_v2`.

## Non-goals

- No web signup, no MsgSchool credentials, no email verification.
- No multi-agent routing (the marketplace's whole point; we don't need it here).
- No admin dashboard for v1 — admin tasks happen by direct DB query.
- No per-user daemon, container, or namespace. Workspace-level isolation only.

## Credentials and environment

- `DATABASE_URL` — Postgres.
- `TELEGRAM_BOT_TOKEN` — from @BotFather. Gate: bot is a no-op without this.
- `TELEGRAM_WEBHOOK_SECRET` — shared secret sent in `X-Telegram-Bot-Api-Secret-Token`.
- `FREE_CODE`, `FREE_CODE_PERIOD_DAYS` — the unlock code and its window.
- `USER_WORKSPACE_ROOT`, `PROVISION_SCRIPT` — provisioning paths.

See `.env.example`.

## Current status

### Done
- [x] Landing + privacy + terms pages
- [x] DB schema (`ms_users`, `ms_messages`, `ms_code_redemptions`, `ms_drizzle_migrations`) in shared `public` schema
- [x] Webhook entry (`/api/bot/webhook`), shared-secret auth, fire-and-forget dispatch
- [x] Onboarding state machine: new → provisioning → active → expired
- [x] Provision script (`provision.sh`) — full OCM-style pipeline: workspace create, seed copy, symlink platform skills, agent + binding in `openclaw.json`, gateway `SIGUSR1`
- [x] Deprovision script (inverse of provision)
- [x] Agent dispatch wired — `openclaw agent --json`, reply extracted from `result.payloads[*].text`, sent via our Bot API helper
- [x] PERSONA / SOUL / TOOLS / AGENTS scoped to Canvas+Skyward + high-school/college curriculum tutoring
- [x] 13 slash commands (`/help /commands /status /assignments /grades /compare /belowA /pathtoA /teacherspace /syllabusdrift /events /attendance /connect /reset`) with plain-English alternatives
- [x] `/help` surfaces the 10 most-asked parent pain-points
- [x] `/status` includes the Venmo donation + quarterly-drawing block
- [x] SKYWARD_PLAYBOOK.md embedded in every workspace (symlinked, sanitized)
- [x] CANVAS_ACCESS_TOKEN_REFERENCE.jpg embedded in every workspace (symlinked)
- [x] Platform-owned credential capture (`CREDENTIAL_CAPTURE=on`): inbound detector classifies, encrypts via `systemd-creds`, deletes paste from Telegram, sends receipt; agent never sees raw credentials. See `docs/CREDENTIAL_CAPTURE_SPEC.md`.
- [x] Encryption at rest for `credentials/*.json` — `*.json.enc` ciphertext on disk, plaintext only on per-user tmpfs, machine-bound key
- [x] Outbound credential scrubber — every agent reply runs through `scrubOutbound()` before reaching Telegram
- [x] At-rest credscan timer — fires every 2 min, greps the workspace for plaintext credential leaks, replaces with `[redacted-credscan]`
- [x] Full production cutover: `msgschool.com` → msgschool (port 3010 via nginx); OCMarketplace removed
- [x] OpenClaw upgraded to `2026.4.15` on the droplet
- [x] `browser` tool operational for agents (Chromium Headless Shell + system libs + `browser` block in openclaw.json); confirmed by navigating example.com + canyons.instructure.com/login/ldap
- [x] `scripts/bootstrap-droplet.sh` — idempotent one-time setup for any new droplet, documents the root cause so this doesn't get rediscovered
- [x] provision.sh hardened: preflight fails loudly if browser block is missing; no more per-agent sandbox/tools overrides (those caused the original outage)
- [x] Typing indicators during agent turns — user sees the dots instead of silence for 30-60s

### Roadmap (in rough priority order)

Open work items live in operator-internal notes; this section intentionally does not duplicate them. The remaining structural follow-ups visible in code are:

- **Per-user OS-level UID isolation** between agent and `msgschool-toolsd` — today the protection that keeps the agent from reading credential plaintext is behavioral; the structural version requires a setuid hook from OpenClaw upstream.
- **Off-host encrypted backup destination** — nightly age-encrypted backups currently rsync to a sibling host on the same LAN; a non-LAN destination is the next hardening step. Runbook at `docs/OFFHOST_BACKUP_RUNBOOK.md`.

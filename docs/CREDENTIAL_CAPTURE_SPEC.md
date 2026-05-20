# Platform-Owned Credential Capture — Specification

**Status:** implementation live in production with `CREDENTIAL_CAPTURE=on`. This spec is maintained as the architectural reference for the credential lifecycle.
**Scope:** inbound Telegram messages containing Canvas or Skyward credentials + at-rest encryption of the stored values.

## Why this exists

The previous credential handling flow had two distinct failure modes:

1. **Agent-cooperative scrubbing (early iteration).** Platform detected credential-shaped messages, deleted them from Telegram, wrote raw values to `credentials/inbox.jsonl`, nudged the agent via `[SYSTEM]` message to parse + sort. Failed because the model would redundantly echo values into its own replies, and the outbound scrubber's `[redacted]` replacement made legitimate replies unreadable.
2. **Pure pass-through (briefly, before the current implementation).** Platform did nothing. Agent received raw credential messages and wrote `credentials/*.json` itself. Failed because the agent (a) sometimes stumbled the parse (multi-field pastes, ambiguous format), (b) left the user's paste in Telegram chat history forever, (c) had to navigate strict PERSONA rules on what to echo back. The risk was always one bad model response from leaking.

The root issue in both: **the agent is in the hot path for a credential's lifecycle.** Any LLM in that hot path is a liability because it might echo, paraphrase, or describe the value.

**Proposed architecture: remove the agent from the hot path entirely.** Platform detects, writes to `credentials/*.json`, deletes from Telegram, sends a tiny receipt. Agent is notified via `[SYSTEM]` with the *kind* of credential stored, never the value. Agent reads `credentials/*.json` for verification probes and never receives the raw paste.

## Threat model

### What this prevents

- **Forever-in-chat credentials.** User's paste is deleted within ~1 second of receipt; Telegram retains only the deletion tombstone, not the content.
- **Agent-originated leaks.** Agent sees `[SYSTEM] canvas.token stored` — never the string itself. Can't echo what it doesn't have.
- **Agent parse stumbles.** Regex/field-classifier is deterministic code, not an LLM. Correctness is tested and auditable.
- **Race condition exposure.** The paste is visible in the user's chat history for the window between send and `deleteMessage`. We minimize but cannot eliminate. See "Inherent exposures" below.
- **Platform log leakage.** `ms_messages.text` stores `[scrubbed: canvas.token]`, not the raw value. Workspace log files never receive the raw paste.

### What this does NOT prevent

- **Physical screen recording** during the ~1s exposure window before delete. Out of scope.
- **Telegram server-side retention.** Telegram keeps deleted messages internally for an undocumented period; we rely on their claim that `deleteMessage` scrubs from both ends but cannot verify.
- **Compromise of the msgschool VM.** Anyone with root on the VM reads `credentials/*.json` and `/etc/msgschool/.env` directly. Out of scope; covered by `SECURITY.md`.
- **User pasting credentials into a different chat by mistake** (e.g., sending to a friend instead of the bot). Impossible to prevent from the bot side.

## What "credential-shaped" means (detection rules)

Detection runs **per inbound message, line-by-line** before any agent dispatch. Each line is classified independently. If ANY line matches, the whole message is treated as a credential paste and the full message is deleted.

### Pattern catalog (conservative set)

| Signal | Example | Classification confidence |
|---|---|---|
| Labeled prefix `<field>:` or `<field>=` followed by a value | `password: examplepass1` | HIGH — classified by label |
| Multi-line labeled block | `Username: jsmith001\nPassword: examplepass1` | HIGH — each line classified |
| Canvas host URL | `https://canyons.instructure.com` | MEDIUM — classified as `canvas.url` |
| Canvas LDAP URL | `https://canyons.instructure.com/login/ldap` | MEDIUM — classified as `canvas.login_url` |
| Skyward portal URL | `https://*/wsisa.dll/...` | HIGH — classified as `skyward.url` |
| Long opaque alphanumeric blob alone on a line | `1234~aBcDeF...` (60+ chars, `[A-Za-z0-9~_\-]` only) | HIGH — context-sensitive (see below) |
| Just a username-shaped string with context | `jsmith001` after an agent ask for Canvas username | MEDIUM — context-sensitive |

### Context-sensitive classification

A raw paste like `1234~aBcDeFxxx` (60 chars opaque) is high-confidence a CREDENTIAL, but the platform has to decide WHICH field it belongs to. Algorithm:

1. Look up the last `ms_messages.text` outbound row for this `telegram_user_id` within the last 10 minutes.
2. Scan that text for explicit asks: "your Canvas token", "Skyward username", "paste the password", etc.
3. Match the shape of the inbound value against the asked field's expected shape:
   - Token: 40+ chars, opaque, identifier-safe charset
   - URL: starts with `https://`, matches domain patterns
   - Username: no whitespace, typically alphanumeric + digits
   - Password: any non-whitespace characters, length >= 4
4. If shape + ask match → classify.
5. If shape matches no ask (e.g., agent last said "what's your name" but inbound looks like a token): classify as `unknown`, store in a pending slot, send user `⚠️ That looks like a credential but I didn't ask for one yet — I dropped it from chat. What is it? (code CRED0003)`.
6. If shape matches multiple possible fields (e.g., "examplepass1" could be password OR username): default to whichever the agent LAST asked for; if no recent ask, classify as `unknown`.

### Non-detection (must NOT fire)

- Plain prose containing the words "password" or "token" without a value (*"I forgot my password"*)
- URLs that aren't Canvas or Skyward portals (*"check out https://google.com"*)
- Short alphanumeric strings under 40 chars that could be a normal word
- Numeric-only strings (assignment IDs, phone numbers, etc.)
- Messages starting with `/` (slash commands) — always pass through untouched

## Field classification targets

The platform writes to one of these schema'd slots:

### `credentials/canvas.json`

```json
{
  "url":       "https://canyons.instructure.com",
  "login_url": "https://canyons.instructure.com/login/ldap",
  "username":  "jsmith001",
  "password":  "...",
  "token":     "1234~aBcDeF...",
  "school":    "<populated after first probe>",
  "district":  "<populated after first probe>",
  "student":   "<populated after first probe, from /users/self>",
  "stored_at": { "url": "ISO-8601", "username": "...", ... },
  "verified":  "<ISO-8601 from last successful probe, or null>"
}
```

### `credentials/skyward.json`

```json
{
  "url":      "https://student.canyonsdistrict.org/scripts/wsisa.dll/WService=wsEAplus/fwemnu01.w",
  "username": "JSMITH000",
  "password": "...",
  "stored_at": { "url": "...", "username": "...", "password": "..." },
  "verified": "<ISO-8601 or null>"
}
```

`stored_at` is a per-field timestamp, not a single "last write" — lets us detect stale fields. Existing fields are merged, not replaced wholesale, on a new paste.

## The write + delete ordering

Atomicity matters — we can't have the paste deleted but the write fail, or vice versa.

1. **Parse + validate.** Extract all fields from the message. Fail closed: if ANY field looks invalid (e.g., Canvas URL doesn't match `https://*.instructure.com`), reject the whole message with `CRED0002`.
2. **Write to tempfile.** `credentials/canvas.json.tmp-<uuid>` containing the merged new state.
3. **Atomic rename** tempfile → `credentials/canvas.json`. POSIX `rename(2)` guarantees atomicity within the same filesystem.
4. **Delete from Telegram.** `deleteMessage(chat_id, message_id)`. If this fails (48h+ old message, bot permission lost, transient API error), surface to the user as `CRED0004 — deletion failed, please delete manually`. Do NOT roll back the write; the paste is already in our storage and the user's chat, and rolling back doesn't reduce exposure.
5. **Log in `ms_messages`.** Inbound row has `text = [scrubbed: canvas.token,canvas.password]`.
6. **Send receipt.** Single terse line, see user-feedback section.
7. **Notify agent.** `[SYSTEM] User pasted canvas.token and canvas.password; I stored them in credentials/canvas.json. Missing fields: canvas.url, canvas.username. Readiness gate open. Run a probe once all 4 Canvas fields + 3 Skyward fields are present.`

If step 2-3 fails (disk full, workspace missing): send user `⚠️ Message lost — code CRED0001. Please resend and I'll try again.`, delete the original message anyway, don't notify the agent. User can retry immediately.

## User-facing messages (all messages terse)

| Event | Receipt |
|---|---|
| Field stored successfully | `📥 Stored canvas.token.` |
| Multiple fields stored from one paste | `📥 Stored canvas.username + canvas.password.` |
| Gate satisfied (all fields present) | `📥 Stored canvas.token. ✅ Canvas ready — verifying…` → followed by probe result |
| Full readiness reached | `📥 Stored skyward.password. ✅ All set — verifying…` → `✅ Connected as Sam Davenport. Try /pulse.` |
| Detection fired but couldn't classify | `⚠️ That looks like a credential but I can't tell what field. (code CRED0003) Please label it like "username: foo".` |
| Write failed | `⚠️ Message lost — code CRED0001. Please resend.` |
| Validation failed (malformed) | `⚠️ That doesn't look right — code CRED0002. Canvas URLs should look like https://<district>.instructure.com.` |
| Delete from Telegram failed | `📥 Stored canvas.token. ⚠️ I couldn't delete your paste from chat — please remove it manually. (code CRED0004)` |

No cryptic stack traces. No agent voice. Platform's own terse style. Error codes are stable and grep-able for post-hoc debugging.

## Agent notification schema

After every credential storage event, the platform dispatches a `[SYSTEM]` message to the agent. This is NOT a normal user turn — the agent receives it, produces a reply, and the reply goes to the user normally.

### `[SYSTEM]` envelope

```
[SYSTEM]
event: credential_stored
fields_stored: ["canvas.token", "canvas.password"]
canvas_fields_present: ["url", "username", "password", "token"]
canvas_fields_missing: []
skyward_fields_present: ["url", "username", "password"]
skyward_fields_missing: []
ready_for_probe: true
next_step: "Run the Canvas probe per CANVAS_PROBE_REFERENCE.json, then the Skyward probe per SKYWARD_PROBE_REFERENCE.json. Write state/ready.json when both succeed."
```

The agent sees `canvas.token` as the **field name**, not the value. It knows the field is populated. It reads the raw value only by opening `credentials/canvas.json` with its file-read tool — same path, no surprise.

### What the agent does on receipt

- If `ready_for_probe: true` → run the probe chain.
- If fields_missing is non-empty → reply to the user with the remaining ask (e.g., `"Got your Canvas password. Still need your Canvas URL, username, and API token. Paste them next."`). No re-asking of fields already present.
- Never echo the raw value. Never reference any part of the pasted content. Agent's only evidence the paste happened is the `[SYSTEM]` envelope.

## Corner cases

### Multi-field single paste

User pastes:
```
Canvas URL: https://canyons.instructure.com
Username: jsmith001
Password: examplepass1
Token: 1234~aBcDeF...
```

Platform parses all 4, writes all 4 to `credentials/canvas.json`, single `deleteMessage`, single receipt: `📥 Stored canvas.url + canvas.username + canvas.password + canvas.token.`

### Mixed Canvas + Skyward paste

User pastes a setup block covering both services. Each labeled line routes to its correct file. Both files updated, single atomic transaction across both. Receipt lists everything.

### User re-pastes to correct a typo

They paste the wrong password, see it stored, realize the mistake, paste again. Platform overwrites `credentials/canvas.json.password`, bumps `stored_at.password`, deletes the new paste. Agent gets a `[SYSTEM]` event with `fields_stored: [canvas.password]` (not a "re-store" signal). Agent's job to re-probe if the field changed after a previously-successful readiness.

### User pastes something credential-shaped but it's not a credential

E.g., they're copying a course URL that happens to contain `/courses/12345/assignments/67890`. That matches `*.instructure.com` → MEDIUM confidence canvas.url. Platform writes it to `canvas.json.url`, deletes, sends receipt. User goes `wait, that's my assignment link, not my Canvas URL` — they can repaste the correct value or say `/undo` to revert the last field change. (Bonus: `/undo` is cheap; platform keeps a per-field undo history of 5 values.)

### Paste during onboarding that the agent wasn't expecting

User jumps ahead: agent asks role/name, user pastes `token: 1234~aBc...`. High-confidence detection fires. Platform stores `canvas.token`, deletes, sends receipt, and agent's next message explains "I got your token early — still need Canvas URL, username, password + the role/name questions."

### Paste during `/pulse` or mid-conversation

Detection fires regardless of conversational state. Agent's current turn is interrupted: if the user was mid-conversation about homework and accidentally pastes a credential, the credential gets stored + deleted, and the agent's reply explains what happened and resumes.

### Paste that LOOKS like a credential but fails validation

`Canvas URL: foo.com` — not a `*.instructure.com` URL. CRED0002 fires. Original paste is deleted anyway (err on the side of delete-to-protect), nothing written, user sees `⚠️ CRED0002` and can re-paste.

### `deleteMessage` fails (48h window exceeded)

Shouldn't happen — deletion fires within seconds. But if bot loses permission or Telegram is flaky, the write succeeds and the user is told `⚠️ CRED0004 — I couldn't scrub it, please delete manually`. No auto-retry.

### Telegram edits the message

User sends a credential, then EDITS the message to fix a typo. `edited_message` arrives on the webhook. Platform re-detects, re-classifies, re-writes, `deleteMessage` on the edited message (same `message_id`). Single atomic refresh.

### Concurrent pastes from same user

User sends two credential messages in rapid succession (e.g., auto-fill split across two messages). Each inbound webhook runs through detect+write+delete serially per-user (platform uses a per-`telegram_user_id` async lock). No race on the JSON file. Receipts come in order.

### Telegram sends the webhook twice for the same update

Already idempotent via `update_id`: the handler skips any update whose `update_id` is already in `ms_messages`. If the write happened but `deleteMessage` didn't before the duplicate, the second pass finds the file already written, skips the write, tries delete again, then no-op the receipt.

### Agent is in the middle of a /pulse when the paste arrives

Agent turn and platform credential handling are in separate code paths. The agent's turn continues uninterrupted. The `[SYSTEM]` credential event gets queued for the agent's NEXT turn. Receipt is sent to the user immediately from the platform; agent doesn't see the paste at all during its current turn.

### User pastes the same credential twice intentionally

Detection fires twice. Both writes are idempotent (same value → no-op). Both receipts sent. No harm; confusing to the user. Optimization: if the field's existing value matches the new paste exactly, send `📥 canvas.token already stored, no change.` instead of `📥 Stored`.

### Agent bungles the probe after readiness

Not a credential-capture concern — readiness gate is what it is. Agent's probe failure is handled by the existing `CANVAS_PROBE_REFERENCE` + `SKYWARD_PROBE_REFERENCE` failure-signatures path.

### Sensitive info that ISN'T a credential (SSN, DOB, credit card)

Not detected by our patterns. Passes through normally to the agent. Out of scope — we don't accept those fields in any flow anyway, and if a user pastes their SSN into a Canvas-agent chat by mistake, that's a Telegram-hygiene problem not a msgschool problem.

## Write-path safety properties

- **Atomic updates.** Every write goes `tempfile → fsync → rename`. No partial writes.
- **Per-field undo buffer.** `credentials/canvas.json.undo/` holds the last 5 values of each field, each as `<field>.<timestamp>.jsonl`. `/undo <field>` restores the previous value. Pruned after 7 days.
- **No cross-user contamination.** Every write is scoped by `telegram_user_id → workspace path`. Path canonicalization prevents directory traversal via a creative paste.
- **File perms.** `credentials/*.json` mode 0600, owned by the user the msgschool service runs as (currently `root` after the EACCES fix).

## Migration plan — turning this on without breaking existing users

1. **Ship detection + write + delete + receipt behind a feature flag.** `CREDENTIAL_CAPTURE=off` by default; `CREDENTIAL_CAPTURE=on` enables the full pipeline.
2. **Shadow mode first.** With flag on, platform detects + logs what it WOULD have classified, but doesn't write, delete, or send receipts. Compare against agent-parsed credentials for 48h to validate the classifier.
3. **Flip to write-only.** Detection + write + delete enabled; agent still receives the raw paste too. Both sources of truth, platform's wins conflicts.
4. **Flip to authoritative.** Agent no longer receives the raw paste; `[SYSTEM]` notification is the only signal. PERSONA updated to reference platform-owned capture (remove "When the user sends credentials" section's parsing instructions).
5. **Remove agent parse logic from PERSONA.** Section shrinks to "Credentials arrive via `[SYSTEM]` events. Read `credentials/*.json` for values. Never quote."

Rollback at any step: flip the flag off, agent goes back to pure pass-through. No data loss because `credentials/*.json` is already the storage even in agent-parsed mode.

## Testing strategy

### Unit tests (new in `src/lib/bot/__tests__/creds.test.ts`)

- Detection: 20+ labeled/unlabeled inputs, assert correct classification + confidence.
- False positives: 15+ non-credential messages that should NOT fire (prose mentioning "password", URLs to non-Canvas sites, short alphanumeric strings).
- Multi-field paste parsing.
- Context-resolution: mock `ms_messages` with various outbound asks, verify field classification matches.
- Merge semantics: existing `credentials/canvas.json` + new partial paste = correct merged result.
- Path canonicalization: rejected paths containing `../`, null bytes, symlinks escaping the workspace.

### Integration tests (live against a disposable Telegram test account)

- Send each of the 12 canonical prompts from the Sonnet trial bank — verify detection, writes, deletion window (<5s from send to delete), receipts, agent `[SYSTEM]` notifications.
- Race conditions: two pastes within 50ms, one edit of a prior message, webhook replay.

### Smoke in production

First 48h after deploy: monitor `journalctl` for any `CRED000*` errors. If rate > 1/hour across both users, roll back via the feature flag.

## At-rest encryption (ADDED 2026-04-21 — was originally a non-goal)

Original spec deferred encryption at rest. That decision was revisited because the privacy policy says credentials are "stored encrypted" and we want that claim to be defensible. Design settled:

### Architecture

- **On disk (persistent):** `<workspace>/credentials/<svc>.json.enc` — ciphertext via `systemd-creds encrypt --name=msgschool-<svc>-<tgid>`. Machine-bound key managed by the host's `systemd-creds` subsystem (file key in `/var/lib/systemd/credential.secret` mode 0600, TPM-sealed if the VM has TPM passthrough). A disk image stolen while the VM is off contains only ciphertext.
- **In memory (tmpfs):** `/run/msgschool/canvasagent-<tgid>/<svc>.json` — plaintext on tmpfs (`/run` is already tmpfs on Ubuntu 24.04; 391MB free). Tmpfs is cleared on reboot by definition.
- **Agent-visible path:** `<workspace>/credentials/<svc>.json` — a symlink that points at the tmpfs plaintext. Agent's file-read tool resolves through the symlink and sees plaintext. Agent doesn't know encryption exists.
- **Startup hydration:** msgschool.service calls `ensureAllUsersHydrated()` on boot — walks `/opt/msgschool/users/canvasagent-*`, decrypts each `.enc` into tmpfs, refreshes the symlinks. Sub-second for ≤100 users.

### What this defends against

- **Offline disk reads.** A stolen disk image, a backup tarball, or an errant `find /opt -type f | xargs cat` sees ciphertext only. No decryption possible without the running kernel.
- **Backup leaks.** The backup script will exclude `/run` (tmpfs) and `/var/lib/systemd/credential.secret` (key material); only `.enc` files enter the backup. A backup operator who only has the tarball can't decrypt.
- **Accidental plaintext logging.** Nothing in the app ever has a plaintext credential on a persistent path — only tmpfs.

### What this does NOT defend against

- **A running-process compromise with the same privileges as the msgschool service.** Such a process can call `systemd-creds decrypt` itself. This is explicit and called out in the privacy policy's "Security work in progress" section — covered by `SECURITY.md` hardening (network isolation, OS patching, etc.), not by encryption.
- **A compromised host where the attacker has root.** Root can read both the key file and the ciphertext.

### Why this fits CREDENTIAL_CAPTURE (not a separate project)

The platform-owned write path introduced by this spec is the only path that writes to `credentials/*.json`. Adding encryption means a small change inside `credential-store.ts`: serialize JSON → `systemd-creds encrypt` → atomic rename of the `.enc` file → atomic rename of the tmpfs plaintext. Caller-facing API (`mergeCreds`, `readCreds`) unchanged. Agent codebase / PERSONA / playbooks unchanged.

### Concrete implementation (already staged in `src/lib/bot/credential-store.ts`, commit `b8c24ad`)

- `encryptToDisk(tgUserId, svc, plaintextBuffer)` — spawns `systemd-creds encrypt --name=msgschool-<svc>-<tgid>`, atomic-renames ciphertext into `credentials/<svc>.json.enc`.
- `decryptFromDisk(tgUserId, svc)` — spawns `systemd-creds decrypt --name=<same>` on the ciphertext, returns plaintext buffer.
- `publishPlaintext(tgUserId, svc, plaintextBuffer)` — atomic-writes plaintext to `/run/msgschool/.../<svc>.json`, ensures the workspace symlink.
- `ensureSymlink(tgUserId, svc)` — idempotent; handles migration from legacy regular-file layout.
- `ensureAllUsersHydrated()` — boot-time sweep. Must be called from the msgschool service entrypoint.
- `migrateLegacyPlaintextIfPresent(tgUserId, svc)` — one-time: reads an existing plaintext `<svc>.json`, encrypts to `.enc`, publishes plaintext to tmpfs, symlinks over the regular file.

### Migration of already-onboarded users

Before flipping `CREDENTIAL_CAPTURE=on`:

1. `ensureAllUsersHydrated()` runs on service start — no-op for users without any `.enc` file yet.
2. One-shot `scripts/migrate-credentials-to-encrypted.sh` invokes `migrateLegacyPlaintextIfPresent(tg, svc)` for each existing agent's `canvas.json` + `skyward.json`. After it runs, every user is on the encrypted + tmpfs layout.
3. The original plaintext files are replaced in-place by symlinks; no data loss; user experience is identical.

## What we're NOT building (deliberate non-goals)

- **Key rotation automation.** When a user's Canvas token expires, they re-paste. The platform overwrites and triggers a re-probe. No scheduled rotation.
- **Shared credential store.** Per-user workspaces only. If two users happen to use the same school district, their credentials don't share — they each paste their own.
- **Account linking / SSO.** User pastes raw creds; we don't auth-through to the school district's SSO on their behalf outside what the `browser` tool does for a specific probe.
- **Multi-device detection.** Telegram userID is the identity. If the same user paste from phone and laptop, they both hit the same Telegram user → same workspace → same file.

## Open questions to resolve before implementation

1. **Confirm OpenAI/Anthropic `[SYSTEM]` message handling.** Both models accept system-role messages mid-conversation; verify OpenClaw's gateway passes them through verbatim to the model and the model's next turn references them correctly. Test before implementation.
2. **Telegram `deleteMessage` latency floor.** Current measurements show ~300-800ms from `deleteMessage` API call to removal on the user's client. Does this meet our "~1 second exposure" target? Probably yes but measure in shadow mode before committing.
3. **`/undo` command scope.** Is this user-triggered only, or does the platform offer "last action can be undone for 60 seconds via reply CRED0005"? First version: just `/undo <field>`; we can add a timed-soft-undo later if needed.
4. **CRED000* code stability.** Codes become part of the user interface. Once documented, don't renumber them. Current proposed list:
   - `CRED0001`: write failed
   - `CRED0002`: validation failed / malformed value
   - `CRED0003`: detected but can't classify
   - `CRED0004`: deletion failed after storage
   - `CRED0005`: reserved (soft-undo window)
   - `CRED0010+`: reserved for future error modes

## Implementation rough order (for tomorrow)

1. `src/lib/bot/credential-detector.ts` — detection regex + classifier with confidence scores.
2. `src/lib/bot/credential-store.ts` — read/merge/atomic-write/`undo` buffer.
3. `src/lib/bot/handler.ts` — wire detection at the top of `handleUpdate` behind `CREDENTIAL_CAPTURE` env var; deletion + receipt + `[SYSTEM]` notification.
4. Unit tests for detector + store.
5. Shadow mode deploy: flag on, pipeline logs-only.
6. Compare 24h of shadow logs against agent-written `credentials/*.json`.
7. Flip to authoritative; update PERSONA to drop the parsing instructions.
8. Smoke monitor 48h, then lock the flag ON in the default env.

Estimated total: 4-6 hours of focused coding + 48h passive shadow observation before final cutover.

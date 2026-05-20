# MsgSchool — Engineering Roadmap

_Last updated: 2026-05-19. Open engineering work items. Status: 🔴 blocked · 🟡 in progress · ⚪ not started._

## Recently shipped (context)

- **Agent LLM migrated** to a self-hosted local model, with the prior hosted model retained as an automatic fallback.
- **Agent instruction set rebuilt** for the `toolsd` / `ms_call` model — `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md` rewritten lean and `toolsd`-native; stale `browser`/Playwright guidance dropped; the unread `PERSONA.md` retired.
- **Injection bug fixed** — workspace instruction files were symlinks the gateway read as missing, so agents ran with no instructions; they are now real-file copies, and `provision.sh` copies (not symlinks) for new users.
- **`toolsd` `pulse.combined` join** — Canvas↔Skyward course pairing is now done deterministically in `toolsd` (`reconcile.ts`) instead of left to fragile name-matching by the agent.
- **Slow-`ms_call` handling** — the agent is instructed to run `pulse.combined` / `skyward.*` once with a 90 s shell timeout (no poll / re-fire thrash).

## Open work

### 🔴 Skyward — blocked on the district

**S1 — Skyward portal down at the source (district-side).**
The old Skyward SMS portal (`wsisa.dll` Family/Student Access) is unreachable: the app accepts TCP then never responds — confirmed from every network tested (production VM, an unrelated external network, and a human desktop browser). The web host is up; the `wsisa.dll` application behind it is dark. The district is upgrading to **Skyward Qmlativ** for 2026-2027 — this is plausibly the migration cutover. Not fixable from our side. **Action:** confirm with the district whether this is a planned cutover and get an ETA. While it is down, the agent correctly reports "Skyward not available"; Canvas is unaffected.

**S2 — Rewrite `toolsd/skyward.ts` for Skyward Qmlativ.** _(blocked by S1)_
The current Skyward scraper is built entirely for the old SMS app (`#login`, the `cbs`/`tryLogin` popup flow, `a[id="showGradeInfo"]`). Qmlativ is a different web application — different DOM, login flow, and URLs. When the Qmlativ portal is live and reachable, `skyward.ts` needs a full rewrite; stored Skyward credential URLs will also need updating.

**S3 — `toolsd`: add `skyward.get_assignments_for_term`.** _(folds into S2)_
Skyward tools currently return only the overall letter grade per term, not per-assignment detail. Add per-assignment extraction — best done as part of the Qmlativ rewrite (S2), not against the dead SMS portal.

### ⚪ toolsd & agent quality

**T1 — `toolsd` Canvas expansion: `created_at`, `syllabus_body`, calendar events.**
Several agent commands lost their data backing in the `toolsd` migration — `toolsd`'s tool surface is narrower than the raw Canvas API the agent previously reached. Add: assignment `created_at` (unblocks `/pulse` §1 schedule-drift), `syllabus_body` via `?include[]=syllabus_body` on the course fetch (unblocks `/makeuprules`, `/pulse` §4 make-up rules, `/syllabusdrift`), and a calendar/events tool wrapping `/api/v1/users/self/upcoming_events` (unblocks `/events`). All read-only Canvas REST, documented in the Canvas playbook, ~1 h of work. Until done, those commands honestly return "(not available from current data)".

**T2 — Verify slow-`ms_call` handling.** 🟡
The 90 s-timeout instruction is deployed. Needs a live `/pulse` confirming the agent calls `pulse.combined` exactly once with no background / re-fire thrash. A full end-to-end check is partly gated on Skyward being reachable (S1), but the single-call behavior is verifiable on the Canvas half now.

### ⚪ platform correctness & hardening

**P1 — Fix `/reset`.**
`/reset` rotates the per-user session nonce, but the gateway ignores the rotated session id and keeps appending to the agent's original session — so `/reset` is currently a silent no-op and conversation history never clears. Fix: clear the agent's session at the gateway level (the way `deprovision.sh` does) instead of rotating a nonce the gateway does not honor.

**P2 — Gateway / `toolsd` UID separation.**
Per `TOOLSD_SPEC.md`, credentials should be structurally unreadable to the agent process — the threat model assumes separate UIDs for the agent and `toolsd`. The v1 deployment runs both as root, so today only behavioral redirection + audit logging + caching are delivered, not the structural guarantee. Achievable step short of full per-agent isolation: run the gateway as a non-root user and `toolsd` under its own service account, with credentials owned by that account. This is a real UID/permissions migration — sequence it as a deliberate, separate change.

### ⚪ housekeeping

**H1 — Bookkeeping.**
Commit the recent agent-template / instruction-set changes, and regenerate `architecture.json` to reflect current services, the `toolsd` tool surface, and the agent-model state.

---

## Dependency notes

- **S2 → S1**: the Qmlativ rewrite cannot start until the new portal is live and accessible.
- **S3 → S2**: per-assignment Skyward extraction should be built as part of the Qmlativ rewrite.
- **T2** is the verification step for the already-deployed slow-`ms_call` fix.

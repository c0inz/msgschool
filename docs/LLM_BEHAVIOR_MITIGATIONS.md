# LLM Behavior Mitigations

The two recurring failure modes we've seen across LLMs running msgschool agents:

1. **Tool-usage aggressiveness** — agent improvises tool calls, narrates internal state, hallucinates failures.
2. **Misreading data** — agent pulls Canvas/Skyward data correctly but aligns it incorrectly (e.g. wrong grade attached to wrong course).

This document catalogues every mitigation already shipped, plus the gaps still open. File/line references are to the canonical workspace templates under `templates/agent/`.

---

## Tool-usage aggressiveness — what we've done

### 1. Hard readiness gate (`state/ready.json`)

The agent literally cannot run `/pulse` or `/grades` until both probes succeed. `AGENTS.md` and `PERSONA.md` both refuse data commands until the gate file exists. This stops the LLM from "let me just try Canvas anyway" improvising before credentials are sane.

### 2. One reply per turn — narration banned

`AGENTS.md` lines 168–185 enumerates forbidden patterns by example: *"On it — pulling the pulse now"*, *"Let me try a different approach"*, *"The page is redirecting…"*. Combined with `extractReplyText` in `provision.ts` preferring `meta.finalAssistantVisibleText` then last-payload-only (commit `21ee08c`), the user sees one Telegram message at the end, not the play-by-play. **This was the biggest behavioral lever.**

### 3. Probe sequence is fixed and numbered, not free-form

- **Canvas:** 4 explicit GETs in fixed order (`/users/self` → `courses` → `modules` → `course?include[]=syllabus_body`). The agent doesn't get to invent its own exploration.
- **Skyward:** 5 explicit Playwright steps with the exact selectors (`#login`, `cbs('bLogin')`, `a[id="showGradeInfo"]`).
- Both reference files (`CANVAS_PROBE_REFERENCE.json`, `SKYWARD_PROBE_REFERENCE.json`) hold the canonical request/response shapes so the LLM doesn't have to "figure out" the API every time.

### 4. Anti-pattern catchers

`AGENTS.md` line 142 literally calls out: *"if you're about to say 'this appears to be a direct script endpoint' or 'the portal seems to be blocking automated browser sessions', stop. You haven't read the playbook."* These are the exact hallucinations Sonnet kept reaching for; we caught them by name.

### 5. Honest failure reporting

`AGENTS.md` lines 156–166 lists tells of hallucination (*"seems to be"*, *"appears to"*, *"let me try a different approach"*) and forces the agent to either quote the real tool error or say *"the tool returned a generic failure without a specific error — want me to retry?"*

### 6. `thinkingDefault: off` + immediate failover

Per `scripts/bootstrap-droplet.sh` line 91, we flipped Sonnet thinking off — turns out for this narrow task the thinking budget was making the agent *more* speculative, not less. Combined with `auth.cooldowns.overloadedProfileRotations: 0` so a hung primary call falls over to the configured fallback instantly.

### 7. Drift doctrine elevated, not buried

`SOUL.md` line 13 and `AGENTS.md` lines 38–47 define the four drift patterns precisely (with thresholds: ≤2 day created→due gap, >10 day grade lag, etc.) so the agent stops *inventing* drift to look insightful and only flags it when the math actually triggers.

---

## Misreading data (course↔grade misalignment) — what we've done

### 1. Position-based matching with row-anchored fallback

`SKYWARD_PLAYBOOK.md` lines 173–179 calls out the exact bug — *"Math 3 shows an F but it's actually Spanish 2 that has the F"*. Root cause documented: invisible DOM rows throw off `array[i]` matching. Solution documented: row-anchored extraction (Method 2) or verify both lists have the same length before zipping.

### 2. Skyward primary-key is `data-gid`, not order

`AGENTS.md` lines 124–128 codifies that each `a[id="showGradeInfo"]` carries `data-gid` (course id), `data-lit` (term), `data-bkt` (bucket), `innerText` (grade). The agent is supposed to pull the grade *and* its identifying data attributes from the same element, not from sibling elements parsed separately. That eliminates most of the misalignment risk.

### 3. Term verification before reporting grade detail

`SKYWARD_PLAYBOOK.md` lines 181–199 covers Skyward reusing modal dialogs across term clicks. Solution documented: read `dialog.innerText` and bail with `ERROR: Dialog shows wrong term` if `Q4 Progress Report` isn't in the text. This is exactly the "I clicked Q4 but parsed Q3" misread.

### 4. Canvas course code carries grade level

`AGENTS.md` line 85: Canyons course codes are `"SUBJECT LEVEL-TEACHERLASTNAME"`, e.g. `"LANGUAGE ARTS 10-BRANNAN"` — the digit IS the grade level. Explicit instruction: *"if you catch yourself asking 'what grade is X in' AFTER successfully pulling the course list, stop, it's in the data."* Stops the agent from re-asking the user for facts that are sitting in the JSON it already fetched.

### 5. Skyward = system of record for final grade; Canvas = day-to-day

`AGENTS.md` line 44 codifies which side wins when the two disagree. Includes the `days_until_period_end` rule — early in a period a gap is expected, late in a period it's critical. This stops the agent from confidently presenting one number when both exist and differ.

### 6. Probe-reference JSONs are loaded explicitly during probe

Each probe-reference has the literal expected response schema with field names. The agent matches what it sees against the schema rather than guessing field names — which is where most "course mapped to wrong grade" confusion originates.

---

## Where we still have exposure

These are the gaps that map to the two failure modes above:

### A. No structural-equality check before zipping courses↔grades

We document the bug, but there's no programmatic *"if `courses.length !== grades.length`, abort with explicit error"*. Some LLMs would still zip a 7-course list with a 6-grade list and silently misalign by one. **Fix:** a 3-line addition to `SKYWARD_PLAYBOOK.md` Method 2: *"Verify lengths match before pairing; if not, fall back to row-anchored extraction."* (~30 minutes.)

### B. No explicit Canvas↔Skyward course-name normalization rule

Canvas course names and Skyward course names don't match strings (`"LANGUAGE ARTS 10-BRANNAN"` vs `"Language Arts 10"`). When the agent reconciles grades across both systems, it's currently doing fuzzy matching by feel. **Fix:** documented normalization (lowercase, strip teacher suffix, strip period numbers, strip leading/trailing whitespace) in `AGENTS.md` so it's deterministic. (~30 minutes.)

### C. No tool-call budget per turn

The agent can theoretically make 30+ browser calls in a single `/pulse`. We don't cap it. This is the agentic-loop-bloat issue from the cost analysis — also a tool-aggressiveness vector. **Fix:** real OpenClaw-config-or-PERSONA constraint that needs more thought; not a 30-minute patch.

---

## Notes for future-you

- The biggest behavioral lever turned out to be **suppressing narration** (mitigation #2 above) — not better prompting. If a new model regresses on tool aggressiveness, check `extractReplyText` first, prompt-engineering second.
- `thinkingDefault: off` was counter-intuitive but real. Re-test with each model bump (`high` worked fine on earlier Sonnet revs; on 4.6 it added 10–60s and made the agent more speculative).
- All mitigations are documentation-shaped (PERSONA + AGENTS + playbooks). The agent reads these every turn via the auto-load pattern, so changes propagate without redeploys — but they only propagate to *new* containers unless we re-template existing ones. Keep that in mind when rolling out a fix.

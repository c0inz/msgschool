# TOOLS — MsgSchool Agent

## Available tools (allowed)

- `read`, `write`, `edit` — scoped to this workspace only (`USER.md`, `MEMORY.md`, files under `memory/`, `state/`, `credentials/`, `logs/`).
- `browser` — **your primary tool for Canvas and Skyward data.** Chromium via Playwright. Use it to: (a) hit Canvas REST with `Authorization: Bearer` via page-context `fetch()` or request interception, (b) drive the Skyward login per `SKYWARD_PLAYBOOK.md`, (c) extract HTML/markdown from pages that `web_fetch` can't reach.
- `web_fetch` — **public pages only; no custom headers.** Schema is `{url, extractMode, maxChars}`. Useful for district policy pages, general web content. Do NOT attempt to use for Canvas/Skyward auth — it cannot carry a token.
- `web_search` — for looking up school-policy context the user asks about (e.g. "what does 'late work policy' mean at my school").
- `memory_search`, `memory_get` — your own notes from previous wake-ups.

## Denied tools (do not try to invoke)

- `exec` / shell — you have no reason to run arbitrary commands; use `browser` for everything that looks like "I need to curl this."
- `canvas` / `nodes` — unrelated to Canvas LMS; these are OpenClaw's document-canvas + compute-nodes surfaces.
- `gateway` / `cron` / `message` — you do not configure the platform.
- `sessions_spawn` / `sessions_send` — you do not talk to other agents.

## Credentials arrive as regular chat messages

When a user pastes a Canvas URL, token, Skyward URL, username, or password, it comes through as a normal message (msgschool does not auto-delete or scrub). Read the message, parse it, and store what you need in `credentials/canvas.json` or `credentials/skyward.json`. If a user asks whether it's safe to paste credentials in Telegram, be honest: the paste sits in their chat history like any other message — they can delete it from their side if they prefer, but msgschool does not do it for them.

## Text-only wire — no media sending

msgschool's Telegram integration is `sendMessage` only. You cannot send photos, files, voice notes, or documents. `CANVAS_ACCESS_TOKEN_REFERENCE.jpg` is available for YOUR OWN use (read it to describe the UI accurately), but you cannot transmit it to the user. If a user seems confused about where a button is, describe it precisely in text — don't promise a screenshot.

## Canvas integration (user-supplied token)

When the user says `canvas`:
1. Ask for their school's Canvas URL (e.g. `https://myschool.instructure.com`).
2. Walk them to the token page — Canvas → **Account** (left sidebar) → **Settings** → scroll to **Approved Integrations** → click **+ New Access Token**. A visual reference is in this workspace at `CANVAS_ACCESS_TOKEN_REFERENCE.jpg` — if the user is confused about where the button is, send them the image.
3. Ask them to name the token (suggest `MsgSchool`), leave expiry blank (Canvas labels "never"), generate, and paste the token string into the chat.
4. Store the URL + token in `credentials/canvas.json` inside this workspace.
5. Confirm the connection by hitting `GET /api/v1/users/self` on the Canvas URL with the token. Report the name Canvas returns so the user confirms it's the right account.
6. From then on, use that token for all read-only Canvas calls. Never submit coursework.

## Skyward integration (user-supplied credentials)

When the user says `skyward`:
1. Ask for their district's Skyward portal URL and username + password. Skyward URLs are long district-specific strings — **show the Canyons example when asking** so the user knows what to copy from their bookmark or browser address bar: `https://student.canyonsdistrict.org/scripts/wsisa.dll/WService=wsEAplus/fwemnu01.w`.
2. Store in `credentials/skyward.json` (workspace-scoped).
3. Note that Skyward has no public API — you'll use careful HTTP against the portal on wake-ups. Do not attempt to scrape during onboarding conversation; just store and confirm.

### ⚠️ Before you scrape Skyward, read `SKYWARD_PLAYBOOK.md`

Skyward scraping is notoriously brittle (nested tables, JavaScript-rendered grades, district-specific login flows, popups). **The playbook is authoritative.** It contains the working pattern for at least one district (Canyons) and the general approach: Playwright with headless Chromium, capturing the post-login popup page, navigating to Gradebook, extracting via stable DOM anchors.

When you need to pull grades/attendance/assignments from Skyward:
1. Read `SKYWARD_PLAYBOOK.md` end-to-end.
2. Load the user's credentials from `credentials/skyward.json`.
3. Start from the playbook's working example and adapt only where the user's district actually differs.
4. If your attempt fails, diff what you found against the playbook and either fix your code or append a new "Working Pattern: [District Name]" section to the playbook (via platform edit, not runtime) so future agents benefit.

### Canvas integration — playbook pending

A `CANVAS_PLAYBOOK.md` will appear in this workspace once we write one. Canvas is easier than Skyward (real REST API at `/api/v1/`) but quirks still exist (per-district gradebook schemes, weighting, late-work policies). Until the playbook lands, use the Canvas LMS REST API directly with the user's personal access token.

## Outbound messaging

- You reach the user via the platform's Telegram channel. The gateway handles delivery; you just produce the text. Do not hand-construct Telegram API calls.
- Keep each message under ~300 words for Telegram readability.

## Persistence

- Your notes about the user (preferences, child names, schedule quirks) go in `memory/` inside this workspace. Write them as short dated notes. They're how "future you" remembers things across wake-ups.
- Never write outside this workspace.

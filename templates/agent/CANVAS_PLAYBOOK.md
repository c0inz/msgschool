# Canvas LMS Playbook

## ⚠️ HARD RULES — read these first, they override everything below

**You no longer fetch Canvas data by writing a script. The platform owns
that.** Use `ms_call` for every Canvas data read. The legacy "how to
scrape" sections later in this file are kept only as a fallback reference
for when you onboard a brand-new district that the platform hasn't
mapped yet — for Canyons, Jordan, and any other district the platform
already supports, you do not write JavaScript and you do not call
`fetch` against `instructure.com`.

### What you must do

- **Use `ms_call <tool> '<json>'`** to read Canvas data. Examples:
  ```
  ms_call canvas.list_courses '{}'
  ms_call canvas.list_assignments '{"course_id": 12345}'
  ms_call canvas.list_missing '{}'
  ms_call canvas.get_pulse '{}'
  ms_call canvas.connectivity_probe '{}'
  ```
- **`pulse.combined`** is the right call for almost every "what's going
  on" question — it bundles Canvas + Skyward in one shot:
  ```
  ms_call pulse.combined '{}'
  ```
- The response is JSON on stdout. Parse and present.

### What you must NEVER do

- **Never write a `.js` / `.mjs` / `.ts` file that contains a Canvas
  token, a Skyward password, a username, a school URL, or any other
  credential value.** Not as a string literal. Not as a `const`. Not
  inside a template string. The platform forbids this and will redact
  the value before any reply you compose actually reaches the user, but
  the file will still exist on disk and that's a leak.
- **Never read `credentials/canvas.json`** directly. The file does not
  belong in your reasoning loop. `ms_call` is the only legitimate path.
- **Never echo the user's Canvas token, Skyward password, or Skyward
  username into a Telegram reply** — even partially, even hashed, even
  "the last 4". The user already pasted it once; they don't need to see
  it again.
- **Never call `fetch(... instructure.com ...)`** directly. The whole
  reason this rule exists is that doing so requires you to hold the
  token in memory, which means the token can land in a script file or
  a chat reply.

### What if `ms_call` fails?

Tell the user the system is having trouble with their data right now,
ask them to try again in a few minutes, and stop. Do **not** fall back
to writing a script that reads `credentials/*.json` — that's the
behavior we're trying to eliminate.

The detailed scraping notes that follow are reference material for the
*platform team*, not a how-to for you. They exist so the platform
maintainers can keep the tool implementations working when Canvas
changes its UI. Your job is to call the tool.

---

## 0. Onboarding — getting Canvas API access from the user

**Always start by asking the user whether they have a Canvas Personal Access Token.** Most don't.

If they don't, walk them through generating one. The instant you sense confusion about where the button is (hesitation, wrong screen described, "I can't find settings"), **attach `CANVAS_ACCESS_TOKEN_REFERENCE.jpg` from this workspace and send it to them in-chat.** The image shows the exact Canyons-district Canvas page with the `+ New Access Token` button circled implicitly by its placement. Don't wait for the user to ask — proactively send the screenshot the first time they seem stuck.

### Whose credentials to use

Generate the token from the **student's Canvas account**. Parents already have their student's sign-on from district enrollment — there's no need to bring the student into the setup. Tell the parent directly: *"Sign in to Canvas with your student's credentials and follow these steps."*

Heads-up for the parent: most school districts only expose the Canvas API surface on student accounts, so even if they have their own parent/observer login, the access token still needs to come from the student side. It's a district policy thing, not a workaround.

If the user IS the student asking on their own behalf, the script is the same — they sign in with their own credentials.

### Step-by-step script (desktop OR mobile app — the path is the same)

Canvas's navigation is identical in the browser and the iOS/Android app. Tell the user to use whichever they're already signed into.

1. *"Sign in to Canvas using your **student's credentials** — desktop browser or the Canvas Student app, whichever you prefer."*
2. *"Tap/click your profile picture (the **Account** icon — top-left on desktop, bottom nav on mobile) → **Settings**."*
3. *"Scroll down to **Approved Integrations** — I'll send you a screenshot of that page."*  ← **send `CANVAS_ACCESS_TOKEN_REFERENCE.jpg` here**
4. *"Tap **+ New Access Token**."*
5. *"Name it `MsgSchool`, leave expiry blank, tap **Generate Token**."*
6. *"Copy the long string that appears and paste it here. Don't worry — I auto-delete credential messages from chat within a second."*

The last line is load-bearing — it relieves the user's anxiety about pasting a secret into a chat. The platform (msgschool) actually does auto-scrub labelled credentials and Canvas URLs; tell the user so they don't feel like they're leaking something. See the credential delete-on-receipt section in `PERSONA.md`.

**Canvas URL separately:** you need the district's subdomain — e.g. `https://canyons.instructure.com` for Canyons. Ask before or after the token, it doesn't matter. Store the final shape at `credentials/canvas.json`:

```json
{ "url": "https://canyons.instructure.com", "token": "<PAT>" }
```

Verify by calling `GET /api/v1/users/self` with `Authorization: Bearer <token>`. If it returns the user's name/email, you're connected.

---

## 1. Login — what works

### LDAP-backed districts (Canyons is one)

```
URL:  https://<district>.instructure.com/login/ldap
Method: standard HTML form POST; no popups, no SSO redirect juggling.
```

Form fields:
- `input[name="pseudonym_session[unique_id]"]` — username
- `input[name="pseudonym_session[password]"]` — password
- `button[type="submit"]` — submit

Minimum-viable Playwright login:

```javascript
import { chromium } from 'playwright';

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const context = await browser.newContext({
  javaScriptEnabled: true,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0',
  viewport: { width: 1366, height: 900 },
});
const page = await context.newPage();

await page.goto('https://canyons.instructure.com/login/ldap', {
  waitUntil: 'networkidle',
  timeout: 30000,
});
await page.fill('#pseudonym_session_unique_id', '<from credentials/canvas.json>');
await page.fill('#pseudonym_session_password', '<from credentials/canvas.json>');

await Promise.all([
  page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {}),
  page.click('button[type="submit"]'),
]);
```

**NO popup trick needed.** Unlike Skyward (which opens a new window after login), Canvas LDAP uses a single-page redirect. If a Canvas login ever *does* require popup capture on a different district, use the same pattern from `SKYWARD_PLAYBOOK.md`: `Promise.all([context.waitForEvent('page'), click()])`.

### Persisting the session

Save storage state once, reuse for all subsequent scripts. Avoids re-login per turn:

```javascript
await context.storageState({ path: '/tmp/canvas/state.json' });
// later:
const context = await browser.newContext({ storageState: '/tmp/canvas/state.json' });
```

Session cookies last ~30 days on Canyons. When `api/v1/users/self` returns 401, re-log in.

---

## 2. REST API — what's accessible as a STUDENT

Canvas has a rich REST API at `https://<district>.instructure.com/api/v1/`. Auth is via session cookie (if you logged in with Playwright) or `Authorization: Bearer <PAT>` (Personal Access Token generated from Settings → Approved Integrations — see `CANVAS_ACCESS_TOKEN_REFERENCE.jpg` for the UI).

### Making authenticated calls with the `browser` tool (this is the path you have)

`web_fetch` does NOT support custom headers — do not try to use it for authenticated API calls. Use `browser`:

```javascript
// 1. Open any Canvas page to get a real browser context.
await page.goto('https://<district>.instructure.com/login/ldap', {waitUntil:'networkidle'});
// (If not logged in via session, you can still fire API calls with the token alone —
//  Canvas accepts Bearer auth without a session cookie.)

// 2. Fire the authenticated API call from within the page context.
const courses = await page.evaluate(async (token) => {
  const r = await fetch('/api/v1/courses?per_page=100&enrollment_state=active', {
    headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
  });
  return { status: r.status, data: await r.json() };
}, TOKEN_FROM_CREDENTIALS_JSON);

if (courses.status !== 200) { /* handle 401/403 */ }
console.log(`Got ${courses.data.length} courses`);
```

Alternate pattern: `page.request.get(url, { headers: { Authorization: `Bearer ${token}` } })` — Playwright's request API accepts arbitrary headers and shares cookies with the page.

Either way, `token` comes from `credentials/canvas.json` via your `read` tool. **Never print the token.** Log only the request URL, response status, and count of returned objects.

### What students CAN read

| Endpoint | Purpose | Notes |
|---|---|---|
| `GET /api/v1/users/self` | sanity-check auth | fastest way to verify a session is live |
| `GET /api/v1/courses?per_page=100&enrollment_state=active` | list enrolled courses | returns `id`, `name`, `course_code`, `enrollment_term_id` |
| `GET /api/v1/courses/:id?include[]=syllabus_body` | syllabus HTML | many teachers leave this empty; check length before relying on it |
| `GET /api/v1/courses/:id/modules?include[]=items&per_page=50` | module tree + items | **primary curriculum structure** — see §4 |
| `GET /api/v1/courses/:id/assignments?per_page=100&order_by=due_at` | assignments + due dates | **primary source of truth for "what's due"** |
| `GET /api/v1/courses/:id/assignments/:aid/submissions/self` | own submission status | grade + score + workflow_state |
| `GET /api/v1/users/self/missing_submissions` | everything past due and ungraded | cross-course |
| `GET /api/v1/users/self/upcoming_events` | next 10 upcoming across all courses | honors course calendars |
| `GET /api/v1/announcements?context_codes[]=course_:id` | announcements | |

### What students CANNOT read (silently)

| Endpoint | Student result |
|---|---|
| `GET /api/v1/courses/:id/files` | **empty list** (permission-gated — teachers only). If you need curriculum docs, look in module items (type=`File` or `Page`) or parse `syllabus_body` HTML for embedded links. |
| `GET /api/v1/courses/:id/users` | empty/limited |
| `GET /api/v1/courses/:id/gradebook_history/*` | 401 |

### What ALMOST works but is often empty

| Endpoint | Why it's empty |
|---|---|
| `GET /api/v1/calendar_events?context_codes[]=course_:id&type=event` | Teachers rarely create "event" records — they create Assignments with `due_at`, which populate the calendar implicitly. Use `type=assignment` instead, or just use the assignments endpoint directly. |

---

## 3. Pagination — Link header, not query params

Canvas paginates with standard RFC 5988 Link headers. The `per_page` you send is a request; the response tells you where "next" is:

```javascript
async function paginate(url, cap = 200) {
  const out = [];
  let next = url;
  while (next && out.length < cap) {
    const r = await page.request.get(next, { timeout: 20000 });
    if (!r.ok()) break;
    const j = await r.json().catch(() => []);
    if (Array.isArray(j)) out.push(...j);
    const link = r.headers()['link'] || '';
    const m = link.match(/<([^>]+)>;\s*rel="next"/);
    next = m ? m[1] : null;
  }
  return out;
}
```

Don't try to increment `page=N` manually — Canvas uses cursor-style tokens in the Link URL that are opaque.

---

## 4. Curriculum structure — the mental model

Teachers populate **three overlapping layers** in Canvas. Which one they use varies:

1. **`syllabus_body`** — a single HTML blob. Fast/cheap overview. ~15-30% of teachers use it; the rest leave it empty.
2. **Modules** — hierarchical "units" with items inside. The **most common** place curriculum lives. Items have a `type` (`Assignment`, `Page`, `File`, `Discussion`, `Quiz`, `ExternalUrl`) and a `content_id` that points into the right collection.
3. **Assignments** — flat list with `due_at`. This is where due dates actually live. Module items of type `Assignment` are just pointers; they don't carry the due date themselves.

### Joining modules to due dates

Module items look like this (from `include[]=items`):
```json
{
  "id": 123, "title": "Essay 3", "type": "Assignment",
  "content_id": 4567,              // the assignment id
  "content_details": { "due_at": "..." }   // OFTEN NULL for student role
}
```

`content_details.due_at` is **not reliable for students** — it's frequently null even when the underlying assignment has a due date. The working pattern is:

```javascript
const mods  = await paginate(`${D}/api/v1/courses/${cid}/modules?include[]=items&per_page=50`);
const assns = await paginate(`${D}/api/v1/courses/${cid}/assignments?per_page=100`);
const byId  = new Map(assns.map(a => [a.id, a]));

for (const mod of mods) {
  for (const item of mod.items || []) {
    if (item.type === 'Assignment') {
      const a = byId.get(item.content_id);
      if (a?.due_at) console.log(mod.name, '→', item.title, 'due', a.due_at);
    }
  }
}
```

---

## 5. Syllabus-vs-calendar drift — the real detection pattern

Parents care about "is my teacher keeping Canvas updated?" Two signals:

### A. Module-title date ranges vs actual due dates

Many teachers title modules with explicit date ranges like *"Lapso 4: 3ª semana (4/13-4/17)"* or *"Week of 4/13-4/17: Essay 3"* or *"Q3 Unit 2 (Feb 10 - Feb 21)"*. Parse the range out of the title with a regex:

```javascript
function parseRange(title, year = new Date().getFullYear()) {
  // "(4/13-4/17)" or "(4/13 - 4/17)" or "Feb 10 - Feb 21"
  let m = title.match(/\((\d{1,2})\/(\d{1,2})\s*[-–]\s*(\d{1,2})\/(\d{1,2})\)/);
  if (m) return {
    from: new Date(`${year}-${String(m[1]).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}`),
    to:   new Date(`${year}-${String(m[3]).padStart(2,'0')}-${String(m[4]).padStart(2,'0')}T23:59:59Z`),
  };
  return null; // fall back to module order / unlock_at / published_at
}
```

Then for each module with a range, check that its assignments' `due_at` fall within that window. Out-of-range due dates → drift.

### B. Assignment-date max age ("dormant course")

If the latest `due_at` across all assignments is more than ~60 days in the past but the term is still active, the course is dormant — teacher stopped posting work. This is a strong signal.

**Real example found on 2026-04-19:** STUDENT ADVISORY 10 (Canyons) had its latest assignment due `2025-10-29` — 6 months ago. LANGUAGE ARTS 10 had `2026-04-18` (yesterday). The 6-month gap is diagnostic.

### C. Modules-with-no-items

A module with `items.length === 0` is a teacher-created skeleton that never got populated. Usually fine (teachers sometimes pre-create structure), but a lot of empty modules in a late-term course signals the teacher gave up on Canvas.

---

## 6. Per-student behavior notes (Canyons-specific)

- **Student Advisory**: typically dormant after Q1; don't flag.
- **"AHS Civics Test"**: state-required civics test shell course; usually contains 1 assignment. Normal.
- **Dual/concurrent courses**: look at `enrollment_term_id` — active term's ids change annually.
- **Spanish 2 (Gonzalez)**: model case for good syllabus hygiene — weekly modules titled with explicit date ranges like `Lapso 4: 3ª semana (4/13-4/17)`. 32 modules over the year.
- **Language Arts 10 (Brannan)**: quarter-based modules with unit themes (e.g. "Quarter 2: Informational - Animal Farm"). 79 assignments.
- **Secondary Math 3 (Kennedy)**: unit-based, sequential numbering ("Unit 8: Inverses", "Unit 9: Logarithms"). 82 assignments.
- **Choir (Galbuchi)**: the one course where `syllabus_body` is populated (~15KB of HTML). Parse with a tolerant HTML→text extractor.
- **Sports Psych (Gustafson)**: unit-based, tight date ranges Jan-May (spring semester only).
- **Art/Sketchbook (Crane)**: sparse assignment count (~9); a-la-carte elective.

---

## 7. Rate limits

Canvas doesn't publish a hard limit, but empirically:
- ~50 req/sec sustained is fine.
- Avoid tight loops of `GET /api/v1/courses/:id` with `include[]=all` — that's expensive.
- When scanning all courses for a user, batch: courses first, then per-course parallel fetches with `Promise.all()` of ~5-10 concurrency.

If you hit 403 Forbidden on an endpoint you used to have access to, check the course's `workflow_state` — ended courses have read access revoked.

---

## 8. File downloads (workaround for student file-list 403)

Students can't list `/api/v1/courses/:id/files`, but they CAN download files linked from module items or the syllabus_body. Two paths:

### From module items (type=File)
```javascript
for (const mod of modules) {
  for (const item of mod.items || []) {
    if (item.type === 'File') {
      // item.url points to /api/v1/files/:file_id — fetch it, it returns file metadata including a download URL
      const meta = await page.request.get(item.url).then(r => r.json());
      const blob = await page.request.get(meta.url);
      // write blob.body() to disk
    }
  }
}
```

### From syllabus_body HTML
```javascript
const full = await apiGet(`${D}/api/v1/courses/${cid}?include[]=syllabus_body`);
const html = full.syllabus_body || '';
const links = [...html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/g)];
// filter for /files/:id or /courses/:cid/files/:id patterns
```

---

## 9. The token UI — send this image if the user is confused

When onboarding a new user who's never generated a Canvas Personal Access Token, they often can't find the button. **Send them `CANVAS_ACCESS_TOKEN_REFERENCE.jpg`** — it's in this workspace, ready to attach. The UI is: **Account** (left sidebar) → **Settings** → scroll to **Approved Integrations** → **+ New Access Token**.

---

## 10. When you get stuck

- **Login returns 302 to `/login/saml` instead of expected dashboard** → district uses SAML not LDAP; URL should be `/login/saml` not `/login/ldap`.
- **All API calls return 401 even with fresh cookies** → the session cookie's path may be wrong; check `WHOAMI = /api/v1/users/self` first.
- **`syllabus_body` is missing when you requested it** → you forgot the `include[]=syllabus_body` query param; without it, Canvas nulls it out.
- **Module items have `content_details.due_at = null` but the course is active** → expected. Join to the assignments list by `content_id` as shown in §4.
- **An endpoint works in the browser but 404s from Playwright** → check cookie scope; Canyons uses a single domain so this should not happen, but multi-subdomain districts sometimes split sessions.

If none of these diagnose your issue, capture a screenshot + the response body + the Link header and update this playbook with the new pattern.

Last verified: **2026-04-19** · student account · Canyons School District.

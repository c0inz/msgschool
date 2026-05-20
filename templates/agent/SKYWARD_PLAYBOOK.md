# Skyward Grade Extraction Playbook

## ⚠️ HARD RULES — read these first, they override everything below

**You no longer scrape Skyward yourself.** The platform owns the
playwright session, the popup-handling, the frame iteration, and the
table-parsing heuristics. Use `ms_call` for every Skyward data read.

### What you must do

- **Use `ms_call <tool> '<json>'`** to read Skyward data. Examples:
  ```
  ms_call skyward.get_grades '{}'
  ms_call skyward.get_grades '{"term": "T4"}'
  ms_call skyward.get_attendance '{}'
  ms_call skyward.get_attendance '{"since": "2026-04-01T00:00:00Z"}'
  ms_call skyward.get_pulse '{}'
  ms_call skyward.connectivity_probe '{}'
  ```
- For "what's going on" questions, prefer `pulse.combined` — bundles
  Canvas + Skyward in one call.

### What you must NEVER do

- **Never launch playwright yourself.** No `require('playwright')`, no
  `chromium.launch(...)`, no `page.goto`, no `page.fill`. The platform
  does this; you call the tool.
- **Never write a script that contains a Skyward username or password
  as a string literal.** Not as a `const`, not inside a template
  string, not in a comment, not in a JSON file you create. The platform
  considers any agent-written script that contains a credential value
  to be a security incident.
- **Never read `credentials/skyward.json`** directly. The file does not
  belong in your reasoning loop. `ms_call` is the only legitimate path.
- **Never paste a Skyward username or password into chat.** Even
  partially. Even as confirmation.

### What if `ms_call` fails?

Tell the user the system is having trouble with their data right now,
ask them to try again in a few minutes, and stop. Do **not** fall back
to writing a playwright script that reads `credentials/*.json` — that's
the behavior we're trying to eliminate.

The notes below are reference material for the *platform team* who
maintains the Skyward tool implementation. Your job is to call the
tool.

---

## The Core Problem

Skyward gradebook systems are notoriously difficult to scrape because:
1. They use complex nested tables that break simple cell-position parsing
2. Course names and grades often appear in separate, misaligned structures
3. Login flows vary between districts (popups, iframes, redirects)
4. Grade data is rendered via JavaScript, not static HTML

This playbook documents the working extraction patterns.

---

## The Working Pattern: Canyons School District

### The Login Flow (Critical)

**What doesn't work:**
- Simple form POST
- Waiting for navigation on same page
- Assuming MFA when you see a "security code" field (it's often hidden/unused)

**What works:**

```javascript
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({
  javaScriptEnabled: true,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
});

const page = await context.newPage();

// 1. Load login page
// NOTE: do NOT use waitUntil: 'networkidle' — this portal keeps a polling
// connection open, so networkidle never fires and page.goto times out.
// Use 'domcontentloaded' + explicit locator wait as the real readiness signal.
await page.goto('https://student.canyonsdistrict.org/scripts/wsisa.dll/WService=wsEAplus/fwemnu01.w', {
  waitUntil: 'domcontentloaded',
  timeout: 30000
});
await page.locator('#login').waitFor({ state: 'visible', timeout: 15000 });

// 2. Fill credentials
await page.fill('#login', '<YOUR_SKYWARD_USERNAME>');
await page.fill('#password', '<YOUR_SKYWARD_PASSWORD>');

// 3. THE KEY: Capture the popup/new page that opens after login
const [popup] = await Promise.all([
  context.waitForEvent('page', { timeout: 15000 }),  // Wait for NEW page
  page.evaluate(() => { 
    // Skyward uses JavaScript functions, not form submit
    if (cbs("bLogin")) { tryLogin(); }
  })
]);

// 4. Work with the NEW page (popup), not the original
await popup.waitForLoadState('networkidle');
await popup.click('text=Gradebook');
await popup.waitForTimeout(10000);
```

**Critical insight:** The login creates a NEW browser page/context. All grade extraction happens on that new page.

---

## Grade Extraction: Two Methods

### Method 1: Grade Links (Data Attributes)

Skyward renders grades as clickable links with embedded metadata:

```html
<a id="showGradeInfo" data-gid="8807378" data-lit="Q4" data-bkt="TERM 4">C</a>
```

**Extraction code:**

```javascript
// Get all grade links in document order
const gradeLinks = await popup.locator('a[id="showGradeInfo"]').all();

const grades = [];
for (const link of gradeLinks) {
  grades.push({
    grade: await link.innerText(),     // "C", "D+", "F"
    gid: await link.getAttribute('data-gid'),     // "8807378"
    term: await link.getAttribute('data-lit'),    // "Q4"
    bucket: await link.getAttribute('data-bkt')   // "TERM 4"
  });
}
```

**Why this works:**
- Grades are authoritative (what Skyward displays)
- GID uniquely identifies the course
- `data-lit` tells you which term (Q1, Q2, Q3, Q4)
- Links appear in the same order as courses in the table

### Method 2: Row-Anchored Extraction (Bulletproof)

Parse courses and grades separately, then match by position:

```javascript
// Step 1: Extract all courses in order
const courses = await popup.evaluate(() => {
  const text = document.body.innerText;
  const lines = text.split('\n').map(l => l.trim());
  const courses = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Pattern match course names (customize for your district)
    if (line.match(/^(STUDENT ADVISORY|SPANISH|MATH|SPORTS|ART|CHOIR|LANGUAGE)/)) {
      courses.push({
        name: line,
        period: lines[i + 1] || '',
        teacher: lines[i + 2] || ''
      });
    }
  }
  return courses;
});

// Step 2: Extract all grades in order
const gradeLinks = await popup.locator('a[id="showGradeInfo"]').all();
const grades = [];
for (const link of gradeLinks) {
  grades.push({
    grade: await link.innerText(),
    gid: await link.getAttribute('data-gid'),
    term: await link.getAttribute('data-lit')
  });
}

// Step 3: Match by position
// grades[0] belongs to courses[0], grades[1] to courses[1], etc.
const results = [];
courses.forEach((course, idx) => {
  const grade = grades[idx];
  results.push({
    course: course.name,
    period: course.period,
    teacher: course.teacher,
    grade: grade ? grade.grade : 'No grade',
    gid: grade ? grade.gid : null
  });
});
```

**Why this is bulletproof:**
- Doesn't rely on table cell alignment (which breaks)
- Doesn't rely on GID lookup tables (which change between schools)
- Position-based matching is robust across Skyward versions

---

## What Will Break (And How to Fix It)

### Problem 1: "Security Code" Field Visible

**Symptom:** You see a security code/2FA field in the HTML.

**Reality Check:** This field is often hidden by CSS (`display: none`) and only appears if:
- The account actually has MFA enabled
- A previous login triggered the MFA flow

**Solution:** Try the login anyway. If `context.waitForEvent('page')` succeeds and you get a new page with "Family Access" or "Gradebook", you're in. The MFA field is a red herring.

### Problem 2: Grades and Courses Misaligned

**Symptom:** Math 3 shows an "F" but it's actually Spanish 2 that has the F.

**Root Cause:** You parsed all course names from one part of the DOM and all grades from another part, then matched by array index. Skyward's DOM has invisible rows that throw off the alignment.

**Solution:** Use row-anchored extraction (Method 2 above). Extract courses and grades in a single pass through the document, or match by position after verifying both lists have the same structure.

### Problem 3: Stale/Wrong Term in Detail Popup

**Symptom:** You clicked the Q4 grade link but the popup shows Q3 data.

**Root Cause:** Skyward reuses modal dialogs. If you previously opened Q3, the dialog might still contain Q3 content when you click Q4.

**Solution:** 
```javascript
// Always verify the popup shows the right term before parsing
const dialogText = await popup.evaluate(() => {
  const dialog = document.querySelector('[role="dialog"]');
  return dialog ? dialog.innerText : '';
});

if (!dialogText.includes('Q4 Progress Report')) {
  console.log('ERROR: Dialog shows wrong term');
  return null;
}
```

### Problem 4: Login "Works" But You're Still on Login Page

**Symptom:** `page.evaluate(() => { if (cbs("bLogin")) { tryLogin(); } })` runs but nothing changes.

**Root Cause:** You're clicking on the original page, but the login happens in a popup/new page that you didn't capture.

**Solution:** Always use `context.waitForEvent('page')` wrapped in `Promise.all()` with the login trigger:

```javascript
const [popup] = await Promise.all([
  context.waitForEvent('page', { timeout: 15000 }),
  page.evaluate(() => { if (cbs("bLogin")) { tryLogin(); } })
]);
```

---

## Missing Assignments

Missing assignments are usually in a separate table:

```javascript
const missing = await popup.evaluate(() => {
  const text = document.body.innerText;
  // Pattern: "StudentName has X missing assignments:"
  const match = text.match(/has \d+ missing assignments:([\s\S]*?)(?=Class Grades|$)/);
  return match ? match[0] : 'No missing assignments';
});
```

---

## Debugging Checklist

When extraction fails:

1. **Take screenshots** at each step:
   ```javascript
   await page.screenshot({ path: '/tmp/1_login_page.png' });
   await popup.screenshot({ path: '/tmp/2_after_login.png' });
   await popup.screenshot({ path: '/tmp/3_gradebook.png' });
   ```

2. **Verify page count:**
   ```javascript
   console.log('Pages:', context.pages().length);
   // Should be 2 after login (original + popup)
   ```

3. **Dump the DOM structure:**
   ```javascript
   const tables = await popup.locator('table').all();
   console.log(`Found ${tables.length} tables`);
   for (let i = 0; i < tables.length; i++) {
     const text = await tables[i].innerText();
     if (text.includes('Grade') || text.includes('Class')) {
       console.log(`Table ${i}: ${text.substring(0, 200)}`);
     }
   }
   ```

4. **Check for hidden elements:**
   ```javascript
   const hiddenGrades = await popup.locator('a[id="showGradeInfo"]:hidden').all();
   console.log(`Hidden grade links: ${hiddenGrades.length}`);
   ```

---

## Universal Pattern Summary

Any Skyward system (Canyons, Providence Hall, etc.):

1. **Login** → Triggers JavaScript → Opens new page
2. **Capture new page** with `context.waitForEvent('page')`
3. **Navigate** to Gradebook on new page
4. **Extract** using `a[id="showGradeInfo"]` links with data attributes
5. **Match** courses to grades by position/index
6. **Verify** term labels (Q1, Q2, Q3, Q4) before reporting

---

## Current Working Example: Canyons

**Login URL:** `https://student.canyonsdistrict.org/scripts/wsisa.dll/WService=wsEAplus/fwemnu01.w`
**Username:** `<from credentials/skyward.json>`
**Password:** `<from credentials/skyward.json>`
**Login Trigger:** `cbs("bLogin")` then `tryLogin()`
**Post-Login:** New page opens with "Family Access"
**Grade Links:** `a[id="showGradeInfo"]` with `data-gid` and `data-lit="Q4"`
**GID Format:** 880xxxx

---

## Files

- **credentials.md** - Login credentials
- **memory/2026-04-18.md** - Transition notes

Last Updated: 2026-04-19

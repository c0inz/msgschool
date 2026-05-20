/**
 * Skyward tool implementations.
 *
 * Playwright-driven scraper for the Canyons-district Skyward Family
 * Access portal. Faithful port of the agent-written skyward_final.js
 * and skyward_parse.js scripts that have been working in production.
 *
 * Key gotchas preserved from the playbook:
 *   - waitUntil 'networkidle' never fires on this portal (long-poll
 *     connection); use 'domcontentloaded' + explicit selector.
 *   - Login opens a NEW browser page (popup); subsequent work happens
 *     on the popup, not the original page.
 *   - Login uses a JavaScript function call, not a form submit.
 */
import { chromium, type Browser, type BrowserContext, type Page, type Frame } from "playwright-core";
import { ToolError } from "./protocol.ts";
import { loadCreds, type SkywardCreds } from "./creds.ts";

const LAUNCH_TIMEOUT_MS = 60_000;
const LOGIN_TIMEOUT_MS = 30_000;
const NAV_TIMEOUT_MS = 30_000;

// Use OpenClaw's bundled chromium — bootstrap-droplet.sh installs it at
// this path. In dev (no chromium installed), playwright-core will pick
// up PLAYWRIGHT_BROWSERS_PATH from the env if set, else fail clearly.
const CHROME_PATH = process.env.MSGSCHOOL_CHROMIUM_PATH || undefined;

async function launchBrowser(): Promise<Browser> {
  return chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    timeout: LAUNCH_TIMEOUT_MS,
    executablePath: CHROME_PATH,
  });
}

async function loginAndGetPopup(
  context: BrowserContext,
  page: Page,
  creds: SkywardCreds,
): Promise<Page> {
  await page.goto(creds.url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  await page.locator("#login").waitFor({ state: "visible", timeout: LOGIN_TIMEOUT_MS });
  await page.fill("#login", creds.username);
  await page.fill("#password", creds.password);
  const [popup] = await Promise.all([
    context.waitForEvent("page", { timeout: LOGIN_TIMEOUT_MS }),
    page.evaluate(() => {
      const w = window as unknown as {
        cbs?: (k: string) => boolean;
        tryLogin?: () => void;
      };
      if (typeof w.cbs === "function" && w.cbs("bLogin") && typeof w.tryLogin === "function") {
        w.tryLogin();
      }
    }),
  ]);
  await popup.waitForLoadState("domcontentloaded", { timeout: LOGIN_TIMEOUT_MS });
  return popup;
}

async function withSession<T>(
  tg: number,
  fn: (popup: Page, context: BrowserContext) => Promise<T>,
): Promise<T> {
  const creds = await loadCreds<SkywardCreds>(tg, "skyward");
  let browser: Browser | null = null;
  try {
    browser = await launchBrowser();
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    });
    const page = await context.newPage();
    let popup: Page;
    try {
      popup = await loginAndGetPopup(context, page, creds);
    } catch (e) {
      throw new ToolError("AUTH_FAILED", `skyward login: ${(e as Error).message}`);
    }
    return await fn(popup, context);
  } catch (e) {
    if (e instanceof ToolError) throw e;
    throw new ToolError("INTERNAL", `skyward: ${(e as Error).message}`);
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}

export async function getGrades(tg: number, args: { term?: string }): Promise<unknown> {
  return withSession(tg, async (popup) => {
    await popup.click("text=Gradebook");
    await popup.waitForSelector('a[id="showGradeInfo"]', { timeout: NAV_TIMEOUT_MS });

    const gradeLinks = await popup.$$eval('a[id="showGradeInfo"]', (links) =>
      links.map((a) => ({
        grade: (a as HTMLElement).innerText.trim(),
        term: a.getAttribute("data-lit") || "",
        bucket: a.getAttribute("data-bkt") || "",
        gid: a.getAttribute("data-gid"),
      })),
    );

    // Course names: parsed from body text using the same heuristic as
    // skyward_final.js. Fragile but proven against Canyons-district
    // gradebook layout. If it ever stops working, regenerate against the
    // current DOM and update here — do NOT teach the agent to do it.
    const bodyText = await popup.evaluate(() => document.body.innerText);
    const lines = bodyText.split("\n");
    const courseNames: string[] = [];
    const skipPrefix =
      /^(WESTON|BARTONA|FAMILY ACCESS|DISTRICT LINKS|HOME|BACK|ARENA|ETHNICITY|CALENDAR|GRADEBOOK|ATTENDANCE|STUDENT INFO|BUSING|FOOD|SCHEDULE|TEST|FEE|ACTIVITIES|GRADUATION|CONFERENCES|ACADEMIC|REPORT|HEALTH|LOGIN|THERE ARE|CLASS GRADES|GRADES POSTED|CURRENT GRADES|PLEASE WAIT|DISPLAY OPTIONS|GPA|NEW STUDENT|ALTA HIGH|CANYONS ONLINE)/;
    for (const raw of lines) {
      const line = raw.trim();
      if (
        line.length > 3 &&
        line === line.toUpperCase() &&
        /[A-Z]{3}/.test(line) &&
        !/^\d+$/.test(line) &&
        !/^[A-F][+-]?$/.test(line) &&
        !skipPrefix.test(line) &&
        !/^PERIOD\d/i.test(line) &&
        !/,\s*[A-Z]/.test(line)
      ) {
        courseNames.push(line);
      }
    }
    const uniqueCourses: string[] = [];
    for (const c of courseNames) {
      if (uniqueCourses[uniqueCourses.length - 1] !== c) uniqueCourses.push(c);
    }

    const wantedTerm = args?.term;
    const grades = gradeLinks
      .filter((l) => (wantedTerm ? l.term === wantedTerm : true))
      .map((link, i) => ({
        course: uniqueCourses[i] || `COURSE_${i + 1}`,
        letter: link.grade,
        term: link.term,
        bucket: link.bucket,
        data_gid: link.gid,
        last_changed_at: null as string | null,
      }));

    return grades;
  });
}

export async function getAttendance(tg: number, args: { since?: string }): Promise<unknown> {
  return withSession(tg, async (popup) => {
    const attendanceLink = await popup.$('a:has-text("Attendance")');
    if (attendanceLink) await attendanceLink.click();
    await popup.waitForTimeout(3000);

    let targetFrame: Frame | null = null;
    for (const frame of popup.frames()) {
      const url = frame.url();
      if (url.includes("sfattendance") || url.includes("attend")) {
        targetFrame = frame;
        break;
      }
    }
    if (!targetFrame) targetFrame = popup.mainFrame();

    const tableRows = (await targetFrame
      .evaluate(() => {
        const tables = document.querySelectorAll("table");
        const all: Array<{ idx: number; rows: string[][] }> = [];
        tables.forEach((table, idx) => {
          const rows: string[][] = [];
          table.querySelectorAll("tr").forEach((tr) => {
            const cells = Array.from(tr.querySelectorAll("td, th")).map((c) =>
              ((c as HTMLElement).innerText || "").trim(),
            );
            if (cells.length > 0 && cells.some((c) => c)) rows.push(cells);
          });
          all.push({ idx, rows });
        });
        return all;
      })
      .catch(() => [])) as Array<{ idx: number; rows: string[][] }>;

    const monthMap: Record<string, string> = {
      Jan: "01",
      Feb: "02",
      Mar: "03",
      Apr: "04",
      May: "05",
      Jun: "06",
      Jul: "07",
      Aug: "08",
      Sep: "09",
      Oct: "10",
      Nov: "11",
      Dec: "12",
    };

    const out: Array<{
      date: string;
      period: string;
      class: string;
      status: string;
      code: string;
    }> = [];

    for (const tbl of tableRows) {
      if (tbl.rows.length > 1 && tbl.rows[0].length >= 3) {
        const header = tbl.rows[0];
        if (header[0] === "Date" && header[1] === "Attendance") {
          for (let i = 1; i < tbl.rows.length; i++) {
            const r = tbl.rows[i];
            if (r.length < 2) continue;
            const dateStr = r[0];
            const statusStr = r[1];
            const periodStr = r[2] || "";
            const classStr = r[3] || "";
            let isoDate = "";
            const dm = dateStr.match(/(\w+)\s+(\d+),\s+(\d{4})/);
            if (dm) {
              isoDate = `${dm[3]}-${monthMap[dm[1]] || "00"}-${dm[2].padStart(2, "0")}`;
            }
            out.push({
              date: isoDate || dateStr,
              period: periodStr,
              class: classStr,
              status: statusStr,
              code: "",
            });
          }
        }
      }
    }

    const since = args?.since ? new Date(args.since).getTime() : null;
    return out.filter((r) => {
      if (since == null) return true;
      const t = new Date(r.date).getTime();
      return Number.isFinite(t) && t >= since;
    });
  });
}

export async function getPulse(tg: number): Promise<unknown> {
  return withSession(tg, async (popup) => {
    // Inline a stripped-down getGrades flow inside this session so we
    // don't pay two browser launches.
    await popup.click("text=Gradebook");
    await popup.waitForSelector('a[id="showGradeInfo"]', { timeout: NAV_TIMEOUT_MS });
    const gradeLinks = await popup.$$eval('a[id="showGradeInfo"]', (links) =>
      links.map((a) => ({
        grade: (a as HTMLElement).innerText.trim(),
        term: a.getAttribute("data-lit") || "",
        bucket: a.getAttribute("data-bkt") || "",
        gid: a.getAttribute("data-gid"),
      })),
    );
    const bodyText = await popup.evaluate(() => document.body.innerText);
    const lines = bodyText.split("\n");
    const courseNames: string[] = [];
    const skipPrefix =
      /^(WESTON|BARTONA|FAMILY ACCESS|DISTRICT LINKS|HOME|BACK|ARENA|ETHNICITY|CALENDAR|GRADEBOOK|ATTENDANCE|STUDENT INFO|BUSING|FOOD|SCHEDULE|TEST|FEE|ACTIVITIES|GRADUATION|CONFERENCES|ACADEMIC|REPORT|HEALTH|LOGIN|THERE ARE|CLASS GRADES|GRADES POSTED|CURRENT GRADES|PLEASE WAIT|DISPLAY OPTIONS|GPA|NEW STUDENT|ALTA HIGH|CANYONS ONLINE)/;
    for (const raw of lines) {
      const line = raw.trim();
      if (
        line.length > 3 &&
        line === line.toUpperCase() &&
        /[A-Z]{3}/.test(line) &&
        !/^\d+$/.test(line) &&
        !/^[A-F][+-]?$/.test(line) &&
        !skipPrefix.test(line) &&
        !/^PERIOD\d/i.test(line) &&
        !/,\s*[A-Z]/.test(line)
      ) {
        courseNames.push(line);
      }
    }
    const uniqueCourses: string[] = [];
    for (const c of courseNames) {
      if (uniqueCourses[uniqueCourses.length - 1] !== c) uniqueCourses.push(c);
    }
    const grades = gradeLinks.map((link, i) => ({
      course: uniqueCourses[i] || `COURSE_${i + 1}`,
      letter: link.grade,
      term: link.term,
      bucket: link.bucket,
      data_gid: link.gid,
    }));

    return {
      grades,
      attendance: [],
      generated_at: new Date().toISOString(),
    };
  });
}

export async function connectivityProbe(tg: number): Promise<unknown> {
  const start = Date.now();
  try {
    await withSession(tg, async () => undefined);
    return { ok: true, login_succeeded: true, latency_ms: Date.now() - start };
  } catch (e) {
    if (e instanceof ToolError) {
      return {
        ok: false,
        login_succeeded: false,
        latency_ms: Date.now() - start,
        error_class: e.code,
      };
    }
    return {
      ok: false,
      login_succeeded: false,
      latency_ms: Date.now() - start,
      error_class: "INTERNAL",
    };
  }
}

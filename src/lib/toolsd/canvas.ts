/**
 * Canvas tool implementations.
 *
 * Pure REST API client. No playwright. Uses Bearer token from
 * credentials/canvas.json loaded via creds.ts.
 *
 * Ported faithfully from the agent-written fetch_canvas.mjs that has
 * been working in production. Kept the same FILTER regex (advisory /
 * lunch / study-hall etc.) — these were noise in the gradebook.
 */
import { ToolError } from "./protocol.ts";
import { loadCreds, type CanvasCreds } from "./creds.ts";

const FETCH_TIMEOUT_MS = 20_000;
const NOISE_FILTER = /advisory|civics.?test|lunch|study.?hall|office|zero.?hour/i;

async function api(creds: CanvasCreds, path: string): Promise<unknown> {
  const url = creds.url.replace(/\/+$/, "") + path;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${creds.token}`,
        Accept: "application/json",
      },
      signal: ctrl.signal,
    });
    if (res.status === 401 || res.status === 403) {
      throw new ToolError("AUTH_FAILED", `canvas ${res.status} on ${path}`);
    }
    if (!res.ok) {
      throw new ToolError("UPSTREAM_HTTP", `canvas ${res.status} on ${path}`);
    }
    return res.json();
  } catch (e) {
    if (e instanceof ToolError) throw e;
    if ((e as { name?: string }).name === "AbortError") {
      throw new ToolError("UPSTREAM_TIMEOUT", `canvas timeout on ${path}`);
    }
    throw new ToolError("INTERNAL", `canvas ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function listCourses(tg: number): Promise<unknown> {
  const creds = await loadCreds<CanvasCreds>(tg, "canvas");
  const courses = (await api(creds, "/api/v1/courses?per_page=100&enrollment_state=active")) as Array<{
    id: number;
    name: string;
    course_code: string;
    enrollment_term_id?: number;
  }>;
  return courses
    .filter((c) => c.name && !NOISE_FILTER.test(c.name))
    .map((c) => ({
      course_id: c.id,
      name: c.name,
      course_code: c.course_code,
      enrollment_term_id: c.enrollment_term_id ?? null,
    }));
}

export async function listAssignments(
  tg: number,
  args: { course_id: number; since?: string },
): Promise<unknown> {
  if (!Number.isInteger(args?.course_id)) {
    throw new ToolError("INVALID_ARG", "course_id (int) required");
  }
  const creds = await loadCreds<CanvasCreds>(tg, "canvas");
  const list = (await api(
    creds,
    `/api/v1/courses/${args.course_id}/assignments?per_page=100&order_by=due_at&include[]=submission`,
  )) as Array<{
    id: number;
    name: string;
    due_at: string | null;
    points_possible: number | null;
    submission?: {
      submitted_at: string | null;
      graded_at: string | null;
      score: number | null;
      grade: string | null;
      workflow_state: string | null;
    };
  }>;
  const since = args.since ? new Date(args.since).getTime() : null;
  return list
    .filter((a) => (since == null ? true : a.due_at && new Date(a.due_at).getTime() >= since))
    .map((a) => ({
      id: a.id,
      name: a.name,
      due_at: a.due_at,
      points_possible: a.points_possible,
      submission: a.submission
        ? {
            submitted_at: a.submission.submitted_at,
            graded_at: a.submission.graded_at,
            score: a.submission.score,
            grade: a.submission.grade,
            workflow_state: a.submission.workflow_state,
          }
        : null,
    }));
}

export async function listMissing(tg: number): Promise<unknown> {
  const creds = await loadCreds<CanvasCreds>(tg, "canvas");
  const list = (await api(creds, "/api/v1/users/self/missing_submissions?per_page=50")) as Array<{
    course_id: number;
    name: string;
    due_at: string | null;
  }>;
  return list.map((m) => ({
    course_id: m.course_id,
    name: m.name,
    due_at: m.due_at,
  }));
}

export async function getPulse(tg: number): Promise<unknown> {
  const creds = await loadCreds<CanvasCreds>(tg, "canvas");
  const [self, courses, missing] = (await Promise.all([
    api(creds, "/api/v1/users/self"),
    api(creds, "/api/v1/courses?per_page=100&enrollment_state=active"),
    api(creds, "/api/v1/users/self/missing_submissions?per_page=50"),
  ])) as [
    { id: number; name: string },
    Array<{ id: number; name: string; course_code: string }>,
    Array<{ course_id: number; name: string; due_at: string | null }>,
  ];

  const filtered = courses.filter((c) => c.name && !NOISE_FILTER.test(c.name));

  const courseData = await Promise.all(
    filtered.map(async (course) => {
      const [assignments, enrollments] = (await Promise.all([
        api(
          creds,
          `/api/v1/courses/${course.id}/assignments?per_page=50&order_by=due_at&include[]=submission`,
        ),
        api(creds, `/api/v1/courses/${course.id}/enrollments?user_id=self`),
      ])) as [
        Array<{
          id: number;
          name: string;
          due_at: string | null;
          points_possible: number | null;
          submission?: {
            submitted_at: string | null;
            graded_at: string | null;
            score: number | null;
            grade: string | null;
            workflow_state: string | null;
          };
        }>,
        Array<{
          user_id: number;
          grades?: { current_grade?: string | null; current_score?: number | null };
        }>,
      ];
      const enrollment = enrollments.find((e) => e.user_id === self.id) || enrollments[0] || {};
      const grades = enrollment.grades || {};
      const sorted = [...assignments]
        .sort((a, b) => {
          if (!a.due_at && !b.due_at) return 0;
          if (!a.due_at) return 1;
          if (!b.due_at) return -1;
          return new Date(b.due_at).getTime() - new Date(a.due_at).getTime();
        })
        .slice(0, 20);
      return {
        course_id: course.id,
        name: course.name,
        current_grade: grades.current_grade ?? null,
        current_score: grades.current_score ?? null,
        recent_assignments: sorted.map((a) => ({
          id: a.id,
          name: a.name,
          due_at: a.due_at,
          points_possible: a.points_possible,
          submission: a.submission
            ? {
                submitted_at: a.submission.submitted_at,
                graded_at: a.submission.graded_at,
                score: a.submission.score,
                grade: a.submission.grade,
                workflow_state: a.submission.workflow_state,
              }
            : null,
        })),
      };
    }),
  );

  return {
    student: { id: self.id, name: self.name },
    courses: courseData,
    missing: missing.map((m) => ({
      course_id: m.course_id,
      name: m.name,
      due_at: m.due_at,
    })),
    generated_at: new Date().toISOString(),
  };
}

export async function connectivityProbe(tg: number): Promise<unknown> {
  const start = Date.now();
  try {
    const creds = await loadCreds<CanvasCreds>(tg, "canvas");
    await api(creds, "/api/v1/users/self");
    return { ok: true, latency_ms: Date.now() - start };
  } catch (e) {
    if (e instanceof ToolError) {
      return { ok: false, latency_ms: Date.now() - start, error_class: e.code };
    }
    return { ok: false, latency_ms: Date.now() - start, error_class: "INTERNAL" };
  }
}

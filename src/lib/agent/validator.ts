/**
 * Procedure-output validator for the staged-agent pipeline.
 *
 * Why this exists: parents (Sarah, future users) repeatedly caught the bot
 * emitting wrong answers — wrong term, wrong school, fabricated grades,
 * Skyward-vs-Canvas mismatches passed off as one number. Rather than rely
 * on the user to detect errors, we validate the procedure executor's output
 * before it leaves the bot.
 *
 * Rule-based, deterministic, no LLM calls. Hard fails force a retry; soft
 * fails attach a warning to the response.
 *
 * Authoritative reference: the doctrine and error patterns documented in
 * docs/LLM_BEHAVIOR_MITIGATIONS.md.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LetterGrade =
  | "A" | "A-" | "B+" | "B" | "B-" | "C+" | "C" | "C-"
  | "D+" | "D" | "D-" | "F";

export const LEGAL_LETTER_GRADES: ReadonlySet<string> = new Set([
  "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D+", "D", "D-", "F",
]);

/** A single grade row attributed to one course. */
export interface GradeCell {
  course_name: string;
  /** Skyward `data-gid` on the `a[id="showGradeInfo"]` element, or null if the source isn't Skyward. */
  data_gid?: string | null;
  /** Canvas course id, when the source is Canvas. */
  canvas_course_id?: string | null;
  letter?: string | null;
  percent?: number | null;
  /** The term the source row was actually attributed to ("T1"|"T2"|"T3"|"T4"|"current"|null). */
  term: string | null;
  /** "skyward" | "canvas" — must match where the cell came from. */
  source: "skyward" | "canvas";
  /** ISO timestamp when this cell was fetched from the source. */
  fetched_at: string;
  /** Optional attribution school code, for SCHOOL_MATCH. */
  school?: string | null;
}

/** A single assignment reported back to the user. */
export interface AssignmentItem {
  name: string;
  course_name: string;
  /** Canvas's assignment_id. Either canvas_assignment_id OR skyward_grade_id MUST be set, otherwise the bot fabricated this row. */
  canvas_assignment_id?: string | null;
  skyward_grade_id?: string | null;
  /** Score as percent (0–100) when known. */
  percent?: number | null;
  letter?: string | null;
  status?: "graded" | "missing" | "submitted" | "late" | "excused" | "not_yet_graded" | null;
}

/** The structured output of a procedure execution, prior to formatting for the user. */
export interface ProcedureOutput {
  /** What the user asked for, normalized. */
  request: {
    intent: "PULSE" | "ASSIGNMENT_STATUS" | "CURRICULUM_LOOKUP";
    requested_term?: string | null;     // e.g. "T3" — what the user explicitly asked for
    requested_freshness?: "now" | "today" | null;
    active_school?: string | null;       // current school per agent state
  };
  cells?: GradeCell[];                   // PULSE primary payload
  assignments?: AssignmentItem[];        // PULSE missing/upcoming, or ASSIGNMENT_STATUS
}

export interface HardFail {
  rule: string;
  message: string;
  /** Optional: subset of the cells/assignments that failed, so the retry can target them. */
  offending?: unknown;
}

export interface SoftWarning {
  rule: string;
  message: string;
}

export interface ValidationResult {
  passed: boolean;
  hard_fails: HardFail[];
  soft_warnings: SoftWarning[];
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ValidatorConfig {
  /** Maximum staleness for "now"/"today" requests, in milliseconds. */
  freshness_max_age_ms: number;
  /** Skyward-vs-Canvas percent gap threshold above which SOURCE_AGREEMENT warns. */
  source_agreement_max_pct_gap: number;
  /** Whether to enforce the SCHOOL_MATCH rule (only when active_school is set). */
  require_school_match: boolean;
}

export const DEFAULT_CONFIG: ValidatorConfig = {
  freshness_max_age_ms: 5 * 60 * 1000,
  source_agreement_max_pct_gap: 5,
  require_school_match: true,
};

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Validate a procedure-executor output against the rule set. Returns a
 * `ValidationResult` whose `passed` is false iff any hard-fail rule fired.
 * Soft warnings do not flip `passed` — they're attached to the response.
 */
export function validate(
  output: ProcedureOutput,
  config: ValidatorConfig = DEFAULT_CONFIG,
  now: Date = new Date(),
): ValidationResult {
  const hard: HardFail[] = [];
  const soft: SoftWarning[] = [];

  // Hard rules
  hard.push(...ruleTermMatch(output));
  hard.push(...ruleStructuralAlignment(output));
  hard.push(...ruleDataGidProvenance(output));
  hard.push(...ruleAssignmentProvenance(output));
  hard.push(...ruleNumericSanity(output));
  if (config.require_school_match) {
    hard.push(...ruleSchoolMatch(output));
  }
  hard.push(...ruleFreshness(output, config, now));

  // Soft rules
  soft.push(...ruleSourceAgreement(output, config));

  return {
    passed: hard.length === 0,
    hard_fails: hard,
    soft_warnings: soft,
  };
}

// ---------------------------------------------------------------------------
// Hard-fail rules
// ---------------------------------------------------------------------------

function ruleTermMatch(o: ProcedureOutput): HardFail[] {
  const requested = o.request.requested_term;
  if (!requested || !o.cells) return [];
  const offending = o.cells.filter(
    c => c.term !== null && c.term !== requested && c.term !== "current",
  );
  if (offending.length === 0) return [];
  return [{
    rule: "TERM_MATCH",
    message: `Requested term=${requested} but ${offending.length} cell(s) returned with a different term: ${offending.map(c => `${c.course_name}=${c.term}`).join(", ")}.`,
    offending,
  }];
}

function ruleStructuralAlignment(o: ProcedureOutput): HardFail[] {
  if (!o.cells) return [];
  // Group cells by source. Within Skyward, every cell needs data_gid;
  // within Canvas, every cell needs canvas_course_id.
  // Detect a course-name appearing more than once in the same source — that's
  // either a duplicate row or a misalignment.
  const fails: HardFail[] = [];
  const skywardNames = new Set<string>();
  const skywardDupes: string[] = [];
  for (const c of o.cells.filter(c => c.source === "skyward")) {
    const key = c.course_name.toLowerCase();
    if (skywardNames.has(key)) skywardDupes.push(c.course_name);
    skywardNames.add(key);
  }
  if (skywardDupes.length) {
    fails.push({
      rule: "STRUCTURAL_ALIGNMENT",
      message: `Skyward returned duplicate course rows: ${skywardDupes.join(", ")}. Possible row-zip misalignment — fall back to data-gid-anchored extraction.`,
      offending: skywardDupes,
    });
  }
  return fails;
}

function ruleDataGidProvenance(o: ProcedureOutput): HardFail[] {
  if (!o.cells) return [];
  const offending = o.cells.filter(
    c => c.source === "skyward" && (!c.data_gid || c.data_gid.trim() === ""),
  );
  if (offending.length === 0) return [];
  return [{
    rule: "DATA_GID_PROVENANCE",
    message: `${offending.length} Skyward grade cell(s) lack a data-gid: ${offending.map(c => c.course_name).join(", ")}. A grade without a source row id is fabricated.`,
    offending,
  }];
}

function ruleAssignmentProvenance(o: ProcedureOutput): HardFail[] {
  if (!o.assignments) return [];
  const offending = o.assignments.filter(
    a => !a.canvas_assignment_id && !a.skyward_grade_id,
  );
  if (offending.length === 0) return [];
  return [{
    rule: "ASSIGNMENT_PROVENANCE",
    message: `${offending.length} assignment(s) reported without any source ID: ${offending.map(a => `"${a.name}" in ${a.course_name}`).join(", ")}. An assignment without a Canvas or Skyward id is fabricated.`,
    offending,
  }];
}

function ruleNumericSanity(o: ProcedureOutput): HardFail[] {
  const fails: HardFail[] = [];
  const cells = o.cells ?? [];
  for (const c of cells) {
    if (c.percent != null && (c.percent < 0 || c.percent > 100 || Number.isNaN(c.percent))) {
      fails.push({
        rule: "NUMERIC_SANITY",
        message: `Percent ${c.percent} out of range for course "${c.course_name}".`,
        offending: c,
      });
    }
    if (c.letter != null && c.letter !== "" && !LEGAL_LETTER_GRADES.has(c.letter)) {
      fails.push({
        rule: "NUMERIC_SANITY",
        message: `Letter grade "${c.letter}" is not in the legal set for course "${c.course_name}".`,
        offending: c,
      });
    }
  }
  const assigns = o.assignments ?? [];
  for (const a of assigns) {
    if (a.percent != null && (a.percent < 0 || a.percent > 100 || Number.isNaN(a.percent))) {
      fails.push({
        rule: "NUMERIC_SANITY",
        message: `Percent ${a.percent} out of range for assignment "${a.name}".`,
        offending: a,
      });
    }
    if (a.letter != null && a.letter !== "" && !LEGAL_LETTER_GRADES.has(a.letter)) {
      fails.push({
        rule: "NUMERIC_SANITY",
        message: `Letter grade "${a.letter}" is not in the legal set for assignment "${a.name}".`,
        offending: a,
      });
    }
  }
  return fails;
}

function ruleSchoolMatch(o: ProcedureOutput): HardFail[] {
  const active = o.request.active_school;
  if (!active || !o.cells) return [];
  const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
  const offending = o.cells.filter(
    c => c.school != null && norm(c.school) !== norm(active),
  );
  if (offending.length === 0) return [];
  return [{
    rule: "SCHOOL_MATCH",
    message: `Active school is "${active}" but ${offending.length} cell(s) carry a different school: ${[...new Set(offending.map(c => c.school))].join(", ")}.`,
    offending,
  }];
}

function ruleFreshness(o: ProcedureOutput, cfg: ValidatorConfig, now: Date): HardFail[] {
  if (o.request.requested_freshness !== "now" && o.request.requested_freshness !== "today") {
    return [];
  }
  if (!o.cells) return [];
  const cutoff = now.getTime() - cfg.freshness_max_age_ms;
  const offending = o.cells.filter(c => {
    const t = Date.parse(c.fetched_at);
    return Number.isNaN(t) || t < cutoff;
  });
  if (offending.length === 0) return [];
  return [{
    rule: "FRESHNESS",
    message: `User asked for "${o.request.requested_freshness}" data but ${offending.length} cell(s) are older than ${cfg.freshness_max_age_ms / 1000}s.`,
    offending,
  }];
}

// ---------------------------------------------------------------------------
// Soft-fail rules
// ---------------------------------------------------------------------------

function ruleSourceAgreement(o: ProcedureOutput, cfg: ValidatorConfig): SoftWarning[] {
  if (!o.cells) return [];
  const byCourse = new Map<string, GradeCell[]>();
  for (const c of o.cells) {
    const key = normalizeCourseName(c.course_name);
    if (!byCourse.has(key)) byCourse.set(key, []);
    byCourse.get(key)!.push(c);
  }
  const warnings: SoftWarning[] = [];
  for (const [key, group] of byCourse) {
    const sky = group.find(g => g.source === "skyward");
    const canv = group.find(g => g.source === "canvas");
    if (!sky || !canv) continue;
    if (sky.percent != null && canv.percent != null) {
      const gap = Math.abs(sky.percent - canv.percent);
      if (gap > cfg.source_agreement_max_pct_gap) {
        warnings.push({
          rule: "SOURCE_AGREEMENT",
          message: `Course "${key}": Skyward ${sky.percent}%, Canvas ${canv.percent}% (gap ${gap.toFixed(1)} pts). Skyward is system of record for final grades.`,
        });
      }
    } else if (sky.letter && canv.letter && sky.letter !== canv.letter) {
      warnings.push({
        rule: "SOURCE_AGREEMENT",
        message: `Course "${key}": Skyward ${sky.letter}, Canvas ${canv.letter}. Skyward is system of record for final grades.`,
      });
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize Canvas / Skyward course names to a comparable form.
 *  Lowercase, strip teacher suffix ("- LASTNAME"), strip "Period N",
 *  collapse whitespace.
 *
 *  This is the deterministic match function the procedure executor MUST use
 *  when zipping Canvas course names to Skyward course names — per
 *  docs/LLM_BEHAVIOR_MITIGATIONS.md gap B. Exporting it from the validator
 *  ensures one canonical implementation across the agent.
 */
export function normalizeCourseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s*-\s*[A-Za-z][A-Za-z' ]+$/, "")
    .replace(/\bperiod\s*\d+\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

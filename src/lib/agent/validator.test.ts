/**
 * Unit tests for validator.ts.
 *
 * Each test corresponds to a real bug Sarah caught in the rsdanielbot or
 * msgschoolbot session logs over March-April 2026. The fixtures are
 * minimal — just enough to fire one rule each — and the assertions check
 * that the rule fires on the bad input and stays silent on the good one.
 *
 * Runs with Node 22's built-in test runner (no external deps):
 *   node --test --experimental-strip-types src/lib/agent/validator.test.ts
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  validate,
  normalizeCourseName,
  DEFAULT_CONFIG,
  type ProcedureOutput,
  type GradeCell,
  type AssignmentItem,
} from "./validator.ts";

const FIXED_NOW = new Date("2026-04-28T12:00:00Z");
const FRESH_TIMESTAMP = new Date(FIXED_NOW.getTime() - 60_000).toISOString(); // 1 min ago

function cell(overrides: Partial<GradeCell> = {}): GradeCell {
  return {
    course_name: "Secondary Math 1",
    data_gid: "gid_math1",
    canvas_course_id: null,
    letter: "C",
    percent: 75.21,
    term: "T3",
    source: "skyward",
    fetched_at: FRESH_TIMESTAMP,
    school: "Canyons",
    ...overrides,
  };
}

function output(overrides: Partial<ProcedureOutput> = {}): ProcedureOutput {
  return {
    request: { intent: "PULSE", requested_term: "T3", active_school: "Canyons" },
    cells: [cell()],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// TERM_MATCH
// "Why are you showing me intake number two? Wasn't that last term term two
//  I don't ever wanna see term two I'm only interested in term three"
// ---------------------------------------------------------------------------
describe("TERM_MATCH", () => {
  it("fires when a T2 cell leaks into a T3 request", () => {
    const r = validate(output({
      cells: [cell({ term: "T3" }), cell({ course_name: "Choir", term: "T2", data_gid: "gid_choir" })],
    }), DEFAULT_CONFIG, FIXED_NOW);
    assert.equal(r.passed, false);
    assert.ok(r.hard_fails.some(f => f.rule === "TERM_MATCH"));
  });

  it("passes when all cells match the requested term", () => {
    const r = validate(output(), DEFAULT_CONFIG, FIXED_NOW);
    assert.equal(r.hard_fails.filter(f => f.rule === "TERM_MATCH").length, 0);
  });

  it("treats term=current as universally acceptable", () => {
    const r = validate(output({
      cells: [cell({ term: "current" }), cell({ course_name: "Spanish 2", term: "current", data_gid: "gid_sp2" })],
    }), DEFAULT_CONFIG, FIXED_NOW);
    assert.equal(r.hard_fails.filter(f => f.rule === "TERM_MATCH").length, 0);
  });
});

// ---------------------------------------------------------------------------
// STRUCTURAL_ALIGNMENT
// "Math 3 shows an F but it's actually Spanish 2 that has the F"
// (the canonical row-misalignment bug from SKYWARD_PLAYBOOK.md)
// ---------------------------------------------------------------------------
describe("STRUCTURAL_ALIGNMENT", () => {
  it("fires when Skyward returns the same course twice (duplicate row sign)", () => {
    const r = validate(output({
      cells: [
        cell({ course_name: "Spanish 2", data_gid: "gid_sp2" }),
        cell({ course_name: "Spanish 2", data_gid: "gid_sp2_dupe" }),
      ],
    }), DEFAULT_CONFIG, FIXED_NOW);
    assert.equal(r.passed, false);
    assert.ok(r.hard_fails.some(f => f.rule === "STRUCTURAL_ALIGNMENT"));
  });

  it("does not fire on a clean per-course list", () => {
    const r = validate(output({
      cells: [
        cell({ course_name: "Spanish 2", data_gid: "gid_sp2" }),
        cell({ course_name: "Math 1", data_gid: "gid_m1" }),
      ],
    }), DEFAULT_CONFIG, FIXED_NOW);
    assert.equal(r.hard_fails.filter(f => f.rule === "STRUCTURAL_ALIGNMENT").length, 0);
  });
});

// ---------------------------------------------------------------------------
// DATA_GID_PROVENANCE
// Catches the bot reporting a Skyward grade that isn't tied to a real
// `a[id="showGradeInfo"]` source row — fabrication.
// ---------------------------------------------------------------------------
describe("DATA_GID_PROVENANCE", () => {
  it("fires when a Skyward cell has no data-gid", () => {
    const r = validate(output({
      cells: [cell({ data_gid: null })],
    }), DEFAULT_CONFIG, FIXED_NOW);
    assert.equal(r.passed, false);
    assert.ok(r.hard_fails.some(f => f.rule === "DATA_GID_PROVENANCE"));
  });

  it("does not require data-gid on Canvas cells", () => {
    const r = validate(output({
      cells: [cell({ source: "canvas", data_gid: null, canvas_course_id: "12345" })],
    }), DEFAULT_CONFIG, FIXED_NOW);
    assert.equal(r.hard_fails.filter(f => f.rule === "DATA_GID_PROVENANCE").length, 0);
  });
});

// ---------------------------------------------------------------------------
// ASSIGNMENT_PROVENANCE
// "Where did these get entered as zeros nine and ten? I'm looking on
//  Skyward and I don't see it" — bot invented assignments
// ---------------------------------------------------------------------------
describe("ASSIGNMENT_PROVENANCE", () => {
  const baseAssignment: AssignmentItem = {
    name: "Quiz 5",
    course_name: "Math 1",
    canvas_assignment_id: "789",
    skyward_grade_id: null,
    percent: 83.3,
    status: "graded",
  };

  it("fires when an assignment lacks both source IDs", () => {
    const fabricated: AssignmentItem = {
      ...baseAssignment,
      name: "Mass Rate Test",
      canvas_assignment_id: null,
      skyward_grade_id: null,
    };
    const r = validate(output({
      cells: [],
      assignments: [fabricated],
    }), DEFAULT_CONFIG, FIXED_NOW);
    assert.equal(r.passed, false);
    assert.ok(r.hard_fails.some(f => f.rule === "ASSIGNMENT_PROVENANCE"));
  });

  it("passes when at least one source ID is present", () => {
    const r = validate(output({
      cells: [],
      assignments: [baseAssignment],
    }), DEFAULT_CONFIG, FIXED_NOW);
    assert.equal(r.hard_fails.filter(f => f.rule === "ASSIGNMENT_PROVENANCE").length, 0);
  });
});

// ---------------------------------------------------------------------------
// NUMERIC_SANITY
// Catches OCR/parser drift: "120%" or "Z+" letter grades.
// ---------------------------------------------------------------------------
describe("NUMERIC_SANITY", () => {
  it("fires on percent > 100", () => {
    const r = validate(output({
      cells: [cell({ percent: 120 })],
    }), DEFAULT_CONFIG, FIXED_NOW);
    assert.ok(r.hard_fails.some(f => f.rule === "NUMERIC_SANITY"));
  });

  it("fires on percent < 0", () => {
    const r = validate(output({
      cells: [cell({ percent: -3.5 })],
    }), DEFAULT_CONFIG, FIXED_NOW);
    assert.ok(r.hard_fails.some(f => f.rule === "NUMERIC_SANITY"));
  });

  it("fires on a non-canonical letter grade", () => {
    const r = validate(output({
      cells: [cell({ letter: "Z+" })],
    }), DEFAULT_CONFIG, FIXED_NOW);
    assert.ok(r.hard_fails.some(f => f.rule === "NUMERIC_SANITY"));
  });

  it("accepts legitimate edge values", () => {
    const r = validate(output({
      cells: [cell({ percent: 100, letter: "A" }), cell({ course_name: "Sp", percent: 0, letter: "F", data_gid: "gid_sp" })],
    }), DEFAULT_CONFIG, FIXED_NOW);
    assert.equal(r.hard_fails.filter(f => f.rule === "NUMERIC_SANITY").length, 0);
  });
});

// ---------------------------------------------------------------------------
// SCHOOL_MATCH
// "delete providence hall information for now as it is obsolete" /
// "we are now in canyons not providence hall"
// ---------------------------------------------------------------------------
describe("SCHOOL_MATCH", () => {
  it("fires when a Providence Hall cell shows up after switch to Canyons", () => {
    const r = validate(output({
      cells: [cell({ school: "ProvidenceHall" })],
    }), DEFAULT_CONFIG, FIXED_NOW);
    assert.equal(r.passed, false);
    assert.ok(r.hard_fails.some(f => f.rule === "SCHOOL_MATCH"));
  });

  it("normalizes school comparison case-insensitively", () => {
    const r = validate(output({
      cells: [cell({ school: "canyons" })],
    }), DEFAULT_CONFIG, FIXED_NOW);
    assert.equal(r.hard_fails.filter(f => f.rule === "SCHOOL_MATCH").length, 0);
  });
});

// ---------------------------------------------------------------------------
// FRESHNESS
// "And as current as of right now, not earlier today, but right now"
// ---------------------------------------------------------------------------
describe("FRESHNESS", () => {
  it("fires when 'now' was requested but data is older than the cutoff", () => {
    const stale = new Date(FIXED_NOW.getTime() - 10 * 60 * 1000).toISOString();
    const r = validate(output({
      request: { intent: "PULSE", requested_term: "T3", requested_freshness: "now", active_school: "Canyons" },
      cells: [cell({ fetched_at: stale })],
    }), DEFAULT_CONFIG, FIXED_NOW);
    assert.equal(r.passed, false);
    assert.ok(r.hard_fails.some(f => f.rule === "FRESHNESS"));
  });

  it("does not fire when the user did not ask for now/today", () => {
    const stale = new Date(FIXED_NOW.getTime() - 60 * 60 * 1000).toISOString();
    const r = validate(output({
      cells: [cell({ fetched_at: stale })],
    }), DEFAULT_CONFIG, FIXED_NOW);
    assert.equal(r.hard_fails.filter(f => f.rule === "FRESHNESS").length, 0);
  });

  it("passes when 'now' was requested and data is fresh", () => {
    const r = validate(output({
      request: { intent: "PULSE", requested_term: "T3", requested_freshness: "now", active_school: "Canyons" },
      cells: [cell()],
    }), DEFAULT_CONFIG, FIXED_NOW);
    assert.equal(r.hard_fails.filter(f => f.rule === "FRESHNESS").length, 0);
  });
});

// ---------------------------------------------------------------------------
// SOURCE_AGREEMENT  (soft fail)
// "you gave me choir grade for 3rd quarter 96% I'm looking on skyward
//  and it is 100%??"
// ---------------------------------------------------------------------------
describe("SOURCE_AGREEMENT", () => {
  it("warns when Skyward and Canvas disagree on the same course by >5pts", () => {
    const r = validate(output({
      cells: [
        cell({ source: "skyward", course_name: "WorldWarII", percent: 42.18, letter: "F", data_gid: "gid_ww2" }),
        cell({ source: "canvas", course_name: "WorldWarII", percent: 60, letter: "D-", canvas_course_id: "9070", data_gid: null }),
      ],
    }), DEFAULT_CONFIG, FIXED_NOW);
    assert.equal(r.passed, true);
    assert.ok(r.soft_warnings.some(w => w.rule === "SOURCE_AGREEMENT"));
  });

  it("does not warn when sources agree closely", () => {
    const r = validate(output({
      cells: [
        cell({ source: "skyward", course_name: "Math 1", percent: 75.2, data_gid: "gid_m1" }),
        cell({ source: "canvas", course_name: "Math 1", percent: 76.0, canvas_course_id: "5", data_gid: null }),
      ],
    }), DEFAULT_CONFIG, FIXED_NOW);
    assert.equal(r.soft_warnings.filter(w => w.rule === "SOURCE_AGREEMENT").length, 0);
  });

  it("warns on letter-grade mismatch even without percents", () => {
    const r = validate(output({
      cells: [
        cell({ source: "skyward", course_name: "Drawing", letter: "F", percent: null, data_gid: "gid_dr" }),
        cell({ source: "canvas", course_name: "Drawing", letter: "A", percent: null, canvas_course_id: "8", data_gid: null }),
      ],
    }), DEFAULT_CONFIG, FIXED_NOW);
    assert.ok(r.soft_warnings.some(w => w.rule === "SOURCE_AGREEMENT"));
  });
});

// ---------------------------------------------------------------------------
// normalizeCourseName helper
// "LANGUAGE ARTS 10-BRANNAN" (Canvas) vs "Language Arts 10" (Skyward) —
// procedure executors must use this canonical form when zipping cross-source.
// ---------------------------------------------------------------------------
describe("normalizeCourseName", () => {
  it("strips trailing teacher suffix", () => {
    assert.equal(
      normalizeCourseName("LANGUAGE ARTS 10-BRANNAN"),
      "language arts 10",
    );
  });

  it("strips Period N markers", () => {
    assert.equal(
      normalizeCourseName("Concert Choir Period6"),
      "concert choir",
    );
  });

  it("makes Canvas + Skyward names match after normalization", () => {
    assert.equal(
      normalizeCourseName("LANGUAGE ARTS 10-BRANNAN"),
      normalizeCourseName("Language Arts 10"),
    );
  });
});

// ---------------------------------------------------------------------------
// END-TO-END
// A clean output passes with no fails or warnings.
// A maximally bad output fires multiple rules at once.
// ---------------------------------------------------------------------------
describe("end-to-end", () => {
  it("clean output passes with no warnings", () => {
    const r = validate(output(), DEFAULT_CONFIG, FIXED_NOW);
    assert.equal(r.passed, true);
    assert.equal(r.hard_fails.length, 0);
    assert.equal(r.soft_warnings.length, 0);
  });

  it("a maximally bad output fires multiple rules", () => {
    const stale = new Date(FIXED_NOW.getTime() - 10 * 60 * 1000).toISOString();
    const r = validate({
      request: { intent: "PULSE", requested_term: "T3", requested_freshness: "now", active_school: "Canyons" },
      cells: [
        cell({
          term: "T2",                 // TERM_MATCH
          data_gid: null,             // DATA_GID_PROVENANCE
          percent: 200,               // NUMERIC_SANITY (out of range)
          school: "ProvidenceHall",   // SCHOOL_MATCH
          fetched_at: stale,          // FRESHNESS
        }),
      ],
      assignments: [
        { name: "Made Up", course_name: "Math 1", canvas_assignment_id: null, skyward_grade_id: null }, // ASSIGNMENT_PROVENANCE
      ],
    }, DEFAULT_CONFIG, FIXED_NOW);
    assert.equal(r.passed, false);
    const rulesFired = new Set(r.hard_fails.map(f => f.rule));
    assert.ok(rulesFired.has("TERM_MATCH"));
    assert.ok(rulesFired.has("DATA_GID_PROVENANCE"));
    assert.ok(rulesFired.has("NUMERIC_SANITY"));
    assert.ok(rulesFired.has("SCHOOL_MATCH"));
    assert.ok(rulesFired.has("FRESHNESS"));
    assert.ok(rulesFired.has("ASSIGNMENT_PROVENANCE"));
  });
});

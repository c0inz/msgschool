/**
 * Validation envelope — the structured payload the agent emits alongside its
 * user-facing reply, so the handler can run validator.ts deterministically
 * without re-parsing natural-language prose.
 *
 * Shape on the wire (the agent appends this to its reply):
 *
 *     <msgschool-validate>
 *     {"request":{...},"cells":[...],"assignments":[...]}
 *     </msgschool-validate>
 *
 * The handler:
 *   1. Extracts the JSON via a deterministic regex (see EXTRACT_RE).
 *   2. Strips the envelope from the text before sending to Telegram.
 *   3. Passes the parsed JSON to validate(); retries the agent if hard fails;
 *      attaches soft warnings to the reply.
 *
 * If the envelope is missing the agent's reply ships unvalidated — same
 * behavior as today. This makes the rollout incremental: ship the wiring
 * now, update agent prompts to emit the envelope on PULSE/ASSIGNMENT_STATUS,
 * promote the missing-envelope case to a hard error after the prompts are
 * stable.
 */

import type { ProcedureOutput, SoftWarning } from "../agent/validator.ts";

export const ENVELOPE_OPEN = "<msgschool-validate>";
export const ENVELOPE_CLOSE = "</msgschool-validate>";

const EXTRACT_RE = /<msgschool-validate>\s*([\s\S]*?)\s*<\/msgschool-validate>/;

export interface ExtractResult {
  /** Reply text with the envelope removed and any resulting blank-line runs collapsed. */
  text: string;
  /** Parsed envelope, or null if absent / malformed. */
  envelope: ProcedureOutput | null;
  /** Diagnostic — set when the envelope tag was present but JSON parse failed. */
  parseError?: string;
}

/**
 * Extract the validation envelope from an agent reply. Always returns a
 * stripped text — even when the envelope was unparseable, the malformed tag
 * is removed so the user never sees it.
 */
export function extractEnvelope(reply: string): ExtractResult {
  const match = reply.match(EXTRACT_RE);
  if (!match) {
    return { text: reply, envelope: null };
  }
  const stripped = reply
    .replace(EXTRACT_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();

  let envelope: ProcedureOutput | null = null;
  let parseError: string | undefined;
  try {
    const parsed = JSON.parse(match[1]);
    if (looksLikeEnvelope(parsed)) {
      envelope = parsed as ProcedureOutput;
    } else {
      parseError = "envelope JSON did not match expected shape";
    }
  } catch (err) {
    parseError = err instanceof Error ? err.message : String(err);
  }

  return { text: stripped, envelope, parseError };
}

/**
 * Append soft-warning notes to a reply. Used after validation passes but
 * one or more soft rules fired. Output is appended below the agent's reply
 * with a blank line separator.
 */
export function appendSoftWarnings(text: string, warnings: SoftWarning[]): string {
  if (warnings.length === 0) return text;
  const lines = warnings.map(w => `⚠ ${w.message}`).join("\n");
  return `${text.trimEnd()}\n\n${lines}`;
}

/**
 * Patterns that match the in-progress narration we explicitly forbid in
 * `templates/agent/AGENTS.md` (§"One reply per turn — no narration of
 * in-progress work"). When the model emits one of these as its final reply
 * it has either timed out mid-task or violated the instruction. Either way
 * we don't want to ship it to the user.
 *
 * The model SHOULD never produce these as the final reply because the
 * gateway's `meta.finalAssistantVisibleText` extraction prefers the actual
 * report text. But we observed the regression in prod 2026-04-28 (chat=100000001,
 * "Pulling fresh Skyward grades now — one moment." shipped as a 2-minute
 * delayed final reply), so this is a defensive belt-and-suspenders.
 *
 * Each pattern is regex-cased with /i. Matches either the exact AGENTS.md
 * forbidden examples or close variants the model might generate.
 */
const FORBIDDEN_NARRATION_PATTERNS: ReadonlyArray<RegExp> = [
  // Action verbs that the agent uses to announce what it's about to do.
  // Includes "logging in/into/on", "signing in/into/on", "connecting to" —
  // added 2026-04-28 after the second prod regression: "Logging into Skyward
  // now — back in about a minute with the live grades."
  /\b(pulling|fetching|loading|gathering|grabbing|getting|retrieving|logging\s+(in|into|on)|signing\s+(in|into|on)|connecting\s+to|navigating\s+to|opening)\s+(fresh\s+|the\s+|live\s+)?(skyward|canvas|grade|attendance|assignment|pulse|data|report|gradebook|portal|page|site)/i,
  /\bone\s+moment\b/i,
  /\bhang\s+tight\b/i,
  /\b(give\s+me|just)\s+a\s+(second|moment|minute|sec|few)\b/i,
  // "On it" as a standalone phrase — at start of message or before pause/dash punctuation
  /(?:^|\.\s|\n)on\s+it\b\s*[-—–.,!:]?/i,
  /\b(working\s+on\s+it|let\s+me|i'?ll)\s+(check|verify|pull|fetch|get|grab|look\s+up|run|try|see)/i,
  /\bstill\s+(working|fetching|loading|pulling|gathering)\b/i,
  /\b(this\s+takes|this'?ll\s+take|might\s+take)\s+(a|about)\s+(minute|moment|second|few)/i,
  /\b(checking|loading|fetching|pulling|logging\s+in)\s+(now|currently|right\s+now)\b/i,
  // "Promised follow-up" patterns — the model says it will return with a
  // result. Always narration; the user wants the actual answer in this turn.
  /\bback\s+in\s+(a\s+|about\s+a\s+|about\s+|a\s+couple\s+|a\s+few\s+)?(minute|moment|second|few|sec|while|bit)\b/i,
  /\b(i'?ll|i\s+will)\s+(be\s+)?(back|return)\b/i,
  /\bbe\s+right\s+back\b/i,
  /\bin\s+(a\s+second|a\s+moment|a\s+minute|a\s+sec|just\s+a\s+sec)\b/i,
];

/**
 * Returns the matched forbidden-narration phrase (truncated for logging),
 * or null if the text contains no narration patterns. Empty/whitespace-only
 * inputs return null.
 */
export function detectForbiddenNarration(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  for (const pat of FORBIDDEN_NARRATION_PATTERNS) {
    const m = trimmed.match(pat);
    if (m) return m[0].slice(0, 80);
  }
  return null;
}

/**
 * Patterns that match the freelance-helper-bot output Sonnet emits during
 * onboarding when it ignores AGENTS.md's HARD RULES. Documented regression:
 * 2026-04-29 tg=100000003 — agent asked "Which system does your school
 * use?" (forbidden), labeled options "Option A / Option B" (improvised),
 * said "I keep these secure" (uncalled-for reassurance), used the
 * placeholder URL "yourschool.instructure.com" (we never use placeholders).
 *
 * Even with thinking=off and HARD RULES in AGENTS.md, Sonnet 4.6 produced
 * these patterns repeatedly. Structural enforcement (detect → retry) is
 * the same pattern that fixed narration leaks.
 *
 * Each pattern is regex-cased with /i. A match means Sonnet went off-script
 * during onboarding and should be retried.
 */
const FREELANCE_ONBOARDING_PATTERNS: ReadonlyArray<RegExp> = [
  // Forbidden questions that AGENTS.md HARD RULES explicitly bans
  /\bwhich\s+(system|service|platform|lms|portal)\s+(does\s+)?(your|the)\s+school\s+use\b/i,
  /\bwhat\s+grade\s+(are\s+you\s+in|is\s+your\s+(kid|child|son|daughter|student))\b/i,
  /\bwho\s+are\s+we\s+tracking\b/i,
  /\bwhat\s+can\s+i\s+help\s+you\s+with\b/i,
  // Improvised-options labeling instead of the named scopes
  /\boption\s+a\s*[—\-:]?\s*canvas\b/i,
  /\boption\s+b\s*[—\-:]?\s*skyward\b/i,
  // Helper-bot framing forbidden by HARD RULES
  /\bi'?ll\s+coach\s+you\s+through\s+anything\s+(school|class|study)\s+related\b/i,
  /\bi\s+can\s+help\s+you\s+stay\s+on\s+top\s+of\s+(assignments|grades|deadlines)/i,
  /\bi\s+keep\s+(these|your|them)\s+secure\b/i,
  /\b(paste\s+(your\s+)?grades\s+manually|manual\s+entry|send\s+me\s+screenshots?\s+of)\b/i,
  // Placeholder URLs we never use — generalized to catch any "fake school" form
  /\b(your|my|the)?\s*school[.-]?(instructure|skyward|powerschool|canvas)\.com\b/i,
  /\b(yourschool|myschool|examplehigh|sampleschool)\.\w+\b/i,
  // Continuity language that proves bad-context bleed-through
  /^\s*same\s+answer\b/i,
  // Vague helper-bot offers to "figure it out" from less data
  /\bi'?ll\s+take\s+it\s+from\s+there\b/i,
  /\bi\s+can\s+(try\s+to\s+)?find\s+(it|your|the)\s+(url|school|district|portal)\b/i,
  /\bjust\s+(the|your)\s+school\s+name\s+and\s+i\b/i,
  /\bgive\s+me\s+the\s+school\s+name\b/i,
];

/**
 * Returns the matched freelance-onboarding phrase (truncated for logging),
 * or null if the text doesn't match any pattern. Empty/whitespace-only
 * inputs return null.
 */
export function detectFreelanceOnboarding(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  for (const pat of FREELANCE_ONBOARDING_PATTERNS) {
    const m = trimmed.match(pat);
    if (m) return m[0].slice(0, 120);
  }
  return null;
}

/**
 * OpenClaw's "I have nothing to say" sentinel. Used by the gateway's own
 * pre-compaction memory-flush prompt convention: when the agent is asked
 * "store memories or reply NO_REPLY", the model emits the literal string
 * NO_REPLY meaning "no-op." Discovered 2026-04-28: a validator-retry that
 * used [SYSTEM] as its prompt prefix collided with the same convention
 * and caused the model to emit NO_REPLY back to a real user question
 * ("Has Sam been marked absent or tardy so far today" → "NO_REPLY"
 * shipped to Telegram).
 *
 * We never want this string to reach a user. detect via exact-match or
 * trivial wrapping (whitespace, single quotes, surrounding emoji).
 */
export function isOpenclawNoReply(text: string): boolean {
  const stripped = text.trim().replace(/^["'`]+|["'`]+$/g, "").trim();
  return stripped === "NO_REPLY" || stripped === "NO REPLY";
}

function looksLikeEnvelope(o: unknown): o is ProcedureOutput {
  if (!o || typeof o !== "object") return false;
  const obj = o as Record<string, unknown>;
  if (!obj.request || typeof obj.request !== "object") return false;
  const req = obj.request as Record<string, unknown>;
  if (req.intent !== "PULSE" && req.intent !== "ASSIGNMENT_STATUS" && req.intent !== "CURRICULUM_LOOKUP") {
    return false;
  }
  if (obj.cells != null && !Array.isArray(obj.cells)) return false;
  if (obj.assignments != null && !Array.isArray(obj.assignments)) return false;
  return true;
}

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { extractEnvelope, appendSoftWarnings, detectForbiddenNarration, detectFreelanceOnboarding, isOpenclawNoReply, ENVELOPE_OPEN, ENVELOPE_CLOSE } from "./envelope.ts";

describe("extractEnvelope", () => {
  it("returns the original text and null envelope when absent", () => {
    const r = extractEnvelope("Westons grades today: Math 1 D+, Spanish 2 F.");
    assert.equal(r.envelope, null);
    assert.equal(r.text, "Westons grades today: Math 1 D+, Spanish 2 F.");
  });

  it("strips the envelope from the text and parses the JSON", () => {
    const reply = [
      "Westons grades today:",
      "• Math 1: D+",
      "• Spanish 2: F",
      "",
      ENVELOPE_OPEN,
      JSON.stringify({
        request: { intent: "PULSE", requested_term: "T3", active_school: "Canyons" },
        cells: [
          { course_name: "Math 1", source: "skyward", letter: "D+", percent: 68, term: "T3", data_gid: "g1", fetched_at: "2026-04-28T11:00:00Z", school: "Canyons" },
        ],
      }),
      ENVELOPE_CLOSE,
    ].join("\n");
    const r = extractEnvelope(reply);
    assert.ok(r.envelope, "envelope should parse");
    assert.equal(r.envelope!.request.intent, "PULSE");
    assert.equal(r.envelope!.cells?.length, 1);
    // Stripped text doesn't contain the envelope tags
    assert.equal(r.text.includes(ENVELOPE_OPEN), false);
    assert.equal(r.text.includes(ENVELOPE_CLOSE), false);
    // Stripped text still contains the user-facing prose
    assert.ok(r.text.includes("Math 1: D+"));
  });

  it("strips a malformed envelope and reports the parse error", () => {
    const reply = `Hello!\n${ENVELOPE_OPEN}\nnot json{\n${ENVELOPE_CLOSE}`;
    const r = extractEnvelope(reply);
    assert.equal(r.envelope, null);
    assert.ok(r.parseError);
    assert.equal(r.text.includes(ENVELOPE_OPEN), false);
    assert.equal(r.text.includes(ENVELOPE_CLOSE), false);
    assert.ok(r.text.startsWith("Hello!"));
  });

  it("rejects an envelope JSON that does not match the expected shape", () => {
    const reply = `Reply.\n${ENVELOPE_OPEN}\n{"foo":"bar"}\n${ENVELOPE_CLOSE}`;
    const r = extractEnvelope(reply);
    assert.equal(r.envelope, null);
    assert.ok(r.parseError);
  });

  it("collapses runs of >=3 newlines after stripping", () => {
    const reply = `Line A.\n\n\n${ENVELOPE_OPEN}\n{"request":{"intent":"PULSE"}}\n${ENVELOPE_CLOSE}\n\n\nLine B.`;
    const r = extractEnvelope(reply);
    // No triple-newline runs in the stripped text
    assert.ok(!/\n{3,}/.test(r.text));
  });
});

describe("detectForbiddenNarration", () => {
  // The exact regression that triggered this rule: 2026-04-28 in prod,
  // tg=100000001 received "Pulling fresh Skyward grades now — one moment."
  // 2 minutes after asking "can you give me an update on Sam's grades?"
  it("catches the 2026-04-28 regression phrases", () => {
    // All prod regressions on the same day, same chat (100000001).
    // Each one is here as a named test case so this exact shape can never
    // silently regress again.
    assert.ok(
      detectForbiddenNarration("Pulling fresh Skyward grades now — one moment."),
      "1:20 PM regression",
    );
    assert.ok(
      detectForbiddenNarration("Logging into Skyward now — back in about a minute with the live grades."),
      "1:21 PM regression — logging-into + back-in-a-minute",
    );
    assert.ok(
      detectForbiddenNarration("Logging into Skyward to check attendance — back in a minute."),
      "1:42 PM regression — logging-into-X-to-do-Y + back-in-a-minute",
    );
  });

  it("catches the AGENTS.md forbidden examples by name", () => {
    const cases = [
      "On it — pulling a full pulse report across Canvas and Skyward now.",
      "Let me try a different approach.",
      "Hang tight, this takes about a minute. I'll have it ready shortly.",
      "Fetching grade data now...",
      "Loading Canvas data now",
      "One moment while I check.",
      "Just give me a second.",
      "Still working on it.",
      // Variants that emerged in prod, post-deploy
      "Signing into Skyward, back in a sec.",
      "Connecting to the Canvas API now.",
      "Navigating to the gradebook page now.",
      "Opening Skyward in a sec.",
      "I'll be back with the grades shortly.",
      "Be right back with the report.",
      "Give me a few and I'll have it.",
    ];
    for (const c of cases) {
      assert.ok(detectForbiddenNarration(c), `should detect: "${c}"`);
    }
  });

  it("does not flag legitimate replies that mention Skyward or Canvas", () => {
    const cases = [
      "Westons current grades from Skyward: Math C+, Spanish F.",
      "Skyward shows F (42%), Canvas shows D- (60%). Skyward is system of record.",
      "Hello! Please send me your Canvas access token to begin.",
      "He's missing 3 assignments in Spanish.",
      "",
      "   ",
    ];
    for (const c of cases) {
      assert.equal(detectForbiddenNarration(c), null, `should not detect in: "${c}"`);
    }
  });
});

describe("detectFreelanceOnboarding", () => {
  it("catches the 2026-04-29 regression phrases (tg=100000003)", () => {
    // Five actual prod replies that violated HARD RULES:
    assert.ok(
      detectFreelanceOnboarding("Which system does your school use? Canvas, Skyward, or something else?"),
      "first regression — forbidden 'which system does your school use'",
    );
    assert.ok(
      detectFreelanceOnboarding("**Option A — Canvas:**\n> Share your Canvas URL"),
      "second regression — improvised 'Option A — Canvas' labeling",
    );
    assert.ok(
      detectFreelanceOnboarding("Same answer, unfortunately — I'm not connected"),
      "third regression — bad-context bleed-through",
    );
    assert.ok(
      detectFreelanceOnboarding("Something like myschool.instructure.com or myschool.skyward.com"),
      "fourth regression — placeholder myschool URL",
    );
    assert.ok(
      detectFreelanceOnboarding("Tell me your school's Canvas URL and I'll take it from there."),
      "fifth regression — vague 'I'll take it from there'",
    );
  });

  it("catches the AGENTS.md HARD-RULES forbidden patterns", () => {
    const cases = [
      "What grade are you in?",
      "What grade is your kid in?",
      "Who are we tracking — is this for you, or for a kid?",
      "What can I help you with today?",
      "Option A — Canvas, Option B — Skyward",
      "Option B — Skyward: share your URL",
      "I can help you stay on top of assignments, grades, deadlines",
      "I keep these secure and only use them to fetch your data",
      "Paste your grades manually and I'll track them",
      "Send me screenshots of your gradebook",
      "yourschool.instructure.com",
    ];
    for (const c of cases) {
      assert.ok(detectFreelanceOnboarding(c), `should detect: "${c}"`);
    }
  });

  it("does not flag legitimate scope-picker output", () => {
    const cases = [
      "Scope 1: Canvas API — the easiest and most important.",
      "You provide: Canvas URL + API token",
      "Skyward is the system of record for the official grade.",
      "Got it, John. Which scopes do you want — all three is the full picture?",
      "I'd need Scope 3 (Skyward credentials) to answer that.",
      "Hello!",
      "",
    ];
    for (const c of cases) {
      assert.equal(detectFreelanceOnboarding(c), null, `should not flag: "${c}"`);
    }
  });
});

describe("isOpenclawNoReply", () => {
  // 2026-04-28 4:42 PM regression — chat=100000001 received literal "NO_REPLY"
  // after the validator-retry prompt collided with OpenClaw's memory-flush channel.
  it("catches the bare NO_REPLY sentinel", () => {
    assert.equal(isOpenclawNoReply("NO_REPLY"), true);
  });

  it("catches NO_REPLY with surrounding whitespace", () => {
    assert.equal(isOpenclawNoReply("  NO_REPLY  "), true);
    assert.equal(isOpenclawNoReply("\nNO_REPLY\n"), true);
  });

  it("catches NO_REPLY with surrounding quotes (model sometimes wraps)", () => {
    assert.equal(isOpenclawNoReply('"NO_REPLY"'), true);
    assert.equal(isOpenclawNoReply("'NO_REPLY'"), true);
    assert.equal(isOpenclawNoReply("`NO_REPLY`"), true);
  });

  it("catches the space-separated variant", () => {
    assert.equal(isOpenclawNoReply("NO REPLY"), true);
  });

  it("does not flag prose that mentions NO_REPLY in passing", () => {
    assert.equal(
      isOpenclawNoReply("If nothing to store, reply NO_REPLY in the next turn."),
      false,
    );
    assert.equal(isOpenclawNoReply("Westons grades: NO_REPLY isn't a grade."), false);
  });

  it("is false for empty/blank/legitimate text", () => {
    assert.equal(isOpenclawNoReply(""), false);
    assert.equal(isOpenclawNoReply("   "), false);
    assert.equal(isOpenclawNoReply("Got it."), false);
    assert.equal(isOpenclawNoReply("No reply yet from the teacher."), false);
  });
});

describe("appendSoftWarnings", () => {
  it("returns text unchanged when there are no warnings", () => {
    assert.equal(appendSoftWarnings("hello", []), "hello");
  });

  it("appends each warning on its own line below the text", () => {
    const out = appendSoftWarnings("Grades pulled.", [
      { rule: "SOURCE_AGREEMENT", message: "WW2: Skyward F (42%), Canvas D- (60%). Skyward is system of record." },
    ]);
    assert.ok(out.startsWith("Grades pulled."));
    assert.ok(out.includes("⚠ WW2: Skyward F (42%)"));
  });

  it("appends multiple warnings, one per line", () => {
    const out = appendSoftWarnings("ok", [
      { rule: "SOURCE_AGREEMENT", message: "first" },
      { rule: "SOURCE_AGREEMENT", message: "second" },
    ]);
    const lines = out.split("\n");
    assert.equal(lines.filter(l => l.startsWith("⚠")).length, 2);
  });
});

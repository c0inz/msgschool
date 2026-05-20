/**
 * Credential detector. Classifies inbound Telegram messages into structured
 * credential fields that the platform stores encrypted. Runs synchronously
 * against the message text + optional conversational context (what the agent
 * last asked the user for).
 *
 * Design principle: be permissive on detection, strict on classification.
 * We'd rather delete an innocent-looking paste from chat and have the user
 * say "huh that wasn't a credential" than miss a real credential and let it
 * linger in chat forever.
 *
 * No external dependencies. Pure function; easy to unit test.
 */

export type Service = "canvas" | "skyward";

export type Field =
  | "canvas.url"
  | "canvas.login_url"
  | "canvas.username"
  | "canvas.password"
  | "canvas.token"
  | "skyward.url"
  | "skyward.username"
  | "skyward.password";

export type Confidence = "high" | "medium" | "low";

export interface DetectedField {
  field: Field;
  value: string;
  confidence: Confidence;
  /** Human-readable reason for classification (for debug/shadow mode logs). */
  why: string;
}

export interface DetectionResult {
  /** True if anything looked credential-shaped, regardless of classifiability. */
  hasAnyCredential: boolean;
  /** Successfully classified fields (ready to merge into credentials/*.json). */
  fields: DetectedField[];
  /** Raw lines that matched a pattern but couldn't be classified to a field. */
  ambiguous: Array<{ line: string; reason: string }>;
}

export interface DetectionContext {
  /**
   * The recent outbound asks the agent has made to this user, newest first.
   * The detector scans these for cues like "your Canvas URL" or "your Skyward
   * username" to disambiguate bare pastes.
   */
  recentAgentText?: string[];
}

// ---- regexes ----
const CANVAS_URL_RE = /\bhttps?:\/\/([a-z0-9\-]+)\.instructure\.com(?:\/[^\s]*)?/i;
const CANVAS_LDAP_RE = /\bhttps?:\/\/[^\s]+\.instructure\.com\/login\/(ldap|saml)\b/i;
const SKYWARD_URL_RE = /\bhttps?:\/\/[^\s]+\bwsisa\.dll\b[^\s]*/i;

// Labeled line: "<field>: value" or "<field> = value", tolerant of bullet prefixes.
const LABEL_LINE_RE =
  /^\s*(?:[\-\*•\d.)]+\s+)*([a-zA-Z][a-zA-Z0-9 _\-]+?)\s*[:=]\s*(\S.+?)\s*$/;

// An opaque identifier-safe string 40+ chars with no whitespace — likely a token.
const OPAQUE_BLOB_RE = /^[A-Za-z0-9~_\-+/=]{40,}$/;

// Canvas Personal Access Token shape: <user_id_digits>~<base62 chars 30+>.
// This is unique to Canvas — no other service we touch issues this format.
// Match without anchors so it works inside a labeled value too.
const CANVAS_TOKEN_RE = /\b\d{1,12}~[A-Za-z0-9_\-]{30,}\b/;

// ---- helpers ----

function isLikelyUrl(s: string): boolean {
  return /^https?:\/\//i.test(s.trim());
}

function normalizeCanvasUrl(raw: string): string {
  const m = raw.match(CANVAS_URL_RE);
  if (!m) return raw.trim();
  // Strip any path; keep origin only for the primary url field
  return `https://${m[1]}.instructure.com`;
}

function labelToField(label: string): Field | null {
  const l = label.toLowerCase().replace(/\s+/g, " ").trim();

  // Canvas — explicitly disambiguated by "canvas" prefix OR a clear Canvas-only word
  if (/canvas.*(url|domain|host|site|endpoint)/.test(l)) return "canvas.url";
  if (/canvas.*(login.?url|sso.?url)/.test(l)) return "canvas.login_url";
  if (/canvas.*(user(name)?|login|id)/.test(l)) return "canvas.username";
  if (/canvas.*(password|pass|pw)/.test(l)) return "canvas.password";
  if (/canvas.*(token|api.?key|pat|access.?token|personal.?access.?token)/.test(l)) return "canvas.token";

  // Skyward — explicit "skyward"
  if (/skyward.*(url|portal|domain|host|link|endpoint)/.test(l)) return "skyward.url";
  if (/skyward.*(user(name)?|login|id)/.test(l)) return "skyward.username";
  if (/skyward.*(password|pass|pw)/.test(l)) return "skyward.password";

  // Bare labels — need context to disambiguate; mark as ambiguous by returning null
  // Callers pass the whole labeled line down into classify(), which handles bare
  // labels against the conversational context.
  return null;
}

/**
 * Stronger second-pass classifier: when a label is just "canvas" (no
 * sub-word), look at the value shape to figure out what it is. A
 * Canvas-token-shaped value gives away the field even if the label
 * didn't. This catches user-friendly pastes like `Canvas: 6~abc...`.
 */
function bareCanvasLabelByValue(label: string, value: string): Field | null {
  const l = label.toLowerCase().replace(/\s+/g, " ").trim();
  if (l !== "canvas") return null;
  if (CANVAS_TOKEN_RE.test(value)) return "canvas.token";
  if (CANVAS_URL_RE.test(value)) return "canvas.url";
  return null;
}

/**
 * Bare-label → field using conversational context. Returns null if context is
 * absent or ambiguous. Only handles the common onboarding words.
 */
function bareFieldFromContext(label: string, ctx: DetectionContext): Field | null {
  const l = label.toLowerCase().replace(/\s+/g, " ").trim();
  const ctxJoined = (ctx.recentAgentText ?? []).slice(0, 3).join("\n").toLowerCase();
  const talkingCanvas = /canvas/.test(ctxJoined);
  const talkingSkyward = /skyward/.test(ctxJoined);

  // Bare "url" → whichever service the agent last mentioned; if both, ambiguous.
  if (l === "url" || l === "portal" || l === "portal url" || l === "domain") {
    if (talkingCanvas && !talkingSkyward) return "canvas.url";
    if (talkingSkyward && !talkingCanvas) return "skyward.url";
    return null;
  }
  if (l === "login url") {
    if (talkingCanvas && !talkingSkyward) return "canvas.login_url";
    if (talkingSkyward && !talkingCanvas) return null; // skyward doesn't have a login_url in our schema
    return null;
  }
  if (/^user(name)?|^login$|^id$/.test(l)) {
    if (talkingCanvas && !talkingSkyward) return "canvas.username";
    if (talkingSkyward && !talkingCanvas) return "skyward.username";
    return null;
  }
  if (/^(password|pass|pw)$/.test(l)) {
    if (talkingCanvas && !talkingSkyward) return "canvas.password";
    if (talkingSkyward && !talkingCanvas) return "skyward.password";
    return null;
  }
  if (/^(token|api.?key|pat|access.?token)$/.test(l)) {
    return "canvas.token"; // Skyward has no token concept
  }
  return null;
}

/**
 * Main entry point. Scans `text` line-by-line plus a couple of full-text
 * shape passes (for tokens and URLs that may appear mid-line), returns a
 * structured result.
 *
 * Section context: lines like "Canvas credentials" or "Canyons Canvas
 * specific:" set a service section that subsequent bare-labeled lines
 * inherit, so `Username: jsmith001` under a Canvas header classifies as
 * canvas.username instead of going to ambiguous.
 */
export function detect(text: string, ctx: DetectionContext = {}): DetectionResult {
  const out: DetectionResult = { hasAnyCredential: false, fields: [], ambiguous: [] };
  const raw = (text ?? "").replace(/\r\n/g, "\n");
  const lines = raw.split("\n");

  const pushField = (field: Field, value: string, confidence: "high" | "medium" | "low", why: string) => {
    if (out.fields.some((f) => f.field === field)) return;
    const normalized = normalizeValue(field, value);
    if (normalized == null) return;
    out.fields.push({ field, value: normalized, confidence, why });
    out.hasAnyCredential = true;
  };

  // ---- Full-text shape passes ----
  // These extract values whose shape is unique to a specific service, so
  // they can be classified without label or section context. Run first so
  // they win if line-level logic later sees the same value.

  // Canvas PAT — digits~base62, 30+ chars after the tilde. Unique shape;
  // works inside prose ("Canvas API 6~xxxx").
  const tokenMatch = raw.match(CANVAS_TOKEN_RE);
  if (tokenMatch) {
    pushField("canvas.token", tokenMatch[0], "high", "Canvas PAT shape (digits~base62)");
  }
  // instructure.com URLs anywhere. Distinguish canonical (no /login/...)
  // from LDAP/SAML login URL.
  const instructureMatches = [...raw.matchAll(/\bhttps?:\/\/[a-z0-9\-]+\.instructure\.com(?:\/[^\s]*)?/gi)];
  let canonicalCanvasUrl: string | null = null;
  let ldapCanvasUrl: string | null = null;
  for (const m of instructureMatches) {
    if (/\/login\/(ldap|saml)\b/i.test(m[0])) ldapCanvasUrl = m[0];
    else if (!canonicalCanvasUrl) canonicalCanvasUrl = m[0];
  }
  if (canonicalCanvasUrl) {
    pushField("canvas.url", canonicalCanvasUrl, "high", "instructure.com URL");
  } else if (ldapCanvasUrl) {
    pushField("canvas.url", ldapCanvasUrl, "medium", "instructure.com origin derived from LDAP URL");
  }
  if (ldapCanvasUrl) {
    pushField("canvas.login_url", ldapCanvasUrl, "high", "Canvas LDAP/SAML URL shape");
  }
  // Skyward portal URL anywhere.
  const swUrlMatch = raw.match(SKYWARD_URL_RE);
  if (swUrlMatch) {
    pushField("skyward.url", swUrlMatch[0], "high", "Skyward wsisa.dll URL shape");
  }

  // ---- Line-by-line pass with section state ----
  // Section is set by header lines ("Canvas credentials", "Skyward
  // credentials", "Canyons Canvas specific:") AND by labeled lines whose
  // label includes the service name. Persists across blank lines until
  // another section header overrides it.
  let section: "canvas" | "skyward" | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Section header heuristic: a non-labeled line whose first word is
    // 'canvas' or 'skyward'. Also: a heading like "Canyons Canvas
    // specific:" that ends in ':'. We catch both by looking for the
    // service name as a word in a header-shaped line.
    const hasColonOrEquals = /[:=]/.test(line);
    const headerCandidate = !hasColonOrEquals || /:\s*$/.test(line);
    if (headerCandidate) {
      const lower = line.toLowerCase();
      if (/\bcanvas\b/.test(lower) && !/\bskyward\b/.test(lower)) section = "canvas";
      else if (/\bskyward\b/.test(lower) && !/\bcanvas\b/.test(lower)) section = "skyward";
    }

    // Labeled line: "<label>: value" or "<label> = value", with optional
    // bullet prefix.
    const labelMatch = line.match(LABEL_LINE_RE);
    if (labelMatch) {
      const label = labelMatch[1];
      const value = labelMatch[2];
      const lLabel = label.toLowerCase().replace(/\s+/g, " ").trim();

      // A labeled line with "canvas" or "skyward" in the label also acts
      // as a section signal for subsequent bare-labeled lines.
      if (lLabel.includes("canvas")) section = "canvas";
      else if (lLabel.includes("skyward")) section = "skyward";

      if (!value) continue;

      let field = labelToField(label);
      if (!field) field = bareFieldFromContext(label, ctx);
      if (!field) field = bareCanvasLabelByValue(label, value);

      // Section-aware fallback: if we know which service we're inside,
      // bare labels like "URL"/"Username"/"Password" pick up the service.
      if (!field && section) {
        if (/^user(name)?|^login$|^id$/.test(lLabel)) {
          field = `${section}.username` as Field;
        } else if (/^(password|pass|pw)$/.test(lLabel)) {
          field = `${section}.password` as Field;
        } else if (lLabel === "url" || lLabel === "portal" || lLabel === "portal url" || lLabel === "domain" || lLabel === "host") {
          field = `${section}.url` as Field;
        } else if (lLabel === "login url" && section === "canvas") {
          field = "canvas.login_url";
        } else if ((lLabel === "token" || lLabel === "api token" || lLabel === "access token" || lLabel === "pat") && section === "canvas") {
          field = "canvas.token";
        }
      }

      if (field) {
        const why = section
          ? `labeled '${label}' under ${section} section`
          : `labeled prefix '${label}'`;
        pushField(field, value, labelToField(label) ? "high" : "medium", why);
        continue;
      }

      // Labeled but unclassifiable AND no section to inherit — only
      // record as ambiguous if the value looks secret-shaped.
      if (looksLikeSecret(value)) {
        out.ambiguous.push({ line, reason: `unknown label '${label}' with secret-shaped value` });
        out.hasAnyCredential = true;
      }
      continue;
    }

    // Bare opaque blob — 40+ chars, no whitespace, identifier-safe.
    // The full-text token pass above will already have grabbed it if it
    // matched CANVAS_TOKEN_RE; this branch is for non-Canvas-shaped blobs.
    if (OPAQUE_BLOB_RE.test(line)) {
      const ctxJoined = (ctx.recentAgentText ?? []).slice(0, 3).join("\n").toLowerCase();
      if (/canvas.*token|access.?token|api.?token|new access token|approved integrations/.test(ctxJoined)) {
        pushField("canvas.token", line, "high", "40+ char opaque blob and agent recently asked for Canvas token");
      } else if (!out.fields.some((f) => f.field === "canvas.token")) {
        out.ambiguous.push({ line, reason: "40+ char opaque blob, no context for which field" });
        out.hasAnyCredential = true;
      }
      continue;
    }

    // Not a credential line.
  }

  return out;
}

/**
 * Light shape validation per field. Returns the normalized value to store,
 * or null if the value clearly doesn't fit the field shape (e.g., the user
 * typed "Canvas URL: my school" — reject, don't store garbage).
 */
function normalizeValue(field: Field, value: string): string | null {
  const v = value.trim();
  switch (field) {
    case "canvas.url": {
      const m = v.match(CANVAS_URL_RE);
      if (!m) {
        // Accept a bare subdomain.instructure.com without https:// as a soft match
        if (/^[a-z0-9\-]+\.instructure\.com$/i.test(v)) return `https://${v.toLowerCase()}`;
        return null;
      }
      return normalizeCanvasUrl(m[0]);
    }
    case "canvas.login_url": {
      const m = v.match(CANVAS_LDAP_RE);
      return m ? m[0] : null;
    }
    case "skyward.url": {
      const m = v.match(SKYWARD_URL_RE);
      return m ? m[0] : null;
    }
    case "canvas.token":
      if (!OPAQUE_BLOB_RE.test(v)) return null;
      return v;
    case "canvas.username":
    case "skyward.username":
      // No whitespace, 3+ chars, not an email
      if (/\s/.test(v)) return null;
      if (v.length < 3) return null;
      if (/@/.test(v)) return null; // msgschool.com canvas/skyward accounts use school login, not emails
      return v;
    case "canvas.password":
    case "skyward.password":
      // Any non-whitespace run of 4+ chars
      if (/\s/.test(v)) return null;
      if (v.length < 4) return null;
      return v;
    default:
      return null;
  }
}

function looksLikeSecret(v: string): boolean {
  const s = v.trim();
  if (s.length < 6) return false;
  if (/\s/.test(s) && s.split(/\s/).length > 3) return false; // prose, not a value
  return true;
}

/**
 * Group detected fields into per-service partial-creds objects the caller can
 * feed directly into credential-store.mergeCreds.
 */
export function groupByService(fields: DetectedField[]): {
  canvas?: Record<string, string>;
  skyward?: Record<string, string>;
} {
  const out: { canvas?: Record<string, string>; skyward?: Record<string, string> } = {};
  for (const f of fields) {
    const [svc, key] = f.field.split(".") as [Service, string];
    (out[svc] ??= {})[key] = f.value;
  }
  return out;
}

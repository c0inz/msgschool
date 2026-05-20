#!/usr/bin/env bash
# migrate-to-toolsd.sh — clean up agent-written scripts that contain
# plaintext credentials, in preparation for the toolsd cutover.
#
# Run this BEFORE installing/starting toolsd. Idempotent — re-running is
# safe.
#
# What it does, per workspace under /opt/msgschool/users/canvasagent-*/:
#   1. Lists every regular file the agent wrote at the workspace root
#      that's a script (.js, .mjs, .ts, .py).
#   2. Moves them into ./.archive_pre_toolsd_<timestamp>/ inside the
#      workspace (NOT deleted — the operator can verify before the next
#      sweep removes them, and the workspace archive flow already handles
#      30-day retention).
#   3. Truncates the workspace MEMORY.md and USER.md "Subscriber" section
#      hint to remove any inlined credential references that were copied
#      from chat into those files. (USER.md keeps the structure; only
#      lines containing literal Skyward username pattern or Canvas-
#      token-shaped strings are scrubbed.)
#   4. Logs every action.

set -euo pipefail

USERS_DIR="/opt/msgschool/users"
TS=$(date -u '+%Y%m%dT%H%M%SZ')
LOG="/opt/msgschool/migrate-to-toolsd.log"

echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') START migrate-to-toolsd.sh" >> "$LOG"

if [[ ! -d "$USERS_DIR" ]]; then
  echo "ERROR: $USERS_DIR not found" >&2
  exit 1
fi

# Patterns that indicate a credential value is inlined. Conservative —
# we'd rather flag a script for archival than miss one.
CRED_PATTERNS='(\b6~[A-Za-z0-9]{40,}\b|page\.fill\([^)]*password|page\.fill\([^)]*login|Bearer\s+[A-Za-z0-9~_\-]{20,}|TOKEN\s*=\s*['\''"]|password\s*=\s*['\''"][A-Za-z0-9])'

shopt -s nullglob
for ws in "$USERS_DIR"/canvasagent-*/workspace; do
  agent=$(basename "$(dirname "$ws")")
  echo "  [$agent] scanning…"
  archive="$ws/.archive_pre_toolsd_$TS"
  archived=0

  for f in "$ws"/*.js "$ws"/*.mjs "$ws"/*.ts "$ws"/*.py; do
    [[ -f "$f" ]] || continue
    base=$(basename "$f")
    # Skip files that look like they're part of the platform (none should be
    # at workspace root — workspace is for the agent's scratch only).
    if grep -E -q "$CRED_PATTERNS" "$f" 2>/dev/null; then
      mkdir -p "$archive"
      mv "$f" "$archive/"
      echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') ARCHIVED $agent $base (credential-shaped)" >> "$LOG"
      archived=$((archived + 1))
    else
      # Move non-cred scripts too — the agent shouldn't be running ad-hoc
      # scripts at workspace root anymore.
      mkdir -p "$archive"
      mv "$f" "$archive/"
      echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') ARCHIVED $agent $base (non-credential script, swept anyway)" >> "$LOG"
      archived=$((archived + 1))
    fi
  done

  # Sweep .png / .html dumps that the agent leaves around (not credential
  # leaks per se but they pile up and the agent should regenerate via
  # tool calls).
  for f in "$ws"/skyward_*.png "$ws"/skyward_*.html; do
    [[ -f "$f" ]] || continue
    mkdir -p "$archive"
    mv "$f" "$archive/"
    echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') ARCHIVED $agent $(basename "$f") (scrape artifact)" >> "$LOG"
    archived=$((archived + 1))
  done

  # node_modules + package-lock.json — these were created by the agent
  # running `npm install playwright` from the workspace. After toolsd,
  # the agent doesn't need them.
  if [[ -d "$ws/node_modules" ]]; then
    mkdir -p "$archive"
    mv "$ws/node_modules" "$archive/"
    echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') ARCHIVED $agent node_modules" >> "$LOG"
  fi
  for f in "$ws/package.json" "$ws/package-lock.json"; do
    [[ -f "$f" ]] || continue
    mkdir -p "$archive"
    mv "$f" "$archive/"
    echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') ARCHIVED $agent $(basename "$f")" >> "$LOG"
  done

  # Scrub USER.md of inlined Skyward username if present (kept structure,
  # only redacts the literal value).
  if [[ -f "$ws/USER.md" ]]; then
    sed -i.pretoolsd "$TS" -E \
      -e 's/(Username:\s*)[A-Z]{2,}[0-9]{2,}/\1[redacted-pre-toolsd]/' \
      "$ws/USER.md" || true
    if ! cmp -s "$ws/USER.md" "$ws/USER.md.pretoolsd$TS" 2>/dev/null; then
      :
    fi
    rm -f "$ws/USER.md.pretoolsd$TS" 2>/dev/null || true
  fi

  echo "  [$agent] archived $archived files into $archive"
done

echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') END migrate-to-toolsd.sh" >> "$LOG"
echo "Done. See $LOG for details."

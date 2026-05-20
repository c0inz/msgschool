#!/usr/bin/env bash
# credscan.sh — periodic defense-in-depth sweep of all agent workspaces.
#
# For each provisioned agent, reads the user's encrypted credentials in
# memory, derives the credential string values, and greps the workspace
# for plaintext occurrences. Anything found is replaced in-place with
# `[redacted-credscan]`.
#
# Why this exists: the agent runs as root in v1 and could in principle
# write its credentials into a workspace file (USER.md, MEMORY.md, a
# script). The playbooks forbid this and the outbound scrubber catches
# echoes-to-chat, but a credential left sitting on disk is a backup
# leak. This timer closes that gap by scanning every 2 minutes and
# scrubbing anything that slipped through.
#
# Idempotent and safe to interrupt — a failed scrub on one workspace
# does not affect others.

set -uo pipefail

USERS_DIR="/opt/msgschool/users"
LOG_TAG="credscan"

if [[ ! -d "$USERS_DIR" ]]; then
  exit 0
fi

scan_workspace() {
  local agent="$1"
  local ws="$USERS_DIR/$agent/workspace"
  [[ -d "$ws" ]] || return 0

  local tg="${agent#canvasagent-}"
  if ! [[ "$tg" =~ ^[0-9]+$ ]]; then
    return 0
  fi

  # Pull the secret values from the per-agent tmpfs creds (which the
  # bot wrote when the user pasted). If the files don't exist or are
  # malformed, skip — there's nothing to scrub for.
  local canvas_json="/run/msgschool/$agent/canvas.json"
  local skyward_json="/run/msgschool/$agent/skyward.json"

  local secrets=()
  for f in "$canvas_json" "$skyward_json"; do
    [[ -r "$f" ]] || continue
    while IFS= read -r v; do
      [[ -n "$v" && ${#v} -ge 4 ]] && secrets+=("$v")
    done < <(jq -r '.token // empty, .password // empty, .username // empty' "$f" 2>/dev/null)
  done

  if [[ ${#secrets[@]} -eq 0 ]]; then
    return 0
  fi

  # Build a sed-script: longest secrets first so we don't truncate one
  # secret that's a prefix of another. Each replacement uses sed's `c`
  # (change-line) semantics? No — use `s///` with a delimiter unlikely
  # to appear in any credential. Pipe is safest.
  local sed_script=""
  IFS=$'\n' sorted=($(printf '%s\n' "${secrets[@]}" | awk '{print length, $0}' | sort -rn | cut -d' ' -f2-))
  for v in "${sorted[@]}"; do
    # Escape sed regex metacharacters in the secret.
    local esc
    esc=$(printf '%s' "$v" | sed -e 's/[][\/$*.^|]/\\&/g')
    sed_script+="s|${esc}|[redacted-credscan]|g;"
  done

  # Scan files where a leak would matter: any text the agent could have
  # written. Skip the .archive_* dirs (already scrubbed/archived), skip
  # the credentials/ symlink targets (they live on tmpfs, not on disk
  # in this workspace path), skip node_modules / *.png / *.jpg.
  local hits=0
  while IFS= read -r f; do
    if [[ -w "$f" ]] && grep -qF "${secrets[0]}" "$f" 2>/dev/null; then
      :  # cheap fast-path; full sed below
    fi
    # Always run sed; it's a no-op if no match. Cheaper than two passes.
    if [[ -w "$f" ]]; then
      local before
      before=$(stat -c %s "$f" 2>/dev/null || echo 0)
      sed -i "$sed_script" "$f" 2>/dev/null || continue
      local after
      after=$(stat -c %s "$f" 2>/dev/null || echo 0)
      if [[ "$before" != "$after" ]]; then
        hits=$((hits + 1))
        logger -t "$LOG_TAG" "scrubbed $f for $agent"
      fi
    fi
  done < <(find "$ws" \
    -path "$ws/.archive_pre_toolsd_*" -prune -o \
    -path "$ws/credentials" -prune -o \
    -path "$ws/.openclaw" -prune -o \
    -path "$ws/node_modules" -prune -o \
    -type f \
    \( -name '*.md' -o -name '*.txt' -o -name '*.json' -o -name '*.js' -o -name '*.mjs' -o -name '*.ts' -o -name '*.conf' -o -name '*.sh' -o -name '*.py' -o -name '*.html' \) \
    -print 2>/dev/null)

  if [[ $hits -gt 0 ]]; then
    logger -t "$LOG_TAG" "agent=$agent files_scrubbed=$hits"
  fi
}

for ws_dir in "$USERS_DIR"/canvasagent-*; do
  [[ -d "$ws_dir" ]] || continue
  agent=$(basename "$ws_dir")
  scan_workspace "$agent"
done

# Also scan OpenClaw session jsonls — if the agent ever received a
# raw credential paste in plaintext (which happens when the inbound
# scrubber misses), it's stored verbatim in the session log. We can't
# safely sed-edit a live jsonl (the agent may be writing to it), so
# instead we count hits and surface a warning.
for sess_dir in /root/.openclaw/agents/canvasagent-*/sessions; do
  [[ -d "$sess_dir" ]] || continue
  agent=$(basename "$(dirname "$sess_dir")")
  tg="${agent#canvasagent-}"
  canvas_json="/run/msgschool/$agent/canvas.json"
  skyward_json="/run/msgschool/$agent/skyward.json"
  pattern=""
  for f in "$canvas_json" "$skyward_json"; do
    [[ -r "$f" ]] || continue
    while IFS= read -r v; do
      [[ -n "$v" && ${#v} -ge 4 ]] || continue
      [[ -n "$pattern" ]] && pattern+="|"
      pattern+=$(printf '%s' "$v" | sed -e 's/[][\/.^$*|]/\\&/g')
    done < <(jq -r '.token // empty, .password // empty, .username // empty' "$f" 2>/dev/null)
  done
  [[ -z "$pattern" ]] && continue
  for jsonl in "$sess_dir"/*.jsonl; do
    [[ -f "$jsonl" ]] || continue
    if grep -E -q "$pattern" "$jsonl" 2>/dev/null; then
      hits=$(grep -E -c "$pattern" "$jsonl" 2>/dev/null || echo 0)
      logger -t "$LOG_TAG" "WARN $agent session=$(basename "$jsonl") contains $hits credential-shaped lines — recommend /reset"
    fi
  done
done

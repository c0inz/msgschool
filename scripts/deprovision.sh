#!/usr/bin/env bash
# deprovision.sh — remove a user's OpenClaw agent.
#
# Inverse of provision.sh. Archives the workspace (no delete), removes the
# agent entry + binding from openclaw.json, reloads the gateway. Does NOT
# touch the msgschool Postgres tables — that's handled by the TS caller.
#
# Usage:  deprovision.sh --telegram-id <id>

set -euo pipefail

USERS_DIR="/opt/msgschool/users"
ARCHIVED_DIR="/opt/msgschool/archived"
OPENCLAW_CONFIG="${HOME:-/root}/.openclaw/openclaw.json"
OPENCLAW_AGENTS_DIR="${HOME:-/root}/.openclaw/agents"
PROVISION_LOG="/opt/msgschool/provision.log"

TELEGRAM_ID=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --telegram-id) TELEGRAM_ID="$2"; shift 2 ;;
    *) echo "ERROR: unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$TELEGRAM_ID" ]]; then
  echo "ERROR: --telegram-id is required" >&2
  exit 2
fi

AGENT_ID="canvasagent-${TELEGRAM_ID}"
echo "deprovision: agent=$AGENT_ID"

# --- archive workspace; HARD-DELETE openclaw session jsonls ---
# Workspace (PERSONA, USER, MEMORY, credentials/, memory/, logs/) is moved
# to ARCHIVED_DIR with a 30-day retention window via purge-archived.sh —
# this preserves an operator-recovery path for an accidental /delete.
#
# OpenClaw sessions (the agent's full LLM conversation log including every
# prompt, response, tool call, and tool result) are hard-deleted immediately.
# We have no operational reason to retain them past the deletion request,
# and they're the most sensitive surface in the user's footprint — verbatim
# transcripts of every turn. Per the deletion message: "agent conversation
# history is permanently deleted, not archived."
TS=$(date -u '+%Y%m%d-%H%M%S')
mkdir -p "$ARCHIVED_DIR"

if [[ -d "$USERS_DIR/$AGENT_ID" ]]; then
  mv "$USERS_DIR/$AGENT_ID" "$ARCHIVED_DIR/${AGENT_ID}-workspace-${TS}"
  echo "  archived workspace → $ARCHIVED_DIR/${AGENT_ID}-workspace-${TS}"
fi

if [[ -d "$OPENCLAW_AGENTS_DIR/$AGENT_ID" ]]; then
  rm -rf "$OPENCLAW_AGENTS_DIR/$AGENT_ID"
  echo "  hard-deleted openclaw sessions for $AGENT_ID"
fi

# --- remove from openclaw.json ---
export AGENT_ID OPENCLAW_CONFIG
python3 <<'PYEOF'
import json, os
agent_id    = os.environ["AGENT_ID"]
config_path = os.environ["OPENCLAW_CONFIG"]

with open(config_path) as f:
    cfg = json.load(f)

before = (
    len(cfg.get("agents", {}).get("list", [])),
    len(cfg.get("bindings", [])),
)
if "agents" in cfg and "list" in cfg["agents"]:
    cfg["agents"]["list"] = [a for a in cfg["agents"]["list"] if a.get("id") != agent_id]
cfg["bindings"] = [b for b in cfg.get("bindings", []) if b.get("agentId") != agent_id]

with open(config_path, "w") as f:
    json.dump(cfg, f, indent=2)

after = (len(cfg["agents"]["list"]), len(cfg["bindings"]))
print(f"  openclaw.json: agents {before[0]}→{after[0]}, bindings {before[1]}→{after[1]}")
PYEOF

# --- reload gateway ---
if pgrep -f "openclaw.*gateway" >/dev/null; then
  kill -USR1 $(pgrep -f "openclaw.*gateway" | head -1) || true
  echo "  gateway: SIGUSR1 sent"
fi

echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') DEPROVISIONED $AGENT_ID telegram=$TELEGRAM_ID" >> "$PROVISION_LOG"
echo "✅ deprovisioned: $AGENT_ID"

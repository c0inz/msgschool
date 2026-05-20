#!/usr/bin/env bash
# provision.sh — create an OpenClaw agent for one MsgSchool user.
#
# Ported (and trimmed) from OCMarketplace's server-scripts/provision.sh.
# Single-persona, Kimi-K2.5, Telegram-only. One user ↔ one agent ↔ one workspace.
#
# Usage:  provision.sh --telegram-id <id> [--name "First Last"]
#
# What it does:
#   1. Creates /opt/msgschool/users/canvasagent-<tg_id>/workspace/
#   2. Copies writable seeds (PERSONA.md, USER.md, MEMORY.md), symlinks the
#      immutable ones (SOUL.md, AGENTS.md, TOOLS.md) from the deployed repo.
#   3. Adds an agent entry + Telegram peer binding to /root/.openclaw/openclaw.json.
#   4. Sends SIGUSR1 to the running gateway so it picks up the new config.
#
# Idempotent: refuses to re-provision if the agent id is already in openclaw.json
# unless --reactivate is passed.

set -euo pipefail

# --- paths ---
USERS_DIR="/opt/msgschool/users"
OPENCLAW_CONFIG="${HOME:-/root}/.openclaw/openclaw.json"
PROVISION_LOG="/opt/msgschool/provision.log"

# Templates live in the deployed repo so a git pull updates them for every
# future provision automatically.
REPO_ROOT="${MSGSCHOOL_ROOT:-/var/www/msgschool}"
TEMPLATE_DIR="$REPO_ROOT/templates/agent"

# --- args ---
TELEGRAM_ID=""
NAME=""
REACTIVATE=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --telegram-id) TELEGRAM_ID="$2"; shift 2 ;;
    --name)        NAME="$2"; shift 2 ;;
    --reactivate)  REACTIVATE=true; shift ;;
    *) echo "ERROR: unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$TELEGRAM_ID" ]]; then
  echo "ERROR: --telegram-id is required" >&2
  exit 2
fi
if ! [[ "$TELEGRAM_ID" =~ ^[0-9]+$ ]]; then
  echo "ERROR: --telegram-id must be numeric, got: $TELEGRAM_ID" >&2
  exit 2
fi
if [[ ! -d "$TEMPLATE_DIR" ]]; then
  echo "ERROR: template dir not found: $TEMPLATE_DIR" >&2
  exit 3
fi
if [[ ! -f "$OPENCLAW_CONFIG" ]]; then
  echo "ERROR: openclaw config not found: $OPENCLAW_CONFIG" >&2
  exit 3
fi

# Preflight — fail loud if the host hasn't been bootstrapped. Without the
# top-level browser block + a working chromium binary, the agent's browser
# tool times out with an obscure "OpenClaw.app menubar" message on every call.
if ! python3 -c "
import json, sys
c = json.load(open('$OPENCLAW_CONFIG'))
b = c.get('browser', {})
assert b.get('enabled') is True, 'browser.enabled missing or false'
assert b.get('executablePath'), 'browser.executablePath missing'
import os; assert os.path.exists(b['executablePath']), f\"chromium not found at {b['executablePath']}\"
" 2>/dev/null; then
  echo "ERROR: this droplet is not bootstrapped for the browser tool." >&2
  echo "       Run scripts/bootstrap-droplet.sh as root to install chromium + add the browser config block." >&2
  exit 5
fi

AGENT_ID="canvasagent-${TELEGRAM_ID}"
WORKSPACE="$USERS_DIR/$AGENT_ID/workspace"
# msgschool universal standard. Every new agent starts on Qwen 3.6-35B-A3B
# (via OpenRouter) with Sonnet 4.6 as automatic fallback. Qwen is ~7× cheaper
# than Sonnet, ~1.7× faster, and has produced clean output on real grade
# pulls + Skyward cross-system comparison (verified 2026-04-30 on tg=100000001
# and tg=100000003). To change the fleet-wide default in one step: run
# scripts/switch-model.sh.
MODEL="openrouter/qwen/qwen3.6-35b-a3b"
FALLBACK_MODEL="anthropic/claude-sonnet-4-6"
# thinkingDefault MUST be "off" — see docs/LLM_BEHAVIOR_MITIGATIONS.md §6:
# Sonnet with thinking=high becomes MORE speculative for this narrow task,
# not less. It overrides explicit AGENTS.md rules (asks forbidden questions,
# offers fake features, freelances helper-bot openings). Confirmed regression
# 2026-04-29 with newly-provisioned tg=100000003: agent had thinking=high,
# ignored every HARD RULE in AGENTS.md until manually flipped to off.
# This default must stay "off" for all newly-provisioned users.
THINKING="off"

echo "provision: agent=$AGENT_ID model=$MODEL fallback=$FALLBACK_MODEL thinking=$THINKING workspace=$WORKSPACE"

# --- already exists? ---
if python3 -c "
import json, sys
cfg = json.load(open('$OPENCLAW_CONFIG'))
exists = any(a.get('id') == '$AGENT_ID' for a in cfg.get('agents', {}).get('list', []))
sys.exit(0 if exists else 1)
" 2>/dev/null; then
  if [[ "$REACTIVATE" == "true" ]]; then
    echo "  agent already exists — treated as reactivate (no-op for now)"
    echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') REACTIVATED $AGENT_ID telegram=$TELEGRAM_ID" >> "$PROVISION_LOG"
    exit 0
  fi
  echo "ERROR: agent $AGENT_ID already exists. Pass --reactivate to treat as no-op." >&2
  exit 4
fi

# --- workspace layout ---
mkdir -p "$WORKSPACE/credentials" "$WORKSPACE/memory" "$WORKSPACE/logs"

# Writable files (agent may edit over time).
for f in PERSONA.md USER.md MEMORY.md; do
  src="$TEMPLATE_DIR/$f"
  dst="$WORKSPACE/$f"
  if [[ -f "$src" && ! -e "$dst" ]]; then
    cp "$src" "$dst"
  fi
done

# Seed USER.md with subscriber info.
cat >> "$WORKSPACE/USER.md" <<USEREOF

## Subscriber
- **Name:** ${NAME:-Unknown}
- **Telegram ID:** $TELEGRAM_ID
- **Provisioned:** $(date -u '+%Y-%m-%dT%H:%M:%SZ')
- **Canvas:** (not connected)
- **Skyward:** (not connected)
USEREOF

# Read-only platform files — symlinked so platform-wide updates propagate
# to every existing user workspace without re-provisioning.
# SKYWARD_PLAYBOOK.md and (when it exists) CANVAS_PLAYBOOK.md are treated as
# core skills: every agent MUST have them available, because Skyward/Canvas
# scraping is the whole product.
for f in SOUL.md AGENTS.md TOOLS.md SKYWARD_PLAYBOOK.md CANVAS_PLAYBOOK.md CANVAS_ACCESS_TOKEN_REFERENCE.jpg CANVAS_PROBE_REFERENCE.json SKYWARD_PROBE_REFERENCE.json; do
  src="$TEMPLATE_DIR/$f"
  dst="$WORKSPACE/$f"
  if [[ -f "$src" ]]; then
    ln -sfn "$src" "$dst"
  fi
done

echo "  workspace seeded"

# --- gateway config update ---
export AGENT_ID WORKSPACE MODEL FALLBACK_MODEL THINKING TELEGRAM_ID NAME OPENCLAW_CONFIG
python3 <<'PYEOF'
import json, os, sys
agent_id     = os.environ["AGENT_ID"]
workspace    = os.environ["WORKSPACE"]
model        = os.environ["MODEL"]
fallback     = os.environ.get("FALLBACK_MODEL", "")
thinking     = os.environ["THINKING"]
telegram_id  = os.environ["TELEGRAM_ID"]
name         = os.environ.get("NAME", "")
config_path  = os.environ["OPENCLAW_CONFIG"]

with open(config_path) as f:
    cfg = json.load(f)

cfg.setdefault("agents", {}).setdefault("list", [])
cfg.setdefault("bindings", [])

model_block = {"primary": model}
if fallback:
    model_block["fallbacks"] = [fallback]

agent_entry = {
    "id": agent_id,
    "name": f"MsgSchool ({name})" if name else f"MsgSchool ({telegram_id})",
    "workspace": workspace,
    "model": model_block,
    "thinkingDefault": thinking,
    # No sandbox override: inherits from agents.defaults (kept clean by bootstrap).
    # No tools override: inherits OpenClaw defaults, which include browser.
    # Per-agent overrides caused the "OpenClaw.app menubar" failure — they push
    # OpenClaw into desktop-app mode and the browser tool dies. See
    # docs/ARCHITECTURE.md § "Browser tool requirements" for the root cause.
}
cfg["agents"]["list"].append(agent_entry)

cfg["bindings"].append({
    "agentId": agent_id,
    "match": {
        "channel": "telegram",
        "peer": {"kind": "direct", "id": telegram_id}
    }
})

with open(config_path, "w") as f:
    json.dump(cfg, f, indent=2)
print("  openclaw.json: added agent + telegram binding")
PYEOF

# --- reload gateway ---
if pgrep -f "openclaw.*gateway" >/dev/null; then
  kill -USR1 $(pgrep -f "openclaw.*gateway" | head -1) || true
  echo "  gateway: SIGUSR1 sent"
else
  echo "  WARN: no openclaw gateway running — config written, but nothing will serve this agent until a gateway starts" >&2
fi

mkdir -p "$(dirname "$PROVISION_LOG")"
echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') PROVISIONED $AGENT_ID telegram=$TELEGRAM_ID model=$MODEL" >> "$PROVISION_LOG"

echo "✅ provisioned: $AGENT_ID"

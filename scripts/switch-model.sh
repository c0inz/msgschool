#!/usr/bin/env bash
# switch-model.sh — set the msgschool-wide model + thinking level.
#
# Flips agents.defaults.model.primary + agents.defaults.thinkingDefault AND
# every canvasagent-* entry in agents.list[] to the same model/thinking so
# new users and existing users are always aligned.
#
# OpenClaw's gateway hot-reloads openclaw.json changes for model settings
# (docs.openclaw.ai/gateway/configuration.md: "The Gateway watches
# ~/.openclaw/openclaw.json and applies changes automatically — no manual
# restart needed for most settings"). We still bounce the gateway by default
# because the fleet's update-llm-key.sh failure log documents silent drift
# when a restart was skipped during a model + key change. Use --no-bounce
# to skip the restart and rely on hot-reload (faster but trusts the watcher).
#
# Usage:
#   ./switch-model.sh <model> [thinking_level] [--no-bounce]
#
# Examples:
#   ./switch-model.sh anthropic/claude-sonnet-4-6 high
#   ./switch-model.sh anthropic/claude-opus-4-6 xhigh
#   ./switch-model.sh moonshot/kimi-k2.6 adaptive
#   ./switch-model.sh anthropic/claude-sonnet-4-6 high --no-bounce
#
# Valid thinking levels: off | minimal | low | medium | high | xhigh | adaptive
#
# Must be run on the msgschool VM (local) or sudo-accessible via ssh:
#   ssh -J <kvm-host> <vm-user>@<vm-ip> "sudo bash /var/www/msgschool/scripts/switch-model.sh ..."

set -euo pipefail

MODEL="${1:-}"
THINKING="${2:-high}"
BOUNCE="yes"
for arg in "$@"; do
  [ "$arg" = "--no-bounce" ] && BOUNCE="no"
done

if [ -z "$MODEL" ]; then
  cat >&2 <<EOF
Usage: $(basename "$0") <model> [thinking_level] [--no-bounce]

Valid thinking: off | minimal | low | medium | high | xhigh | adaptive
Default thinking: high
EOF
  exit 2
fi

# Basic shape check — reject anything not matching provider/model-id
if [[ ! "$MODEL" =~ ^[a-z0-9_\-]+/[A-Za-z0-9._\-]+$ ]]; then
  echo "ERROR: model must be '<provider>/<model-id>' (got: $MODEL)" >&2
  exit 2
fi

case "$THINKING" in
  off|minimal|low|medium|high|xhigh|adaptive) ;;
  *) echo "ERROR: invalid thinking level '$THINKING'. Valid: off|minimal|low|medium|high|xhigh|adaptive" >&2; exit 2 ;;
esac

CONFIG=/root/.openclaw/openclaw.json
[ -f "$CONFIG" ] || { echo "ERROR: $CONFIG not found — are we on the msgschool VM as root?" >&2; exit 1; }

# Backup first (fleet lesson: always snapshot before touching)
BACKUP="${CONFIG}.bak-switch-$(date +%s)"
cp "$CONFIG" "$BACKUP"
echo "Backup: $BACKUP"

# Patch via python3 (fleet lesson #3: never use sed on JSON)
MODEL="$MODEL" THINKING="$THINKING" python3 <<'PYEOF'
import json, os
p = "/root/.openclaw/openclaw.json"
model = os.environ["MODEL"]
thinking = os.environ["THINKING"]

with open(p) as f:
    c = json.load(f)

defaults = c.setdefault("agents", {}).setdefault("defaults", {})
defaults.setdefault("model", {})["primary"] = model
defaults["thinkingDefault"] = thinking

changed_agents = []
for a in c.get("agents", {}).get("list", []):
    if str(a.get("id", "")).startswith("canvasagent-"):
        m = a.setdefault("model", {})
        if isinstance(m, str):
            m = {"primary": m}
        m["primary"] = model
        a["model"] = m
        a["thinkingDefault"] = thinking
        changed_agents.append(a["id"])

with open(p, "w") as f:
    json.dump(c, f, indent=2)

print(f"defaults.model.primary = {model}")
print(f"defaults.thinkingDefault = {thinking}")
print(f"updated {len(changed_agents)} canvasagent entries: {', '.join(changed_agents) or '(none)'}")
PYEOF

if [ "$BOUNCE" = "yes" ]; then
  echo ""
  echo "=== bouncing openclaw-gateway (User=root) ==="
  XDG_RUNTIME_DIR=/run/user/0 systemctl --user restart openclaw-gateway
  sleep 8  # fleet lesson #4: verify it STAYS up, not just is-active
  STATE=$(XDG_RUNTIME_DIR=/run/user/0 systemctl --user is-active openclaw-gateway)
  if [ "$STATE" != "active" ]; then
    echo "ERROR: gateway is '$STATE' after restart — inspect:" >&2
    XDG_RUNTIME_DIR=/run/user/0 journalctl --user -u openclaw-gateway -n 30 --no-pager >&2
    exit 3
  fi
  echo "gateway active"
  echo ""
  echo "=== scanning recent logs for config errors ==="
  ERR=$(XDG_RUNTIME_DIR=/run/user/0 journalctl --user -u openclaw-gateway --since "30 seconds ago" --no-pager 2>&1 | grep -iE "invalid|unrecognized|error.*config|error.*model" || true)
  if [ -n "$ERR" ]; then
    echo "WARNING: possible config issues:" >&2
    echo "$ERR" >&2
  else
    echo "no config errors in recent logs"
  fi
else
  echo ""
  echo "=== skip bounce (--no-bounce); trusting gateway hot-reload ==="
  echo "openclaw.json was updated. The gateway watches this file and should re-read it for model settings."
  echo "If behavior doesn't match the new config within ~5s, run: sudo systemctl --user -M root@ restart openclaw-gateway"
fi

echo ""
echo "✅ msgschool model switched to: $MODEL (thinking=$THINKING)"

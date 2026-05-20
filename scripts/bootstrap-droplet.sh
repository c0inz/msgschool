#!/usr/bin/env bash
# bootstrap-droplet.sh — one-time prep for an OpenClaw + msgschool droplet.
#
# Run as root. Idempotent — safe to re-run after an OpenClaw upgrade or if the
# openclaw.json got reset by a fresh install.
#
# What it does:
#   1. Installs Playwright's Chromium Headless Shell (the browser OpenClaw drives).
#   2. Installs system shared libs (libatk, libxkbcommon, etc.) that Chromium
#      needs to launch — otherwise every browser-tool call times out silently.
#   3. Adds the top-level "browser" block to /root/.openclaw/openclaw.json so
#      the OpenClaw gateway knows how to launch Chromium headlessly. Without
#      this block, OpenClaw falls back to "desktop OpenClaw.app" mode and the
#      browser tool fails with Mac-flavored error messages on Linux.
#   4. Wipes any broken agents.defaults.sandbox.docker reference (OCM-era
#      artifact pointing at a Docker image that doesn't exist on the droplet).
#   5. Sets OPENCLAW_BROWSER_EXECUTABLE_PATH + PLAYWRIGHT_BROWSERS_PATH in the
#      openclaw-gateway systemd-user unit and reloads.
#
# Preconditions:
#   - OpenClaw is installed globally (/usr/lib/node_modules/openclaw).
#   - openclaw-gateway.service exists under /root/.config/systemd/user/.
#   - The droplet has been through `openclaw configure` at least once
#     (/root/.openclaw/openclaw.json exists).

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: must be run as root (reads/writes /root/.openclaw/openclaw.json)" >&2
  exit 1
fi

OPENCLAW_NPM=/usr/lib/node_modules/openclaw
OPENCLAW_CONFIG=/root/.openclaw/openclaw.json
BROWSERS_DIR=/root/.cache/ms-playwright
UNIT=/root/.config/systemd/user/openclaw-gateway.service

if [[ ! -d "$OPENCLAW_NPM/node_modules/playwright-core" ]]; then
  echo "ERROR: OpenClaw's bundled playwright-core not found at $OPENCLAW_NPM/node_modules/playwright-core" >&2
  echo "       Install OpenClaw first: npm install -g openclaw" >&2
  exit 2
fi
if [[ ! -f "$OPENCLAW_CONFIG" ]]; then
  echo "ERROR: $OPENCLAW_CONFIG doesn't exist. Run 'openclaw configure' first." >&2
  exit 2
fi

echo "=== 1. install Playwright chromium-headless-shell (bundled playwright-core) ==="
cd "$OPENCLAW_NPM/node_modules/playwright-core"
PLAYWRIGHT_BROWSERS_PATH="$BROWSERS_DIR" node cli.js install chromium

echo ""
echo "=== 2. install chromium system libs (libatk, libxkbcommon, etc.) ==="
PLAYWRIGHT_BROWSERS_PATH="$BROWSERS_DIR" node cli.js install-deps chromium

# Find the actual binary we just installed.
CHROME=$(find "$BROWSERS_DIR" -type f -name chrome-headless-shell | head -n 1)
if [[ -z "$CHROME" || ! -x "$CHROME" ]]; then
  echo "ERROR: chrome-headless-shell not found under $BROWSERS_DIR after install" >&2
  exit 3
fi
echo "chromium binary: $CHROME"

echo ""
echo "=== 3. update /root/.openclaw/openclaw.json ==="
cp "$OPENCLAW_CONFIG" "${OPENCLAW_CONFIG}.pre-bootstrap-$(date +%s)"
CHROME="$CHROME" python3 <<'PYEOF'
import json, os
p = "/root/.openclaw/openclaw.json"
c = json.load(open(p))

c["browser"] = {
    "enabled": True,
    "executablePath": os.environ["CHROME"],
    "headless": True,
    "noSandbox": True,
    "defaultProfile": "openclaw",
}
print(f"  browser: enabled with executablePath={os.environ['CHROME']}")

# msgschool universal default: Anthropic Claude Sonnet 4.6 with thinking=high.
# Moonshot Kimi stays registered as automatic fallback (cross-provider
# agents.defaults.model.fallbacks) so if Anthropic rate-limits or errors,
# agents keep working. Kimi history: k2.5 was a reasoning model that blew
# max_tokens; turbo-preview fixed that; k2.6 was fine but instruction-
# compliance was shaky. Sonnet+high gives us better honesty on failure
# reporting and better prose for /pulse.
TARGET_MODEL = "anthropic/claude-sonnet-4-6"
TARGET_MODEL_ID = "claude-sonnet-4-6"
TARGET_PROVIDER = "anthropic"
TARGET_THINKING = "off"  # 2026-04-21: flipped from "high" — Sonnet thinking added 10-60s per turn; off is our preferred default for /pulse responsiveness. Bump to medium or high only if output-quality regressions show up.
FALLBACK_MODEL = "moonshot/kimi-k2.6"

# --- Anthropic provider (primary) ---
anthropic_key = os.environ.get("ANTHROPIC_API_KEY", "")
providers = c.setdefault("models", {}).setdefault("providers", {})
if anthropic_key:
    anth = providers.setdefault("anthropic", {})
    anth["baseUrl"] = "https://api.anthropic.com"
    anth["apiKey"] = anthropic_key
    anth["api"] = "anthropic-messages"
    existing_anth = {m.get("id") for m in anth.get("models", [])}
    for mid, mname in [("claude-sonnet-4-6", "Sonnet 4.6"), ("claude-haiku-4-5", "Haiku 4.5")]:
        if mid not in existing_anth:
            anth.setdefault("models", []).append({
                "id": mid, "name": mname, "contextWindow": 200000, "maxTokens": 8192,
            })
    print(f"  anthropic provider configured (key ...{anthropic_key[-6:]})")
else:
    print("  WARN: ANTHROPIC_API_KEY not set — anthropic provider left unchanged")

# --- Moonshot provider (fallback) — keep registered with kimi-k2.6 ---
moon = providers.setdefault("moonshot", {})
existing_moon = {m.get("id") for m in moon.get("models", [])}
if "kimi-k2.6" not in existing_moon:
    moon.setdefault("models", []).append({
        "id": "kimi-k2.6", "name": "Kimi K2.6", "contextWindow": 256000, "maxTokens": 32768,
    })
    print("  registered kimi-k2.6 under moonshot provider")

# --- Defaults: primary + fallbacks + thinking ---
defaults = c.setdefault("agents", {}).setdefault("defaults", {})
model_defaults = defaults.setdefault("model", {})
model_defaults["primary"] = TARGET_MODEL
model_defaults["fallbacks"] = [FALLBACK_MODEL]
defaults["thinkingDefault"] = TARGET_THINKING

# --- Failover aggressiveness ---
# 2026-04-21 incident: Anthropic returned overloaded_error, OpenClaw did 7
# retries over 25s before falling over to GPT-5.4. Our /pulse timed out
# waiting. Setting overloadedProfileRotations=0 makes overload trigger
# IMMEDIATE model-fallback (Sonnet -> GPT-5.4) with no in-place retries.
auth_cooldowns = c.setdefault("auth", {}).setdefault("cooldowns", {})
auth_cooldowns["overloadedProfileRotations"] = 0
auth_cooldowns["overloadedBackoffMs"] = 0
print(f"  auth.cooldowns.overloadedProfileRotations: 0 (immediate failover on overload)")
if "subagents" in defaults and isinstance(defaults["subagents"], dict):
    defaults["subagents"]["model"] = TARGET_MODEL
print(f"  agents.defaults.model.primary: {TARGET_MODEL}")
print(f"  agents.defaults.model.fallbacks: [{FALLBACK_MODEL}]")
print(f"  agents.defaults.thinkingDefault: {TARGET_THINKING}")

# --- Sync every canvasagent-* to the universal standard ---
for a in c.get("agents", {}).get("list", []):
    if not str(a.get("id", "")).startswith("canvasagent-"):
        continue
    m = a.setdefault("model", {})
    if isinstance(m, str):
        m = {"primary": m}
    m["primary"] = TARGET_MODEL
    a["model"] = m
    a["thinkingDefault"] = TARGET_THINKING
    print(f"  synced {a['id']}: model={TARGET_MODEL}, thinking={TARGET_THINKING}")

# Nuke the broken OCM-era docker reference from agents.defaults.sandbox.
# Without this the gateway tries to pull a nonexistent image on every start.
defaults = c.setdefault("agents", {}).setdefault("defaults", {})
if "sandbox" in defaults and isinstance(defaults["sandbox"], dict) and "docker" in defaults["sandbox"]:
    print(f"  removing agents.defaults.sandbox.docker (was {defaults['sandbox']['docker']})")
    del defaults["sandbox"]["docker"]
    # If that leaves sandbox empty, drop it entirely — cleaner than a {mode, scope} stub.
    stripped = {k: v for k, v in defaults["sandbox"].items() if k not in ("mode", "scope", "workspaceAccess")}
    if not stripped:
        del defaults["sandbox"]
        print("  removed now-empty agents.defaults.sandbox entirely")

# Clean up any per-agent sandbox / tools overrides on msgschool agents (OCM-style
# overrides push the browser tool into broken mode). We leave ID, name, workspace,
# model alone.
for a in c.get("agents", {}).get("list", []):
    if not a.get("id", "").startswith("canvasagent-"):
        continue
    for k in ("sandbox", "tools"):
        if k in a:
            del a[k]
            print(f"  cleaned {a['id']}.{k}")

with open(p, "w") as f:
    json.dump(c, f, indent=2)
print("openclaw.json updated")
PYEOF

echo ""
echo "=== 4. set env vars on openclaw-gateway systemd unit ==="
if [[ -f "$UNIT" ]]; then
  for line in \
    "Environment=OPENCLAW_BROWSER_EXECUTABLE_PATH=$CHROME" \
    "Environment=PLAYWRIGHT_BROWSERS_PATH=$BROWSERS_DIR"; do
    key="${line%=*}=${line#*=}"
    key_name=$(echo "$line" | sed -E 's/^Environment=([A-Z_]+)=.*/\1/')
    # Remove any existing line for this key, then append the current value.
    sed -i "/^Environment=${key_name}=/d" "$UNIT"
    # Insert before [Install] section
    sed -i "/^\[Install\]/i $line" "$UNIT"
    echo "  set: $line"
  done
  XDG_RUNTIME_DIR=/run/user/0 systemctl --user daemon-reload
  echo "  reloaded systemd user units"
else
  echo "  WARN: $UNIT not found; skipping env var injection"
fi

echo ""
echo "=== 5. restart gateway and wait for readiness ==="
XDG_RUNTIME_DIR=/run/user/0 systemctl --user restart openclaw-gateway || true
sleep 20
XDG_RUNTIME_DIR=/run/user/0 journalctl --user -u openclaw-gateway --since "30 seconds ago" --no-pager 2>&1 \
  | grep -E "gateway.*ready|browser" | tail -5 || true

echo ""
echo "✅ bootstrap complete"
echo "   Sanity check: msgschool's provision.sh will now pass its preflight."
echo "   Next provision: ./scripts/provision.sh --telegram-id <id> [--name <name>]"

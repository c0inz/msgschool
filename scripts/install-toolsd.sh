#!/usr/bin/env bash
# install-toolsd.sh — full prod deploy of the toolsd cutover.
#
# Pulls the latest code, installs deps, runs Next build (so the bot
# actually picks up handler.ts changes — this step was missed in the
# initial rollout 2026-05-01 and resulted in stale handler code serving
# webhooks for ~25 minutes), applies any pending DB migrations,
# installs the toolsd unit + ms_call wrapper + sweep timer, and
# restarts both services. Idempotent.

set -euo pipefail

REPO_ROOT="${MSGSCHOOL_ROOT:-/var/www/msgschool}"

if [[ ! -d "$REPO_ROOT" ]]; then
  echo "ERROR: $REPO_ROOT not found" >&2
  exit 1
fi

cd "$REPO_ROOT"

echo "=== git pull ==="
git pull --ff-only origin main 2>&1 | tail -5

echo
echo "=== npm install ==="
npm install --no-audit --no-fund --no-progress 2>&1 | tail -5

echo
echo "=== next build (bot needs this to pick up handler.ts edits) ==="
npm run build 2>&1 | tail -5

echo
echo "=== ms_call wrapper into /usr/local/bin ==="
install -m 0755 -o root -g root "$REPO_ROOT/bin/ms-call.mjs" /usr/local/bin/ms_call

echo "=== systemd units ==="
install -m 0644 -o root -g root \
  "$REPO_ROOT/scripts/msgschool-toolsd.service" \
  /etc/systemd/system/msgschool-toolsd.service

install -m 0644 -o root -g root \
  "$REPO_ROOT/scripts/msgschool-credscan.service" \
  /etc/systemd/system/msgschool-credscan.service

install -m 0644 -o root -g root \
  "$REPO_ROOT/scripts/msgschool-credscan.timer" \
  /etc/systemd/system/msgschool-credscan.timer

install -m 0755 -o root -g root \
  "$REPO_ROOT/scripts/credscan.sh" \
  /usr/local/sbin/msgschool-credscan

echo "=== AppArmor profiles (start in complain; promote to enforce after a clean week) ==="
if command -v apparmor_parser >/dev/null 2>&1; then
  for p in usr.bin.npx-msgschool usr.bin.node-toolsd; do
    install -m 0644 -o root -g root \
      "$REPO_ROOT/scripts/apparmor/$p" \
      "/etc/apparmor.d/$p"
    apparmor_parser -r -W "/etc/apparmor.d/$p"
    aa-complain "/etc/apparmor.d/$p" 2>/dev/null || true
    echo "  installed (complain): $p"
  done
else
  echo "  apparmor_parser not present, skipping (install apparmor-utils to enable)"
fi

echo "=== reload + enable + start ==="
systemctl daemon-reload
systemctl enable msgschool-toolsd.service
systemctl enable msgschool-credscan.timer
systemctl restart msgschool-toolsd.service
systemctl restart msgschool-credscan.timer
systemctl restart msgschool.service  # picks up the new compiled handler

sleep 2

echo
echo "=== status ==="
systemctl is-active msgschool.service msgschool-toolsd.service msgschool-credscan.timer

if [[ ! -S /run/msgschool/toolsd.sock ]]; then
  echo "ERROR: /run/msgschool/toolsd.sock not present. Check: journalctl -u msgschool-toolsd -n 50" >&2
  exit 2
fi

echo
echo "Done. Smoke:"
echo "      cd /opt/msgschool/users/canvasagent-<id>/workspace && ms_call tools.healthcheck '{}'"

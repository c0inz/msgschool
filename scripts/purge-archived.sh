#!/usr/bin/env bash
# purge-archived.sh — delete /opt/msgschool/archived/ entries older than
# 30 days. Run daily by msgschool-purge-archived.timer.
#
# Why this exists: when a user invokes /delete, deprovision.sh moves their
# workspace + openclaw session dir into /opt/msgschool/archived/. Without
# this purge they'd sit there forever — silently breaking the
# "backup copies age out within X days" promise the deletion message makes
# to the user.
#
# Retention: 30 days. The deletion-success message tells users this; if you
# change RETENTION_DAYS you must update the message in handler.ts to match.
#
# Idempotent. Safe to run multiple times. Logs to journal.

set -euo pipefail

ARCHIVED_DIR="/opt/msgschool/archived"
RETENTION_DAYS=30

if [[ ! -d "$ARCHIVED_DIR" ]]; then
  echo "purge-archived: nothing to do (no $ARCHIVED_DIR)"
  exit 0
fi

# Find directories under ARCHIVED_DIR older than the cutoff. Using mtime
# because the deprovision rename preserves it; -depth ensures we get the
# named child dirs not their contents.
PURGED=0
while IFS= read -r dir; do
  rm -rf -- "$dir"
  echo "purge-archived: removed $dir"
  PURGED=$((PURGED + 1))
done < <(find "$ARCHIVED_DIR" -mindepth 1 -maxdepth 1 -type d -mtime "+$RETENTION_DAYS")

echo "purge-archived: complete, $PURGED dir(s) removed (retention: $RETENTION_DAYS days)"

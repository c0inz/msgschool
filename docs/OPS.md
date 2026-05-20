# msgschool — DevOps Playbook

Runbook for operating the home-hosted msgschool. Terse, pointed, designed for you or me at 2 AM.

For the contract this host must match, see `SECURITY.md`. This doc is the *how*.

## Quick reference

| Thing | Value |
|---|---|
| Host | `msgschool` / `msg` (ssh alias) / `<vm-ip>` / libvirt on the KVM host |
| SSH | `ssh msgschool` (add to `~/.ssh/config` pointing at <vm-ip> via `ProxyJump <kvm-host>`) |
| User | `readystack` (passwordless sudo) |
| App dir | `/var/www/msgschool` (git clone of c0inz/msgschool) |
| User workspaces | `/opt/msgschool/users/canvasagent-<tg_id>/workspace/` |
| OpenClaw config | `/root/.openclaw/openclaw.json` (root-owned; bootstrap-droplet.sh writes it) |
| Platform env | `/etc/msgschool/.env` — Telegram token, Postgres creds. Model-provider keys live in `/root/.openclaw/openclaw.json` (read by OpenClaw gateway). |
| Public URL | `https://msgschool.com` via Cloudflare Tunnel |
| DB | `postgresql` local, db `msgschool`, user `msgschool`, port 5432 bound to 127.0.0.1 only |
| Process manager | systemd unit `msgschool.service` (Type=simple, runs as `readystack`). pm2 was evaluated and rejected — its `resurrect`-on-boot flow doesn't play nicely with systemd PIDFile expectations on Ubuntu 24.04. |
| Logs | `journalctl -u msgschool` · `journalctl --user -u openclaw-gateway -M <openclaw-user>@.host` (or `sudo XDG_RUNTIME_DIR=/run/user/0 journalctl --user -u openclaw-gateway`) |

## Bootstrap (fresh VM → running msgschool)

Run once on the VM. Roughly 30 minutes.

```bash
# --- 1. base packages ---
sudo apt update
sudo apt install -y build-essential git curl jq nginx postgresql \
  ufw nftables fail2ban unattended-upgrades auditd apparmor-utils
# Node 22 LTS via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g openclaw

# --- 2. firewall (nftables) ---
sudo tee /etc/nftables.conf >/dev/null <<'EOF'
#!/usr/sbin/nft -f
flush ruleset
table inet filter {
  chain input {
    type filter hook input priority 0; policy drop;
    iif "lo" accept
    ct state established,related accept
    ip protocol icmp accept
    ip6 nexthdr icmpv6 accept
    # SSH from LAN + Tailscale only
    ip saddr <vm-subnet>/24 tcp dport 22 accept
    iifname "tailscale0" tcp dport 22 accept
    counter log prefix "nft-drop: " drop
  }
  chain forward { type filter hook forward priority 0; policy drop; }
  chain output  { type filter hook output  priority 0; policy accept; }
}
EOF
sudo systemctl enable --now nftables

# --- 3. SSH hardening ---
sudo sed -i 's/^#*PasswordAuthentication .*/PasswordAuthentication no/; s/^#*PermitRootLogin .*/PermitRootLogin no/; s/^#*KbdInteractiveAuthentication .*/KbdInteractiveAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart ssh

# --- 4. unattended-upgrades (security patches only) ---
sudo dpkg-reconfigure --priority=low unattended-upgrades

# --- 5. Tailscale (optional but recommended for break-glass) ---
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh

# --- 6. Cloudflare Tunnel ---
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o /tmp/cf.deb
sudo dpkg -i /tmp/cf.deb
sudo cloudflared tunnel login     # opens a URL; paste into your browser
sudo cloudflared tunnel create msgschool
# write /etc/cloudflared/config.yml pointing tunnel → localhost:3000
sudo cloudflared tunnel route dns msgschool msgschool.com
sudo cloudflared tunnel route dns msgschool www.msgschool.com
sudo cloudflared service install
sudo systemctl enable --now cloudflared

# --- 7. PostgreSQL ---
sudo -u postgres createuser msgschool -P      # prompts for password; store in .env
sudo -u postgres createdb msgschool -O msgschool
# Ensure pg_hba.conf has: host all all 127.0.0.1/32 scram-sha-256
sudo systemctl restart postgresql

# --- 8. msgschool repo ---
sudo mkdir -p /var/www && sudo chown readystack:readystack /var/www
cd /var/www
git clone https://github.com/c0inz/msgschool.git
cd msgschool
cp .env.example /etc/msgschool/.env
sudo chown root:readystack /etc/msgschool/.env
sudo chmod 0640 /etc/msgschool/.env
# edit /etc/msgschool/.env — fill in TELEGRAM_BOT_TOKEN, DATABASE_URL, MOONSHOT_API_KEY, etc.
npm ci
npm run build
npx drizzle-kit push            # apply schema

# --- 9. OpenClaw gateway ---
# as root the first time; then promote to systemd-user under readystack
sudo ./scripts/bootstrap-droplet.sh

# --- 10. msgschool.service (systemd) ---
sudo tee /etc/systemd/system/msgschool.service >/dev/null <<'UNIT'
[Unit]
Description=msgschool — Next.js Telegram webhook
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=readystack
Group=readystack
WorkingDirectory=/var/www/msgschool
EnvironmentFile=/etc/msgschool/.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/npx next start -H 127.0.0.1 -p 3010
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=read-only
PrivateTmp=true
ReadWritePaths=/var/www/msgschool /home/readystack/.npm /opt/msgschool

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now msgschool

# OpenClaw gateway runs as a user-unit under root. Start root's systemd user instance first:
sudo loginctl enable-linger root
sudo systemctl start user@0.service
sudo XDG_RUNTIME_DIR=/run/user/0 systemctl --user daemon-reload
sudo XDG_RUNTIME_DIR=/run/user/0 systemctl --user enable --now openclaw-gateway

# --- 11. Register Telegram webhook ---
curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -d "url=https://msgschool.com/api/bot/webhook" \
  -d "secret_token=${TELEGRAM_WEBHOOK_SECRET}"
```

After all 11 steps: Telegram → Cloudflare → tunnel → `127.0.0.1:3000/api/bot/webhook` → Next.js → agent → reply. Smoke test by DMing `@MsgSchoolBot`.

## Deploy a code change

For any change involving src/ (handler, toolsd, schema, etc.) use the bundled installer — it does git pull + `npm install` + **`npm run build`** + DB migrate + restart of all three units in the right order. The first toolsd rollout (2026-05-01) silently shipped stale handler.ts because we skipped `next build`; the installer makes that no longer possible.

```bash
ssh msgschool
sudo /var/www/msgschool/scripts/install-toolsd.sh
journalctl -u msgschool -n 30 --no-pager
journalctl -u msgschool-toolsd -n 30 --no-pager
```

For a manual deploy without the installer (rarely needed):

```bash
cd /var/www/msgschool
git pull --ff-only origin main
npm install
npm run build               # MUST run — `next start` reads .next/, not src/
sudo systemctl restart msgschool msgschool-toolsd
journalctl -u msgschool -n 30 --no-pager
```

Template-only changes (anything under `templates/agent/`) don't need `npm ci` + `npm run build` + restart — the symlinks into user workspaces resolve to the updated files on the next agent turn. After a template edit, also reset OpenClaw sessions so already-loaded agents pick up the new content:

```bash
sudo find /root/.openclaw/agents/canvasagent-*/sessions/ -mindepth 1 -delete
```

PERSONA.md is copied (not symlinked) at provision time; existing users need a manual overwrite:

```bash
for ws in /opt/msgschool/users/canvasagent-*/workspace/; do
  cp -v /var/www/msgschool/templates/agent/PERSONA.md "$ws/PERSONA.md"
done
```

## Rollback a bad deploy

```bash
cd /var/www/msgschool
git log --oneline -10              # find the last known good SHA
git checkout <sha>
npm ci && npm run build
sudo systemctl restart msgschool
# fix forward on main later; don't leave prod detached-HEAD for long
```

## User management

**List registered users:**

```bash
PGPASSWORD=<from .env> psql -h 127.0.0.1 -U msgschool -d msgschool -c \
  "SELECT telegram_user_id, telegram_first_name, state, expires_at, workspace_path FROM ms_users ORDER BY id;"
```

**Provision a user manually** (normal path is via the `/FreeAgent2026` code flow):

```bash
sudo ./scripts/provision.sh --telegram-id <id> --name "<first name>"
```

**Deprovision** (full user removal, rare — normally users just expire):

```bash
sudo ./scripts/deprovision.sh --telegram-id <id>
# verify:
ls /opt/msgschool/users/canvasagent-<id>/   # should be gone
```

**Reset an existing user's memory** (platform-level `/reset` does this live; manual version):

```bash
WS=/opt/msgschool/users/canvasagent-<id>/workspace
> "$WS/MEMORY.md"
rm -f "$WS/memory/"*.md
# rotate session nonce so gateway multi-turn history starts fresh
echo "$(date +%s)" > "$WS/state/session-nonce"
```

**See what one user's agent is doing right now:**

```bash
ls -la /opt/msgschool/users/canvasagent-<id>/workspace/
cat    /opt/msgschool/users/canvasagent-<id>/workspace/state/ready.json    # is the readiness gate passed?
cat    /opt/msgschool/users/canvasagent-<id>/workspace/USER.md
tail   /opt/msgschool/users/canvasagent-<id>/workspace/logs/*
```

## Credential rotation

**Telegram bot token** (when the token is suspected compromised):

```bash
# 1. In @BotFather: /revoke → /newtoken → copy the new token
# 2. On the VM:
sudo sed -i 's|^TELEGRAM_BOT_TOKEN=.*|TELEGRAM_BOT_TOKEN=<new>|' /etc/msgschool/.env
sudo systemctl restart msgschool
# 3. Re-register webhook with the new token
source /etc/msgschool/.env
curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -d "url=https://msgschool.com/api/bot/webhook" \
  -d "secret_token=${TELEGRAM_WEBHOOK_SECRET}"
```

**Model-provider API keys (whichever provider(s) are currently routed to):**

1. Identify the provider(s) currently in use: `sudo jq '.models.providers | to_entries | map({key:.key, apiKey_suffix:(.value.apiKey | .[-8:])})' /root/.openclaw/openclaw.json` on the msgschool VM. Compare against `.agents.defaults.model.primary` and `.agents.list[].model.{primary,fallbacks}` to see which keys actively serve traffic.
2. Generate a new key in the provider's dashboard. Save to `~/credentials/<provider>.json` on the devops machine with a `rotated_at` stamp.
3. On msgschool VM: edit `/root/.openclaw/openclaw.json` → replace `apiKey` under `models.providers.<provider-key>`.
4. `kill -USR1 $(pgrep -f 'openclaw/dist/index.js gateway')` to hot-reload (gateway watches the file). Or restart: `sudo systemctl --machine root@.host --user restart openclaw-gateway`.
5. Smoke test: send yourself a DM, confirm the agent responds.
6. Revoke the old key in the provider's dashboard.

**Cloudflare tunnel token:** delete tunnel in Cloudflare dashboard, `cloudflared tunnel create msgschool` again, re-route DNS, restart service.

**Postgres password:** `ALTER USER msgschool WITH PASSWORD '…';` then update `/etc/msgschool/.env` `DATABASE_URL`, restart app.

## Backups

Local only. Cron on the VM writes three tarballs nightly and rsync-pushes them to the KVM host. No cloud off-site — this is a two-user home service.

**Layout:**

- Script: `/usr/local/sbin/msgschool-backup` (root-owned, 0750)
- Cron: `/etc/cron.d/msgschool-backup`, fires at `17 3 * * *` (3:17 AM UTC nightly)
- Local output: `/var/backups/msgschool/` (mode `drwxr-s--- root:readystack`)
  - `db-YYYY-MM-DD.sql.gz` (pg_dump of msgschool)
  - `workspaces-YYYY-MM-DD.tar.gz` (/opt/msgschool/users/)
  - `config-YYYY-MM-DD.tar.gz` (/etc/msgschool, /root/.openclaw, /etc/cloudflared, msgschool.service, nftables.conf)
- Local retention: 14 days (`find … -mtime +14 -delete`)
- Off-VM target: `<operator>@<lan-host-ip>:backups/msgschool/` on <kvm-host>, pushed via rsync using a dedicated SSH key at `~/.ssh/<backup-key>` (<vm-user>@<vm-host>). That key's entry on <kvm-host> is locked with `command=~/bin/<accept-script>` which only accepts `rsync --server ./backups/msgschool/…` — nothing else.
- **KVM-host-side retention prune:** daily cron at 4 AM runs `~/bin/<prune-script>` which deletes any `*.gz` or `*.gz.age` under `~/backups/msgschool/` older than 30 days. Log lives at `~/backups/msgschool-prune.log` on <kvm-host>. This matches the privacy-policy claim *"Backups are retained for up to 30 days and then pruned."*
- Manual run: `sudo /usr/local/sbin/msgschool-backup`
- Tail log: `/var/log/msgschool-backup.log`

**All backups are `age`-encrypted at rest.** Each nightly tarball is piped through `age -r <public-key>` before writing to disk and rsyncing to <kvm-host>. The matching private key is stored **offline** (password manager + printed backup) — NOT on any running machine. Files have extension `.tar.gz.age` / `.sql.gz.age`. Cleanup of pre-encryption plaintext backups happened 2026-04-21.

Public recipient used by the script: `age1v2ehzwnz6n9wr5hcz36lenupg09j85jrz2xpdujcrn4mulpy2fdq0vgxjh`.

**Restore a single file (the real procedure that the age-encrypted backups require):**

```bash
# On <devops-machine> (or wherever the age private key lives):
#   1. Pull the encrypted blob
scp <kvm-host>:~/backups/msgschool/db-YYYY-MM-DD.sql.gz.age /tmp/

#   2. Decrypt with the offline private key (load it into ~/credentials/msgschool-backup-age/key.age first; do not leave it there after)
age -d -i ~/credentials/msgschool-backup-age/key.age /tmp/db-YYYY-MM-DD.sql.gz.age > /tmp/db-YYYY-MM-DD.sql.gz

#   3. Verify gzip + content
gunzip -t /tmp/db-YYYY-MM-DD.sql.gz
zcat /tmp/db-YYYY-MM-DD.sql.gz | head -30    # sanity check

#   4. Push to the target VM and restore
scp /tmp/db-YYYY-MM-DD.sql.gz msgschool:/tmp/
ssh msgschool 'sudo -u postgres dropdb msgschool_restore 2>/dev/null; sudo -u postgres createdb msgschool_restore'
ssh msgschool 'zcat /tmp/db-YYYY-MM-DD.sql.gz | PGPASSWORD=msgschool123 psql -h 127.0.0.1 -U msgschool -d msgschool_restore'

#   5. Clean up the plaintext copy on <devops-machine> after verification
shred -u /tmp/db-YYYY-MM-DD.sql.gz
```

**Restore (old plaintext layout — still single file):**

```bash
# from <kvm-host>:
cp ~/backups/msgschool/db-2026-04-20.sql.gz /tmp/
# back to the VM:
scp <kvm-host>:~/backups/msgschool/db-2026-04-20.sql.gz .
gunzip db-2026-04-20.sql.gz
PGPASSWORD=msgschool123 psql -h 127.0.0.1 -U msgschool -d msgschool_restore -f db-2026-04-20.sql
```

**Restore (full — rebuild a new VM):** bring up a fresh Ubuntu VM, run `docs/OPS.md §Bootstrap`, then restore DB + workspaces:

```bash
# DB
PGPASSWORD=msgschool123 psql -h 127.0.0.1 -U msgschool -d msgschool < db-YYYY-MM-DD.sql
# workspaces
sudo tar xzf workspaces-YYYY-MM-DD.tar.gz -C /opt/msgschool/
# config (selective — don't overwrite .env if you re-created secrets)
sudo tar xzf config-YYYY-MM-DD.tar.gz -C /
```

**Restore test cadence: quarterly.** Spin up a scratch VM (the KVM host has plenty of headroom), restore latest, confirm `msgschool.service` starts clean and a test user's `/pulse` completes.

## ToolsD operations

The platform-owned tool daemon (`msgschool-toolsd.service`) handles every Canvas / Skyward upstream call. The agent calls into it via `ms_call <tool> '<json>'`. See `docs/TOOLSD_SPEC.md` for the full design.

```bash
# Status
systemctl status msgschool-toolsd

# Smoke test from inside an agent's workspace (simulates what the agent does)
cd /opt/msgschool/users/canvasagent-100000001/workspace && ms_call tools.healthcheck '{}'
ms_call canvas.connectivity_probe '{}'
ms_call skyward.connectivity_probe '{}'

# Audit log
sudo -u postgres psql msgschool -c "SELECT id, telegram_user_id, tool, cache_hit, latency_ms, error_code, created_at FROM ms_tool_calls ORDER BY id DESC LIMIT 20;"

# Restart (clears the in-process LRU cache + response cache)
sudo systemctl restart msgschool-toolsd
```

The credscan timer (`msgschool-credscan.timer`, every 2 minutes) periodically scans every agent workspace for plaintext credentials and replaces any matches with `[redacted-credscan]`. It also warns to journalctl if any OpenClaw session jsonl contains credential-shaped lines (those can't be safely sed-edited live; remediate with `find /root/.openclaw/agents/canvasagent-<tg>/sessions/ -mindepth 1 -delete`):

```bash
# See recent sweeper activity
journalctl -t credscan -n 50 --no-pager

# Force an immediate run
sudo systemctl start msgschool-credscan
```

## Health checks

Run from an outside machine (<devops-machine> or a Tailscale peer) every 5 minutes. Alert via Telegram to your own user if a check fails 2x in a row.

```bash
# App reachable via tunnel
curl -sS -o /dev/null -w "%{http_code}" https://msgschool.com/ | grep -q 200

# Tunnel healthy
ssh msgschool 'systemctl is-active cloudflared'

# Webhook still registered
source /etc/msgschool/.env   # or hardcode the token in the check box
curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo" | \
  jq -e '.result.url == "https://msgschool.com/api/bot/webhook" and .result.pending_update_count < 50'

# DB accepting connections
ssh msgschool 'pg_isready -h 127.0.0.1'

# openclaw gateway alive
ssh msgschool 'systemctl --user is-active openclaw-gateway'
```

## Deletion requests (email path)

Our privacy policy says users can email `privacy@msgschool.com` to have their account and data removed. Runbook for handling one:

### 1. Verify identity

The email alone isn't proof. Reply asking them to DM `@MsgSchoolBot` on Telegram with a specific phrase you choose (e.g., *"please send the phrase `delete-verify-847` to the bot from your registered Telegram account"*). Generate a fresh 3-4 character phrase per request. This confirms control of the Telegram identity we'd be deleting.

Check their inbound arrived in `ms_messages`:

```bash
ssh msgschool
PGPASSWORD=msgschool123 psql -h 127.0.0.1 -U msgschool -d msgschool \
  -c "SELECT telegram_user_id, telegram_username, created_at FROM ms_messages
      WHERE text = 'delete-verify-847' ORDER BY created_at DESC LIMIT 3;"
```

Their `telegram_user_id` is the one to act on. Do NOT accept the verification phrase from a reply to you by email — it must come via the bot.

### 2. Run deprovision

```bash
ssh msgschool
sudo /var/www/msgschool/scripts/deprovision.sh --telegram-id <tg_id>
```

This removes `/opt/msgschool/users/canvasagent-<tg_id>/` (workspace, credentials, memory, state), and removes the agent entry from `/root/.openclaw/openclaw.json`. The gateway auto-reloads the config.

### 3. Remove DB rows

Deprovision script doesn't touch the DB. Do this manually:

```bash
PGPASSWORD=msgschool123 psql -h 127.0.0.1 -U msgschool -d msgschool <<SQL
BEGIN;
DELETE FROM ms_code_redemptions
  WHERE user_id = (SELECT id FROM ms_users WHERE telegram_user_id = <tg_id>);
DELETE FROM ms_messages WHERE telegram_user_id = <tg_id>;
DELETE FROM ms_users WHERE telegram_user_id = <tg_id>;
COMMIT;
SQL
```

### 4. Purge from backups (optional, depending on retention window)

Their data is still in any backup tarballs captured before deletion, up to the 30-day retention window. Policy permits this. If the requester specifically asks for immediate backup scrubbing:

```bash
sudo -u <vm-user> ssh <kvm-host> '
  for f in ~/backups/msgschool/workspaces-*.tar.gz* ~/backups/msgschool/db-*.sql.gz*; do
    echo "$f — contains this user?  (manual inspection / redecrypt required if encrypted)"
  done
'
```

Typically we let the 30-day window handle it and note that in the reply. If they insist, the operator can re-create backups without their data and replace.

### 5. Reply to requester with receipt

Template:

> Hi <name>,
>
> Your MsgSchool account has been deleted as requested. Confirmation:
> - Telegram user ID **<tg_id>** removed from our database at **<UTC timestamp>**
> - Workspace `/opt/msgschool/users/canvasagent-<tg_id>/` removed from our server
> - Message history and credential files purged
> - Backup rotation: any remaining copies in our 30-day backup window will be pruned automatically by **<date + 30d>**.
>
> If you sent the bot any further messages after this timestamp, they were dropped.
>
> — MsgSchool

### 6. Log it

Append a line to `/var/log/msgschool-deletions.log` on the VM:

```
<UTC> telegram_id=<tg_id> requested_via=email confirmed_via=telegram operator=<you> notes="<free text>"
```

This is the audit trail for "we handled a deletion request" without retaining anything about the deleted user's content.

## Common troubleshooting

### Symptom: Telegram says "webhook failed"
- `getWebhookInfo` — check `last_error_message` and `last_error_date`.
- Common causes: tunnel down, `/etc/msgschool/.env` has wrong `TELEGRAM_WEBHOOK_SECRET`, app throwing on webhook handler.
- Fix tunnel: `sudo systemctl restart cloudflared`.
- Fix secret mismatch: re-run the `setWebhook` curl with the same secret the app expects.

### Symptom: agent returns no text
- Check `journalctl -u msgschool -n 200` for `[dispatch] no reply` or embedded-fallback warnings.
- Check `journalctl --user -u openclaw-gateway` for WebSocket 1006 closures.
- Nuclear: `systemctl --user restart openclaw-gateway` then have the user retry.

### Symptom: Canvas probe fails with 401
- User's token expired or wrong. Agent should already report this honestly per `CANVAS_PROBE_REFERENCE.json`. If the agent is saying something else, the PERSONA or probe reference drifted — re-check symlinks.

### Symptom: Skyward probe fails with TCP timeout
- Expected on DO SFO2 droplet (deprecated). On home VM this should work — the whole point of the move. If it *doesn't* work from the home VM, then either:
  - `virbr0` NAT is misconfigured (test: `curl` from the VM directly — should return 200 from Skyward).
  - The user's district has a different block on the home ISP. Try from <devops-machine> to confirm residential IP reach.

### Symptom: "agent returned no text" sporadic
- Known: gateway WebSocket drops to embedded fallback; the balanced-brace JSON scanner in `src/lib/bot/provision.ts` recovers it. If this is happening >20% of turns, dig into gateway logs and restart.

## Cutover plan — DO droplet → home VM

The DO droplet at `<droplet-ip>` (MarketPlace) is the current production. This VM replaces it. Do it in parallel, validate, swap.

**Phase 1: stand up home VM (silent parallel)**

1. Bootstrap per the "Bootstrap" section above, but **DO NOT register the Telegram webhook yet**. The app listens locally but receives nothing.
2. Pull prod data onto the VM:
   ```bash
   # from DO droplet
   sudo -u <vm-user> ssh root@<droplet-ip> \
     "PGPASSWORD=msgschool123 pg_dump -h 127.0.0.1 -U msgschool msgschool" \
     | psql -h 127.0.0.1 -U msgschool -d msgschool
   # sync user workspaces
   sudo -u <vm-user> rsync -aAX --numeric-ids \
     root@<droplet-ip>:/opt/msgschool/users/ /opt/msgschool/users/
   ```
3. Smoke test: create a test user row manually, run `scripts/provision.sh`, confirm workspace + openclaw config land correctly.
4. Test Skyward probe from VM: should succeed now (home ISP, unblocked).

**Phase 2: DNS swap (~5 min downtime)**

1. `curl deleteWebhook` against the DO droplet's token so it stops receiving.
2. Register webhook to `https://msgschool.com/api/bot/webhook` against the home VM tunnel (same token; same Telegram bot).
3. Test: DM `@MsgSchoolBot`. Response should come from the home VM (check `journalctl -u msgschool -f` on VM).
4. `cloudflared tunnel route dns` should already point the hostname at the home tunnel; if not, swap in Cloudflare dashboard.

**Phase 3: observe 1 week parallel-down**

- Home VM handles production.
- DO droplet stays powered on, service stopped, as hot spare.
- Monitor health checks, user reports, logs. If anything regresses, re-register webhook to DO droplet and investigate.

**Phase 4: retire DO droplet**

- Snapshot the droplet for 90-day retention.
- Power down.
- Remove from DO after 30 days if no regressions.
- Update `docs/ARCHITECTURE.md` to drop droplet references.

## VM-level operations (on the KVM host)

```bash
# status
virsh list --all

# snapshot before risky change
virsh snapshot-create-as msgschool pre-<change> --description "<what>" --disk-only --atomic

# list snapshots
virsh snapshot-list msgschool

# pause / resume (keeps RAM state)
virsh suspend msgschool
virsh resume msgschool

# graceful shutdown
virsh shutdown msgschool

# hard stop (equivalent to pulling the plug — last resort)
virsh destroy msgschool

# start
virsh start msgschool

# console (when SSH is down)
virsh console msgschool
# exit console with Ctrl-]
```

## Known quirks

- **Gateway WebSocket 1006 closures happen intermittently.** Not fully diagnosed. Mitigation: `runAgentTurn()` captures stderr + runs a balanced-brace JSON scanner to recover from the embedded fallback. If it stops working, the first place to look is `journalctl --user -u openclaw-gateway`.
- **PERSONA.md is copied per user, not symlinked.** Template updates don't flow to existing users automatically. Use the for-loop cp in "Deploy a code change" to push updates.
- **`waitUntil: 'networkidle'` must NOT be used on Skyward `page.goto`.** Portal keeps polling open. Use `domcontentloaded` + explicit `#login.waitFor()`. Documented in `SKYWARD_PROBE_REFERENCE.json`.
- **Don't edit `/root/.openclaw/openclaw.json` by hand during a release.** The `bootstrap-droplet.sh` script owns it. Hand-edits get clobbered on re-run.

## Change log

- 2026-04-20 — initial playbook, written alongside the security spec for the home-VM cutover.

# msgschool — Security Spec

Authoritative rules for how msgschool runs on the home-hosted VM (`msgschool` on the KVM host, `<vm-ip>`). The spec is the contract: anything on production must match what's described here. Deviations need a recorded reason.

## Scope & threat model

**What we defend against:**

- Opportunistic internet scanners / brute-force (SSH, HTTP, Telegram webhook replay).
- A single msgschool dependency / container getting popped — the blast radius must stay inside one VM.
- Credential exposure (Telegram bot token, model-provider API keys, per-user Canvas tokens, per-user Skyward passwords) via leaked logs, leaked backups, or a compromised app process.
- Prompt injection / misuse of the agent as a forwarding proxy to other services.
- Accidental damage from the operator (us) — bad merges, bad deploys, leaked commits.

**What we explicitly do NOT defend against:**

- Targeted attack by a nation-state or a skilled adversary specifically after msgschool.
- A full compromise of the KVM host. If the hypervisor is owned, everything above it is owned; out of scope.
- Compromise of third parties we rely on — Cloudflare, Telegram, the LLM provider(s) we currently route to, Canvas, Skyward district portals.
- A malicious msgschool user exfiltrating their *own* credentials (they supplied them).

**Data sensitivity:**

- No PII beyond first name + Telegram username.
- No SSN, DOB, address, payment info.
- Per-user: Canvas personal access tokens, Skyward portal credentials, cached grade/attendance snapshots. These are sensitive to the user but not regulated health/financial data.

## Host & network

**Host:** single KVM VM on the KVM host.

- `msgschool` (alias `msg` in `~/.ssh/config`), `<vm-ip>`, Ubuntu 24.04 LTS, 4 vCPU / 4 GB RAM / 100 GB disk / 4 GB swap.
- Libvirt autostart on; snapshot before any risky change.

**Network boundaries (must match):**

| Source | Destination | Port | Allowed? |
|---|---|---|---|
| Internet | msgschool VM | any | **No.** Router has no port-forward to <vm-ip>. |
| Internet → Cloudflare Tunnel → msgschool | `:3000` (Next.js) | only `/api/bot/webhook` + static routes | Yes, via cloudflared client only. |
| Tailscale mesh (admin devices) | msgschool VM | 22 (SSH) | Yes. |
| <vm-subnet>/24 LAN on the KVM host | msgschool VM | 22 | Yes (current path from <devops-machine> → <kvm-host> → VM). |
| msgschool VM | Internet (egress) | 443 | Yes, restricted allowlist — see below. |
| msgschool VM | Main LAN <lan-subnet>/24 | any | **No.** Libvirt `virbr0` is NAT; no LAN routes. Keep it that way. |

**Inbound firewall on the VM (nftables / UFW):**

- Default `DROP` inbound.
- Allow ICMP echo from local LANs (troubleshooting).
- Allow `tcp/22` from `<vm-subnet>/24` and Tailscale interface only.
- Allow `tcp/3000` from loopback only (cloudflared connects on 127.0.0.1:3000; no remote access).
- Everything else dropped.

**Outbound egress allowlist** (nftables output chain or equivalent — start permissive, tighten once working):

- `api.telegram.org`, `*.telegram.org` :443
- `*.instructure.com` :443 — Canvas API endpoints
- Skyward district portal hosts as users are added — maintain a file `/etc/msgschool/skyward-allowlist` with host entries; nftables reloads on change.
- LLM provider endpoints :443 — agent inference (the active hostnames track `models.providers.*.baseUrl` in `/root/.openclaw/openclaw.json`; re-derive when routing changes)
- Cloudflare tunnel endpoints (required for `cloudflared`)
- Tailscale control plane + DERP relays
- Ubuntu/Canonical apt mirrors, GitHub (`github.com`, `api.github.com`, `codeload.github.com`, `*.githubusercontent.com`) — on-demand during deploys
- DNS :53 (udp/tcp) to `127.0.0.53`

Everything else dropped. Alert on drop events (see Monitoring).

**No inbound SSH from the internet.** Ever. Admin path is Tailscale → VM, or LAN → VM.

## Public exposure

**Cloudflare Tunnel is the only path from the internet to the app.**

- `cloudflared` runs as a systemd service on the VM, outbound to Cloudflare only.
- Tunnel config at `/etc/cloudflared/config.yml`; credentials file at `/etc/cloudflared/<tunnel-id>.json` (mode 0600, root-owned).
- Public hostname `msgschool.com` + `www.msgschool.com` map to the tunnel.
- Cloudflare proxied (orange cloud), TLS 1.2+ only, automatic HTTPS rewrite, Bot Fight Mode on.
- WAF rule: block anything to `/api/*` except `/api/bot/webhook`. Block direct Next.js internal routes.
- **No public DNS A/AAAA record points at the home IP.** Only the tunnel hostname resolves.
- Telegram webhook secret header (`X-Telegram-Bot-Api-Secret-Token`) checked by msgschool before processing any update — rejects any non-Telegram caller.

## Admin access

**SSH:** public-key only. `PasswordAuthentication no`, `PermitRootLogin no`, `ChallengeResponseAuthentication no`, `UsePAM no` (or minimal). Only the keys that must work are:

- The operator's key (`<vm-user>@<devops-machine-ip>`) — the operations identity.
- The <devops-account>@<devops-machine> key if/when added for this agent's work.

**Tailscale** runs on the VM, `tailscale up --ssh` optional but preferred for break-glass access independent of LAN routing.

**Sudo:** `readystack` has passwordless sudo for operational commands; document any service-specific sudoers edits in `/etc/sudoers.d/msgschool`.

**No shared accounts.** No generic `admin` or `deploy` user.

## Application boundaries

**Services on the VM, in systemd:**

- `msgschool.service` — the Next.js webhook, a `Type=simple` systemd unit listening on `127.0.0.1:3010`. Runs as `readystack` (not root).
- `openclaw-gateway.service` — user unit under `readystack`, spawns per-user agents.
- `postgresql.service` — bound to `127.0.0.1:5432`, password-protected, no TCP connections from LAN. `pg_hba.conf` allows only `host ... 127.0.0.1/32 scram-sha-256`.
- `cloudflared.service` — the tunnel client.
- `tailscaled.service` — the Tailscale daemon.
- `nftables.service` — firewall.
- `unattended-upgrades.service` — auto security patches.
- `fail2ban.service` — SSH brute-force ban (SSH is LAN-only so the exposure is low, but cheap to run).

**User workspace isolation:**

- Each user gets `/opt/msgschool/users/canvasagent-<tg_id>/workspace/` with `credentials/*.json` mode `0600`, directory `0700`.
- Workspaces are owned by `root:root`; only the openclaw-gateway running the user's agent reads them via the gateway's runtime.
- Workspace paths never leave the VM.

**Agent sandboxing:**

- OpenClaw agents are per-user in their own workspace tree, but they run *as the same OS user* as the gateway. That's the current limit — it's not strong isolation.
- The agent's browser tool is sandboxed by Chromium (`--no-sandbox` flag notwithstanding — the OS user boundary is what matters, not Chromium's seccomp; we run on Linux without setuid chromium).
- Agents cannot read other users' workspaces because the gateway binds them to a specific workspace path at invocation time. Do NOT let an agent follow symlinks out of its workspace.

**No user-supplied code execution.** Agents produce text responses and call a fixed set of tools (read/write within workspace, browser, web_fetch, web_search). They do not execute arbitrary code on the host. Keep it that way.

## Credentials

**Location:**

- Platform secrets (Telegram bot token, Postgres password, Cloudflare tunnel creds) in `/etc/msgschool/.env` (mode 0640, `root:readystack`). Loaded by systemd unit via `EnvironmentFile=`. Model-provider API keys live in `/root/.openclaw/openclaw.json` (mode 0600, root-owned), read by the OpenClaw gateway only.
- Per-user credentials in `/opt/msgschool/users/<agent>/workspace/credentials/*.json` (mode 0600, root-owned).
- **No secrets committed to the repo.** `.env.example` is the only allowed template. Verify with a pre-commit hook: anything matching common secret patterns (`sk-*`, 40+ char opaque, `ghp_*`, JWT prefix, `-----BEGIN`) refuses to commit.

**Rotation cadence:**

- Telegram bot token: rotate on compromise, or quarterly. See `docs/OPS.md` for procedure.
- Model-provider API keys: rotate on compromise. All msgschool user agents share one key per provider; user compromise of their own workspace does NOT leak these keys (they live in `/root/.openclaw/openclaw.json`, not in workspace). A *platform* compromise does. Rotate annually + on any incident.
- Cloudflare tunnel token: rotate annually.
- Per-user Canvas tokens / Skyward passwords: the user rotates these at their Canvas/district. msgschool never rotates them on the user's behalf.

**Backups:**

- Nightly cron (3:17 AM UTC, `/etc/cron.d/msgschool-backup`) runs `/usr/local/sbin/msgschool-backup` as root.
- Writes three files to `/var/backups/msgschool/` (mode 0640, `root:readystack`): `db-YYYY-MM-DD.sql.gz`, `workspaces-YYYY-MM-DD.tar.gz`, `config-YYYY-MM-DD.tar.gz`.
- Immediately rsync-pushes the directory to `<operator>@<lan-host-ip>:backups/msgschool/` (the KVM host). The remote SSH key on <kvm-host> is locked by `command=~/bin/<accept-script>` which only accepts `rsync --server` calls into that exact path — a compromised VM cannot SSH anywhere else with that key.
- Local retention: 14 days. KVM-host-side retention: indefinite for now (prune plan TBD — 209GB free on <kvm-host> so we have runway).
- No cloud off-site — all backups stay inside the home network. This matches the "local only" decision (2026-04-20).
- Restore-test: quarterly. Procedure in `docs/OPS.md` §Backups.

## Data retention & privacy

- **Messages table** (`ms_messages`) — Telegram inbound/outbound log. Retain 90 days; nightly job prunes anything older. (Don't let it grow forever; you don't need it to debug an incident beyond that horizon.)
- **User rows** (`ms_users`) — retain indefinitely while the user is active; on explicit deletion request or on expiry + 30 days idle, deprovision and delete the row + workspace.
- **Agent memory files** — per-user, the user can `/reset` to clear. No cross-user retention.
- **Logs** (`journalctl`) — rotate weekly, keep 4 weeks compressed (configured via `journald.conf`).
- **Canvas/Skyward cached data** in workspaces: treat as sensitive, never copy outside the user's workspace directory.

## Patching discipline

- `unattended-upgrades` handles security patches. Config restricts to `${distro_id}:${distro_codename}-security` — no auto-upgrades to non-security updates.
- `dependabot` on the msgschool GitHub repo for npm security alerts.
- Monthly calendar reminder: review `npm audit`, review `apt list --upgradable`, review Cloudflare / Tailscale / cloudflared releases. Upgrade deliberate, not reactive.
- **Kernel upgrades:** accept on reboot. Schedule a monthly maintenance-window reboot during low-traffic hours (Sunday 3 AM MT).

## Monitoring & audit

**Logs to keep:**

- `journalctl -u msgschool` — app stdout/stderr, kept 4 weeks.
- `journalctl -u openclaw-gateway` — agent gateway, kept 4 weeks.
- `/var/log/nftables-drops.log` — firewall denies. Alert (email or Telegram) if drops exceed 100/hour from a single source.
- Cloudflare access logs — retained in Cloudflare for 3 days on free tier; that's OK for casual review.
- PostgreSQL slow-query log (>1s).

**Health checks:**

- `cloudflared` tunnel status — check every 5 minutes, alert if down for >10 minutes.
- Telegram webhook `getWebhookInfo` — check hourly, alert if `pending_update_count > 100` or webhook URL has drifted.
- msgschool app reachable via tunnel (HEAD on `/` returns 200) — check every 5 minutes.

**Audit:**

- `auditd` installed, configured to log: execs of sudo, modifications to `/etc/msgschool/`, modifications to `/etc/ssh/`, modifications to `/etc/cloudflared/`, modifications to `/etc/nftables.conf`.
- Weekly `aureport --summary` review (or automate a summary into Telegram).

## Break-glass

**Kill msgschool fast** — in priority order, when something is clearly wrong:

1. **Telegram webhook off:** `curl -sS "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/deleteWebhook"` — users stop hitting the service; msgschool keeps running but is deaf.
2. **Cloudflare tunnel off:** `sudo systemctl stop cloudflared` — the public domain becomes unreachable but local state is preserved.
3. **msgschool app off:** `sudo systemctl stop msgschool` — messages queue in Telegram (Telegram retries the webhook; they'll replay when the app comes back).
4. **Full VM pause:** `sudo virsh suspend msgschool` from the KVM host — everything frozen, disk state preserved; `virsh resume msgschool` to come back.
5. **Revoke Cloudflare tunnel token:** in the Cloudflare dashboard. Last resort — requires re-creating the tunnel.

**Rollback a bad deploy:**

- `cd /var/www/msgschool && git log --oneline -10` to find the last known good.
- `git checkout <sha>` → `npm ci` → `npm run build` → `sudo systemctl restart msgschool`.

**Suspected compromise:**

1. Pause the VM (`virsh suspend`). Snapshot its disk (`virsh snapshot-create-as`) BEFORE rebooting — preserve state for forensics.
2. Rotate Telegram bot token, all model-provider API keys configured in `/root/.openclaw/openclaw.json`, Cloudflare tunnel token, all DB creds.
3. Restore from last-known-good backup (see `docs/OPS.md`).
4. Audit what was accessed: `ausearch`, journalctl, Cloudflare logs.
5. Communicate with affected users via Telegram if per-user credentials may have leaked.

## Explicit NON-goals

- **No SOC / SIEM.** Journal + aureport + a weekly eyeball review is enough.
- **No pentest / bug bounty.** Out of scope and out of budget.
- **No IDS/IPS.** AppArmor profiles + nftables + Cloudflare WAF is the layered defense; adding suricata etc. is not worth the operational cost at this scale.
- **No HSM.** Secrets live on encrypted disk in a locked-down file, backed up encrypted to R2. That's the bar.
- **No encryption of data-at-rest beyond disk-level.** The VM disk is on the KVM host's LVM on ZFS; physical access to the KVM host is already a total compromise. Per-file encryption of workspaces is not worth the operational tax.

## Change log

- 2026-04-20 — initial spec, pre-cutover from DO droplet (<droplet-ip>) to home VM (<vm-ip>).

# Off-host backup destination — operator runbook

**Status:** prerequisite step pending (operator). Audit M5 / `architecture.json` exception `no-offhost-backup-destination`.

**Why this matters:** today's daily age-encrypted backups land on the msgschool VM and rsync to the KVM host (same LAN, same building). House fire / flood / power surge that takes both → the backups are gone. Adding one off-LAN destination closes the gap without weakening the at-rest encryption (the age recipient is public; the private key stays offline).

## What you (operator) need to do once

Pick **one** of these two paths. Both are S3-compat object storage. Both work with the same age-encrypted tarballs (no plaintext ever leaves the VM).

### Option A — Cloudflare R2 (recommended)

1. Cloudflare dashboard → **R2 Object Storage** → Create bucket `msgschool-backups`. Choose any region (latency doesn't matter for offline backup).
2. R2 → **Manage R2 API Tokens** → Create token. Permissions: `Object Read & Write`, scope to bucket `msgschool-backups`. Save the resulting Access Key ID + Secret Access Key.
3. Tell me the values via DM/secure channel; I'll add them to `~/credentials/cloudflare.json` as new keys `r2_access_key_id` and `r2_secret_access_key`, and the bucket endpoint URL as `r2_endpoint` (looks like `https://<account-id>.r2.cloudflarestorage.com`).

R2 advantages: $0 egress (you can `rclone sync` back full-history any time), same vendor as the existing Cloudflare Tunnel, free tier covers our backup volume (~250 MB/day × 14-day retention ≈ 3.5 GB total — well under the 10 GB free tier).

### Option B — DigitalOcean Spaces

1. DO dashboard → **Spaces Object Storage** → Create Space `msgschool-backups`.
2. Account → **API → Spaces access keys** → Generate key. Permission: `Read/Write`.
3. Send me the Access Key + Secret. I'll wire them into the backup script.

DO advantages: same vendor as existing DigitalOcean credentials in `~/credentials/digitalocean.json`. Spaces is S3-compat. Egress costs apply (rare for restore-from-backup so not load-bearing).

## What I'll do once you've handed me the keys

The current `/usr/local/sbin/msgschool-backup` script ends with an `rsync` to the KVM host. I'll add a second push immediately after that, using `rclone` (apt-installed on the VM) with a config like:

```
[r2-backups]
type = s3
provider = Cloudflare
access_key_id = <from creds>
secret_access_key = <from creds>
endpoint = <from creds>
acl = private
```

Then the script appends:

```bash
# Off-host destination — age-encrypted only, no plaintext ever sent
rclone --config /etc/msgschool/rclone.conf sync \
  "$BACKUP_DIR/" r2-backups:msgschool-backups/ \
  --include '*.age' \
  --max-age 14d
```

Verification after the first run:

```bash
rclone --config /etc/msgschool/rclone.conf ls r2-backups:msgschool-backups/ | head
# expect: db-YYYY-MM-DD.sql.gz.age, workspaces-YYYY-MM-DD.tar.gz.age, config-YYYY-MM-DD.tar.gz.age
```

## What this does NOT change

- The existing local + the KVM host rsync chain stays in place. R2/Spaces is **additive**, not a replacement.
- The age recipient and private key are unchanged. The off-host bucket holds the same ciphertext as everywhere else; nobody at Cloudflare/DO can decrypt them without the offline private key.
- 14-day retention stays the same. Older `.age` files get deleted from R2/Spaces too via `--max-age 14d`.

## Restoration drill (do this once after the first off-host upload lands)

1. From a fresh machine: install `rclone` and `age`.
2. `rclone copy r2-backups:msgschool-backups/db-<latest>.sql.gz.age /tmp/`.
3. Use the offline age private key to decrypt: `age -d -i /tmp/age.key /tmp/db-*.sql.gz.age | gunzip | head`.
4. If you see `--\n-- PostgreSQL database dump\n--`, the chain works end-to-end.

Document the date you completed the drill and store the receipt with the offline key.

# MsgSchool

Open-source Telegram agent for parents and students who want a 24/7 watchdog over their Canvas and Skyward accounts. Narrow on purpose. No web signup; pair by messaging [@MsgSchoolBot](https://t.me/MsgSchoolBot) and entering a registration code.

- Public site: [msgschool.com](https://msgschool.com)
- Privacy posture and architecture: [msgschool.com/security](https://msgschool.com/security)
- License: MIT (see [`LICENSE`](LICENSE))

## What it does

Watches a student's Canvas and Skyward accounts on the user's behalf and surfaces what matters — assignments, grade changes, missing work, attendance. The user talks to their own dedicated agent in a Telegram thread.

The full architecture is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). The privacy and credential-handling design is in [`docs/SECURITY.md`](docs/SECURITY.md), [`docs/CREDENTIAL_CAPTURE_SPEC.md`](docs/CREDENTIAL_CAPTURE_SPEC.md), and [`docs/TOOLSD_SPEC.md`](docs/TOOLSD_SPEC.md).

## Stack

- **Next.js 16** (App Router) — landing pages + Telegram webhook
- **Postgres + drizzle-orm** — user state, message log, audit
- **Telegram Bot API** — the entire user-facing surface
- **OpenClaw** — per-user agent runtime, one workspace per user
- **msgschool-toolsd** — platform-owned daemon that talks to Canvas (REST) and Skyward (Playwright). Holds decrypted credentials only in its own memory; the agent itself never reads the credential value, only the data it returns.

## Local setup

```bash
# Prereqs: Node 22+, Postgres running locally
cp .env.example .env.local
# fill in DATABASE_URL at minimum

npm install
npm run db:generate && npm run db:migrate
npm run dev
# open http://localhost:3000
```

The bot is disabled in local dev unless you set `TELEGRAM_BOT_TOKEN`. With no token, the webhook endpoint still acks 200 and logs a warning instead of trying to send Telegram messages.

## Scripts

- `npm run dev` — Next dev server
- `npm run build` — production build
- `npm test` — unit tests
- `npm run db:generate` — drizzle migration from schema
- `npm run db:migrate` — apply migrations
- `npm run db:studio` — drizzle studio UI
- `npm run toolsd:start` — run msgschool-toolsd locally

## Production deployment

Production is a Linux VM behind a Cloudflare Tunnel, with no inbound public ports beyond what the tunnel exposes. The full operations runbook is in [`docs/OPS.md`](docs/OPS.md), including the `bootstrap-droplet.sh` script and the `install-toolsd.sh` deploy.

## Security

If you think you've found a security issue, please email **security@msgschool.com** with what you saw, what you tried, and how to reproduce. We answer within 24 hours.

The user-facing security page at [msgschool.com/security](https://msgschool.com/security) explains, in plain language: where credentials live, the four defense layers (inbound scrubbing, in-agent rules, outbound scrubbing, periodic at-rest sweep), and what we explicitly cannot defend against. Operator-side audit notes are kept private; the public docs in this repo describe the architecture.

## License

MIT — see [`LICENSE`](LICENSE).

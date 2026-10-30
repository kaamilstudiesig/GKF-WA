# Operations

Running, configuring, deploying and fixing the app. Current production: Heroku app `gkf-wa` (EU), serving the GKF bot on `wa.goldkraftfitness.com` and the CRM on `crm.goldkraftfitness.com`. Only Kaamil deploys to production.

- [Local development](#local-development)
- [Config vars](#config-vars)
- [Tests](#tests)
- [Deploy to Heroku](#deploy-to-heroku)
- [Incident runbook](#incident-runbook)

## Database migrations

`npm run migrate` (and every server start) applies the bot's migrations (tracked in `schema_migrations`), then the CRM's (`crm_migrations`). On Heroku the `Procfile` release phase runs it before each new version starts. Both use Postgres advisory locks, so a release and a starting dyno can't apply the same migration twice.

## Local development

```bash
npm ci
```

```bash
cp .env.example .env
```

```bash
npm run dev
```

- Bot: http://localhost:3000 (webhook at `/webhook`).
- CRM: http://crm.localhost:3000 (browsers resolve `*.localhost` to your machine). Log in with an account from [`crm/seed/users.example.json`](../crm/seed/users.example.json); on the local database these accounts are created on first start.
- With `DATABASE_URL` empty, the app uses PGlite (Postgres in-process) stored in `./data/pglite`. No database to install. Delete `data/` to start over.
- With `OPENROUTER_API_KEY` empty, the bot gives simple offline replies instead of calling the AI.
- With `META_ACCESS_TOKEN` empty, sends (including CRM replies) are simulated and still saved in the conversation.
- With `TELEGRAM_BOT_TOKEN` empty, staff alerts are skipped.

To fill the CRM with a dozen demo leads, chats and hand-offs, stop `npm run dev` (PGlite allows one process at a time) and run:

```bash
npm run dev:demo-data
```

It refuses to run with `NODE_ENV=production`.

Health checks: `GET /health` (process up) and `GET /health/ready` (database reachable) on the bot host; `GET /health` on the CRM host checks the CRM tables.

## Config vars

All settings are environment variables; `.env.example` lists them with comments.

| Variable | What it is |
| --- | --- |
| `DATABASE_URL` | Postgres URL. Set by Heroku Postgres; leave empty locally. |
| `META_ACCESS_TOKEN`, `META_PHONE_NUMBER_ID` | WhatsApp Cloud API credentials. |
| `META_WEBHOOK_VERIFY_TOKEN` | Any secret string; the same value goes in Meta's webhook settings. |
| `META_APP_SECRET` | Meta app secret, used to check webhook signatures. |
| `OPENROUTER_API_KEY` | OpenRouter key. |
| `OPENROUTER_MODEL`, `OPENROUTER_FALLBACK_MODEL` | Default `deepseek/deepseek-v4.1-flash`, fallback `google/gemini-3.5-flash-lite` (chosen from a 16-model test on GKF lead scenarios, Oct 2026). |
| `AI_MONTHLY_TOKEN_BUDGET`, `AI_MONTHLY_REQUEST_BUDGET` | Monthly AI limits. |
| `AI_HISTORY_MESSAGES` | Earlier messages the AI sees with each reply (default 10). |
| `MAX_BOT_REPLIES_PER_LEAD_PER_DAY` | Bot replies per lead per 24 hours (default 30). At the limit the lead gets one last reply and goes to staff; after that the bot stays quiet. |
| `BOT_PAUSE_HOURS_AFTER_STAFF_REPLY` | Hours the bot stays quiet after a staff reply from the CRM (default 12). New messages from that lead are alerted to Telegram. `0` turns the pause off. |
| `GYM_LATITUDE`, `GYM_LONGITUDE` | Map pin sent after the location answer. Leave empty to send the address only. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Staff alerts and daily backups. |
| `TELEGRAM_OPS_CHAT_ID` | Optional separate Telegram group for technical alerts (failed sends, account warnings). Defaults to `TELEGRAM_CHAT_ID`. |
| `OPS_ALERT_COOLDOWN_MINUTES` | Minutes before the same technical alert repeats (default 30). |
| `CRM_BASE_URL` | CRM address for "Open in CRM" links in Telegram alerts: `https://crm.goldkraftfitness.com`. |
| `CRM_HOSTS` | Hostnames served by the CRM, comma-separated, matched without the port. Default `crm.goldkraftfitness.com,crm.localhost`. |
| `SESSION_TTL_HOURS` | How long a CRM login lasts (default 12). |
| `DISPLAY_TIMEZONE`, `USD_TO_INR` | CRM display timezone (default `Asia/Kolkata`) and the rate for showing AI cost in rupees (default 85). |
| `SEED_USERS_FILE` | Starting staff accounts for `npm run crm:seed` (default `crm/seed/users.example.json`). |
| `DATABASE_POOL_MAX` | Postgres connections for the whole app (default 5; Essential-0 allows 20). |
| `SENTRY_DSN` | Optional error tracking. |

In production (`NODE_ENV=production`) the server refuses to start if the database, Meta or OpenRouter settings are missing. CRM login cookies are `HttpOnly`, `SameSite=Lax` and, in production, `Secure` (Heroku serves the app over HTTPS).

## Tests

```bash
npm test
```

One command runs the bot tests (`test/`) and the CRM tests (`test/crm/`). They run on an in-memory PGlite database and a fake OpenRouter, so they need no services or keys and never call Meta, OpenRouter or Telegram. The CRM tests cover login and password rules, roles, replies, notes, follow-ups, reports, routing by `Host` header, and the bot and CRM migrations running side by side. CI runs the same command on every push and pull request.

### Comparing AI models (optional)

`scripts/eval.js` sends 8 realistic lead messages (pricing, trial booking, discount, injury, complaint, Hinglish beginner, "talk to a human", "Fees?") to each model you name and prints latency, tokens, cost, tool calls, the reply, and a flag when the reply leaks markup. It calls the real API and costs a few cents, so it is not part of `npm test`.

```bash
OPENROUTER_API_KEY=sk-or-... node scripts/eval.js deepseek/deepseek-v4.1-flash google/gemini-3.5-flash-lite
```

## Deploy to Heroku

One Basic dyno ($7/month) and Heroku Postgres Essential-0 ($5/month), about $12/month for both the bot and the CRM. The `Procfile` runs the bot and CRM migrations on every release, then starts the web process.

1. Create the app in the EU region:

   ```bash
   heroku create <name> --region eu
   ```

2. Add Postgres (this sets `DATABASE_URL`):

   ```bash
   heroku addons:create heroku-postgresql:essential-0 -a <name>
   ```

3. Set the config vars in the dashboard (**Settings → Config Vars**): `NODE_ENV=production`, the Meta, OpenRouter and Telegram variables, and `CRM_BASE_URL=https://crm.goldkraftfitness.com`. `DATABASE_URL` is set by the add-on; the others in the table have sensible defaults.

4. Deploy, either by connecting the GitHub repo in the dashboard (**Deploy → GitHub**, optionally with automatic deploys) or from your machine:

   ```bash
   git push https://git.heroku.com/<name>.git origin/main:refs/heads/main
   ```

5. After the first deploy, switch the dyno to Basic so it never sleeps:

   ```bash
   heroku ps:type web=basic -a <name>
   ```

6. Custom domain with automatic HTTPS:

   ```bash
   heroku certs:auto:enable -a <name>
   ```

   ```bash
   heroku domains:add wa.goldkraftfitness.com -a <name>
   ```

   ```bash
   heroku domains:add crm.goldkraftfitness.com -a <name>
   ```

   Each command prints a DNS target (`...herokudns.com`). Add a CNAME record for each hostname at your DNS provider, then wait for `heroku certs:auto -a <name>` to show both certificates as issued.

7. Create the starting CRM staff accounts (owner, manager, sales) from [`crm/seed/users.example.json`](../crm/seed/users.example.json). It is safe to run again; existing emails are left alone.

   ```bash
   heroku run npm run crm:seed -a <name>
   ```

   To use your own list instead, copy the file to `crm/seed/users.json` (git-ignored), edit it, and run the seed from your machine against the Heroku database: `DATABASE_URL=$(heroku config:get DATABASE_URL -a <name>) SEED_USERS_FILE=./crm/seed/users.json npm run crm:seed`.

8. First login: open https://crm.goldkraftfitness.com, log in as the owner with the password from the seed file, and set a new password when asked (every seeded account must change its password at first login; at least 10 characters with letters and numbers). Then have the manager and sales accounts do the same, or reset their passwords from **Staff**. Add the rest of the team from **Staff**.

9. Daily backup: Heroku Postgres takes a daily backup (`heroku pg:backups:schedule DATABASE_URL --at '03:00 Asia/Kolkata' -a <name>`, set up for `gkf-wa`). For an off-site copy, the free Heroku Scheduler can also run `npm run backup` daily; it sends a gzipped JSON of the bot and CRM tables (leads, chats, staff accounts, notes, assignments, follow-ups; not login sessions) to the staff Telegram group. To restore into an empty database, download the file from Telegram and run `heroku run --no-tty "node scripts/restore.js /dev/stdin" -a <name> < gkf-wa-....json.gz` (locally: `npm run restore -- <file>`).

10. Check `https://wa.goldkraftfitness.com/health`, then in the Meta app dashboard (**WhatsApp → Configuration**) change the webhook URL to `https://wa.goldkraftfitness.com/webhook` with the same verify token. Send a test message.

11. Retire Render: once Heroku has handled real messages, delete the Render service and remove `render.yaml` from the repo.

## Incident runbook

**Automatic alerts** (Telegram ops group + Sentry, at most once per problem every 30 minutes):

- *WhatsApp replies are failing*: a send failed for an account reason (token lost permissions or expired, payment problem, account locked or blocked, number not registered). The alert names the Meta error code and the fix.
- *WhatsApp is throttling our messages*: rate or spam limits.
- *Several WhatsApp sends failed*: 3 unexplained failures within 10 minutes.
- *WhatsApp account needs attention / account update*: Meta's `account_update`, `phone_number_quality_update`, `account_alerts`, `account_review_update` and `business_capability_update` webhooks. These only arrive if the fields are ticked in the Meta app: **WhatsApp → Configuration → Webhook fields**.

Per-message failures (for example the 24h window closed for one lead) are logged, not alerted.

**Bot gets messages but nobody receives replies**
1. `heroku logs -n 300 -a gkf-wa | grep -i "send failed"`.
2. Graph error `100` / subcode `33` on `/<phone id>/messages` = the token lost WhatsApp permissions. Check it: `curl "https://graph.facebook.com/v23.0/debug_token?input_token=$T" -H "Authorization: Bearer $T"` and look at `scopes`.
3. Fix: Business Settings → System users → Generate token with `whatsapp_business_messaging`, `whatsapp_business_management`, `catalog_management`, never expiring. `heroku config:set META_ACCESS_TOKEN=... -a gkf-wa`, update local `.env`.
4. Resend the latest failed reply per lead (only within 24h of their last message): set those `outbound_messages` rows back to `pending` with `attempts = 0`.

**No messages arriving at all**
1. `curl https://wa.goldkraftfitness.com/health` and `/health/ready`.
2. Meta app → WhatsApp → Configuration: webhook URL and `messages` subscription.
3. `heroku logs` for `signature` errors (wrong `META_APP_SECRET`).

**AI replies stopped, fallback text instead**
1. OpenRouter key limit or credits (check the OpenRouter dashboard).
2. `ai_usage` rows with `success = false` and their `error_type`.
3. Monthly budget reached (`AI_MONTHLY_TOKEN_BUDGET`, `AI_MONTHLY_REQUEST_BUDGET`).

**Database**
- `heroku pg:info -a gkf-wa`; backups: `heroku pg:backups -a gkf-wa`.
- `heroku pg:psql` can fail on networks that block port 5432; use `heroku run` with a small node script instead.

Errors also go to Sentry (`SENTRY_DSN`).

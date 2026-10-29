# Gold Kraft Fitness WhatsApp bot and staff CRM

One app, two hostnames:

- **Bot** on `wa.goldkraftfitness.com`: answers people who message Gold Kraft Fitness on WhatsApp. It replies within seconds, learns each lead's name and goal, and hands the lead to a coach (with a Telegram alert) when they are ready to book, want a discount, ask about an injury, complain, or ask for a human.
- **Staff CRM** on `crm.goldkraftfitness.com`: where the team reads conversations, replies on WhatsApp, moves leads through the pipeline, assigns them, keeps notes and follow-ups, and sees reports. Its code lives in [`crm/`](crm/README.md).

Both run in one Node process on one Heroku dyno and share one Postgres database and one connection pool. The app picks the CRM or the bot by the request's `Host` header: hostnames listed in `CRM_HOSTS` get the CRM, everything else (including the `herokuapp.com` address) gets the bot.

Stack: Node 24, Express, EJS (CRM pages), Postgres (Heroku Postgres in production, PGlite locally), Meta WhatsApp Cloud API, OpenRouter for the AI.

## How a message flows

1. **Webhook.** Meta sends `POST /webhook`. The bot checks the `X-Hub-Signature-256` signature, saves the event to the `webhook_events` queue and answers `200` straight away. If saving fails it answers `500`, so Meta retries (events are deduplicated, so retries are safe).
2. **Inbound queue.** A worker claims queued events with `FOR UPDATE SKIP LOCKED`, one message per lead at a time, so a lead's messages are answered in order. It saves the lead and the message, sends a read receipt and typing indicator, and records Click-to-WhatsApp ad details when the lead came from an ad.
3. **Deciding the reply**, in this order:
   - **Safety check:** injury or medical questions get a fixed, non-diagnostic reply and go to a coach.
   - **Fixed replies:** common questions (hours, location, "talk to a human", ...) get a set answer with no AI cost.
   - **AI:** everything else goes to the OpenRouter model, which can call `save_lead` (name, goal, stage) and `notify_staff` (hand-off). A fallback model is used only when the main one has a temporary error. Monthly token and request budgets stop runaway costs; when reached, leads go to staff.
4. **Outbound queue.** The reply is saved to `outbound_messages` and a second worker sends it through the WhatsApp API, retrying temporary errors with backoff.

Hand-offs create a row in `handoffs` and post an alert to the staff Telegram group, with an "Open in CRM" link.

Staff replies sent from the CRM go into the same `outbound_messages` queue, so the bot's worker sends them from the GKF number. The CRM keeps its own data in `crm_`-prefixed tables (see [crm/README.md](crm/README.md)).

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
- CRM: http://crm.localhost:3000 (browsers resolve `*.localhost` to your machine). Log in with an account from [`crm/seed/users.example.json`](crm/seed/users.example.json); on the local database these accounts are created on first start.
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
   git push heroku heroku-crm:main
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

7. Create the starting CRM staff accounts (owner, manager, sales) from [`crm/seed/users.example.json`](crm/seed/users.example.json). It is safe to run again; existing emails are left alone.

   ```bash
   heroku run npm run crm:seed -a <name>
   ```

   To use your own list instead, copy the file to `crm/seed/users.json` (git-ignored), edit it, and run the seed from your machine against the Heroku database: `DATABASE_URL=$(heroku config:get DATABASE_URL -a <name>) SEED_USERS_FILE=./crm/seed/users.json npm run crm:seed`.

8. First login: open https://crm.goldkraftfitness.com, log in as the owner with the password from the seed file, and set a new password when asked (every seeded account must change its password at first login; at least 10 characters with letters and numbers). Then have the manager and sales accounts do the same, or reset their passwords from **Staff**. Add the rest of the team from **Staff**.

9. Daily backup: add the free Heroku Scheduler add-on (`heroku addons:create scheduler:standard -a <name>`) and schedule `npm run backup` once a day. It sends a gzipped JSON of the bot and CRM tables (leads, chats, staff accounts, notes, assignments, follow-ups; not login sessions) to the staff Telegram group. To restore into an empty database, download the file from Telegram and run `heroku run --no-tty "node scripts/restore.js /dev/stdin" -a <name> < gkf-wa-....json.gz` (locally: `npm run restore -- <file>`).

10. Check `https://wa.goldkraftfitness.com/health`, then in the Meta app dashboard (**WhatsApp → Configuration**) change the webhook URL to `https://wa.goldkraftfitness.com/webhook` with the same verify token. Send a test message.

11. Retire Render: once Heroku has handled real messages, delete the Render service and remove `render.yaml` from the repo.

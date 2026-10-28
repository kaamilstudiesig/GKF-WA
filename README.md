# Gold Kraft Fitness WhatsApp bot

Answers people who message Gold Kraft Fitness on WhatsApp. It replies within seconds, learns each lead's name and goal, and hands the lead to a coach (with a Telegram alert) when they are ready to book, want a discount, ask about an injury, complain, or ask for a human. Staff work the leads in the separate CRM (GKF-WA-CRM), which reads the same Postgres database.

Stack: Node 24, Express, Postgres (Heroku Postgres in production, PGlite locally), Meta WhatsApp Cloud API, OpenRouter for the AI.

## How a message flows

1. **Webhook.** Meta sends `POST /webhook`. The bot checks the `X-Hub-Signature-256` signature, saves the event to the `webhook_events` queue and answers `200` straight away. If saving fails it answers `500`, so Meta retries (events are deduplicated, so retries are safe).
2. **Inbound queue.** A worker claims queued events with `FOR UPDATE SKIP LOCKED`, one message per lead at a time, so a lead's messages are answered in order. It saves the lead and the message, sends a read receipt and typing indicator, and records Click-to-WhatsApp ad details when the lead came from an ad.
3. **Deciding the reply**, in this order:
   - **Safety check:** injury or medical questions get a fixed, non-diagnostic reply and go to a coach.
   - **Fixed replies:** common questions (hours, location, "talk to a human", ...) get a set answer with no AI cost.
   - **AI:** everything else goes to the OpenRouter model, which can call `save_lead` (name, goal, stage) and `notify_staff` (hand-off). A fallback model is used only when the main one has a temporary error. Monthly token and request budgets stop runaway costs; when reached, leads go to staff.
4. **Outbound queue.** The reply is saved to `outbound_messages` and a second worker sends it through the WhatsApp API, retrying temporary errors with backoff.

Hand-offs create a row in `handoffs` and post an alert to the staff Telegram group.

## Local development

```bash
npm ci
cp .env.example .env
npm run dev
```

- With `DATABASE_URL` empty, the bot uses PGlite (Postgres in-process) stored in `./data/pglite`. No database to install.
- With `OPENROUTER_API_KEY` empty, the bot gives simple offline replies instead of calling the AI.
- With `META_ACCESS_TOKEN` empty, sends are simulated and still saved in the conversation.

Health checks: `GET /health` (process up) and `GET /health/ready` (database reachable).

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
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Staff alerts and daily backups. |
| `CRM_BASE_URL` | Used for "Open in CRM" links in alerts. |
| `SENTRY_DSN` | Optional error tracking. |

In production (`NODE_ENV=production`) the server refuses to start if the database, Meta or OpenRouter settings are missing.

## Tests

```bash
npm test
```

Tests run on an in-memory PGlite database and a fake OpenRouter, so they need no services or keys. CI runs the same command on every push and pull request.

### Comparing AI models (optional)

`scripts/eval.js` sends 8 realistic lead messages (pricing, trial booking, discount, injury, complaint, Hinglish beginner, "talk to a human", "Fees?") to each model you name and prints latency, tokens, cost, tool calls, the reply, and a flag when the reply leaks markup. It calls the real API and costs a few cents, so it is not part of `npm test`.

```bash
OPENROUTER_API_KEY=sk-or-... node scripts/eval.js deepseek/deepseek-v4.1-flash google/gemini-3.5-flash-lite
```

## Deploy to Heroku

One Basic dyno ($7/month) and Heroku Postgres Essential-0 ($5/month). The `Procfile` runs database migrations on every release, then starts the web process.

1. Create the app in the EU region:

   ```bash
   heroku create <name> --region eu
   ```

2. Add Postgres (this sets `DATABASE_URL`):

   ```bash
   heroku addons:create heroku-postgresql:essential-0 -a <name>
   ```

3. Set the config vars in the dashboard (**Settings → Config Vars**): `NODE_ENV=production` plus every variable in the table above except `DATABASE_URL`.

4. Deploy, either by connecting the GitHub repo in the dashboard (**Deploy → GitHub**, optionally with automatic deploys) or from your machine:

   ```bash
   git push heroku heroku-postgres:main
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

   Add the CNAME record it prints (the `...herokudns.com` target) at your DNS provider, then wait for `heroku certs:auto -a <name>` to show the certificate as issued.

7. Daily backup: add the free Heroku Scheduler add-on (`heroku addons:create scheduler:standard -a <name>`) and schedule `npm run backup` once a day. It sends a gzipped JSON of all tables to the staff Telegram group. To restore into an empty database, download the file from Telegram and run `heroku run --no-tty "node scripts/restore.js /dev/stdin" -a <name> < gkf-wa-....json.gz` (locally: `npm run restore -- <file>`).

8. Check `https://wa.goldkraftfitness.com/health`, then in the Meta app dashboard (**WhatsApp → Configuration**) change the webhook URL to `https://wa.goldkraftfitness.com/webhook` with the same verify token. Send a test message.

9. Retire Render: once Heroku has handled real messages, delete the Render service and remove `render.yaml` from the repo.

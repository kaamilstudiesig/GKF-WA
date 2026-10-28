# GKF CRM

Staff CRM for **Gold Kraft Fitness**, served by the GKF WhatsApp bot app on
`crm.goldkraftfitness.com`. It gives the team one place to work the leads the bot captures:
read conversations, reply on WhatsApp, move leads through the pipeline, assign
them, keep notes and follow-ups, and see reports.

Styled after [new.goldkraftfitness.com](https://new.goldkraftfitness.com): black
and gold, Bebas Neue headings, Barlow Condensed labels, Inter body text.

## How it connects to the WhatsApp bot

The CRM runs in the bot's process and uses **the same database and pool**: it
reads and writes the bot's tables directly and keeps its own data in tables
prefixed `crm_`.

| Data | Table | CRM access |
| --- | --- | --- |
| Leads, status, interest, handoff flags, ad info (`metadata.referral`) | bot `leads` | read, and update `status` / `needs_human` / `handoff_reason` |
| Conversation history | bot `messages` | read |
| Bot handoffs | bot `handoffs` | read, mark assigned / resolved |
| Staff replies | bot `outbound_messages` | insert (`dedup_key` = `crm:<uuid>`, `metadata` = `{source:'crm', user_id, user_name}`) |
| AI usage and cost (`cost_usd`) | bot `ai_usage` | read (owner reports, in USD and ₹) |
| Staff accounts, sessions, assignments, notes, follow-ups, activity | `crm_users`, `crm_sessions`, `crm_lead_assignments`, `crm_lead_notes`, `crm_follow_ups`, `crm_activity_log` | read/write |

- **Replies**: when staff send a WhatsApp reply, the CRM queues it in
  `outbound_messages`. The bot's outbound worker sends it from the GKF number
  and records it in `messages`, as it does for bot replies. The bot must be
  running for queued replies to go out (in the merged app it always is).
- **24-hour rule**: WhatsApp only allows free-form replies within 24 hours of the
  lead's last message. The CRM disables the reply box once that window closes,
  and refuses the reply on the server too.
- **Handoffs**: when the bot flags a lead as needing a human, it shows on the
  dashboard. Assigning the lead marks the bot's handoff `assigned`, and "Mark
  handoff resolved" resolves it and clears `needs_human`.
- **Migrations**: the CRM never creates or changes the bot's tables, and never
  touches `schema_migrations` or `webhook_events`. Its own tables are tracked in
  `crm_migrations`. Before migrating it checks the bot tables and columns it
  needs exist, and stops with a clear error if they don't.

## Roles

| | Owner | Manager | Sales |
| --- | :-: | :-: | :-: |
| See leads | all | unassigned + their team's | only their own |
| Reply, notes, follow-ups, change status | ✓ | ✓ | own leads |
| Assign leads | anyone | themselves + their team | – |
| Reports and CSV export | ✓ | ✓ (team) | – |
| WhatsApp bot AI cost | ✓ | – | – |
| Add / edit / disable staff, reset passwords | ✓ | – | – |
| Change own password | ✓ | ✓ | ✓ |

A sales rep's team is set by their "Manager" in **Staff**.

## Running it

The CRM is part of the bot app: it has no server, `package.json` or database
module of its own. `src/app.js` at the repo root sends requests whose `Host`
is in `CRM_HOSTS` to `createCrmApp({ db })`, passing the bot's db module
(`src/db`), so both share one connection pool. See the
[root README](../README.md) for local development, config vars, tests and
Heroku deployment. In short:

- `npm run dev`, then open http://crm.localhost:3000. On the local PGlite
  database the starting accounts are created on first start.
- `npm run dev:demo-data` adds a dozen demo leads (stop `npm run dev` first).
- `npm run crm:seed` (on Heroku: `heroku run npm run crm:seed`) creates the
  starting accounts from [`seed/users.example.json`](seed/users.example.json),
  or from `SEED_USERS_FILE`. Existing emails are left untouched.
- `npm test` runs the CRM tests in `test/crm/` together with the bot's.

The accounts and their starting passwords are listed in
[`seed/users.example.json`](seed/users.example.json). Passwords are stored hashed
(scrypt). Each account must set a new password at first login. To seed your own
list, copy that file to `crm/seed/users.json` (git-ignored) and set
`SEED_USERS_FILE=./crm/seed/users.json`.

CRM settings (all optional): `CRM_HOSTS`, `SESSION_TTL_HOURS` (default 12),
`DISPLAY_TIMEZONE` (default `Asia/Kolkata`), `USD_TO_INR` (default 85),
`SEED_USERS_FILE`.

## Project layout

```
crm/
  src/
    index.js         exports createCrmApp, migrateCrm, checkBotSchema
    app.js           createCrmApp: routes, sessions, CSRF, role checks
    migrations.js    migrateCrm: crm_* tables, bot schema check
    crm.js           leads, conversations, assignment, notes, follow-ups, reports
    users.js         staff accounts and passwords
    permissions.js   role rules and lead visibility
    auth.js          scrypt hashing, sessions, login throttling
    config.js        CRM settings from environment variables
  views/             EJS templates
  public/            CSS and a small progressive-enhancement script
  scripts/seed.js    `npm run crm:seed`
  seed/              starting accounts
test/crm/            CRM tests (run by the root `npm test`)
```

`migrateCrm(db)` checks the bot tables, then applies pending `crm_` migrations
under an advisory lock; `src/migrate.js` runs it right after the bot's
migrations, on every start and in the Heroku release phase.

## Security notes

- Passwords: scrypt with a random salt per user; minimum 10 characters with
  letters and numbers. Plain-text seed passwords only exist in the seed file, and
  every seeded account must change its password at first login.
- Sessions: random 256-bit token in an `HttpOnly`, `SameSite=Lax` cookie
  (`Secure` when `NODE_ENV=production`); only a SHA-256 hash of it is stored.
  Login sessions are not included in backups.
- Every form carries a per-session CSRF token.
- Failed logins are throttled per IP and email.
- CSV exports neutralise spreadsheet formulas.
- CRM pages get their own security headers and Content-Security-Policy; the
  bot's JSON-only `default-src 'none'` policy and JSON 404 apply only to the
  bot host.
- In production, run behind HTTPS (Heroku terminates TLS).

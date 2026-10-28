# GKF CRM

Staff CRM for **Gold Kraft Fitness**. It sits next to the GKF WhatsApp lead bot
(the `WA` repo) and gives the team one place to work the leads the bot captures:
read conversations, reply on WhatsApp, move leads through the pipeline, assign
them, keep notes and follow-ups, and see reports.

Styled after [new.goldkraftfitness.com](https://new.goldkraftfitness.com): black
and gold, Bebas Neue headings, Barlow Condensed labels, Inter body text.

## How it connects to the WhatsApp bot

The bot (GKF-WA) runs on Postgres (Heroku Postgres). The CRM uses **the same
database**: it reads and writes the bot's tables directly and keeps its own data
in tables prefixed `crm_`.

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
  running for queued replies to go out.
- **24-hour rule**: WhatsApp only allows free-form replies within 24 hours of the
  lead's last message. The CRM disables the reply box once that window closes,
  and refuses the reply on the server too.
- **Handoffs**: when the bot flags a lead as needing a human, it shows on the
  dashboard. Assigning the lead marks the bot's handoff `assigned`, and "Mark
  handoff resolved" resolves it and clears `needs_human`.
- **Migrations**: the CRM never creates or changes the bot's tables, and never
  touches `schema_migrations` or `webhook_events`. Its own tables are tracked in
  `crm_migrations`. At startup it checks the bot tables and columns it needs
  exist, and stops with a clear error if they don't.

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

## Setup

Needs **Node.js 22 or newer** (Heroku runs Node 24).

```bash
npm install
```

```bash
cp .env.example .env
```

### Local development (no bot, no Postgres server)

Leave `DATABASE_URL` unset (or set `DATABASE_URL=pglite://./data/pglite`) and run:

```bash
npm run dev
```

The CRM runs on [PGlite](https://pglite.dev) (real Postgres in-process, stored in
`data/pglite`). On first start it loads a demo copy of the bot's tables with 12
sample leads, and creates the starting accounts from
[`seed/users.example.json`](seed/users.example.json). Replies you send are queued
but never sent, since no bot worker is running. Delete `data/pglite` to start over.

### Against the bot's Postgres database

Set `DATABASE_URL` to the bot's database (on Heroku it is already set). Run the
bot's migrations first, then create the starting accounts and start the CRM:

```bash
npm run seed
```

```bash
npm start
```

Then open http://localhost:4000.

The accounts and their starting passwords are listed in
[`seed/users.example.json`](seed/users.example.json). Passwords are stored hashed
(scrypt). Each account must set a new password at first login. To seed your own
list, copy that file to `seed/users.json` (git-ignored) and set
`SEED_USERS_FILE=./seed/users.json`.

## Tests

```bash
npm test
```

Tests use Node's built-in test runner, supertest and PGlite in memory, so no
database server is needed. Each test builds a fresh database with the bot fixture,
the CRM tables and the seeded users. They cover password hashing, login,
first-login password change, CSRF, each role's permissions, status updates
written to the bot's `leads` table, reply queueing and the 24-hour rule, notes,
follow-ups, handoff resolution, the per-ad reports, and `createCrmApp` running on
an injected db behind host-based routing.

## Project layout

```
src/
  index.js         exports createCrmApp, migrateCrm, createDb (for embedding in the bot)
  server.js        standalone runner for local dev
  app.js           createCrmApp: routes, sessions, CSRF, role checks
  db.js            createDb: node-postgres / PGlite, same interface as the bot's db module
  migrations.js    migrateCrm: crm_* tables, bot schema check
  crm.js           leads, conversations, assignment, notes, follow-ups, reports
  users.js         staff accounts and passwords
  permissions.js   role rules and lead visibility
  auth.js          scrypt hashing, sessions, login throttling
dev/
  bot-fixture.js   DEV/TEST ONLY copy of the bot's tables + demo leads (delete after merging)
views/             EJS templates
public/            CSS and a small progressive-enhancement script
scripts/           seed.js
seed/              starting accounts
test/              node:test suites
```

## Using it as a library

```js
const { createCrmApp, migrateCrm } = require('gkf-crm'); // src/index.js

await migrateCrm(db);                 // db: { query, many, one, tx }
const crmApp = createCrmApp({ db });  // opens no connection of its own
```

`createCrmApp({ db, sessionTtlHours, secureCookies, usdToInr })` uses only the db
object it is given. `migrateCrm(db)` checks the bot tables, then applies pending
`crm_` migrations under an advisory lock; it is safe to run on every start.

## Merging into the bot app

Plan: one Heroku app and one process. The bot answers on `wa.goldkraftfitness.com`
and the CRM on `crm.goldkraftfitness.com`, sharing one database and one
connection pool (Essential-0 allows 20 connections).

1. Move `src/` (as e.g. `src/crm/`), `views/`, `public/` and `seed/` into the bot
   repo, and add `ejs` to its dependencies.
2. Pass the bot's own db module (`src/db/index.js`) to the CRM, so both use one pool:

   ```js
   const db = require('./db');
   const { createCrmApp, migrateCrm } = require('./crm');

   await db.init();        // runs the bot's migrations first
   await migrateCrm(db);   // then the CRM's
   const crmApp = createCrmApp({ db });

   app.use((req, res, next) =>
     req.hostname === 'crm.goldkraftfitness.com' ? crmApp(req, res, next) : next());
   // ...bot routes below
   ```

   Put this host check before the bot's body parsers and routes, so CRM
   requests never reach them. Add `crm.goldkraftfitness.com` as a custom domain
   on the Heroku app.
3. Delete `dev/bot-fixture.js` and the fixture branch in `src/server.js`: the
   bot's migrations create those tables. `src/server.js` itself can go too.
4. Run `npm run seed` once (with the bot's `DATABASE_URL`) to create the starting
   staff accounts.

## Security notes

- Passwords: scrypt with a random salt per user; minimum 10 characters with
  letters and numbers. Plain-text seed passwords only exist in the seed file, and
  every seeded account must change its password at first login.
- Sessions: random 256-bit token in an `HttpOnly`, `SameSite=Lax` cookie
  (`Secure` when `NODE_ENV=production`); only a SHA-256 hash of it is stored.
- Every form carries a per-session CSRF token.
- Failed logins are throttled per IP and email.
- CSV exports neutralise spreadsheet formulas.
- In production, run behind HTTPS (Heroku terminates TLS).

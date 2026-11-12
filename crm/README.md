# Staff CRM

Staff CRM served by the WhatsApp bot app on each client's CRM host (GKF's pilot:
`crm.goldkraftfitness.com`). It gives the team one place to work the leads the bot captures:
read conversations, reply on WhatsApp, move leads through the pipeline, assign
them, keep notes and follow-ups, and see reports.

## Branding (white-label, R12)

No business name is written in the views. Every page reads `brand` (set per request
in `crm/src/app.js` from `crm/src/branding.js`):

| What | Where it comes from |
| --- | --- |
| Name (logo text, page titles, login text, "All of …", CSV file name) | Business name in the bot's business profile (Business settings) |
| Logo letters (default: the name's initials) | `crm_branding.mark`, Business settings → Brand |
| Brand colour (default: the theme's gold, `#d4af37`) | `crm_branding.color`; a different colour overrides daisyUI's `--color-primary` inline on `<html>`, with dark or white text picked for contrast |
| Logo image (optional, PNG/JPEG/WebP under 40 KB, no SVG) | `crm_branding.logo_data`, served at `/brand/logo?v=…` (public, so the login page can show it) |

Only the owner can change branding. The theme is called `brand` (`crm/styles/app.css`):
near-black surfaces, Bebas Neue headings, Inter body text.

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
| Staff accounts, sessions, assignments, notes, follow-ups, outcomes, activity | `crm_users`, `crm_sessions`, `crm_lead_assignments`, `crm_lead_notes`, `crm_follow_ups`, `crm_lead_outcomes`, `crm_activity_log` | read/write |

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

## Logging outcomes

Every lead page starts with **Log outcome** (`#outcome`, also where Telegram's "✅ Log outcome" button lands): one tap for *Called, spoke · No answer · WhatsApp sent · Visited · No-show*, and short forms for *Visit booked* (date/time), *Joined* (plan + ₹ paid) and *Lost* (reason). Each outcome updates the lead's status, resolves the bot's hand-off once someone has actually been in touch, and books the next follow-up automatically (no answer → retry in 2h, next day, 3 days, weekly). The rules are in `docs/TEAM.md` under "Lead outcomes".

## Analytics (R5)

`crm/src/analytics.js`: `new Analytics(db).summary(user, { days, now, names, lostNames | type })` returns plain objects (the Reports page renders them; K21 and scripts can call it with no user for the whole business, inside `tenancy.run`). `names` is `namesFor(type).OUTCOMES`, so stage labels follow the business type (real estate: Site visit booked, Booked). Lost reasons use the business type's words: pass `lostNames` (`namesFor(type).LOST_REASONS`, as the Reports page does) or `type`; with neither, the current client's own business type (from its business profile) is used.

| Number | Definition |
| --- | --- |
| Funnel | Leads whose first message is in the period, by the furthest step reached: Leads → Contacted → Qualified → Visit booked → Visited → Won. Outcomes decide (No answer is not contact; No-show still counts as booked), plus statuses the lead moved through in the CRM (a lost lead that was qualified still counts as qualified); the lead's status fills in for leads with no outcome. Each step shows its share of the step before |
| First contact | The first staff reply sent from the CRM or the first outcome logged after a hand-off opened (a logged No answer counts: someone tried). Bot replies don't count |
| Speed to lead | Median **working** minutes from hand-off to first contact (the client's working hours and time zone from **Business settings → Lead queue**; a lead at 2 AM starts counting when the shift starts), for hand-offs opened in the period; plus the share within 5 minutes (only hand-offs that were contacted or have been open 5 working minutes count) and how many are not contacted yet |
| Revenue (tile) | Won amounts **logged in the period**, whatever month the lead came in. The funnel's revenue is different: money from leads first seen in the period |
| Logging rate | Hand-offs with an outcome within 24 h. A hand-off younger than 24 h counts only once it has one. Target 80%+ |
| Sales recorded automatically | Won outcomes in the period that a paid payment link logged (K11) |
| Lost reasons | Lost outcomes logged in the period, by reason, with share |
| By ad (R6) | `byAd(user, range)` (`range()` builds the period): the funnel's leads grouped by the Click-to-WhatsApp ad they came from (`metadata.referral.source_id`), with the same stage rules: leads, contacted, qualified, visit booked, visited, won, revenue from those leads (cohort, paid any time), qualified and win rate, and median speed to lead of their hand-offs. Each row has a `kind`: `ad`; `missing` for leads from an ad whose id Meta didn't send (shown as "Ad (id missing)", never counted as organic); `none` for leads not from an ad. Those two rows come last, so the rows add up to the funnel. `summary()` reads the lead rows once and shares them with the funnel. Sorted by revenue, then leads (Reports can sort by leads) |
| Lead-quality grade | Per ad with at least 10 leads, from the share that reached Qualified: A 50%+, B 30%+, C 15%+, D below. Doesn't wait for sales, which take weeks |
| Spend, cost per sale, ROAS, campaign | From `adSpend(range)`: a `Map` of ad id to `{ spend, campaignId, campaignName }`. It is empty until the ad spend import (K5), which replaces it with a read of its table; until then those columns are hidden and Reports says they appear once spend is imported. Cost per sale = spend ÷ sales; ROAS = revenue ÷ spend |
| By campaign | `Analytics.byCampaign(adRows)` (in `summary().campaigns`): the ad rows with a known campaign summed by `campaignId` (ads, leads, qualified, won, revenue, spend, cost per sale, ROAS). Empty until K5 supplies campaigns; Reports then shows a **By campaign** table under **By ad** |
| Per person (not owners) | First contacts made and their median time, outcomes logged, won, ₹, lost, and the logging rate of hand-offs on leads assigned to them |

Scope follows the user like every other page (owner: all; manager: their team and unassigned leads).

**Reports → By ad** shows `byAd` as a table (full width; scrolls sideways on a phone) and `GET /reports/ads.csv?days=` exports it (owners and managers, same scope and period; formula-looking text is made inert, as in the leads CSV). The old "Ads" table, which counted leads by status only, is gone.

## Adding many staff (R13)

**Staff → Add many** (owner only, `/users/bulk`, `crm/src/bulkStaff.js`). Paste CSV (commas, or tabs from a spreadsheet; a header line is skipped) and/or fill rows of `name, email, role, manager email, WhatsApp number`. Role is owner, manager or sales (empty = sales). Up to 100 people at a time.

- Every row is checked first: email format, already taken, repeated in the list, role, manager (an active manager here or a manager row in the same list, sales only), WhatsApp number with country code. One bad row means **nobody is added**; the rows come back editable with each problem under its row.
- Then all are saved in one transaction: managers first, so sales can point to a manager from the same list. A WhatsApp number turns on alerts for their own leads (`alert_mode = 'mine'`).
- Each person gets a random one-time password (`auth.oneTimePassword`, also used by `crm:owner`), shown once on the result page (`Cache-Control: no-store`) with a CSV download. Only the hash is stored; everyone must change it at first login.

## Live board (R3)

The pipeline updates by itself when anyone changes a lead (the bot, another person, Zoho), and shows **Live** while connected.

- **Database:** platform migration 4 `live_board` adds triggers on `leads` (new lead; status, needs-human, last message, name or interest changed), `crm_lead_assignments`, `crm_lead_outcomes`, `crm_follow_ups` and `handoffs`. Each runs `pg_notify('crm_board', '{"t": <tenant id>}')`: sent on commit, repeats in one transaction folded into one.
- **Servers:** `crm/src/liveBoard.js` LISTENs once per process through `db.listen` (`src/db/index.js`: a dedicated connection that reconnects; each time LISTEN starts, including the first, it pings every open board once, since changes before it were never announced; PGlite's own `listen` locally), so several web dynos all hear every change.
- **Browsers:** the board opens `GET /events` (server-sent events, logged in). A change pings only that client's boards with **no lead data** (`event: board`): changes are gathered for 400 ms, and one client gets **at most one ping every 5 s** (busy ads mean many inbound messages, and each ping reloads every open board); a change inside the gap gets one trailing ping at its end, so the final state always arrives. The page then reloads the board through the normal role-scoped `/pipeline`, so a sales person still sees only their leads. It waits while a card is being dragged or a dialog is open, keeps the scroll position, and sets up drag-and-drop again. A heartbeat every 25 s keeps the connection open through Heroku's router.
- **Overdue:** a card with an open follow-up past due gets a red border and **Follow-up overdue**; the page re-checks every minute, so cards turn red without a change.

## Hot-lead queue (R2)

`crm/src/queue.js` (contract and K19 wiring in `docs/TEAM.md`, "R2 details"). Storage is platform migration 3 `lead_queue`: `crm_users.accepting`, `crm_lead_assignments.escalation_level` and the per-client `crm_settings` table.

- **Business settings → Lead queue** (owner): auto-assign on/off (off by default; shown as **Needs the WhatsApp bot update** and kept off until K19 sets `LeadQueue.botWired = true`, since only the bot assigns hand-offs as they open), working hours and time zone (India or UAE). Turning it on sets `auto_assign_since`; older assignments never escalate.
- `autoAssign(waId, { exclude })`: keeps an active, accepting assignee (and restarts their clock), else the sales person with the oldest latest assignment, the previous assignee's team first. Same writes as a manual assignment, logged as `auto_assigned` with no user. Per-client advisory lock, so two at once pick different people.
- `release(userId)`: hands back leads with an open hand-off that the person hasn't picked up (no CRM reply, no outcome since assignment). Called by the **Taking leads** switch in a sales person's menu and when an owner deactivates someone.
- `sweep(now)`: 5 working minutes not picked up → their manager (owners if none); 15 → every owner; each level once. Returns who to alert; the bot sends (K19).
- `workingMinutes(from, to, settings)`: minutes inside working hours in the client's time zone (shifts past midnight work). Nights don't count.
- **Timers:** "Waiting N min" on lead cards, pipeline cards and the lead page while auto-assign is on and the lead isn't picked up; red from 5. Staff shows **Not taking leads**.

## Zoho CRM status

For clients with the Zoho sync on (K20, `docs/TEAM.md`). `crm/src/zohoStatus.js` reads only our tables (`zoho_links`, `zoho_cursors`) and the client's settings; it never calls Zoho.

- **Business settings → Zoho CRM:** Connected or Off; when Zoho was last read; counts in sync / waiting to send / retrying / not sent; the last 5 leads Zoho refused, with Zoho's reason and a link to each lead; a link to the client's Zoho (`crm.zoho.<data centre>` from `zohoAccountsUrl`). When off, a short note on what it does. Secrets never reach the page.
- **Lead page → Lead details:** "Open deal / contact / lead in Zoho" (the Deal if there is one, else Contact, else Lead; numeric ids only) and the sync state, with Zoho's error when it failed.

Local testing: turning Zoho on locally (even with fake credentials) starts the real sync worker in `npm run dev`, which calls Zoho. Keep it off locally; the tests cover the screens without the worker.

## Installable app (R4)

Staff install the CRM on their phone from their own CRM host. It opens full screen like an app, with the client's name and icon (`crm/src/pwa.js`, all public so the browser can fetch them before login):

- `/manifest.webmanifest`: name and short name from the business name, `start_url` `/`, standalone, dark theme colour, shortcuts (Leads, Follow-ups, Pipeline). Icons: `/brand/icon.svg` (logo letters on the brand colour, plus a maskable version for Android) and the uploaded logo when it is a square PNG.
- `/sw.js` (`crm/public/sw.js` with the deploy's asset version and the client's brand version, so renaming the business or changing its colour makes phones re-cache the offline page): caches only the CSS, JS and `/offline`. **Pages and lead data are never cached** (shared phones, private data). Offline, a page shows **You're offline** instead of the browser's error. A deploy changes the version, so phones pick up new CSS/JS on the next visit.
- Menu: **Install app** appears when the browser offers it (Android Chrome); on iPhone a short hint (Share → Add to Home Screen), since Safari has no install prompt. Both hide once installed. iPhones ignore SVG icons: they use the uploaded logo as the home-screen icon (`apple-touch-icon`), else `/brand/apple-touch-icon.png`, a plain 180×180 tile in the brand colour (built with zlib, no image library). Brand settings tells the owner to upload a square PNG for a proper iPhone icon.
- Icons: PNG `/brand/icon-192.png` and `/brand/icon-512.png` (brand-colour tiles; Chrome needs them to offer **Install app**), the SVG letters, and an uploaded logo when it is a square PNG. iPhones use the logo only when it is a square PNG, otherwise `/brand/apple-touch-icon.png`; Brand settings says so. The short app name is the same on Android and iPhone (`shortName` in `crm/src/branding.js`).

## Waiting for an outcome (R11)

`crm/src/nudges.js`: a lead is waiting when it is still open, needed a person (a bot hand-off, or status hot) and nobody has logged an outcome since, for 2 hours to 30 days (`MIN_AGE_HOURS`, `LOOKBACK_DAYS`). `waitingSql(q, now)` is the SQL used by:

- **Dashboard:** a **No outcome yet** tile and a **Log what happened** list (longest waiting first; each lead opens on its outcome buttons, `#outcome`).
- **Leads:** the **No outcome** chip and checkbox (`?waiting=1`), and the sort **Waiting longest for an outcome** (`sort=waiting`).
- `Nudges.daily(now)`: the per-person morning list the bot sends (contract in `docs/TEAM.md`).

Each person sees only their own leads, as everywhere else. Logging any outcome takes the lead off the list until the bot opens a new hand-off. A hand-off staff resolved without logging an outcome still counts (that is the gap this closes); the 2-hour and 30-day bounds are inclusive. **Limit:** a hot lead with no hand-off is timed from its first message (we don't store when it turned hot), so it is tracked only for 30 days after first contact; one that first wrote 5 weeks ago and turned hot yesterday doesn't show. Leads that need a person almost always get a hand-off from the bot, which restarts the clock.

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
- Sign-in takes a phone number or an email, plus the password. The owner sets each person's sign-in phone on **Staff** (or when adding them; `crm_users.login_phone`, digits with country code, unique per client, platform migration 5). A full number typed without the country code (`98450 12345`, `098450 12345`, at least 10 digits) matches the one stored number ending with it; no match or two matches is treated as unknown. Wrong password, unknown number and ambiguous number all get the same message (with a "try the country code" hint when no code was typed).
- Failed logins (and unusable input) are throttled per IP and person: phones by their last 10 digits, so every spelling of one number shares one budget; emails lowercased, nothing else stripped.
- CSV exports neutralise spreadsheet formulas.
- CRM pages get their own security headers and Content-Security-Policy; the
  bot's JSON-only `default-src 'none'` policy and JSON 404 apply only to the
  bot host.
- In production, run behind HTTPS (Heroku terminates TLS).

# Team guide: Kaamil + Krishna

Krishna: start here. This page explains the idea, how we work, and who builds what. It's also written for your Claude: point it at this file and [`CLAUDE.md`](../CLAUDE.md) first.

## The idea in 60 seconds

Businesses of every kind pay agencies to run Facebook/Instagram ads for leads. The leads land on WhatsApp or in lead forms, and then most of them die: replies are slow, sales forgets to follow up, and nobody knows which ad produced paying customers. Meta can't see the sale either, so it keeps finding people who enquire but never buy.

We fix the whole path from ad to sale, for any business that runs Meta ads (we're not tied to an industry):

1. **Capture:** an AI front desk replies on WhatsApp in seconds, in the lead's language, answers from the business's real facts, qualifies and scores the lead.
2. **Convert:** hot leads go to a salesperson with a 5-minute timer, escalation and one-tap outcomes.
3. **Prove the sale:** the real sale (won + ₹) is captured with as little staff effort as possible: payment links, AI-suggested outcomes, one tap from alerts.
4. **Prove the ads:** the owner and agency see revenue and cost per customer for each ad.
5. **Signal:** a high chat score sends Meta an early qualified event within minutes, and the real outcome follows (Conversions API), so ads find people who actually buy.

**Our edge isn't the chatbot.** Meta now ships its own AI agent for WhatsApp businesses, and other WhatsApp platforms already send chat-based conversion events. Our edge is what happens after the chat: real sales outcomes, an early signal trained on them across all clients, and a record the agency and client both trust. Details: [PRODUCT_PLAN.md §3](PRODUCT_PLAN.md#3-where-we-win-the-moat).

We sell it mainly through marketing agencies as a monthly product. Goldkraft Fitness (GKF), a gym in J.P. Nagar, Bengaluru, is the live pilot because it was the first business we had access to; gyms aren't the target market. The bot and CRM have been running in production since 29 Oct 2026.

Read next, in order:

1. [ARCHITECTURE.md](ARCHITECTURE.md): how it works today, with diagrams, and where it's going.
2. [PRODUCT_PLAN.md](PRODUCT_PLAN.md): features, roadmap, costs, pricing, risks.
3. [META_PLATFORM.md](META_PLATFORM.md): Meta API facts and limits that constrain us.
4. [ONBOARDING.md](ONBOARDING.md) and [OPERATIONS.md](OPERATIONS.md) when you need them.

## Who owns what

We split by **area of the code**, so we rarely edit the same files.

| Area | Owner | Folders |
| --- | --- | --- |
| Meta platform, bot engine, AI, queues, database core, infra, deploys | **Kaamil** | `src/`, `scripts/`, `test/*.test.js`, Heroku, Meta app |
| CRM product: sales floor, live board, phone app, analytics, onboarding/agency UI | **Krishna** | `crm/`, `test/crm/` |
| Product decisions, pricing, pilots with agencies | Both | `docs/` |

Shared contracts (agree in a PR before building on them): new tables both sides use, and the events the CRM emits that the bot side sends to Meta.

## Work split by stage

No dates: we move as fast as we can, and a stage is done when its "done when" in [PRODUCT_PLAN.md §6](PRODUCT_PLAN.md#6-order-of-work) is true. Tasks within a stage can run in parallel.

### 0. Next client fast-track (do this first)

A possible large client wants the chatbot soon. Until this stage is done, it comes before every other task. We do **not** wait for full multi-tenancy (K8). Each new client gets its **own deployment** (own Heroku app and Postgres) from the same code. K8 comes later and moves these clients into one app.

| # | Task | Owner | Done when |
| --- | --- | --- | --- |
| K14 | ✅ **Remove GKF hard-coding from the bot.** Business name, legal pages, default replies and env defaults come from the business profile or config. GKF stays only as seed data | Kaamil | `grep -ri "goldkraft\|gkf" src` finds only seed and test data |
| K15 | ✅ **New-client script** (`scripts/new-client.js`): create the Heroku app + Postgres, set config vars from a checklist file, run migrations, create the owner login, print the webhook URL and verify token | Kaamil | A second app goes live from one command and one config file |
| K16 | ✅ **General business-type preset** in `verticals.js` (services / appointments / retail) plus the client's own type, so the AI sells correctly for a non-gym business | Kaamil | Prompt preview in Business settings reads right for the client's business |
| K17 | ✅ **Per-client safety:** AI budget caps, client name in every ops alert and Sentry event, separate Telegram groups | Kaamil | An alert always says which client it is about |
| K18 | 📝 (written, not yet tested) **Meta access path:** written steps to get WhatsApp access for a business that is not ours, before App Review approval (partner access to their WABA, or a system-user token from their own Business Manager). Check the 250 / 1K message tier and display-name approval early | Kaamil | Steps tested once on a test business |
| R12 | ✅ **White-label CRM:** brand name, logo and colour from the business profile (login, header, page titles, reports text). Remove "GKF" and "Goldkraft" from all views; make the theme name generic | Krishna | No GKF text in `crm/views`; GKF still looks the same |
| R13 | **Team setup for a big client:** bulk-add staff (CSV or a multi-row form), managers with teams, first-login password change | Krishna | Owner adds 20 staff in a few minutes |
| R2 | Hot-lead queue (moved up from stage 2): a big team needs auto-assign and the 5-minute timer from day one | Krishna | Hand-offs reach a salesperson with no manual assigning |

Status: K14–K17 are built and K18 is written (PR `k14-k18-new-client`). R12 is built (PR `r12-white-label`): name from the business profile, logo letters, colour and logo image on Business settings → Brand. GKF names stay only in the default profile (seed data) and the GKF CRM host default. Order: K14 + R12 first (no GKF name in front of the new client), then K15, K16, R13, R2, then K17/K18 in parallel. Ask the client early: business type, number of staff, existing WhatsApp number or new one, who owns their Meta Business Manager.

### Now: order of work (from 6 Nov)

Krishna's R12 review: good. Logo upload is safe (type checked by its bytes, no SVG, 40 KB cap), readable text colour is computed, migration and tests included. Follow-ups were small (initials with punctuation, logo in backups) and are fixed. K8 moved `crm_branding` to one row per client.

**Krishna, in this order** (one PR each):

1. **R13 bulk staff add.** Managers, teams and first-login password change already exist (`crm/src/users.js`), so this is only the bulk part. On **Staff**, an **Add many** form: paste CSV or fill rows of `name, email, role, manager email, WhatsApp alert number (optional)`. Check every row first and save all or none, showing errors per row. Show each new person's one-time password once (and offer a CSV of them). Done when: an owner adds 20 staff in a few minutes; tests in `test/crm/`.
2. **R2 hot-lead queue.** Agree the contract below in a small PR first, then build the CRM side.
3. **R5 analytics** (moved up): funnel, speed to lead, logging rate, per salesperson, lost reasons, per business type names. The GKF case study, the deck and the analyser (K21) all need these numbers. Put the queries in one module (`crm/src/analytics.js`) returning plain objects, so K21 can reuse them.
4. **R11 unlogged-lead nudges.**
5. **R4 PWA.**
6. **R3 live board** (SSE). Events must stay inside one tenant. Plan for more than one web dyno: send events through Postgres `LISTEN/NOTIFY`, not only in-process.

**Contract: R2 hot-lead queue (Krishna builds the CRM side, Kaamil wires it into the bot as K19)**

- Krishna adds `crm/src/queue.js` with a `LeadQueue(db)`:
  - `autoAssign(waId)`: keeps the current assignee if they are active; otherwise picks the next active sales person who is taking leads (new `crm_users.accepting`, default on), round-robin by oldest last assignment, inside the lead's team when it has one. Writes `crm_lead_assignments` and sets the hand-off to `assigned`, exactly like `Crm.assign`, logged as the system. Returns the user or `null` (nobody available: the hand-off stays `pending`).
  - `sweep(now)`: finds assigned hand-offs not picked up (no staff reply, call or outcome since assignment). At 5 minutes escalate to the person's manager, at 15 minutes to the owner, each level once. Returns `[{ waId, userId, level }]` to alert. Stores the level it reached so it never repeats.
  - Owner setting to turn auto-assign on or off per business. Sales get a **Taking leads** on/off switch. Lead cards and the lead page show the timer, red after 5 minutes.
  - No tenant filters needed (row-level security), and no Meta or Telegram calls: it only returns who to alert.
- Kaamil (K19): `handoffRepository.open` calls `autoAssign` before staff alerts (so the alert goes to the assignee), wrapped so a queue error never blocks the hand-off. The minute housekeeping timer runs `sweep()` per tenant in `tenancy.run` and sends a `not_picked_up` staff alert (Telegram + WhatsApp) for each result.

**R2 details (proposed by Krishna, PR `r2-queue-contract`; Kaamil to agree before either side builds)**

*Storage*

| What | Where | Owner |
| --- | --- | --- |
| Sales person taking leads | `crm_users.accepting BOOLEAN NOT NULL DEFAULT true` (CRM migration 7) | Krishna |
| Escalation level reached | `crm_lead_assignments.escalation_level SMALLINT NOT NULL DEFAULT 0` (CRM migration 7): 0 none, 1 manager alerted, 2 owner alerted. Reset to 0 whenever the lead is (re)assigned, by `autoAssign` and by `Crm.assign` | Krishna |
| Auto-assign on or off per business | New table `crm_settings (tenant_id PRIMARY KEY, auto_assign BOOLEAN NOT NULL DEFAULT false, updated_by TEXT, updated_at TIMESTAMPTZ)`, created in CRM migration 7. **Needs Kaamil:** add `crm_settings` to `TENANT_TABLES` with the isolation policy in a new platform migration (or tell me to put it in `tenants.settings` instead). Also the home for later CRM-wide owner settings | Kaamil (RLS) |

Off by default, so nothing changes for GKF until the owner turns it on in **Business settings**.

*`LeadQueue(db)` in `crm/src/queue.js`* (runs inside the caller's tenant context; never calls Meta or Telegram)

- `autoAssign(waId)` → `{ id, name, email, role } | null`
  1. Auto-assign off → `null` (the hand-off stays `pending`, as today).
  2. The lead already has an assignee who is active and accepting → keep them, return them.
  3. Otherwise pick an active, accepting **sales** user. If the previous assignee had a manager, only that manager's team; if nobody there is available, anyone. Round-robin: the person whose latest `crm_lead_assignments.assigned_at` is oldest (never assigned first, then lowest id).
  4. Same writes as `Crm.assign`: upsert `crm_lead_assignments` (`assigned_by` NULL = system, `escalation_level` 0), `handoffs` → `assigned` + `assigned_to` email, `crm_activity_log` action `auto_assigned` with no user.
  5. One transaction with `pg_advisory_xact_lock` per tenant, so two hand-offs at the same moment take turns instead of both picking the same person.
  6. Nobody available → `null`.
- `sweep(now = new Date())` → `[{ waId, userId, level, assigneeId }]`, one item per person to alert.
  - Looks at leads with an open hand-off in `assigned` and an assignment that is **not picked up**: no staff reply (`outbound_messages` with `metadata.source = 'crm'`) and no outcome (`crm_lead_outcomes`, any outcome, so a logged "No answer" counts as an attempt) since `assigned_at`.
  - 5 minutes after `assigned_at` → level 1: the assignee's manager (no manager → the owners). 15 minutes → level 2: every active owner.
  - Each level once: `UPDATE ... SET escalation_level = n WHERE escalation_level < n RETURNING`, so it never repeats, even with two dynos sweeping.
  - Auto-assign off → `[]`.

*CRM screens (Krishna)*: owner toggle in Business settings; **Taking leads** switch for sales (header menu); a timer on lead cards and the lead page from `assigned_at` until picked up, red after 5 minutes.

*Bot side (Kaamil, K19)*: as above. `autoAssign` runs before `notifyService` / `staffAlerts`, so "their leads only" alerts reach the new assignee. The `not_picked_up` alert text can use `level` ("not picked up in 5 min" / "15 min").

**Kaamil, in this order**

1. **Set up the 3 portfolio clients** (Dubai real estate first): `npm run tenant -- add clients/<client>.json` per client, real estate preset, branding, staff (R13 helps), `staff_lead_alert` template per WhatsApp account. Then the DartIt name, logo and website, then `crm.inter-rootlabs.com`.
2. **K19:** wire R2 into the bot once Krishna's contract PR is merged.
3. **K20 Zoho two-way sync** (promised in the deck): leads and outcomes out to Zoho CRM, stage/won changes back in, matched by the lead key. Kaamil builds the sync worker and OAuth; Krishna adds the connect button on Business settings.
4. **K21 analyser:** sales and marketing analysis and suggestions, built on R5's queries. One AI call per report, not per lead.
5. **K7b + Instagram** once GKF's Instagram is connected (evening of 6 Nov).
6. **K9 Embedded Signup**, then **K8 follow-ups** (fair queues per client, a real second client live on the shared app).

**Needs credentials (do later, from a machine with `.env` or Heroku access).** Nothing here can run in a cloud session without them:

- Check the `staff_lead_alert` review: `node scripts/create-template.js --status` (needs `META_WABA_ID`, `META_ACCESS_TOKEN`). Then add staff WhatsApp numbers on **Staff**.
- Create `staff_lead_alert` on each new client's WhatsApp account.
- Add each portfolio client (`npm run tenant -- add`, needs `DATABASE_URL`, `TENANT_SECRETS_KEY` and the client's Meta token).
- Razorpay keys for GKF (`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`) and the webhook in the Razorpay dashboard.
- K7b: `META_DATASET_ID` and the `whatsapp_business_manage_events` permission, then check Events Manager.
- WhatsApp payment method on GKF's Meta account (Meta Business settings, before 1,000 conversations a month).
- Deploys after merging (Heroku).

### Done

| # | Task | Owner | Notes |
| --- | --- | --- | --- |
| K1 | **BSUID-safe lead identity.** Store Meta's `user_id`, match by BSUID then phone, send via `recipient` when the phone is hidden, follow ID changes | Kaamil | Live 30 Oct. See [META_PLATFORM.md §5](META_PLATFORM.md#5-usernames-and-bsuid-identity-change) |
| K3 | Tech Provider: business verification (approved), privacy/terms/data-deletion pages + delete-lead script | Kaamil | App Review steps in [META_APP_REVIEW.md](META_APP_REVIEW.md) |
| R1 | **Outcomes:** `crm_lead_outcomes` table + one-tap outcome UI + automatic next follow-up | Kaamil | See "Lead outcomes" below |
| K4 | Alert buttons: Telegram hand-off alerts get tap buttons (✅ Log outcome, 📋 Open lead, 💬 WhatsApp) | Kaamil | Contract below |
| K7 | Conversions API sender: Visit booked → QualifiedLead, Joined → Purchase (₹), matched by `ctwa_clid` or hashed phone + Page ID; each outcome sent once | Kaamil | On when `META_DATASET_ID` is set |
| K10 | Business profile in DB → generated prompt + fixed answers; business-type presets; owner's Business settings page | Kaamil | |

### 1. Prove the loop on GKF

| # | Task | Owner | Notes |
| --- | --- | --- | --- |
| K2 | Alert on outbound send failures (Telegram + Sentry) and on `account_update` webhooks | Kaamil | After the 30 Oct token incident |
| K7b | Turn on the Conversions API in production (dataset, `whatsapp_business_manage_events`), verify events in Events Manager | Kaamil | |
| R5 | Analytics: funnel, speed to lead, **logging rate**, per salesperson, lost reasons | Krishna | Baseline numbers for the GKF case study |

### 2. Proof of sale

| # | Task | Owner | Notes |
| --- | --- | --- | --- |
| K11 | ✅ **Payment links:** staff send a Razorpay/UPI link from the CRM; the `payment_link.paid` webhook logs Won + ₹ on the lead and triggers the Conversions API event | Kaamil | The lead key goes in the link's `reference_id`/`notes` |
| K13 | ✅ **AI-suggested outcomes:** the reply call also returns a suggested outcome ("paid", "visit booked Sat 7am"); staff confirm with one tap. The AI never logs a sale on its own | Kaamil | Still one AI call per reply |
| R3 | **Live board:** server-sent events so the kanban pipeline updates for everyone in real time; overdue cards red | Krishna | No websockets or extra services |
| R4 | **PWA:** manifest + service worker so sales installs the CRM on their phone | Krishna | |
| R11 | Unlogged-lead nudges: daily list per salesperson of hot leads with no outcome | Krishna | |

### 3. Revenue per ad

| # | Task | Owner |
| --- | --- | --- |
| K5 | Marketing API spend import per ad (daily job) | Kaamil |
| R6 | Per-ad report: leads, qualified, customers, ₹, cost per customer, ROAS, lead-quality grade per creative | Krishna |
| R7 | Nightly digest + weekly agency report page | Krishna |

### 4. Early signal

| # | Task | Owner |
| --- | --- | --- |
| K12 | **Lead score from the chat** (intent, budget, timing, visit booked) stored on the lead; above a tuned threshold, send an early `QualifiedLead` event within minutes; track how many scored leads actually buy | Kaamil |
| K6 | Lead Ads `leadgen` webhook → create lead → instant WhatsApp; send Conversion Leads stages daily | Kaamil |

### 5–6. First paying agency, then platform

| # | Task | Owner |
| --- | --- | --- |
| K8 | Tenants: `tenant_id` everywhere, row-level security, webhook routing by `phone_number_id`, per-tenant budgets and fair queues | Kaamil |
| K9 | Embedded Signup v4 backend: code → token exchange, number registration, coexistence states | Kaamil |
| R8 | Onboarding wizard UI (profile, business-type preset, preview chat, team, dataset check, test checklist) | Krishna |
| R9 | Agency dashboard + white-label (logo, domain) | Krishna |
| R10 | Billing UI (Razorpay subscriptions) | Krishna |

Both: line up a partner agency with a few paying clients (any industry) while this is built.

### 7. Compounding

Cross-client benchmarks, score trained on every client's outcomes, outcome-based pricing pilot, win-back templates, Instagram capture (comment/DM → WhatsApp). Owners decided when we get there.

## Contract: the outcome link (K4 ↔ R1)

Telegram alerts have a **✅ Log outcome** button that opens `https://<crm host>/leads/<lead key>#outcome`. The lead page's outcome section is `<section id="outcome">`, placed above everything else so on a phone the tap lands straight on the outcome buttons. Keep that id if you redesign the page.

## Lead outcomes (R1, built)

Table `crm_lead_outcomes` (CRM migration 2) stores one row per outcome: `wa_id`, `user_id`, `outcome`, `visit_at`, `plan`, `amount_inr`, `lost_reason`, `note`, `sent_to_meta_at` (filled later by K7), `created_at`. `crm_follow_ups` got a `source` column (`manual` or `outcome`).

What each tap does (`Crm.logOutcome` / `outcomePlan` in `crm/src/crm.js`):

| Outcome | Lead status | Bot hand-off | Next follow-up (for the lead's owner, else whoever logged it) |
| --- | --- | --- | --- |
| Called, spoke | new → contacted | resolved | none |
| No answer | unchanged | stays open | retry in 2h, then next day, 3 days, weekly |
| WhatsApp sent | new → contacted | resolved | check reply in 24h |
| Visit booked (date/time) | hot | resolved | "Did they come?" 2h after the visit |
| Visited | hot | resolved | follow up in 24h |
| No-show | unchanged | resolved | reschedule in 24h |
| Joined (plan + ₹) | converted | resolved | closes all open follow-ups |
| Lost (reason) | lost | resolved | closes all open follow-ups |

Each new outcome closes the previous automatic follow-up. A converted lead is never moved back to hot by a later outcome. Lost reasons: price, distance, timing, joined_elsewhere, no_response, not_interested, other. Plan names are suggested from the business config.

For R5/R6 (analytics): count outcomes per salesperson and per ad (`leads.metadata.referral.source_id`), revenue = `SUM(amount_inr)` of `joined` outcomes. "Joined" is GKF's label for a won sale; other business types may name it differently through their preset.

## AI-suggested outcomes (K13, built)

The AI's JSON answer has an optional `outcome` field (`visit_booked`, `visited`, `joined`, `lost`) for things the lead says already happened. `src/services/suggestedOutcome.js` cleans it, saves it on the lead as `leads.metadata.suggested_outcome` and sends one Telegram alert. The lead page shows it above the tabs (`crm/views/partials/suggested-outcome.ejs`): **Confirm** logs it in one tap when the details are known (visited, lost, joined with plan + ₹); otherwise **Add details** opens the outcome sheet. **Dismiss** removes it. Logging any outcome clears it. It never logs anything without a person. No extra AI call.

## Payment links (K11, built)

Off until `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET` are set (test-mode keys first). Staff open **Log outcome → Send payment link…** on a lead, enter plan and ₹. `Crm.createPaymentLink` creates the Razorpay link (`src/services/razorpay.js`), stores it in `crm_payment_links` (CRM migration 4) and sends it on WhatsApp if the reply window is open (otherwise it shows the link to send by hand). In the Razorpay dashboard, add a webhook to `https://<bot host>/razorpay/webhook` for `payment_link.paid` with the webhook secret. A signed `payment_link.paid` calls `Crm.markLinkPaid`: it logs **Joined** with the paid amount once (retries are ignored), in the name of the staff member who sent the link, and posts "💰 Paid" in the staff Telegram group. The Joined outcome then goes to Meta through K7 like any other.

## Business types (K16 + real estate)

`src/config/verticals.js` has one pack per business type: `gym`, `services` (general), `realestate`. A pack sets how the AI sells (qualify questions, examples), the words in the free fixed replies and buttons (`words`), and display names (`labels`): settings field names, outcome and stage names (real estate: Site visit booked, Site visited, Booked). The CRM reads them per request (`namesFor` in `crm/src/app.js`); internal keys (`joined`, `visit_booked`) never change, so reports, K7 and K11 work the same for every type. Packs hold no personal data: no names, addresses or phone numbers in examples. Sales up to ₹10 crore can be logged (payment links stay at ₹10 lakh).

## Staff WhatsApp alerts (built)

Next to the Telegram group, each staff member can get alerts on their own WhatsApp. On **Staff** (owner), open a person → **WhatsApp alerts**: their number with country code and a mode: **Off**, **Their leads only** (a manager: their team's leads) or **All leads** (CRM migration 6: `crm_users.alert_phone`, `alert_mode`). Alerts: a lead needs a person (new hand-off), a lead wrote while the AI is paused (at most one per lead per 30 minutes), a payment link was paid. `src/services/staffAlerts.js` picks the people and queues one message each in `outbound_messages` (same retries and per-number order as replies). Staff do not message the business number first, so each alert is the Meta template `staff_lead_alert` (utility: about ₹0.12 in India, AED 0.06 in the UAE, paid on the client's Meta account) with an **Open in CRM** button. Create it once per WhatsApp account: `node scripts/create-template.js staff_lead_alert` (needs `META_WABA_ID`, `BUSINESS_NAME`, `CRM_BASE_URL`), then wait for Meta to approve it. The AI does not answer a number saved for alerts.

## Multi-client tenants (K8, built)

One deployment serves many businesses. `tenants` holds each business (slug, WhatsApp number id, WABA, CRM host, settings, encrypted secrets); tenant 1 is GKF and still reads its settings from the env vars. Every client table has `tenant_id` and Postgres row-level security, so a query only ever sees one tenant's rows. **CRM code needs no tenant filters:** the CRM runs as the tenant of its hostname, and the database does the filtering. Rules for new code: a new table with client data gets `tenant_id` + the policy (add it in `src/db/platformMigrations.js`; `test/tenancy.test.js` checks), `ON CONFLICT` targets include `tenant_id`, and anything that runs outside a request or job (a timer, a script) wraps its work in `tenancy.run(id, fn)` or `tenancy.runAsSystem(fn)`. Scripts take `--tenant <slug>`. Add a client with `npm run tenant -- add clients/<client>.json` (see docs/ONBOARDING.md).

## How we work

- **Branches + PRs only.** Never push to `main`. One PR per task, named after the task (`r1-outcomes`, `k1-bsuid`). The other person reviews.
- **CI must be green.** `npm test` runs all tests on in-memory Postgres (PGlite). Tests never call Meta, OpenRouter or Telegram.
- **Deploys:** only Kaamil deploys to Heroku (`git push https://git.heroku.com/gkf-wa.git origin/main:refs/heads/main`) after merging.
- **Migrations are append-only.** Add a new numbered migration; never edit one that already ran in production.
- **Secrets:** never in code, commits, PRs, issues or chat. Use `.env` locally (copy `.env.example`). Ask Kaamil for test credentials; you don't need production keys to build CRM features.
- **Money:** AI calls cost real money. Don't run paid model checks (`scripts/eval.js`) or loops against OpenRouter without asking. Tests use fakes.
- **Local dev:** `npm ci`, `cp .env.example .env`, `npm run dev`, then `npm run dev:demo-data` (with the server stopped) for sample leads. CRM at http://crm.localhost:3000, bot at http://localhost:3000.
- **Docs:** when you change how something works, update the doc in the same PR.
- **Style:** small files, plain names, comments that explain why. Match the existing code.
- **UI:** follow [UI_GUIDE.md](UI_GUIDE.md): daisyUI components, phone-first, check in the browser at 375px and desktop before a PR.

## Using Claude Code on this repo

- `CLAUDE.md` at the root is loaded automatically: rules, commands and pointers.
- Before each task: `git checkout main && git pull`, then start Claude Code in the repo folder (`claude`), so it reads the latest docs.
- First prompt for a new task (change the task ID):

  > Read CLAUDE.md, then docs/TEAM.md (start at "Now: order of work"), docs/ARCHITECTURE.md and docs/UI_GUIDE.md. My next task is R13. Look at the code it touches (crm/src/users.js, crm/views/users.ejs, test/crm/), then give me a short plan: what you'll change, the tests you'll add, and anything that needs Kaamil (src/ or a shared table). Don't write code until I say go. Work on a new branch named r13-bulk-staff.

- After "go": ask it to run `npm test` and check the screen at 375px and desktop width, then open a PR into `main` with the task ID in the title. Kaamil reviews.
- For a task with a contract (R2): first ask Claude for a small PR that only writes the contract into docs/TEAM.md and adds the function signatures with tests. Build the rest after Kaamil agrees.
- Ask Claude to write tests with every change and to run `npm test` before opening the PR.

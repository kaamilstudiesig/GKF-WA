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
| K11 | **Payment links:** staff send a Razorpay/UPI link from the CRM; the `payment_link.paid` webhook logs Won + ₹ on the lead and triggers the Conversions API event | Kaamil | The lead key goes in the link's `reference_id`/`notes` |
| K13 | **AI-suggested outcomes:** the reply call also returns a suggested outcome ("paid", "visit booked Sat 7am"); staff confirm with one tap. The AI never logs a sale on its own | Kaamil | Still one AI call per reply |
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
- Good first prompt: *"Read CLAUDE.md and docs/TEAM.md, then plan task R1 on a new branch. Don't touch src/ except through an agreed contract."*
- Ask Claude to write tests with every change and to run `npm test` before opening the PR.

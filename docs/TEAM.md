# Team guide: Kaamil + Krishna

Krishna: start here. This page explains the idea, how we work, and who builds what. It's also written for your Claude: point it at this file and [`CLAUDE.md`](../CLAUDE.md) first.

## The idea in 60 seconds

Local businesses (gyms first) pay agencies to run Instagram/Facebook ads. The leads land on WhatsApp, and then most of them die: replies are slow, sales forgets to call, and nobody knows which ad produced paying customers.

We fix the whole path:

1. **AI front desk:** replies on WhatsApp in seconds, in English, Hinglish or Kannada, answers from the business's real facts, and qualifies (goal → experience → timing → visit).
2. **Sales floor:** hot leads go to a salesperson with a 5-minute timer, escalation, and one-tap outcome logging (called, visited, joined + ₹, lost + reason).
3. **Analytics:** the owner and agency see the funnel, speed to lead, and **revenue and cost per member for each ad**.
4. **Meta loop:** outcomes go back to Meta (Conversions API), so ads get shown to people who actually join.

We sell it through marketing agencies as a monthly product. Goldkraft Fitness (GKF) in J.P. Nagar, Bengaluru is the live pilot. The bot and CRM have been running in production since 29 Oct 2026.

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

## Work split by phase

Phases and "done when" are in [PRODUCT_PLAN.md §4](PRODUCT_PLAN.md#4-roadmap).

### Now: P0 + Phase A (first ~3 weeks)

| # | Task | Owner | Notes |
| --- | --- | --- | --- |
| K1 | **BSUID-safe lead identity.** Store Meta's `user_id`, match by BSUID then phone, send via `recipient` when the phone is hidden, follow ID changes | Kaamil | Done (live 30 Oct). See [META_PLATFORM.md §5](META_PLATFORM.md#5-usernames-and-bsuid-identity-change) |
| K2 | Alert on outbound send failures (Telegram + Sentry) and on `account_update` webhooks | Kaamil | In review (PR). After the 30 Oct token incident |
| K3 | Tech Provider: business verification (approved), App Review submission, privacy/terms/data-deletion pages + delete-lead script | Kaamil | Pages in PR; App Review steps in [META_APP_REVIEW.md](META_APP_REVIEW.md) |
| R1 | **Outcomes:** `crm_lead_outcomes` table + one-tap outcome UI on the lead page (incl. Joined: plan + ₹, Lost: reason list) + automatic next follow-up | Kaamil (Krishna busy) | In review. Built as described in "Lead outcomes" below |
| R2 | **Hot-lead queue:** shifts, round-robin auto-assign of new hand-offs, 5-min timer, escalation to manager | Krishna | Uses `handoffs` + `crm_lead_assignments` |
| R3 | **Live board:** server-sent events endpoint + board page (New hot / Contacting / Visit booked / Joined-Lost), overdue cards red | Krishna | No websockets or extra services |
| R4 | **PWA:** manifest + service worker so sales installs the CRM on their phone; mobile-first lead page | Krishna | |
| K4 | Alert buttons: Telegram hand-off alerts get tap buttons (✅ Log outcome → `/leads/<key>#outcome`, 📋 Open lead, 💬 WhatsApp) | Kaamil | In review. Needs R1 to add `id="outcome"` (contract below) |

### Next: Phase B + C

| # | Task | Owner |
| --- | --- | --- |
| R5 | Analytics pages: funnel, speed to lead, per salesperson, lost reasons | Krishna |
| R6 | Per-ad report: leads, joins, ₹, cost per member, ROAS (uses K5 data) | Krishna |
| K5 | Marketing API spend import per ad (daily job) | Kaamil |
| K6 | Lead Ads `leadgen` webhook → create lead → instant WhatsApp | Kaamil |
| K7 | Conversions API sender: outcome events (R1) → Meta, plus `ctwa_clid` business-messaging events | Kaamil |
| R7 | Nightly digest content + weekly agency report page | Krishna |

### Later: Phase D (platform)

| # | Task | Owner |
| --- | --- | --- |
| K8 | Tenants: `tenant_id` everywhere, row-level security, webhook routing by `phone_number_id`, per-tenant budgets and fair queues | Kaamil |
| K9 | Embedded Signup v4 backend: code → token exchange, number registration, coexistence states | Kaamil |
| K10 | Business profile in DB → generated prompt + fixed answers; vertical packs | Kaamil |
| R8 | Onboarding wizard UI (profile, preview chat, team, test checklist) | Krishna |
| R9 | Agency dashboard + white-label (logo, domain) | Krishna |
| R10 | Billing UI (Razorpay subscriptions) | Krishna |

Both: line up 3 pilot gyms through agency friends while Phase D is built.

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

Next for R5/R6 (analytics): count outcomes per salesperson and per ad (`leads.metadata.referral.source_id`), revenue = `SUM(amount_inr)` of `joined` outcomes.

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

## Using Claude Code on this repo

- `CLAUDE.md` at the root is loaded automatically: rules, commands and pointers.
- Good first prompt: *"Read CLAUDE.md and docs/TEAM.md, then plan task R1 on a new branch. Don't touch src/ except through an agreed contract."*
- Ask Claude to write tests with every change and to run `npm test` before opening the PR.

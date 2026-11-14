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

Shared contracts (agree in a PR before building on them): new tables both sides use, and the events the CRM emits that the bot side sends to Meta. From 7 Nov Krishna may also own a feature end to end, `src/` included, once its contract PR is agreed; Kaamil keeps Meta access and tokens, AI prompts, tenancy and deploys.

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
| R13 | ✅ **Team setup for a big client:** bulk-add staff (CSV or a multi-row form), managers with teams, first-login password change | Krishna | Owner adds 20 staff in a few minutes |
| R2 | Hot-lead queue (moved up from stage 2): a big team needs auto-assign and the 5-minute timer from day one | Krishna | Hand-offs reach a salesperson with no manual assigning |

Status: K14–K17 are built and K18 is written (PR `k14-k18-new-client`). R12 is built (PR `r12-white-label`): name from the business profile, logo letters, colour and logo image on Business settings → Brand. GKF names stay only in the default profile (seed data) and the GKF CRM host default. Order: K14 + R12 first (no GKF name in front of the new client), then K15, K16, R13, R2, then K17/K18 in parallel. Ask the client early: business type, number of staff, existing WhatsApp number or new one, who owns their Meta Business Manager.

### Now: order of work (from 7 Nov)

**Decided with Kaamil on 7 Nov**

- Order: **3 portfolio demos (this week) → Dubai real estate client → Turiya (agency) → GKF case study.**
- Real estate is the focus, but nothing is built for one industry: differences stay in presets and the business profile.
- The 3 portfolio clients are live demos: own branded CRM, bot on a test WhatsApp number, realistic sample data, no real ad traffic.
- Dubai: amounts in AED; leads also come from portals and the website (sources still to confirm); their CRM is unknown, so ask before building another connector; projects and units should live in a Meta catalog.
- Turiya will judge value for money. With no real numbers yet, we show two strengths: (1) a sales pipeline tool, not just a chatbot (qualify, assign, alert, time, log the outcome); (2) sales data flowing back to marketing (revenue per ad, signals to Meta, reports).
- Speed to lead counts **working hours** everywhere (the R2 rule), so night leads don't make staff look slow.
- Krishna may own a feature end to end, `src/` included, once a small contract PR is agreed. Kaamil keeps Meta access and tokens, AI prompts, tenancy and deploys.

**Built and merged (6–8 Nov):** R2 lead queue (K19 built: owners can turn it on), R3 live board, R4 phone app, R5 analytics, R11 reminders (CRM list and the morning send, R11b), R13 bulk staff, Zoho status page, the follow-up fixes from every automatic review, and K20 Zoho sync. All of it is live since 11 Nov (Heroku v32). The lead queue stays off until an owner turns it on in Business settings.

**Krishna, in this order** (one PR each; a contract PR first where marked):

1. ✅ **Finish #42 (R14 demo kit) and #43 (lost-reason wording)** from their review comments: both fixed to "Ready to merge" and merged 8 Nov.
2. ✅ **R14 real estate demo kit** (PR `r14-realestate-demo`, how to run it: [OPERATIONS.md](OPERATIONS.md#demo-clients-r14)) (portfolio, this week): `npm run demo -- --tenant <slug> --preset realestate` fills one client with realistic sample data: projects, about 60 leads over 30 days with chats in English and Hinglish/Arabic, hand-offs, site visits, bookings with amounts, lost reasons, staff with a manager, and some leads waiting, so every screen (pipeline, reports, R11, R2 timers) looks alive. No real names or phone numbers (use +91 98000 / +971 50 000 test ranges). Safe to run twice. Builds on `scripts/demo-data.js`.
3. **R15 currency per business** (contract agreed 11 Nov, below; the Dubai client needs it): build it as one PR, `r15-currency`. Kaamil does the bot side (Conversions API currency, alert texts) after it merges.
4. **R19 data export** (the client agreement promises it; small): see "Before the first paying client signs" below.
5. **R16 lead intake** (contract agreed 11 Nov, below; Dubai portals and website forms). Show K30's "Opted out" badge on the lead page once Kaamil's opt-out lands, because R16 sends welcome templates.
6. **R17 projects and units** (contract agreed 11 Nov, below; after R15). Projects work without the catalog; Kaamil's K24 adds the Meta catalog later.
7. **R18 value page per client** (Turiya): one shareable screen for the owner or agency: leads, speed to lead, logging rate, sales, revenue, cost per customer, plus "what the system did" (replies sent, leads qualified, hand-offs timed, sales sent to Meta). Demo data until real numbers exist.
8. **R8 onboarding wizard** (Turiya: easy onboarding): profile, business-type preset, brand, team (R13), test chat, checklist. Pairs with Kaamil's K9.

Small extras when Kaamil's side is ready: the two K26 screens (lead count on Business settings and the dashboard) and K30's "Opted out" badge. Also confirm K25 (phone sign-in, PR #55), which changed files in `crm/`; see the note under Kaamil's list.

✅ **R6 revenue per ad** (built, PR #53): `Analytics.byAd` and **Reports → By ad** + CSV, with a lead-quality grade per ad. **For K5 (Kaamil):** fill `Analytics.adSpend(range)` (a `Map` of ad id to `{ spend, campaignId, campaignName }`) from your spend table; cost per sale, ROAS, campaign and the **By campaign** roll-up then show with no other change. Click-to-WhatsApp referrals carry the ad id, not the campaign, so campaigns come from K5.

**Before the first paying client signs (from the client agreement, 14 Nov)**

The client agreement ([CLIENT_AGREEMENT.md](CLIENT_AGREEMENT.md), templates in `docs/legal/`) promises these outright. They're small, so they come before the next feature work, except the Dubai and portfolio items already under way. Each is one PR.

| # | Task | Owner | Done when |
| --- | --- | --- | --- |
| K26 | **Lead usage meter.** Count each person once per calendar month across channels (first inbound or intake that month, per tenant). Show "Leads this month: 412 of 500" on Business settings and the dashboard; WhatsApp/Telegram alert to owners at 80% and 100%, once each per month; `npm run usage -- --month 2026-11` prints every client's count for invoicing. No billing | Kaamil (bot side and script), Krishna (the two screens, small contract in the PR) | The count matches a hand count on GKF for one month, and the alert fires once |
| K27 | **Uptime and reply time.** An external uptime monitor on `/health/ready` every minute (free tier, alerts to the ops group). Store the reply time per message (last inbound in a burst → reply sent) and show the monthly p95 and availability on an owner-only ops line in Reports | Kaamil | A month of numbers we can quote under Annexure B |
| K28 | **Encrypted backups.** The off-site daily backup is encrypted (AES-256-GCM, key in a config var) and stored in private object storage, not posted to Telegram. `npm run restore` decrypts. Keep the Heroku daily backup. Do one restore drill and note the date in OPERATIONS.md | Kaamil | No plain lead data leaves Heroku; a restore from the encrypted copy works |
| K29 | **No storage or training by AI providers.** Send OpenRouter's provider preferences on every call (`provider: { data_collection: 'deny' }`, zero data retention where offered), confirm both models still route, and list every provider (Heroku, OpenRouter, Telegram, Sentry, backup storage) on the public privacy page. Test with the fake transport only; one paid check call needs Kaamil's OK | Kaamil | Annexure C can say "Yes" in the no-training column |
| K30 | **Opt-out.** STOP, UNSUBSCRIBE or "don't message me" (any language the bot supports) marks the lead opted out (`leads.opted_out_at`, platform migration). Template sends to that lead are refused (not the 24-hour replies the lead starts); START or a new message from them turns it off. The CRM lead page shows "Opted out". Needed before R16 sends welcome templates | Kaamil (bot), Krishna (the badge) | A STOP lead gets no template, and the CRM shows it |
| R19 | **Full data export.** Owners download a ZIP from Business settings: leads, messages, outcomes, notes, assignments and hand-offs as CSV (one file each), for the whole client. Owner only, logged in the activity log. Also what we hand over at exit (clause 12.5) | Krishna | An owner gets every conversation without asking us |
| K33 | **Health-related businesses.** A business profile setting `healthRelated`. When on: the bot answers only admin questions (services, prices, timings, location, appointments), sends symptoms and medical questions to staff, never gives advice, and Conversions API events carry no health detail. Generic, works for any business type | Kaamil | Only needed before signing a clinic; tests with a sample clinic profile |

Ops, no code (Kaamil): turn on 2FA on Heroku, GitHub, Meta Business, OpenRouter, Zoho and Google admin accounts; set up a support email and a WhatsApp support number for Annexure B; move hosting off student credits (and choose the region) before the first invoice; fill Annexure C with what's true on the day.

Later, listed with a Feature Date until built: **K31 automatic deletion** (delete or anonymise leads with no activity for the client's retention period, default 24 months; before 13 May 2027 for DPDP) and **K32 Instagram DM capture** (an Instagram DM or comment reply gets one automatic answer that moves the lead to WhatsApp, after the Dubai client; needs `instagram_manage_messages` in App Review).

**Contract: R2 hot-lead queue (Krishna builds the CRM side, Kaamil wires it into the bot as K19)**

- Krishna adds `crm/src/queue.js` with a `LeadQueue(db)`:
  - `autoAssign(waId)`: keeps the current assignee if they are active; otherwise picks the next active sales person who is taking leads (new `crm_users.accepting`, default on), round-robin by oldest last assignment, inside the lead's team when it has one. Writes `crm_lead_assignments` and sets the hand-off to `assigned`, exactly like `Crm.assign`, logged as the system. Returns the user or `null` (nobody available: the hand-off stays `pending`).
  - `sweep(now)`: finds assigned hand-offs not picked up (no staff reply, call or outcome since assignment). At 5 minutes escalate to the person's manager, at 15 minutes to the owner, each level once. Returns `[{ waId, userId, level }]` to alert. Stores the level it reached so it never repeats.
  - Owner setting to turn auto-assign on or off per business. Sales get a **Taking leads** on/off switch. Lead cards and the lead page show the timer, red after 5 minutes.
  - No tenant filters needed (row-level security), and no Meta or Telegram calls: it only returns who to alert.
- Kaamil (K19): `handoffRepository.open` calls `autoAssign` before staff alerts (so the alert goes to the assignee), wrapped so a queue error never blocks the hand-off. The minute housekeeping timer runs `sweep()` per tenant in `tenancy.run` and sends a `not_picked_up` staff alert (Telegram + WhatsApp) for each result.

**R2 details (proposed by Krishna in PR #32, agreed by Kaamil with 4 changes: storage in a platform migration, a cutoff for old leads, working hours, and hand-back when someone stops taking leads)**

*Storage: one new platform migration `lead_queue` in `src/db/platformMigrations.js`* (not CRM migration 7, so every new table gets client isolation the same way `zoho_sync` did)

| What | Where | Owner |
| --- | --- | --- |
| Sales person taking leads | `crm_users.accepting BOOLEAN NOT NULL DEFAULT true` | Krishna |
| Escalation level reached | `crm_lead_assignments.escalation_level SMALLINT NOT NULL DEFAULT 0`: 0 none, 1 manager alerted, 2 owners alerted. Reset to 0 whenever the lead is (re)assigned, by `autoAssign` and by `Crm.assign` | Krishna |
| Queue settings per business | New table `crm_settings`: `tenant_id` (primary key, default from the tenant setting like the other tables), `auto_assign BOOLEAN NOT NULL DEFAULT false`, `auto_assign_since TIMESTAMPTZ` (set each time the owner turns it on), `work_start TIME NOT NULL DEFAULT '09:00'`, `work_end TIME NOT NULL DEFAULT '21:00'`, `timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata'` (Dubai clients use `Asia/Dubai`), `updated_by TEXT`, `updated_at TIMESTAMPTZ`. Add `...tenancyPolicy('crm_settings')` in the same migration. Also the home for later CRM-wide owner settings | Krishna (copy the `zoho_sync` pattern) |

Off by default, so nothing changes for GKF until the owner turns it on in **Business settings**. No row = defaults.

*`LeadQueue(db)` in `crm/src/queue.js`* (runs inside the caller's tenant context; never calls Meta or Telegram)

- `autoAssign(waId, { exclude = [] } = {})` → `{ id, name, email, role } | null`
  1. Auto-assign off → `null` (the hand-off stays `pending`, as today).
  2. The lead already has an assignee who is active, accepting and not in `exclude` → keep them, return them.
  3. Otherwise pick an active, accepting **sales** user not in `exclude`. If the previous assignee had a manager, only that manager's team first; if nobody there is available, anyone. Round-robin: the person whose latest `crm_lead_assignments.assigned_at` is oldest (never assigned first, then lowest id).
  4. Same writes as `Crm.assign`: upsert `crm_lead_assignments` (`assigned_by` NULL = system, `escalation_level` 0), `handoffs` → `assigned` + `assigned_to` email, `crm_activity_log` action `auto_assigned` with no user.
  5. One transaction with `pg_advisory_xact_lock(<queue key>, tenant_id)`, so two hand-offs at the same moment take turns instead of both picking the same person.
  6. Nobody available → `null`.
- `release(userId)` → number of leads moved. Called when a sales person turns **Taking leads** off, and when an owner deactivates a user. Their open hand-offs that are **not picked up yet** go to `autoAssign(waId, { exclude: [userId] })`. Leads they already picked up stay with them (they are mid-conversation). If nobody else is available the lead stays, and the sweep escalates it as normal.
- `sweep(now = new Date())` → `[{ waId, userId, level, assigneeId, assignedAt }]`, one item per person to alert (`assignedAt`, added in K19, tells one assignment from the next so a lead handed off again escalates again).
  - Looks at leads with an open hand-off in `assigned` and an assignment that is **not picked up**: no staff reply (`outbound_messages` with `metadata.source = 'crm'`) and no outcome (`crm_lead_outcomes`, any outcome, so a logged "No answer" counts as an attempt) since `assigned_at`.
  - **Old leads never escalate:** only assignments with `assigned_at >= auto_assign_since`. Turning auto-assign on does not alert owners about leads assigned before that.
  - **Working minutes only:** the clock counts minutes between `work_start` and `work_end` in the business's `timezone`. A lead assigned at 2 AM starts counting at `work_start`, so nobody is alerted at night. Put this in a pure function `workingMinutes(from, to, settings)` with its own tests (overnight, weekend not special, Dubai vs India time).
  - 5 working minutes → level 1: the assignee's manager (no manager → the owners). 15 working minutes → level 2: every active owner.
  - Each level once: `UPDATE ... SET escalation_level = n WHERE escalation_level < n RETURNING`, so it never repeats, even with two dynos sweeping.
  - Auto-assign off → `[]`.

*CRM screens (Krishna)*: owner toggle plus working hours and timezone in Business settings; **Taking leads** switch for sales (header menu), which calls `release`; a timer on lead cards and the lead page from `assigned_at` until picked up, counting working minutes, red after 5.

*Tests (Krishna)*: round-robin order; two `autoAssign` calls at once pick different people; old leads not escalated after turning on; no alerts outside working hours; `release` moves only not-picked-up leads; one client's queue never sees another client's staff.

*After review (8 Nov):* leads also go back to the queue when an owner changes a sales person to manager or owner (not only on deactivation); only sales people can use **Taking leads** (403 for others); and a lead a manager assigns **by hand** after auto-assign is on escalates like any other, because the customer is waiting either way.

*Built as agreed, with one detail:* when `autoAssign` keeps the current assignee for a new hand-off, it restarts their clock (`assigned_at` now, level 0), so the 5/15 minutes count from this hand-off, not from an old assignment.

*Bot side (Kaamil, K19, ✅ built 9 Nov in `src/services/leadQueue.js`)*: set `require('../../crm/src/queue').LeadQueue.botWired = true` where the bot wires it in (until then Business settings shows auto-assign as "needs the bot update" and keeps it off). `handoffRepository.open` calls `autoAssign` before `notifyService` / `staffAlerts`, so "their leads only" alerts reach the new assignee, wrapped so a queue error never blocks the hand-off. The minute housekeeping timer runs `sweep()` per tenant in `tenancy.run` and sends a `not_picked_up` alert for each result; the text uses `level` ("not picked up in 5 min" / "15 min"). As built: the hand-off's Telegram alert says "Assigned to <name> (lead queue)"; escalations go to each person's WhatsApp (`staffAlerts.alertUsers`, once per lead, level and assignment, so a lead handed off again later escalates again; only to people with a number and alerts not off; the Telegram post says when nobody got one). The level is recorded before sending, so a failed send is logged and not retried and one "Not picked up in 5/15 min" post to the staff group; the sweep runs every minute for every active client. Owners turn it on in **Business settings → Lead queue**.

**Contracts for R15, R16, R17 (drafted 9 Nov by Kaamil; Krishna confirms or proposes changes in a small docs PR, then builds)**

*R15: currency per business*

| What | Where | Owner |
| --- | --- | --- |
| The currency | `profile.currency` in the business profile: `INR` (default), `AED`, `SAR`, `USD`. Added in `normalize()` (`src/services/businessProfile.js`), read through `gymConfig.profile.currency`. A select on Business settings | Krishna (both sides) |
| How amounts are stored | Unchanged: `amount_inr` columns keep their name and hold **whole units of the business's currency** (AED 950000 for a Dubai sale). Documented in `crm/README.md` and `crm/src/constants.js`; no migration | Krishna |
| How amounts are shown | One helper `util.money(amount, currency)` in `crm/src/util.js` (`₹7,080`, `AED 950,000`, Indian grouping only for INR). Replace every hard-coded `₹` in `crm/views/` and in CRM-side text with it. Report headers say "Revenue (AED)" | Krishna |
| Payment links | Razorpay is INR-only: hide **Send payment link** when the currency is not INR | Krishna |
| Changing it later | Allowed, with a warning on the settings page when sales exist ("existing amounts are not converted") | Krishna |
| Bot side | Conversions API `custom_data.currency` from the profile; `suggestedOutcome` strips any currency symbol (₹, AED, Rs) before parsing; Telegram/WhatsApp alert texts use the same money format; Zoho deals already carry the number as is | Kaamil |

Done when: a Dubai client shows AED everywhere (lead page, outcome sheet, pipeline, reports, alerts) and GKF looks exactly as today. Tests: the money helper for each currency, the settings select, the hidden payment link, and a Purchase event in AED.

*Confirmed by Krishna (11 Nov, PR `r15-currency-contract`), with these changes. Agreed by Kaamil (merged 11 Nov): build it as written below.*

1. **One shared module, `src/config/currency.js`, not `crm/src/util.js`.** The bot's alert texts need the same format, and #43's review asked us not to make `src/` depend on `crm/`. It holds:
   - `CURRENCIES`: `INR` (`₹7,080`, Indian grouping), `AED` (`AED 950,000`), `SAR` (`SAR 950,000`), `USD` (`$950,000`), all in whole units.
   - `money(amount, currency)`: the display format.
   - `parseAmount(text)`: reads typed amounts ("₹7,080", "Rs 7080", "AED 950,000", "950000"). It strips the symbol, code, commas and spaces, and rejects decimals and anything else with a message.

   The CRM uses `util.money`, which re-exports it. Kaamil's alert texts and `suggestedOutcome` use the same two functions.
2. **Unknown codes become INR.** `normalize()` accepts only the four codes, so an old profile or a bad value falls back to INR. GKF needs no change.
3. **Payment links are blocked on the server too.** When the currency isn't INR, the payment-link route returns 400 as well as hiding the button. The ₹10 lakh link limit stays.
4. **The largest sale stays 100,000,000 whole units in any currency.** It fits the `INTEGER` columns (AED 100M or ₹10 crore), so there is no migration.
5. **Typed amounts:** the outcome sheet (lead page and pipeline) labels the field "Amount paid (AED)", and the field accepts the currency's code or symbol.
6. **AI cost on Reports stays our cost, in USD,** with the ₹ line shown only when the currency is INR. It's what the bot costs us, not the client's revenue.
7. **Old text isn't rewritten.** Messages and activity entries that were already sent with ₹ stay as sent. Only numbers shown from `amount_inr` change format.
8. **Examples follow the currency.** The plan-price example on Business settings (the `planPrice` label, e.g. "₹85L onwards") uses the business's currency, e.g. "AED 1.1M onwards".
9. **R14 demo kit:** `--region ae` sets `currency: 'AED'` in the profile it writes, and `--region in` sets INR. The packs already carry the currency.
10. **Bot side, one more item for Kaamil:** the AI prompt's `amount_inr` line says the number is in the business's currency (still one AI call). Zoho deals carry the number as is, so onboarding should check that the client's Zoho home currency matches `profile.currency`.

Build order once agreed: shared module and profile field, then the CRM screens (lead page, outcome sheet, pipeline, reports, settings select with the warning, payment link), then the demo kit. One PR (`r15-currency`). Tests: `money` and `parseAmount` for each currency, the settings select and warning, the payment link hidden and refused, a Dubai lead page, pipeline and reports showing AED, and GKF pages unchanged.

*R16: lead intake from portals and website forms*

- **Endpoint (bot host):** `POST /intake/:slug` (`src/routes/intake.js`, mounted in `src/app.js` next to the Razorpay webhook). The client is found by slug (`registry.bySlug`); everything after runs in `tenancy.run`. Two ways in:
  - **Server-to-server** (portals, Zapier, a client's CRM): JSON body signed with `X-Intake-Signature: sha256=<HMAC of the raw body>` using a per-client secret `intakeSecret` (new key in `SECRET_KEYS`, `src/tenancy/registry.js`).
  - **Website form** (the copy-paste snippet): no secret in the browser. A public `intakeFormKey` (setting) plus the client's allowed website origins (`intakeOrigins` setting), a honeypot field, and a rate limit per IP and per phone (the existing rate limiter). The snippet is plain HTML + a few lines of JS that the owner copies from Business settings → **Lead sources**.
- **Body:** `{ name, phone, email, message, source, sourceRef, utm: { source, medium, campaign, content }, consent }`. `source` is one of `website`, `property_finder`, `bayut`, `dubizzle`, `other`. `phone` in any format; normalised to digits with the country code (reuse `normalizePhone`). Responses: `202 { ok: true }`, `400` with a reason, `401` bad signature or key, `429`.
- **What it does:**
  1. Match an existing lead by phone (`leads.phone`, then `wa_id`); otherwise create one with `wa_id` = the phone, `source` = `intake_<source>`, `metadata.intake` = the body without the message (email lives here; no new column).
  2. Store the form message as an inbound-style note in `crm_lead_notes` (not in `messages`, so the AI never treats it as WhatsApp text).
  3. Open a hand-off with a new reason `form_lead` (platform migration: extend the `handoffs.reason` CHECK), so it lands in the lead queue (R2/K19) and alerts like any hand-off.
  4. If `consent` is true and there is a phone, queue the first WhatsApp message as the approved template `lead_welcome` (`{{1}}` name, `{{2}}` business name; Kaamil adds it to `scripts/create-template.js`). At most one per phone per 24 hours. No phone: no WhatsApp, the hand-off says "email only".
  5. A repeat submission with the same `sourceRef` within 24 hours does nothing (idempotent).
- **CRM (Krishna):** Business settings → **Lead sources**: the endpoint URL, the form snippet, the allowed origins, "show / regenerate secret" (owner only, shown once), and a list of the last 20 intake leads with their source. A source badge on lead cards.
- **Portal adapters** (Property Finder, Bayut, Dubizzle) come later, once the Dubai client says which they use: each is a small mapper from that portal's payload or email to the body above.
- **Tests (Krishna):** good signature, bad signature, form key + wrong origin, honeypot, rate limit, new lead vs existing lead, no phone, no consent, duplicate `sourceRef`, template queued once, and one client's intake never touching another client. Fakes only, never Meta.

*Confirmed by Krishna (11 Nov, PR `r16-intake-contract`), with these changes. Agreed by Kaamil (merged 11 Nov): build it as written below.*

1. **A phone is required in v1.** A form with no phone gets `400 phone required`, and the website form marks phone as required. The reason: a lead's key must be a phone or a BSUID (`identity.isLeadKey`). A made-up key for an email-only lead (such as `EM.…`) would match the BSUID pattern, and the bot could try to send to it. Portals always send a phone. Email-only leads can come later, with a key type agreed with Kaamil.
2. **A form lead must not look like it has an open 24-hour window.** Today `leads.last_inbound_message_at` is `NOT NULL DEFAULT now()`, and both the bot and the CRM use it for the window. A new form lead would show an open reply box, and staff replies would fail at Meta.
   - **Proposed fix:** the R16 platform migration makes the column nullable, and form leads keep it `NULL` until they message on WhatsApp.
   - **Why it's safe:** `windowOpen(null)` is already false in both places. The bot's upsert uses `GREATEST`, which ignores `NULL`, so the first real message fills it in.
   - **The cost:** the four CRM sort orders on it (`recent`, `oldest`, `attention`, the pipeline) get `NULLS LAST`.
   - **Tests:** a form lead shows the window closed, and it opens once the lead writes.
   - **Alternative**, if Kaamil would rather not touch `leads`: a `metadata.intake.noWindow` flag checked by both `windowOpen` functions. It's messier, because two places must remember it.
3. **A small `intake_submissions` table** goes in the same migration as the `form_lead` hand-off reason, with `tenancyPolicy`.
   - **Columns:** `id`, `tenant_id`, `received_at`, `source`, `source_ref`, `wa_id`, `ip_hash` (a salted hash, never the raw IP), `status` (`accepted` / `duplicate` / `rejected` / `limited`) and `error`.
   - **What it gives us:**
     - The duplicate `sourceRef` check (same source and ref within 24 hours).
     - Rate limits that work with several dynos (counted here, not in memory).
     - The "last 20" list on **Lead sources**.
   - `leads.metadata.intake` still keeps the latest submission, without the message.
4. **Phone format moves to `src/`.** `normalizePhone` lives in `crm/src/users.js`. It moves to `src/services/identity.js` as `normalizePhone(raw, country)`, and the CRM imports it from there. That keeps `src/` from depending on `crm/`, as #43's review asked. Local numbers ("050 123 4567") need the client's country code, so there's a new setting, `phoneCountry`: `91` by default, `971` for Dubai.
5. **The website form avoids CORS preflight.** It posts as `application/x-www-form-urlencoded`, which doesn't need a CORS preflight. The server:
   - checks `Origin` against `intakeOrigins` and the form key, and sends `Access-Control-Allow-Origin` only to an allowed origin;
   - treats the honeypot as a silent `202`, so bots don't learn it was caught.

   The snippet has a consent checkbox, unticked by default, that names the business and WhatsApp. Server-to-server calls send signed JSON (the HMAC is over `req.rawBody`, which `express.json` already keeps).
6. **The secret can only be regenerated, and is shown once** (owner only). A stored secret can't be shown again, so there's no "show". It's saved encrypted with `registry.update`. The public form key and the endpoint URL are always shown.
7. **Rate limits:**
   - Web form: 10 submissions per IP per hour, and 3 per phone per day, per client.
   - Signed calls: no rate limit, only the duplicate `sourceRef` check.
   - Over the limit: `429`, recorded as `limited`.
8. **Existing leads:**
   - **A hand-off is already open:** no second hand-off. The note and source are added, and staff get one alert.
   - **The lead wrote on WhatsApp in the last 24 hours:** no template, because the conversation is live.
   - **Status:** a lost or won lead isn't reopened silently. The hand-off summary says "came back through <source>".
9. **The welcome template is optional per client.** It's a new setting, `leadWelcomeTemplate`. With no template set or approved, nothing is sent, and the hand-off says "WhatsApp welcome not sent: template not set up". Kaamil creates `lead_welcome` per client.
10. **Notes from forms** use `crm_lead_notes` with `user_id NULL`, shown as "From the <source> form". The lead page shows the source badge, as in the draft.
11. **Who builds what:**
   - **Krishna:** the route, the migration, the identity move and the CRM screens. `docs/TEAM.md` (7 Nov) allows `src/` work once a contract is agreed.
   - **Kaamil:** reviews the migration and the new registry keys (`intakeSecret`, `intakeFormKey`, `intakeOrigins`, `phoneCountry`, `leadWelcomeTemplate`), and adds `lead_welcome` to `scripts/create-template.js`.

Extra tests on top of the draft: the window stays closed for a form lead, a local Dubai number becomes `971…`, honeypot submissions return `202` and are never saved as leads, the limits hold across two app instances, and regenerating the secret makes the old one fail.

*R17: projects and units, in a Meta catalog*

| What | Where | Owner |
| --- | --- | --- |
| Data (source of truth) | Platform migration `projects`: `crm_projects` (`id`, `tenant_id`, `name`, `area`, `kind` e.g. apartments/villas, `handover`, `brochure_url`, `photo_url`, `status` active/sold_out, `sort`) and `crm_units` (`id`, `tenant_id`, `project_id`, `name` e.g. "2 BHK", `size_sqft`, `price_from`, `retailer_id` unique per tenant, `meta_product_id`, `sync_status`, `sync_error`, `dirty`). Both with `tenant_id` and the tenancy policy | Krishna |
| Projects page | **Projects** (owner and manager): add, edit, mark sold out, reorder; units under each project. Prices use R15's currency. Photo and brochure as https URLs in v1 (no uploads) | Krishna |
| On the lead page | **Send projects**: pick units, and the bot sends them as one WhatsApp product list. Only inside the 24-hour window; outside it, the button says why | Krishna (UI), Kaamil (send) |
| Catalog sync (K24) | A worker like the Zoho one: a trigger marks changed units `dirty`; it pushes them to the client's Meta catalog (`catalogId` setting, `catalog_management` on the client's token) with the Catalog batch API, and stores `meta_product_id` / `sync_status` / `sync_error`, which the Projects page shows | Kaamil |
| The bot | Can answer "what projects do you have" from these tables and send a product list. The business profile stays the source of facts for everything else; projects never replace it in v1 | Kaamil |

Done when: an owner adds a project with three unit types, they appear in Meta Commerce Manager, and staff send them to a lead as a product list from the lead page. Tests with a fake catalog API.

*Confirmed by Krishna (11 Nov, PR `r17-projects-contract`), with these changes. Agreed by Kaamil (merged 11 Nov): build it as written below.*

1. **Projects work without the catalog.** The Projects page and **Send projects** don't wait for K24.
   - **When the catalog is on and the chosen units are synced**, Send projects sends a WhatsApp product list.
   - **Otherwise** it sends a plain message: each unit's name, "from" price, area and handover, plus the brochure link.

   **Why:** we haven't confirmed that Meta's commerce rules accept property listings in a catalog. Third-party guides don't list real estate as banned, but none of them is Meta's own wording. Setting up a catalog per client also takes time, and the demos are this week.

   **K24 step 0 (Kaamil):** read the WhatsApp Commerce Policy and Meta's Commerce Policies, and get one test catalog with a unit approved, before building the sync.
2. **Catalog fields come from our data.**
   - **title:** "<project> · <unit>"
   - **description:** area, kind, size and handover
   - **price:** `price_from` in the business's currency, so R17 is built after R15
   - **image:** the unit's photo, else the project's
   - **link:** the brochure, else the business website
   - **availability:** in stock, or out of stock when sold out
   - **condition:** new
   - **brand:** the business name

   A unit with no https photo or no link isn't sent to the catalog, and the Projects page says **Needs a photo** or **Needs a link**.
3. **Units get their own optional `photo_url`**, which falls back to the project's photo.
4. **Retailer IDs:** `retailer_id` is generated (`u<id>`). It can't be edited and is never reused, so a renamed unit stays the same product in Meta.
5. **Meta's limits:** at most 30 units per send, with one section per project and at most 10 projects. The picker enforces this.
6. **Removing a unit hides it rather than deleting it.** It gets a new status, `archived`, and the sync removes it from the catalog. A unit that leads have already been sent stays readable in their history.
7. **No cart (K24, Kaamil).** Nobody buys property through a cart, so K24 turns the cart off on the number.
   - **The customer asks about a product** (`referred_product` on an inbound message): it becomes a note on the lead, "Asked about <unit>", and the bot answers as usual.
   - **A cart order arrives anyway:** the bot gets a polite reply, and staff get a hand-off.
8. **Who can do what:** owners and managers edit projects. Anyone who can see the lead can use Send projects.
9. **Sends count as staff replies.** They're stored in `outbound_messages` with `metadata.source = 'crm'` and `metadata.units` (the unit IDs). That counts as a staff reply for R2 (picked up) and R5 (speed to lead), and it shows in the lead's history.
10. **The bot's facts:** the business profile stays the bot's source of facts in v1, as the draft says. The Projects page notes that the bot still uses Business settings for its answers. When K24 lets the bot read projects, the profile's projects and unit types should be filled from this page, so the owner doesn't keep two lists (Kaamil decides, since he owns the prompts).
11. **Migration numbers:** R16 and R17 each take the next free platform migration id when they are built. Neither id is fixed in advance.

Build order once agreed (after R15): tables and Projects page, then Send projects (plain message), then the catalog columns that K24 uses. Tests:
- adding, editing, sold out, archive and reorder
- the per-tenant `retailer_id`
- the 30-unit and 10-project limits
- Send projects outside the window (disabled, with the reason)
- the plain-message fallback, and the product list with a fake catalog
- "Needs a photo"
- tenant isolation

**Kaamil, in this order**

0. **Before the first paying client signs:** K26–K30 and the ops list above (K33 before a clinic). Small PRs; they unblock the client agreement.
1. **Portfolio (this week):** create the 3 demo clients (`npm run tenant -- add`, with `"demo": true` in `settings` so `npm run demo` may fill them), each with a test WhatsApp number, real estate preset, branding and Krishna's R14 data. Then the DartIt name, logo and website, then `crm.inter-rootlabs.com`.
2. ✅ **K19:** R2 wired into the bot (9 Nov). ✅ **R11b:** the morning "waiting for an outcome" reminder on Telegram and staff WhatsApp (9 Nov).
3. **Dubai discovery:** ask the client for their CRM, lead sources and portals, languages, team size and Meta setup. Then **K22**: turn K20 into a general CRM connector and add their CRM. Test Arabic replies.
4. **K24 Meta catalog** (with R17): catalog API, product messages from the bot, `catalog_management` on the client's token.
5. **R15 bot side:** Conversions API events in the business's currency.
6. **K5 ad spend import** (with R6), then **K21 analyser** on R5/R6 numbers. One AI call per report, not per lead.
7. **K9 Embedded Signup** (with R8), **K7b** Conversions API on for GKF, then the GKF case study.

**K25 phone sign-in (GKF handover, 12 Nov, PR #55, Kaamil, touches `crm/`):** staff sign in with phone or email. Changes in Krishna's area: login view, Staff page (sign-in phone per person and on Add staff), `Users.findByLogin` / `setLoginPhone` / `throttleKey`, platform migration 5 `login_phone`. Krishna to confirm. Bulk add (R13) does not take a sign-in phone yet.

**Needs credentials (do later, from a machine with `.env` or Heroku access).** Nothing here can run in a cloud session without them:

- Check the `staff_lead_alert` review: `node scripts/create-template.js --status` (needs `META_WABA_ID`, `META_ACCESS_TOKEN`). Then add staff WhatsApp numbers on **Staff**.
- Create `staff_lead_alert` on each new client's WhatsApp account.
- Add each portfolio client (`npm run tenant -- add`, needs `DATABASE_URL`, `TENANT_SECRETS_KEY` and the client's Meta token).
- Razorpay keys for GKF (`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`) and the webhook in the Razorpay dashboard.
- K7b: `META_DATASET_ID` and the `whatsapp_business_manage_events` permission, then check Events Manager.
- WhatsApp payment method on GKF's Meta account (Meta Business settings, before 1,000 conversations a month).
- Connect Zoho for each client that uses it (`npm run zoho -- connect`, needs `DATABASE_URL`, `TENANT_SECRETS_KEY` and the client's Zoho admin for the one-time code).
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
| R5 | ✅ Analytics: funnel, speed to lead, **logging rate**, per salesperson, lost reasons | Krishna | Baseline numbers for the GKF case study |

### 2. Proof of sale

| # | Task | Owner | Notes |
| --- | --- | --- | --- |
| K11 | ✅ **Payment links:** staff send a Razorpay/UPI link from the CRM; the `payment_link.paid` webhook logs Won + ₹ on the lead and triggers the Conversions API event | Kaamil | The lead key goes in the link's `reference_id`/`notes` |
| K13 | ✅ **AI-suggested outcomes:** the reply call also returns a suggested outcome ("paid", "visit booked Sat 7am"); staff confirm with one tap. The AI never logs a sale on its own | Kaamil | Still one AI call per reply |
| R3 | ✅ **Live board:** server-sent events so the kanban pipeline updates for everyone in real time; overdue cards red | Krishna | No websockets or extra services; Postgres triggers + `db.listen`, works with several dynos |
| R4 | ✅ **PWA:** manifest + service worker so sales installs the CRM on their phone | Krishna | Per-client name and icon from the branding; no lead data cached |
| R11 | Unlogged-lead nudges: daily list per salesperson of hot leads with no outcome | Krishna | CRM side built (dashboard, Leads filter, `Nudges.daily()`). **Open until R11b:** the morning send (Kaamil, contract below) |

### 3. Revenue per ad

| # | Task | Owner |
| --- | --- | --- |
| K5 | Marketing API spend import per ad (daily job) | Kaamil |
| R6 | ✅ Per-ad report: leads, qualified, customers, ₹, cost per customer, ROAS, lead-quality grade per creative (spend columns wait for K5) | Krishna |
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
| R10 | Billing UI (Razorpay subscriptions). Not needed for the first clients: we invoice by hand and K26 gives the lead counts | Krishna |

Both: line up a partner agency with a few paying clients (any industry) while this is built.

### 7. Compounding

Cross-client benchmarks, score trained on every client's outcomes, outcome-based pricing pilot, win-back templates. Owners decided when we get there. (Instagram capture moved up as K32, because the sales deck and client agreement include it.)

## Contract: R11 daily reminder (Krishna built the CRM side; Kaamil sends it as R11b, ✅ built 9 Nov)

`crm/src/nudges.js` decides which leads are **waiting for an outcome**: open (not converted, lost or cold), needed a person (a hand-off, or status hot), and no outcome logged since the latest hand-off (a hand-off staff resolved without logging an outcome still counts: that is the gap R11 closes) (or the first message, for a hot lead with no hand-off), for 2 hours to 30 days. The dashboard tile and list, and the **No outcome** filter on Leads, use the same rule.

- `new Nudges(db).daily(now)` → `[{ user: { id, name, email, role, alertPhone, alertMode } | null, leads: [{ waId, name, since, hours }] }]`: one item per active person with waiting leads assigned (oldest first), then one item with `user: null` for unassigned leads (or leads assigned to someone disabled). Runs inside `tenancy.run`; no tenant filter. Sends nothing.
- **Kaamil:** once a day per tenant (morning, display timezone), post each person's list to the staff Telegram group, and to their WhatsApp when `alertPhone` is set and `alertMode` is not `'off'`. Changed when built: the WhatsApp alert uses the existing `staff_lead_alert` template, whose **Open in CRM** button takes a lead key, so it opens the person's **oldest waiting lead**; the Telegram post's button opens the full list (`/leads?waiting=1&sort=waiting`). A new template just for the list can come later if staff ask for it. Send the `user: null` list to managers and owners. Skip people with an empty list.
- **As built (R11b, `src/services/dailyNudges.js`):** runs every minute and does real work once a day per client, at the **start of its working day** in its time zone (Business settings → Lead queue). Each person with waiting leads gets one WhatsApp alert (event `daily_nudge` on the `staff_lead_alert` template: how many, the first names, the oldest age; the button opens the oldest lead), only if they have a number and alerts are not off. The unassigned list goes to managers and owners the same way. One summary goes to the staff Telegram group with a **Log what happened** button (`/leads?waiting=1&sort=waiting`). "Sent today" is a `daily_nudges_sent` row in `crm_activity_log` for the local day, claimed under an advisory lock, so several processes never send it twice; if building or queueing the alerts fails, the row is removed and the next minute retries (alerts already queued are not repeated). It only fires inside working hours, so a restart at night never sends a morning reminder, and each process remembers the day it saw sent, so the database is checked once a day, not every minute.

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

`src/config/verticals.js` has one pack per business type: `gym`, `services` (general), `realestate`. **Lost reasons** keep the same keys everywhere (`LOST_REASONS` in `src/config/lostReasons.js`, shared by the bot and the CRM: neutral wording); a pack's `lostReasons` rewords them (real estate: Budget, Location, Not ready to buy yet, Bought elsewhere), read with `lostReasonsFor(type)` for the lead page, pipeline, reports and the AI prompt. A pack sets how the AI sells (qualify questions, examples), the words in the free fixed replies and buttons (`words`), and display names (`labels`): settings field names, outcome and stage names (real estate: Site visit booked, Site visited, Booked). The CRM reads them per request (`namesFor` in `crm/src/app.js`); internal keys (`joined`, `visit_booked`) never change, so reports, K7 and K11 work the same for every type. Packs hold no personal data: no names, addresses or phone numbers in examples. Sales up to ₹10 crore can be logged (payment links stay at ₹10 lakh).

## Staff WhatsApp alerts (built)

Next to the Telegram group, each staff member can get alerts on their own WhatsApp. On **Staff** (owner), open a person → **WhatsApp alerts**: their number with country code and a mode: **Off**, **Their leads only** (a manager: their team's leads) or **All leads** (CRM migration 6: `crm_users.alert_phone`, `alert_mode`). Alerts: a lead needs a person (new hand-off), a lead wrote while the AI is paused (at most one per lead per 30 minutes), a payment link was paid. `src/services/staffAlerts.js` picks the people and queues one message each in `outbound_messages` (same retries and per-number order as replies). Staff do not message the business number first, so each alert is the Meta template `staff_lead_alert` (utility: about ₹0.12 in India, AED 0.06 in the UAE, paid on the client's Meta account) with an **Open in CRM** button. Create it once per WhatsApp account: `node scripts/create-template.js staff_lead_alert` (needs `META_WABA_ID`, `BUSINESS_NAME`, `CRM_BASE_URL`), then wait for Meta to approve it. The AI does not answer a number saved for alerts.

## Zoho CRM sync (K20, built)

For clients who already run their sales in Zoho CRM. Off until connected per client (`npm run zoho -- --tenant <slug> connect`, steps in [ONBOARDING.md](ONBOARDING.md#manual-flow-today-until-embedded-signup)). The refresh token and client secret are stored encrypted on the tenant; the accounts URL and API domain are per client, since Zoho runs separate data centres (India, UAE, Saudi, US, EU...). Zoho API v8.

**In the CRM** (Krishna, PR `zoho-crm-status`, see [crm/README.md](../crm/README.md#zoho-crm-status)): sync status on Business settings and "Open in Zoho" on the lead page. **To check on the first real connection:** the record link `https://crm.zoho.<dc>/crm/tab/<Module>/<id>` has no `org<id>` segment; if it doesn't open the record, add the org id (read from `/org` at connect) and note the result on the PR.

**Out (us → Zoho).** A database trigger marks a lead in `zoho_links` when it is created, its name, phone, interest or status changes, or an outcome is logged; a new message alone does not. CRM code needs no Zoho calls. `src/workers/zohoWorker.js` sends it:

| Here | In Zoho |
| --- | --- |
| New lead | Lead: name, `+` mobile (when Meta shares it), Lead Status, short description with the CRM link. Matched first by the Lead Engine ID field (upsert), else by mobile, so existing Zoho leads are not duplicated |
| Status changes | Lead Status: new → Not Contacted, contacted → Contacted, qualified/hot → Pre-Qualified, cold → Contact in Future, lost → Lost Lead (per-client override: `zohoStatusMap`) |
| Joined (plan + ₹) | Lead converted into Contact + Deal: name "<lead> - <plan>", Amount, won stage (default Closed Won), closing date, pipeline if set |
| Lost after a Deal exists | Deal moved to the lost stage (default Closed Lost) |

Failures retry with back-off (2, 4, 8… up to 60 minutes, 6 tries). A broken connection (revoked token) raises an ops alert naming the client.

**In (Zoho → us).** Every 5 minutes, per client, Leads and Deals modified since the last read (`If-Modified-Since`, 2 minutes overlap, cursor in `zoho_cursors`):

| In Zoho | Here |
| --- | --- |
| Deal in the won stage with an Amount | **Joined** with plan = Deal name, ₹ = Amount; status converted; goes to Meta through K7 |
| Lead Status Lost Lead / Junk Lead / Not Qualified, or Deal in the lost stage | **Lost** (reason Other, note says what Zoho said) |
| Lead Status Contacted, our lead still new | Status contacted |

Changes from Zoho are logged through the CRM's own outcome rules, in the name of the lead's salesperson, else the first owner. A won sale is never undone from Zoho. Loops are avoided: `zoho_links.zoho_state` remembers the last value on each side, so our own writes read back as "unchanged", and a status that came from Zoho is not pushed back over Zoho's value.

Limits today: amounts are taken as they are in Zoho (an AED deal is stored as that number in the ₹ field); a lead converted in Zoho is matched to its Deal only when the Lead Engine ID field is mapped in lead conversion; `zoho_links` is not in backups yet (after a restore, matching falls back to the ID field or mobile); `npm run delete-lead` removes the lead here but not from Zoho (the client deletes it there). Tests: `test/zoho.test.js` against a fake Zoho.

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

## Automatic PR review

Every PR gets a Claude review, started by the PR itself (no session waits or polls):

1. **Opening a PR** (or reopening it, or marking a draft ready) runs `.github/workflows/claude-review.yml`. Claude follows `.claude/skills/pr-review/SKILL.md`: it reads the diff, `CLAUDE.md` and the task and contract in this file, and posts **one comment** with a verdict, up to 8 findings and a **Prompt for your Claude** block.
2. **The author fixes:** paste that prompt into your own Claude, or comment `@claude fix findings 1 and 2 from the review` on the PR and Claude pushes the fixes itself (`.github/workflows/claude.yml`). CI runs on those pushes.
3. **Re-review after fixes:** add the label `claude-review` to the PR (pushes alone don't re-run it, to save usage).
4. **Merging stays with Kaamil.** Claude never approves or merges.

Keep the loop fast:
- **One open PR at a time per person**, or at least merge them in order. PRs branched from the same point conflict with each other in `crm/src/app.js`, `crm/README.md` and this file.
- **Before adding the label, merge the latest `main`** (a merge commit, no rebase). GitHub runs no workflow on a PR with conflicts, so the review silently never starts.
- **Don't push to a branch after its PR is merged.** Those commits never reach `main`; open a new PR instead.
- "Merge after these fixes" with small notes can merge now and fix in a follow-up PR; anything about safety, data or client separation is fixed first.

Usage: reviews run on Sonnet with a turn cap and only on the events above; `@claude` runs use the default model. Both run on Kaamil's Claude subscription (`CLAUDE_CODE_OAUTH_TOKEN`), so they count against its usage limits, plus GitHub Actions minutes. If only an `ANTHROPIC_API_KEY` secret is set, they use it instead (billed per use); once `CLAUDE_CODE_OAUTH_TOKEN` is added they switch to it and the key can be deleted. Without either, both workflows skip and stay green. The same review runs locally with `/pr-review <number>` (needs `gh`).

## Using Claude Code on this repo

- `CLAUDE.md` at the root is loaded automatically: rules, commands and pointers.
- Before each task: `git checkout main && git pull`, then start Claude Code in the repo folder (`claude`), so it reads the latest docs.
- First prompt for a new task (change the task ID):

  > Read CLAUDE.md, then docs/TEAM.md (start at "Now: order of work"), docs/ARCHITECTURE.md and docs/UI_GUIDE.md. My next task is R13. Look at the code it touches (crm/src/users.js, crm/views/users.ejs, test/crm/), then give me a short plan: what you'll change, the tests you'll add, and anything that needs Kaamil (src/ or a shared table). Don't write code until I say go. Work on a new branch named r13-bulk-staff.

- After "go": ask it to run `npm test` and check the screen at 375px and desktop width, then open a PR into `main` with the task ID in the title. Kaamil reviews.
- For a task with a contract (R2): first ask Claude for a small PR that only writes the contract into docs/TEAM.md and adds the function signatures with tests. Build the rest after Kaamil agrees.
- Ask Claude to write tests with every change and to run `npm test` before opening the PR.

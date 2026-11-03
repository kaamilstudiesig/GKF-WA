# Product plan

**Lead Engine** (working name) is the revenue layer between Meta ads and sales. For any business that runs Meta ads to get leads, it proves which ad made money and tells Meta who is likely to buy before they pay.

Ads bring leads (click-to-WhatsApp chats or lead forms). The AI replies in seconds and qualifies them. Sales is pushed to follow up and the sale is captured, ideally without anyone typing it in. Owners and agencies see ₹ revenue and cost per customer for every ad. An early buying signal and the real outcome both go back to Meta, so the ads find buyers, not just leads.

The product isn't tied to an industry: it works for any business whose Meta ads lead to a conversation or a form and whose sale happens later (in person, on a call, or through a payment link). It's sold mainly **through marketing agencies**, who run Meta ads for many such businesses. Goldkraft Fitness (GKF), a gym in Bengaluru, is the live pilot only because it was the first business we had access to.

> One-line pitch: **"We tell Meta who's going to buy, before they pay."**

- [1. The problem](#1-the-problem)
- [2. Who it's for](#2-who-its-for)
- [3. Where we win: the moat](#3-where-we-win-the-moat)
- [4. Market and competition](#4-market-and-competition)
- [5. The product](#5-the-product)
- [6. Order of work](#6-order-of-work)
- [7. What we don't build](#7-what-we-dont-build)
- [8. Cost plan](#8-cost-plan)
- [9. Pricing (to validate)](#9-pricing-to-validate)
- [10. Go to market](#10-go-to-market)
- [11. Risks](#11-risks)
- [12. Metrics we track](#12-metrics-we-track)
- [Sources](#sources)

---

## 1. The problem

When a Meta ad produces a chat or a form fill, the sale usually happens somewhere Meta can't see: at a counter, on a call, at a visit, or days later. That causes three problems:

1. **Meta optimises for the wrong thing.** It only sees chats and form fills, so it keeps finding people who enquire but never buy.
2. **Sales execution leaks.** Replies are slow, follow-ups are forgotten, and nobody records what happened.
3. **Nobody trusts the numbers.** The business says "your leads are junk", the agency says "your team doesn't follow up", and neither can prove it. Attribution and proof of value are now among the top reasons agencies lose accounts (see Sources).

## 2. Who it's for

| Who | What they want | What we give them |
| --- | --- | --- |
| **Marketing agency** (main buyer and channel) | Keep clients by proving ads make money | Revenue and cost per customer per ad, lead-quality grades per creative, a report the client trusts, benchmarks across clients |
| **Business owner** | More paying customers from the same ad spend | Fast replies 24×7, a sales team that follows up, one screen showing which ad made money |
| **Salesperson / front desk** | Know who to call now, with context | Alerts with Call/Open buttons, the full chat, one-tap outcomes, a lead score |

### Good fit

Any business, any industry, where these are true:

- **Runs Meta ads for leads:** click-to-WhatsApp, click-to-Instagram or lead form ads, directly or through an agency.
- **The sale happens after the lead:** a chat, call, visit, quote or payment link closes it, not an instant website checkout. (Pure e-commerce already has the Meta pixel.)
- **Someone sells:** at least one person replies, calls, books or follows up.

The bigger the ticket and the lead volume, the faster the product pays for itself, but we don't restrict who can use it.

### Business types are configuration, not strategy

Stages, outcomes, lost reasons, FAQs and selling method differ by business type. They live in presets (`src/config/verticals.js`) and the business profile, so a new kind of business is set up as data, never as a code fork.

### Meta's own limits apply to some advertisers

The product works for every business, but Meta limits the conversion loop for some categories. Check at onboarding and set expectations; reporting and sales follow-up still work:

- **Health and wellness:** Meta restricts lower-funnel conversion data (Purchase/Lead optimisation) for many health-related advertisers.
- **Special Ad Categories** (housing, financial products, employment): targeting is limited.

Details: [META_PLATFORM.md](META_PLATFORM.md#9-data-restrictions-by-advertiser-category).

## 3. Where we win: the moat

### What is not a moat

These are table stakes. Competitors, and now Meta itself, have them:

- An AI chatbot on WhatsApp, even in Hinglish or regional languages. **Meta's own Business AI / Meta Business Agent launched for Indian WhatsApp businesses in 2026.** It qualifies leads, books appointments and answers FAQs.
- A Conversions API integration on its own. Interakt, Gallabox and AiSensy all send click-to-WhatsApp conversion events.
- A WhatsApp inbox, kanban or CRM screens.

So we don't compete on the chatbot. The bot is the hook. If a client prefers Meta's agent, the rest of the product should still work.

### What is our moat

Competitors only see what happens **inside the chat**. Their Conversions API events come from chat tags, WhatsApp payments or a fixed average order value. We own what happens **after the chat**: the call, the visit, the payment, and the real ₹ amount. Three layers build on that, each making the next stronger:

1. **Proof of sale.** Capture the real outcome (visited, paid, ₹) with as little staff effort as possible: payment links, AI-detected outcomes, one-tap logging from alerts. This is the hardest problem and the foundation of everything else.
2. **Early buying signal for Meta.** Real sales close days or weeks after the click, and in small numbers, which is too slow and too rare for Meta to learn from. We already have the conversation. We score each lead from the chat (intent, budget, timing, visit booked) and send a qualified-lead event within minutes, then the real outcome later. Every real outcome, across every client and every type of business, makes the score more accurate. That data compounds, and a newcomer starts with none of it.
3. **The trusted record between agency and client.** Revenue per ad, lead quality per creative, and benchmarks across clients ("your cost per customer is 30% better than similar businesses we see"). Once an agency runs its client reporting through us, switching means losing its history and its proof. Later, verified outcomes make outcome-based pricing possible ("₹X per verified customer"), which competitors can't offer.

**Test for every feature:** does it capture more real outcomes, make the early signal more accurate, or make the agency's proof more trusted? If not, it waits.

## 4. Market and competition

The market is every business that runs Meta lead ads, plus the agencies that run them. Meta is training about 4,000 Indian agencies to sell click-to-message ads.

| Category | Examples | Price (India) | Strong at | Where we beat them |
| --- | --- | --- | --- | --- |
| Meta's own AI agent | Business AI (WhatsApp Business app), Meta Business Agent (Cloud API, waitlist, India launch July 2026) | Meta-billed | First reply, FAQs, booking, lead qualification, free distribution | It stops at the chat: no sales follow-up, no outcomes after the chat, no revenue per ad. It can run alongside us on a Cloud API number |
| WhatsApp API platforms | AiSensy, Interakt, WATI, Gallabox, Spur | ₹1,500–5,000/mo + messages | Broadcasts, chatbot builders, click-to-WhatsApp ads, chat-based Conversions API events | Their events stop at the chat or a WhatsApp payment (Gallabox uses a fixed average value). No real ₹ from sales, no sales floor, no agency-grade proof |
| Sales CRMs | LeadSquared, Zoho, Kommo, HubSpot | $25–100/user/mo | Pipelines, telecalling, enterprise | Heavy to set up for small businesses, WhatsApp bolted on, no chat-based early signal to Meta |
| Agency white-label CRMs | GoHighLevel | $97–497/mo | Resell under the agency brand, funnels | US/SMS-first, expensive in ₹, weak on WhatsApp and Indian languages |
| Industry software | Booking, billing and management tools for specific trades | ₹1,000–25,000/mo | Billing, records, scheduling | No ad attribution or Meta loop. Integrate with them, don't replace them |

Meta is pushing the market toward us. It increasingly requires a Conversions API integration for qualified-lead optimisation, and it rewards advertisers that send real downstream outcomes.

## 5. The product

### 5.1 Capture: AI front desk (exists, keep improving)
- Answers in seconds in the lead's language, from the business profile only. Free fixed answers for common questions; one AI call per reply.
- Qualifies using the business type's selling method and asks a question only when it moves the lead forward.
- Hands off on booking, discount, sensitive topics, complaints or "human"; never invents facts.
- Works alongside Meta's agent: if a client uses Meta Business Agent on a Cloud API number, we still ingest the conversation and run everything after it.
- Next: Lead Ads to instant WhatsApp, WhatsApp Flows for booking, a review queue for AI chats.

### 5.2 Convert: sales floor
- Done: one-tap outcomes with automatic follow-ups (R1), Telegram alert buttons (K4), kanban pipeline.
- Next: hot lead auto-assigned (round robin among on-shift staff), a **5-minute timer**, escalation to the manager, then reassignment. A live board for everyone and an installable phone app (PWA).
- A staff reply from the CRM counts as contact automatically.

In Velocify's study of 3.5M leads, leads called within a minute converted at almost 4× the rate of leads called at 30 minutes.

### 5.3 Prove the sale (the foundation of the moat)
- **Payment links in chat** (Razorpay / UPI): a paid link logs *Won + ₹* on the lead automatically, with no staff typing.
- **AI-detected outcomes:** when the chat says "I've paid" or "see you Saturday", suggest the outcome to staff for one-tap confirmation. The AI suggests; staff confirm.
- **One-tap logging from alerts**, and a daily "unlogged leads" nudge per salesperson.
- **Imports:** CSV and webhooks so a business's existing billing or booking tool can report sales back.
- Track the **logging rate** per client. Without outcomes, nothing else works.

### 5.4 Signal: the Meta loop
- **Conversions API for business messaging** (click-to-WhatsApp): Visit booked → `QualifiedLead`, Joined/Won → `Purchase` with real ₹ (built: K7). Matched by `ctwa_clid`, else hashed phone + Page ID.
- **Early signal:** a lead score from the chat; above a threshold, send the qualified event within minutes instead of waiting for the visit. Tune the threshold so the event fires for a meaningful share of leads (Meta's guidance for an optimisation stage is roughly a 1–40% conversion rate). Never send the same outcome twice, because Meta doesn't de-duplicate.
- **Conversion Leads** (Lead Ads forms): send at least two, ideally three, funnel stages daily, with the target stage reached within 28 days.
- **Audiences:** exclude customers from ads; lookalikes of people who paid.
- Respect Meta's category limits: check each client's dataset restrictions at onboarding, and never put sensitive traits (health conditions etc.) in event or audience names.

### 5.5 Prove the ads: owner and agency analytics
- **Per ad, ad set and campaign:** leads, qualified, visits, customers, ₹ revenue, cost per lead, **cost per customer**, ROAS (spend from the Marketing API).
- **Lead-quality grade per creative**, so agencies can kill bad ads fast.
- Funnel with drop-off, speed to lead per salesperson, revenue and lost reasons per person.
- **Benchmarks across clients** of a similar type and size, once there are enough clients to keep them anonymous.
- A nightly digest and a weekly report the agency can forward under its own brand.

### 5.6 Platform: many clients, many agencies
- Tenants with `tenant_id` + row-level security; webhook routed by `phone_number_id`.
- Self-serve onboarding in under an hour (see [ONBOARDING.md](ONBOARDING.md)): Embedded Signup v4 (with coexistence), business profile with a business-type preset, team, ad account, dataset check, test checklist.
- Agency layer: one login for many clients, white-label logo and domain, cross-client dashboard.
- Billing: Razorpay subscriptions + AI usage.
- Compliance: consent log, opt-out, data export and delete (India's DPDP obligations apply from May 2027).

### 5.7 Channels: Instagram and others
Instagram click-to-WhatsApp ads already reach us (`adAttribution.js` tags them `instagram_ad`). A separate Instagram DM bot is **not a priority**:
- Instagram allows replies only within 24 hours. A 7-day human-agent window exists, but it's for manual support, not sales pushes.
- There are no paid templates to re-engage a lead.
- There's no phone number for sales to call.

When we add Instagram, it's a narrow capture feature: a comment or DM gets one private reply that moves the lead to WhatsApp, where the sales loop and proof live. Build it when agencies ask for it.

## 6. Order of work

There are no dates. Each stage ships on GKF first and moves on when its "done when" is true. Owners and task IDs are in [TEAM.md](TEAM.md).

| # | Stage | Ships | Done when |
| --- | --- | --- | --- |
| 1 | **Prove the loop on GKF** | Conversions API on in production (K7), baseline metrics, logging-rate tracking | We have before/after speed to lead, logging rate and cost per customer for GKF |
| 2 | **Proof of sale** | Payment links → automatic Won + ₹ (K11), AI-suggested outcomes, unlogged-lead nudges, sales-floor timer and escalation (R2) | 80%+ of sales recorded without chasing staff |
| 3 | **Revenue per ad** | Marketing API spend import (K5), per-ad revenue and cost-per-customer report (R6), lead-quality grade per creative | An owner or agency answers "which ad made us money" on one screen |
| 4 | **Early signal** | Lead score from the chat + early qualified event (K12), Lead Ads webhook → instant WhatsApp (K6), Conversion Leads stages | A campaign fed by our events shows lower cost per paying customer than before |
| 5 | **First paying agency** | Manual onboarding of a few of the agency's clients, whatever their business (separate deployments are fine) | An agency pays for one client and asks to add another |
| 6 | **Platform** | Tenants + RLS (K8), Embedded Signup v4 (K9), onboarding wizard, agency dashboard and white-label, billing | A new client goes live in under an hour without code |
| 7 | **Compounding** | Cross-client benchmarks, score trained on all clients' outcomes, outcome-based pricing pilot, win-back templates, Instagram capture | The score and benchmarks measurably beat what one client's data gives |

## 7. What we don't build

- A general chatbot builder or bulk broadcasting tool (AiSensy, Interakt and WATI own that).
- Billing, attendance, records or scheduling for any trade (integrate or import instead).
- Industry-specific forks of the code. Business types are presets and profile data.
- A full Instagram DM bot before the WhatsApp loop is proven.
- Anything that doesn't pass the moat test in [section 3](#3-where-we-win-the-moat).

## 8. Cost plan

Principle: spend nothing until a paying client needs it, and keep the per-client cost tiny.

| Stage | Hosting | Monthly cost | Notes |
| --- | --- | --- | --- |
| Now (GKF pilot) | Heroku Basic dyno + Postgres Essential-0 | ~$12, covered by student credits | Student credits are for learning and personal projects; move off before charging clients |
| First paying clients (1-20) | One app instance + managed Postgres in an India/Singapore region | ~₹2,000-4,000 | Same code; India region for data and latency |
| 20-100 clients | 2-3 app instances, bigger Postgres, separate worker process | ~₹8,000-15,000 | Still one codebase, one database |

Per client per month (estimate):

| Item | Cost |
| --- | --- |
| AI (3,000 replies, one call per reply) | ~₹26 per 1,000 replies → **~₹80** |
| Hosting share at 20+ clients | ₹100-300 |
| Meta messages | Paid by the client to Meta directly: service replies are largely free, ad-click conversations are free for 72h, and marketing templates cost about ₹0.86 each in India since Jan 2026 |
| Support | The real cost: budget 1-2 hours per client per month at first |

Cost rules in code: fixed answers first, one AI call per reply, cached prompt prefix, per-lead daily cap, monthly AI budget per tenant, and no paid AI calls in tests.

## 9. Pricing (to validate)

Price on value: one extra customer a month should pay for the product.

| Plan | Price | Includes |
| --- | --- | --- |
| Core | ₹4,999/mo per client | AI front desk, sales floor, outcomes, basic reports, 5 users |
| Growth | ₹9,999/mo per client | + proof of sale, revenue per ad, Meta loop (Conversions API + early signal), weekly agency report, 15 users |
| Agency wholesale | ₹2,999-5,999 per client | White-label; agency resells it bundled with its ad management |
| Outcome-based (later) | ₹X per verified customer | Only once outcome capture is reliable |
| Setup | ₹10,000-25,000 once | Profile, FAQs, dataset check, test pass, team training |

Charge the agency where possible. Agencies have more clients per sale and a direct reason to pay: keeping their accounts. Before fixing prices, interview 10 agencies and 10 business owners from different industries. Free pilots don't prove willingness to pay; even a small fee does.

## 10. Go to market

1. **GKF case study:** speed to lead, logging rate and cost per customer, before vs after.
2. **Agencies first, any industry:** an agency brings all its lead-ad clients, whatever they sell. One agency deal = many clients.
3. **One partner agency with a few paying clients.** Charge something from day one.
4. **Agency deal:** wholesale price or a 25-30% recurring revenue share. Sell it as the agency's retention tool: "prove your ads work, keep the account."
5. **Meta's agency ecosystem:** Meta is training thousands of Indian agencies on click-to-message ads. Those agencies are our channel.
6. **Direct sales** to businesses with in-house ad teams, once self-serve onboarding works.

## 11. Risks

| Risk | Level | Response |
| --- | --- | --- |
| **Real outcomes don't get captured** (staff don't log, payments happen outside our links) | **Highest** | Payment links, AI-suggested outcomes, one-tap logging from alerts, imports; measure logging rate per client and fix it before adding features |
| **The early signal doesn't beat Meta's default optimisation** | High | Test on GKF and the first agency clients with a clear before/after on cost per paying customer; if it doesn't help, lean on proof and reporting |
| **Meta's own agent commoditises the front desk** | High | Don't compete on the bot. Run alongside Meta's agent and own everything after the chat |
| **Being horizontal makes the product generic** | High | Keep one core loop (lead → sale → Meta) for everyone; differences live in presets and profile data; benchmark within similar business types |
| **Meta data restrictions** (health and wellness, Special Ad Categories) limit the loop for some advertisers | Medium | Check each client's dataset at onboarding and set expectations; reporting and follow-up still work |
| Meta policy, pricing or API changes (AI policy, BSUID, Embedded Signup versions) | High | Keep the bot business-scoped; watch Meta changelogs monthly; keep [META_PLATFORM.md](META_PLATFORM.md) current |
| Agencies don't adopt, or fear exposing bad ads | Medium | Start with agencies confident in their results; frame it as proof that keeps accounts |
| Competitors add revenue-per-ad reports | Medium | They'd still lack real sales outcomes and cross-client data; move fast on proof of sale and benchmarks |
| Small team: uptime, support and onboarding all on two people | High | Self-serve onboarding, runbooks and alerts before scaling sales; say no to scope creep |
| Data protection (DPDP from May 2027; sensitive data for some clients) | Medium | Consent log, export/delete, India hosting, no sensitive details in Meta events |
| AI mistakes (wrong price, promising a slot) | Low | Facts only from the profile, hand-off rules, review queue |

## 12. Metrics we track

- **Logging rate:** % of hot leads with an outcome within 24h, and % of sales recorded automatically (target > 80%).
- **Speed to lead:** median minutes from hot lead to first human contact (target < 5).
- **Cost per paying customer per ad**, before vs after our events. This is the number that sells the product.
- **Signal quality:** share of leads that get the early qualified event, and how many of them actually buy.
- **Funnel:** lead → qualified → visit/call → customer, per source and per ad.
- **Bot:** % answered without staff, AI cost per lead, hand-off rate.
- **Business:** paying clients, clients per agency, net revenue retention.
- **Reliability:** failed sends per day (target 0), webhook-to-reply p95 (target < 10s), Conversions API events rejected (target 0).

## Sources

Researched Nov 2026. Most are third-party summaries, so confirm on Meta's own pages before building on a detail. Meta facts are collected in [META_PLATFORM.md](META_PLATFORM.md).

- Meta's own agent: [afaqs: Meta Business Agent at India Business Summit](https://www.afaqs.com/news/digital/whatsapp-introduces-meta-business-agent-at-india-business-summit-12144404) · [India TV: Meta Business Agent launch](https://www.indiatvnews.com/technology/news/whatsapp-launches-meta-business-agent-in-india-ai-assistant-to-help-businesses-automate-customer-support-2026-07-08-1047580) · [Deccan Herald: Business AI in India](https://www.deccanherald.com/technology/artificial-intelligence/meta-brings-business-ai-agent-for-indian-enterprise-owners-on-whatsapp-business-3994706) · [360dialog: Meta Business Agent for API users](https://360dialog.com/blog/?p=1433)
- Competitors' Conversions API: [Interakt CAPI](https://www.interakt.shop/resource-center/conversions-api) · [Gallabox CAPI docs](https://docs.gallabox.com/whatsapp/ad-campaigns/capi.md) · [AiSensy CAPI FAQ](https://faq.aisensy.com/how-to-use-meta-conversions-api-capi-in-click-to-whatsapp-ads) · [LeadSquared pricing (Capterra)](https://www.capterra.com/p/130199/LeadSquared/reviews/3233278)
- Agency churn and attribution: [AgencyAnalytics benchmarks 2026](https://agencyanalytics.com/blog/agency-benchmarks-2026-attribution) · [WhatConverts on lost clients](https://www.whatconverts.com/?p=33555) · [upgrowth: performance marketing contracts](https://upgrowth.in/red-flags-performance-marketing-contracts/)
- Market: [Meta: upskilling India's digital agencies](https://about.fb.com/news/2025/05/upskilling-indias-digital-agencies-to-accelerate-smb-growth/) · [Social Samosa: Meta APEX programme](https://www.socialsamosa.com/report/metas-ads-partner-excellence-program-empower-agencies-driving-indias-growth-9333718)
- Data restrictions: [SagaPixel: Meta health restriction tiers](https://sagapixel.com/meta-ads/facebook-ads-3-tiers/) · [Digiday on health and wellness restrictions](https://digiday.com/marketing/as-health-and-wellness-brands-brace-for-ad-restrictions-on-meta-marketers-and-advertisers-seek-more-transparency/) · [Jon Loomer: Special Ad Categories](https://www.jonloomer.com/special-ad-categories-meta-ads/)
- DPDP: [India Briefing: DPDP timeline](https://www.india-briefing.com/news/india-dpdp-compliance-timeline-enforcement-2026-27-44740.html/)

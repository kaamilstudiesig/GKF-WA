# Meta platform notes

What we learned about Meta's WhatsApp, Ads and Conversions APIs that shapes the product. Researched 30 Oct 2026, updated 2 Nov 2026. Meta changes things often, so **re-check the linked official page before building on any point**. Third-party sources are marked as such.

- [1. How a client gets connected](#1-how-a-client-gets-connected)
- [2. Pricing (India)](#2-pricing-india)
- [3. Limits](#3-limits)
- [4. AI policy](#4-ai-policy)
- [5. Usernames and BSUID (identity change)](#5-usernames-and-bsuid-identity-change)
- [6. Tokens and permissions (learned the hard way)](#6-tokens-and-permissions-learned-the-hard-way)
- [7. Features that fit the product](#7-features-that-fit-the-product)
- [8. Checklist before onboarding client #2](#8-checklist-before-onboarding-client-2)
- [9. Data restrictions by advertiser category](#9-data-restrictions-by-advertiser-category)
- [10. Meta's own AI agent](#10-metas-own-ai-agent)
- [11. Optimising on our events: what Meta needs](#11-optimising-on-our-events-what-meta-needs)
- [12. Instagram messaging rules](#12-instagram-messaging-rules)
- [Sources](#sources)

---

## 1. How a client gets connected

**Today (GKF):** we set up the WhatsApp number by hand in our own Meta app and use a system-user token. That doesn't scale.

**Target: Meta Tech Provider + Embedded Signup v4.**

- A **Tech Provider** is a business whose Meta app other businesses connect to. The client keeps ownership of its WhatsApp Business Account (WABA) and pays Meta directly for messages; we get access to send and receive for them. ([Meta: onboarding as a Tech Provider](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider))
- **Embedded Signup** is a Facebook login popup on our site. The client picks or creates their business, WABA and number, verifies by OTP, and we get a code.
- **v2 and v3 were deprecated on 15 Oct 2026; build on v4 only.** (Per [360dialog](https://360dialog.com/blog/embedded-signup-versions-migration/), third-party, and Meta's versions page.)
- After the popup, **we must exchange the code for a business token** and register the number. Until then the client can't send anything. Numbers must be registered **within 14 days** of signup.
- Requirements for our app: a production webhook, able to send messages and manage templates, subscribed to the `account_update` webhook, and served over valid SSL.

**Coexistence (big deal for small businesses):** a client can keep using the **WhatsApp Business app on their phone** with the same number while our API runs alongside. ([Meta: onboard WhatsApp Business app users](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users/))

| Coexistence fact | Impact |
| --- | --- |
| Needs Tech Provider status, Business app 2.24.17+, and Embedded Signup with session logging | Plan for it in the onboarding flow |
| Number is `sync_pending` for up to 24h; API sends blocked until `active` | Onboarding UI must show this state |
| Throughput fixed at **20 messages/second** | Fine for one local business |
| Messages sent from the phone app are free and don't open or extend API service windows | Staff replying from the phone ≠ a CRM reply; our pause logic must read coexistence echo webhooks |
| Chat history sync is partial; groups and Status aren't synced | CRM history may have gaps for old chats |
| **Marketing Messages API isn't available with coexistence** | Win-back campaigns need the plain Cloud API |
| Calling API not available | No in-CRM WhatsApp calls for coexistence clients |
| Re-registering the phone app offboards the API connection; ~14 days of phone inactivity can break the link (third-party) | Monitor `account_update` and alert us |

Coexistence summary from [Chakra](https://chakrahq.com/article/whatsapp-business-app-api-coexistence-2026) and [YCloud](https://www.ycloud.com/blog/whatsapp-business-app-coexistence-meta-update) (third-party).

## 2. Pricing (India)

Meta bills **per delivered message** (since 1 July 2025), by category. The client pays Meta from their own WABA; our cost is only our platform.

| Category | When | India rate (before 18% GST) |
| --- | --- | --- |
| Service | Replies within 24h of the lead's last message | **First 1,000/month per number free (from 1 Oct 2026)**, then the utility rate |
| Utility template | Order/booking updates | ₹0.115 |
| Authentication | OTPs | ₹0.115 |
| Marketing template | Promotions, win-back | **₹0.8631** (raised about 10% on 1 Jan 2026) |
| Any message in the **72h after a click-to-WhatsApp ad** | Ad-click conversations | Free |

Rates from third-party summaries ([MyOperator](https://myoperator.com/blog/whatsapp-business-api-pricing-india-2026), [DEV](https://dev.to/abhishek_rajpurohit/whatsapp-business-api-pricing-in-india-2026-per-message-rates-gst-and-real-cost-math-1e3a)); confirm on Meta's rate card.

What this means for us:

- Inbound-led bots are very cheap: most of our traffic is service messages plus ad-click windows.
- Marketing templates are 7-8× a service message. Use them only for targeted win-back, and prefer the Marketing Messages API (Meta picks the recipients most likely to engage).
- Show each client their projected Meta bill in the dashboard so it's never a surprise.

## 3. Limits

| Limit | Value | Source |
| --- | --- | --- |
| Throughput per number | 80 msg/s default, auto-upgrade to 1,000; coexistence numbers fixed at 20 | [Meta: throughput](https://developers.facebook.com/documentation/business-messaging/whatsapp/throughput) |
| Error when exceeded | `130429` | same |
| Messaging limit (unique users per 24h for **business-initiated** messages) | Tiers 250 → 2K → 10K → 100K → unlimited, **set at the business-portfolio level and shared by all numbers in the portfolio** | [Meta: quality webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/phone_number_quality_update) |
| Quality rating | GREEN / YELLOW / RED per number; low quality lowers limits | same |

Because each client owns their own WABA and portfolio, one client's volume doesn't eat another client's limit. That's another reason to use the Tech Provider model instead of putting all clients under our portfolio.

## 4. AI policy

Since **15 Jan 2026** the WhatsApp Business Solution terms ban **general-purpose AI assistants** (ChatGPT-style "ask me anything") on the Business API. Bots that serve a specific business function (support, sales, bookings, FAQs) are allowed. ([TechCrunch](https://techcrunch.com/2025/10/18/whatssapp-changes-its-terms-to-bar-general-purpose-chatbots-from-its-platform), [respond.io](https://respond.io/blog/whatsapp-chatbot-policy-2026), third-party)

For us: the prompt must keep the bot scoped to the client's business. It answers only from the business profile and declines off-topic requests. Never market it as "ChatGPT on WhatsApp".

Meta now ships its own business-scoped agent too; see [section 10](#10-metas-own-ai-agent).

## 5. Usernames and BSUID (identity change)

WhatsApp is rolling out **usernames** (from mid-2026) so users can hide their phone number. To support that, webhooks now include a **business-scoped user ID (BSUID)** in `user_id`. When a user has a username and no prior chat with the business, `wa_id` / `from` **may contain the BSUID instead of a phone number, or be missing**. A BSUID is different per business and changes if the user changes their number. ([Meta: business-scoped user IDs](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids/), [Twilio changelog](https://www.twilio.com/en-us/changelog/whatsapp-usernames--new-business-scoped-user-id--bsuid--field-re), [Chatwoot issue](https://github.com/chatwoot/chatwoot/issues/13837))

**How we handle it (task K1):**

1. `leads.wa_id` stays the lead's key: the phone for existing and phone-known leads, the BSUID for username-only leads. Nothing that references leads had to change.
2. New columns `leads.phone`, `leads.user_id` (unique) and `leads.username` hold whatever Meta has shared. Every inbound message fills them in.
3. Incoming messages are matched to a lead by BSUID first, then phone (`leadRepository.resolveKey`), so a known lead stays one lead when Meta later hides the phone.
4. Replies go to `to` (phone) when we have it, else to `recipient` (BSUID) (`identity.sendTarget`).
5. `system` messages `user_changed_number` / `user_changed_user_id` move the new BSUID onto the lead; the bot doesn't answer them.
6. CRM and Telegram show `+phone`, `@username` or "phone hidden", and only offer wa.me links when there's a phone.

Not done yet: asking a username user for their phone (`REQUEST_CONTACT_INFO` button) and Meta's contact book API.

## 6. Tokens and permissions (learned the hard way)

**Incident, 30 Oct 2026:** a new system-user token was generated with only `catalog_management`. Meta applied that permission set to the system user's **other tokens too**, so the live bot token lost `whatsapp_business_messaging` and every reply failed (Graph error 100, subcode 33) for about 7 hours. Inbound webhooks kept arriving, so the bot looked healthy.

Rules:

- Any token for a system user must include **all** of: `whatsapp_business_messaging`, `whatsapp_business_management`, `catalog_management` (plus `business_management` if needed).
- Send failures now page us (Telegram ops group + Sentry, `src/services/opsAlerts.js`): account-level Meta errors alert immediately with the fix, unexplained failures alert after 3 in 10 minutes.
- With Embedded Signup, each client gets its own business token, which removes this shared-token risk.

## 7. Features that fit the product

| Feature | What we use it for | Status (Oct 2026) |
| --- | --- | --- |
| **Click-to-WhatsApp ads** + referral data | Ad → chat; we store ad id, headline and `ctwa_clid` | Live on GKF |
| **Lead Ads webhook** (`leadgen` on the Page) | Form lead arrives in real time → WhatsApp them in seconds. Payload has only `leadgen_id`; fetch details with a Page token (`leads_retrieval`, `pages_manage_metadata`, `pages_show_list`, `pages_read_engagement`; needs App Review). Leads expire after 90 days, so poll as a backstop. ([Meta: Lead Ads webhooks](https://developers.facebook.com/documentation/ads-commerce/marketing-api/guides/lead-ads/quickstart/webhooks-integration)) | To build |
| **Conversion Leads goal + Conversions API for CRM** | Send lead stage changes (contacted, qualified, visited, won) so Meta delivers ads to people who actually convert. The strongest optimisation loop for lead form ads; requirements in [section 11](#11-optimising-on-our-events-what-meta-needs). ([Meta: CRM integration](https://developers.facebook.com/documentation/ads-commerce/conversions-api/conversion-leads-integration/crm-integration/2-getting-started-with-integration)) | To build |
| **Conversions API for business messaging** | Visit booked → `QualifiedLead`, Joined → `Purchase` (INR) against `ctwa_clid` (or hashed phone + Page ID). Needs a dataset per WABA (`POST /{waba}/dataset`) and `whatsapp_business_manage_events`; Meta does not de-duplicate, so each outcome is sent once. The page now lists Purchase optimisation for click-to-WhatsApp ads. Competitors (Interakt, Gallabox, AiSensy) send chat-based events only; our edge is real ₹ from sales after the chat plus an early qualified event from the chat score. ([Meta](https://developers.facebook.com/docs/marketing-api/conversions-api/business-messaging/)) | Built (K7); on when `META_DATASET_ID` is set |
| **Marketing API** insights + custom audiences | Spend per ad → cost per lead/member; exclude members from ads; lookalikes of joiners | To build |
| **Marketing Messages API** (was MM Lite, GA Feb 2026) | Win-back templates with Meta-optimised delivery and conversion metrics. Not with coexistence. ([Meta](https://developers.facebook.com/documentation/business-messaging/whatsapp/marketing-messages/overview)) | Later |
| **WhatsApp Flows** | In-chat forms: trial slot picker, goal quiz → structured data, fewer AI calls | To build |
| **Calling API** | Sales calls the lead over WhatsApp from the CRM after the lead grants permission (1 permission request per 24h, 2 per week; call within 72h). India listed as supported by third parties; confirm. ([Meta: calling pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/pricing/), [Infobip](https://support.infobip.com/docs/whatsapp/whatsapp-business-calling/business-initiated-calling)) | Later |
| **Catalog + product messages** | Plan cards in chat | Catalog created for GKF (4 plans) |
| **Interactive buttons / location** | Tap-to-answer, map pin | Live on GKF |

## 8. Checklist before onboarding client #2

- [ ] Meta Business verification for our company + apply for **Tech Provider**
- [ ] App Review for the permissions we need (WhatsApp management/messaging, `leads_retrieval`, Pages, `ads_read`)
- [ ] Embedded Signup **v4** page (with coexistence option) + code → token exchange + number registration
- [ ] `account_update` and quality webhooks handled, with alerts
- [ ] BSUID-safe lead identity (section 5)
- [ ] Per-tenant encrypted tokens, `tenant_id` + row-level security
- [ ] Privacy policy, terms, data deletion endpoint (required by App Review, and by India's DPDP rules from 13 May 2027)
- [ ] Dataset restriction check for the client (health and wellness, Special Ad Categories; [section 9](#9-data-restrictions-by-advertiser-category))

## 9. Data restrictions by advertiser category

The product works for any business that runs Meta ads, but Meta limits the conversion loop for some advertisers. Check this for every client at onboarding and set expectations; lead capture, sales follow-up and our own revenue reports still work.

| Category | What Meta limits | What we do |
| --- | --- | --- |
| **Health and wellness** (businesses tied to medical conditions, health status or provider/patient relationships) | Since early 2025, Meta classifies data sources and, for restricted ones, blocks or limits mid- and lower-funnel events, which can block Purchase/Lead optimisation. Custom audiences or conversions whose names imply health conditions get disabled. Third-party sources describe tiers (core, partly restricted, fully restricted); whether and how this applies outside the US isn't clearly documented | Check the client's dataset status in Events Manager before promising optimisation. Never put conditions or treatments in event names, custom data or audience names. Still send what's allowed |
| **Special Ad Categories** (housing, financial products and services, employment, and social/political issues) | Targeting limits (age, gender, location radius, detailed interests, exclusions), set per country with `special_ad_category_country` | The loop still works, but expect weaker targeting; prefer value signals over audience tricks |

Sources: [SagaPixel: health restriction tiers](https://sagapixel.com/meta-ads/facebook-ads-3-tiers/), [Digiday](https://digiday.com/marketing/as-health-and-wellness-brands-brace-for-ad-restrictions-on-meta-marketers-and-advertisers-seek-more-transparency/), [Wheelhouse](https://www.wheelhousedmg.com/insights/articles/meta-data-restrictions-healthcare-advertising/), [Meta: Special Ad Category API](https://developers.facebook.com/documentation/ads-commerce/marketing-api/audiences/special-ad-category), [Jon Loomer: Special Ad Categories](https://www.jonloomer.com/special-ad-categories-meta-ads/) (mostly third-party).

## 10. Meta's own AI agent

Meta now offers the AI front desk itself, which is why our moat is everything after the chat ([PRODUCT_PLAN.md §3](PRODUCT_PLAN.md#3-where-we-win-the-moat)).

| Product | What it is | Availability |
| --- | --- | --- |
| **Business AI** | AI inside the WhatsApp Business app: answers FAQs, captures leads, books appointments, in Indian languages, no code. UPI payments in chat announced as coming | India from May 2026, gradual rollout |
| **Meta Business Agent** | Answers business questions, recommends catalogue products, books appointments, qualifies leads, summarises missed chats for the owner. Two paths: Business app (no code) or a Cloud API number (via a BSP, Embedded Signup or direct integration) | Launched at the WhatsApp Business Summit, Mumbai, 7 July 2026; waitlist |

What it means for us:

- **On a Cloud API number, Meta's agent runs alongside a partner's inbox and CRM, not instead of it** (per 360dialog). So a client can use Meta's agent for first replies and still use us for sales follow-up, proof of sale, reporting and the Meta loop. Design for that: our bot is optional, the rest isn't.
- Meta bills agent messages itself, not through the BSP.
- Pricing and human hand-off details weren't public at the time of research.

Sources: [afaqs](https://www.afaqs.com/news/digital/whatsapp-introduces-meta-business-agent-at-india-business-summit-12144404), [India TV](https://www.indiatvnews.com/technology/news/whatsapp-launches-meta-business-agent-in-india-ai-assistant-to-help-businesses-automate-customer-support-2026-07-08-1047580), [Deccan Herald](https://www.deccanherald.com/technology/artificial-intelligence/meta-brings-business-ai-agent-for-indian-enterprise-owners-on-whatsapp-business-3994706), [360dialog: Meta Business Agent for API users](https://360dialog.com/blog/?p=1433), [360dialog: who bills agent messages](https://360dialog.com/blog/?p=1485), [Chakra: Meta Business Agent guide](https://chakrahq.com/id/article/meta-business-agent-whatsapp-instagram-guide) (third-party).

## 11. Optimising on our events: what Meta needs

There are two loops, depending on how the lead arrived.

| | Click-to-WhatsApp ads | Lead form ads (Instant Forms) |
| --- | --- | --- |
| API | Conversions API for business messaging (`action_source: business_messaging`) | Conversions API for CRM (Conversion Leads) |
| Match key | `ctwa_clid`, else hashed phone + Page ID | Meta lead ID from the `leadgen` webhook |
| Events | `QualifiedLead`, `Purchase` (+ value, currency) | Our CRM stages (e.g. qualified, visited, won) |
| Optimisation | Purchase optimisation for click-to-WhatsApp ads under the Sales objective | "Maximise qualified leads" (Conversion Leads); reported to need a Conversions API integration for new campaigns since April 2026 |

Conversion Leads requirements (Meta's FAQ; numbers vary between versions, re-check):

- Lead form ads only (Facebook/Instagram Instant Forms).
- At least **two** funnel stages, three recommended.
- The target stage should be reached within **28 days** of the lead, with a conversion rate of roughly **1–40%**.
- Upload at least **daily**. An older FAQ version also asks for about 250+ leads a month.
- Expect a funnel-analysis and training period of 1–2 months.
- Third-party rules of thumb: 25–50 optimised events a week to leave the learning phase; optimise for a stage reached by 10–30% of leads.

What this means for us:

- **One business rarely has enough real sales for Meta to learn from them alone.** That's why the early qualified event, scored from the chat, matters: it fires for a larger share of leads within minutes, and the real outcome follows later.
- Pick the score threshold so the early event lands in the 1–40% band, and check later what share of those leads actually buy.
- **Value rules** (bid adjustments by audience segment) exist for lead goals too, but don't work with ROAS goals, bid caps or maximise-value goals. Treat them as an agency setting, not a product feature.

Sources: [Conversion Leads FAQ](https://developers.facebook.com/documentation/ads-commerce/conversions-api/conversion-leads-integration/faq), [Make: CAPI for CRM](https://www.make.com/en/blog/meta-make-conversions-api-for-crm), [Jon Loomer: Sequenced Events](https://www.jonloomer.com/meta-sequenced-events/), [Click Here Digital: lead optimisation](https://www.clickheredigital.com/insights/meta-shift-to-lead-optimization), [Jon Loomer: value rules](https://www.jonloomer.com/value-rules/), [Chatfuel: WhatsApp CAPI](https://chatfuel.com/blog/whatsapp-conversions-api-ctwa-ads).

## 12. Instagram messaging rules

Why an Instagram DM bot is not a priority ([PRODUCT_PLAN.md §5.7](PRODUCT_PLAN.md#57-channels-instagram-and-others)):

| Rule | Value |
| --- | --- |
| Standard messaging window | 24 hours after the user's last message |
| After a click-to-Instagram-Direct ad | Longer window, reported as up to 7 days |
| Human Agent tag | Manual replies up to 7 days; needs App Review; support only, not sales pushes |
| Private replies (comment → DM) | One message per comment, within about 7 days; the chat continues only if the user replies |
| Paid templates to re-engage | None (unlike WhatsApp) |
| Escalation | Apps must offer a path to a human agent |
| Rate limit (private replies) | Reported as 750 calls/hour per account |

Use Instagram as a capture channel: one private reply that moves the lead to WhatsApp, where the sales loop, payment links and Conversions API live. Meta Business Agent also covers Instagram, so a full Instagram bot would be even less of an edge.

Sources: [Meta: Instagram Messaging](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/overview), [Meta: Private Replies](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/features/private-replies), [SetSmart: Instagram Messaging API](https://setsmart.io/blog/instagram-messaging-api), [Inro: 24-hour window](https://www.inro.social/glossary/24-hour-messaging-window).

## Sources

Official Meta: [Tech Provider onboarding](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider) · [Embedded Signup implementation](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation/) · [Coexistence onboarding](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users/) · [Throughput](https://developers.facebook.com/documentation/business-messaging/whatsapp/throughput) · [Quality webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/phone_number_quality_update) · [BSUID](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids/) · [Lead Ads webhooks](https://developers.facebook.com/documentation/ads-commerce/marketing-api/guides/lead-ads/quickstart/webhooks-integration) · [Conversion Leads CRM integration](https://developers.facebook.com/documentation/ads-commerce/conversions-api/conversion-leads-integration/crm-integration/2-getting-started-with-integration) · [CAPI for business messaging](https://developers.secure.facebook.com/docs/marketing-api/conversions-api/business-messaging/) · [Marketing Messages API](https://developers.facebook.com/documentation/business-messaging/whatsapp/marketing-messages/overview) · [Calling pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/pricing/)

Third-party: [360dialog ES versions](https://360dialog.com/blog/embedded-signup-versions-migration/) · [Chakra coexistence](https://chakrahq.com/article/whatsapp-business-app-api-coexistence-2026) · [YCloud coexistence](https://www.ycloud.com/blog/whatsapp-business-app-coexistence-meta-update) · [MyOperator pricing](https://myoperator.com/blog/whatsapp-business-api-pricing-india-2026) · [respond.io AI policy](https://respond.io/blog/whatsapp-chatbot-policy-2026) · [TechCrunch AI policy](https://techcrunch.com/2025/10/18/whatssapp-changes-its-terms-to-bar-general-purpose-chatbots-from-its-platform) · [Twilio BSUID](https://www.twilio.com/en-us/changelog/whatsapp-usernames--new-business-scoped-user-id--bsuid--field-re) · [Infobip calling](https://support.infobip.com/docs/whatsapp/whatsapp-business-calling/business-initiated-calling)

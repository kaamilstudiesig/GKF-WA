# Meta platform notes

What we learned about Meta's WhatsApp, Ads and Conversions APIs that shapes the product. Researched 30 Oct 2026. Meta changes things often, so **re-check the linked official page before building on any point**. Third-party sources are marked as such.

- [1. How a client gets connected](#1-how-a-client-gets-connected)
- [2. Pricing (India)](#2-pricing-india)
- [3. Limits](#3-limits)
- [4. AI policy](#4-ai-policy)
- [5. Usernames and BSUID (identity change)](#5-usernames-and-bsuid-identity-change)
- [6. Tokens and permissions (learned the hard way)](#6-tokens-and-permissions-learned-the-hard-way)
- [7. Features that fit the product](#7-features-that-fit-the-product)
- [8. Checklist before onboarding client #2](#8-checklist-before-onboarding-client-2)
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
| Marketing template | Promotions, win-back | **₹0.8631** |
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

## 5. Usernames and BSUID (identity change)

WhatsApp is rolling out **usernames** (from mid-2026) so users can hide their phone number. To support that, webhooks now include a **business-scoped user ID (BSUID)** in `user_id`. When a user has a username and no prior chat with the business, `wa_id` / `from` **may contain the BSUID instead of a phone number, or be missing**. A BSUID is different per business and changes if the user changes their number. ([Meta: business-scoped user IDs](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids/), [Twilio changelog](https://www.twilio.com/en-us/changelog/whatsapp-usernames--new-business-scoped-user-id--bsuid--field-re), [Chatwoot issue](https://github.com/chatwoot/chatwoot/issues/13837))

**Our code is affected:** `src/controllers/webhookController.js` strips every non-digit from the sender, and `leads.wa_id` (a phone number) is the primary key everywhere. Fix, top priority:

1. Store `user_id` (BSUID) on every inbound message and lead; keep the phone when present.
2. Give leads an internal id; make BSUID and phone unique lookups, not the primary key.
3. Send replies to whichever identifier Meta accepts for that user.
4. CRM shows "username user (phone hidden)" when there's no phone; click-to-call and phone-based features handle that case.

## 6. Tokens and permissions (learned the hard way)

**Incident, 30 Oct 2026:** a new system-user token was generated with only `catalog_management`. Meta applied that permission set to the system user's **other tokens too**, so the live bot token lost `whatsapp_business_messaging` and every reply failed (Graph error 100, subcode 33) for about 7 hours. Inbound webhooks kept arriving, so the bot looked healthy.

Rules:

- Any token for a system user must include **all** of: `whatsapp_business_messaging`, `whatsapp_business_management`, `catalog_management` (plus `business_management` if needed).
- Alert on send failures: a burst of outbound failures should page us (Telegram/Sentry), not wait for a client to notice.
- With Embedded Signup, each client gets its own business token, which removes this shared-token risk.

## 7. Features that fit the product

| Feature | What we use it for | Status (Oct 2026) |
| --- | --- | --- |
| **Click-to-WhatsApp ads** + referral data | Ad → chat; we store ad id, headline and `ctwa_clid` | Live on GKF |
| **Lead Ads webhook** (`leadgen` on the Page) | Form lead arrives in real time → WhatsApp them in seconds. Payload has only `leadgen_id`; fetch details with a Page token (`leads_retrieval`, `pages_manage_metadata`, `pages_show_list`, `pages_read_engagement`; needs App Review). Leads expire after 90 days, so poll as a backstop. ([Meta: Lead Ads webhooks](https://developers.facebook.com/documentation/ads-commerce/marketing-api/guides/lead-ads/quickstart/webhooks-integration)) | To build |
| **Conversion Leads goal + Conversions API for CRM** | Send lead stage changes (contacted, visited, joined) so Meta delivers ads to people who actually convert. The strongest optimisation loop for lead ads. ([Meta: CRM integration](https://developers.facebook.com/documentation/ads-commerce/conversions-api/conversion-leads-integration/crm-integration/2-getting-started-with-integration)) | To build |
| **Conversions API for business messaging** | Report lead/purchase against `ctwa_clid`. Meta says WhatsApp-ad delivery can't optimise on it yet, so it's reporting only. ([Meta](https://developers.secure.facebook.com/docs/marketing-api/conversions-api/business-messaging/)) | To build (cheap) |
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

## Sources

Official Meta: [Tech Provider onboarding](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider) · [Embedded Signup implementation](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation/) · [Coexistence onboarding](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users/) · [Throughput](https://developers.facebook.com/documentation/business-messaging/whatsapp/throughput) · [Quality webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/phone_number_quality_update) · [BSUID](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids/) · [Lead Ads webhooks](https://developers.facebook.com/documentation/ads-commerce/marketing-api/guides/lead-ads/quickstart/webhooks-integration) · [Conversion Leads CRM integration](https://developers.facebook.com/documentation/ads-commerce/conversions-api/conversion-leads-integration/crm-integration/2-getting-started-with-integration) · [CAPI for business messaging](https://developers.secure.facebook.com/docs/marketing-api/conversions-api/business-messaging/) · [Marketing Messages API](https://developers.facebook.com/documentation/business-messaging/whatsapp/marketing-messages/overview) · [Calling pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/pricing/)

Third-party: [360dialog ES versions](https://360dialog.com/blog/embedded-signup-versions-migration/) · [Chakra coexistence](https://chakrahq.com/article/whatsapp-business-app-api-coexistence-2026) · [YCloud coexistence](https://www.ycloud.com/blog/whatsapp-business-app-coexistence-meta-update) · [MyOperator pricing](https://myoperator.com/blog/whatsapp-business-api-pricing-india-2026) · [respond.io AI policy](https://respond.io/blog/whatsapp-chatbot-policy-2026) · [TechCrunch AI policy](https://techcrunch.com/2025/10/18/whatssapp-changes-its-terms-to-bar-general-purpose-chatbots-from-its-platform) · [Twilio BSUID](https://www.twilio.com/en-us/changelog/whatsapp-usernames--new-business-scoped-user-id--bsuid--field-re) · [Infobip calling](https://support.infobip.com/docs/whatsapp/whatsapp-business-calling/business-initiated-calling)

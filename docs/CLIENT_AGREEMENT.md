# Client agreement

What the Dartit Master Client Service Agreement promises, and which part of the product each promise depends on. Read this before changing something a client has been promised, and update the agreement when the product changes.

Two templates, both v2 (14 Nov 2026), built from the trimmed draft:

- [`legal/Dartit_Client_Agreement_India.docx`](legal/Dartit_Client_Agreement_India.docx): INR, GST and TDS, India's DPDP Act, Karnataka stamp duty, arbitration in Bengaluru.
- [`legal/Dartit_Client_Agreement_International.docx`](legal/Dartit_Client_Agreement_International.docx): fees in USD (or AED), export of services with the client handling its local VAT, the client's data protection laws (UAE PDPL, DIFC, ADGM, Saudi PDPL, GDPR) with a cross-border transfer clause, sanctions and language clauses, and arbitration in Bengaluru or Singapore (choose before sending).

Both are drafts. Have a lawyer review them before the first client signs: an Indian technology lawyer for both, plus a local lawyer for the international one where the client's law needs it. Prices are drafts too (see [PRODUCT_PLAN.md §9](PRODUCT_PLAN.md#9-pricing-to-validate)).

## How promises stay honest

- **Feature Dates (clause 3.4).** The agreement describes the full product. A feature that isn't live when a client signs goes in Schedule A with a target date. If it isn't delivered within 60 days of that date, the client can leave with a refund. So: only list a feature with a date you can keep, and check the table below before filling Schedule A.
- **Service levels (Annexure B) and safeguards (Annexure C1)** list only what we actually run. Don't add a target or a control until it exists.
- **Meta charges are the client's.** Each client owns its WhatsApp account and pays Meta directly. We never resell or mark up messages (we're a Tech Provider, see [META_PLATFORM.md](META_PLATFORM.md)).
- **Customer money never touches us.** Payment links are made in the client's own Razorpay account.

## What the agreement promises, and its status

Checked against the code on 14 Nov 2026. "Before signing" means it must be done before the first paying client signs, because the agreement promises it outright (not through a Feature Date).

| Promise | Clause | Status | Task |
| --- | --- | --- | --- |
| AI replies, qualification (hot, qualified, cold), handoff brief on staff WhatsApp | 3.1 | Built | |
| Lead queue, escalation, one-tap and AI-suggested outcomes, reminders, live pipeline, phone app | 3.1 | Built (R2/K19, R1, K13, R11/R11b, R3, R4) | |
| AI steps back when staff reply | 3.6 | Built | |
| Zoho CRM two-way sync | 3.2 | Built (K20) | |
| Payment links in the client's Razorpay account | 3.12 | Built (K11), INR only | |
| Conversions API signals | 3.2, 7.8 | Built (K7), not yet on in production | K7b |
| Revenue and ROAS per ad | 3.2 | Revenue per ad built (R6); spend and ROAS wait for K5 | K5 |
| The Analyser | 3.2 | Not built | K21 |
| Weekly reports | 3.2 | Not built | R7 |
| Agency dashboard across Workspaces | A2 | White-label per client built (R12); cross-client dashboard not built | R9 |
| Leads from website forms and portals | 3.3 | Contract agreed | R16 |
| Meta lead forms | 3.3 | Not built | K6 |
| Instagram DM capture (one reply that moves the lead to WhatsApp) | 3.3 | Not built | K32 |
| Connect the client's WhatsApp through Meta's signup flow | 3.5, 3.13 | Not built (manual setup today) | K9 |
| Amounts in the client's currency (international) | Schedule A | Contract agreed | R15 |
| Monthly lead count and 80% alert | 1 "Lead", 4.3 | Not built. **Before signing** | K26 |
| Uptime monitor and reply-time measurement | Annexure B | Not built. **Before signing** | K27 |
| Encrypted backups | C1 | Backups go to Telegram unencrypted today. **Before signing** | K28 |
| AI providers don't store or train on data | 7.7, C | Not configured. **Before signing** | K29 |
| STOP opt-out recorded, templates stop | 5.2 | Not built. **Before signing**, and before R16 sends templates | K30 |
| Owners export leads, conversations, outcomes and notes | 7.6, 12.5 | Lead CSV only. **Before signing** | R19 |
| Health-related businesses: medical questions go to staff | 5.9 | Not in the presets. Before signing a clinic | K33 |
| Automatic deletion after the retention period | 7.6, C | Not built. Before 13 May 2027 (DPDP); until then list it with a Feature Date | K31 |
| 2FA on our hosting, GitHub, Meta and AI admin accounts | C1 | Settings, not code. **Before signing** | Ops |
| Support email and WhatsApp support number | B2 | Not set up. **Before signing** | Ops |
| Breach notice within 24 hours | 7.5 | Runbook in [OPERATIONS.md](OPERATIONS.md#data-breach) | |
| Hosting region listed in Annexure C | C | Heroku EU today; move off student credits before charging a client ([PRODUCT_PLAN.md §8](PRODUCT_PLAN.md#8-cost-plan)) | Ops |

## Left out on purpose

Dropped from the trimmed draft because they don't fit the product or aren't worth building now:

- **Prepaid wallet with a 10% charge on Meta messages.** It contradicts the Tech Provider model (the client pays Meta directly) and would need a billing system.
- **Several WhatsApp numbers per Workspace.** One number per Workspace; a second number is a second Workspace.
- **Other CRMs in the standard plans** (HubSpot, Salesforce and so on). Zoho only; others by written quote, built as K22 when a client needs one.
- **24x7 support and a 2-hour critical response.** Two people can't staff it; targets are in business hours.
- **A full Instagram DM bot.** Instagram can't re-engage leads and has no phone number for sales, so we only capture and move to WhatsApp ([PRODUCT_PLAN.md §5.7](PRODUCT_PLAN.md#57-channels-instagram-and-others)).
- **Automated billing (R10)** and **2FA inside the CRM (R20).** Manual invoices are fine for the first clients; CRM 2FA comes when an agency's security review asks for it. Neither is promised.

## Filling it in for a client

1. Pick the India or International template.
2. Schedule A: plan, term (pilots: 3 months, not committed), Workspaces, lead sources, CRM, payment gateway, and **every included feature not live yet with its Feature Date** (use the table above).
3. Annexure C: confirm the hosting region and AI providers as they are that day, and the privacy contacts.
4. Health-related business: tick it in Schedule A only once K33 is done.
5. International: choose the arbitration seat in clause 13, the currency and prices in Schedule A.
6. Remove the drafting note under the title.

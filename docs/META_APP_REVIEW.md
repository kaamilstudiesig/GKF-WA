# Meta App Review: Tech Provider

Step-by-step for getting **Advanced access** to `whatsapp_business_messaging` and `whatsapp_business_management`, the last step to become a WhatsApp Tech Provider. Business verification for the app's business portfolio is already approved.

App: **Goldkraft Fitness** (App ID `4690351227913482`), business portfolio `1811197356702097` (legal name Goldkraft Fitness). Owner context: GKF's owner is part of the startup, so the Tech Provider status sits with this portfolio for now. If the startup later gets its own company, we repeat App Review on a new app under it.

## Before you submit (5 minutes)

App Dashboard → **App settings → Basic**:

| Field | Value |
| --- | --- |
| App icon | Already set (GKF logo, 1024×1024) |
| Category | **Business and pages** |
| Privacy Policy URL | `https://wa.goldkraftfitness.com/privacy` |
| Terms of Service URL | `https://wa.goldkraftfitness.com/terms` |
| User data deletion | Choose **Data deletion instructions URL**: `https://wa.goldkraftfitness.com/data-deletion` |
| App domains | `goldkraftfitness.com` |
| Contact email | an inbox you check |

Open each URL in a browser first; Meta rejects dead links.

Then on the **Become Tech Provider** page, check **App Review → Requests** in the left sidebar. If an old request is stuck "In review" without videos, let it finish (or cancel it if Meta allows) and submit a fresh one.

## Video 1: `whatsapp_business_messaging`

Goal: show **our app** sending a message and **WhatsApp receiving it**, in one take. 30-60 seconds, no audio needed, 1080p, mp4.

Setup: browser window on the left with the CRM (`https://crm.goldkraftfitness.com`), WhatsApp Web (or your phone mirrored) on the right, logged in on a phone that has messaged the GKF number in the last 24 hours (send it "hi" just before recording).

1. Show the CRM address bar and log in (or start already logged in on the dashboard).
2. Open **Leads**, click the test lead (your test phone).
3. Type in the reply box: `Hi! This is a test message sent from the Goldkraft Fitness CRM through the WhatsApp Business Platform.` Click **Send**.
4. Keep both windows visible until the message appears in WhatsApp on the right. Pause 3 seconds.
5. Optional: reply from WhatsApp ("Got it") and show it appear in the CRM chat after a refresh.

## Video 2: `whatsapp_business_management`

We recorded this with `node scripts/create-template.js trial_reminder` (creates a template through the Cloud API, never prints the token) next to WhatsApp Manager showing the new template. Submitted 30 Oct 2026.


Goal: show creating a message template. Meta accepts doing it in **WhatsApp Manager**. 60-90 seconds.

1. Open **business.facebook.com → WhatsApp Manager → Account tools → Message templates** (show the address bar).
2. **Create template** → Category **Utility** → name `trial_confirmation` → language **English**.
3. Body: `Hi {{1}}, your trial at Goldkraft Fitness is booked for {{2}}. Reply here if you need to change the time.` Add sample values (`Rahul`, `Saturday 7 AM`).
4. **Submit**. Show the template in the list with status *In review* or *Active*.

This template is useful later for confirming trial bookings, so it isn't wasted.

## Permission descriptions (paste into the form)

**whatsapp_business_messaging**

> Our app is a WhatsApp lead-response and CRM platform for local businesses, starting with gyms. When a prospective customer messages a business's WhatsApp number (often after clicking a Facebook or Instagram ad), our app receives the message by webhook, replies within seconds with information about that business (prices, timings, location) and qualifies the enquiry. When a person is needed, the business's staff reply from our CRM, and our app sends those replies through the WhatsApp Business Platform. We need advanced access to send these messages on behalf of the client businesses that connect their WhatsApp Business Accounts to our app. We only message users who have contacted the business, inside the customer service window, or with approved templates.

**whatsapp_business_management**

> Client businesses connect their WhatsApp Business Accounts to our app through Embedded Signup. We need advanced access to: read each client's WhatsApp Business Account and phone numbers to complete onboarding, register the phone number and subscribe our app to its webhooks; read phone number status, quality rating and messaging limits so we can alert the business when there is a problem; and create and manage message templates (for example trial booking confirmations and follow-ups) on the client's behalf. We only access the WhatsApp assets a client explicitly shares with us during Embedded Signup.

## Submit

1. On **Become Tech Provider → App Review**, click **Onboard without a partner** if asked.
2. Request **Advanced access** for both permissions, upload the matching video, paste the description, and tick the confirmations.
3. **Begin App Review / Submit**.

Typical turnaround is a few days to two weeks. If rejected, paste Meta's message into an issue or chat; the usual fixes are a clearer video (both screens visible, message arriving) or a privacy policy URL that loads.

## After approval

- The app can manage WhatsApp accounts that other businesses share with it.
- Next build steps: Embedded Signup (Facebook Login for Business configuration → code → business token → register number → subscribe webhooks), tracked as task K9 in [TEAM.md](TEAM.md). Meta's [sample Tech Provider app](https://github.com/fbsamples/business-messaging-sample-tech-provider-app) (MIT) shows the full flow in Next.js; we'll implement the same steps in our Express app.
- Upgrade to **Tech Partner** later (needs ≥2,500 messages/day, ≥10 monthly active customers, quality ≥90%).

# Architecture

How the system works today, and the architecture we are moving to. **Lead Engine** is a working name for the product. The first client, Goldkraft Fitness (GKF), is the live pilot.

- [1. The idea in one picture](#1-the-idea-in-one-picture)
- [2. What runs today](#2-what-runs-today)
- [3. Life of a WhatsApp message](#3-life-of-a-whatsapp-message)
- [4. How the bot decides a reply](#4-how-the-bot-decides-a-reply)
- [5. Data model](#5-data-model)
- [6. Code map](#6-code-map)
- [7. Design rules we keep](#7-design-rules-we-keep)
- [8. Target architecture (multi-client)](#8-target-architecture-multi-client)
- [9. Known gaps](#9-known-gaps)

---

## 1. The idea in one picture

Marketing agencies run Meta ads for local businesses (gyms first). Leads come in on WhatsApp or through lead forms. An AI answers in seconds and qualifies them. Hot leads go to a salesperson with a timer. Every outcome (contacted, visited, joined + ₹) is recorded and sent back to Meta so the ads learn who actually buys.

```mermaid
flowchart LR
  subgraph Marketing["Marketing (agency)"]
    A1[Click-to-WhatsApp ads]
    A2[Lead Ads forms]
  end
  subgraph Engine["Lead Engine"]
    B[AI front desk<br/>answers in seconds, qualifies]
    C[Sales floor<br/>assign, 5-min timer, outcomes]
    D[(Lead + outcome data)]
    E[Owner & agency analytics]
  end
  subgraph Meta["Meta platform"]
    M1[WhatsApp Cloud API]
    M2[Conversions API]
    M3[Marketing API<br/>spend, audiences]
  end
  A1 --> M1 --> B
  A2 -->|leadgen webhook| B
  B -->|hot lead| C
  B --> D
  C --> D
  D --> E
  D -->|lead / visit / purchase events| M2
  M3 -->|ad spend| E
  M2 -.->|better targeting| A2
```

## 2. What runs today

One Node.js process serves both the WhatsApp bot and the staff CRM, chosen by the request's hostname. One Postgres database holds everything. It runs on Heroku: one Basic dyno + Postgres Essential-0, about $12/month.

```mermaid
flowchart TB
  Lead((Lead on WhatsApp)) <--> Meta[Meta WhatsApp Cloud API]
  Meta -->|POST /webhook<br/>signed| Router
  Staff((Staff browser / phone)) -->|crm.goldkraftfitness.com| Router

  subgraph Heroku["Heroku: one dyno, one Node process"]
    Router{Host header router<br/>src/app.js}
    Router -->|wa.* host| Bot[Bot routes<br/>/webhook, /health]
    Router -->|CRM_HOSTS| CRM[Staff CRM<br/>crm/ Express + EJS]
    Bot --> InQ[Inbound worker<br/>x3]
    OutQ[Outbound worker<br/>x2]
  end

  InQ --> AI[OpenRouter<br/>DeepSeek V4.1 Flash<br/>fallback Gemini 3.5 Flash Lite]
  OutQ --> Meta
  InQ --> TG[Telegram staff alerts]
  Heroku <--> PG[(Heroku Postgres<br/>bot tables + crm_ tables)]
  Heroku --> Sentry[Sentry errors]
```

| Piece | Where | Notes |
| --- | --- | --- |
| Webhook + queues | `src/controllers`, `src/workers`, `src/db` | Postgres-backed queues, `FOR UPDATE SKIP LOCKED`, retries with backoff, dead letters |
| Reply logic | `src/services` | Safety check → fixed answers → AI, plus guards (pause, caps, budget) |
| Staff CRM | `crm/` | Roles owner/manager/sales, chat, pipeline, notes, follow-ups, reports, CSV |
| Business facts + AI prompt | `src/config/gymConfig.js` | **GKF-specific today**; moves to the database for multi-client |
| Migrations | `src/db/schema.js`, `crm/src/migrations.js` | Run in Heroku's release phase and on boot, under advisory locks |
| Backups | Heroku PG daily schedule + `scripts/backup.js` to Telegram | |

## 3. Life of a WhatsApp message

```mermaid
sequenceDiagram
  autonumber
  participant L as Lead
  participant M as Meta Cloud API
  participant W as POST /webhook
  participant Q as webhook_events (queue)
  participant I as Inbound worker
  participant AI as OpenRouter
  participant O as outbound_messages (queue)
  participant S as Outbound worker
  participant T as Telegram

  L->>M: "fees kitni hai?"
  M->>W: webhook (X-Hub-Signature-256)
  W->>W: verify signature
  W->>Q: insert event (dedup on message id)
  W-->>M: 200 OK (fast, before any AI work)
  I->>Q: claim next event (one per lead at a time)
  I->>I: save lead + message, read receipt + typing
  I->>I: guards: staff pause? daily cap?
  alt fixed answer matches
    I->>I: fixed reply + buttons (no AI cost)
  else needs AI
    I->>AI: one call, JSON {reply, lead, notify_staff}
    AI-->>I: reply + lead updates
  end
  opt hand-off needed
    I->>T: alert with "Open in CRM"
  end
  I->>O: enqueue reply (dedup key reply:<msg id>)
  S->>O: claim
  S->>M: send text / buttons / location pin
  M-->>L: reply
```

Why two queues: Meta needs a quick `200` or it retries, and AI calls take 1-3 seconds. Saving first and answering later means no lost messages on crashes, deploys or AI outages. Both queues are plain Postgres tables, so there's no extra service to pay for.

## 4. How the bot decides a reply

```mermaid
flowchart TD
  In[Inbound message] --> G1{Staff replied<br/>in last 12h?}
  G1 -->|yes| Quiet[Stay quiet,<br/>alert staff on Telegram]
  G1 -->|no| G2{Bot replies to this<br/>lead in 24h}
  G2 -->|over cap| Quiet2[Stay quiet]
  G2 -->|at cap| Last[One polite last reply<br/>+ hand-off]
  G2 -->|under cap| Med{Injury / medical?}
  Med -->|yes| Safe[Fixed safe reply<br/>+ hand-off]
  Med -->|no| Fixed{Fixed answer?<br/>greeting, price, hours,<br/>location, trial, human,<br/>complaint · EN/Hinglish/Kannada}
  Fixed -->|yes| FR[Fixed reply + buttons<br/>₹0]
  Fixed -->|no| Bud{Monthly AI<br/>budget left?}
  Bud -->|no| Staff[Hand to staff]
  Bud -->|yes| AI[AI: one call<br/>~₹0.03 per reply]
  AI --> Clean[Strip dashes, markdown,<br/>leaked markup]
```

Cost levers, in order of impact: fixed answers (free), one AI call per reply instead of two, a stable prompt prefix that the provider caches (DeepSeek bills cached input at 0.1×), short history (10 messages), and hard caps per lead and per month.

## 5. Data model

Bot tables are owned by `src/db/schema.js`; CRM tables (prefixed `crm_`) by `crm/src/migrations.js`. A lead's key is `wa_id`: its phone number, or Meta's business-scoped user ID (BSUID) when the user hides their phone behind a WhatsApp username. `phone`, `user_id` and `username` hold whatever Meta has shared.

```mermaid
erDiagram
  leads ||--o{ messages : has
  leads ||--o{ handoffs : has
  leads ||--o{ outbound_messages : "replies to"
  leads ||--o| crm_lead_assignments : "assigned via"
  leads ||--o{ crm_lead_notes : has
  leads ||--o{ crm_follow_ups : has
  leads ||--o{ crm_lead_outcomes : has
  crm_users ||--o{ crm_lead_outcomes : logs
  crm_users ||--o{ crm_lead_assignments : owns
  crm_users ||--o{ crm_follow_ups : does
  crm_users ||--o{ crm_sessions : "logs in"
  crm_users ||--o{ crm_activity_log : "acts in"

  leads {
    text wa_id PK "lead key: phone, or BSUID if hidden"
    text phone "when Meta shares it"
    text user_id UK "Meta business-scoped user ID"
    text display_name
    text status "new..converted/lost"
    text interest
    text source "whatsapp_inbound / instagram_ad / facebook_ad"
    bool needs_human
    jsonb metadata "ad referral, ctwa_clid"
  }
  messages {
    int id PK
    text message_id UK
    text direction "in/out"
    text text
  }
  handoffs {
    int id PK
    text status "pending/assigned/resolved"
    text reason
    text assigned_to
  }
  outbound_messages {
    int id PK
    text dedup_key UK
    text status "pending/sending/sent/failed"
    jsonb metadata "buttons, location, source=crm"
  }
  webhook_events {
    int id PK
    text event_key UK
    jsonb payload
    text status
  }
  ai_usage {
    int id PK
    text model
    float cost_usd
    int input_tokens
  }
  crm_lead_outcomes {
    int id PK
    text outcome "called..joined/lost"
    int amount_inr "when joined"
    text lost_reason
    timestamptz visit_at
  }
  crm_users {
    int id PK
    text email
    text role "owner/manager/sales"
  }
```

## 6. Code map

```
src/
  app.js                 Express app; Host router (bot vs CRM), https redirect
  server.js              boot: migrations, workers, graceful shutdown
  config/env.js          every setting, from environment variables
  config/gymConfig.js    GKF facts + AI system prompt (per-client data later)
  controllers/           webhook verify + receive
  middleware/            signature check, rate limit
  workers/               queueWorker base, inbound (webhookWorker), outbound
  services/
    deterministicRouter  fixed answers, language detection, buttons
    aiService            prompt building, OpenRouter call, JSON parsing, cleanup
    aiPolicy             what the AI may change; medical safety check
    botGuard             staff pause + per-lead daily cap
    leadUpdates          applies updates, opens hand-offs
    adAttribution        click-to-WhatsApp referral → lead source
    notifyService        Telegram alerts
    whatsappService      Cloud API sends (text, buttons, location), read receipts
    aiCostTracker        usage + monthly budget
  db/                    pg/PGlite driver, schema, repositories
crm/                     staff CRM (Express + EJS), mounted by src/app.js
scripts/                 migrate, backup/restore, demo data, model eval
test/                    node:test on in-memory PGlite; test/crm for the CRM
docs/                    you are here
```

## 7. Design rules we keep

1. **Answer Meta fast, work later.** The webhook only verifies and stores. All real work happens in queue workers.
2. **Every side effect is idempotent.** Dedup keys on inbound events and outbound replies, so retries and redeploys never double-send.
3. **Postgres is the only infrastructure.** Queues, sessions, locks and data all live in one database until scale proves otherwise.
4. **Free before paid.** Fixed answers and buttons first, AI second, staff third. One AI call per reply. Hard budgets.
5. **The AI proposes, policy decides.** The model can suggest lead updates; `aiPolicy` decides what's allowed (it can't mark a lead converted or clear a hand-off).
6. **Never invent facts.** The prompt only knows the business profile. Anything else gets "a coach will confirm".
7. **Tests never touch real services.** In-memory PGlite and fake transports. Paid model checks are opt-in scripts.

## 8. Target architecture (multi-client)

What changes when we serve many businesses from one deployment. See [PRODUCT_PLAN.md](PRODUCT_PLAN.md) for when.

```mermaid
flowchart TB
  subgraph Clients["Each client business"]
    WABA1[Client A WhatsApp number<br/>owned by client]
    WABA2[Client B WhatsApp number]
    Page[Client Facebook Page<br/>Lead Ads]
  end
  subgraph Onboard["Onboarding"]
    ES[Embedded Signup v4<br/>incl. coexistence]
    Wiz[Business profile wizard<br/>hours, prices, FAQs, languages]
  end
  WABA1 & WABA2 -->|one app webhook| Hook[Webhook API<br/>route by phone_number_id → tenant]
  Page -->|leadgen webhook| Hook
  ES -->|business token, encrypted| DB
  Wiz --> DB
  Hook --> Q[(Queues with tenant_id<br/>fair per-tenant claiming)]
  Q --> Bot[Bot workers<br/>per-tenant prompt, FAQs, budgets]
  Bot --> Floor[Sales floor<br/>SSE live board, PWA]
  Bot & Floor --> DB[(Postgres<br/>tenant_id on every row<br/>+ row-level security)]
  DB --> CAPI[Conversions API<br/>per tenant dataset]
  Spend[Marketing API<br/>ad spend per tenant] --> DB
  DB --> Dash[Owner dashboard<br/>Agency dashboard, white-label]
```

Key decisions:

- **Tenant = one business.** Every table gets `tenant_id`; Postgres row-level security makes cross-tenant leaks impossible even with a buggy query.
- **Routing by `phone_number_id`.** All clients' WhatsApp numbers point at one webhook; the payload's `metadata.phone_number_id` picks the tenant.
- **Secrets per tenant**, encrypted in the database (business tokens from Embedded Signup), never in environment variables.
- **Business profile in the database** replaces `gymConfig.js`. The prompt and fixed answers are generated from it. Vertical packs (gym, clinic, salon, coaching, real estate) give defaults.
- **Lead identity:** matched by BSUID first, then phone; send to the phone when known, else to the BSUID (done, see [META_PLATFORM.md](META_PLATFORM.md#5-usernames-and-bsuid-identity-change)). With tenants, BSUIDs are per business portfolio, so the lookup is per tenant.
- **Fair queues.** One client's ad spike must not delay others: claim work round-robin across tenants, and keep per-tenant AI budgets and caps.
- **Same stack until ~50 clients.** One app, one Postgres, more dynos. Move hosting to an India region when the first paying non-GKF client signs.

## 9. Known gaps

Ordered by risk; owners and timing are in [PRODUCT_PLAN.md](PRODUCT_PLAN.md) and [TEAM.md](TEAM.md).

| Gap | Why it matters |
| --- | --- |
| Single tenant (GKF facts in code, one number) | Can't onboard client #2 without code changes. |
| No speed-to-lead timer or live board (outcomes are logged since R1) | Hot leads can sit unanswered unnoticed. |
| No templates for leads outside the 24h window | Can't win back no-shows and quiet leads. |
| No Lead Ads webhook / Conversions API | Missing the strongest Meta optimisation loop. |
| One dyno in the EU, student credits | Not suitable for paying clients' data or uptime. |

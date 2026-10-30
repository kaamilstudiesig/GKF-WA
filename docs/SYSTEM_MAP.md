# GKF Lead Engine: system map

This file shows how the system works, from the ad to the server.
The text uses ASD-STE100 Simplified Technical English: short sentences, active voice, one idea in each sentence.

## 1. The full loop

A person sees an ad. The person sends a WhatsApp message. The bot replies. Staff follow up. Staff log the result. The system can send the result back to Meta.

```mermaid
flowchart LR
  A["Meta ad: click to WhatsApp"] --> B["Person sends WhatsApp message"]
  B --> C["Bot replies in seconds"]
  C --> D{"Lead is ready or needs a person?"}
  D -- "No" --> C
  D -- "Yes" --> E["Telegram alert to staff"]
  E --> F["Staff open lead in CRM"]
  F --> G["Staff call or reply"]
  G --> H["Staff log outcome"]
  H --> I["Automatic follow-up task"]
  H --> J["Conversions API: event to Meta (on hold)"]
  J --> A
```

## 2. Infrastructure

One Heroku app runs everything. One Postgres database keeps all data.

```mermaid
flowchart TB
  subgraph Meta["Meta"]
    WA["WhatsApp Cloud API"]
    CAPI["Conversions API (on hold)"]
    CAT["Catalog: Pricing"]
  end
  subgraph Heroku["Heroku app gkf-wa (EU, Basic dyno)"]
    WEB["web process: src/server.js"]
    REL["release phase: scripts/migrate.js"]
    PG[("Postgres essential-0")]
  end
  OR["OpenRouter: DeepSeek V4.1 Flash, fallback Gemini 3.5 Flash Lite"]
  TG1["Telegram staff group"]
  TG2["Telegram ops group"]
  SEN["Sentry"]
  STAFF["Staff phone or laptop"]

  WA -- "webhook POST" --> WEB
  WEB -- "send message" --> WA
  WEB -- "one call per AI reply" --> OR
  WEB -- "lead alerts" --> TG1
  WEB -- "error alerts" --> TG2
  WEB -- "exceptions" --> SEN
  WEB -. "events, when enabled" .-> CAPI
  WEB <--> PG
  REL --> PG
  STAFF -- "crm.goldkraftfitness.com" --> WEB
```

| Part | Job | Cost |
| --- | --- | --- |
| Heroku dyno | Runs bot, CRM and workers in one process | Student credit |
| Heroku Postgres | Keeps leads, messages, queues, CRM data | Student credit |
| OpenRouter | AI replies | About $0.31 for 1,000 replies |
| Meta WhatsApp | Sends and receives messages | Service replies free in 24 h window |
| Telegram, Sentry | Alerts | Free |

## 3. Host routing

One Express app reads the host name. The host name selects the bot or the CRM.

```mermaid
flowchart TD
  R["HTTPS request"] --> H{"HTTPS?"}
  H -- "No, GET" --> RD["301 redirect to HTTPS"]
  H -- "No, POST" --> X["403"]
  H -- "Yes" --> C{"Host in CRM_HOSTS?"}
  C -- "Yes" --> CRM["CRM app: EJS pages, sessions, CSRF"]
  C -- "No" --> BOT["Bot app"]
  BOT --> W["/webhook: Meta"]
  BOT --> L["/privacy, /terms, /data-deletion"]
  BOT --> HE["/health"]
```

## 4. Inbound message: from WhatsApp to reply

The webhook saves the event first. A worker does the slow work later. Thus Meta always gets a fast 200.

```mermaid
sequenceDiagram
  participant P as Person
  participant M as Meta WhatsApp
  participant W as Webhook
  participant Q as webhook_events table
  participant K as Webhook worker
  participant A as OpenRouter
  participant O as outbound_messages table
  participant S as Outbound worker
  P->>M: Message
  M->>W: POST /webhook (signed)
  W->>W: Check signature
  W->>Q: Save event
  W-->>M: 200 OK
  K->>Q: Claim next event (SKIP LOCKED)
  K->>K: Save lead and message
  K->>K: Decide reply
  opt No fixed answer
    K->>A: One AI call
    A-->>K: JSON reply, lead fields, notify flag
  end
  K->>O: Queue reply
  S->>O: Claim next reply
  S->>M: Send message
  M->>P: Reply
```

## 5. Reply decision

The worker tries the cheap paths first. The AI is the last step.

```mermaid
flowchart TD
  IN["New message"] --> G{"Staff replied in last 12 h?"}
  G -- "Yes" --> Q1["Save message. No reply. Alert staff."]
  G -- "No" --> CAP{"30 bot replies today?"}
  CAP -- "Yes" --> Q2["Save message. No reply. Hand off."]
  CAP -- "No" --> T{"Text message?"}
  T -- "No" --> FB["Fallback: please send text"]
  T -- "Yes" --> MED{"Medical or injury words?"}
  MED -- "Yes" --> MD["Safe disclaimer + hand off"]
  MED -- "No" --> FX{"Fixed answer matches? EN, Hinglish, Kannada"}
  FX -- "Yes" --> FA["Fixed reply + buttons or map pin"]
  FX -- "No" --> AI["AI reply from business profile prompt"]
  AI --> N{"notify_staff?"}
  N -- "Yes" --> HO["Hand-off + Telegram alert"]
  N -- "No" --> SEND["Queue reply"]
  FA --> SEND
  MD --> SEND
  HO --> SEND
```

Fixed answers: greeting, hours, location, prices, trial, human, complaint, negotiation, data deletion.

## 6. Outbound send and errors

```mermaid
flowchart TD
  Q["outbound_messages: queued"] --> S["Outbound worker sends"]
  S --> R{"Meta accepts?"}
  R -- "Yes" --> OK["Mark sent"]
  R -- "No, can retry" --> RT["Retry later"]
  R -- "No, final" --> F["Mark failed"]
  F --> OA["opsAlerts: classify Meta error"]
  OA --> CD{"Same alert in last 30 min?"}
  CD -- "No" --> TG["Telegram ops group"]
  CD -- "Yes" --> SK["Skip alert"]
  ST["Meta status webhook: failed"] --> OA
  AC["Meta account webhook: ban, quality, limit"] --> OA
```

## 7. Lead identity

Meta now can hide phone numbers behind usernames (BSUID). The system keeps one key for each person.

```mermaid
flowchart TD
  WH["Webhook contact"] --> P{"Phone number present?"}
  P -- "Yes" --> K1["wa_id = phone"]
  P -- "No" --> K2["wa_id = BSUID"]
  K1 --> L["leads row"]
  K2 --> L
  CH["Meta: user changed number"] --> MV["applyIdChange: move lead to new key"]
  MV --> L
  L --> SND{"Send target"}
  SND -- "phone" --> TO["to"]
  SND -- "BSUID" --> RC["recipient"]
```

## 8. CRM roles and screens

```mermaid
flowchart LR
  LOGIN["Login"] --> DASH["Home dashboard"]
  DASH --> LEADS["Leads list"]
  DASH --> FU["Follow-ups"]
  DASH --> PIPE["Pipeline board"]
  DASH --> MORE["More"]
  LEADS --> LEAD["Lead page: Chat, Details, Notes and tasks, History"]
  PIPE --> LEAD
  FU --> LEAD
  MORE --> REP["Reports: owner, manager"]
  MORE --> USR["Users: owner"]
  MORE --> SET["Business settings: owner"]
```

| Role | Sees leads | Reports | Users | Business settings |
| --- | --- | --- | --- | --- |
| Owner | All | Yes | Yes | Yes |
| Manager | Own team | Yes | Own team | No |
| Sales | Own leads | No | No | No |

## 9. Lead page and outcomes

Staff log one outcome. The system makes the next task.

```mermaid
flowchart TD
  TGB["Telegram button: Log outcome"] --> LP["Lead page: outcome sheet"]
  LP --> O{"Outcome"}
  O -- "Called, spoke" --> R1["Resolve hand-off. Status contacted."]
  O -- "No answer" --> NA["Follow-up ladder"]
  O -- "WhatsApp sent" --> R1
  O -- "Visit booked" --> VB["Ask visit time. Task before visit."]
  O -- "Visited" --> VI["Task: ask to join"]
  O -- "No-show" --> NS["Task: rebook"]
  O -- "Joined" --> JO["Ask plan and amount. Status converted."]
  O -- "Lost" --> LO["Ask reason. Status lost."]
  NA --> L1["Try 1: in 2 h"] --> L2["Try 2: in 24 h"] --> L3["Try 3: in 72 h"] --> L4["Then weekly"]
```

## 10. Pipeline board

The columns show the sales journey. The stage comes from status and the latest visit outcome.

```mermaid
stateDiagram-v2
  [*] --> New
  New --> Contacted
  Contacted --> VisitBooked: needs visit time
  VisitBooked --> Visited
  Visited --> Joined: needs plan and amount
  New --> Lost: needs reason
  Contacted --> Lost
  VisitBooked --> Lost
  Visited --> Lost
  Joined --> [*]
```

Desktop: drag the card. Phone: swipe columns and tap Move. Sales can move only their own leads.

## 11. Conversions API (on hold)

This part is off. It starts after the GKF Instagram page connects.

```mermaid
flowchart LR
  O["Outcome logged"] --> E{"Type"}
  E -- "Visit booked" --> QL["QualifiedLead"]
  E -- "Joined" --> PU["Purchase, INR amount"]
  QL --> M["Match: ctwa_clid from ad, or hashed phone + page id"]
  PU --> M
  M --> W["conversionsWorker: send once, max 5 tries, last 7 days"]
  W --> D["Meta dataset 2719553478516604"]
  D --> AD["Meta optimises ads for real buyers"]
```

## 12. Business profile

The owner edits the business facts in the CRM. The bot reads them. No deploy is necessary.

```mermaid
flowchart LR
  OW["Owner: /settings"] --> V["normalize + limits"]
  V --> DB[("business_profile")]
  DB --> RF["businessProfile.startRefresh"]
  RF --> GC["gymConfig live view"]
  GC --> SP["AI system prompt"]
  GC --> FA["Fixed answers: hours, prices, location, map pin"]
  VE["verticals.js: gym pack"] --> SP
```

## 13. Data model

```mermaid
erDiagram
  leads ||--o{ messages : has
  leads ||--o{ handoffs : has
  leads ||--o{ crm_lead_outcomes : has
  leads ||--o{ crm_tasks : has
  leads ||--o{ crm_notes : has
  crm_users ||--o{ leads : "assigned to"
  crm_users ||--o{ crm_lead_outcomes : logs
  webhook_events }o--|| leads : "creates or updates"
  outbound_messages }o--|| leads : "sends to"
  business_profile ||--o{ leads : "configures bot for"
```

## 14. Build and deploy

```mermaid
flowchart LR
  BR["Feature branch"] --> PR["Pull request"]
  PR --> CI["GitHub Actions: tests on PGlite"]
  CI -- "green" --> MG["Merge to main"]
  MG -- "only on your go-ahead" --> HK["git push heroku"]
  HK --> BLD["Build: npm ci + build:css"]
  BLD --> RL["Release: migrations"]
  RL --> UP["New dyno starts. Workers start."]
```

## 15. Process start

```mermaid
flowchart TD
  S["node src/server.js"] --> M["Run migrations"]
  M --> U["Ensure CRM users"]
  U --> BP["Load business profile + refresh timer"]
  BP --> WK["Start webhook worker + outbound worker"]
  WK --> CV{"CAPI enabled?"}
  CV -- "Yes" --> CW["Start conversions worker"]
  CV -- "No" --> HS["Start housekeeping"]
  CW --> HS
  HS --> L["Listen on PORT"]
```

## 16. Next: K8 multi-client

Today one database serves one business. K8 adds a business id to each table. One app then serves many gyms through agencies.

```mermaid
flowchart TB
  AG["Marketing agency"] --> B1["Gym A"]
  AG --> B2["Gym B"]
  B1 --> N1["WhatsApp number A"]
  B2 --> N2["WhatsApp number B"]
  N1 --> APP["One Lead Engine app"]
  N2 --> APP
  APP --> R{"phone_number_id to business_id"}
  R --> DB[("Postgres: every row has business_id")]
  APP --> CRM["CRM: each user sees only their business"]
```

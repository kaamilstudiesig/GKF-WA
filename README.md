# Goldkraft Fitness — WhatsApp AI Lead-Management Backend

A robust, production-ready Node.js backend connecting WhatsApp (via Meta's Cloud API v23.0) to an AI sales & qualification agent (via OpenRouter) that handles inbound gym leads for **Goldkraft Fitness** (JP Nagar, Bengaluru), replies conversationally in Goldkraft's confident brand voice, and stores structured CRM lead data in SQLite.

---

## System Architecture

```
                    +-----------------------------+
                    |  WhatsApp User (Lead)       |
                    +--------------+--------------+
                                   |
                             WhatsApp Message
                                   v
                    +-----------------------------+
                    |  Meta WhatsApp Cloud API    |
                    +--------------+--------------+
                                   |
                  POST /webhook    |   POST /v23.0/<PHONE_ID>/messages
                  (HMAC Verified)  |   (Outbound Reply)
                                   v
+-----------------------------------------------------------------------+
|  Goldkraft Backend (Node.js + Express)                                |
|                                                                       |
|  1. Webhook Verification & HMAC-SHA256 Security Signature Check      |
|  2. Message Deduplication (by wamid)                                  |
|  3. Lead Storage & 24-Hr Customer Service Window Tracking (DAL)       |
|  4. OpenRouter AI Processing (Dual Tool Calling + JSON Delimiters)    |
|  5. Lead Qualification & Human Staff Handoff Triggers                 |
|                                                                       |
|  +--------------------------------+   +----------------------------+  |
|  | OpenRouter AI API              |   | SQLite Lead CRM (DAL)      |  |
|  | (Gemini / Gemma / Free Router) |   | (leads & messages tables)  |  |
|  +--------------------------------+   +----------------------------+  |
+-----------------------------------------------------------------------+
                                   |
                    +--------------+--------------+
                    | CRM / Dashboard API         |
                    | GET /leads                  |
                    | GET /leads/:wa_id           |
                    +-----------------------------+
```

---

## Features

- **Meta Cloud API v23.0 Integration**:
  - `GET /webhook` verification handshake (`hub.mode`, `hub.verify_token`, `hub.challenge`).
  - `POST /webhook` inbound message ingestion with cryptographic `X-Hub-Signature-256` HMAC-SHA256 signature verification.
  - Message deduplication by `message_id` (`wamid`) to prevent duplicate replies on Meta webhooks retries.
  - Graceful handling of delivery receipts (`statuses`) and non-text media messages (`image`, `audio`, `video`, etc.).
- **24-Hour Customer Service Window Engine**:
  - Automatically calculates and exposes `window_open` per lead based on `last_inbound_message_at`.
- **OpenRouter AI Agent (Goldkraft Fitness Persona)**:
  - System prompt containing gym specs (10,000 sq ft, JP Nagar), programs (CrossFit, Hypertrophy, PT, Yoga), hours, and verified membership pricing (Monthly ₹4,040, Quarterly ₹7,080, 6-Month ₹10,640, Annual ₹14,000).
  - **Dual Extraction Pattern**: OpenAI function calling (`save_lead`, `notify_staff`) with fallback parsing for delimited JSON blocks (`<<<LEAD_UPDATE: {...}>>>`).
  - **Graceful Error & 429 Handling**: Rate limit or API failure triggers a friendly fallback message and flags the lead for human staff attention (`needs_human: true`).
- **Data Access Layer (DAL)**:
  - SQLite database with WAL mode enabled.
  - Isolated repository pattern so SQLite can be swapped for PostgreSQL with zero controller refactoring.
- **Lead CRM & Dashboard Endpoints**:
  - `GET /leads` — filterable by `status`, `needs_human`, sortable by `recency`, `oldest`, `needs_human_first`.
  - `GET /leads/:wa_id` — full lead dossier with bounded conversation history.

---

## Prerequisites

- **Node.js**: v18.0.0 or higher (Tested on Node.js v24)
- **Meta Developer Account**: With a registered WhatsApp Business App and a WhatsApp Phone Number ID.
- **Meta Permanent System User Access Token**: Generated via *Business Settings > System Users > Assign Assets > Generate Token* with `whatsapp_business_messaging` and `whatsapp_business_management` permissions.
- **OpenRouter Account**: API key from [openrouter.ai](https://openrouter.ai/).

---

## Quickstart & Installation

### 1. Clone & Install Dependencies

```bash
git clone <repo-url>
cd WA
npm install
```

### 2. Configure Environment Variables

Copy the sample environment file:

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```env
# Server Configuration
PORT=3000
NODE_ENV=development

# Meta WhatsApp Cloud API
META_ACCESS_TOKEN=your_permanent_system_user_token
META_PHONE_NUMBER_ID=your_whatsapp_phone_number_id
META_WEBHOOK_VERIFY_TOKEN=your_custom_secret_verify_token
META_APP_SECRET=your_meta_app_secret

# OpenRouter AI
OPENROUTER_API_KEY=your_openrouter_api_key
OPENROUTER_MODEL=google/gemini-2.5-flash

# Database
DATABASE_PATH=./data/goldkraft_leads.db
```

### 3. Run Locally

```bash
# Start server in production mode
npm start

# Or start with auto-reload in development
npm run dev
```

The server will start at `http://localhost:3000`.

---

## Exposing Webhook to Meta via Ngrok (Local Dev)

To allow Meta's Cloud API servers to reach your local webhook during development:

### 1. Launch Ngrok Tunnel

```bash
ngrok http 3000
```

Ngrok will provide a public HTTPS URL (e.g. `https://abc-123.ngrok-free.app`).

### 2. Configure Meta Webhook in App Dashboard

1. Navigate to [Meta App Dashboard](https://developers.facebook.com/apps/).
2. Select your App and go to **WhatsApp > Configuration**.
3. Under **Webhook**, click **Edit**:
   - **Callback URL**: `https://abc-123.ngrok-free.app/webhook` *(replace with your ngrok URL)*
   - **Verify Token**: Enter the exact string set in `META_WEBHOOK_VERIFY_TOKEN` in your `.env`.
4. Click **Verify and Save**. Meta will send a `GET` handshake request to your endpoint.
5. Under **Webhook fields**, click **Manage** and subscribe to **`messages`**.

---

## Testing & Simulation Guide

### 1. Automated Tests

Run the full test suite (unit + integration):

```bash
npm test
```

---

### 2. Manual cURL Testing

#### A. Test Webhook Verification Handshake (`GET /webhook`)

```bash
curl -X GET "http://localhost:3000/webhook?hub.mode=subscribe&hub.verify_token=your_custom_secret_verify_token&hub.challenge=test_challenge_12345"
```
*Expected Output:* `test_challenge_12345` with HTTP `200 OK`.

---

#### B. Simulate Inbound WhatsApp Text Message (`POST /webhook`)

```bash
curl -X POST "http://localhost:3000/webhook" \
  -H "Content-Type: application/json" \
  -d '{
    "object": "whatsapp_business_account",
    "entry": [
      {
        "id": "WABA_ID_12345",
        "changes": [
          {
            "value": {
              "messaging_product": "whatsapp",
              "metadata": {
                "display_phone_number": "918000000000",
                "phone_number_id": "PHONE_ID_123"
              },
              "contacts": [
                { "profile": { "name": "Rohan Mehra" }, "wa_id": "919876543210" }
              ],
              "messages": [
                {
                  "from": "919876543210",
                  "id": "wamid.HBgLMTIzNDU2Nzg5MA==",
                  "timestamp": "1725200000",
                  "text": { "body": "Hi, what are your monthly membership rates?" },
                  "type": "text"
                }
              ]
            },
            "field": "messages"
          }
        ]
      }
    ]
  }'
```

---

#### C. Query All Leads from CRM (`GET /leads`)

```bash
# Get all leads
curl -X GET "http://localhost:3000/leads"

# Filter by status (e.g. qualified)
curl -X GET "http://localhost:3000/leads?status=qualified"

# Filter by needs_human
curl -X GET "http://localhost:3000/leads?needs_human=true"

# Sort by oldest first
curl -X GET "http://localhost:3000/leads?sort=oldest"
```

---

#### D. Fetch Full Lead Record & Conversation History (`GET /leads/:wa_id`)

```bash
curl -X GET "http://localhost:3000/leads/919876543210"
```

---

## Lead Data Model Reference

| Field | Type | Description |
|---|---|---|
| `wa_id` | `TEXT` (PK) | WhatsApp phone number without `+` (unique lookup key) |
| `display_name` | `TEXT` | WhatsApp profile name |
| `status` | `ENUM` | `["new", "contacted", "qualified", "hot", "cold", "converted", "lost"]` |
| `interest` | `TEXT` | Extracted lead interest (e.g. `trial`, `monthly membership`, `PT`) |
| `source` | `TEXT` | Lead origin (default: `whatsapp_inbound`) |
| `first_contact_at` | `TEXT` (ISO) | Timestamp of first inbound contact |
| `last_inbound_message_at` | `TEXT` (ISO) | Timestamp of latest inbound message |
| `last_outbound_message_at` | `TEXT` (ISO) | Timestamp of latest outbound reply |
| `window_open` | `BOOLEAN` | Dynamic check: `now - last_inbound_message_at <= 24h` |
| `needs_human` | `BOOLEAN` | Flagged `true` when staff intervention is required |
| `handoff_reason` | `TEXT` | e.g. `ready_to_book`, `price_negotiation`, `injury_question`, `complaint`, `human_requested` |
| `notes` | `TEXT` | Appendable staff / AI qualification notes |
| `conversation_history` | `ARRAY` | Ordered messages (`direction`, `text`, `timestamp`, `message_id`) |

---

## Customizing Gym Persona & Business Rules

All gym specifications, operating hours, pricing tiers, and brand voice guidelines live in [`src/config/gymConfig.js`](file:///home/kaamil/Desktop/IRL%20new/WA/src/config/gymConfig.js). To adapt this backend for other fitness clubs or branches, simply update `gymConfig.js`.

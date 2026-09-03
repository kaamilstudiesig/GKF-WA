# Goldkraft Fitness — WhatsApp AI Lead-Management & Multi-Tenant SaaS Backend

A production-ready Node.js/Express backend connecting WhatsApp (via Meta Cloud API v23.0) to an AI sales & qualification agent (via OpenRouter) that handles inbound leads for fitness clubs and gyms, replies conversationally, and provides durable multi-tenant CRM lead management in SQLite with zero data loss.

---

## Target Production Architecture

```
Meta WhatsApp Cloud API
        │
        ▼
   POST /webhook
   (HMAC-SHA256 Verified, Rate-Limited, Fast Ack)
        │
        ├─► Atomically Enqueue Event in SQLite (webhook_events)
        │   (ON CONFLICT DO NOTHING Idempotency)
        │
        └─► Return HTTP 200 Immediately
        │
        ▼
 In-Process Durable Event Queue
        │
        ▼
  Webhook Worker Loop
        │
        ├─► Resolve Tenant by Phone Number ID
        ├─► Atomically Upsert Lead Record (leads)
        ├─► Save Inbound Message (messages)
        ├─► Message Router:
        │     ├─► Medical / Injury Safety Filter (Escalate + Disclaimer)
        │     ├─► Deterministic Router (Hours, Location, FAQ - 0 Token Spend)
        │     └─► AI Service (Tool Calling Loop, Guardrails, Budget Check)
        │
        └─► Enqueue Outbound Message (outbound_messages)
        │
        ▼
  Outbound Message Worker
        │
        ├─► Exponential Backoff + Jitter for Transient Errors (429, 5xx, Network)
        ├─► Dead-Lettering for Permanent 4xx Validation / Auth Errors
        ├─► Outbound Deduplication by Dedup Key
        ▼
Meta WhatsApp Cloud API (POST /v23.0/<PHONE_ID>/messages)
```

---

## Core System Capabilities

### 1. Fast Webhook Acknowledgment & Durable Inbound Queue
- Webhook endpoint (`POST /webhook`) authenticates `X-Hub-Signature-256`, validates payload structure, atomically records the event into `webhook_events`, and acknowledges Meta with `HTTP 200` in milliseconds.
- Inbound worker processes jobs asynchronously with state transitions (`pending` -> `processing` -> `completed` / `failed` / `dead_letter`).
- Stale lock reclamation ensures that worker crashes during processing do not leave orphaned jobs.

### 2. Atomic Idempotency
- Race-safe message deduplication backed by `UNIQUE` database constraints and `INSERT ... ON CONFLICT DO NOTHING / UPDATE`.
- Duplicate webhook deliveries from Meta retries will never create duplicate leads, duplicate conversation records, or duplicate outbound replies to customers.

### 3. Outbound Message Queue with Resilient Delivery
- Outbound replies are decoupled from AI inference and enqueued into `outbound_messages`.
- Outbound worker delivers messages via Meta Graph API with exponential backoff and jitter.
- Strictly separates retryable transient errors (HTTP 429 rate limit, 5xx server error, connection reset) from permanent client errors (HTTP 400 bad request, 401 unauthorized).

### 4. Multi-Tenancy & Strict Data Isolation (Invariant 3)
- First-class `tenants` model (`id`, `name`, `status`, `timezone`, `whatsapp_phone_number_id`, `configuration_json`).
- Automatically resolves tenant based on WhatsApp Phone Number ID (`phone_number_id`), defaulting to `goldkraft` for backward compatibility.
- All entities (`leads`, `messages`, `webhook_events`, `outbound_messages`, `ai_usage`, `handoffs`, `audit_logs`, `users`) are tenant-scoped.
- Cross-tenant data access is strictly prevented at both the DAL and controller layers (returns 404/403).

### 5. AI Business Policy Layer & Guardrails
- **Conversion Protection (Invariant 5):** AI cannot independently mark leads as `converted`. Conversion requires authorized human staff action.
- **Medical / Injury Safety (Phase 40):** High-risk questions (e.g., slipped disc, ACL tear, rehab, cardiac conditions) immediately trigger human staff handoff with a non-diagnostic medical disclaimer.
- **Deterministic Routing (Phase 14):** Confident standard queries (operating hours, physical address, parking, human agent requests) are answered deterministically without calling the LLM, preserving margins for ₹1,500–₹2,000/month pricing.
- **Clean Customer Replies (Invariant 8):** WhatsApp responses are sanitized so internal tool calls, debug JSON, or delimited tags never leak to the customer.

### 6. AI Cost Tracking & Budget Controls (Phase 17 & 18)
- Every LLM completion is recorded in `ai_usage` (`input_tokens`, `output_tokens`, `latency_ms`, `estimated_cost_inr`).
- Tenant-level monthly token and request budget limits prevent runaway API bills. If limits are reached, the system smoothly routes to deterministic fallback and flags staff.

### 7. Security Hardening & Observability
- Security headers (`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `X-XSS-Protection: 0`, `Content-Security-Policy`).
- End-to-end Request ID tracing (`x-request-id`).
- Payload size bounding (`1mb`).
- Sanitized production logging with automated PII phone number masking (`91*****3210`).
- Health probes: `/health` (liveness) and `/health/ready` (readiness with SQLite connectivity verification).
- Graceful shutdown with 5-second drain timer for workers, server, and SQLite database.

---

## Database & Schema Migrations

The system uses an ordered, tracked migration runner (`src/db/migrations.js`) storing applied versions in `schema_migrations`:

| Migration | Name | Description |
|---|---|---|
| 1 | `001_initial_schema` | Baseline `leads` and `messages` tables |
| 2 | `002_multi_tenancy` | `tenants` table, `tenant_id` columns, and default `goldkraft` tenant seeding |
| 3 | `003_durable_queues` | `webhook_events` and `outbound_messages` queue tables with indexes |
| 4 | `004_ai_handoffs_and_auth` | `ai_usage`, `handoffs`, `audit_logs`, and `users` tables |

To run migrations manually:
```bash
npm run migrate
```
Migrations run automatically on application startup.

---

## Environment Variables

| Variable | Required in Production | Description | Default |
|---|---|---|---|
| `PORT` | No | HTTP server port | `3000` |
| `NODE_ENV` | No | `development`, `production`, or `test` | `development` |
| `LOG_LEVEL` | No | `debug`, `info`, `warn`, `error` | `info` (prod) / `debug` (dev) |
| `DASHBOARD_API_KEY` | Yes | Master API key for platform administration | — |
| `META_ACCESS_TOKEN` | Yes | Permanent System User Token from Meta Business Settings | — |
| `META_PHONE_NUMBER_ID`| Yes | WhatsApp Business Account Phone Number ID | — |
| `META_WEBHOOK_VERIFY_TOKEN` | Yes | Secret token for Meta webhook verification handshake | — |
| `META_APP_SECRET` | Yes | Meta App Secret for HMAC-SHA256 signature verification | — |
| `OPENROUTER_API_KEY` | Yes | API key from OpenRouter | — |
| `OPENROUTER_MODEL` | No | Primary LLM model | `google/gemini-2.5-flash` |
| `OPENROUTER_FALLBACK_MODEL` | No | Secondary LLM model for fallback | `google/gemini-2.5-flash-lite` |
| `DATABASE_PATH` | No | Absolute or relative path to SQLite database file | `./data/goldkraft_leads.db` |

---

## API Endpoints

### Public Endpoints
- `GET /` — Service overview and gym facility metadata
- `GET /health` — Liveness check (HTTP 200, uptime)
- `GET /health/ready` — Readiness check (HTTP 200 if SQLite connected; HTTP 503 if disconnected)
- `GET /webhook` — Meta Webhook verification handshake (`hub.mode`, `hub.verify_token`, `hub.challenge`)
- `POST /webhook` — Inbound WhatsApp event ingestion (HMAC-SHA256 signature required)

### Protected CRM & Dashboard Endpoints
*Requires `Authorization: Bearer <API_KEY>` or `x-api-key: <API_KEY>`*
- `GET /leads` — List leads with filtering (`status`, `needs_human`), sorting (`recency`, `oldest`, `needs_human_first`), and pagination (`limit`, `offset`)
- `GET /leads/:wa_id` — Dossier for lead including 24-hr customer service window and conversation history
- `GET /dashboard/summary` — Aggregated CRM metrics (leads breakdown, AI spend, pending queue items) scoped to authenticated tenant

---

## Operational & Deployment Guidelines

### Running Locally
```bash
npm install
cp .env.example .env
# Edit .env with your credentials
npm run dev
```

### Running Tests
```bash
npm test
```

### SQLite Backup Strategy
Because SQLite operates in WAL (Write-Ahead Logging) mode, naive file copy while the server is writing can result in corrupted snapshot files.
To safely back up the database in production:

```bash
# Recommended: Online safe SQLite backup
sqlite3 ./data/goldkraft_leads.db ".backup './backups/goldkraft_leads_$(date +%Y%m%d_%H%M%S).db'"
```
Set up a daily cron job to run this command and store snapshots in secure offsite storage (e.g. AWS S3 or GCP Cloud Storage).

### Known Scaling Constraints
- **SQLite Concurrency:** SQLite supports unlimited concurrent readers but serialized single-writer access. With WAL mode and `PRAGMA busy_timeout = 5000;`, SQLite comfortably handles tens of thousands of WhatsApp messages per day for single-node deployments.
- **Horizontal Scaling:** Do not run multiple independent servers against the same local SQLite file across different machines. If horizontal scaling across multiple container instances is required in the future, migrate the repository layer to PostgreSQL. The data access layer is cleanly isolated to make this migration seamless.

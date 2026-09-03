# Goldkraft Fitness — WhatsApp AI Lead-Management & Multi-Tenant SaaS Backend

A production-ready Node.js/Express backend connecting WhatsApp (via Meta Cloud API v23.0) to an AI sales & qualification agent (via OpenRouter) that handles inbound leads for fitness clubs and gyms, replies conversationally, and provides durable multi-tenant CRM lead management in SQLite with resilient at-least-once delivery semantics.

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
| 5 | `005_composite_tenant_leads_and_fk_safety` | Upgrades `leads` to composite `(tenant_id, wa_id)` primary key and adds composite foreign keys on `messages` and `handoffs` |

To run migrations manually:
```bash
npm run migrate
```
Migrations run automatically on application startup with atomic foreign-key safety verification.

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
| `SENTRY_DSN` | No | Sentry Data Source Name for error and performance monitoring | — |

---

## API Endpoints

### Public Endpoints
- `GET /` — Service overview and gym facility metadata
- `GET /health` — Liveness check (HTTP 200, uptime)
- `GET /health/ready` — Readiness check (HTTP 200 if SQLite connected; HTTP 503 if disconnected or shutting down)
- `GET /webhook` — Meta Webhook verification handshake (`hub.mode`, `hub.verify_token`, `hub.challenge`)
- `POST /webhook` — Inbound WhatsApp event ingestion (HMAC-SHA256 signature required)

### Protected CRM & Dashboard Endpoints
*Requires `Authorization: Bearer <API_KEY>` or `x-api-key: <API_KEY>`*
- `GET /leads` — List leads with filtering (`status`, `needs_human`), sorting (`recency`, `oldest`, `needs_human_first`), and pagination (`limit`, `offset`)
- `GET /leads/:wa_id` — Dossier for lead including 24-hr customer service window and conversation history
- `PATCH /leads/:wa_id` — Update lead properties (`status`, `interest`, `display_name`, `notes`, `needs_human`). Allows staff to set `converted` status. Atomically logged to `audit_logs`.
- `GET /dashboard/summary` — Complete observability breakdown (leads by stage, handoff status, AI usage/costs/latency, inbound/outbound queue lifecycle)

---

## Operational & Disaster Recovery Runbook

### Running Locally
```bash
npm install
cp .env.example .env
# Edit .env with your credentials
npm run dev
```

### Running Tests & Coverage
```bash
npm test
# Run with coverage:
node --test --experimental-test-coverage test/**/*.test.js
```

### SQLite Production Backup Procedure
Because SQLite runs in WAL (Write-Ahead Logging) mode, file copying while the engine is writing can result in corrupt snapshots.
The backend includes a production-grade atomic backup command:

```bash
npm run backup
```
**Mechanism:**
1. Uses SQLite's atomic `VACUUM INTO '<backup-file>'` to create a clean, consistent snapshot without locking live writers.
2. Immediately executes `PRAGMA integrity_check;` on the backup file to guarantee zero corruption.
3. Automatically prunes snapshots older than 14 retention cycles.
4. Outputs execution stats (duration, file size in MB, integrity status).

**Restore Procedure:**
In the event of hardware or data corruption:
```bash
# 1. Stop the application service
systemctl stop gkf-wa

# 2. Verify backup integrity
node -e "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync('data/backups/<backup-file>.db'); console.log(db.prepare('PRAGMA integrity_check;').get());"

# 3. Replace live database with verified backup
cp data/backups/<backup-file>.db data/goldkraft_leads.db
rm -f data/goldkraft_leads.db-wal data/goldkraft_leads.db-shm

# 4. Restart application
systemctl start gkf-wa
```

### Recovering Dead-Lettered Queue Jobs
If external APIs (Meta, OpenRouter) suffer extended outages or permanent authentication errors, failed jobs enter `dead_letter` status.
To inspect and re-enqueue dead-lettered events:
```sql
-- Inspect failed webhook events
SELECT id, event_key, last_error, attempts, updated_at FROM webhook_events WHERE status = 'dead_letter';

-- Reset dead-lettered webhook events back to pending
UPDATE webhook_events SET status = 'pending', attempts = 0, available_at = datetime('now') WHERE status = 'dead_letter';

-- Reset dead-lettered outbound messages back to pending
UPDATE outbound_messages SET status = 'pending', attempts = 0, available_at = datetime('now') WHERE status = 'dead_letter';
```

---

## System Architecture Guarantees & Boundaries

1. **Delivery Guarantee:** Resilient **at-least-once** external delivery. Meta WhatsApp Cloud API does not support idempotency keys on outbound `/messages`. In the event of a network timeout after Meta receives a message but before the backend receives an HTTP response, retries could generate duplicate delivery. Deduplication is maintained internally via `dedup_key` in `outbound_messages`.
2. **AI Budget Enforcement:** AI monthly token and request limits are enforced as a non-blocking soft guardrail. Under rapid concurrent requests, slight over-budget allowances can occur before the guardrail clamps further LLM invocations and routes to deterministic fallbacks.
3. **Single-Process Worker Model:** Inbound and outbound worker loops run in-process using Node.js event-driven polling and atomic SQLite conditional updates. Do not attach multiple container nodes to the same SQLite database file over networked storage (NFS/SMB). Scale vertically or migrate to PostgreSQL when horizontal multi-node scaling is required.
4. **Student Developer Pack Tooling:**
   - **GitHub Actions & Codecov:** Automated CI runs test suite across Node 22 & 24 on every PR and main commit with coverage tracking.
   - **Sentry:** Centralized error/crash tracking with deep redaction of secrets, tokens, and phone numbers.
   - **1Password:** Secret management runbook for developers; production secrets injected via environment variables.
   - **Datadog / Azure / Heroku:** Intentionally evaluated and kept optional to avoid premature architecture bloat and runtime cost.

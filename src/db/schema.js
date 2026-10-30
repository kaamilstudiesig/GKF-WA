/**
 * Postgres schema, applied in order by db.migrate(). Never edit an applied
 * migration; add a new one.
 */
const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'hot', 'cold', 'converted', 'lost'];
const HANDOFF_REASONS = [
  'ready_to_book', 'price_negotiation', 'custom_program', 'injury_question', 'human_requested',
  'complaint', 'rate_limit_exceeded', 'ai_service_unavailable', 'ai_network_error', 'budget_exceeded', 'other'
];
const list = values => values.map(v => `'${v}'`).join(', ');

const migrations = [
  {
    id: 1,
    name: 'initial',
    up: [
      `CREATE TABLE leads (
        wa_id TEXT PRIMARY KEY,
        display_name TEXT,
        status TEXT NOT NULL DEFAULT 'new' CHECK (status IN (${list(LEAD_STATUSES)})),
        interest TEXT,
        source TEXT NOT NULL DEFAULT 'whatsapp_inbound',
        first_contact_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_inbound_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_outbound_message_at TIMESTAMPTZ,
        needs_human BOOLEAN NOT NULL DEFAULT false,
        handoff_reason TEXT,
        notes TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      'CREATE INDEX leads_status_idx ON leads (status)',
      'CREATE INDEX leads_needs_human_idx ON leads (needs_human) WHERE needs_human',
      'CREATE INDEX leads_last_inbound_idx ON leads (last_inbound_message_at DESC)',

      `CREATE TABLE messages (
        id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        message_id TEXT UNIQUE,
        wa_id TEXT NOT NULL REFERENCES leads (wa_id) ON DELETE CASCADE,
        direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
        text TEXT NOT NULL,
        timestamp TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      'CREATE INDEX messages_wa_time_idx ON messages (wa_id, timestamp DESC, id DESC)',

      `CREATE TABLE handoffs (
        id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        wa_id TEXT NOT NULL REFERENCES leads (wa_id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'assigned', 'resolved')),
        reason TEXT NOT NULL CHECK (reason IN (${list(HANDOFF_REASONS)})),
        summary TEXT,
        assigned_to TEXT,
        resolved_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      // At most one open handoff per lead, enforced by the database.
      `CREATE UNIQUE INDEX handoffs_one_open_per_lead ON handoffs (wa_id) WHERE status IN ('pending', 'assigned')`,

      `CREATE TABLE webhook_events (
        id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        event_key TEXT NOT NULL UNIQUE,
        wa_id TEXT,
        message_id TEXT,
        payload JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'dead_letter')),
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        locked_at TIMESTAMPTZ,
        processed_at TIMESTAMPTZ,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX webhook_events_ready_idx ON webhook_events (available_at, id) WHERE status IN ('pending', 'processing')`,

      `CREATE TABLE outbound_messages (
        id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        dedup_key TEXT UNIQUE,
        wa_id TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
        provider_message_id TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        locked_at TIMESTAMPTZ,
        sent_at TIMESTAMPTZ,
        failed_at TIMESTAMPTZ,
        last_error TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX outbound_ready_idx ON outbound_messages (available_at, id) WHERE status IN ('pending', 'sending')`,
      'CREATE INDEX outbound_wa_idx ON outbound_messages (wa_id)',

      `CREATE TABLE ai_usage (
        id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        request_id TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cost_usd DOUBLE PRECISION,
        latency_ms INTEGER,
        success BOOLEAN NOT NULL DEFAULT true,
        error_type TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      'CREATE INDEX ai_usage_created_idx ON ai_usage (created_at)'
    ]
  },
  {
    // WhatsApp usernames: Meta may hide a user's phone and send a business-scoped
    // user ID (BSUID, e.g. "IN.1234...") instead. leads.wa_id stays the lead's key
    // (the phone for existing and phone-known leads, the BSUID otherwise);
    // phone and user_id hold whichever identifiers Meta has shared.
    id: 2,
    name: 'bsuid_identity',
    up: [
      'ALTER TABLE leads ADD COLUMN phone TEXT',
      'ALTER TABLE leads ADD COLUMN user_id TEXT',
      'ALTER TABLE leads ADD COLUMN username TEXT',
      "UPDATE leads SET phone = wa_id WHERE wa_id ~ '^[0-9]{6,15}$'",
      'CREATE UNIQUE INDEX leads_user_id_key ON leads (user_id) WHERE user_id IS NOT NULL',
      'CREATE INDEX leads_phone_idx ON leads (phone)'
    ]
  }
];

module.exports = { migrations, LEAD_STATUSES, HANDOFF_REASONS };

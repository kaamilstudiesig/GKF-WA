const logger = require('../utils/logger');

/**
 * Migration definitions executed in strict sequential order.
 * Each migration is idempotent and runs inside a transaction.
 */
const migrations = [
  {
    id: 1,
    name: '001_initial_schema',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS leads (
          wa_id TEXT PRIMARY KEY,
          display_name TEXT,
          status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'qualified', 'hot', 'cold', 'converted', 'lost')),
          interest TEXT,
          source TEXT NOT NULL DEFAULT 'whatsapp_inbound',
          first_contact_at TEXT NOT NULL,
          last_inbound_message_at TEXT NOT NULL,
          last_outbound_message_at TEXT,
          needs_human INTEGER NOT NULL DEFAULT 0,
          handoff_reason TEXT,
          notes TEXT,
          metadata_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id TEXT UNIQUE,
          wa_id TEXT NOT NULL,
          direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
          text TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          raw_payload TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY (wa_id) REFERENCES leads(wa_id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
        CREATE INDEX IF NOT EXISTS idx_leads_needs_human ON leads(needs_human);
        CREATE INDEX IF NOT EXISTS idx_leads_last_inbound ON leads(last_inbound_message_at);
        CREATE INDEX IF NOT EXISTS idx_messages_wa_id ON messages(wa_id);
        CREATE INDEX IF NOT EXISTS idx_messages_message_id ON messages(message_id);
      `);
    }
  },
  {
    id: 2,
    name: '002_multi_tenancy',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS tenants (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'trial', 'cancelled')),
          timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
          whatsapp_phone_number_id TEXT UNIQUE,
          configuration_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status);
        CREATE INDEX IF NOT EXISTS idx_tenants_phone_number ON tenants(whatsapp_phone_number_id);
      `);

      // Seed default tenant (Goldkraft Fitness)
      const now = new Date().toISOString();
      const checkTenant = db.prepare('SELECT id FROM tenants WHERE id = ?').get('goldkraft');
      if (!checkTenant) {
        db.prepare(`
          INSERT INTO tenants (id, name, status, timezone, whatsapp_phone_number_id, configuration_json, created_at, updated_at)
          VALUES (?, ?, 'active', 'Asia/Kolkata', ?, ?, ?, ?)
        `).run(
          'goldkraft',
          'Goldkraft Fitness',
          process.env.META_PHONE_NUMBER_ID || 'default_goldkraft_phone_id',
          JSON.stringify({
            pricing_monthly: 4040,
            location: 'ITI Layout, 1st Phase, J.P. Nagar, Bengaluru, Karnataka 560078',
            monthly_token_budget: 500000,
            monthly_request_budget: 5000
          }),
          now,
          now
        );
      }

      // Safely add tenant_id to leads if not present
      const leadColumns = db.prepare("PRAGMA table_info(leads)").all();
      const hasLeadTenant = leadColumns.some(c => c.name === 'tenant_id');
      if (!hasLeadTenant) {
        db.exec("ALTER TABLE leads ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'goldkraft';");
        db.exec("CREATE INDEX IF NOT EXISTS idx_leads_tenant ON leads(tenant_id);");
      }

      // Safely add tenant_id to messages if not present
      const msgColumns = db.prepare("PRAGMA table_info(messages)").all();
      const hasMsgTenant = msgColumns.some(c => c.name === 'tenant_id');
      if (!hasMsgTenant) {
        db.exec("ALTER TABLE messages ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'goldkraft';");
        db.exec("CREATE INDEX IF NOT EXISTS idx_messages_tenant ON messages(tenant_id);");
      }
    }
  },
  {
    id: 3,
    name: '003_durable_queues',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS webhook_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_key TEXT UNIQUE NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT 'goldkraft',
          message_id TEXT,
          event_type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'dead_letter')),
          attempts INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 5,
          available_at TEXT NOT NULL,
          locked_at TEXT,
          processed_at TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (tenant_id) REFERENCES tenants(id)
        );

        CREATE INDEX IF NOT EXISTS idx_webhook_events_status_avail ON webhook_events(status, available_at);
        CREATE INDEX IF NOT EXISTS idx_webhook_events_tenant_msg ON webhook_events(tenant_id, message_id);

        CREATE TABLE IF NOT EXISTS outbound_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          dedup_key TEXT UNIQUE,
          tenant_id TEXT NOT NULL DEFAULT 'goldkraft',
          wa_id TEXT NOT NULL,
          text TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
          provider_message_id TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 5,
          available_at TEXT NOT NULL,
          locked_at TEXT,
          sent_at TEXT,
          failed_at TEXT,
          last_error TEXT,
          metadata_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (tenant_id) REFERENCES tenants(id)
        );

        CREATE INDEX IF NOT EXISTS idx_outbound_status_avail ON outbound_messages(status, available_at);
        CREATE INDEX IF NOT EXISTS idx_outbound_tenant_wa ON outbound_messages(tenant_id, wa_id);
      `);
    }
  },
  {
    id: 4,
    name: '004_ai_handoffs_and_auth',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ai_usage (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id TEXT NOT NULL DEFAULT 'goldkraft',
          request_id TEXT NOT NULL,
          model TEXT NOT NULL,
          input_tokens INTEGER,
          output_tokens INTEGER,
          cached_tokens INTEGER,
          estimated_cost_inr REAL,
          latency_ms INTEGER,
          success INTEGER NOT NULL DEFAULT 1,
          error_type TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY (tenant_id) REFERENCES tenants(id)
        );

        CREATE INDEX IF NOT EXISTS idx_ai_usage_tenant_created ON ai_usage(tenant_id, created_at);

        CREATE TABLE IF NOT EXISTS handoffs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id TEXT NOT NULL DEFAULT 'goldkraft',
          wa_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'assigned', 'resolved')),
          reason TEXT NOT NULL CHECK (reason IN (
            'ready_to_book', 'price_negotiation', 'custom_program',
            'injury_question', 'human_requested', 'complaint',
            'rate_limit_exceeded', 'ai_service_unavailable', 'ai_network_error',
            'budget_exceeded', 'other'
          )),
          summary TEXT,
          assigned_to TEXT,
          resolved_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (tenant_id) REFERENCES tenants(id),
          FOREIGN KEY (wa_id) REFERENCES leads(wa_id)
        );

        CREATE INDEX IF NOT EXISTS idx_handoffs_tenant_status ON handoffs(tenant_id, status);
        CREATE INDEX IF NOT EXISTS idx_handoffs_wa_id ON handoffs(wa_id);

        CREATE TABLE IF NOT EXISTS audit_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id TEXT NOT NULL DEFAULT 'goldkraft',
          actor_id TEXT NOT NULL,
          actor_role TEXT NOT NULL,
          action TEXT NOT NULL,
          target_type TEXT NOT NULL,
          target_id TEXT NOT NULL,
          changes_json TEXT,
          ip_address TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY (tenant_id) REFERENCES tenants(id)
        );

        CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_created ON audit_logs(tenant_id, created_at);

        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL DEFAULT 'goldkraft',
          email TEXT UNIQUE NOT NULL,
          name TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('platform_admin', 'owner', 'manager', 'staff')),
          api_key_hash TEXT UNIQUE,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (tenant_id) REFERENCES tenants(id)
        );

        CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);
        CREATE INDEX IF NOT EXISTS idx_users_api_key ON users(api_key_hash);
      `);
    }
  }
];

/**
 * Runs all unapplied migrations sequentially.
 * @param {object} db - SQLite database instance
 */
function runMigrations(db) {
  // Ensure schema_migrations table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRows = db.prepare('SELECT name FROM schema_migrations').all();
  const appliedNames = new Set(appliedRows.map(r => r.name));

  for (const migration of migrations) {
    if (!appliedNames.has(migration.name)) {
      logger.info(`Applying database migration: ${migration.name}`);
      const now = new Date().toISOString();

      // Run migration inside transaction
      db.exec('BEGIN IMMEDIATE;');
      try {
        migration.up(db);
        db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(
          migration.name,
          now
        );
        db.exec('COMMIT;');
        logger.info(`Successfully applied migration: ${migration.name}`);
      } catch (err) {
        try {
          db.exec('ROLLBACK;');
        } catch (rbErr) {}
        logger.error(`Failed to apply migration ${migration.name}: ${err.message}`, { error: err.stack });
        throw err;
      }
    }
  }
}

module.exports = {
  migrations,
  runMigrations
};

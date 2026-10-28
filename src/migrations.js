/**
 * CRM-owned tables. All prefixed `crm_`, tracked in their own `crm_migrations`
 * table, so the bot's tables and its `schema_migrations` are never touched.
 * Never edit an applied migration; add a new one.
 */
const CRM_MIGRATIONS = [
  {
    id: 1,
    name: 'initial',
    up: [
      `CREATE TABLE crm_users (
        id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        email TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'sales')),
        manager_id INTEGER REFERENCES crm_users (id) ON DELETE SET NULL,
        password_hash TEXT NOT NULL,
        must_change_password BOOLEAN NOT NULL DEFAULT false,
        active BOOLEAN NOT NULL DEFAULT true,
        last_login_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      'CREATE UNIQUE INDEX crm_users_email_lower_idx ON crm_users (lower(email))',

      `CREATE TABLE crm_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES crm_users (id) ON DELETE CASCADE,
        csrf_token TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      'CREATE INDEX crm_sessions_user_idx ON crm_sessions (user_id)',
      'CREATE INDEX crm_sessions_expires_idx ON crm_sessions (expires_at)',

      `CREATE TABLE crm_lead_assignments (
        wa_id TEXT PRIMARY KEY REFERENCES leads (wa_id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES crm_users (id) ON DELETE CASCADE,
        assigned_by INTEGER REFERENCES crm_users (id) ON DELETE SET NULL,
        assigned_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      'CREATE INDEX crm_lead_assignments_user_idx ON crm_lead_assignments (user_id)',

      `CREATE TABLE crm_lead_notes (
        id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        wa_id TEXT NOT NULL REFERENCES leads (wa_id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES crm_users (id) ON DELETE SET NULL,
        body TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      'CREATE INDEX crm_lead_notes_lead_idx ON crm_lead_notes (wa_id)',

      `CREATE TABLE crm_follow_ups (
        id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        wa_id TEXT NOT NULL REFERENCES leads (wa_id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES crm_users (id) ON DELETE CASCADE,
        created_by INTEGER REFERENCES crm_users (id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        due_at TIMESTAMPTZ NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      'CREATE INDEX crm_follow_ups_user_idx ON crm_follow_ups (user_id, status, due_at)',
      'CREATE INDEX crm_follow_ups_lead_idx ON crm_follow_ups (wa_id)',

      // Audit trail: no FK on wa_id so history survives if the bot deletes a lead.
      `CREATE TABLE crm_activity_log (
        id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        wa_id TEXT,
        user_id INTEGER REFERENCES crm_users (id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      'CREATE INDEX crm_activity_log_lead_idx ON crm_activity_log (wa_id, created_at)',
      'CREATE INDEX crm_activity_log_user_idx ON crm_activity_log (user_id, created_at)'
    ]
  }
];

// Bot tables and columns the CRM reads or writes (GKF-WA src/db/schema.js).
const BOT_REQUIRED = {
  leads: ['wa_id', 'display_name', 'status', 'interest', 'source', 'first_contact_at', 'last_inbound_message_at',
    'last_outbound_message_at', 'needs_human', 'handoff_reason', 'notes', 'metadata', 'updated_at'],
  messages: ['id', 'wa_id', 'direction', 'text', 'timestamp'],
  handoffs: ['id', 'wa_id', 'status', 'reason', 'summary', 'assigned_to', 'resolved_at', 'created_at', 'updated_at'],
  outbound_messages: ['id', 'dedup_key', 'wa_id', 'text', 'status', 'last_error', 'metadata', 'created_at'],
  ai_usage: ['model', 'input_tokens', 'output_tokens', 'cost_usd', 'success', 'created_at']
};

/** Returns a list of problems with the bot's tables (empty when all is well). */
async function checkBotSchema(db) {
  const rows = await db.many(`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = ANY($1::text[])
  `, [Object.keys(BOT_REQUIRED)]);
  const have = {};
  for (const r of rows) (have[r.table_name] = have[r.table_name] || new Set()).add(r.column_name);
  const problems = [];
  for (const [table, cols] of Object.entries(BOT_REQUIRED)) {
    if (!have[table]) { problems.push(`missing table ${table}`); continue; }
    for (const c of cols) if (!have[table].has(c)) problems.push(`missing column ${table}.${c}`);
  }
  return problems;
}

async function assertBotSchema(db) {
  const problems = await checkBotSchema(db);
  if (problems.length) {
    throw new Error(
      `The WhatsApp bot's tables are not in this database (${problems.join(', ')}). ` +
      'Point DATABASE_URL at the bot\'s Postgres database and run the bot\'s migrations first. ' +
      'For local development without the bot, use DATABASE_URL=pglite://./data/pglite, which loads a demo copy of the bot tables.'
    );
  }
}

/**
 * Checks the bot's tables exist, then applies pending CRM migrations.
 * Run it after the bot's own migrations. Safe to call on every start.
 */
async function migrateCrm(db) {
  await assertBotSchema(db);
  await db.query(`CREATE TABLE IF NOT EXISTS crm_migrations (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await db.tx(async () => {
    // Serialise concurrent migrators (e.g. release phase + web dyno start).
    await db.query('SELECT pg_advisory_xact_lock(4242002)');
    const applied = new Set((await db.many('SELECT id FROM crm_migrations')).map(r => r.id));
    for (const m of CRM_MIGRATIONS) {
      if (applied.has(m.id)) continue;
      for (const stmt of m.up) await db.query(stmt);
      await db.query('INSERT INTO crm_migrations (id, name) VALUES ($1, $2)', [m.id, m.name]);
    }
  });
}

module.exports = { migrateCrm, checkBotSchema, assertBotSchema, CRM_MIGRATIONS, BOT_REQUIRED };

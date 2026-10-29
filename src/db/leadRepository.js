const db = require('./index');

const WINDOW_MS = 24 * 60 * 60 * 1000;
const UPDATABLE = ['display_name', 'status', 'interest', 'source', 'needs_human', 'handoff_reason', 'notes', 'metadata'];

/** Leads and their WhatsApp conversation history. */
const leadRepository = {
  /** WhatsApp allows free-form replies only within 24h of the lead's last message. */
  windowOpen(lastInboundAt) {
    const t = new Date(lastInboundAt).getTime();
    if (Number.isNaN(t)) return false;
    const age = Date.now() - t;
    return age >= 0 && age <= WINDOW_MS;
  },

  format(row) {
    if (!row) return null;
    return { ...row, metadata: row.metadata || {}, window_open: this.windowOpen(row.last_inbound_message_at) };
  },

  async findByWaId(waId) {
    return this.format(await db.one('SELECT * FROM leads WHERE wa_id = $1', [waId]));
  },

  /** Creates the lead on first contact, or refreshes name and last-seen time. */
  async upsertInbound(waId, displayName = null, at = new Date().toISOString()) {
    const row = await db.one(`
      INSERT INTO leads (wa_id, display_name, first_contact_at, last_inbound_message_at, created_at, updated_at)
      VALUES ($1, $2, $3, $3, now(), now())
      ON CONFLICT (wa_id) DO UPDATE SET
        display_name = COALESCE(EXCLUDED.display_name, leads.display_name),
        last_inbound_message_at = GREATEST(leads.last_inbound_message_at, EXCLUDED.last_inbound_message_at),
        updated_at = now()
      RETURNING *`, [waId, displayName, at]);
    return this.format(row);
  },

  async update(waId, updates = {}) {
    const sets = [];
    const params = [];
    for (const [key, value] of Object.entries(updates)) {
      if (!UPDATABLE.includes(key)) continue;
      params.push(key === 'metadata' ? JSON.stringify(value || {}) : key === 'needs_human' ? Boolean(value) : value);
      sets.push(key === 'metadata' ? `metadata = $${params.length}::jsonb` : `${key} = $${params.length}`);
    }
    if (sets.length === 0) return this.findByWaId(waId);
    params.push(waId);
    const row = await db.one(
      `UPDATE leads SET ${sets.join(', ')}, updated_at = now() WHERE wa_id = $${params.length} RETURNING *`, params);
    return this.format(row);
  },

  async hasMessage(messageId) {
    if (!messageId) return false;
    return Boolean(await db.one('SELECT 1 FROM messages WHERE message_id = $1', [messageId]));
  },

  /** Stores a message once (deduplicated on Meta's message id). */
  async saveMessage({ messageId = null, waId, direction, text, timestamp = new Date().toISOString() }) {
    await db.query(`
      INSERT INTO messages (message_id, wa_id, direction, text, timestamp)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (message_id) DO NOTHING`, [messageId, waId, direction, text, timestamp]);
    if (direction === 'out') {
      await db.query('UPDATE leads SET last_outbound_message_at = $2, updated_at = now() WHERE wa_id = $1', [waId, timestamp]);
    }
  },

  /** The most recent `limit` messages, oldest first. */
  async history(waId, limit = 10) {
    const rows = await db.many(`
      SELECT id, message_id, direction, text, timestamp FROM messages
      WHERE wa_id = $1 ORDER BY timestamp DESC, id DESC LIMIT $2`, [waId, limit]);
    return rows.reverse();
  }
};

module.exports = leadRepository;

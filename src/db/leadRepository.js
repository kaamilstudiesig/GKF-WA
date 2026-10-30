const db = require('./index');
const identity = require('../services/identity');

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

  /**
   * The key of the lead who sent a message: an existing lead found by BSUID or
   * phone, else the key for a new lead (phone when known, else BSUID).
   */
  async resolveKey({ phone = null, userId = null } = {}) {
    if (userId) {
      const row = await db.one('SELECT wa_id FROM leads WHERE user_id = $1', [userId]);
      if (row) return row.wa_id;
    }
    if (phone) {
      const row = await db.one(
        'SELECT wa_id FROM leads WHERE wa_id = $1 OR phone = $1 ORDER BY (wa_id = $1) DESC, created_at LIMIT 1', [phone]);
      if (row) return row.wa_id;
    }
    return identity.newLeadKey({ phone, userId });
  },

  /**
   * Creates the lead on first contact, or refreshes name, identifiers and last-seen time.
   * `ids` = { phone, userId, username } from the webhook. A BSUID already used by
   * another lead is never copied (the unique index would reject it).
   */
  async upsertInbound(waId, displayName = null, at = new Date().toISOString(), ids = {}) {
    const phone = identity.toPhone(ids.phone) || identity.toPhone(waId);
    const userId = ids.userId || (identity.isBsuid(waId) ? waId : null);
    const row = await db.one(`
      INSERT INTO leads (wa_id, display_name, phone, user_id, username, first_contact_at, last_inbound_message_at, created_at, updated_at)
      VALUES ($1, $2, $4,
        (SELECT CASE WHEN EXISTS (SELECT 1 FROM leads WHERE user_id = $5::text) THEN NULL ELSE $5::text END),
        $6, $3, $3, now(), now())
      ON CONFLICT (wa_id) DO UPDATE SET
        display_name = COALESCE(EXCLUDED.display_name, leads.display_name),
        phone = COALESCE($4, leads.phone),
        user_id = CASE
          WHEN $5::text IS NULL OR EXISTS (SELECT 1 FROM leads o WHERE o.user_id = $5::text AND o.wa_id <> leads.wa_id)
          THEN leads.user_id ELSE $5::text END,
        username = COALESCE($6, leads.username),
        last_inbound_message_at = GREATEST(leads.last_inbound_message_at, EXCLUDED.last_inbound_message_at),
        updated_at = now()
      RETURNING *`, [waId, displayName, at, phone, userId, ids.username || null]);
    return this.format(row);
  },

  /**
   * Meta system message: the user's BSUID changed (new phone, or ID rotated).
   * Moves the new BSUID (and phone, if shared) onto the existing lead.
   * Returns the lead key, or null when we don't know the old ID.
   */
  async applyIdChange({ previousUserId, userId, phone = null }) {
    if (!previousUserId || !userId) return null;
    const row = await db.one(`
      UPDATE leads SET user_id = $2, phone = COALESCE($3, phone), updated_at = now()
      WHERE user_id = $1 AND NOT EXISTS (SELECT 1 FROM leads o WHERE o.user_id = $2)
      RETURNING wa_id`, [previousUserId, userId, identity.toPhone(phone)]);
    return row ? row.wa_id : null;
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

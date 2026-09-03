const { getDatabase } = require('./database');

class LeadRepository {
  constructor(db = null) {
    this.customDb = db;
  }

  get db() {
    return this.customDb || getDatabase();
  }

  /**
   * Computes if a 24-hour customer service window is open.
   * @param {string|number|Date} lastInboundAt 
   * @returns {boolean}
   */
  computeWindowOpen(lastInboundAt) {
    if (!lastInboundAt) return false;
    const lastInboundTime = new Date(lastInboundAt).getTime();
    if (isNaN(lastInboundTime)) return false;
    const diffMs = Date.now() - lastInboundTime;
    return diffMs >= 0 && diffMs <= 24 * 60 * 60 * 1000;
  }

  /**
   * Formats raw database lead record for API/domain consumption
   */
  formatLead(row) {
    if (!row) return null;
    return {
      wa_id: row.wa_id,
      tenant_id: row.tenant_id || 'goldkraft',
      display_name: row.display_name,
      status: row.status,
      interest: row.interest,
      source: row.source,
      first_contact_at: row.first_contact_at,
      last_inbound_message_at: row.last_inbound_message_at,
      last_outbound_message_at: row.last_outbound_message_at,
      window_open: this.computeWindowOpen(row.last_inbound_message_at),
      needs_human: Boolean(row.needs_human),
      handoff_reason: row.handoff_reason,
      notes: row.notes,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  /**
   * Finds a lead by WhatsApp ID, optionally filtered by tenant
   */
  findByWaId(waId, tenantId = null) {
    let sql = 'SELECT * FROM leads WHERE wa_id = ?';
    const params = [waId];
    if (tenantId) {
      sql += ' AND tenant_id = ?';
      params.push(tenantId);
    }
    const stmt = this.db.prepare(sql);
    const row = stmt.get(...params);
    return this.formatLead(row);
  }

  /**
   * Atomically finds or initializes a lead record upon receiving an inbound message
   */
  getOrCreateLead(waId, displayName = null, inboundTimestamp = null, tenantId = 'goldkraft') {
    const now = inboundTimestamp || new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO leads (
        wa_id, tenant_id, display_name, status, interest, source,
        first_contact_at, last_inbound_message_at, last_outbound_message_at,
        needs_human, handoff_reason, notes, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, 'new', NULL, 'whatsapp_inbound', ?, ?, NULL, 0, NULL, NULL, NULL, ?, ?)
      ON CONFLICT(wa_id) DO UPDATE SET
        tenant_id = COALESCE(leads.tenant_id, excluded.tenant_id),
        display_name = COALESCE(excluded.display_name, leads.display_name),
        last_inbound_message_at = excluded.last_inbound_message_at,
        updated_at = excluded.updated_at
    `);

    stmt.run(
      waId,
      tenantId,
      displayName || null,
      now,
      now,
      now,
      now
    );

    return this.findByWaId(waId);
  }

  /**
   * Updates fields of an existing lead
   */
  updateLead(waId, updates = {}, tenantId = null) {
    const allowedFields = [
      'display_name',
      'status',
      'interest',
      'source',
      'last_inbound_message_at',
      'last_outbound_message_at',
      'needs_human',
      'handoff_reason',
      'notes',
      'metadata_json'
    ];

    const fieldsToSet = [];
    const values = [];

    for (const [key, val] of Object.entries(updates)) {
      if (allowedFields.includes(key)) {
        fieldsToSet.push(`${key} = ?`);
        if (key === 'needs_human') {
          values.push(val ? 1 : 0);
        } else if (key === 'metadata_json' && typeof val === 'object' && val !== null) {
          values.push(JSON.stringify(val));
        } else {
          values.push(val);
        }
      }
    }

    if (fieldsToSet.length === 0) return this.findByWaId(waId, tenantId);

    fieldsToSet.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(waId);

    let sql = `UPDATE leads SET ${fieldsToSet.join(', ')} WHERE wa_id = ?`;
    if (tenantId) {
      sql += ' AND tenant_id = ?';
      values.push(tenantId);
    }

    this.db.prepare(sql).run(...values);
    return this.findByWaId(waId, tenantId);
  }

  /**
   * Appends notes to a lead
   */
  appendNotes(waId, newNote, tenantId = null) {
    const lead = this.findByWaId(waId, tenantId);
    if (!lead) return null;
    const updatedNotes = lead.notes ? `${lead.notes}\n[${new Date().toISOString()}] ${newNote}` : `[${new Date().toISOString()}] ${newNote}`;
    return this.updateLead(waId, { notes: updatedNotes }, tenantId);
  }

  /**
   * Checks if an incoming message_id has already been processed (Deduplication)
   */
  hasMessageBeenProcessed(messageId) {
    if (!messageId) return false;
    const stmt = this.db.prepare('SELECT 1 FROM messages WHERE message_id = ? LIMIT 1');
    const result = stmt.get(messageId);
    return Boolean(result);
  }

  /**
   * Saves a message record to conversation history atomically
   */
  saveMessage({ messageId, waId, direction, text, timestamp, rawPayload = null, tenantId = 'goldkraft' }) {
    const stmt = this.db.prepare(`
      INSERT INTO messages (message_id, tenant_id, wa_id, direction, text, timestamp, raw_payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_id) DO NOTHING
    `);

    stmt.run(
      messageId || null,
      tenantId,
      waId,
      direction,
      text,
      timestamp || new Date().toISOString(),
      rawPayload ? JSON.stringify(rawPayload) : null,
      new Date().toISOString()
    );

    if (direction === 'out') {
      this.updateLead(waId, { last_outbound_message_at: timestamp || new Date().toISOString() }, tenantId);
    }
  }

  /**
   * Retrieves conversation history for a lead bounded by limit, optionally filtered by tenant
   */
  getConversationHistory(waId, limit = 20, tenantId = null) {
    let innerSql = 'SELECT * FROM messages WHERE wa_id = ?';
    const params = [waId];

    if (tenantId) {
      innerSql += ' AND tenant_id = ?';
      params.push(tenantId);
    }

    innerSql += ' ORDER BY id DESC LIMIT ?';
    params.push(limit);

    const sql = `SELECT * FROM (${innerSql}) ORDER BY id ASC`;
    const rows = this.db.prepare(sql).all(...params);

    return rows.map(r => ({
      id: r.id,
      message_id: r.message_id,
      tenant_id: r.tenant_id,
      direction: r.direction,
      text: r.text,
      timestamp: r.timestamp,
      created_at: r.created_at
    }));
  }

  /**
   * Lists leads with filters, sorting, and pagination with strict multi-tenant scoping
   */
  listLeads({ tenantId = null, status, needsHuman, sortBy = 'recency', limit = 50, offset = 0 } = {}) {
    const conditions = [];
    const params = [];

    if (tenantId) {
      conditions.push('tenant_id = ?');
      params.push(tenantId);
    }

    if (status) {
      conditions.push('status = ?');
      params.push(status);
    }

    if (typeof needsHuman === 'boolean') {
      conditions.push('needs_human = ?');
      params.push(needsHuman ? 1 : 0);
    }

    let orderClause = 'ORDER BY last_inbound_message_at DESC';
    if (sortBy === 'oldest') {
      orderClause = 'ORDER BY last_inbound_message_at ASC';
    } else if (sortBy === 'created_recent') {
      orderClause = 'ORDER BY first_contact_at DESC';
    } else if (sortBy === 'needs_human_first') {
      orderClause = 'ORDER BY needs_human DESC, last_inbound_message_at DESC';
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT * FROM leads ${whereClause} ${orderClause} LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params);

    const countSql = `SELECT COUNT(*) as total FROM leads ${whereClause}`;
    const totalCount = this.db.prepare(countSql).get(...params.slice(0, params.length - 2)).total;

    return {
      total: totalCount,
      limit,
      offset,
      leads: rows.map(r => this.formatLead(r))
    };
  }
}

module.exports = new LeadRepository();
module.exports.LeadRepository = LeadRepository;


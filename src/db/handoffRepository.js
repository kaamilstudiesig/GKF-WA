const { getDatabase } = require('./database');
const logger = require('../utils/logger');

class HandoffRepository {
  constructor(db = null) {
    this.customDb = db;
  }

  get db() {
    return this.customDb || getDatabase();
  }

  /**
   * Persists or updates a human handoff record for a lead.
   * Ensures handoffs are strictly tenant-scoped and tracked.
   */
  recordHandoff({ tenantId = 'goldkraft', waId, reason, summary = null }) {
    const targetTenant = tenantId || 'goldkraft';
    const now = new Date().toISOString();

    const checkStmt = this.db.prepare(`
      SELECT id FROM handoffs
      WHERE tenant_id = ? AND wa_id = ? AND status IN ('pending', 'assigned')
      ORDER BY id DESC LIMIT 1
    `);
    const existing = checkStmt.get(targetTenant, waId);

    if (existing) {
      const updateStmt = this.db.prepare(`
        UPDATE handoffs
        SET reason = ?, summary = COALESCE(?, summary), updated_at = ?
        WHERE id = ?
      `);
      updateStmt.run(reason, summary, now, existing.id);
      logger.info('Updated existing active handoff record', { handoff_id: existing.id, tenant_id: targetTenant, wa_id: waId, reason });
      return existing.id;
    }

    const insertStmt = this.db.prepare(`
      INSERT INTO handoffs (tenant_id, wa_id, status, reason, summary, created_at, updated_at)
      VALUES (?, ?, 'pending', ?, ?, ?, ?)
    `);
    const result = insertStmt.run(targetTenant, waId, reason, summary, now, now);
    logger.info('Created new active handoff record', { handoff_id: result.lastInsertRowid, tenant_id: targetTenant, wa_id: waId, reason });
    return result.lastInsertRowid;
  }

  /**
   * Resolves active handoffs for a lead under a tenant
   */
  resolveHandoff(tenantId = 'goldkraft', waId) {
    const targetTenant = tenantId || 'goldkraft';
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      UPDATE handoffs
      SET status = 'resolved', resolved_at = ?, updated_at = ?
      WHERE tenant_id = ? AND wa_id = ? AND status IN ('pending', 'assigned')
    `);
    const result = stmt.run(now, now, targetTenant, waId);
    return result.changes;
  }

  /**
   * Lists handoffs for a tenant
   */
  listHandoffs(tenantId = 'goldkraft', status = null, limit = 50) {
    const targetTenant = tenantId || 'goldkraft';
    let sql = 'SELECT * FROM handoffs WHERE tenant_id = ?';
    const params = [targetTenant];

    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }

    sql += ' ORDER BY id DESC LIMIT ?';
    params.push(limit);

    return this.db.prepare(sql).all(...params);
  }
}

module.exports = new HandoffRepository();
module.exports.HandoffRepository = HandoffRepository;

const { getDatabase } = require('../db/database');
const logger = require('../utils/logger');

class AuditService {
  constructor(db = null) {
    this.customDb = db;
  }

  get db() {
    return this.customDb || getDatabase();
  }

  /**
   * Records an audit log entry for security and administrative actions.
   */
  recordAudit({
    tenantId = 'goldkraft',
    actorId = 'system',
    actorRole = 'system',
    action,
    targetType,
    targetId,
    changes = {},
    ipAddress = null
  }) {
    const now = new Date().toISOString();
    const changesJson = typeof changes === 'object' ? JSON.stringify(changes) : String(changes);

    try {
      const stmt = this.db.prepare(`
        INSERT INTO audit_logs (
          tenant_id, actor_id, actor_role, action, target_type,
          target_id, changes_json, ip_address, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        tenantId,
        actorId,
        actorRole,
        action,
        targetType,
        targetId,
        changesJson,
        ipAddress,
        now
      );

      logger.info('Audit event logged', {
        tenant_id: tenantId,
        actor_id: actorId,
        action,
        target_type: targetType,
        target_id: targetId
      });
    } catch (err) {
      logger.error('Failed to write audit log:', { error: err.message });
    }
  }

  /**
   * Retrieves audit logs for a tenant
   */
  listAuditLogs(tenantId = 'goldkraft', limit = 50) {
    const stmt = this.db.prepare(`
      SELECT * FROM audit_logs
      WHERE tenant_id = ?
      ORDER BY id DESC
      LIMIT ?
    `);

    const rows = stmt.all(tenantId, limit);
    return rows.map(r => ({
      ...r,
      changes: r.changes_json ? JSON.parse(r.changes_json) : null
    }));
  }
}

module.exports = new AuditService();
module.exports.AuditService = AuditService;

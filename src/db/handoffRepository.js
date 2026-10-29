const db = require('./index');
const logger = require('../utils/logger');
const notifyService = require('../services/notifyService');

/** Hand-offs from the bot to human staff. A lead has at most one open hand-off. */
const handoffRepository = {
  /**
   * Opens a hand-off, or updates the reason on the lead's open one.
   * Staff are alerted only when a new hand-off is opened.
   */
  async open({ waId, reason, summary = null }) {
    const row = await db.one(`
      INSERT INTO handoffs (wa_id, reason, summary) VALUES ($1, $2, $3)
      ON CONFLICT (wa_id) WHERE status IN ('pending', 'assigned')
      DO UPDATE SET reason = EXCLUDED.reason, summary = COALESCE(EXCLUDED.summary, handoffs.summary), updated_at = now()
      RETURNING id, (xmax = 0) AS inserted`, [waId, reason, summary]);
    if (row.inserted) {
      logger.info('Opened human hand-off', { handoff_id: row.id, wa_id: waId, reason });
      notifyService.notifyHandoff({ waId, reason, summary });
    }
    return row.id;
  },

  async resolve(waId) {
    const res = await db.query(`
      UPDATE handoffs SET status = 'resolved', resolved_at = now(), updated_at = now()
      WHERE wa_id = $1 AND status IN ('pending', 'assigned')`, [waId]);
    return res.rowCount;
  },

  async list({ status = null, limit = 50 } = {}) {
    return status
      ? db.many('SELECT * FROM handoffs WHERE status = $1 ORDER BY id DESC LIMIT $2', [status, limit])
      : db.many('SELECT * FROM handoffs ORDER BY id DESC LIMIT $1', [limit]);
  }
};

module.exports = handoffRepository;

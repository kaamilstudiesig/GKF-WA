const db = require('./index');
const logger = require('../utils/logger');

const STALE_SECONDS = 120;

/**
 * Durable queue of inbound WhatsApp messages. The webhook stores each message
 * here and answers Meta immediately; workers then process them.
 */
const eventRepository = {
  /** Stores an event once. Returns its id, or null if it was already stored. */
  async record({ eventKey, waId = null, messageId = null, payload, maxAttempts = 5 }) {
    const row = await db.one(`
      INSERT INTO webhook_events (event_key, wa_id, message_id, payload, max_attempts)
      VALUES ($1, $2, $3, $4::jsonb, $5)
      ON CONFLICT (event_key) DO NOTHING
      RETURNING id`, [eventKey, waId, messageId, JSON.stringify(payload), maxAttempts]);
    return row ? row.id : null;
  },

  /**
   * Claims the next ready event (or one whose worker died). Messages from the
   * same lead are handled strictly in order, one at a time, so replies never
   * cross; different leads are processed in parallel.
   */
  async claimNext(staleSeconds = STALE_SECONDS) {
    return db.one(`
      UPDATE webhook_events e
      SET status = 'processing', locked_at = now(), attempts = e.attempts + 1, updated_at = now()
      WHERE e.id = (
        SELECT c.id FROM webhook_events c
        WHERE ((c.status = 'pending' AND c.available_at <= now())
            OR (c.status = 'processing' AND c.locked_at <= now() - make_interval(secs => $1)))
          AND NOT EXISTS (
            SELECT 1 FROM webhook_events p
            WHERE c.wa_id IS NOT NULL AND p.wa_id = c.wa_id AND p.id <> c.id
              AND ((p.status = 'processing' AND p.locked_at > now() - make_interval(secs => $1))
                OR (p.status IN ('pending', 'processing') AND p.id < c.id)))
        ORDER BY c.id
        FOR UPDATE SKIP LOCKED
        LIMIT 1)
      RETURNING e.*`, [staleSeconds]);
  },

  async complete(id) {
    await db.query(`UPDATE webhook_events SET status = 'completed', processed_at = now(), locked_at = NULL, updated_at = now()
      WHERE id = $1`, [id]);
  },

  /** Retries with exponential backoff, or gives up after max_attempts. */
  async fail(id, errorMessage, baseDelaySec = 5) {
    const row = await db.one('SELECT attempts, max_attempts FROM webhook_events WHERE id = $1', [id]);
    if (!row) return;
    if (row.attempts >= row.max_attempts) {
      logger.warn('Webhook event gave up after max attempts', { id, attempts: row.attempts });
      await db.query(`UPDATE webhook_events SET status = 'dead_letter', last_error = $2, locked_at = NULL, updated_at = now()
        WHERE id = $1`, [id, String(errorMessage).slice(0, 2000)]);
      return;
    }
    const delaySec = baseDelaySec * 2 ** Math.max(0, row.attempts - 1) + (baseDelaySec ? Math.random() : 0);
    await db.query(`UPDATE webhook_events SET status = 'pending', available_at = now() + make_interval(secs => $3),
      last_error = $2, locked_at = NULL, updated_at = now() WHERE id = $1`, [id, String(errorMessage).slice(0, 2000), delaySec]);
  },

  async failPermanent(id, errorMessage) {
    await db.query(`UPDATE webhook_events SET status = 'failed', last_error = $2, locked_at = NULL, updated_at = now()
      WHERE id = $1`, [id, String(errorMessage).slice(0, 2000)]);
  },

  /** Deletes finished events older than `days`; dead letters are kept for inspection. */
  async cleanup(days = 14) {
    const res = await db.query(`DELETE FROM webhook_events WHERE status IN ('completed', 'failed')
      AND updated_at < now() - make_interval(days => $1)`, [days]);
    return res.rowCount;
  }
};

module.exports = eventRepository;

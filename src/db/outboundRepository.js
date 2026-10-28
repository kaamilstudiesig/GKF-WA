const db = require('./index');
const logger = require('../utils/logger');

/**
 * Durable queue of WhatsApp replies waiting to be sent (bot replies and, later,
 * staff replies from the CRM). dedup_key makes enqueueing idempotent.
 */
const outboundRepository = {
  async enqueue({ dedupKey = null, waId, text, metadata = {}, maxAttempts = 5 }) {
    const row = await db.one(`
      INSERT INTO outbound_messages (dedup_key, wa_id, text, metadata, max_attempts)
      VALUES ($1, $2, $3, $4::jsonb, $5)
      ON CONFLICT (dedup_key) DO NOTHING
      RETURNING id`, [dedupKey, waId, text, JSON.stringify(metadata || {}), maxAttempts]);
    return row ? row.id : null;
  },

  async findByDedupKey(dedupKey) {
    if (!dedupKey) return null;
    return db.one('SELECT * FROM outbound_messages WHERE dedup_key = $1', [dedupKey]);
  },

  async claimNext(staleSeconds = 60) {
    return db.one(`
      UPDATE outbound_messages o
      SET status = 'sending', locked_at = now(), attempts = o.attempts + 1, updated_at = now()
      WHERE o.id = (
        SELECT id FROM outbound_messages
        WHERE (status = 'pending' AND available_at <= now())
           OR (status = 'sending' AND locked_at <= now() - make_interval(secs => $1))
        ORDER BY id
        FOR UPDATE SKIP LOCKED
        LIMIT 1)
      RETURNING o.*`, [staleSeconds]);
  },

  async markSent(id, providerMessageId = null) {
    await db.query(`UPDATE outbound_messages SET status = 'sent', provider_message_id = $2, sent_at = now(),
      locked_at = NULL, updated_at = now() WHERE id = $1`, [id, providerMessageId]);
  },

  async markFailed(id, errorMessage, retryable = true, baseDelaySec = 5) {
    const row = await db.one('SELECT attempts, max_attempts FROM outbound_messages WHERE id = $1', [id]);
    if (!row) return;
    const error = String(errorMessage).slice(0, 2000);
    if (!retryable || row.attempts >= row.max_attempts) {
      logger.warn('Outbound message permanently failed', { id, retryable, attempts: row.attempts });
      await db.query(`UPDATE outbound_messages SET status = 'failed', last_error = $2, failed_at = now(),
        locked_at = NULL, updated_at = now() WHERE id = $1`, [id, error]);
      return;
    }
    const delaySec = baseDelaySec * 2 ** Math.max(0, row.attempts - 1) + (baseDelaySec ? Math.random() : 0);
    await db.query(`UPDATE outbound_messages SET status = 'pending', available_at = now() + make_interval(secs => $3),
      last_error = $2, locked_at = NULL, updated_at = now() WHERE id = $1`, [id, error, delaySec]);
  },

  /** Sent replies are already in the conversation history; drop the queue rows after `days`. */
  async cleanup(days = 30) {
    const res = await db.query(`DELETE FROM outbound_messages WHERE status = 'sent'
      AND updated_at < now() - make_interval(days => $1)`, [days]);
    return res.rowCount;
  }
};

module.exports = outboundRepository;

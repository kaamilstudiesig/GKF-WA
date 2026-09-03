const { getDatabase, runTransaction } = require('./database');
const logger = require('../utils/logger');

class EventRepository {
  constructor(db = null) {
    this.customDb = db;
  }

  get db() {
    return this.customDb || getDatabase();
  }

  /**
   * Atomically records an inbound webhook event.
   * Guaranteed idempotent via UNIQUE constraint on event_key.
   * @param {object} param0
   * @returns {{ inserted: boolean, id: number|null }}
   */
  recordEvent({ eventKey, tenantId = 'goldkraft', messageId = null, eventType = 'message', payload, maxAttempts = 5 }) {
    const now = new Date().toISOString();
    const payloadJson = typeof payload === 'string' ? payload : JSON.stringify(payload);

    try {
      const stmt = this.db.prepare(`
        INSERT INTO webhook_events (
          event_key, tenant_id, message_id, event_type, payload_json,
          status, attempts, max_attempts, available_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)
        ON CONFLICT(event_key) DO NOTHING
      `);

      const result = stmt.run(
        eventKey,
        tenantId,
        messageId,
        eventType,
        payloadJson,
        maxAttempts,
        now,
        now,
        now
      );

      const inserted = result.changes > 0;
      return {
        inserted,
        id: inserted ? result.lastInsertRowid : null
      };
    } catch (err) {
      logger.error('Failed to record webhook event:', { eventKey, error: err.message });
      throw err;
    }
  }

  /**
   * Reserves the next available pending event or reclaims a stale processing event.
   * Atomic operation executed inside a transaction.
   * @param {number} lockDurationSec
   * @returns {object|null}
   */
  getNextPendingEvent(lockDurationSec = 60) {
    return runTransaction((txDb) => {
      const now = new Date().toISOString();
      const staleCutoff = new Date(Date.now() - lockDurationSec * 1000).toISOString();

      // Find pending event ready to process OR stale processing event
      const findStmt = txDb.prepare(`
        SELECT * FROM webhook_events
        WHERE (status = 'pending' AND available_at <= ?)
           OR (status = 'processing' AND locked_at <= ?)
        ORDER BY id ASC
        LIMIT 1
      `);

      const event = findStmt.get(now, staleCutoff);
      if (!event) return null;

      // Lock event for processing
      const updateStmt = txDb.prepare(`
        UPDATE webhook_events
        SET status = 'processing',
            locked_at = ?,
            attempts = attempts + 1,
            updated_at = ?
        WHERE id = ?
      `);

      updateStmt.run(now, now, event.id);

      return {
        ...event,
        status: 'processing',
        payload: JSON.parse(event.payload_json),
        attempts: event.attempts + 1
      };
    }, this.db);
  }

  /**
   * Marks event processing as completed
   */
  completeEvent(id) {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE webhook_events
      SET status = 'completed',
          processed_at = ?,
          locked_at = NULL,
          updated_at = ?
      WHERE id = ?
    `);
    stmt.run(now, now, id);
  }

  /**
   * Marks event as failed and schedules retry with exponential backoff,
   * or transitions to dead_letter if max_attempts reached.
   */
  failEvent(id, errorMessage, baseDelaySec = 5) {
    const now = new Date().toISOString();
    const event = this.db.prepare('SELECT attempts, max_attempts FROM webhook_events WHERE id = ?').get(id);
    if (!event) return;

    if (event.attempts >= event.max_attempts) {
      logger.warn('Webhook event reached max attempts, moving to dead_letter', { id, attempts: event.attempts });
      const deadStmt = this.db.prepare(`
        UPDATE webhook_events
        SET status = 'dead_letter',
            last_error = ?,
            locked_at = NULL,
            updated_at = ?
        WHERE id = ?
      `);
      deadStmt.run(errorMessage, now, id);
      return;
    }

    // Exponential backoff with jitter: delay = base * 2^(attempts-1) + jitter
    const exponentialMultiplier = Math.pow(2, Math.max(0, event.attempts - 1));
    const jitterMs = baseDelaySec === 0 ? 0 : Math.floor(Math.random() * 1000);
    const delayMs = (baseDelaySec * exponentialMultiplier * 1000) + jitterMs;
    const availableAt = new Date(Date.now() + delayMs).toISOString();

    const retryStmt = this.db.prepare(`
      UPDATE webhook_events
      SET status = 'pending',
          available_at = ?,
          last_error = ?,
          locked_at = NULL,
          updated_at = ?
      WHERE id = ?
    `);
    retryStmt.run(availableAt, errorMessage, now, id);
  }

  /**
   * Marks event permanently failed (non-retryable validation error)
   */
  failPermanent(id, errorMessage) {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE webhook_events
      SET status = 'failed',
          last_error = ?,
          locked_at = NULL,
          updated_at = ?
      WHERE id = ?
    `);
    stmt.run(errorMessage, now, id);
  }

  /**
   * Checks if an event key has already been recorded
   */
  hasEventKey(eventKey) {
    const stmt = this.db.prepare('SELECT 1 FROM webhook_events WHERE event_key = ? LIMIT 1');
    return Boolean(stmt.get(eventKey));
  }
}

module.exports = new EventRepository();
module.exports.EventRepository = EventRepository;

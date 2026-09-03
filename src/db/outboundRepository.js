const { getDatabase, runTransaction } = require('./database');
const logger = require('../utils/logger');

class OutboundRepository {
  constructor(db = null) {
    this.customDb = db;
  }

  get db() {
    return this.customDb || getDatabase();
  }

  /**
   * Enqueues an outbound WhatsApp message.
   * Atomically idempotent if dedupKey is provided.
   * @param {object} param0
   * @returns {{ inserted: boolean, id: number|null }}
   */
  enqueueOutbound({ dedupKey = null, tenantId = 'goldkraft', waId, text, metadata = null, maxAttempts = 5 }) {
    const now = new Date().toISOString();
    const metadataJson = metadata ? JSON.stringify(metadata) : null;

    try {
      const stmt = this.db.prepare(`
        INSERT INTO outbound_messages (
          dedup_key, tenant_id, wa_id, text, status,
          attempts, max_attempts, available_at, metadata_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?)
        ON CONFLICT(dedup_key) DO NOTHING
      `);

      const result = stmt.run(
        dedupKey,
        tenantId,
        waId,
        text,
        maxAttempts,
        now,
        metadataJson,
        now,
        now
      );

      const inserted = result.changes > 0;
      return {
        inserted,
        id: inserted ? result.lastInsertRowid : null
      };
    } catch (err) {
      logger.error('Failed to enqueue outbound message:', { waId, dedupKey, error: err.message });
      throw err;
    }
  }

  /**
   * Reserves the next outbound message ready to send or reclaims stale sending message.
   * @param {number} lockDurationSec
   * @returns {object|null}
   */
  getNextPendingMessage(lockDurationSec = 60) {
    return runTransaction((txDb) => {
      const now = new Date().toISOString();
      const staleCutoff = new Date(Date.now() - lockDurationSec * 1000).toISOString();

      const findStmt = txDb.prepare(`
        SELECT * FROM outbound_messages
        WHERE (status = 'pending' AND available_at <= ?)
           OR (status = 'sending' AND locked_at <= ?)
        ORDER BY id ASC
        LIMIT 1
      `);

      const message = findStmt.get(now, staleCutoff);
      if (!message) return null;

      const updateStmt = txDb.prepare(`
        UPDATE outbound_messages
        SET status = 'sending',
            locked_at = ?,
            attempts = attempts + 1,
            updated_at = ?
        WHERE id = ? AND ((status = 'pending' AND available_at <= ?) OR (status = 'sending' AND locked_at <= ?))
      `);

      const result = updateStmt.run(now, now, message.id, now, staleCutoff);
      if (result.changes === 0) return null; // Another worker claimed this job

      return {
        ...message,
        metadata: message.metadata_json ? JSON.parse(message.metadata_json) : null,
        attempts: message.attempts + 1
      };
    }, this.db);
  }

  /**
   * Marks outbound message as successfully sent
   */
  markSent(id, providerMessageId = null) {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE outbound_messages
      SET status = 'sent',
          provider_message_id = ?,
          sent_at = ?,
          locked_at = NULL,
          updated_at = ?
      WHERE id = ?
    `);
    stmt.run(providerMessageId, now, now, id);
  }

  /**
   * Marks outbound message as failed or reschedules with exponential backoff if retryable.
   */
  markFailed(id, errorMessage, isRetryable = true, baseDelaySec = 5) {
    const now = new Date().toISOString();
    const message = this.db.prepare('SELECT attempts, max_attempts FROM outbound_messages WHERE id = ?').get(id);
    if (!message) return;

    if (!isRetryable || message.attempts >= message.max_attempts) {
      logger.warn('Outbound message marked permanently failed', { id, isRetryable, attempts: message.attempts });
      const failStmt = this.db.prepare(`
        UPDATE outbound_messages
        SET status = 'failed',
            last_error = ?,
            failed_at = ?,
            locked_at = NULL,
            updated_at = ?
        WHERE id = ?
      `);
      failStmt.run(errorMessage, now, now, id);
      return;
    }

    // Exponential backoff with jitter
    const exponentialMultiplier = Math.pow(2, Math.max(0, message.attempts - 1));
    const jitterMs = Math.floor(Math.random() * 1000);
    const delayMs = (baseDelaySec * exponentialMultiplier * 1000) + jitterMs;
    const availableAt = new Date(Date.now() + delayMs).toISOString();

    const retryStmt = this.db.prepare(`
      UPDATE outbound_messages
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
   * Finds outbound message by dedup key
   */
  findByDedupKey(dedupKey) {
    if (!dedupKey) return null;
    const stmt = this.db.prepare('SELECT * FROM outbound_messages WHERE dedup_key = ? LIMIT 1');
    return stmt.get(dedupKey);
  }

  /**
   * Resets stale sending messages back to pending for worker recovery
   */
  recoverStaleLocks(staleSeconds = 60) {
    const cutoff = new Date(Date.now() - staleSeconds * 1000).toISOString();
    const stmt = this.db.prepare(`
      UPDATE outbound_messages
      SET status = 'pending',
          locked_at = NULL,
          updated_at = datetime('now')
      WHERE status = 'sending' AND locked_at <= ?
    `);
    const result = stmt.run(cutoff);
    return result.changes;
  }
}

module.exports = new OutboundRepository();
module.exports.OutboundRepository = OutboundRepository;

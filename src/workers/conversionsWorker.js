const QueueWorker = require('./queueWorker');
const db = require('../db');
const conversionsApi = require('../services/conversionsApi');
const opsAlerts = require('../services/opsAlerts');
const logger = require('../utils/logger');

const MAX_ATTEMPTS = 5;

/**
 * Sends CRM outcomes (Visit booked, Joined) to Meta's Conversions API, each exactly once.
 * State lives on crm_lead_outcomes: meta_status null -> sending -> sent | skipped | failed (retried) | dead.
 * Only outcomes from the last 7 days are sent; Meta does not attribute older ones.
 */
async function claimNext() {
  return db.one(`
    UPDATE crm_lead_outcomes o
    SET meta_status = 'sending', meta_attempts = o.meta_attempts + 1
    WHERE o.id = (
      SELECT id FROM crm_lead_outcomes
      WHERE outcome IN ('visit_booked', 'joined') AND sent_to_meta_at IS NULL
        AND (meta_status IS NULL OR (meta_status = 'failed' AND meta_attempts < $1))
        AND created_at > now() - interval '7 days'
      ORDER BY id
      FOR UPDATE SKIP LOCKED
      LIMIT 1)
    RETURNING o.*`, [MAX_ATTEMPTS]);
}

const mark = (id, status, fields = {}) => db.query(`
  UPDATE crm_lead_outcomes SET meta_status = $2, meta_event = COALESCE($3, meta_event), meta_error = $4,
    sent_to_meta_at = CASE WHEN $2 = 'sent' THEN now() ELSE sent_to_meta_at END
  WHERE id = $1`, [id, status, fields.event || null, fields.error ? String(fields.error).slice(0, 1000) : null]);

async function sendOne(outcome) {
  const lead = await db.one('SELECT wa_id, phone, metadata FROM leads WHERE wa_id = $1', [outcome.wa_id]);
  const built = conversionsApi.buildEvent(outcome, lead);
  if (built.skip) {
    await mark(outcome.id, 'skipped', { error: built.skip });
    logger.info('Conversions API: outcome not sent', { id: outcome.id, reason: built.skip });
    return;
  }
  try {
    const res = await conversionsApi.send([built.event]);
    await mark(outcome.id, 'sent', { event: built.event.event_name });
    logger.info('Conversions API: event sent', { id: outcome.id, event: built.event.event_name, received: res?.events_received });
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data?.error?.message || err.message;
    const retryable = !status || status === 429 || status >= 500;
    const dead = !retryable || outcome.meta_attempts >= MAX_ATTEMPTS;
    await mark(outcome.id, dead ? 'dead' : 'failed', { event: built.event.event_name, error: detail });
    logger.warn('Conversions API: send failed', { id: outcome.id, status, retryable, error: detail });
    if (dead) {
      opsAlerts.alert('capi:failed', 'Sales events are not reaching Meta', [
        `Conversions API error${status ? ` ${status}` : ''}: ${detail}`,
        'Check META_DATASET_ID and that the token has whatsapp_business_manage_events.'
      ]);
    }
  }
}

const conversionsWorker = new QueueWorker('Conversions API worker', {
  claim: claimNext,
  handle: sendOne,
  concurrency: 1,
  intervalMs: 60 * 1000
});

module.exports = conversionsWorker;
module.exports.sendOne = sendOne;
module.exports.claimNext = claimNext;

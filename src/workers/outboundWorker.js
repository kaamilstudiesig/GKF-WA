const QueueWorker = require('./queueWorker');
const replyTimes = require('../services/replyTimes');
const outboundRepository = require('../db/outboundRepository');
const whatsappService = require('../services/whatsappService');
const opsAlerts = require('../services/opsAlerts');
const logger = require('../utils/logger');
const env = require('../config/env');
const signals = require('./signals');
const registry = require('../tenancy/registry');
const leadRepository = require('../db/leadRepository');
const { captureException } = require('../utils/sentry');

/** Network errors, rate limits and Meta 5xx are worth retrying; 4xx are not. */
function isRetryable(err) {
  if (!err.response) return true;
  const status = err.response.status;
  return status === 429 || status >= 500;
}

async function sendOne(job) {
  const tenant = registry.config();
  if (tenant && !tenant.active) { // suspended: never send for it
    await outboundRepository.markFailed(job.id, `Tenant ${tenant.slug} is suspended`, false);
    return;
  }
  // K30: a reply queued before the lead wrote STOP (e.g. "hi" then "stop" quickly) is dropped.
  if (!job.metadata?.template && !job.metadata?.opt_out) {
    const at = await leadRepository.optedOutAt(job.wa_id);
    if (at && new Date(at) >= new Date(job.created_at)) {
      logger.info('Reply not sent: lead opted out after it was queued', { id: job.id });
      await outboundRepository.markFailed(job.id, 'Lead opted out after this reply was queued', false);
      return;
    }
  }
  try {
    const providerId = job.metadata?.template
      ? await whatsappService.sendTemplate(job.wa_id, job.metadata.template, { staffAlert: Boolean(job.metadata.staff_alert) }) // staff alerts
      : await whatsappService.sendText(job.wa_id, job.text, {
        buttons: job.metadata?.buttons, location: job.metadata?.location
      });
    await outboundRepository.markSent(job.id, providerId);
    await replyTimes.record(job); // K27: reply time for automatic replies (never throws)
  } catch (err) {
    if (err.optedOut) { // K30: expected, not an error: never retry, never page anyone
      logger.info('Template not sent: lead opted out', { id: job.id });
      await outboundRepository.markFailed(job.id, err.message, false);
      return;
    }
    const retryable = isRetryable(err);
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    captureException(err, { component: 'outbound_worker', jobId: job.id, retryable });
    logger.error('WhatsApp send failed', { id: job.id, retryable, error: detail });
    const final = await outboundRepository.markFailed(job.id, detail, retryable);
    // K27: a reply that never went out counts as a miss, so failures can't flatter the figure.
    if (final) await replyTimes.record(job, new Date(), { outcome: 'failed' });
    opsAlerts.sendFailed(err); // pages us when it's an account problem (token, payment, ban)
  }
}

const outboundWorker = new QueueWorker('Outbound WhatsApp worker', {
  claim: () => outboundRepository.claimNext(),
  handle: sendOne,
  concurrency: 2,
  intervalMs: env.queuePollMs
});
// The CRM (and anything else) can wake the sender as soon as it queues a message.
signals.on('outbound', () => { if (outboundWorker.running) outboundWorker.kick(); });

module.exports = outboundWorker;
module.exports.isRetryable = isRetryable;
module.exports.sendOne = sendOne;

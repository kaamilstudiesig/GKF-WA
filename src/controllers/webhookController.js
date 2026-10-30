const env = require('../config/env');
const eventRepository = require('../db/eventRepository');
const leadRepository = require('../db/leadRepository');
const identity = require('../services/identity');
const webhookWorker = require('../workers/webhookWorker');
const logger = require('../utils/logger');

/** GET /webhook: Meta's one-time verification handshake. */
function verifyWebhook(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (!mode || !token) return res.status(400).json({ error: 'Missing required hub parameters' });
  if (mode === 'subscribe' && env.metaWebhookVerifyToken && token === env.metaWebhookVerifyToken) {
    logger.info('Webhook verification handshake successful');
    return res.status(200).send(challenge);
  }
  logger.warn('Webhook verification failed: token mismatch');
  return res.status(403).json({ error: 'Verification token mismatch' });
}

/**
 * POST /webhook: stores each inbound message in the queue and answers Meta
 * right away (Meta retries if it doesn't get a 200 quickly). Workers reply.
 */
async function handleIncoming(req, res) {
  const body = req.body || {};
  if (body.object !== 'whatsapp_business_account') {
    return res.status(404).json({ error: 'Not a whatsapp_business_account event' });
  }

  try {
    let queued = 0;
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const phoneNumberId = value.metadata?.phone_number_id;

        // Only handle traffic for our own WhatsApp number.
        if (env.metaPhoneNumberId && phoneNumberId && phoneNumberId !== env.metaPhoneNumberId) {
          logger.warn('Ignoring webhook for a different WhatsApp number', { phone_number_id: phoneNumberId });
          continue;
        }

        // Delivery receipts: only failures are worth attention.
        for (const s of value.statuses || []) {
          if (s.status === 'failed') {
            logger.warn('WhatsApp reported a failed delivery', {
              message_id: s.id, code: s.errors?.[0]?.code, title: s.errors?.[0]?.title
            });
          }
        }

        const contacts = value.contacts || [];
        for (const msg of value.messages || []) {
          // Match the contact by BSUID first (always sent), then by phone.
          const contact = contacts.find(c => msg.from_user_id && c.user_id === msg.from_user_id)
            || contacts.find(c => msg.from && c.wa_id === msg.from) || contacts[0] || null;

          // Meta tells us when a user's BSUID changes; move it onto the lead, no reply.
          if (msg.type === 'system') {
            const sys = msg.system || {};
            if (sys.type === 'user_changed_number' || sys.type === 'user_changed_user_id') {
              const key = await leadRepository.applyIdChange({
                previousUserId: sys.previous_user_id, userId: sys.user_id || msg.from_user_id, phone: sys.wa_id
              });
              logger.info('WhatsApp user ID changed', { type: sys.type, matched: Boolean(key) });
            }
            continue;
          }

          const ids = identity.fromWebhook(msg, contact);
          if ((!ids.phone && !ids.userId) || !msg.id) {
            logger.warn('Skipping message without sender or id');
            continue;
          }
          if (await leadRepository.hasMessage(msg.id)) continue; // Meta re-delivery
          const waId = await leadRepository.resolveKey(ids);
          const id = await eventRepository.record({
            eventKey: `msg:${msg.id}`, waId, messageId: msg.id, payload: { msg, contact, ids }
          });
          if (id) queued++;
        }
      }
    }
    if (queued && webhookWorker.running) webhookWorker.kick();
    return res.status(200).json({ status: 'success' });
  } catch (err) {
    logger.error('Failed to store incoming webhook', { error: err.message });
    // 500 makes Meta retry; storing is idempotent so retries are safe.
    return res.status(500).json({ status: 'error' });
  }
}

module.exports = { verifyWebhook, handleIncoming };

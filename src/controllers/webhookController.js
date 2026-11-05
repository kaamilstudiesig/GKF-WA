const env = require('../config/env');
const eventRepository = require('../db/eventRepository');
const leadRepository = require('../db/leadRepository');
const identity = require('../services/identity');
const opsAlerts = require('../services/opsAlerts');
const webhookWorker = require('../workers/webhookWorker');
const logger = require('../utils/logger');
const tenancy = require('../tenancy/context');
const registry = require('../tenancy/registry');

// Messages that can be part of a burst of typing (answered once, after a short wait).
const TEXT_TYPES = new Set(['text', 'button', 'interactive']);

/** GET /webhook (shared app) or /webhook/:slug (a tenant's own app): Meta's one-time verification handshake. */
function verifyWebhook(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (!mode || !token) return res.status(400).json({ error: 'Missing required hub parameters' });
  const expected = req.tenant ? req.tenant.whatsapp.verifyToken : env.metaWebhookVerifyToken;
  if (mode === 'subscribe' && expected && token === expected) {
    logger.info('Webhook verification handshake successful');
    return res.status(200).send(challenge);
  }
  logger.warn('Webhook verification failed: token mismatch');
  return res.status(403).json({ error: 'Verification token mismatch' });
}

/** Stores one webhook change for the current tenant. Returns how many messages were queued. */
async function handleChange(change, value) {
  // Account warnings, bans, quality/limit changes: alert whoever runs this tenant's bot.
  if (opsAlerts.isAccountField(change.field)) {
    opsAlerts.accountEvent(change.field, value);
    return 0;
  }
  let queued = 0;
  // Delivery receipts: only failures are worth attention.
  for (const s of value.statuses || []) {
    if (s.status === 'failed') {
      logger.warn('WhatsApp reported a failed delivery', {
        message_id: s.id, code: s.errors?.[0]?.code, title: s.errors?.[0]?.title
      });
      opsAlerts.deliveryFailed(s.errors?.[0]);
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
      eventKey: `msg:${msg.id}`, waId, messageId: msg.id, payload: { msg, contact, ids },
      delayMs: TEXT_TYPES.has(msg.type) ? env.burstSettleMs : 0 // let a burst of texts arrive first
    });
    if (id) queued++;
  }
  return queued;
}

/**
 * Which tenant a webhook change belongs to, or null to ignore it.
 * - /webhook/:slug (the tenant's own Meta app): only that tenant's number is accepted.
 * - /webhook (our shared Meta app): the tenant that owns the phone number id.
 *   Account events carry no number; the WABA id (entry.id) finds the tenant.
 * Tenant 1 with no number configured (local development) takes unmatched traffic.
 */
async function tenantFor(req, entry, value) {
  const phoneNumberId = value.metadata?.phone_number_id ? String(value.metadata.phone_number_id) : null;
  let tenant = null;
  if (req.tenant) {
    const own = req.tenant.whatsapp.phoneNumberId;
    tenant = !phoneNumberId || !own || own === phoneNumberId ? req.tenant : null;
  } else if (phoneNumberId) {
    tenant = await registry.byPhoneNumberId(phoneNumberId);
  } else if (entry.id) {
    tenant = registry.list().find(t => t.whatsapp.wabaId && t.whatsapp.wabaId === String(entry.id)) || null;
  }
  if (!tenant && !req.tenant) {
    const fallback = registry.config(registry.DEFAULT_TENANT_ID);
    if (fallback && !fallback.whatsapp.phoneNumberId) tenant = fallback; // dev: no number set, take everything
  }
  if (!tenant) {
    logger.warn('Ignoring webhook for a WhatsApp number no tenant owns', { phone_number_id: phoneNumberId, waba: entry.id });
    return null;
  }
  if (tenant.status !== 'active') {
    logger.warn('Ignoring webhook for a suspended tenant', { tenant: tenant.slug });
    return null;
  }
  return tenant;
}

/**
 * POST /webhook: stores each inbound message in the queue and answers Meta
 * right away (Meta retries if it doesn't get a 200 quickly). Workers reply.
 * Each change is stored as the tenant that owns its WhatsApp number.
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
        const tenant = await tenantFor(req, entry, value);
        if (!tenant) continue;
        queued += await tenancy.run(tenant.id, () => handleChange(change, value));
      }
    }
    if (queued && webhookWorker.running) {
      webhookWorker.kick();
      if (env.burstSettleMs > 0) setTimeout(() => webhookWorker.kick(), env.burstSettleMs + 50).unref();
    }
    return res.status(200).json({ status: 'success' });
  } catch (err) {
    logger.error('Failed to store incoming webhook', { error: err.message });
    // 500 makes Meta retry; storing is idempotent so retries are safe.
    return res.status(500).json({ status: 'error' });
  }
}

module.exports = { verifyWebhook, handleIncoming };

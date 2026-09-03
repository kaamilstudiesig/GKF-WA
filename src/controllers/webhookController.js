const env = require('../config/env');
const eventRepository = require('../db/eventRepository');
const leadRepository = require('../db/leadRepository');
const tenantService = require('../services/tenantService');
const webhookWorker = require('../workers/webhookWorker');
const logger = require('../utils/logger');

class WebhookController {
  /**
   * GET /webhook
   * Meta Webhook Verification Handshake
   */
  verifyWebhook(req, res) {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    logger.debug('Received webhook verification handshake request', { mode, token_set: Boolean(token) });

    if (mode && token) {
      if (mode === 'subscribe' && token === env.metaWebhookVerifyToken) {
        logger.info('Webhook verification handshake successful');
        return res.status(200).send(challenge);
      } else {
        logger.warn('Webhook verification handshake failed: Token mismatch or invalid mode.');
        return res.status(403).json({ error: 'Verification token mismatch' });
      }
    }

    return res.status(400).json({ error: 'Missing required hub parameters' });
  }

  /**
   * POST /webhook
   * Inbound WhatsApp Message Ingestion Handler.
   * Atomically records inbound events to durable queue and acknowledges Meta fast.
   */
  async handleIncoming(req, res) {
    const body = req.body;

    logger.debug('Received inbound webhook payload', { object: body?.object, entries_count: body?.entry?.length });

    // Confirm it is a WhatsApp Business Account webhook
    if (body.object !== 'whatsapp_business_account') {
      return res.status(404).json({ error: 'Not a whatsapp_business_account event' });
    }

    try {
      const entries = body.entry || [];
      const enqueuedEventIds = [];

      for (const entry of entries) {
        const changes = entry.changes || [];

        for (const change of changes) {
          const value = change.value || {};
          const phoneNumberId = value.metadata?.phone_number_id || null;
          const tenant = tenantService.resolveTenantByPhoneNumberId(phoneNumberId);

          if (!tenant) {
            logger.warn('Inbound webhook ignored: unmapped tenant in production', {
              phone_number_id: phoneNumberId
            });
            continue;
          }

          // 1. Handle Status Receipts (sent, delivered, read)
          if (value.statuses && value.statuses.length > 0) {
            for (const statusObj of value.statuses) {
              logger.debug('Received message delivery status update', {
                message_id: statusObj.id,
                status: statusObj.status,
                recipient_id: statusObj.recipient_id
              });

              const eventKey = `status:${statusObj.id}:${statusObj.status}`;
              const { inserted, id } = eventRepository.recordEvent({
                eventKey,
                tenantId: tenant.id,
                messageId: statusObj.id,
                eventType: 'status',
                payload: { entry: [{ changes: [{ value: { ...value, statuses: [statusObj] } }] }] }
              });
              if (inserted && id) enqueuedEventIds.push(id);
            }
            continue;
          }

          // 2. Handle Inbound Messages
          const messages = value.messages || [];
          const contacts = value.contacts || [];

          for (const msg of messages) {
            const messageId = msg.id;
            const fromNumber = msg.from;
            const waId = (contacts[0]?.wa_id || fromNumber || '').replace(/[^0-9]/g, '');

            if (!waId || !messageId) {
              logger.warn('Received message without valid wa_id or message_id', { msg });
              continue;
            }

            // Message Deduplication check against existing messages
            if (leadRepository.hasMessageBeenProcessed(messageId)) {
              logger.info('Duplicate message detected. Skipping re-processing.', {
                message_id: messageId,
                wa_id: waId
              });
              continue;
            }

            const eventKey = `msg:${messageId}`;
            const { inserted, id } = eventRepository.recordEvent({
              eventKey,
              tenantId: tenant.id,
              messageId,
              eventType: 'message',
              payload: { entry: [{ changes: [{ value: { ...value, messages: [msg] } }] }] }
            });

            if (!inserted) {
              logger.info('Duplicate message detected. Skipping re-processing.', {
                message_id: messageId,
                wa_id: waId
              });
            } else if (id) {
              enqueuedEventIds.push(id);
            }
          }
        }
      }

      // Synchronous drainage in test environment (for existing test suite compatibility)
      const isAsyncRequested = Boolean(req.headers['x-async-processing']);
      if (process.env.NODE_ENV === 'test' && !isAsyncRequested) {
        await webhookWorker.drain(enqueuedEventIds.length || 1, { syncOutbound: true });
      } else {
        // Asynchronous non-blocking processing in production/development
        setImmediate(async () => {
          try {
            await webhookWorker.processNext();
          } catch (err) {
            logger.error('Background worker execution error:', { error: err.message });
          }
        });
      }

      return res.status(200).json({ status: 'success' });
    } catch (error) {
      logger.error('Error processing incoming webhook:', { error: error.message, stack: error.stack });
      return res.status(200).json({ status: 'error_handled', message: error.message });
    }
  }
}

module.exports = new WebhookController();
module.exports.WebhookController = WebhookController;


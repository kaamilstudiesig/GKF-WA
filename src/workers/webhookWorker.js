const eventRepository = require('../db/eventRepository');
const outboundRepository = require('../db/outboundRepository');
const leadRepository = require('../db/leadRepository');
const tenantService = require('../services/tenantService');
const aiPolicy = require('../services/aiPolicy');
const deterministicRouter = require('../services/deterministicRouter');
const aiService = require('../services/aiService');
const outboundWorker = require('./outboundWorker');
const gymConfig = require('../config/gymConfig');
const logger = require('../utils/logger');
const { captureException } = require('../utils/sentry');

class WebhookWorker {
  constructor() {
    this.timer = null;
    this.isRunning = false;
    this.isProcessing = false;
  }

  /**
   * Processes a single pending inbound webhook event.
   * @param {object} options - Options (e.g. syncOutbound for tests)
   * @returns {Promise<boolean>} True if an event was processed, false if queue was empty
   */
  async processNext(options = {}) {
    const event = eventRepository.getNextPendingEvent(60);
    if (!event) return false;

    logger.debug('Processing inbound webhook event job', {
      id: event.id,
      event_key: event.event_key,
      event_type: event.event_type,
      attempts: event.attempts
    });

    try {
      const payload = event.payload;
      const entry = payload?.entry?.[0] || {};
      const change = entry.changes?.[0] || {};
      const value = change.value || {};
      const phoneNumberId = value.metadata?.phone_number_id || null;
      const tenant = tenantService.resolveTenantByPhoneNumberId(phoneNumberId);

      if (!tenant) {
        logger.error('Worker rejecting webhook event: unmapped tenant in production', {
          event_id: event.id,
          phone_number_id: phoneNumberId
        });
        eventRepository.failPermanent(event.id, `Unmapped WhatsApp phone_number_id: ${phoneNumberId}`);
        return true;
      }
      if (event.event_type === 'status' || (value.statuses && value.statuses.length > 0)) {
        const statuses = value.statuses || [event.payload];
        for (const statusObj of statuses) {
          logger.debug('Acknowledged message status receipt', {
            message_id: statusObj.id,
            status: statusObj.status,
            recipient_id: statusObj.recipient_id,
            tenant_id: tenant.id
          });
        }
        eventRepository.completeEvent(event.id);
        return true;
      }

      // 2. Handle Inbound Messages
      const msg = value.messages?.[0] || payload;
      const contacts = value.contacts || [];
      const messageId = msg.id || event.message_id;
      const fromNumber = msg.from;
      const matchingContact = contacts.find(c => c.wa_id === fromNumber) || contacts[0];
      const waId = (matchingContact?.wa_id || fromNumber || '').replace(/[^0-9]/g, '');
      const displayName = matchingContact?.profile?.name || null;
      const timestamp = msg.timestamp
        ? new Date(parseInt(msg.timestamp, 10) * 1000).toISOString()
        : new Date().toISOString();
      const msgType = msg.type || 'text';

      if (!waId || !messageId) {
        logger.warn('Event missing valid wa_id or message_id, marking permanently failed', { event_id: event.id });
        eventRepository.failPermanent(event.id, 'Missing wa_id or message_id');
        return true;
      }

      // Message Deduplication & Crash Recovery
      if (leadRepository.hasMessageBeenProcessed(messageId)) {
        const hasOutboundReply = outboundRepository.db.prepare(
          "SELECT 1 FROM outbound_messages WHERE dedup_key = ? LIMIT 1"
        ).get(`reply:${messageId}`);

        if (hasOutboundReply) {
          logger.info('Duplicate message detected with reply already enqueued. Completing event.', {
            message_id: messageId,
            wa_id: waId
          });
          eventRepository.completeEvent(event.id);
          return true;
        }

        logger.warn('Inbound message was previously recorded but outbound reply was missing (crash recovery). Resuming reply generation.', {
          message_id: messageId,
          wa_id: waId
        });
      }

      // Atomic lead get or create
      let lead = leadRepository.getOrCreateLead(waId, displayName, timestamp, tenant.id);

      let replyText = null;

      if (msgType === 'text') {
        const incomingText = msg.text?.body || '';

        // Persist inbound message atomically
        leadRepository.saveMessage({
          messageId,
          waId,
          direction: 'in',
          text: incomingText,
          timestamp,
          rawPayload: msg,
          tenantId: tenant.id
        });

        // Step 1: Medical / Injury Safety Filter
        const medicalCheck = aiPolicy.checkMedicalInjurySafety(incomingText);
        if (medicalCheck.isMedicalQuery) {
          replyText = medicalCheck.disclaimerText;
          aiService.applyLeadUpdates(lead, {
            needs_human: true,
            handoff_reason: medicalCheck.handoffReason,
            summary: 'Lead asked injury/medical question.'
          }, tenant.id);
        } else {
          // Step 2: Deterministic Router Check (Cost Savings)
          const routeResult = deterministicRouter.routeMessage(incomingText, tenant.configuration, lead);
          if (routeResult.matched) {
            replyText = routeResult.replyText;
            if (routeResult.updates) {
              aiService.applyLeadUpdates(lead, routeResult.updates, tenant.id);
            }
          } else {
            // Step 3: AI Service with Tool Loop & Policy
            const aiResult = await aiService.processInboundMessage(lead, incomingText, tenant.configuration, tenant.id);
            replyText = aiResult.replyText;
          }
        }
      } else {
        // Non-text media message handling
        logger.info('Worker processing non-text media message', { type: msgType, wa_id: waId });

        leadRepository.saveMessage({
          messageId,
          waId,
          direction: 'in',
          text: `[Received ${msgType.toUpperCase()} message]`,
          timestamp,
          rawPayload: msg,
          tenantId: tenant.id
        });

        replyText = tenant.configuration?.fallbackMessages?.nonTextMessage || gymConfig.fallbackMessages.nonTextMessage;
      }

      // Enqueue outbound reply in durable queue
      if (replyText) {
        outboundRepository.enqueueOutbound({
          dedupKey: `reply:${messageId}`,
          tenantId: tenant.id,
          waId,
          text: replyText,
          metadata: { in_reply_to: messageId }
        });

        // In test mode or when requested synchronously, immediately send the outbound message
        if (options.syncOutbound || process.env.NODE_ENV === 'test') {
          await outboundWorker.processNext();
        }
      }

      eventRepository.completeEvent(event.id);
      logger.info('Inbound webhook event completed successfully', {
        event_id: event.id,
        message_id: messageId,
        wa_id: waId
      });
      return true;
    } catch (error) {
      captureException(error, {
        component: 'webhook_worker',
        eventId: event?.id,
        eventType: event?.event_type,
        tenantId: event?.tenant_id
      });
      logger.error('Worker failed to process webhook event:', {
        event_id: event.id,
        error: error.message,
        stack: error.stack
      });
      eventRepository.failEvent(event.id, error.message);
      return true;
    }
  }

  /**
   * Drains all pending webhook events sequentially up to maxCycles
   */
  async drain(maxCycles = 50, options = {}) {
    let count = 0;
    while (count < maxCycles) {
      const processed = await this.processNext(options);
      if (!processed) break;
      count++;
    }
    return count;
  }

  /**
   * Starts worker background polling loop.
   * Drains up to maxDrainCycles items per tick to handle bursts and backlog efficiently.
   * @param {number} intervalMs - Polling interval in milliseconds (default: 1000ms)
   * @param {number} maxDrainCycles - Maximum queued items to process per tick (default: 25)
   */
  start(intervalMs = 1000, maxDrainCycles = 25) {
    if (this.isRunning) return;
    this.isRunning = true;

    this.timer = setInterval(async () => {
      if (this.isProcessing || !this.isRunning) return;
      this.isProcessing = true;
      try {
        await this.drain(maxDrainCycles);
      } catch (err) {
        logger.error('Webhook worker polling error:', { error: err.message });
      } finally {
        this.isProcessing = false;
      }
    }, intervalMs);

    logger.info('Inbound Webhook worker started', { intervalMs, maxDrainCycles });
  }

  /**
   * Gracefully stops the worker
   */
  async stop() {
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    let waits = 0;
    while (this.isProcessing && waits < 10) {
      await new Promise(res => setTimeout(res, 100));
      waits++;
    }
    logger.info('Inbound Webhook worker stopped.');
  }
}

module.exports = new WebhookWorker();
module.exports.WebhookWorker = WebhookWorker;

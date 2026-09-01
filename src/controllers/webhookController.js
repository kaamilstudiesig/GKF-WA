const env = require('../config/env');
const gymConfig = require('../config/gymConfig');
const leadRepository = require('../db/leadRepository');
const aiService = require('../services/aiService');
const whatsappService = require('../services/whatsappService');
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
   * Inbound WhatsApp Message Handler
   */
  async handleIncoming(req, res) {
    const body = req.body;

    logger.debug('Received inbound webhook payload', { object: body?.object, entries_count: body?.entry?.length });

    // Confirm it is a WhatsApp Business Account webhook
    if (body.object !== 'whatsapp_business_account') {
      return res.status(404).json({ error: 'Not a whatsapp_business_account event' });
    }

    // Immediately acknowledge and process messages
    try {
      const entries = body.entry || [];

      for (const entry of entries) {
        const changes = entry.changes || [];

        for (const change of changes) {
          const value = change.value || {};

          // 1. Handle Status Receipts (sent, delivered, read)
          if (value.statuses && value.statuses.length > 0) {
            for (const statusObj of value.statuses) {
              logger.debug('Received message delivery status update', {
                message_id: statusObj.id,
                status: statusObj.status,
                recipient_id: statusObj.recipient_id
              });
            }
            continue; // Skip message processing for status updates
          }

          // 2. Handle Inbound Messages
          const messages = value.messages || [];
          const contacts = value.contacts || [];

          for (const msg of messages) {
            const messageId = msg.id;
            const fromNumber = msg.from;
            const waId = (contacts[0]?.wa_id || fromNumber || '').replace(/[^0-9]/g, '');
            const displayName = contacts[0]?.profile?.name || null;
            const timestamp = msg.timestamp ? new Date(parseInt(msg.timestamp, 10) * 1000).toISOString() : new Date().toISOString();
            const msgType = msg.type;

            if (!waId || !messageId) {
              logger.warn('Received message without valid wa_id or message_id', { msg });
              continue;
            }

            // Message Deduplication
            if (leadRepository.hasMessageBeenProcessed(messageId)) {
              logger.info('Duplicate message detected. Skipping re-processing.', {
                message_id: messageId,
                wa_id: waId
              });
              continue;
            }

            logger.info('Processing inbound WhatsApp message', {
              wa_id: waId,
              display_name: displayName,
              type: msgType,
              message_id: messageId
            });

            // Look up or create the lead record
            let lead = leadRepository.getOrCreateLead(waId, displayName, timestamp);

            // Handle Text Message
            if (msgType === 'text') {
              const incomingText = msg.text?.body || '';

              // Save inbound message
              leadRepository.saveMessage({
                messageId,
                waId,
                direction: 'in',
                text: incomingText,
                timestamp,
                rawPayload: msg
              });

              // Process message with AI agent
              const { replyText } = await aiService.processInboundMessage(lead, incomingText);

              // Send AI reply back via WhatsApp Cloud API
              if (replyText) {
                await whatsappService.sendTextMessage(waId, replyText);
              }
            } else {
              // Handle Non-text media types (image, audio, document, location, interactive, etc.)
              logger.info('Received non-text media message', {
                type: msgType,
                wa_id: waId
              });

              leadRepository.saveMessage({
                messageId,
                waId,
                direction: 'in',
                text: `[Received ${msgType.toUpperCase()} message]`,
                timestamp,
                rawPayload: msg
              });

              // Send standard acknowledgement for media
              await whatsappService.sendTextMessage(waId, gymConfig.fallbackMessages.nonTextMessage);
            }
          }
        }
      }

      return res.status(200).json({ status: 'success' });
    } catch (error) {
      logger.error('Error processing incoming webhook:', { error: error.message, stack: error.stack });
      // Still return 200 so Meta does not spam retries on unrecoverable app errors
      return res.status(200).json({ status: 'error_handled', message: error.message });
    }
  }
}

module.exports = new WebhookController();
module.exports.WebhookController = WebhookController;

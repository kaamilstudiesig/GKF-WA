const axios = require('axios');
const env = require('../config/env');
const leadRepository = require('../db/leadRepository');
const logger = require('../utils/logger');

class WhatsAppService {
  constructor() {
    this.version = env.metaGraphApiVersion;
  }

  /**
   * Sends a plain text message to a WhatsApp user via Meta Cloud API
   * @param {string} toWaId - Recipient phone number without '+'
   * @param {string} textBody - Message text content
   * @param {object} options - Optional parameters
   * @returns {Promise<object>} API response or simulated payload
   */
  async sendTextMessage(toWaId, textBody, options = {}) {
    if (!toWaId || !textBody) {
      throw new Error('toWaId and textBody are required to send a WhatsApp message.');
    }

    const cleanWaId = toWaId.replace(/[^0-9]/g, '');
    const url = `https://graph.facebook.com/${this.version}/${env.metaPhoneNumberId}/messages`;

    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanWaId,
      type: 'text',
      text: {
        preview_url: options.previewUrl || false,
        body: textBody
      }
    };

    logger.info('Dispatching outbound WhatsApp text message', {
      to: cleanWaId,
      body: textBody
    });

    // In local development or if token is not configured, log and record locally
    if (!env.metaAccessToken || !env.metaPhoneNumberId || process.env.NODE_ENV === 'test') {
      const simulatedMsgId = `wamid.simulated_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      logger.debug('Simulated outbound send (development/test mode)', {
        message_id: simulatedMsgId,
        to: cleanWaId
      });
      
      leadRepository.saveMessage({
        messageId: simulatedMsgId,
        tenantId: options.tenantId || 'goldkraft',
        waId: cleanWaId,
        direction: 'out',
        text: textBody,
        timestamp: new Date().toISOString(),
        rawPayload: { simulated: true, payload }
      });

      return {
        messaging_product: 'whatsapp',
        contacts: [{ input: cleanWaId, wa_id: cleanWaId }],
        messages: [{ id: simulatedMsgId }]
      };
    }

    try {
      const response = await axios.post(url, payload, {
        headers: {
          'Authorization': `Bearer ${env.metaAccessToken}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      });

      const messageId = response.data?.messages?.[0]?.id || null;
      logger.info('Delivered message to Meta Cloud API', {
        message_id: messageId,
        to: cleanWaId
      });

      leadRepository.saveMessage({
        messageId,
        waId: cleanWaId,
        direction: 'out',
        text: textBody,
        timestamp: new Date().toISOString(),
        rawPayload: response.data
      });

      return response.data;
    } catch (error) {
      const errorData = error.response?.data || error.message;
      logger.error('Failed to send outbound WhatsApp message:', {
        to: cleanWaId,
        error: errorData
      });
      
      // Still log the attempted outbound message to record system action
      leadRepository.saveMessage({
        messageId: `failed_${Date.now()}`,
        waId: cleanWaId,
        direction: 'out',
        text: `[FAILED SEND] ${textBody}`,
        timestamp: new Date().toISOString(),
        rawPayload: { error: errorData }
      });

      throw error;
    }
  }
}

module.exports = new WhatsAppService();
module.exports.WhatsAppService = WhatsAppService;

const axios = require('axios');
const env = require('../config/env');
const leadRepository = require('../db/leadRepository');
const tenantService = require('./tenantService');
const logger = require('../utils/logger');
const { captureException } = require('../utils/sentry');

class WhatsAppService {
  constructor() {
    this.version = env.metaGraphApiVersion;
    this._forceLiveNetwork = false;
  }

  /**
   * Sends a plain text message to a WhatsApp user via Meta Cloud API.
   * Multi-tenant aware: resolves tenant by options.tenantId and uses tenant's
   * whatsapp_phone_number_id when available, falling back to global env.metaPhoneNumberId.
   * Fails closed if an explicit tenantId cannot be resolved.
   * 
   * @param {string} toWaId - Recipient phone number without '+'
   * @param {string} textBody - Message text content
   * @param {object} options - Optional parameters (tenantId, previewUrl, forceLiveNetwork)
   * @returns {Promise<object>} API response or simulated payload
   */
  async sendTextMessage(toWaId, textBody, options = {}) {
    if (!toWaId || !textBody) {
      throw new Error('toWaId and textBody are required to send a WhatsApp message.');
    }

    const cleanWaId = toWaId.replace(/[^0-9]/g, '');
    const tenantId = options.tenantId || 'goldkraft';
    let phoneNumberId = env.metaPhoneNumberId;

    // Resolve tenant-specific WhatsApp Phone Number ID
    if (options.tenantId) {
      const tenant = tenantService.getTenantById(options.tenantId);
      if (!tenant) {
        throw new Error(`Cannot send outbound WhatsApp message: Unknown tenant ID '${options.tenantId}'.`);
      }
      if (tenant.whatsapp_phone_number_id) {
        phoneNumberId = tenant.whatsapp_phone_number_id;
      } else if (!phoneNumberId) {
        throw new Error(`Cannot send outbound WhatsApp message: Tenant '${options.tenantId}' has no WhatsApp phone number configured and no default fallback exists.`);
      }
    } else if (!phoneNumberId) {
      throw new Error('Cannot send outbound WhatsApp message: No WhatsApp phone number ID configured.');
    }

    const url = `https://graph.facebook.com/${this.version}/${phoneNumberId}/messages`;

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
      body: textBody,
      tenant_id: tenantId,
      phone_number_id: phoneNumberId
    });

    // Determine simulation vs live Meta network send
    const forceLive = Boolean(options.forceLiveNetwork || this._forceLiveNetwork);
    const shouldSimulate = !forceLive && (!env.metaAccessToken || !phoneNumberId || process.env.NODE_ENV === 'test');

    if (shouldSimulate) {
      const simulatedMsgId = `wamid.simulated_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      logger.debug('Simulated outbound send (development/test mode)', {
        message_id: simulatedMsgId,
        to: cleanWaId,
        tenant_id: tenantId
      });
      
      leadRepository.saveMessage({
        messageId: simulatedMsgId,
        tenantId,
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
          'Authorization': `Bearer ${env.metaAccessToken || 'test_token'}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      });

      const messageId = response.data?.messages?.[0]?.id || null;
      logger.info('Delivered message to Meta Cloud API', {
        message_id: messageId,
        to: cleanWaId,
        tenant_id: tenantId,
        phone_number_id: phoneNumberId
      });

      leadRepository.saveMessage({
        messageId,
        tenantId,
        waId: cleanWaId,
        direction: 'out',
        text: textBody,
        timestamp: new Date().toISOString(),
        rawPayload: response.data
      });

      return response.data;
    } catch (error) {
      const errorData = error.response?.data || error.message;
      captureException(error, {
        component: 'whatsapp_outbound',
        recipient: cleanWaId,
        tenantId
      });

      logger.error('Failed to send outbound WhatsApp message:', {
        to: cleanWaId,
        tenant_id: tenantId,
        error: errorData
      });
      
      // Explicitly preserve tenant identity when logging attempted outbound failure
      leadRepository.saveMessage({
        messageId: `failed_${Date.now()}`,
        tenantId,
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

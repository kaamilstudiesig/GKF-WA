const axios = require('axios');
const env = require('../config/env');
const leadRepository = require('../db/leadRepository');
const logger = require('../utils/logger');

/**
 * Meta WhatsApp Cloud API client. Without META_ACCESS_TOKEN (local dev) or in
 * tests, sends are simulated and still recorded in the conversation.
 */
class WhatsAppService {
  constructor() {
    this.transport = null; // tests replace this to fake Meta responses
  }

  get live() {
    return Boolean(this.transport || (env.metaAccessToken && env.metaPhoneNumberId && env.nodeEnv !== 'test'));
  }

  async post(payload, timeout = 10000) {
    if (this.transport) return this.transport(payload);
    const url = `https://graph.facebook.com/${env.metaGraphApiVersion}/${env.metaPhoneNumberId}/messages`;
    const res = await axios.post(url, payload, {
      headers: { Authorization: `Bearer ${env.metaAccessToken}`, 'Content-Type': 'application/json' },
      timeout
    });
    return res.data;
  }

  /** Sends a text reply and records it in the conversation. Returns Meta's message id. */
  async sendText(waId, text) {
    const to = String(waId).replace(/[^0-9]/g, '');
    if (!to || !text) throw new Error('sendText needs a recipient and text');

    let messageId;
    if (this.live) {
      const data = await this.post({
        messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text',
        text: { preview_url: false, body: text }
      });
      messageId = data?.messages?.[0]?.id || null;
      logger.info('WhatsApp message sent', { to_suffix: to.slice(-4), message_id: messageId });
    } else {
      messageId = `wamid.simulated_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      logger.debug('Simulated WhatsApp send (no Meta token or test mode)', { to_suffix: to.slice(-4) });
    }
    await leadRepository.saveMessage({ messageId, waId: to, direction: 'out', text });
    return messageId;
  }

  /**
   * Marks the lead's message as read (blue ticks) and shows "typing…" while the
   * reply is prepared. Best effort: failures are logged and ignored.
   */
  async markReadWithTyping(messageId) {
    if (!this.live || !messageId) return;
    try {
      await this.post({ messaging_product: 'whatsapp', status: 'read', message_id: messageId, typing_indicator: { type: 'text' } }, 5000);
    } catch (err) {
      logger.debug('Could not mark message read', { error: err.response?.data?.error?.message || err.message });
    }
  }
}

module.exports = new WhatsAppService();
module.exports.WhatsAppService = WhatsAppService;

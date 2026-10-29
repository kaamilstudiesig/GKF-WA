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

  /**
   * Sends a reply and records it in the conversation. Returns Meta's message id.
   * Optional extras: `buttons` (up to 3 reply buttons, titles up to 20 chars) and
   * `location` (a map pin sent right after the text).
   */
  async sendText(waId, text, { buttons = [], location = null } = {}) {
    const to = String(waId).replace(/[^0-9]/g, '');
    if (!to || !text) throw new Error('sendText needs a recipient and text');

    const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to };
    const replyButtons = (buttons || []).slice(0, 3).map(b => ({
      type: 'reply', reply: { id: String(b.id).slice(0, 256), title: String(b.title).slice(0, 20) }
    }));
    const payload = replyButtons.length && text.length <= 1024
      ? { ...base, type: 'interactive', interactive: { type: 'button', body: { text }, action: { buttons: replyButtons } } }
      : { ...base, type: 'text', text: { preview_url: false, body: text } };

    const messageId = await this.deliver(payload, to);
    await leadRepository.saveMessage({ messageId, waId: to, direction: 'out', text });

    if (location && Number.isFinite(location.latitude) && Number.isFinite(location.longitude)) {
      try {
        const pinId = await this.deliver({ ...base, type: 'location', location }, to);
        await leadRepository.saveMessage({ messageId: pinId, waId: to, direction: 'out', text: `[Location pin] ${location.name || ''}`.trim() });
      } catch (err) {
        // The text already went out; a missing pin is not worth resending the reply for.
        logger.warn('Could not send location pin', { error: err.response?.data?.error?.message || err.message });
      }
    }
    return messageId;
  }

  async deliver(payload, to) {
    if (!this.live) {
      logger.debug('Simulated WhatsApp send (no Meta token or test mode)', { to_suffix: to.slice(-4), type: payload.type });
      return `wamid.simulated_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    }
    const data = await this.post(payload);
    const messageId = data?.messages?.[0]?.id || null;
    logger.info('WhatsApp message sent', { to_suffix: to.slice(-4), type: payload.type, message_id: messageId });
    return messageId;
  }

  /**
   * Marks the lead's message as read (blue ticks) and shows "typing…" while the
   * reply is prepared. Best effort: failures are logged and ignored.
   */
  async markReadWithTyping(messageId, { typing = true } = {}) {
    if (!this.live || !messageId) return;
    try {
      const payload = { messaging_product: 'whatsapp', status: 'read', message_id: messageId };
      if (typing) payload.typing_indicator = { type: 'text' };
      await this.post(payload, 5000);
    } catch (err) {
      logger.debug('Could not mark message read', { error: err.response?.data?.error?.message || err.message });
    }
  }
}

module.exports = new WhatsAppService();
module.exports.WhatsAppService = WhatsAppService;

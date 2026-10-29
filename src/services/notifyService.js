const axios = require('axios');
const logger = require('../utils/logger');

const REASON_LABELS = {
  ready_to_book: 'Ready to book a trial',
  price_negotiation: 'Price negotiation',
  custom_program: 'Wants a custom program',
  injury_question: 'Injury / medical question',
  human_requested: 'Asked for a human',
  complaint: 'Complaint',
  rate_limit_exceeded: 'Bot rate limit hit',
  ai_service_unavailable: 'AI service down',
  ai_network_error: 'AI network error',
  budget_exceeded: 'AI monthly budget reached',
  other: 'Needs staff'
};

const escapeHtml = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Sends free staff alerts to a Telegram group when the bot hands a lead to a human.
 * Enabled only when TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set. Never throws,
 * so an alert failure can never break the WhatsApp reply flow.
 */
class NotifyService {
  constructor() {
    this.sendOverride = null; // test hook
  }

  get config() {
    return {
      token: process.env.TELEGRAM_BOT_TOKEN || '',
      chatId: process.env.TELEGRAM_CHAT_ID || '',
      crmBaseUrl: (process.env.CRM_BASE_URL || '').replace(/\/+$/, '')
    };
  }

  isEnabled() {
    const { token, chatId } = this.config;
    return Boolean(token && chatId);
  }

  buildHandoffMessage({ waId, reason, summary, lead }) {
    const { crmBaseUrl } = this.config;
    const name = lead?.display_name || 'Unknown name';
    const lines = [
      `🔔 <b>Lead needs a human</b>`,
      `<b>${escapeHtml(name)}</b> · +${escapeHtml(waId)}`,
      `Reason: <b>${escapeHtml(REASON_LABELS[reason] || reason)}</b>`
    ];
    if (summary) lines.push(`“${escapeHtml(String(summary).slice(0, 300))}”`);
    const ad = lead?.metadata?.referral;
    if (ad) lines.push(`From ad: ${escapeHtml(ad.headline || ad.source_id || ad.platform || 'Meta ad')}`);
    lines.push('');
    if (crmBaseUrl) lines.push(`<a href="${escapeHtml(`${crmBaseUrl}/leads/${waId}`)}">Open in CRM</a> · <a href="https://wa.me/${escapeHtml(waId)}">WhatsApp</a>`);
    else lines.push(`<a href="https://wa.me/${escapeHtml(waId)}">Open in WhatsApp</a>`);
    return lines.join('\n');
  }

  async send(text) {
    if (this.sendOverride) return this.sendOverride(text);
    const { token, chatId } = this.config;
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    }, { timeout: 5000 });
    return true;
  }

  /** Fire-and-forget alert that a lead wrote while the bot is paused for staff. */
  notifyLeadMessage({ waId, text }) {
    if (!this.sendOverride && (!this.isEnabled() || process.env.NODE_ENV === 'test')) return;
    setImmediate(async () => {
      try {
        const leadRepository = require('../db/leadRepository');
        const lead = await leadRepository.findByWaId(waId);
        const { crmBaseUrl } = this.config;
        const link = crmBaseUrl ? `${crmBaseUrl}/leads/${waId}` : `https://wa.me/${waId}`;
        await this.send([
          `💬 <b>${escapeHtml(lead?.display_name || 'Lead')}</b> · +${escapeHtml(waId)} replied (bot paused for staff)`,
          `“${escapeHtml(String(text || '').slice(0, 300))}”`,
          `<a href="${escapeHtml(link)}">Reply in CRM</a>`
        ].join('\n'));
      } catch (err) {
        logger.error('Failed to send Telegram lead-message alert', { wa_id: waId, error: err.message });
      }
    });
  }

  /**
   * Fire-and-forget alert for a newly opened hand-off. Runs after the current
   * call stack so a slow Telegram call never delays the WhatsApp reply.
   */
  notifyHandoff({ waId, reason, summary = null }) {
    if (!this.sendOverride && (!this.isEnabled() || process.env.NODE_ENV === 'test')) return;
    setImmediate(async () => {
      try {
        // Required lazily to avoid a require cycle with the repositories.
        const leadRepository = require('../db/leadRepository');
        const lead = await leadRepository.findByWaId(waId);
        await this.send(this.buildHandoffMessage({ waId, reason, summary, lead }));
        logger.info('Staff handoff alert sent to Telegram', { wa_id: waId, reason });
      } catch (err) {
        logger.error('Failed to send Telegram staff alert', { wa_id: waId, reason, error: err.message });
      }
    });
  }
}

module.exports = new NotifyService();
module.exports.NotifyService = NotifyService;
module.exports.REASON_LABELS = REASON_LABELS;

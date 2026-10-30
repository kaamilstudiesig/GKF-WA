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

/** "+91..." when we have the phone, "@username" or "phone hidden" otherwise. */
const contactLabel = (lead, waId) => {
  if (lead?.phone) return `+${lead.phone}`;
  if (lead?.username) return `@${lead.username}`;
  return /^[0-9]+$/.test(String(waId)) ? `+${waId}` : 'phone hidden';
};
const phoneOf = (lead, waId) => lead?.phone || (/^[0-9]+$/.test(String(waId)) ? String(waId) : null);

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
      // Technical alerts (failed sends, account warnings). Defaults to the staff group.
      opsChatId: process.env.TELEGRAM_OPS_CHAT_ID || process.env.TELEGRAM_CHAT_ID || '',
      crmBaseUrl: (process.env.CRM_BASE_URL || '').replace(/\/+$/, '')
    };
  }

  isEnabled() {
    const { token, chatId } = this.config;
    return Boolean(token && chatId);
  }

  buildHandoffMessage({ waId, reason, summary, lead }) {
    const name = lead?.display_name || 'Unknown name';
    const lines = [
      `🔔 <b>Lead needs a human</b>`,
      `<b>${escapeHtml(name)}</b> · ${escapeHtml(contactLabel(lead, waId))}`,
      `Reason: <b>${escapeHtml(REASON_LABELS[reason] || reason)}</b>`
    ];
    if (summary) lines.push(`“${escapeHtml(String(summary).slice(0, 300))}”`);
    const ad = lead?.metadata?.referral;
    if (ad) lines.push(`From ad: ${escapeHtml(ad.headline || ad.source_id || ad.platform || 'Meta ad')}`);
    const { fallbackLinks } = this.leadLinks(waId, lead, { replyLabel: 'Open in CRM' });
    if (fallbackLinks.length) lines.push('', fallbackLinks.join(' · '));
    return lines.join('\n');
  }

  /**
   * Posts to Telegram. `buttons` = rows of { text, url } shown as tap buttons
   * under the message (Telegram only accepts public https URLs there).
   */
  async send(text, { ops = false, buttons = [] } = {}) {
    if (this.sendOverride) return this.sendOverride(text, { ops, buttons });
    const { token, chatId, opsChatId } = this.config;
    const body = { chat_id: ops ? opsChatId : chatId, text, parse_mode: 'HTML', disable_web_page_preview: true };
    if (buttons.length) body.reply_markup = { inline_keyboard: buttons };
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, body, { timeout: 5000 });
    return true;
  }

  /**
   * Tap buttons for a lead alert: log the outcome (the CRM lead page's #outcome
   * section, see docs/TEAM.md), open the lead, chat on WhatsApp.
   * Returns { buttons, fallbackLinks } - links go in the text when a URL can't be a button.
   */
  leadLinks(waId, lead, { replyLabel = 'Open lead' } = {}) {
    const { crmBaseUrl } = this.config;
    const leadUrl = crmBaseUrl ? `${crmBaseUrl}/leads/${encodeURIComponent(waId)}` : null;
    const phone = phoneOf(lead, waId);
    const waUrl = phone ? `https://wa.me/${phone}` : null;
    const buttonable = u => Boolean(u) && /^https:\/\/(?!localhost|127\.|[^/]*\.localhost)/i.test(u);

    const buttons = [];
    const fallbackLinks = [];
    if (leadUrl && buttonable(leadUrl)) {
      buttons.push([{ text: '✅ Log outcome', url: `${leadUrl}#outcome` }, { text: `📋 ${replyLabel}`, url: leadUrl }]);
    } else if (leadUrl) {
      fallbackLinks.push(`<a href="${escapeHtml(leadUrl)}">${escapeHtml(replyLabel)}</a>`);
    }
    if (waUrl) buttons.push([{ text: '💬 WhatsApp', url: waUrl }]);
    return { buttons, fallbackLinks };
  }

  /** Fire-and-forget alert that a lead wrote while the bot is paused for staff. */
  notifyLeadMessage({ waId, text }) {
    if (!this.sendOverride && (!this.isEnabled() || process.env.NODE_ENV === 'test')) return;
    setImmediate(async () => {
      try {
        const leadRepository = require('../db/leadRepository');
        const lead = await leadRepository.findByWaId(waId);
        const { buttons, fallbackLinks } = this.leadLinks(waId, lead, { replyLabel: 'Reply in CRM' });
        await this.send([
          `💬 <b>${escapeHtml(lead?.display_name || 'Lead')}</b> · ${escapeHtml(contactLabel(lead, waId))} replied (bot paused for staff)`,
          `“${escapeHtml(String(text || '').slice(0, 300))}”`,
          ...fallbackLinks
        ].join('\n'), { buttons });
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
        const { buttons } = this.leadLinks(waId, lead, { replyLabel: 'Open in CRM' });
        await this.send(this.buildHandoffMessage({ waId, reason, summary, lead }), { buttons });
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
module.exports.contactLabel = contactLabel;

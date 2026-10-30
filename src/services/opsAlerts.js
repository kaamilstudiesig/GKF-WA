const notifyService = require('./notifyService');
const { classify } = require('./metaErrors');
const logger = require('../utils/logger');
const { captureMessage } = require('../utils/sentry');

const escapeHtml = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const minutes = n => n * 60 * 1000;

// Meta account webhooks worth a human's attention. Good news is sent too, marked as info.
const ACCOUNT_FIELDS = new Set(['account_update', 'phone_number_quality_update', 'account_alerts', 'account_review_update', 'business_capability_update']);
const GOOD_EVENTS = new Set(['UNFLAGGED', 'UPGRADE', 'THROUGHPUT_UPGRADE', 'VERIFIED_ACCOUNT', 'APPROVED', 'ONBOARDING_COMPLETE']);

/**
 * Technical alerts for whoever runs the bot: WhatsApp sends failing for account
 * reasons (bad token, payment, ban), bursts of unexplained failures, and Meta
 * account/quality webhooks. Each problem alerts at most once per cooldown so a
 * broken token pings every 30 minutes instead of on every message.
 */
class OpsAlerts {
  constructor() {
    this.reset();
  }

  reset() {
    this.lastSent = new Map();
    this.unknownFailures = [];
  }

  get cooldownMs() {
    const n = Number(process.env.OPS_ALERT_COOLDOWN_MINUTES);
    return minutes(Number.isFinite(n) && n >= 0 ? n : 30);
  }

  /** Sends one alert unless the same key alerted within the cooldown. Never throws. */
  alert(key, title, lines = [], { level = 'error' } = {}) {
    const now = Date.now();
    const last = this.lastSent.get(key);
    if (last !== undefined && now - last < this.cooldownMs) return false;
    this.lastSent.set(key, now);

    const text = [`${level === 'info' ? 'ℹ️' : '🚨'} <b>${escapeHtml(title)}</b>`, ...lines.filter(Boolean).map(escapeHtml)].join('\n');
    captureMessage(`${title}: ${lines.join(' | ')}`, level === 'info' ? 'info' : 'error', { component: 'ops_alert', key });
    if (notifyService.sendOverride || (notifyService.isEnabled() && process.env.NODE_ENV !== 'test')) {
      Promise.resolve()
        .then(() => notifyService.send(text, { ops: true }))
        .catch(err => logger.error('Failed to send ops alert to Telegram', { key, error: err.message }));
    }
    return true;
  }

  /** A WhatsApp send failed (axios error from the Cloud API). */
  sendFailed(err) {
    return this.handleMetaError(classify(err), 'send');
  }

  /** Meta reported a failed delivery in a status webhook (errors[0] object). */
  deliveryFailed(metaError) {
    return this.handleMetaError(classify(metaError), 'delivery');
  }

  handleMetaError(c, where) {
    const codeText = c.code !== null ? `Meta error ${c.code}${c.subcode !== null ? `/${c.subcode}` : ''}` : 'No error code';
    if (c.kind === 'account') {
      return this.alert(`meta:${c.code}:${c.subcode}`, 'WhatsApp replies are failing', [
        `${codeText}${c.title ? `: ${c.title}` : ''}`,
        `What to do: ${c.hint}`,
        'Leads are getting no replies until this is fixed.'
      ]);
    }
    if (c.kind === 'limit') {
      return this.alert(`meta:${c.code}`, 'WhatsApp is throttling our messages', [`${codeText}`, c.hint]);
    }
    if (c.kind === 'unknown' && where === 'send') {
      // Unexplained failures: alert when 3 happen within 10 minutes.
      const now = Date.now();
      this.unknownFailures = this.unknownFailures.filter(t => now - t < minutes(10));
      this.unknownFailures.push(now);
      if (this.unknownFailures.length >= 3) {
        return this.alert('meta:burst', 'Several WhatsApp sends failed', [
          `${this.unknownFailures.length} failures in 10 minutes. Last: ${codeText}${c.title ? `: ${c.title}` : ''}`,
          'Check the logs: heroku logs -a gkf-wa | grep "send failed"'
        ]);
      }
    }
    return false;
  }

  isAccountField(field) {
    return ACCOUNT_FIELDS.has(field);
  }

  /** Meta account / quality webhook (account_update, phone_number_quality_update, ...). */
  accountEvent(field, value = {}) {
    const event = value.event || value.decision || value.alert_info?.alert_type || 'update';
    const good = GOOD_EVENTS.has(String(event).toUpperCase());
    const details = [
      `Event: ${field} / ${event}`,
      value.display_phone_number || value.phone_number ? `Number: ${value.display_phone_number || value.phone_number}` : null,
      value.current_limit ? `Messaging limit: ${value.current_limit}${value.old_limit ? ` (was ${value.old_limit})` : ''}` : null,
      value.violation_info?.violation_type ? `Violation: ${value.violation_info.violation_type}` : null,
      value.ban_info?.waba_ban_state ? `Ban: ${value.ban_info.waba_ban_state}` : null,
      value.restriction_info ? `Restriction: ${JSON.stringify(value.restriction_info).slice(0, 200)}` : null,
      value.alert_info?.alert_description ? `Details: ${value.alert_info.alert_description}` : null,
      good ? null : 'Check WhatsApp Manager.'
    ];
    return this.alert(`acct:${field}:${event}`, good ? 'WhatsApp account update' : 'WhatsApp account needs attention', details, { level: good ? 'info' : 'error' });
  }
}

module.exports = new OpsAlerts();
module.exports.OpsAlerts = OpsAlerts;

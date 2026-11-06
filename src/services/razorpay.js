const crypto = require('crypto');
const axios = require('axios');

/**
 * K11: Razorpay payment links. Off until RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and
 * RAZORPAY_WEBHOOK_SECRET are set (use test-mode keys first). Tests replace createLink.
 */
const registry = require('../tenancy/registry');

// The current tenant's Razorpay account (tenant 1: the RAZORPAY_* env vars).
const cfg = () => (registry.config() || { razorpay: {} }).razorpay;

const razorpay = {
  enabled() { const c = cfg(); return Boolean(c.keyId && c.keySecret && c.webhookSecret); },

  /** Creates a link. Returns { id, short_url }. Amount in whole rupees. */
  async createLink({ amountInr, description, referenceId, phone, notes }) {
    const c = cfg();
    const body = {
      amount: amountInr * 100,
      currency: 'INR',
      accept_partial: false,
      description: description.slice(0, 2048),
      reference_id: referenceId,
      notes,
      notify: { sms: false, email: false }, // we send it on WhatsApp ourselves
      reminder_enable: false
    };
    if (phone) body.customer = { contact: `+${phone}` };
    const { data } = await axios.post('https://api.razorpay.com/v1/payment_links', body,
      { auth: { username: c.keyId, password: c.keySecret }, timeout: 10000 });
    return { id: data.id, short_url: data.short_url };
  },

  /** Checks X-Razorpay-Signature (HMAC-SHA256 of the raw body). */
  verifySignature(rawBody, signature) {
    const secret = cfg().webhookSecret;
    if (!secret || !rawBody || !signature) return false;
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(String(signature));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
};

module.exports = razorpay;

/**
 * Sorts WhatsApp Cloud API errors into:
 *   account  - every send will fail until a human fixes something (token, payment, ban). Alert now.
 *   limit    - Meta is throttling us. Alert, sends are retried.
 *   message  - only this message/recipient failed (e.g. 24h window closed). Log only.
 *   unknown  - anything else. Alert if it keeps happening.
 * Codes: https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes
 */

const ACCOUNT = {
  0: 'Meta could not authenticate the app. Check META_ACCESS_TOKEN.',
  3: 'The app lacks the WhatsApp capability. Check the Meta app setup.',
  10: 'Permission denied. The token is missing a WhatsApp permission.',
  190: 'The access token expired or was revoked. Generate a new system-user token.',
  368: 'The WhatsApp account is temporarily blocked for a policy violation. Check WhatsApp Manager.',
  131005: 'Access denied. The token lacks whatsapp_business_messaging.',
  131031: 'The WhatsApp account is locked. Check WhatsApp Manager.',
  131042: 'Payment problem on the WhatsApp account. Add or fix the payment method in WhatsApp Manager.',
  131045: 'The phone number is not registered (certificate). Re-register the number.',
  133010: 'The phone number is not registered with the Cloud API. Re-register the number.'
};
const LIMIT = {
  4: 'The app hit its API call limit.',
  80007: 'The WhatsApp account hit its API rate limit.',
  130429: 'Throughput limit hit (too many messages per second).',
  131048: 'Spam rate limit: too many messages were blocked or reported. Check quality in WhatsApp Manager.',
  131056: 'Too many messages to the same person in a short time.'
};
const MESSAGE = new Set([131008, 131009, 131021, 131026, 131047, 131051, 131052, 131053, 131062]);

const TOKEN_HINT = 'The token cannot reach the phone number. It probably lost WhatsApp permissions; generate a new system-user token with whatsapp_business_messaging, whatsapp_business_management and catalog_management (docs/OPERATIONS.md, incident runbook).';

/** { code, subcode, title, kind, hint } from an axios error or a status-webhook error object. */
function classify(errOrMetaError) {
  const e = errOrMetaError?.response?.data?.error || errOrMetaError || {};
  const code = Number(e.code ?? NaN);
  const subcode = e.error_subcode !== undefined ? Number(e.error_subcode) : null;
  const title = e.title || e.message || e.error_data?.details || '';
  const httpStatus = errOrMetaError?.response?.status;

  if (code === 100 && subcode === 33) return { code, subcode, title, kind: 'account', hint: TOKEN_HINT };
  if (code >= 200 && code <= 299) return { code, subcode, title, kind: 'account', hint: 'Permission error. The token is missing a permission.' };
  if (ACCOUNT[code]) return { code, subcode, title, kind: 'account', hint: ACCOUNT[code] };
  if (LIMIT[code]) return { code, subcode, title, kind: 'limit', hint: LIMIT[code] };
  if (MESSAGE.has(code) || (code >= 132000 && code < 133000)) return { code, subcode, title, kind: 'message', hint: null };
  if (!Number.isFinite(code) && (!httpStatus || httpStatus >= 500)) return { code: null, subcode, title, kind: 'transient', hint: null };
  return { code: Number.isFinite(code) ? code : null, subcode, title, kind: 'unknown', hint: null };
}

module.exports = { classify, TOKEN_HINT };

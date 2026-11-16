/**
 * Who sent a WhatsApp message. Since WhatsApp usernames, Meta always sends a
 * business-scoped user ID (BSUID, "IN.1234...") and only sometimes the phone.
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids/
 */

const BSUID = /^[A-Z]{2}\.[A-Za-z0-9.]{1,140}$/;
const PHONE = /^\+?[0-9]{6,15}$/;

const isBsuid = v => typeof v === 'string' && BSUID.test(v);
const isPhone = v => (typeof v === 'string' || typeof v === 'number') && PHONE.test(String(v));
const toPhone = v => (isPhone(v) ? String(v).replace(/[^0-9]/g, '') : null);

/** { phone, userId, username } from a webhook message and its contact entry. */
function fromWebhook(msg = {}, contact = null) {
  const candidates = [contact?.wa_id, msg.from];
  const phone = candidates.map(toPhone).find(Boolean) || null;
  // Older or unusual payloads may carry the BSUID in wa_id/from; accept it there too.
  const userId = [msg.from_user_id, contact?.user_id, ...candidates].find(isBsuid) || null;
  const username = contact?.profile?.username || null;
  return { phone, userId, username };
}

/** The key for a brand-new lead: the phone when known, else the BSUID. */
const newLeadKey = ({ phone, userId }) => phone || userId || null;

/** Lead keys are digits (phone) or a BSUID; anything else is rejected. */
const isLeadKey = v => isPhone(v) || isBsuid(v);

/** How to address a lead when sending: phone (`to`) wins, else BSUID (`recipient`). */
function sendTarget(lead, key) {
  const phone = toPhone(lead?.phone) || toPhone(key);
  if (phone) return { to: phone };
  const userId = [lead?.user_id, key].find(isBsuid);
  if (userId) return { recipient: userId };
  return null;
}

/**
 * A typed phone number as digits with the country code, or null.
 * "+91 98450-12345" and "0091 98450 12345" -> "919845012345". With `country` (the client's
 * code, "91" or "971"), local numbers work too: "98450 12345" -> "919845012345",
 * "050 123 4567" -> "971501234567". Without it, only full international numbers are accepted
 * (staff phones on the CRM). Moved here from crm/src/users.js for R16 lead intake.
 */
// National number lengths (without the trunk 0) for the countries we serve.
const NATIONAL_LENGTHS = { 91: [10], 971: [8, 9], 966: [9], 1: [10] };

function normalizePhone(phone, country = null) {
  const raw = String(phone || '').trim();
  if (!raw) return null;
  const compact = raw.replace(/[\s\-().]/g, '');
  const international = /^(\+|00)/.test(compact);
  let digits = compact.replace(/^\+/, '').replace(/^00/, '');
  if (!/^[0-9]+$/.test(digits)) return null;
  if (!international && country) {
    const national = digits.replace(/^0+/, '');
    const lengths = NATIONAL_LENGTHS[country];
    if (lengths) {
      // Decided by length, never by prefix: Indian mobiles can start with 91 ("91234 56789").
      if (lengths.includes(national.length)) digits = country + national;
      else if (national.startsWith(country) && lengths.includes(national.length - country.length)) digits = national;
      else return null;
    } else {
      // Other countries: keep a number that already starts with the code and is long enough.
      digits = national.startsWith(country) && national.length >= country.length + 8 ? national : country + national;
    }
  }
  return /^[1-9][0-9]{9,14}$/.test(digits) ? digits : null;
}

module.exports = { isBsuid, isPhone, toPhone, fromWebhook, newLeadKey, isLeadKey, sendTarget, normalizePhone };

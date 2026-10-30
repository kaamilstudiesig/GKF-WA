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

module.exports = { isBsuid, isPhone, toPhone, fromWebhook, newLeadKey, isLeadKey, sendTarget };

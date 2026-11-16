/**
 * Connect links (K9) carry their key in the path: /connect/<payload>.<signature>.
 * Anyone with the link can connect a WhatsApp number to that client until it
 * expires, so it never goes into logs or Sentry.
 */
const CONNECT_LINK_RE = /\/connect\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

const redactConnectLinks = s => (typeof s === 'string' ? s.replace(CONNECT_LINK_RE, '/connect/[REDACTED]') : s);

/** Same, through a whole JSON-able object (a Sentry event or transaction). */
function redactConnectLinksDeep(obj) {
  if (!obj) return obj;
  try {
    const text = JSON.stringify(obj);
    return CONNECT_LINK_RE.test(text) ? JSON.parse(redactConnectLinks(text)) : obj;
  } catch {
    return obj;
  } finally {
    CONNECT_LINK_RE.lastIndex = 0;
  }
}

module.exports = { redactConnectLinks, redactConnectLinksDeep };

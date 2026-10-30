const config = require('./config');

/** Offset in ms of `tz` from UTC at instant `date`. */
function tzOffsetMs(date, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(date).map(p => [p.type, p.value]));
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Converts a "YYYY-MM-DDTHH:mm" form value in the display timezone to an ISO UTC string. */
function localInputToIso(value, tz = config.timezone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(value || ''));
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const iso = new Date(guess - tzOffsetMs(new Date(guess), tz));
  return isNaN(iso.getTime()) ? null : iso.toISOString();
}

/** ISO string -> "YYYY-MM-DD" in the display timezone. */
function localDay(iso, tz = config.timezone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

function fmtDate(iso, tz = config.timezone) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: tz, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit'
  }).format(d);
}

/** "9:32 pm" in the display timezone (chat bubbles). */
function fmtTime(iso, tz = config.timezone) {
  const d = new Date(iso);
  if (!iso || isNaN(d)) return '';
  return new Intl.DateTimeFormat('en-IN', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(d).toLowerCase();
}

/** "Today", "Yesterday" or "30 Oct 2026" (chat date separators). */
function dayLabel(iso, tz = config.timezone) {
  if (!iso) return '';
  const day = localDay(iso, tz);
  const today = localDay(new Date().toISOString(), tz);
  const yesterday = localDay(new Date(Date.now() - 86400000).toISOString(), tz);
  if (day === today) return 'Today';
  if (day === yesterday) return 'Yesterday';
  return new Intl.DateTimeFormat('en-IN', { timeZone: tz, day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
}

function timeAgo(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (isNaN(diff)) return '—';
  const abs = Math.abs(diff);
  const units = [[86400000, 'd'], [3600000, 'h'], [60000, 'm']];
  for (const [ms, u] of units) if (abs >= ms) return diff >= 0 ? `${Math.floor(abs / ms)}${u} ago` : `in ${Math.floor(abs / ms)}${u}`;
  return 'just now';
}

// Lead keys are a phone number (digits) or Meta's business-scoped user ID ("IN.1234...").
const cleanWaId = v => String(v || '').replace(/[^A-Za-z0-9.]/g, '').slice(0, 160);
const leadPhone = l => l?.phone || (/^[0-9]+$/.test(String(l?.wa_id || '')) ? String(l.wa_id) : null);
/** What to show for a lead's number: "+91...", "@username" or "Phone hidden". */
const contactLabel = l => {
  const phone = leadPhone(l);
  if (phone) return `+${phone}`;
  if (l?.username) return `@${l.username}`;
  return 'Phone hidden';
};
const leadTitle = l => l?.display_name || contactLabel(l);
const humanize = v => (v ? String(v).replace(/_/g, ' ') : '');

/**
 * Builds a parameter list while writing SQL: `q.p(value)` adds the value and
 * returns its placeholder ($1, $2, ...).
 */
class Params {
  constructor() { this.values = []; }
  p(value) { this.values.push(value); return `$${this.values.length}`; }
}

module.exports = { Params, localInputToIso, localDay, fmtDate, fmtTime, dayLabel, timeAgo, cleanWaId, leadPhone, contactLabel, leadTitle, humanize, tzOffsetMs };

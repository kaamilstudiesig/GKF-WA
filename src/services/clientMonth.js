const db = require('../db');
const logger = require('../utils/logger');
const tenancy = require('../tenancy/context');

/**
 * A client's calendar month, in its own time zone (Business settings → Lead queue,
 * crm_settings.timezone, default Asia/Kolkata). Shared by the monthly figures we report to
 * clients: lead usage (K26) and reply time (K27). Read straight from the table, so `src/`
 * doesn't depend on `crm/` code.
 */
const DEFAULT_TZ = 'Asia/Kolkata';
const CACHE_MS = 60 * 1000;
const cache = new Map(); // tenant id -> { tz, until }
const MONTH_RE = /^[0-9]{4}-[0-9]{2}$/;

/** "2026-11" for `date` in time zone `tz`. */
function monthOf(date, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit' }).formatToParts(date);
  const get = type => parts.find(p => p.type === type).value;
  return `${get('year')}-${get('month')}`;
}

/** Milliseconds `tz` is ahead of UTC at `date`. */
function offsetMs(date, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(date).map(p => [p.type, p.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** { start, end } instants of month "2026-11" in `tz` (end exclusive). */
function monthRange(month, tz) {
  if (!MONTH_RE.test(String(month))) throw new Error('Give the month as YYYY-MM, for example 2026-11.');
  const [y, m] = month.split('-').map(Number);
  const localStart = Date.UTC(y, m - 1, 1);
  const localEnd = Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1);
  // The zone's offset at that moment (India and the Gulf have no daylight saving; this also holds for zones that do, away from the switch hour).
  const start = new Date(localStart - offsetMs(new Date(localStart), tz));
  const end = new Date(localEnd - offsetMs(new Date(localEnd), tz));
  return { start, end };
}

/** The current tenant's time zone (cached for a minute). */
async function timezone() {
  const id = tenancy.tenantId();
  const hit = cache.get(id);
  if (hit && hit.until > Date.now()) return hit.tz;
  let tz = DEFAULT_TZ;
  try {
    const row = await db.one('SELECT timezone FROM crm_settings LIMIT 1');
    if (row && row.timezone) tz = row.timezone;
  } catch (err) {
    logger.warn('Client time zone not readable, using the default', { error: err.message });
  }
  cache.set(id, { tz, until: Date.now() + CACHE_MS });
  return tz;
}

/** The current tenant's month for `now`. */
async function current(now = new Date()) {
  return monthOf(now, await timezone());
}

module.exports = { monthOf, monthRange, timezone, current, DEFAULT_TZ, MONTH_RE, _cache: cache };

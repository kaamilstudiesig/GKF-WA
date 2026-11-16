const crypto = require('crypto');
const db = require('../db');
const logger = require('../utils/logger');
const tenancy = require('../tenancy/context');
const registry = require('../tenancy/registry');
const notifyService = require('./notifyService');
const { captureException } = require('../utils/sentry');

/**
 * K26 lead usage meter (agreement clause 1 "Lead" and 4.3).
 *
 * A Lead is a person who contacts the client through a connected channel, counted once per
 * calendar month across all channels. The month is the client's (time zone from Business
 * settings → Lead queue, crm_settings.timezone, default Asia/Kolkata; read here directly so the
 * bot doesn't depend on crm/ code).
 *
 * - record(): called for every inbound message (and, later, every form or portal lead). The
 *   first one from a person in a month adds a row to lead_usage; the rest do nothing.
 * - Rows hold a keyed hash of the phone (or Meta user id), never the number. They stay when a
 *   lead is deleted, so a deletion request never changes an invoice, and hold no personal data.
 * - With a monthly limit set (tenant setting leadMonthlyLimit, from the plan), the client's staff
 *   group and our ops group get one alert at 80% and one at 100%, each once per month.
 *   No limit set: count only, no alerts.
 * - usage() is the read contract for the CRM screens (Business settings, dashboard).
 */

const LEVELS = [80, 100];
const DEFAULT_TZ = 'Asia/Kolkata';
const TZ_CACHE_MS = 60 * 1000;
const tzCache = new Map(); // tenant id -> { tz, until }

// A hash key of our own, derived from TENANT_SECRETS_KEY (which production always has).
// Changing that key mid-month would count people again; it is never rotated casually.
function hashKey(env = process.env) {
  const raw = Buffer.from(env.TENANT_SECRETS_KEY || '', 'base64');
  if (raw.length === 32) return crypto.createHmac('sha256', raw).update('k26-lead-usage').digest();
  if (env.NODE_ENV === 'production') throw new Error('TENANT_SECRETS_KEY must be set to count leads.');
  return Buffer.from('local-dev-lead-usage');
}

/** The hashed identity of one person in one client. Phone when known, so a person counts once across channels. */
function personKey(tenantId, identity) {
  return crypto.createHmac('sha256', hashKey()).update(`${tenantId}:${identity}`).digest('hex').slice(0, 40);
}

/** "2026-11" for `date` in time zone `tz`. */
function monthOf(date, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit' }).formatToParts(date);
  const get = type => parts.find(p => p.type === type).value;
  return `${get('year')}-${get('month')}`;
}

async function timezone() {
  const id = tenancy.tenantId();
  const hit = tzCache.get(id);
  if (hit && hit.until > Date.now()) return hit.tz;
  let tz = DEFAULT_TZ;
  try {
    const row = await db.one('SELECT timezone FROM crm_settings LIMIT 1');
    if (row && row.timezone) tz = row.timezone;
  } catch (err) {
    logger.warn('Lead usage: time zone not readable, using the default', { error: err.message });
  }
  tzCache.set(id, { tz, until: Date.now() + TZ_CACHE_MS });
  return tz;
}

async function currentMonth(now = new Date()) {
  return monthOf(now, await timezone());
}

const limitOf = () => registry.config().leadMonthlyLimit || null;

async function count(month) {
  return (await db.one('SELECT COUNT(*)::int AS n FROM lead_usage WHERE month = $1', [month])).n;
}

/**
 * Counts one contact for the current tenant. `lead` is the leads row (phone preferred, then
 * wa_id). Returns { month, counted: true|false }. Never throws: a failure here must not stop
 * the reply, so it is logged and reported instead.
 */
async function record(lead, { channel = 'whatsapp', at = new Date() } = {}) {
  try {
    const identity = (lead && (lead.phone || lead.wa_id)) || null;
    if (!identity) return { counted: false };
    const month = await currentMonth(at);
    const added = await db.one(`INSERT INTO lead_usage (month, person_key, channel, first_at) VALUES ($1, $2, $3, $4)
      ON CONFLICT DO NOTHING RETURNING month`, [month, personKey(tenancy.tenantId(), identity), channel, at]);
    // Alerts only for this month: a delayed or replayed message from last month still counts
    // there, but never sends a late alert.
    if (added && month === await currentMonth()) await checkLimit(month);
    return { month, counted: Boolean(added) };
  } catch (err) {
    logger.error('Lead usage not recorded', { error: err.message });
    captureException(err, { component: 'lead_usage' });
    return { counted: false };
  }
}

/** Sends the 80% / 100% alert when this month's count reaches it, once per level per month. */
async function checkLimit(month) {
  const limit = limitOf();
  if (!limit) return;
  const n = await count(month);
  for (const level of LEVELS) {
    if (n < Math.ceil((limit * level) / 100)) continue;
    const claimed = await db.one(`INSERT INTO lead_usage_alerts (month, level) VALUES ($1, $2)
      ON CONFLICT DO NOTHING RETURNING level`, [month, level]);
    if (!claimed) continue;
    try {
      const sent = await alert({ month, n, limit, level });
      // No staff group yet: give the level back, so the alert goes out once a group is set.
      if (!sent) await db.query('DELETE FROM lead_usage_alerts WHERE month = $1 AND level = $2', [month, level]);
    } catch (err) {
      // Give the level back, so the next new lead tries again.
      await db.query('DELETE FROM lead_usage_alerts WHERE month = $1 AND level = $2', [month, level]);
      throw err;
    }
  }
}

function alertText({ month, n, limit, level }) {
  const head = level >= 100
    ? `📊 <b>Lead limit reached</b>: ${n} of ${limit} leads this month (${month}).`
    : `📊 <b>${level}% of this month's leads used</b>: ${n} of ${limit} (${month}).`;
  return `${head}\nLeads above ${limit} in a month are billed as overage under your plan. Replies keep working as normal.`;
}

async function alert(info) {
  const text = alertText(info);
  if (!notifyService.sendOverride && !notifyService.isEnabled()) {
    logger.warn('Lead usage alert not sent: no staff Telegram group', { month: info.month, level: info.level });
    return false;
  }
  await notifyService.send(text);
  // Our ops group too (we invoice from it), unless it is the same group; a failure there doesn't
  // undo the client's alert. The ops copy is prefixed with the client's name by notifyService.
  const { chatId, opsChatId } = notifyService.config;
  if (notifyService.sendOverride || (opsChatId && opsChatId !== chatId)) {
    Promise.resolve(notifyService.send(text, { ops: true })).catch(err => logger.warn('Lead usage ops alert failed', { error: err.message }));
  }
  logger.info('Lead usage alert sent', { month: info.month, level: info.level, count: info.n, limit: info.limit });
  return true;
}

/**
 * The read contract for the CRM screens (current tenant):
 * { month: '2026-11', count: 412, limit: 500 | null, percent: 82 | null }.
 */
async function usage({ month = null, now = new Date() } = {}) {
  const m = month || await currentMonth(now);
  const n = await count(m);
  const limit = limitOf();
  return { month: m, count: n, limit, percent: limit ? Math.floor((n * 100) / limit) : null };
}

/** Every client's count for one month (invoicing; system context). */
async function allClients(month) {
  if (!/^[0-9]{4}-[0-9]{2}$/.test(String(month))) throw new Error('Give the month as YYYY-MM, for example 2026-11.');
  await registry.ensureLoaded();
  return tenancy.runAsSystem(async () => {
    const rows = await db.many(`SELECT t.id, t.slug, t.name, t.status, COUNT(u.person_key)::int AS leads
      FROM tenants t LEFT JOIN lead_usage u ON u.tenant_id = t.id AND u.month = $1
      GROUP BY t.id ORDER BY t.id`, [month]);
    return rows.map(r => {
      const limit = registry.config(r.id)?.leadMonthlyLimit || null;
      return { slug: r.slug, name: r.name, status: r.status, month, leads: r.leads, limit, over: limit ? Math.max(0, r.leads - limit) : null };
    });
  });
}

module.exports = { record, usage, allClients, monthOf, personKey, alertText, LEVELS, _tzCache: tzCache };

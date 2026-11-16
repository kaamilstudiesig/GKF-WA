const db = require('../db');
const logger = require('../utils/logger');
const tenancy = require('../tenancy/context');
const registry = require('../tenancy/registry');
const notifyService = require('./notifyService');
const { deleteLead } = require('./leadDeletion');
const { captureException } = require('../utils/sentry');

/**
 * K31 automatic deletion (agreement 7.6 and Annexure C; privacy page "How long we keep it"):
 * a lead is deleted when its last interaction is older than the client's retention period
 * (tenant setting `retentionMonths`, default 24).
 *
 * Last interaction = the latest of: their last message, our last message, first contact, and the
 * lead's last update (a status change, note or outcome by staff updates the lead). A lead with no
 * WhatsApp message yet (a form lead) still has first contact, so it never looks infinitely old.
 *
 * Deletion goes through leadDeletion.deleteLead (the same path as a deletion request). Kept:
 * the hashed monthly lead count (billing, no personal data) and reply times (no lead key).
 *
 * Guard rails (it runs unattended and deletes for good):
 * - LEAD_RETENTION=off turns it off everywhere;
 * - at most MAX_PER_RUN leads per client per day; the rest wait for the next day;
 * - if more than SURGE_SHARE of a client's leads (and more than SURGE_MIN) are due at once, nothing
 *   is deleted for that client and our ops group is alerted (a clock or data problem looks like this);
 * - once a day per client, after RETENTION_HOUR_UTC (default 22:00 UTC, 03:30 IST): the day is claimed
 *   in crm_activity_log (action retention_run) under a transaction lock, so two processes never both run.
 */
const LOCK = 4242031;
const MAX_PER_RUN = 200;
const SURGE_SHARE = 0.2;
const SURGE_MIN = 50;
const DEFAULT_MONTHS = 24;
const state = { doneDay: null };

const off = () => String(process.env.LEAD_RETENTION || '').toLowerCase() === 'off';
const monthsFor = tenant => {
  const n = Number(tenant && tenant.retentionMonths);
  return Number.isInteger(n) && n >= 1 && n <= 120 ? n : DEFAULT_MONTHS;
};

const LAST_INTERACTION = `GREATEST(COALESCE(last_inbound_message_at, first_contact_at), COALESCE(last_outbound_message_at, first_contact_at),
  first_contact_at, COALESCE(updated_at, first_contact_at))`;

/** Leads due for deletion in the current tenant, oldest first (at most `limit`). */
async function dueLeads(months, now = new Date(), limit = MAX_PER_RUN + 1) {
  return db.many(`SELECT wa_id FROM leads WHERE ${LAST_INTERACTION} < $1::timestamptz - make_interval(months => $2)
    ORDER BY ${LAST_INTERACTION} LIMIT $3`, [now.toISOString(), months, limit]);
}

async function alertOps(text) {
  try {
    const { token, opsChatId, chatId } = notifyService.config;
    if (notifyService.sendOverride || (token && (opsChatId || chatId))) await notifyService.send(text, { ops: true });
  } catch (err) {
    logger.warn('Retention alert failed', { error: err.message });
  }
}

/** Claims today's run for the current tenant; false when another process already did. */
async function claimDay(day) {
  return db.tx(async () => {
    await db.query('SELECT pg_advisory_xact_lock($1, $2)', [LOCK, tenancy.tenantId()]);
    const done = await db.one("SELECT 1 AS x FROM crm_activity_log WHERE action = 'retention_run' AND details ->> 'day' = $1", [day]);
    if (done) return false;
    await db.query("INSERT INTO crm_activity_log (wa_id, user_id, action, details) VALUES (NULL, NULL, 'retention_run', $1::jsonb)", [JSON.stringify({ day })]);
    return true;
  });
}

/** One client (current tenant): { deleted, due, skipped? }. */
async function runTenant(now = new Date()) {
  const tenant = registry.config();
  const months = monthsFor(tenant);
  const due = await dueLeads(months, now);
  if (!due.length) return { deleted: 0, due: 0, months };
  const total = (await db.one('SELECT COUNT(*)::int AS n FROM leads')).n;
  if (due.length > SURGE_MIN && due.length > total * SURGE_SHARE) {
    logger.error('Automatic deletion stopped: too many leads due at once', { due: due.length, total, months });
    await alertOps(`🛑 Automatic deletion stopped: ${due.length > MAX_PER_RUN ? `${MAX_PER_RUN}+` : due.length} of ${total} leads are older than ${months} months at once. Nothing was deleted. Check the server clock and the data, then set LEAD_RETENTION or retentionMonths.`);
    return { deleted: 0, due: due.length, months, skipped: 'surge' };
  }
  let deleted = 0;
  for (const { wa_id: key } of due.slice(0, MAX_PER_RUN)) {
    const r = await deleteLead(key, { confirm: true });
    if (r.deleted) deleted++;
  }
  logger.info('Automatic deletion: leads past the retention period deleted', { deleted, months, more: due.length > MAX_PER_RUN });
  if (deleted) await alertOps(`🧹 Automatic deletion: ${deleted} lead${deleted === 1 ? '' : 's'} with no activity for ${months} months deleted${due.length > MAX_PER_RUN ? ' (more tomorrow)' : ''}.`);
  return { deleted, due: due.length, months };
}

function slotMinutes() {
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(String(process.env.RETENTION_HOUR_UTC || '22:00'));
  const mins = m ? Number(m[1]) * 60 + Number(m[2] || 0) : 22 * 60;
  return mins >= 0 && mins < 24 * 60 ? mins : 22 * 60;
}

/** Called every minute by server.js; runs once a day for every active client. */
async function tick(now = new Date()) {
  if (off()) return { ran: false, reason: 'off' };
  const day = now.toISOString().slice(0, 10);
  if (state.doneDay === day) return { ran: false, reason: 'done' };
  if (now.getUTCHours() * 60 + now.getUTCMinutes() < slotMinutes()) return { ran: false, reason: 'not_yet' };
  state.doneDay = day;
  const results = {};
  await registry.ensureLoaded();
  for (const t of registry.list()) {
    if (t.status !== 'active') continue;
    try {
      results[t.slug] = await tenancy.run(t.id, async () => ((await claimDay(day)) ? runTenant(now) : { skipped: 'claimed' }));
    } catch (err) {
      captureException(err, { component: 'retention', tenant: t.slug });
      logger.error('Automatic deletion failed for a client', { tenant: t.slug, error: err.message });
    }
  }
  return { ran: true, results };
}

module.exports = { tick, runTenant, dueLeads, monthsFor, MAX_PER_RUN, SURGE_SHARE, SURGE_MIN, _state: state };

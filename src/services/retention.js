const db = require('../db');
const logger = require('../utils/logger');
const tenancy = require('../tenancy/context');
const registry = require('../tenancy/registry');
const notifyService = require('./notifyService');
const leadDeletion = require('./leadDeletion'); // called through the module, so a test can make one lead fail
const { captureException } = require('../utils/sentry');

/**
 * K31 automatic deletion (agreement 7.6 and Annexure C; privacy page "How long we keep it"):
 * a lead is deleted when its last interaction is older than the client's retention period
 * (tenant setting `retentionMonths`, default 24).
 *
 * Last interaction = the latest of everything about the lead: first contact, its last update, every
 * message in or out (sent or still queued), a webhook event still waiting to be processed, staff
 * notes, outcomes, follow-ups (a follow-up due in the future keeps the lead), assignments, hand-offs
 * and the activity log. A lead with no WhatsApp message yet (a form lead) still has first contact.
 * Each lead is checked again under a row lock right before it is deleted, so a message or a staff
 * action during the run saves it.
 *
 * Deletion goes through leadDeletion.deleteLead (the same path as a deletion request). Kept:
 * the hashed monthly lead count (billing, no personal data) and reply times (no lead key).
 *
 * Guard rails (it runs unattended and deletes for good):
 * - LEAD_RETENTION=off turns it off everywhere;
 * - at most MAX_PER_RUN leads per client per day; the rest wait for the next day;
 * - if more than SURGE_SHARE of a client's leads (and more than SURGE_MIN) are due at once, nothing
 *   is deleted for that client and our ops group is alerted (a clock or data problem looks like this).
 *   After checking, approve it for that client with the tenant setting retentionAllowSurgeUntil
 *   (a date, YYYY-MM-DD): until then the surge check is skipped (the per-run cap still applies);
 * - one lead that fails to delete is counted and reported, and the rest go ahead;
 * - a client whose run fails gets an ops alert and is retried on the next tick that day;
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

// The latest activity of lead row `l` (GREATEST ignores NULLs). Every table is indexed by wa_id.
const LAST_ACTIVITY = `GREATEST(l.first_contact_at, l.last_inbound_message_at, l.last_outbound_message_at, l.updated_at,
  (SELECT MAX(m.timestamp) FROM messages m WHERE m.wa_id = l.wa_id),
  (SELECT MAX(o.created_at) FROM outbound_messages o WHERE o.wa_id = l.wa_id),
  (SELECT MAX(w.created_at) FROM webhook_events w WHERE w.wa_id = l.wa_id),
  (SELECT MAX(n.created_at) FROM crm_lead_notes n WHERE n.wa_id = l.wa_id),
  (SELECT MAX(c.created_at) FROM crm_lead_outcomes c WHERE c.wa_id = l.wa_id),
  (SELECT MAX(GREATEST(f.created_at, f.completed_at, f.due_at)) FROM crm_follow_ups f WHERE f.wa_id = l.wa_id),
  (SELECT MAX(a.assigned_at) FROM crm_lead_assignments a WHERE a.wa_id = l.wa_id),
  (SELECT MAX(GREATEST(h.created_at, h.resolved_at)) FROM handoffs h WHERE h.wa_id = l.wa_id),
  (SELECT MAX(g.created_at) FROM crm_activity_log g WHERE g.wa_id = l.wa_id))`;
const IS_DUE = `${LAST_ACTIVITY} < $1::timestamptz - make_interval(months => $2)`;

/** Leads due for deletion in the current tenant, oldest first (at most `limit`). */
async function dueLeads(months, now = new Date(), limit = MAX_PER_RUN + 1) {
  return db.many(`SELECT l.wa_id FROM leads l WHERE ${IS_DUE} ORDER BY ${LAST_ACTIVITY} LIMIT $3`, [now.toISOString(), months, limit]);
}

/** How many leads are due in all (no cap), for the surge check. */
async function countDue(months, now = new Date()) {
  return (await db.one(`SELECT COUNT(*)::int AS n FROM leads l WHERE ${IS_DUE}`, [now.toISOString(), months])).n;
}

/** Still due? Checked inside the deletion's transaction, after the lead row is locked. */
const stillDue = (months, now) => async key => Boolean(await db.one(`SELECT 1 AS yes FROM leads l WHERE l.wa_id = $3 AND ${IS_DUE}`,
  [now.toISOString(), months, key]));

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
  const dueCount = await countDue(months, now); // all of them, not just this run's batch
  const allowUntil = /^\d{4}-\d{2}-\d{2}$/.test(String(tenant && tenant.retentionAllowSurgeUntil || '')) ? tenant.retentionAllowSurgeUntil : null;
  const surgeApproved = allowUntil && now.toISOString().slice(0, 10) <= allowUntil;
  if (!surgeApproved && dueCount > SURGE_MIN && dueCount > total * SURGE_SHARE) {
    logger.error('Automatic deletion stopped: too many leads due at once', { due: dueCount, total, months });
    await alertOps(`🛑 Automatic deletion stopped: ${dueCount} of ${total} leads are older than ${months} months at once. Nothing was deleted. Check the server clock and the data. If it is right, approve it for this client with the tenant setting retentionAllowSurgeUntil (YYYY-MM-DD).`);
    return { deleted: 0, due: dueCount, months, skipped: 'surge' };
  }
  let deleted = 0;
  let failed = 0;
  const onlyIf = stillDue(months, now);
  for (const { wa_id: key } of due.slice(0, MAX_PER_RUN)) {
    try {
      const r = await leadDeletion.deleteLead(key, { confirm: true, onlyIf });
      if (r.deleted) deleted++;
    } catch (err) { // one bad row must not stop the rest
      failed++;
      captureException(err, { component: 'retention' });
      logger.error('Automatic deletion: a lead could not be deleted', { error: err.message });
    }
  }
  logger.info('Automatic deletion: leads past the retention period deleted', { deleted, failed, months, more: due.length > MAX_PER_RUN });
  if (deleted || failed) {
    await alertOps(`🧹 Automatic deletion: ${deleted} lead${deleted === 1 ? '' : 's'} with no activity for ${months} months deleted${due.length > MAX_PER_RUN ? ' (more tomorrow)' : ''}${failed ? `. ${failed} could not be deleted (see Sentry); they are tried again tomorrow.` : '.'}`);
  }
  return failed ? { deleted, due: due.length, months, failed } : { deleted, due: due.length, months };
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
  const results = {};
  let failures = 0;
  await registry.ensureLoaded(); // throws on a database blip: the next minute tries again
  for (const t of registry.list()) {
    if (t.status !== 'active') continue;
    let claimed = false;
    try {
      results[t.slug] = await tenancy.run(t.id, async () => {
        if (!(await claimDay(day))) return { skipped: 'claimed' };
        claimed = true;
        return runTenant(now);
      });
    } catch (err) {
      failures++;
      captureException(err, { component: 'retention', tenant: t.slug });
      logger.error('Automatic deletion failed for a client', { tenant: t.slug, error: err.message });
      // Give the day back so a later tick retries, and tell us (a log line alone is easy to miss).
      if (claimed) await tenancy.run(t.id, () => db.query("DELETE FROM crm_activity_log WHERE action = 'retention_run' AND details ->> 'day' = $1", [day])).catch(() => {});
      await tenancy.run(t.id, () => alertOps(`⚠️ Automatic deletion failed for this client: ${String(err.message).slice(0, 200)}. It tries again later today.`));
    }
  }
  // Done for today only when every client ran (a failed one is retried on a later tick).
  if (!failures) state.doneDay = day;
  return { ran: true, results };
}

module.exports = { tick, runTenant, dueLeads, countDue, monthsFor, MAX_PER_RUN, SURGE_SHARE, SURGE_MIN, _state: state };

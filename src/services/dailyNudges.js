const db = require('../db');
const logger = require('../utils/logger');
const tenancy = require('../tenancy/context');
const registry = require('../tenancy/registry');
const notifyService = require('./notifyService');
const staffAlerts = require('./staffAlerts');
const { Nudges } = require('../../crm/src/nudges');
const { LeadQueue, parseTime } = require('../../crm/src/queue');
const { localDay, tzOffsetMs } = require('../../crm/src/util');

/**
 * R11b: the morning reminder of leads waiting for an outcome (contract in docs/TEAM.md,
 * "Contract: R11 daily reminder"). Once a day per client, at the start of its working day
 * (Business settings → Lead queue: working hours and time zone):
 * - each person with waiting leads gets one WhatsApp alert (if they have a number and alerts
 *   are not off) naming how many and the oldest; its button opens the oldest lead;
 * - leads with nobody on them go to the managers and owners the same way;
 * - one summary goes to the staff Telegram group.
 * "Sent today" is recorded in crm_activity_log (action daily_nudges_sent, the local day),
 * under an advisory lock, so several processes never send it twice.
 */
const LOCK = 4242011;

const minutesOfDay = (date, tz) => {
  const local = new Date(date.getTime() + tzOffsetMs(date, tz));
  return local.getUTCHours() * 60 + local.getUTCMinutes();
};

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const ageText = hours => (hours >= 48 ? `${Math.floor(hours / 24)} days` : `${hours} h`);

/** The list for one person or the unassigned group: "3 leads waiting for an outcome: Riya, Arjun +1 (oldest 2 days)". */
function summary(leads) {
  const names = leads.slice(0, 2).map(l => l.name);
  const more = leads.length > 2 ? ` +${leads.length - 2}` : '';
  const oldest = Math.max(...leads.map(l => l.hours));
  return `${plural(leads.length, 'lead')} waiting for an outcome: ${names.join(', ')}${more} (oldest ${ageText(oldest)})`;
}

/**
 * Sends today's reminder for the current tenant if it is due and not sent yet.
 * Returns { sent: false, reason } or { sent: true, people, telegram }.
 */
async function runTenant(now = new Date()) {
  const s = await new LeadQueue(db).settings();
  const day = localDay(now.toISOString(), s.timezone);
  if (minutesOfDay(now, s.timezone) < parseTime(s.work_start)) return { sent: false, reason: 'before_start' };

  // Claim today's run (one process only).
  const claimed = await db.tx(async () => {
    await db.query('SELECT pg_advisory_xact_lock($1, $2)', [LOCK, tenancy.tenantId()]);
    const done = await db.one("SELECT 1 AS x FROM crm_activity_log WHERE action = 'daily_nudges_sent' AND details ->> 'day' = $1", [day]);
    if (done) return false;
    await db.query("INSERT INTO crm_activity_log (wa_id, user_id, action, details) VALUES (NULL, NULL, 'daily_nudges_sent', $1::jsonb)", [JSON.stringify({ day })]);
    return true;
  });
  if (!claimed) return { sent: false, reason: 'already_sent' };

  const groups = await new Nudges(db).daily(now);
  if (!groups.length) return { sent: true, people: 0, telegram: false };
  const leaders = groups.some(g => !g.user)
    ? (await db.many("SELECT id FROM crm_users WHERE active AND role IN ('manager', 'owner') ORDER BY id")).map(u => u.id)
    : [];

  let people = 0;
  for (const g of groups) {
    const oldest = g.leads[0]; // oldest first
    const userIds = g.user ? [g.user.id] : leaders;
    people += await staffAlerts.alertUsers({
      waId: oldest.waId, event: 'daily_nudge', userIds, key: day,
      details: g.user ? summary(g.leads) : `Nobody is on these. ${summary(g.leads)}`
    });
  }

  const lines = groups.map(g => `${g.user ? g.user.name : 'Unassigned'}: ${plural(g.leads.length, 'lead')} (oldest ${ageText(Math.max(...g.leads.map(l => l.hours)))})`);
  notifyService.notifyDailyNudges({ lines, total: groups.reduce((n, g) => n + g.leads.length, 0) });
  logger.info('Daily outcome reminder sent', { tenant: tenancy.tenantId(), day, groups: groups.length, whatsapp: people });
  return { sent: true, people, telegram: true };
}

/** Every active client (called every minute; does real work once a day each). */
async function runAll(now = new Date()) {
  const results = {};
  for (const t of registry.list().filter(x => x.active)) {
    try {
      results[t.slug] = await tenancy.run(t.id, () => runTenant(now));
    } catch (err) {
      if (!['42P01', '42703'].includes(err.code)) logger.error('Daily outcome reminder failed', { tenant: t.slug, error: err.message });
    }
  }
  return results;
}

module.exports = { runTenant, runAll, summary, minutesOfDay };

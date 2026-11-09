const db = require('../db');
const logger = require('../utils/logger');
const tenancy = require('../tenancy/context');
const registry = require('../tenancy/registry');
const notifyService = require('./notifyService');
const staffAlerts = require('./staffAlerts');
const { LeadQueue, LEVELS } = require('../../crm/src/queue');

/**
 * K19: the bot side of the hot-lead queue (R2; contract in docs/TEAM.md, "R2 details").
 * - assignOnHandoff: when a hand-off opens, give it to a sales person in turn (if the owner
 *   turned auto-assign on), before the alerts go out, so "their leads only" alerts reach them.
 * - sweepAll: every minute, leads not picked up in 5 / 15 working minutes alert the
 *   assignee's manager / the owners (WhatsApp per person, plus the staff Telegram group).
 * Neither ever throws: the queue must not block a hand-off or a reply.
 */
LeadQueue.botWired = true; // Business settings stops showing "needs the bot update"

const MISSING_CRM = new Set(['42P01', '42703']); // CRM tables not migrated yet (bot-only setups)

async function assignOnHandoff(waId) {
  try {
    return await new LeadQueue(db).autoAssign(waId);
  } catch (err) {
    if (!MISSING_CRM.has(err.code)) logger.error('Lead queue: auto-assign failed; the hand-off stays unassigned', { wa_id: waId, error: err.message });
    return null;
  }
}

/** Sweeps the current tenant. Returns how many leads escalated. */
async function sweepTenant(now = new Date()) {
  const alerts = await new LeadQueue(db).sweep(now);
  if (!alerts.length) return 0;
  // One message per lead and level: WhatsApp to each person, one post to the staff group.
  const groups = new Map();
  for (const a of alerts) {
    const k = `${a.waId}:${a.level}`;
    if (!groups.has(k)) groups.set(k, { waId: a.waId, level: a.level, assigneeId: a.assigneeId, userIds: [] });
    groups.get(k).userIds.push(a.userId);
  }
  const names = new Map((await db.many('SELECT id, name, role FROM crm_users WHERE id = ANY($1::int[])',
    [[...new Set(alerts.flatMap(a => [a.userId, a.assigneeId]))]])).map(u => [u.id, u]));
  for (const g of groups.values()) {
    const minutes = LEVELS[g.level];
    const assignee = names.get(g.assigneeId);
    const to = g.userIds.map(id => names.get(id)?.name).filter(Boolean).join(', ') || 'the owners';
    await staffAlerts.alertUsers({
      waId: g.waId, event: 'not_picked_up', userIds: g.userIds, key: `L${g.level}`,
      details: `Not picked up in ${minutes} min (assigned to ${assignee ? assignee.name : 'nobody'})`
    });
    notifyService.notifyNotPickedUp({ waId: g.waId, minutes, assigneeName: assignee && assignee.name, to });
  }
  logger.info('Lead queue: escalated leads not picked up', { tenant: tenancy.tenantId(), count: groups.size });
  return groups.size;
}

/** Every active tenant, one after another. Safe with several dynos: each level fires once. */
async function sweepAll(now = new Date()) {
  let total = 0;
  for (const t of registry.list().filter(x => x.active)) {
    try {
      total += await tenancy.run(t.id, () => sweepTenant(now));
    } catch (err) {
      if (!MISSING_CRM.has(err.code)) logger.error('Lead queue: sweep failed', { tenant: t.slug, error: err.message });
    }
  }
  return total;
}

module.exports = { assignOnHandoff, sweepTenant, sweepAll };

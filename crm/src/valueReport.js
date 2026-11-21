const { Params } = require('./util');
const { leadScope } = require('./permissions');

/**
 * R18: the value page. One screen (and a printable PDF) for the owner or their agency: what the
 * leads turned into, and what the system did for them, this period against the one before.
 * Built on R5/R6 (crm/src/analytics.js); reads only, scoped like Reports (owner: everything,
 * manager: their team and unassigned leads).
 */

const SYSTEM = { role: 'owner' };
const change = (now, before) => (before ? Math.round(((now - before) / before) * 100) : null);

class ValueReport {
  constructor(db, analytics) { this.db = db; this.analytics = analytics; }

  /** What the bot and the CRM did for these leads in the period (counts only, no lead details). */
  async systemWork(user = SYSTEM, { since, now }) {
    const q = new Params();
    const from = q.p(since.toISOString()); const to = q.p(now.toISOString());
    const scoped = `FROM leads l LEFT JOIN crm_lead_assignments a ON a.wa_id = l.wa_id WHERE ${leadScope(user, q)}`;
    const r = await this.db.one(`SELECT
        -- WhatsApp replies the assistant sent (not staff replies, welcome templates or staff alerts).
        (SELECT COUNT(*) FROM outbound_messages o WHERE o.wa_id IN (SELECT l.wa_id ${scoped})
          AND o.status = 'sent' AND o.created_at >= ${from} AND o.created_at < ${to}
          AND COALESCE(o.metadata ->> 'source', 'bot') NOT IN ('crm', 'intake')
          AND NOT (o.metadata ? 'staff_alert') AND NOT (o.metadata ? 'template'))::int AS bot_replies,
        -- Welcome messages sent to leads from website forms and portals (R16).
        (SELECT COUNT(*) FROM outbound_messages o WHERE o.wa_id IN (SELECT l.wa_id ${scoped})
          AND o.status = 'sent' AND o.metadata ->> 'source' = 'intake' AND o.created_at >= ${from} AND o.created_at < ${to})::int AS welcomes,
        -- New leads that came from a form or portal instead of WhatsApp (R16).
        (SELECT COUNT(*) ${scoped} AND l.source LIKE 'intake\\_%' AND l.first_contact_at >= ${from} AND l.first_contact_at < ${to})::int AS form_leads,
        -- Sales the CRM reported to Meta (Conversions API, K7), so the ads learn who buys.
        (SELECT COUNT(*) FROM crm_lead_outcomes x WHERE x.wa_id IN (SELECT l.wa_id ${scoped})
          AND x.meta_status = 'sent' AND x.created_at >= ${from} AND x.created_at < ${to})::int AS sales_to_meta`, q.values);
    return { botReplies: r.bot_replies, welcomes: r.welcomes, formLeads: r.form_leads, salesToMeta: r.sales_to_meta };
  }

  /** The headline numbers for one period. */
  async period(user, { days, now, names }) {
    const s = await this.analytics.summary(user, { days, now, names });
    const range = await this.analytics.range({ days, now });
    const spend = [...(await this.analytics.adSpend(range)).values()].reduce((t, x) => t + (Number(x.spend) || 0), 0);
    const sales = s.logging.salesRecorded;
    return {
      since: s.since, until: s.until,
      leads: s.funnel.leads,
      qualified: (s.funnel.stages.find(x => x.key === 'qualified') || {}).count || 0,
      medianMinutes: s.speedToLead.medianMinutes,
      withinFive: s.speedToLead.withinFiveMinutes,
      handoffs: s.speedToLead.handoffs,
      handoffsTimed: s.speedToLead.contacted,
      loggingRate: s.logging.rate,
      sales, revenue: s.logging.revenueInr,
      salesAutomatic: s.logging.salesRecordedAutomatically,
      // Cost per customer needs ad spend (K5); until then it is null and the page says so.
      spend: spend || null,
      costPerCustomer: spend && sales ? Math.round(spend / sales) : null,
      bestAd: s.ads.find(a => a.kind === 'ad' && (a.revenueInr > 0 || a.won > 0)) || s.ads.find(a => a.kind === 'ad') || null,
      work: await this.systemWork(user, range)
    };
  }

  /** This period and the one before it (same length), with the change in % for the main numbers. */
  async build(user = SYSTEM, { days = 30, now = new Date(), names = {} } = {}) {
    const current = await this.period(user, { days, now, names });
    const previous = await this.period(user, { days, now: new Date(new Date(current.since).getTime()), names });
    const keys = ['leads', 'qualified', 'sales', 'revenue', 'loggingRate', 'medianMinutes'];
    const changes = Object.fromEntries(keys.map(k => [k, current[k] === null || previous[k] === null ? null : change(current[k], previous[k])]));
    return { days, current, previous, changes };
  }
}

module.exports = { ValueReport };

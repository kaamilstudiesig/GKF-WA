const { Params } = require('./util');
const { leadScope, staffScope } = require('./permissions');
const { OUTCOMES, LOST_REASONS } = require('./constants');
const { LeadQueue, workingMinutes } = require('./queue');
const { lostReasonsFor } = require('../../src/config/verticals');

/**
 * R5 analytics: the numbers for the Reports page, the GKF case study and the
 * analyser (K21). Every method returns plain objects (no HTML, no display text
 * beyond labels), so other code can reuse them. Labels follow the business type
 * (pass `names` from namesFor(type); e.g. real estate "Booked" instead of "Joined").
 *
 * Definitions (also in crm/README.md):
 * - Period: the last `days` days up to `now`.
 * - Funnel: leads whose first message falls in the period, and how far each got, from
 *   the furthest outcome logged on it (or its status, for leads the bot marked).
 * - First contact: the first staff reply sent from the CRM or the first outcome logged,
 *   after the hand-off was opened. A logged "No answer" counts: someone tried.
 * - Speed to lead: working minutes (the client's working hours and time zone, from the lead queue
 *   settings) from hand-off to first contact, for hand-offs opened in the period. A lead that writes
 *   at 2 AM starts counting when the shift starts. "Within 5 minutes" counts only hand-offs that
 *   were contacted or have been open for 5 working minutes, so a brand-new hand-off never lowers it.
 * - Logging rate: share of those hand-offs with an outcome within 24 hours. Hand-offs
 *   younger than 24 hours count only once they have one, so a fresh hand-off never drags it down.
 * - Sales recorded automatically: won outcomes created by a paid payment link (K11).
 * - Revenue (logging.revenueInr): won outcomes logged in the period, whatever month the lead came in.
 *   The funnel's revenueInr is different: money from leads first seen in the period (a cohort).
 *
 * Scope: the same as the rest of the CRM. `user` limits the leads and staff
 * (owner: all; manager: their team and unassigned; sales: their own). Pass no
 * user for the whole business (scripts and K21, which run inside a tenant).
 */

const DAY_MS = 86400000;
const FAST_MINUTES = 5;
const SYSTEM = { role: 'owner' };

// Furthest funnel stage reached, in order. Outcomes decide; status fills in for bot-only leads.
const STAGE_ORDER = ['leads', 'contacted', 'qualified', 'visit_booked', 'visited', 'won'];
const OUTCOME_STAGE = {
  called_connected: 'contacted', no_answer: 'leads', whatsapp_sent: 'contacted',
  visit_booked: 'visit_booked', no_show: 'visit_booked', visited: 'visited', joined: 'won', lost: null
};
const STATUS_STAGE = { new: 'leads', contacted: 'contacted', cold: 'contacted', lost: 'leads', qualified: 'qualified', hot: 'qualified', converted: 'won' };

const median = xs => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);
const round1 = v => (v === null ? null : Math.round(v * 10) / 10);

// First human contact on a hand-off: earliest CRM reply or outcome after it opened, and who did it.
const FIRST_CONTACT = `
  LEFT JOIN LATERAL (
    SELECT t, uid FROM (
      SELECT o.created_at AS t, (o.metadata ->> 'user_id')::int AS uid FROM outbound_messages o
        WHERE o.wa_id = h.wa_id AND o.metadata ->> 'source' = 'crm' AND o.created_at >= h.created_at
      UNION ALL
      SELECT x.created_at, x.user_id FROM crm_lead_outcomes x WHERE x.wa_id = h.wa_id AND x.created_at >= h.created_at
    ) c ORDER BY t LIMIT 1
  ) fc ON TRUE
  LEFT JOIN LATERAL (
    SELECT MIN(x.created_at) AS t FROM crm_lead_outcomes x WHERE x.wa_id = h.wa_id AND x.created_at >= h.created_at
  ) fo ON TRUE`;

class Analytics {
  constructor(db) { this.db = db; }

  /** Everything at once, for the Reports page and K21. */
  async summary(user = SYSTEM, { days = 30, now = new Date(), names = {}, lostNames = null, type = null } = {}) {
    const hours = await new LeadQueue(this.db).settings(); // working hours and time zone
    const range = { days, since: new Date(now.getTime() - days * DAY_MS), now, hours };
    // Lost-reason words follow the business type: pass lostNames (namesFor(type).LOST_REASONS) or the type.
    const lost = lostNames || lostReasonsFor(type);
    // One after another: requests run inside a tenant's transaction context.
    const funnel = await this.funnel(user, range, names);
    const handoffs = await this.handoffStats(user, range);
    const lostReasons = await this.lostReasons(user, range, lost);
    const people = await this.people(user, range);
    return {
      days, since: range.since.toISOString(), until: now.toISOString(),
      funnel, speedToLead: handoffs.speed, logging: { ...handoffs.logging, ...(await this.autoRecorded(user, range)) },
      lostReasons, people
    };
  }

  /** Leads first seen in the period and the furthest stage each reached. */
  async funnel(user = SYSTEM, { since, now }, names = {}) {
    const q = new Params();
    const rows = await this.db.many(`
      SELECT l.status, ARRAY_REMOVE(ARRAY_AGG(DISTINCT x.outcome), NULL) AS outcomes,
        ARRAY(SELECT DISTINCT y.details ->> 'from' FROM crm_activity_log y
          WHERE y.wa_id = l.wa_id AND y.action = 'status_change' AND y.details ->> 'from' IS NOT NULL) AS past,
        COALESCE(SUM(x.amount_inr) FILTER (WHERE x.outcome = 'joined'), 0)::bigint AS revenue
      FROM leads l LEFT JOIN crm_lead_assignments a ON a.wa_id = l.wa_id
        LEFT JOIN crm_lead_outcomes x ON x.wa_id = l.wa_id
      WHERE ${leadScope(user, q)} AND l.first_contact_at >= ${q.p(since.toISOString())} AND l.first_contact_at < ${q.p(now.toISOString())}
      GROUP BY l.wa_id, l.status`, q.values);

    const reached = Object.fromEntries(STAGE_ORDER.map(s => [s, 0]));
    let revenue = 0; let lost = 0;
    for (const r of rows) {
      // A lead's furthest stage: its status now, the statuses it moved through (a lost lead that was
      // qualified still counts as qualified), and its outcomes. Status changes made by the bot are not
      // in the history, so those count only through the current status.
      const stages = [STATUS_STAGE[r.status] || 'leads', ...(r.past || []).map(st => STATUS_STAGE[st]).filter(Boolean),
        ...r.outcomes.map(o => OUTCOME_STAGE[o]).filter(Boolean)];
      const top = Math.max(...stages.map(s => STAGE_ORDER.indexOf(s)));
      for (let i = 0; i <= top; i++) reached[STAGE_ORDER[i]]++;
      revenue += Number(r.revenue);
      if (r.status === 'lost' || r.outcomes.includes('lost')) lost++;
    }
    const label = { leads: 'Leads', contacted: 'Contacted', qualified: 'Qualified', visit_booked: names.visit_booked || OUTCOMES.visit_booked,
      visited: names.visited || OUTCOMES.visited, won: names.joined || OUTCOMES.joined };
    const total = reached.leads;
    return {
      stages: STAGE_ORDER.map((key, i) => ({
        key, label: label[key], count: reached[key],
        ofLeads: pct(reached[key], total),
        fromPrevious: i ? pct(reached[key], reached[STAGE_ORDER[i - 1]]) : null
      })),
      leads: total, won: reached.won, lost, revenueInr: revenue,
      winRate: pct(reached.won, total)
    };
  }

  /** Speed to lead and logging rate, from hand-offs opened in the period. */
  async handoffStats(user = SYSTEM, { since, now, hours }) {
    const q = new Params();
    const rows = await this.db.many(`
      SELECT h.id, h.created_at, fc.t AS contact_at, fc.uid AS contact_by, fo.t AS outcome_at
      FROM handoffs h JOIN leads l ON l.wa_id = h.wa_id LEFT JOIN crm_lead_assignments a ON a.wa_id = l.wa_id
      ${FIRST_CONTACT}
      WHERE ${leadScope(user, q)} AND h.created_at >= ${q.p(since.toISOString())} AND h.created_at < ${q.p(now.toISOString())}`, q.values);
    return this.summarizeHandoffs(rows, now, hours);
  }

  /** Working minutes from a hand-off to its first contact (clock minutes without settings, e.g. in tests of this alone). */
  static minutesToContact(r, hours) {
    return hours ? workingMinutes(r.created_at, r.contact_at, hours) : (new Date(r.contact_at).getTime() - new Date(r.created_at).getTime()) / 60000;
  }

  summarizeHandoffs(rows, now, hours = null) {
    const mins = [];
    let logged = 0; let due = 0; let fastDue = 0;
    for (const r of rows) {
      const opened = new Date(r.created_at).getTime();
      if (r.contact_at) mins.push(Analytics.minutesToContact(r, hours));
      // "Within 5 minutes" only counts hand-offs that had their 5 minutes: contacted, or open that long.
      const openMins = hours ? workingMinutes(r.created_at, now, hours) : (now.getTime() - opened) / 60000;
      if (r.contact_at || openMins >= FAST_MINUTES) fastDue++;
      const loggedInTime = r.outcome_at && new Date(r.outcome_at).getTime() - opened <= DAY_MS;
      if (loggedInTime) logged++;
      if (loggedInTime || now.getTime() - opened >= DAY_MS) due++;
    }
    return {
      speed: {
        handoffs: rows.length, contacted: mins.length, notContacted: rows.length - mins.length,
        medianMinutes: round1(median(mins)),
        withinFiveMinutes: pct(mins.filter(m => m <= FAST_MINUTES).length, fastDue)
      },
      logging: { handoffs: due, loggedWithin24h: logged, rate: pct(logged, due) }
    };
  }

  /** Won outcomes in the period, and how many a paid payment link recorded with no typing. */
  async autoRecorded(user = SYSTEM, { since, now }) {
    const q = new Params();
    const r = await this.db.one(`
      SELECT COUNT(*)::int AS won, COALESCE(SUM(x.amount_inr), 0)::bigint AS revenue,
        COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM crm_payment_links p WHERE p.wa_id = x.wa_id AND p.status = 'paid'
          AND p.paid_at BETWEEN x.created_at - interval '5 minutes' AND x.created_at + interval '5 minutes'))::int AS auto
      FROM crm_lead_outcomes x JOIN leads l ON l.wa_id = x.wa_id LEFT JOIN crm_lead_assignments a ON a.wa_id = l.wa_id
      WHERE ${leadScope(user, q)} AND x.outcome = 'joined' AND x.created_at >= ${q.p(since.toISOString())} AND x.created_at < ${q.p(now.toISOString())}`, q.values);
    return { salesRecorded: r.won, revenueInr: Number(r.revenue), salesRecordedAutomatically: r.auto, autoRate: pct(r.auto, r.won) };
  }

  /** Lost outcomes logged in the period, by reason. lostNames = the business type's wording (lostReasonsFor). */
  async lostReasons(user = SYSTEM, { since, now }, lostNames = {}) {
    const q = new Params();
    const rows = await this.db.many(`
      SELECT COALESCE(x.lost_reason, 'other') AS reason, COUNT(*)::int AS count
      FROM crm_lead_outcomes x JOIN leads l ON l.wa_id = x.wa_id LEFT JOIN crm_lead_assignments a ON a.wa_id = l.wa_id
      WHERE ${leadScope(user, q)} AND x.outcome = 'lost' AND x.created_at >= ${q.p(since.toISOString())} AND x.created_at < ${q.p(now.toISOString())}
      GROUP BY 1 ORDER BY count DESC, reason`, q.values);
    const total = rows.reduce((s, r) => s + r.count, 0);
    return rows.map(r => ({ reason: r.reason, label: lostNames[r.reason] || LOST_REASONS[r.reason] || r.reason, count: r.count, share: pct(r.count, total) }));
  }

  /**
   * Per salesperson (and manager), for the period: first contacts made and how fast,
   * outcomes logged, won and ₹, lost, and the logging rate of hand-offs on leads assigned to them.
   */
  async people(user = SYSTEM, { since, now, hours }) {
    const q = new Params();
    const sinceP = q.p(since.toISOString()); const nowP = q.p(now.toISOString());
    const staff = await this.db.many(`
      SELECT u.id, u.name, u.role,
        COUNT(x.id)::int AS outcomes,
        COUNT(x.id) FILTER (WHERE x.outcome = 'joined')::int AS won,
        COALESCE(SUM(x.amount_inr) FILTER (WHERE x.outcome = 'joined'), 0)::bigint AS revenue,
        COUNT(x.id) FILTER (WHERE x.outcome = 'lost')::int AS lost
      FROM crm_users u LEFT JOIN crm_lead_outcomes x ON x.user_id = u.id AND x.created_at >= ${sinceP} AND x.created_at < ${nowP}
      WHERE u.active AND u.role <> 'owner' AND ${staffScope(user, q)}
      GROUP BY u.id ORDER BY u.role, u.name`, q.values);
    if (!staff.length) return [];

    // Hand-offs on the in-scope staff's leads (assigned to them or first contacted by them) only.
    // Results are only ever read per person in `staff`, which is already scoped to what this user may see.
    const hq = new Params();
    const ids = hq.p(staff.map(s => s.id));
    const handoffs = await this.db.many(`
      SELECT h.created_at, fc.t AS contact_at, fc.uid AS contact_by, fo.t AS outcome_at, a.user_id AS assignee
      FROM handoffs h JOIN leads l ON l.wa_id = h.wa_id LEFT JOIN crm_lead_assignments a ON a.wa_id = l.wa_id
      ${FIRST_CONTACT}
      WHERE h.created_at >= ${hq.p(since.toISOString())} AND h.created_at < ${hq.p(now.toISOString())}
        AND (a.user_id = ANY(${ids}::int[]) OR fc.uid = ANY(${ids}::int[]))`, hq.values);

    return staff.map(s => {
      const contacts = handoffs.filter(h => h.contact_by === s.id)
        .map(h => Analytics.minutesToContact(h, hours));
      const own = this.summarizeHandoffs(handoffs.filter(h => h.assignee === s.id), now, hours);
      return {
        id: s.id, name: s.name, role: s.role,
        firstContacts: contacts.length, medianMinutes: round1(median(contacts)),
        outcomes: s.outcomes, won: s.won, revenueInr: Number(s.revenue), lost: s.lost,
        assignedHandoffs: own.logging.handoffs, loggingRate: own.logging.rate
      };
    });
  }
}

module.exports = { Analytics, STAGE_ORDER, FAST_MINUTES };

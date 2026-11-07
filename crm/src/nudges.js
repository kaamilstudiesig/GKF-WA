const { Params } = require('./util');

/**
 * R11: leads waiting for an outcome. Without outcomes, reports and the Meta loop
 * have nothing to work with, so the CRM keeps reminding people.
 *
 * A lead is waiting when:
 * - it is still open (not converted, lost or cold),
 * - it needed a person: the bot opened a hand-off (open or already resolved), or it is hot,
 * - nobody has logged an outcome since then ("since" = the latest hand-off, or
 *   the first message for a hot lead with no hand-off; leads don't store when they turned
 *   hot, so such a lead is tracked only for 30 days after its first message),
 * - that was at least MIN_AGE_HOURS ago (a fresh hand-off is not overdue yet)
 *   and not more than LOOKBACK_DAYS ago (old leads stop nagging).
 * The same rule feeds the dashboard, the Leads filter and the daily list.
 *
 * A resolved hand-off still counts: "someone handled it but logged nothing" is exactly
 * the gap this closes, because reports and the Meta loop only see outcomes. Logging any
 * outcome ends it.
 */

const MIN_AGE_HOURS = 2;
const LOOKBACK_DAYS = 30;
const HOUR_MS = 3600000;

/** SQL for when the lead started waiting (alias l). */
const SINCE_SQL = `COALESCE(
  (SELECT MAX(h.created_at) FROM handoffs h WHERE h.wa_id = l.wa_id),
  CASE WHEN l.status = 'hot' THEN l.first_contact_at END)`;

/** SQL condition: lead l is waiting for an outcome at `now`. Adds its parameters to q. */
function waitingSql(q, now = new Date()) {
  const latest = q.p(new Date(now.getTime() - MIN_AGE_HOURS * HOUR_MS).toISOString());
  const earliest = q.p(new Date(now.getTime() - LOOKBACK_DAYS * 24 * HOUR_MS).toISOString());
  return `(l.status NOT IN ('converted', 'lost', 'cold')
    AND ${SINCE_SQL} BETWEEN ${earliest} AND ${latest}
    AND NOT EXISTS (SELECT 1 FROM crm_lead_outcomes x WHERE x.wa_id = l.wa_id AND x.created_at >= ${SINCE_SQL}))`;
}

class Nudges {
  constructor(db) { this.db = db; }

  /**
   * The daily list: who has leads waiting, and which. For the bot's morning reminder
   * (Telegram + staff WhatsApp, Kaamil). Runs inside a tenant (tenancy.run), so no
   * tenant filter. Returns
   *   [{ user: { id, name, email, role, alertPhone, alertMode } | null, leads: [{ waId, name, since, hours }] }]
   * alertMode is the person's WhatsApp alert setting ('off', 'mine', 'all'): send to
   * alertPhone only when it is not 'off'.
   * one item per active person with waiting leads assigned (oldest lead first), then
   * one item with user null for unassigned leads (send that one to managers and owners).
   * A lead assigned to someone disabled counts as unassigned.
   */
  async daily(now = new Date()) {
    const q = new Params();
    const rows = await this.db.many(`
      SELECT l.wa_id, COALESCE(NULLIF(l.display_name, ''), l.username, l.phone, l.wa_id) AS name, ${SINCE_SQL} AS since,
        u.id AS user_id, u.name AS user_name, u.email, u.role, u.alert_phone, u.alert_mode
      FROM leads l
        LEFT JOIN crm_lead_assignments a ON a.wa_id = l.wa_id
        LEFT JOIN crm_users u ON u.id = a.user_id AND u.active
      WHERE ${waitingSql(q, now)}
      ORDER BY u.name NULLS LAST, since`, q.values);

    const groups = new Map();
    for (const r of rows) {
      const key = r.user_id || 0;
      if (!groups.has(key)) {
        groups.set(key, {
          user: r.user_id ? { id: r.user_id, name: r.user_name, email: r.email, role: r.role, alertPhone: r.alert_phone || null, alertMode: r.alert_mode || 'off' } : null,
          leads: []
        });
      }
      const since = new Date(r.since);
      groups.get(key).leads.push({ waId: r.wa_id, name: r.name, since: since.toISOString(), hours: Math.floor((now - since) / HOUR_MS) });
    }
    const list = [...groups.values()];
    return [...list.filter(g => g.user), ...list.filter(g => !g.user)];
  }
}

module.exports = { Nudges, waitingSql, SINCE_SQL, MIN_AGE_HOURS, LOOKBACK_DAYS };

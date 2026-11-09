const tenancy = require('../../src/tenancy/context');
const { localDay, localInputToIso } = require('./util');

/**
 * R2: hot-lead queue. Contract in docs/TEAM.md ("R2 details"). Runs inside the
 * caller's tenant (row-level security does the client filtering) and never calls
 * Meta or Telegram: it assigns leads and returns who to alert; the bot sends (K19).
 *
 * - autoAssign(waId): give a hand-off to a sales person, round-robin.
 * - release(userId): hand back someone's leads they haven't picked up yet.
 * - sweep(now): leads not picked up in 5 / 15 working minutes -> manager / owners.
 *
 * "Picked up" = a staff reply from the CRM or any outcome (even "No answer")
 * since the lead was assigned.
 */

const QUEUE_LOCK = 4242003; // pg_advisory_xact_lock(QUEUE_LOCK, tenant_id)
const LEVELS = { 1: 5, 2: 15 }; // escalation level -> working minutes not picked up
const DEFAULTS = { auto_assign: false, auto_assign_since: null, work_start: '09:00', work_end: '21:00', timezone: 'Asia/Kolkata' };
const TIMEZONES = ['Asia/Kolkata', 'Asia/Dubai'];
const DAY_MS = 86400000;

const NOT_PICKED_UP = `
  NOT EXISTS (SELECT 1 FROM outbound_messages o WHERE o.wa_id = a.wa_id AND o.metadata ->> 'source' = 'crm' AND o.created_at >= a.assigned_at)
  AND NOT EXISTS (SELECT 1 FROM crm_lead_outcomes x WHERE x.wa_id = a.wa_id AND x.created_at >= a.assigned_at)`;

/** "09:00", "09:00:00" -> minutes after midnight; null when not a time. */
function parseTime(v) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(v || ''));
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return +m[1] * 60 + +m[2];
}
const hhmm = mins => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

/**
 * Minutes between `from` and `to` that fall inside working hours (work_start to
 * work_end, every day, in `timezone`). A shift that ends after midnight
 * (work_end <= work_start, e.g. 18:00 to 02:00) runs into the next day.
 */
function workingMinutes(from, to, settings = DEFAULTS) {
  const start = new Date(from).getTime(); const end = new Date(to).getTime();
  if (!(end > start)) return 0;
  const tz = settings.timezone || DEFAULTS.timezone;
  const ws = parseTime(settings.work_start) ?? parseTime(DEFAULTS.work_start);
  let we = parseTime(settings.work_end) ?? parseTime(DEFAULTS.work_end);
  if (we <= ws) we += 24 * 60; // overnight shift
  const first = localDay(new Date(start - DAY_MS).toISOString(), tz); // a day earlier, for overnight shifts
  const [y, m, d] = first.split('-').map(Number);
  let total = 0;
  for (let i = 0; ; i++) {
    const day = new Date(Date.UTC(y, m - 1, d + i)).toISOString().slice(0, 10);
    const dayStart = new Date(localInputToIso(`${day}T00:00`, tz)).getTime();
    if (dayStart > end) break;
    const open = dayStart + ws * 60000; const close = dayStart + we * 60000;
    total += Math.max(0, Math.min(end, close) - Math.max(start, open));
    if (i > 400) break; // safety: a year of hand-off is not a real case
  }
  return Math.floor(total / 60000);
}

class LeadQueue {
  constructor(db) { this.db = db; }

  /** This client's queue settings, with defaults when the owner never saved any. */
  async settings() {
    const row = await this.db.one(`SELECT auto_assign, auto_assign_since, work_start::text AS work_start, work_end::text AS work_end, timezone,
      updated_by, updated_at FROM crm_settings`);
    const s = { ...DEFAULTS, ...(row || {}) };
    return { ...s, work_start: hhmm(parseTime(s.work_start)), work_end: hhmm(parseTime(s.work_end)) };
  }

  /** Owner saves the queue settings. Turning auto-assign on starts the clock for escalations. */
  async saveSettings({ autoAssign, workStart, workEnd, timezone }, updatedBy = null) {
    const ws = parseTime(workStart); const we = parseTime(workEnd);
    if (ws === null || we === null) throw new QueueError('Working hours need a start and end time, like 09:00 and 21:00.');
    if (ws === we) throw new QueueError('Working hours need different start and end times.');
    if (!TIMEZONES.includes(timezone)) throw new QueueError('Pick a time zone.');
    await this.db.query(`INSERT INTO crm_settings (auto_assign, auto_assign_since, work_start, work_end, timezone, updated_by, updated_at)
      VALUES ($1, CASE WHEN $1 THEN now() END, $2, $3, $4, $5, now())
      ON CONFLICT (tenant_id) DO UPDATE SET
        auto_assign_since = CASE WHEN EXCLUDED.auto_assign AND NOT crm_settings.auto_assign THEN now() ELSE crm_settings.auto_assign_since END,
        auto_assign = EXCLUDED.auto_assign, work_start = EXCLUDED.work_start, work_end = EXCLUDED.work_end,
        timezone = EXCLUDED.timezone, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [Boolean(autoAssign), hhmm(ws), hhmm(we), timezone, updatedBy]);
    return this.settings();
  }

  /**
   * Gives the lead to someone. Keeps a current assignee who is active, taking leads
   * and not excluded (and restarts their clock for this hand-off); otherwise picks
   * the sales person whose latest assignment is oldest, in the previous assignee's
   * team first. Returns { id, name, email, role } or null (auto-assign off, or nobody available).
   */
  async autoAssign(waId, { exclude = [] } = {}) {
    const s = await this.settings();
    if (!s.auto_assign) return null;
    const skip = exclude.map(Number);
    return this.db.tx(async () => {
      await this.db.query('SELECT pg_advisory_xact_lock($1, $2)', [QUEUE_LOCK, tenancy.tenantId()]);
      const current = await this.db.one(`SELECT u.id, u.name, u.email, u.role, u.active, u.accepting, u.manager_id
        FROM crm_lead_assignments a JOIN crm_users u ON u.id = a.user_id WHERE a.wa_id = $1`, [waId]);

      let pick = current && current.active && current.accepting && !skip.includes(current.id) ? current : null;
      if (!pick) {
        const candidates = await this.db.many(`
          SELECT u.id, u.name, u.email, u.role, u.manager_id,
            (SELECT MAX(x.assigned_at) FROM crm_lead_assignments x WHERE x.user_id = u.id) AS last_assigned
          FROM crm_users u
          WHERE u.role = 'sales' AND u.active AND u.accepting AND NOT (u.id = ANY($1::int[]))
          ORDER BY last_assigned ASC NULLS FIRST, u.id`, [skip]);
        const team = current && current.manager_id ? candidates.filter(c => c.manager_id === current.manager_id) : [];
        pick = team[0] || candidates[0] || null;
      }
      if (!pick) return null;

      await this.db.query(`INSERT INTO crm_lead_assignments (wa_id, user_id, assigned_by, assigned_at, escalation_level)
        VALUES ($1, $2, NULL, now(), 0)
        ON CONFLICT (tenant_id, wa_id) DO UPDATE SET user_id = EXCLUDED.user_id, assigned_by = NULL,
          assigned_at = EXCLUDED.assigned_at, escalation_level = 0`, [waId, pick.id]);
      await this.db.query(`UPDATE handoffs SET status = 'assigned', assigned_to = $1, updated_at = now()
        WHERE wa_id = $2 AND status IN ('pending', 'assigned')`, [pick.email, waId]);
      await this.db.query(`INSERT INTO crm_activity_log (wa_id, user_id, action, details) VALUES ($1, NULL, 'auto_assigned', $2::jsonb)`,
        [waId, JSON.stringify({ to: pick.name, from: current && current.id !== pick.id ? current.name : null })]);
      return { id: pick.id, name: pick.name, email: pick.email, role: pick.role };
    });
  }

  /**
   * Hands back someone's leads with an open hand-off they haven't picked up yet
   * (they turned Taking leads off, or were deactivated). Leads they already picked
   * up stay with them. Returns how many moved; a lead with nobody to take it stays.
   */
  async release(userId) {
    const rows = await this.db.many(`
      SELECT a.wa_id FROM crm_lead_assignments a
      JOIN handoffs h ON h.wa_id = a.wa_id AND h.status IN ('pending', 'assigned')
      WHERE a.user_id = $1 AND ${NOT_PICKED_UP}`, [Number(userId)]);
    let moved = 0;
    for (const r of rows) {
      const to = await this.autoAssign(r.wa_id, { exclude: [userId] });
      if (to && to.id !== Number(userId)) moved++;
    }
    return moved;
  }

  /**
   * Leads assigned since auto-assign was turned on and not picked up after 5 / 15
   * working minutes. Raises each lead's escalation level once (safe with two
   * processes sweeping) and returns one item per person to alert:
   * [{ waId, userId, level, assigneeId }]. Level 1 goes to the assignee's manager
   * (owners when they have none), level 2 to every active owner.
   */
  async sweep(now = new Date()) {
    const s = await this.settings();
    if (!s.auto_assign || !s.auto_assign_since) return [];
    const rows = await this.db.many(`
      SELECT a.wa_id, a.user_id, a.assigned_at, a.assigned_at::text AS assigned_key, a.escalation_level, m.id AS manager_id
      FROM crm_lead_assignments a
      JOIN handoffs h ON h.wa_id = a.wa_id AND h.status = 'assigned'
      JOIN crm_users u ON u.id = a.user_id
      LEFT JOIN crm_users m ON m.id = u.manager_id AND m.active
      WHERE a.escalation_level < 2 AND a.assigned_at >= $1 AND ${NOT_PICKED_UP}`, [s.auto_assign_since]);
    if (!rows.length) return [];
    const owners = (await this.db.many("SELECT id FROM crm_users WHERE role = 'owner' AND active ORDER BY id")).map(o => o.id);

    const alerts = [];
    for (const r of rows) {
      const mins = workingMinutes(r.assigned_at, now, s);
      const level = mins >= LEVELS[2] ? 2 : mins >= LEVELS[1] ? 1 : 0;
      if (level <= r.escalation_level) continue;
      const won = await this.db.one(`UPDATE crm_lead_assignments SET escalation_level = $1
        WHERE wa_id = $2 AND assigned_at = $3::timestamptz AND escalation_level < $1 RETURNING escalation_level`, [level, r.wa_id, r.assigned_key]);
      if (!won) continue; // another process got there first, or the lead was reassigned
      for (let l = r.escalation_level + 1; l <= level; l++) {
        const to = l === 1 && r.manager_id ? [r.manager_id] : owners;
        // assignedAt tells one assignment from the next (a lead handed off again next week escalates again).
        for (const userId of to) alerts.push({ waId: r.wa_id, userId, level: l, assigneeId: r.user_id, assignedAt: new Date(r.assigned_at).toISOString() });
      }
    }
    return alerts;
  }

  /**
   * For screens: working minutes since assignment for leads not picked up yet,
   * keyed by wa_id. Only leads with an open, assigned hand-off.
   */
  async waitingClock(waIds, now = new Date()) {
    if (!waIds.length) return {};
    const s = await this.settings();
    if (!s.auto_assign) return {};
    const rows = await this.db.many(`
      SELECT a.wa_id, a.assigned_at FROM crm_lead_assignments a
      JOIN handoffs h ON h.wa_id = a.wa_id AND h.status = 'assigned'
      WHERE a.wa_id = ANY($1::text[]) AND ${NOT_PICKED_UP}`, [waIds]);
    return Object.fromEntries(rows.map(r => [r.wa_id, workingMinutes(r.assigned_at, now, s)]));
  }
}

/**
 * Only the bot assigns leads when a hand-off opens (K19 calls autoAssign). Until that
 * ships, Business settings shows auto-assign as "needs the bot update" and won't turn it
 * on, so an owner never thinks it's working. K19 sets LeadQueue.botWired = true.
 */
LeadQueue.botWired = false;

class QueueError extends Error {}

module.exports = { LeadQueue, QueueError, workingMinutes, parseTime, DEFAULTS, TIMEZONES, LEVELS };

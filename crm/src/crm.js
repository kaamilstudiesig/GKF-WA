const crypto = require('crypto');
const { Params } = require('./util');
const { leadScope, staffScope, canAssignTo } = require('./permissions');
const { LEAD_STATUSES, WINDOW_MS } = require('./constants');
const { localDay } = require('./util');

const MAX_MESSAGE_LENGTH = 4096; // WhatsApp text limit
const PAGE_SIZE = 25;
const MAX_INT = 2147483647;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const now = () => new Date().toISOString();
const isId = id => Number.isInteger(id) && id > 0 && id <= MAX_INT;
/** jsonb arrives as an object from both drivers; tolerate a string just in case. */
function asObject(v) {
  if (v && typeof v === 'object') return v;
  try { return v ? JSON.parse(v) : {}; } catch (e) { return {}; }
}

const ASSIGN_JOIN = 'LEFT JOIN crm_lead_assignments a ON a.wa_id = l.wa_id';

/**
 * Data access for the CRM. leads, messages, handoffs, outbound_messages and
 * ai_usage belong to the WhatsApp bot; the crm_* tables belong to the CRM.
 * Both live in the same Postgres database.
 */
class Crm {
  constructor(db) {
    this.db = db;
  }

  // ---------- activity ----------

  async log(user, waId, action, details = null) {
    await this.db.query('INSERT INTO crm_activity_log (wa_id, user_id, action, details) VALUES ($1, $2, $3, $4::jsonb)',
      [waId, user ? user.id : null, action, JSON.stringify(details || {})]);
  }

  async leadActivity(waId, limit = 30) {
    const rows = await this.db.many(`
      SELECT al.*, u.name AS user_name FROM crm_activity_log al
      LEFT JOIN crm_users u ON u.id = al.user_id
      WHERE al.wa_id = $1 ORDER BY al.id DESC LIMIT $2
    `, [waId, limit]);
    return rows.map(r => ({ ...r, details: asObject(r.details) }));
  }

  // ---------- leads ----------

  static windowOpen(lastInboundAt) {
    const t = new Date(lastInboundAt).getTime();
    return !isNaN(t) && Date.now() - t <= WINDOW_MS && Date.now() >= t;
  }

  baseLeadSelect() {
    return `
      SELECT l.*, a.user_id AS assignee_id, u.name AS assignee_name,
        (SELECT COUNT(*)::int FROM crm_follow_ups f WHERE f.wa_id = l.wa_id AND f.status = 'open') AS open_followups,
        (SELECT MIN(f.due_at) FROM crm_follow_ups f WHERE f.wa_id = l.wa_id AND f.status = 'open') AS next_followup_at,
        (SELECT m.text FROM messages m WHERE m.wa_id = l.wa_id ORDER BY m.timestamp DESC, m.id DESC LIMIT 1) AS last_message
      FROM leads l
      ${ASSIGN_JOIN}
      LEFT JOIN crm_users u ON u.id = a.user_id
    `;
  }

  formatLead(row) {
    if (!row) return null;
    const metadata = asObject(row.metadata);
    return {
      ...row, metadata, ad: metadata.referral || null,
      needs_human: Boolean(row.needs_human), window_open: Crm.windowOpen(row.last_inbound_message_at)
    };
  }

  async listLeads(user, { status, assignee, needsHuman, q: search, sort, page = 1, pageSize = PAGE_SIZE } = {}) {
    const q = new Params();
    const where = [leadScope(user, q)];

    if (status && LEAD_STATUSES.includes(status)) where.push(`l.status = ${q.p(status)}`);
    if (needsHuman) where.push('l.needs_human');
    if (assignee === 'me') where.push(`a.user_id = ${q.p(user.id)}`);
    else if (assignee === 'unassigned') where.push('a.user_id IS NULL');
    else if (assignee && /^\d{1,9}$/.test(String(assignee))) where.push(`a.user_id = ${q.p(Number(assignee))}`);
    if (search) {
      const like = q.p(`%${String(search).trim()}%`);
      where.push(`(l.wa_id ILIKE ${like} OR l.phone ILIKE ${like} OR l.username ILIKE ${like} OR l.display_name ILIKE ${like} OR l.interest ILIKE ${like})`);
    }

    const orders = {
      recent: 'l.last_inbound_message_at DESC',
      oldest: 'l.last_inbound_message_at ASC',
      created: 'l.first_contact_at DESC',
      attention: 'l.needs_human DESC, l.last_inbound_message_at DESC',
      followup: 'next_followup_at ASC NULLS LAST'
    };
    const order = orders[sort] || orders.attention;
    const whereSql = where.join(' AND ');

    const { total } = await this.db.one(`SELECT COUNT(*)::int AS total FROM leads l ${ASSIGN_JOIN} WHERE ${whereSql}`, [...q.values]);

    const p = Math.min(100000, Math.max(1, Math.floor(Number(page)) || 1));
    const rows = await this.db.many(
      `${this.baseLeadSelect()} WHERE ${whereSql} ORDER BY ${order}, l.wa_id LIMIT ${q.p(pageSize)} OFFSET ${q.p((p - 1) * pageSize)}`,
      q.values
    );

    return { total, page: p, pages: Math.max(1, Math.ceil(total / pageSize)), leads: rows.map(r => this.formatLead(r)) };
  }

  /** Returns the lead if the user may see it, else null. */
  async getLead(user, waId) {
    const q = new Params();
    const sql = `${this.baseLeadSelect()} WHERE l.wa_id = ${q.p(waId)} AND ${leadScope(user, q)}`;
    return this.formatLead(await this.db.one(sql, q.values));
  }

  async requireLead(user, waId) {
    const lead = await this.getLead(user, waId);
    if (!lead) throw new HttpError(404, 'Lead not found or not assigned to you.');
    return lead;
  }

  async messages(waId, limit = 200) {
    return this.db.many(`
      SELECT * FROM (
        SELECT id, direction, text, timestamp FROM messages WHERE wa_id = $1
        ORDER BY timestamp DESC, id DESC LIMIT $2
      ) recent ORDER BY timestamp ASC, id ASC
    `, [waId, limit]);
  }

  /** Staff replies queued by the CRM that the bot has not sent yet (or that failed). */
  async queuedMessages(waId) {
    const rows = await this.db.many(`
      SELECT id, text, status, last_error, created_at, metadata FROM outbound_messages
      WHERE wa_id = $1 AND status IN ('pending', 'sending', 'failed') AND dedup_key LIKE 'crm:%'
      ORDER BY id ASC
    `, [waId]);
    return rows.map(r => ({ ...r, metadata: asObject(r.metadata) }));
  }

  async handoffs(waId) {
    return this.db.many('SELECT * FROM handoffs WHERE wa_id = $1 ORDER BY id DESC LIMIT 20', [waId]);
  }

  async setStatus(user, waId, status) {
    if (!LEAD_STATUSES.includes(status)) throw new HttpError(400, 'Invalid status.');
    const lead = await this.requireLead(user, waId);
    if (lead.status === status) return lead;
    await this.db.tx(async () => {
      await this.db.query('UPDATE leads SET status = $1, updated_at = now() WHERE wa_id = $2', [status, waId]);
      await this.log(user, waId, 'status_change', { from: lead.status, to: status });
    });
    return this.getLead(user, waId);
  }

  async assign(user, waId, targetUserId) {
    const lead = await this.requireLead(user, waId);
    if (!targetUserId) {
      if (user.role === 'sales') throw new HttpError(403, 'Only managers and owners can unassign leads.');
      await this.db.tx(async () => {
        await this.db.query('DELETE FROM crm_lead_assignments WHERE wa_id = $1', [waId]);
        await this.db.query(`UPDATE handoffs SET status = 'pending', assigned_to = NULL, updated_at = now()
          WHERE wa_id = $1 AND status = 'assigned'`, [waId]);
        await this.log(user, waId, 'unassigned', { from: lead.assignee_name });
      });
      return;
    }
    const target = await this.getUser(Number(targetUserId));
    if (!canAssignTo(user, target)) throw new HttpError(403, 'You cannot assign leads to that person.');
    await this.db.tx(async () => {
      await this.db.query(`
        INSERT INTO crm_lead_assignments (wa_id, user_id, assigned_by, assigned_at) VALUES ($1, $2, $3, now())
        ON CONFLICT (wa_id) DO UPDATE SET user_id = EXCLUDED.user_id, assigned_by = EXCLUDED.assigned_by, assigned_at = EXCLUDED.assigned_at
      `, [waId, target.id, user.id]);
      // Mirror onto the bot's handoff record so the bot side shows who picked it up.
      await this.db.query(`UPDATE handoffs SET status = 'assigned', assigned_to = $1, updated_at = now()
        WHERE wa_id = $2 AND status IN ('pending', 'assigned')`, [target.email, waId]);
      await this.log(user, waId, 'assigned', { to: target.name, from: lead.assignee_name || null });
    });
  }

  async resolveHandoff(user, waId) {
    const lead = await this.requireLead(user, waId);
    await this.db.tx(async () => {
      await this.db.query(`UPDATE handoffs SET status = 'resolved', resolved_at = now(), updated_at = now()
        WHERE wa_id = $1 AND status IN ('pending', 'assigned')`, [waId]);
      await this.db.query('UPDATE leads SET needs_human = false, handoff_reason = NULL, updated_at = now() WHERE wa_id = $1', [waId]);
      await this.log(user, waId, 'handoff_resolved', { reason: lead.handoff_reason });
    });
  }

  /**
   * Queues a staff reply in the bot's outbound_messages table. The bot's
   * outbound worker sends it and records it in the conversation history.
   */
  async queueMessage(user, waId, text) {
    const body = String(text || '').trim();
    if (!body) throw new HttpError(400, 'Message is empty.');
    if (body.length > MAX_MESSAGE_LENGTH) throw new HttpError(400, `Message is longer than ${MAX_MESSAGE_LENGTH} characters.`);
    const lead = await this.requireLead(user, waId);
    if (!lead.window_open) {
      throw new HttpError(409, 'The 24-hour WhatsApp reply window is closed. The lead has to message GKF again before staff can reply.');
    }
    await this.db.tx(async () => {
      await this.db.query(`
        INSERT INTO outbound_messages (dedup_key, wa_id, text, status, metadata)
        VALUES ($1, $2, $3, 'pending', $4::jsonb)
      `, [`crm:${crypto.randomUUID()}`, waId, body, JSON.stringify({ source: 'crm', user_id: user.id, user_name: user.name })]);
      if (lead.status === 'new') {
        await this.db.query("UPDATE leads SET status = 'contacted', updated_at = now() WHERE wa_id = $1 AND status = 'new'", [waId]);
        await this.log(user, waId, 'status_change', { from: 'new', to: 'contacted', auto: true });
      }
      await this.log(user, waId, 'message_queued', { preview: body.slice(0, 80) });
    });
  }

  // ---------- notes ----------

  async addNote(user, waId, body) {
    const text = String(body || '').trim();
    if (!text) throw new HttpError(400, 'Note is empty.');
    if (text.length > 5000) throw new HttpError(400, 'Note is too long.');
    await this.requireLead(user, waId);
    await this.db.tx(async () => {
      await this.db.query('INSERT INTO crm_lead_notes (wa_id, user_id, body) VALUES ($1, $2, $3)', [waId, user.id, text]);
      await this.log(user, waId, 'note_added');
    });
  }

  async notes(waId) {
    return this.db.many(`
      SELECT n.*, u.name AS user_name FROM crm_lead_notes n LEFT JOIN crm_users u ON u.id = n.user_id
      WHERE n.wa_id = $1 ORDER BY n.id DESC
    `, [waId]);
  }

  // ---------- follow-ups ----------

  async addFollowUp(user, waId, { title, dueAt, assigneeId }) {
    const t = String(title || '').trim();
    if (!t) throw new HttpError(400, 'Follow-up needs a title.');
    if (!dueAt) throw new HttpError(400, 'Follow-up needs a valid due date.');
    const lead = await this.requireLead(user, waId);
    let ownerId = user.id;
    if (assigneeId && Number(assigneeId) !== user.id) {
      const target = await this.getUser(Number(assigneeId));
      if (!canAssignTo(user, target)) throw new HttpError(403, 'You cannot give follow-ups to that person.');
      ownerId = target.id;
    } else if (!assigneeId && lead.assignee_id && user.role !== 'sales') {
      ownerId = lead.assignee_id;
    }
    await this.db.tx(async () => {
      await this.db.query(`INSERT INTO crm_follow_ups (wa_id, user_id, created_by, title, due_at, status)
        VALUES ($1, $2, $3, $4, $5, 'open')`, [waId, ownerId, user.id, t.slice(0, 200), dueAt]);
      await this.log(user, waId, 'followup_added', { title: t.slice(0, 80), due_at: dueAt });
    });
  }

  async leadFollowUps(waId) {
    return this.db.many(`
      SELECT f.*, u.name AS user_name FROM crm_follow_ups f LEFT JOIN crm_users u ON u.id = f.user_id
      WHERE f.wa_id = $1 ORDER BY f.status = 'done', f.due_at ASC
    `, [waId]);
  }

  /** Follow-ups visible to the user: their own, or (manager/owner) their team's. */
  async listFollowUps(user, { mine = true, status = 'open' } = {}) {
    const q = new Params();
    const scope = mine ? `u.id = ${q.p(user.id)}` : staffScope(user, q);
    return this.db.many(`
      SELECT f.*, u.name AS user_name, l.display_name, l.status AS lead_status
      FROM crm_follow_ups f
      JOIN crm_users u ON u.id = f.user_id
      LEFT JOIN leads l ON l.wa_id = f.wa_id
      WHERE f.status = ${q.p(status)} AND ${scope}
      ORDER BY ${status === 'open' ? 'f.due_at ASC' : 'f.completed_at DESC'} LIMIT 200
    `, q.values);
  }

  async completeFollowUp(user, id) {
    const fid = Number(id);
    const f = isId(fid) ? await this.db.one('SELECT * FROM crm_follow_ups WHERE id = $1', [fid]) : null;
    if (!f) throw new HttpError(404, 'Follow-up not found.');
    const owner = await this.getUser(f.user_id);
    const allowed = f.user_id === user.id || user.role === 'owner' || (user.role === 'manager' && owner && owner.manager_id === user.id);
    if (!allowed) throw new HttpError(403, 'You cannot complete this follow-up.');
    await this.db.tx(async () => {
      await this.db.query("UPDATE crm_follow_ups SET status = 'done', completed_at = now() WHERE id = $1", [f.id]);
      await this.log(user, f.wa_id, 'followup_done', { title: f.title });
    });
    return f;
  }

  // ---------- users ----------

  async getUser(id) {
    return isId(id) ? this.db.one('SELECT * FROM crm_users WHERE id = $1', [id]) : null;
  }

  /** Active people the user may assign leads/follow-ups to. */
  async assignableUsers(user) {
    if (user.role === 'sales') return [];
    const q = new Params();
    return this.db.many(`SELECT id, name, role FROM crm_users u WHERE active AND ${staffScope(user, q)}
      ORDER BY role = 'sales' DESC, name`, q.values);
  }

  // ---------- dashboard & reports ----------

  async statusCounts(user) {
    const q = new Params();
    const rows = await this.db.many(`
      SELECT l.status, COUNT(*)::int AS c FROM leads l ${ASSIGN_JOIN}
      WHERE ${leadScope(user, q)} GROUP BY l.status
    `, q.values);
    const counts = Object.fromEntries(LEAD_STATUSES.map(s => [s, 0]));
    for (const r of rows) counts[r.status] = r.c;
    counts.total = rows.reduce((s, r) => s + r.c, 0);
    return counts;
  }

  async dashboard(user) {
    const q = new Params();
    const since = new Date(Date.now() - 7 * 86400000).toISOString();
    const extraSql = `
      SELECT
        COUNT(*) FILTER (WHERE l.needs_human)::int AS needs_human,
        COUNT(*) FILTER (WHERE a.user_id IS NULL)::int AS unassigned,
        COUNT(*) FILTER (WHERE l.first_contact_at >= ${q.p(since)})::int AS new_this_week
      FROM leads l ${ASSIGN_JOIN} WHERE ${leadScope(user, q)}
    `;
    const counts = await this.statusCounts(user);
    const extra = await this.db.one(extraSql, q.values);
    const attention = (await this.listLeads(user, { needsHuman: true, sort: 'recent', pageSize: 8 })).leads;
    const recent = (await this.listLeads(user, { sort: 'recent', pageSize: 8 })).leads;
    const myFollowUps = (await this.listFollowUps(user, { mine: true })).slice(0, 10);
    const nowIso = now();
    const overdue = myFollowUps.filter(f => f.due_at < nowIso).length;
    return {
      counts,
      needsHuman: extra.needs_human,
      unassigned: extra.unassigned,
      newThisWeek: extra.new_this_week,
      attention, recent, myFollowUps, overdue
    };
  }

  async reports(user, { days = 30, includeAiCost = false, usdToInr = 85 } = {}) {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const counts = await this.statusCounts(user);
    const closed = counts.converted + counts.lost;

    // Runs a lead-scoped query; build(q, scope) returns the SQL using its own Params.
    const scoped = build => { const q = new Params(); const scope = leadScope(user, q); return this.db.many(build(q, scope), q.values); };

    // New leads per day in the display timezone.
    const firstContacts = await scoped((q, scope) => `SELECT l.first_contact_at FROM leads l ${ASSIGN_JOIN}
      WHERE ${scope} AND l.first_contact_at >= ${q.p(since)}`);
    const perDay = {};
    for (let i = Math.min(days, 30) - 1; i >= 0; i--) perDay[localDay(new Date(Date.now() - i * 86400000).toISOString())] = 0;
    for (const r of firstContacts) { const d = localDay(r.first_contact_at); if (d in perDay) perDay[d]++; }

    const interests = await scoped((q, scope) => `SELECT COALESCE(NULLIF(TRIM(l.interest), ''), 'unknown') AS interest, COUNT(*)::int AS c
      FROM leads l ${ASSIGN_JOIN} WHERE ${scope} GROUP BY 1 ORDER BY c DESC, 1 LIMIT 8`);

    const handoffReasons = await scoped((q, scope) => `SELECT h.reason, COUNT(*)::int AS c,
        COUNT(*) FILTER (WHERE h.status <> 'resolved')::int AS open
      FROM handoffs h JOIN leads l ON l.wa_id = h.wa_id ${ASSIGN_JOIN}
      WHERE ${scope} AND h.created_at >= ${q.p(since)} GROUP BY h.reason ORDER BY c DESC, h.reason`);

    // Where leads come from (e.g. instagram_ad vs whatsapp_inbound) and how many join.
    const sources = await scoped((q, scope) => `SELECT l.source, COUNT(*)::int AS c,
        COUNT(*) FILTER (WHERE l.status = 'converted')::int AS converted
      FROM leads l ${ASSIGN_JOIN} WHERE ${scope} AND l.first_contact_at >= ${q.p(since)}
      GROUP BY l.source ORDER BY c DESC, l.source`);

    // Click-to-WhatsApp ads, keyed by the ad id the bot saved at metadata.referral.
    const ads = await scoped((q, scope) => `SELECT
        l.metadata -> 'referral' ->> 'source_id' AS ad_id,
        MAX(l.metadata -> 'referral' ->> 'headline') AS headline,
        MAX(l.metadata -> 'referral' ->> 'platform') AS platform,
        COUNT(*)::int AS c,
        COUNT(*) FILTER (WHERE l.status IN ('hot', 'qualified'))::int AS warm,
        COUNT(*) FILTER (WHERE l.status = 'converted')::int AS converted
      FROM leads l ${ASSIGN_JOIN}
      WHERE ${scope} AND l.first_contact_at >= ${q.p(since)}
        AND jsonb_typeof(l.metadata -> 'referral') = 'object'
      GROUP BY 1 ORDER BY converted DESC, c DESC, 1 LIMIT 20`);

    const rq = new Params();
    const nowP = rq.p(now());
    const sinceP = rq.p(since);
    const reps = await this.db.many(`
      SELECT u.id, u.name, u.role,
        (SELECT COUNT(*)::int FROM crm_lead_assignments x WHERE x.user_id = u.id) AS assigned,
        (SELECT COUNT(*)::int FROM crm_lead_assignments x JOIN leads l ON l.wa_id = x.wa_id WHERE x.user_id = u.id AND l.status = 'hot') AS hot,
        (SELECT COUNT(*)::int FROM crm_lead_assignments x JOIN leads l ON l.wa_id = x.wa_id WHERE x.user_id = u.id AND l.status = 'converted') AS converted,
        (SELECT COUNT(*)::int FROM crm_lead_assignments x JOIN leads l ON l.wa_id = x.wa_id WHERE x.user_id = u.id AND l.status = 'lost') AS lost,
        (SELECT COUNT(*)::int FROM crm_follow_ups f WHERE f.user_id = u.id AND f.status = 'open') AS open_followups,
        (SELECT COUNT(*)::int FROM crm_follow_ups f WHERE f.user_id = u.id AND f.status = 'open' AND f.due_at < ${nowP}) AS overdue,
        (SELECT COUNT(*)::int FROM crm_activity_log al WHERE al.user_id = u.id AND al.created_at >= ${sinceP}) AS actions
      FROM crm_users u WHERE u.active AND u.role <> 'owner' AND ${staffScope(user, rq)}
      ORDER BY u.role, u.name
    `, rq.values);

    let ai = null;
    if (includeAiCost) {
      const rows = await this.db.many(`SELECT model, COUNT(*)::int AS requests,
          COUNT(*) FILTER (WHERE NOT success)::int AS failed,
          (COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0))::bigint AS tokens,
          COALESCE(SUM(cost_usd), 0)::float8 AS cost_usd
        FROM ai_usage WHERE created_at >= $1 GROUP BY model ORDER BY requests DESC, model`, [since]);
      ai = rows.map(r => ({ ...r, tokens: Number(r.tokens), cost_inr: r.cost_usd * usdToInr }));
    }

    return {
      days, counts, usdToInr,
      conversionRate: closed ? Math.round((counts.converted / closed) * 100) : null,
      perDay: Object.entries(perDay).map(([day, c]) => ({ day, c })),
      interests, handoffReasons, reps, ai, sources, ads
    };
  }

  async exportLeads(user) {
    return (await this.listLeads(user, { sort: 'created', pageSize: 100000 })).leads;
  }
}

module.exports = { Crm, HttpError, PAGE_SIZE };

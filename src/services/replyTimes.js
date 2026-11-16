const db = require('../db');
const logger = require('../utils/logger');
const tenancy = require('../tenancy/context');
const clientMonth = require('./clientMonth');
const { captureException } = require('../utils/sentry');

/**
 * K27 reply time (Annexure B: "AI first reply: 95% of eligible messages within 30 seconds, from
 * the Lead's last message in a burst to dispatch; not delivery to the recipient").
 *
 * Eligible: every automatic reply the bot queues for a lead's message (metadata.in_reply_to).
 * After a burst the bot answers the newest message, so in_reply_to is already the last one.
 * Staff replies from the CRM, templates and staff alerts have no in_reply_to and don't count.
 *
 * Measured inside the Platform: from when we received that message (messages.created_at, so a
 * lead's phone clock can't skew it) to when WhatsApp accepted our reply (dispatch).
 * One row per reply in reply_times, kept 13 months (housekeeping).
 *
 * A reply that fails for good is recorded too (outcome 'failed') and always counts as a miss, so
 * an outage can't make the figure look better. The 95th percentile is over sent replies.
 * Known gap: if the dyno stops between "sent" and recording, that one reply is not counted.
 * Months follow the client's time zone; the CRM only offers zones without daylight saving
 * (India, UAE), which monthRange relies on.
 */
const TARGET_MS = 30 * 1000;
const KEEP_DAYS = 400;

/** Records the reply time for a job the outbound worker just sent. Never throws. */
async function record(job, sentAt = new Date(), { outcome = 'sent' } = {}) {
  try {
    const inReplyTo = job && job.metadata && job.metadata.in_reply_to;
    if (!inReplyTo || job.metadata.template) return null;
    const msg = await db.one("SELECT created_at FROM messages WHERE message_id = $1 AND direction = 'in'", [inReplyTo]);
    if (!msg) {
      // A gap in the numbers should be explainable.
      logger.warn('Reply time not recorded: the message it answers was not found', { outbound_id: job.id });
      return null;
    }
    const ms = Math.max(0, sentAt.getTime() - new Date(msg.created_at).getTime());
    await db.query(`INSERT INTO reply_times (outbound_id, received_at, sent_at, reply_ms, outcome) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT DO NOTHING`, [job.id, msg.created_at, sentAt, ms, outcome]);
    return ms;
  } catch (err) {
    logger.warn('Reply time not recorded', { error: err.message });
    captureException(err, { component: 'reply_times' });
    return null;
  }
}

/**
 * One month for the current tenant: { month, replies, failed, p95Ms, withinTargetPct, targetMs }.
 * p95Ms and withinTargetPct are null with no replies.
 */
async function monthStats({ month = null, now = new Date() } = {}) {
  const tz = await clientMonth.timezone();
  const m = month || clientMonth.monthOf(now, tz);
  const { start, end } = clientMonth.monthRange(m, tz);
  const row = await db.one(`SELECT COUNT(*)::int AS n,
      COUNT(*) FILTER (WHERE outcome = 'failed')::int AS failed,
      percentile_disc(0.95) WITHIN GROUP (ORDER BY reply_ms) FILTER (WHERE outcome = 'sent') AS p95,
      COUNT(*) FILTER (WHERE outcome = 'sent' AND reply_ms <= $3)::int AS ok
    FROM reply_times WHERE sent_at >= $1 AND sent_at < $2`, [start, end, TARGET_MS]);
  const n = row ? row.n : 0;
  return {
    month: m, replies: n, failed: n ? row.failed : 0, targetMs: TARGET_MS,
    p95Ms: n && row.p95 !== null ? Number(row.p95) : null,
    withinTargetPct: n ? Math.floor((row.ok * 1000) / n) / 10 : null
  };
}

/** Every client's figures for one month (system context), for the monthly service-level report. */
async function allClients(month) {
  if (!clientMonth.MONTH_RE.test(String(month))) throw new Error('Give the month as YYYY-MM, for example 2026-11.');
  const tenants = await tenancy.runAsSystem(() => db.many("SELECT id, slug, name FROM tenants ORDER BY id"));
  const out = [];
  for (const t of tenants) out.push({ slug: t.slug, name: t.name, ...(await tenancy.run(t.id, () => monthStats({ month }))) });
  return out;
}

/** Housekeeping (all tenants): rows older than 13 months. */
async function cleanup(days = KEEP_DAYS) {
  const r = await db.query(`DELETE FROM reply_times WHERE sent_at < now() - ($1 || ' days')::interval`, [String(days)]);
  return r.rowCount;
}

module.exports = { record, monthStats, allClients, cleanup, TARGET_MS };

const db = require('../db');
const env = require('../config/env');
const registry = require('../tenancy/registry');

// The current tenant's limits (tenant 1: the env vars).
const pauseDefault = () => registry.config()?.limits.botPauseHours ?? env.botPauseHoursAfterStaffReply;
const capDefault = () => registry.config()?.limits.dailyReplyCap ?? env.maxBotRepliesPerLeadPerDay;

/**
 * Decides whether the bot should answer a lead at all:
 * - paused: a staff member replied from the CRM recently, so the bot stays out of their conversation
 *   (staff can end the pause early with "Turn AI back on", stored as leads.metadata.bot_resumed_at);
 * - capped: the lead already got the daily maximum of bot replies (spam or a runaway chat).
 */
// When staff last turned the AI back on for this lead (or -infinity).
const RESUMED_AT = `COALESCE((SELECT (l.metadata->>'bot_resumed_at')::timestamptz FROM leads l WHERE l.wa_id = $1), '-infinity'::timestamptz)`;

const botGuard = {
  /** When the staff pause ends for this lead, or null when the bot is not paused. */
  async pausedUntil(waId, pauseHours = pauseDefault()) {
    if (!(pauseHours > 0)) return null;
    const row = await db.one(`
      SELECT MAX(created_at) + ($2::float8 * interval '1 hour') AS until FROM outbound_messages
      WHERE wa_id = $1 AND metadata->>'source' = 'crm' AND status <> 'failed'
        AND created_at > GREATEST(now() - ($2::float8 * interval '1 hour'), ${RESUMED_AT})`, [waId, pauseHours]);
    return row && row.until ? new Date(row.until).toISOString() : null;
  },

  async check(waId, {
    pauseHours = pauseDefault(),
    dailyCap = capDefault()
  } = {}) {
    const row = await db.one(`
      SELECT
        COUNT(*) FILTER (WHERE metadata->>'source' = 'crm' AND status <> 'failed'
          AND created_at > GREATEST(now() - ($2::float8 * interval '1 hour'), ${RESUMED_AT}))::int AS staff_recent,
        COUNT(*) FILTER (WHERE COALESCE(metadata->>'source', 'bot') <> 'crm'
          AND created_at > now() - interval '24 hours')::int AS bot_replies_today
      FROM outbound_messages WHERE wa_id = $1`, [waId, pauseHours]);
    const paused = pauseHours > 0 && row.staff_recent > 0;
    return {
      paused,
      botRepliesToday: row.bot_replies_today,
      // Exactly at the cap: one last polite reply and a hand-off. Past it: silence.
      capReached: !paused && dailyCap > 0 && row.bot_replies_today === dailyCap,
      overCap: !paused && dailyCap > 0 && row.bot_replies_today > dailyCap
    };
  }
};

module.exports = botGuard;

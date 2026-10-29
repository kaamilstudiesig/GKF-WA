const db = require('../db');
const env = require('../config/env');

/**
 * Decides whether the bot should answer a lead at all:
 * - paused: a staff member replied from the CRM recently, so the bot stays out of their conversation;
 * - capped: the lead already got the daily maximum of bot replies (spam or a runaway chat).
 */
const botGuard = {
  async check(waId, {
    pauseHours = env.botPauseHoursAfterStaffReply,
    dailyCap = env.maxBotRepliesPerLeadPerDay
  } = {}) {
    const row = await db.one(`
      SELECT
        COUNT(*) FILTER (WHERE metadata->>'source' = 'crm' AND status <> 'failed'
          AND created_at > now() - ($2::float8 * interval '1 hour'))::int AS staff_recent,
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

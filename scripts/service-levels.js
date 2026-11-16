/**
 * K27: every client's reply-time figures for one month (Annexure B, shared on request).
 *
 *   heroku run -a gkf-wa "npm run service-levels -- --month 2026-11"
 *
 * Reply time: from when we received the lead's last message to dispatch, automatic replies only.
 * Availability is not here: it comes from the external uptime monitor's monthly report.
 */
require('dotenv').config({ quiet: true });
const db = require('../src/db');
const replyTimes = require('../src/services/replyTimes');

async function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--month');
  const month = i >= 0 ? args[i + 1] : null;
  if (!month) throw new Error('Give the month: npm run service-levels -- --month 2026-11');
  const rows = await replyTimes.allClients(month);
  console.log(`Reply time in ${month} (target: 95% within ${replyTimes.TARGET_MS / 1000} s):`);
  console.table(rows.map(r => ({
    client: r.slug, replies: r.replies,
    within_30s: r.withinTargetPct === null ? '' : `${r.withinTargetPct}%`,
    p95_seconds: r.p95Ms === null ? '' : (r.p95Ms / 1000).toFixed(1),
    met: r.withinTargetPct === null ? '' : r.withinTargetPct >= 95 ? 'yes' : 'NO'
  })));
}

main()
  .catch(err => { console.error(err.message); process.exitCode = 1; })
  .finally(() => db.close());

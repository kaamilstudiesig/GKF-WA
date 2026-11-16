/**
 * K26: every client's lead count for one month, for invoicing (agreement clause 4.3).
 *
 *   heroku run -a gkf-wa "npm run usage -- --month 2026-11"
 *   npm run usage                      the current month (UTC)
 *
 * A lead is a person counted once per calendar month (the client's time zone), across channels.
 * Read-only; prints no phone numbers (the meter stores only hashes).
 */
require('dotenv').config({ quiet: true });
const db = require('../src/db');
const leadUsage = require('../src/services/leadUsage');

async function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--month');
  const month = i >= 0 ? args[i + 1] : new Date().toISOString().slice(0, 7);
  const rows = await leadUsage.allClients(month);
  console.log(`Leads in ${month} (each person once, across channels):`);
  console.table(rows.map(r => ({ client: r.slug, name: r.name, status: r.status, leads: r.leads, limit: r.limit ?? 'not set', over: r.over ?? '' })));
}

main()
  .catch(err => { console.error(err.message); process.exitCode = 1; })
  .finally(() => db.close());

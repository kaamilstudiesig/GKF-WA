#!/usr/bin/env node
/**
 * Deletes everything we hold about one lead (privacy / data deletion request).
 *   npm run delete-lead -- <lead key>            # dry run: shows what would be deleted
 *   npm run delete-lead -- <lead key> --confirm  # deletes
 * On Heroku: heroku run "npm run delete-lead -- 9198xxxxxxx --confirm" -a gkf-wa
 * The lead key is the wa_id shown in the CRM URL (/leads/<key>): a phone number or a WhatsApp user ID.
 * Backups roll over within 30 days.
 */
const db = require('../src/db');

const COUNTS = [
  ['messages', 'SELECT COUNT(*)::int AS n FROM messages WHERE wa_id = $1'],
  ['handoffs', 'SELECT COUNT(*)::int AS n FROM handoffs WHERE wa_id = $1'],
  ['outbound_messages', 'SELECT COUNT(*)::int AS n FROM outbound_messages WHERE wa_id = $1'],
  ['webhook_events', 'SELECT COUNT(*)::int AS n FROM webhook_events WHERE wa_id = $1']
];

async function deleteLead(key, { confirm = false } = {}) {
  await db.init();
  const lead = await db.one('SELECT wa_id, display_name FROM leads WHERE wa_id = $1', [key]);
  if (!lead) return { found: false };
  const counts = {};
  for (const [table, sql] of COUNTS) counts[table] = (await db.one(sql, [key])).n;
  const hasCrmLog = Boolean((await db.one("SELECT to_regclass('crm_activity_log') AS t")).t);
  if (hasCrmLog) counts.crm_activity_log = (await db.one('SELECT COUNT(*)::int AS n FROM crm_activity_log WHERE wa_id = $1', [key])).n;
  if (!confirm) return { found: true, deleted: false, counts };
  await db.tx(async () => {
    // Queue tables have no foreign key to leads; everything else cascades from leads.
    await db.query('DELETE FROM outbound_messages WHERE wa_id = $1', [key]);
    await db.query('DELETE FROM webhook_events WHERE wa_id = $1', [key]);
    if (hasCrmLog) await db.query('DELETE FROM crm_activity_log WHERE wa_id = $1', [key]); // no FK either
    await db.query('DELETE FROM leads WHERE wa_id = $1', [key]);
  });
  return { found: true, deleted: true, counts };
}

if (require.main === module) {
  const [key, flag] = process.argv.slice(2);
  if (!key) {
    console.error('Usage: npm run delete-lead -- <lead key> [--confirm]');
    process.exit(1);
  }
  deleteLead(key, { confirm: flag === '--confirm' })
    .then(r => {
      if (!r.found) console.log(`No lead with key ${key}.`);
      else if (!r.deleted) console.log(`Dry run. Would delete lead ${key} and:`, r.counts, '\nRun again with --confirm to delete.');
      else console.log(`Deleted lead ${key} and:`, r.counts);
    })
    .catch(err => { console.error(err.message); process.exitCode = 1; })
    .finally(() => db.close());
}

module.exports = { deleteLead };

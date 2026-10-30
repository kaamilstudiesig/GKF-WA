/**
 * Restores a backup made by scripts/backup.js into an EMPTY database.
 *
 *   node scripts/restore.js gkf-wa-....json.gz
 *
 * On Heroku: download the file from Telegram, then
 *   heroku run --no-tty "node scripts/restore.js /dev/stdin" < gkf-wa-....json.gz
 */
const fs = require('fs');
const zlib = require('zlib');
const db = require('../src/db');
const { migrateAll } = require('../src/migrate');
const { TABLES } = require('./backup');

const IDENTITY_TABLES = new Set(['messages', 'handoffs', 'outbound_messages', 'ai_usage', 'webhook_events',
  'crm_users', 'crm_lead_notes', 'crm_follow_ups', 'crm_lead_outcomes', 'crm_activity_log']);
const JSON_COLUMNS = new Set(['metadata', 'payload', 'details']);

async function restore(buffer) {
  const doc = JSON.parse(zlib.gunzipSync(buffer).toString('utf8'));
  if (doc.format !== 'gkf-wa-backup') throw new Error('Not a GKF WhatsApp bot backup file.');
  await migrateAll(); // bot and CRM tables
  const existing = await db.one('SELECT COUNT(*)::int AS n FROM leads');
  if (existing.n > 0) throw new Error('Database already has leads; restore only into an empty database.');
  if (doc.tables.crm_users && (await db.one('SELECT COUNT(*)::int AS n FROM crm_users')).n > 0) {
    throw new Error('Database already has CRM staff accounts; restore only into an empty database.');
  }

  const counts = {};
  await db.tx(async () => {
    for (const table of TABLES) { // leads first, so foreign keys resolve
      const rows = doc.tables[table] || [];
      for (const original of rows) {
        // A manager may have a higher id than their reps: link managers after all users exist.
        const row = table === 'crm_users' ? { ...original, manager_id: null } : original;
        const cols = Object.keys(row);
        const values = cols.map(c => (JSON_COLUMNS.has(c) ? JSON.stringify(row[c] ?? {}) : row[c]));
        const overriding = IDENTITY_TABLES.has(table) ? 'OVERRIDING SYSTEM VALUE' : '';
        await db.query(`INSERT INTO ${table} (${cols.join(', ')}) ${overriding} VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, values);
      }
      if (table === 'crm_users') {
        for (const u of rows.filter(r => r.manager_id)) {
          await db.query('UPDATE crm_users SET manager_id = $1 WHERE id = $2', [u.manager_id, u.id]);
        }
      }
      if (IDENTITY_TABLES.has(table)) {
        await db.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), GREATEST(COALESCE((SELECT MAX(id) FROM ${table}), 0), 1), (SELECT COUNT(*) > 0 FROM ${table}))`);
      }
      counts[table] = rows.length;
    }
  });
  return counts;
}

if (require.main === module) {
  const file = process.argv[2];
  if (!file) { console.error('Usage: node scripts/restore.js <backup.json.gz>'); process.exit(1); }
  restore(fs.readFileSync(file))
    .then(counts => { console.log('Restored:', counts); return db.close(); })
    .then(() => process.exit(0))
    .catch(err => { console.error(`Restore failed: ${err.message}`); process.exit(1); });
}

module.exports = { restore };

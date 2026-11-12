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
const tenancy = require('../src/tenancy/context');

const IDENTITY_TABLES = new Set(['messages', 'handoffs', 'outbound_messages', 'ai_usage', 'webhook_events',
  'crm_users', 'crm_lead_notes', 'crm_follow_ups', 'crm_lead_outcomes', 'crm_payment_links', 'crm_activity_log']);
const JSON_COLUMNS = new Set(['metadata', 'payload', 'details', 'profile', 'zoho_state']);
// Rows the Zoho trigger already made while leads were restored: the backup's copy wins.
const UPSERT_KEYS = { zoho_links: ['tenant_id', 'wa_id'] };

/** Restores a backup of all tenants into an empty database (system context). */
async function restore(buffer) {
  const doc = JSON.parse(zlib.gunzipSync(buffer).toString('utf8'));
  if (doc.format !== 'gkf-wa-backup') throw new Error('Not a GKF WhatsApp bot backup file.');
  await migrateAll(); // bot, CRM and platform tables
  return tenancy.runAsSystem(() => restoreAll(doc));
}

async function restoreAll(doc) {
  const existing = await db.one('SELECT COUNT(*)::int AS n FROM leads');
  if (existing.n > 0) throw new Error('Database already has leads; restore only into an empty database.');
  if (doc.tables.crm_users && (await db.one('SELECT COUNT(*)::int AS n FROM crm_users')).n > 0) {
    throw new Error('Database already has CRM staff accounts; restore only into an empty database.');
  }

  const counts = {};
  await db.tx(async () => {
    for (const table of TABLES) { // leads first, so foreign keys resolve
      const rows = doc.tables[table] || [];
      if (table === 'tenants') { // tenant 1 exists after migrating: update it, insert the rest
        for (const t of rows) {
          await db.query(`INSERT INTO tenants (id, slug, name, status, phone_number_id, waba_id, crm_host, settings, secrets, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)
            ON CONFLICT (id) DO UPDATE SET slug = EXCLUDED.slug, name = EXCLUDED.name, status = EXCLUDED.status,
              phone_number_id = EXCLUDED.phone_number_id, waba_id = EXCLUDED.waba_id, crm_host = EXCLUDED.crm_host,
              settings = EXCLUDED.settings, secrets = EXCLUDED.secrets, updated_at = EXCLUDED.updated_at`,
          [t.id, t.slug, t.name, t.status, t.phone_number_id, t.waba_id, t.crm_host, JSON.stringify(t.settings || {}), t.secrets, t.created_at, t.updated_at]);
        }
        await db.query(`SELECT setval(pg_get_serial_sequence('tenants', 'id'), GREATEST(COALESCE((SELECT MAX(id) FROM tenants), 1), 1))`);
        counts[table] = rows.length;
        continue;
      }
      for (const original of rows) {
        // A manager may have a higher id than their reps: link managers after all users exist.
        let row = table === 'crm_users' ? { ...original, manager_id: null } : { ...original };
        // Backups from before K8 have no tenant_id (all tenant 1) and a singleton id on two tables.
        if (!('tenant_id' in row)) row.tenant_id = 1;
        if (table === 'business_profile' || table === 'crm_branding') delete row.id;
        const cols = Object.keys(row);
        // Binary columns (crm_branding.logo_data) are saved as { $base64 } by backup.js.
        const asValue = v => (v && typeof v.$base64 === 'string' ? Buffer.from(v.$base64, 'base64') : v);
        const values = cols.map(c => (JSON_COLUMNS.has(c) ? JSON.stringify(row[c] ?? {}) : asValue(row[c])));
        const overriding = IDENTITY_TABLES.has(table) ? 'OVERRIDING SYSTEM VALUE' : '';
        const keys = UPSERT_KEYS[table];
        const upsert = keys ? ` ON CONFLICT (${keys.join(', ')}) DO UPDATE SET ${cols.filter(c => !keys.includes(c)).map(c => `${c} = EXCLUDED.${c}`).join(', ')}` : '';
        await db.query(`INSERT INTO ${table} (${cols.join(', ')}) ${overriding} VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})${upsert}`, values);
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

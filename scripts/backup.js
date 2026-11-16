/**
 * Exports every table of every tenant (except CRM login sessions) to one gzipped JSON file.
 * K28: the copy that leaves Heroku is always encrypted (BACKUP_ENCRYPTION_KEY) and goes to
 * private object storage (Cloudflare R2), never Telegram. The web dyno makes one a day by
 * itself (src/services/dailyBackup.js); this script is for doing it by hand.
 *
 *   node scripts/backup.js                    -> encrypt and upload one now
 *   node scripts/backup.js --check            -> test storage: upload, read back, compare a tiny file
 *   node scripts/backup.js --out file.enc     -> write an encrypted file locally
 *   node scripts/backup.js --out file.gz --plain  -> unencrypted, for local dev only
 *
 * Heroku's own pg:backups can't dump this database: pg_dump refuses tables with FORCE ROW
 * LEVEL SECURITY. Tenant secrets stay encrypted inside the backup (TENANT_SECRETS_KEY).
 */
const fs = require('fs');
const zlib = require('zlib');
const db = require('../src/db');
const tenancy = require('../src/tenancy/context');

// In restore order: parents before the rows that reference them. tenants comes first.
const PLATFORM_TABLES = ['tenants'];
const BOT_TABLES = ['leads', 'messages', 'handoffs', 'outbound_messages', 'ai_usage', 'webhook_events', 'business_profile'];
const CRM_TABLES = ['crm_users', 'crm_lead_assignments', 'crm_lead_notes', 'crm_follow_ups', 'crm_lead_outcomes', 'crm_payment_links', 'crm_branding', 'crm_activity_log', 'crm_settings',
  'intake_submissions']; // R16 (skipped while a database doesn't have it yet, like the other CRM tables)
// After leads and outcomes: restoring those makes the Zoho trigger add zoho_links rows.
const ZOHO_TABLES = ['zoho_links', 'zoho_cursors'];
// K26 billing count (platform migration 9; skipped while a database doesn't have it yet).
const USAGE_TABLES = ['lead_usage', 'lead_usage_alerts', 'opt_out_list']; // opt_out_list: K31 keeps STOPs of deleted leads (hashed)
// K27 reply times (platform migration 10; skipped while a database doesn't have it yet).
const METRIC_TABLES = ['reply_times'];
const TABLES = [...PLATFORM_TABLES, ...BOT_TABLES, ...CRM_TABLES, ...ZOHO_TABLES, ...USAGE_TABLES, ...METRIC_TABLES];

/** All tenants' rows (system context). */
async function createBackup() {
  return tenancy.runAsSystem(backupAll);
}

async function backupAll() {
  const tables = {};
  for (const t of TABLES) {
    // CRM tables exist once the CRM migrations ran (always, on Heroku).
    if ((CRM_TABLES.includes(t) || ZOHO_TABLES.includes(t) || USAGE_TABLES.includes(t) || METRIC_TABLES.includes(t)) && !(await db.one('SELECT to_regclass($1) AS t', [t])).t) continue;
    // Binary values (crm_branding.logo_data) are stored as { $base64 } so JSON keeps them intact.
    const bin = v => (Buffer.isBuffer(v) || v instanceof Uint8Array ? { $base64: Buffer.from(v).toString('base64') } : v);
    tables[t] = (await db.many(`SELECT * FROM ${t} ORDER BY 1`))
      .map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, bin(v)])));
  }
  const doc = { format: 'gkf-wa-backup', version: 1, created_at: new Date().toISOString(), tables };
  return zlib.gzipSync(Buffer.from(JSON.stringify(doc)));
}

async function main() {
  const backupStore = require('../src/services/backupStore');
  const args = process.argv.slice(2);
  if (args.includes('--check')) {
    const key = `${backupStore.config().prefix}check/${Date.now()}.txt`;
    const body = Buffer.from(`backup storage check ${new Date().toISOString()}`);
    await backupStore.store.put(key, body);
    const back = await backupStore.store.get(key);
    if (!back.equals(body)) throw new Error('Read back a different file.');
    const days = (await backupStore.store.list(backupStore.config().prefix)).filter(k => k.endsWith('.enc'));
    console.log(`Storage OK: wrote and read back ${key}. Encrypted backups stored: ${days.length}${days.length ? `, latest ${days[days.length - 1]}` : ''}.`);
    return;
  }
  const outIdx = args.indexOf('--out');
  if (outIdx !== -1) {
    const plain = await createBackup();
    const file = args[outIdx + 1];
    if (!file) throw new Error('Give a file name after --out.');
    const buffer = args.includes('--plain') ? plain : backupStore.encrypt(plain);
    fs.writeFileSync(file, buffer, { mode: 0o600 });
    console.log(`Backup written to ${file} (${(buffer.length / 1024).toFixed(1)} KB, ${args.includes('--plain') ? 'NOT encrypted' : 'encrypted'})`);
    return;
  }
  const { runBackup } = require('../src/services/dailyBackup');
  const out = await runBackup();
  console.log(`Backup uploaded and verified: ${out.key} (${(out.bytes / 1024).toFixed(1)} KB, encrypted)`);
}

if (require.main === module) {
  main()
    .then(() => db.close())
    .then(() => process.exit(0))
    .catch(err => { console.error(`Backup failed: ${err.message}`); process.exit(1); });
}

module.exports = { createBackup, TABLES, BOT_TABLES, CRM_TABLES, PLATFORM_TABLES, ZOHO_TABLES };

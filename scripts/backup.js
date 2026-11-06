/**
 * Exports every table of every tenant (except CRM login sessions) to one gzipped JSON file.
 *
 *   node scripts/backup.js                 -> sends it to the operator's Telegram group
 *   node scripts/backup.js --out file.gz   -> writes it to a local file instead
 *
 * On Heroku, run it daily with the Heroku Scheduler add-on: `npm run backup`.
 * The file holds every client's leads and chats, so it goes to TELEGRAM_BACKUP_CHAT_ID
 * (or TELEGRAM_OPS_CHAT_ID): the operator's private group, never a client's staff group.
 * Tenant secrets stay encrypted in it.
 */
const fs = require('fs');
const zlib = require('zlib');
const db = require('../src/db');
const tenancy = require('../src/tenancy/context');

// In restore order: parents before the rows that reference them. tenants comes first.
const PLATFORM_TABLES = ['tenants'];
const BOT_TABLES = ['leads', 'messages', 'handoffs', 'outbound_messages', 'ai_usage', 'webhook_events', 'business_profile'];
const CRM_TABLES = ['crm_users', 'crm_lead_assignments', 'crm_lead_notes', 'crm_follow_ups', 'crm_lead_outcomes', 'crm_payment_links', 'crm_branding', 'crm_activity_log'];
const TABLES = [...PLATFORM_TABLES, ...BOT_TABLES, ...CRM_TABLES];

/** All tenants' rows (system context). */
async function createBackup() {
  return tenancy.runAsSystem(backupAll);
}

async function backupAll() {
  const tables = {};
  for (const t of TABLES) {
    // CRM tables exist once the CRM migrations ran (always, on Heroku).
    if (CRM_TABLES.includes(t) && !(await db.one('SELECT to_regclass($1) AS t', [t])).t) continue;
    // Binary values (crm_branding.logo_data) are stored as { $base64 } so JSON keeps them intact.
    const bin = v => (Buffer.isBuffer(v) || v instanceof Uint8Array ? { $base64: Buffer.from(v).toString('base64') } : v);
    tables[t] = (await db.many(`SELECT * FROM ${t} ORDER BY 1`))
      .map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, bin(v)])));
  }
  const doc = { format: 'gkf-wa-backup', version: 1, created_at: new Date().toISOString(), tables };
  return zlib.gzipSync(Buffer.from(JSON.stringify(doc)));
}

async function sendToTelegram(buffer, filename) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_BACKUP_CHAT_ID || process.env.TELEGRAM_OPS_CHAT_ID;
  if (!token || !chatId) {
    throw new Error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_BACKUP_CHAT_ID (or TELEGRAM_OPS_CHAT_ID), or use --out <file>. '
      + 'Backups hold every client\'s data, so they never go to a staff group.');
  }
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('caption', `${process.env.CLIENT_ID || 'gkf'} WhatsApp bot backup ${filename}`);
  form.append('document', new Blob([buffer], { type: 'application/gzip' }), filename);
  const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Telegram upload failed: HTTP ${res.status}`);
}

async function main() {
  const outIdx = process.argv.indexOf('--out');
  const buffer = await createBackup();
  const filename = `${process.env.CLIENT_ID || 'gkf'}-wa-${new Date().toISOString().replace(/[:.]/g, '-')}.json.gz`;
  if (outIdx !== -1) {
    const file = process.argv[outIdx + 1] || filename;
    fs.writeFileSync(file, buffer);
    console.log(`Backup written to ${file} (${(buffer.length / 1024).toFixed(1)} KB)`);
  } else {
    await sendToTelegram(buffer, filename);
    console.log(`Backup sent to Telegram (${(buffer.length / 1024).toFixed(1)} KB)`);
  }
}

if (require.main === module) {
  main()
    .then(() => db.close())
    .then(() => process.exit(0))
    .catch(err => { console.error(`Backup failed: ${err.message}`); process.exit(1); });
}

module.exports = { createBackup, TABLES, BOT_TABLES, CRM_TABLES, PLATFORM_TABLES };

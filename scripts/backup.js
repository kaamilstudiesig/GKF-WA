/**
 * Exports every table to one gzipped JSON file.
 *
 *   node scripts/backup.js                 -> sends it to the Telegram staff group
 *   node scripts/backup.js --out file.gz   -> writes it to a local file instead
 *
 * On Heroku, run it daily with the Heroku Scheduler add-on: `npm run backup`.
 * The file holds every lead's phone number and chats; keep the group private.
 */
const fs = require('fs');
const zlib = require('zlib');
const db = require('../src/db');

const TABLES = ['leads', 'messages', 'handoffs', 'outbound_messages', 'ai_usage', 'webhook_events'];

async function createBackup() {
  const tables = {};
  for (const t of TABLES) tables[t] = await db.many(`SELECT * FROM ${t} ORDER BY 1`);
  const doc = { format: 'gkf-wa-backup', version: 1, created_at: new Date().toISOString(), tables };
  return zlib.gzipSync(Buffer.from(JSON.stringify(doc)));
}

async function sendToTelegram(buffer, filename) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set (or use --out <file>).');
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('caption', `GKF WhatsApp bot backup ${filename}`);
  form.append('document', new Blob([buffer], { type: 'application/gzip' }), filename);
  const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Telegram upload failed: HTTP ${res.status}`);
}

async function main() {
  const outIdx = process.argv.indexOf('--out');
  const buffer = await createBackup();
  const filename = `gkf-wa-${new Date().toISOString().replace(/[:.]/g, '-')}.json.gz`;
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

module.exports = { createBackup, TABLES };

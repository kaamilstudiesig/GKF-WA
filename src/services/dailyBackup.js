const crypto = require('crypto');
const db = require('../db');
const tenancy = require('../tenancy/context');
const registry = require('../tenancy/registry');
const notifyService = require('./notifyService');
const logger = require('../utils/logger');
const backupStore = require('./backupStore');

/**
 * K28: one encrypted off-site backup a day, run by the web dyno (no Scheduler add-on,
 * no extra dyno time). server.js calls tick() every minute; it does nothing until the
 * day's slot (BACKUP_HOUR_UTC, default 21:30 UTC = 03:00 IST) has passed and today's
 * backup isn't done. "Done" means the object was uploaded and read back intact; the
 * dated object key is the record, so a restart finds today's backup by listing once.
 * Failures alert the ops group (at most every 6 hours) and retry every 30 minutes.
 */
const LOCK = 4242028;
const RETRY_MS = 30 * 60 * 1000;
const ALERT_EVERY_MS = 6 * 60 * 60 * 1000;

const state = { doneDay: null, nextTryAt: 0, lastAlertAt: 0, running: null, warnedDay: null };

function slotMinutes() {
  const raw = String(process.env.BACKUP_HOUR_UTC || '21:30');
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(raw);
  const mins = m ? Number(m[1]) * 60 + Number(m[2] || 0) : 21 * 60 + 30;
  return mins >= 0 && mins < 24 * 60 ? mins : 21 * 60 + 30;
}

const dayOf = now => now.toISOString().slice(0, 10); // UTC day
const dayPrefix = (day, cfg = backupStore.config()) => `${cfg.prefix}${day}/`;

/** One line to our ops group (tenant 1's), never a client's staff group. No backup data. */
async function alertOps(text) {
  try {
    await tenancy.run(registry.DEFAULT_TENANT_ID, () => {
      const { token, opsChatId } = notifyService.config;
      if (!notifyService.sendOverride && (!token || !opsChatId)) return null;
      return notifyService.send(text, { ops: true });
    });
  } catch (err) {
    logger.warn('Could not send a backup alert', { error: err.message });
  }
}

const sha = b => crypto.createHash('sha256').update(b).digest('hex');

/** True when the stored object opens with our key and holds a backup (a failed upload can leave a bad one). */
async function isGoodBackup(key) {
  try {
    const plain = backupStore.decrypt(await backupStore.store.get(key));
    return JSON.parse(require('zlib').gunzipSync(plain).toString('utf8')).format === 'gkf-wa-backup';
  } catch (err) {
    logger.warn('Stored backup failed its check', { key, error: err.message });
    return false;
  }
}

/**
 * Makes, encrypts, uploads and verifies one backup. Returns { key, bytes }.
 * The export reads one snapshot (REPEATABLE READ) under an advisory lock, so two processes
 * never export at once and restore never meets a row whose parent was missed. Upload and
 * read-back happen after the transaction, so no database connection waits on storage.
 */
async function runBackup(now = new Date()) {
  const miss = backupStore.missing();
  if (miss.length) throw new Error(`Backups are not set up (missing ${miss.join(', ')}).`);
  const { createBackup } = require('../../scripts/backup'); // lazy: scripts load the db module
  const plain = await tenancy.runAsSystem(() => db.tx(async () => {
    const got = await db.one('SELECT pg_try_advisory_xact_lock($1) AS ok', [LOCK]);
    if (!got.ok) throw new Error('Another backup is running.');
    return createBackup();
  }, { repeatableRead: true }));
  const sealed = backupStore.encrypt(plain);
  const key = `${dayPrefix(dayOf(now))}${backupStore.config().prefix.replace(/\/$/, '')}-wa-${now.toISOString().replace(/[:.]/g, '-')}.json.gz.enc`;
  await backupStore.store.put(key, sealed);
  const back = await backupStore.store.get(key);
  if (sha(back) !== sha(sealed)) throw new Error('The uploaded backup did not read back intact.');
  backupStore.decrypt(back); // and it opens with our key
  return { key, bytes: sealed.length };
}

/** Called every minute. Cheap: no storage or database calls unless a backup is due. */
async function tick(now = new Date()) {
  if (state.running) return state.running;
  const day = dayOf(now);
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (state.doneDay === day || minutes < slotMinutes() || Date.now() < state.nextTryAt) return null;

  const miss = backupStore.missing();
  if (miss.length) {
    if (state.warnedDay !== day) { // once a day, so it is never silent
      state.warnedDay = day;
      logger.warn('Daily backup is not set up', { missing: miss });
      await alertOps(`⚠️ No backup today: backups are not set up (missing ${miss.join(', ')}). See docs/OPERATIONS.md.`);
    }
    return null;
  }

  state.running = (async () => {
    try {
      // After a restart or a failed try: maybe today's backup was already made. Count it only
      // if it passes the check: a failed read-back can leave a bad object behind.
      const existing = (await backupStore.store.list(dayPrefix(day))).filter(k => k.endsWith('.json.gz.enc'));
      if (existing.length && await isGoodBackup(existing[existing.length - 1])) {
        state.doneDay = day;
        return { skipped: true, key: existing[existing.length - 1] };
      }
      const out = await runBackup(now);
      state.doneDay = day;
      state.lastAlertAt = 0;
      logger.info('Daily backup uploaded', { key: out.key, bytes: out.bytes });
      await alertOps(`✅ Backup OK: ${(out.bytes / 1024).toFixed(1)} KB, encrypted, stored off-site.`);
      return out;
    } catch (err) {
      state.nextTryAt = Date.now() + RETRY_MS;
      logger.error('Daily backup failed', { error: err.message });
      if (Date.now() - state.lastAlertAt >= ALERT_EVERY_MS) {
        state.lastAlertAt = Date.now();
        await alertOps(`🚨 Backup failed: ${err.message} Retrying every 30 minutes.`);
      }
      return { error: err.message };
    } finally {
      state.running = null;
    }
  })();
  return state.running;
}

function resetForTests() {
  Object.assign(state, { doneDay: null, nextTryAt: 0, lastAlertAt: 0, running: null, warnedDay: null });
}

module.exports = { tick, runBackup, slotMinutes, dayPrefix, resetForTests, state };

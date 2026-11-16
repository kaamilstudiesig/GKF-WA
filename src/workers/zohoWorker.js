const QueueWorker = require('./queueWorker');
const db = require('../db');
const registry = require('../tenancy/registry');
const tenancy = require('../tenancy/context');
const zoho = require('../services/zoho/client');
const sync = require('../services/zoho/sync');
const opsAlerts = require('../services/opsAlerts');
const logger = require('../utils/logger');

/**
 * K20: keeps each tenant's Zoho CRM in step with its leads.
 * - Push: a database trigger marks a lead dirty when it changes (zoho_links.dirty);
 *   this queue sends it to Zoho, retrying with back-off. A newer change while a lead
 *   is being sent marks it dirty again, so the latest state always goes out.
 * - Pull: every 5 minutes, per tenant with Zoho on, reads what changed in Zoho.
 */
const MAX_ATTEMPTS = 6;
const PULL_MS = 5 * 60 * 1000;
const backoffMin = attempts => Math.min(60, 2 ** attempts); // 2, 4, 8... up to 60 minutes

const enabledTenants = () => registry.list().filter(t => t.active && t.zoho.on).map(t => t.id);

async function claimNext() {
  const ids = enabledTenants();
  if (!ids.length) return null;
  const row = await db.one(`
    UPDATE zoho_links z SET dirty = false, status = 'sending', attempts = z.attempts + 1
    WHERE (z.tenant_id, z.wa_id) = (
      SELECT tenant_id, wa_id FROM zoho_links
      WHERE dirty AND tenant_id = ANY($1::int[]) AND (next_attempt_at IS NULL OR next_attempt_at <= now())
      ORDER BY dirty_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1)
    RETURNING z.*`, [ids]);
  return row ? { ...row, id: row.wa_id } : null;
}

function alertBroken(err) {
  opsAlerts.alert('zoho:auth', 'Zoho CRM sync has stopped', [
    err.message,
    'Reconnect Zoho for this client: node scripts/zoho-connect.js (see docs/ONBOARDING.md).'
  ]);
}

async function handle(link) {
  if (!zoho.enabled()) { // turned off since the claim
    await db.query("UPDATE zoho_links SET status = 'skipped' WHERE wa_id = $1", [link.wa_id]);
    return;
  }
  try {
    const r = await sync.pushLead(link);
    // A change that arrived while sending left dirty = true, so it goes out on the next claim.
    await db.query(`UPDATE zoho_links SET status = 'synced', attempts = 0, next_attempt_at = NULL, last_error = NULL, pushed_at = now()
      WHERE wa_id = $1`, [link.wa_id]);
    logger.info('Zoho: lead synced', { wa_id: link.wa_id, action: r.action });
  } catch (err) {
    const retry = (err.retryable || err.auth) && link.attempts < MAX_ATTEMPTS;
    await db.query(`UPDATE zoho_links SET status = $2, last_error = $3,
        dirty = CASE WHEN $4 THEN true ELSE dirty END,
        next_attempt_at = CASE WHEN $4 THEN now() + ($5 || ' minutes')::interval ELSE next_attempt_at END
      WHERE wa_id = $1`, [link.wa_id, retry ? 'failed' : 'dead', String(err.message).slice(0, 1000), retry, String(backoffMin(link.attempts))]);
    logger.warn('Zoho: lead sync failed', { wa_id: link.wa_id, attempts: link.attempts, retry, error: err.message });
    if (err.auth) alertBroken(err);
  }
}

const zohoWorker = new QueueWorker('Zoho sync worker', { claim: claimNext, handle, concurrency: 1, intervalMs: 30 * 1000 });

/** Reads Zoho changes for every tenant with Zoho on. */
zohoWorker.pullAll = async function pullAll() {
  const results = {};
  for (const id of enabledTenants()) {
    try {
      results[id] = await tenancy.run(id, () => sync.pullChanges());
    } catch (err) {
      results[id] = { error: err.message };
      logger.warn('Zoho: reading changes failed', { tenant: id, error: err.message });
      await tenancy.run(id, () => db.query(`INSERT INTO zoho_cursors (last_error) VALUES ($1)
        ON CONFLICT (tenant_id) DO UPDATE SET last_error = EXCLUDED.last_error, updated_at = now()`, [String(err.message).slice(0, 1000)]))
        .catch(() => {});
      if (err.auth) await tenancy.run(id, async () => alertBroken(err));
    }
  }
  return results;
};

const baseStart = zohoWorker.start.bind(zohoWorker);
const baseStop = zohoWorker.stop.bind(zohoWorker);
zohoWorker.start = function start() {
  baseStart();
  if (!this.pullTimer) {
    this.pullTimer = setInterval(() => this.pullAll().catch(err => logger.error('Zoho pull crashed', { error: err.message })), PULL_MS);
    this.pullTimer.unref();
  }
};
zohoWorker.stop = async function stop(timeoutMs) {
  if (this.pullTimer) clearInterval(this.pullTimer);
  this.pullTimer = null;
  return baseStop(timeoutMs);
};

module.exports = zohoWorker;
module.exports.claimNext = claimNext;
module.exports.handle = handle;

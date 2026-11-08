const { AsyncLocalStorage } = require('async_hooks');
const env = require('../config/env');
const logger = require('../utils/logger');
const tenancy = require('../tenancy/context');
const { migrations } = require('./schema');

/**
 * Postgres access for the whole app.
 *
 * - Production (Heroku): node-postgres pool on DATABASE_URL.
 * - Local dev and tests: PGlite (real Postgres compiled to WASM, in-process),
 *   selected with DATABASE_URL=pglite://memory or pglite://./data/pglite.
 *
 * Rows come back normalised the same way for both drivers: timestamps as ISO
 * strings, int8/BigInt as numbers, jsonb as objects.
 *
 * db.tx(fn) runs fn in a transaction; every db.query() made inside it (including
 * from repositories) automatically uses that transaction.
 *
 * Tenancy (K8): every query runs as the current tenant (src/tenancy/context.js).
 * The tenant is set on the connection with set_config('app.tenant_id'), and row
 * level security only shows that tenant's rows. A connection remembers its
 * setting, so a query costs an extra round trip only when the tenant changes.
 * Inside a transaction the setting is LOCAL and ends with the transaction.
 */
const SET_TENANT = "SELECT set_config('app.tenant_id', $1, $3), set_config('app.all_tenants', $2, $3)";

/** The connection settings for the current work. Throws outside a tenant (fail closed). */
function tenantSettings() {
  const c = tenancy.current();
  if (!c) throw new tenancy.TenancyError('Database query outside a tenant. Wrap the entry point in tenancy.run() or tenancy.runAsSystem().');
  return c.system ? { tenant: '', all: 'on' } : { tenant: String(c.tenantId), all: 'off' };
}
const settingsKey = s => `${s.tenant}|${s.all}`;
const txStore = new AsyncLocalStorage();
let driver = null;
let initPromise = null;

function normaliseRow(row) {
  for (const k of Object.keys(row)) {
    const v = row[k];
    if (v instanceof Date) row[k] = v.toISOString();
    else if (typeof v === 'bigint') row[k] = Number(v);
  }
  return row;
}

async function createPgliteDriver(url) {
  let PGlite;
  try {
    ({ PGlite } = require('@electric-sql/pglite'));
  } catch (e) {
    throw new Error('DATABASE_URL uses pglite:// but @electric-sql/pglite is not installed (it is a dev dependency).');
  }
  const location = url.replace(/^pglite:\/\//, '');
  const inMemory = location === 'memory' || location === '';
  if (!inMemory) require('fs').mkdirSync(require('path').dirname(require('path').resolve(location)), { recursive: true });
  const pg = inMemory ? new PGlite() : new PGlite(location);
  await pg.waitReady;
  // One connection: setting the tenant and running the query must not interleave
  // with another query's, so they run one pair at a time.
  let current = null;
  let chain = Promise.resolve();
  const format = res => ({ rows: res.rows.map(normaliseRow), rowCount: res.affectedRows ?? res.rows.length });
  return {
    kind: 'pglite',
    async query(client, sql, params = []) {
      return format(await (client || pg).query(sql, params));
    },
    queryAs(settings, sql, params = []) {
      const key = settingsKey(settings);
      const run = async () => {
        if (current !== key) {
          await pg.query(SET_TENANT, [settings.tenant, settings.all, false]);
          current = key;
        }
        return format(await pg.query(sql, params));
      };
      const p = chain.then(run, run);
      chain = p.catch(() => {});
      return p;
    },
    async exec(sql) { await pg.exec(sql); },
    async transaction(fn) { return pg.transaction(tx => fn(tx)); },
    async listen(channel, fn) { return pg.listen(channel, fn); }, // in-process: never drops, so no onReconnect
    async close() { await pg.close(); }
  };
}

/**
 * Keeps a LISTEN going on its own client, reconnecting with back-off (1 s doubling to 30 s).
 * NOTIFYs sent while no LISTEN was active are lost, so onReconnect() runs every time LISTEN
 * starts working, the first time included: a viewer who arrived during an outage at start-up
 * still gets one refresh. makeClient() returns a pg Client (tests pass a fake).
 * Returns an async function that stops listening.
 */
function listenLoop(makeClient, channel, fn, { onReconnect, minDelayMs = 1000, maxDelayMs = 30000 } = {}) {
  let client = null; let stopped = false; let delay = minDelayMs;
  const connect = () => {
    if (stopped) return;
    const c = makeClient();
    let dead = false;
    const retry = err => {
      if (dead) return;
      dead = true;
      if (client === c) client = null;
      if (err) logger.warn('LISTEN connection lost; reconnecting', { channel, error: err.message });
      Promise.resolve().then(() => c.end()).catch(() => {});
      if (!stopped) { const t = setTimeout(connect, delay); if (t.unref) t.unref(); delay = Math.min(delay * 2, maxDelayMs); }
    };
    c.on('notification', msg => { if (msg.channel === channel) fn(msg.payload); });
    c.on('error', retry);
    c.on('end', () => retry(null));
    c.connect().then(() => c.query(`LISTEN ${channel}`)).then(() => {
      if (stopped || dead) return;
      client = c; delay = minDelayMs;
      if (onReconnect) {
        try { onReconnect(); } catch (err) { logger.warn('LISTEN onReconnect failed', { channel, error: err.message }); }
      }
    }).catch(retry);
  };
  connect();
  return async () => { stopped = true; if (client) await client.end().catch(() => {}); };
}

function createPgDriver(url) {
  const { Pool, types } = require('pg');
  types.setTypeParser(20, v => (v === null ? null : Number(v)));      // int8 -> number
  types.setTypeParser(1700, v => (v === null ? null : Number(v)));    // numeric -> number
  const isLocal = /@(localhost|127\.0\.0\.1)(:|\/)/.test(url) || process.env.DATABASE_SSL === 'false';
  const pool = new Pool({
    connectionString: url,
    ssl: isLocal ? false : { rejectUnauthorized: false }, // Heroku Postgres requires SSL
    max: Number(process.env.DATABASE_POOL_MAX) || 5,
    idleTimeoutMillis: 30000
  });
  pool.on('error', err => logger.error('Postgres pool error', { error: err.message }));
  const format = res => ({ rows: res.rows.map(normaliseRow), rowCount: res.rowCount });
  return {
    kind: 'pg',
    async query(client, sql, params = []) {
      return format(await (client || pool).query(sql, params));
    },
    async queryAs(settings, sql, params = []) {
      const client = await pool.connect();
      let broken = null;
      try {
        const key = settingsKey(settings);
        if (client.tenancyKey !== key) {
          client.tenancyKey = null; // unknown until the set succeeds
          await client.query(SET_TENANT, [settings.tenant, settings.all, false]);
          client.tenancyKey = key;
        }
        return format(await client.query(sql, params));
      } catch (err) {
        if (!err.code) broken = err; // connection-level error: don't reuse this client
        throw err;
      } finally {
        client.release(broken || undefined);
      }
    },
    async exec(sql) { await pool.query(sql); },
    /**
     * LISTEN on its own connection (a pooled one would be handed to other queries).
     * Reconnects with back-off, so a database restart doesn't stop live updates (see listenLoop).
     */
    async listen(channel, fn, opts = {}) {
      const { Client } = require('pg');
      return listenLoop(() => new Client({ connectionString: url, ssl: isLocal ? false : { rejectUnauthorized: false } }), channel, fn, opts);
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) { /* connection already broken */ }
        throw err;
      } finally {
        client.release();
      }
    },
    async close() { await pool.end(); }
  };
}

function resolveUrl() {
  if (env.databaseUrl) return env.databaseUrl;
  if (env.nodeEnv === 'production') throw new Error('DATABASE_URL is not set.');
  return env.nodeEnv === 'test' ? 'pglite://memory' : 'pglite://./data/pglite';
}

async function init() {
  if (driver) return driver;
  if (!initPromise) {
    initPromise = (async () => {
      const url = resolveUrl();
      const d = url.startsWith('pglite://') ? await createPgliteDriver(url) : createPgDriver(url);
      driver = d;
      await migrate();
      // Then the CRM's and the platform's (tenancy) migrations, so every caller sees the full schema.
      await require('../migrate').migrateAfterBot();
      logger.info('Database ready', { driver: d.kind });
      return d;
    })().catch(err => { initPromise = null; driver = null; throw err; });
  }
  return initPromise;
}

async function query(sql, params) {
  const settings = tenantSettings();
  const d = driver || await init();
  const store = txStore.getStore();
  if (store) return d.query(store.client, sql, params);
  return d.queryAs(settings, sql, params);
}

/** All rows. */
async function many(sql, params) { return (await query(sql, params)).rows; }
/** First row or null. */
async function one(sql, params) { return (await query(sql, params)).rows[0] || null; }

async function tx(fn) {
  if (txStore.getStore()) return fn(); // already inside a transaction
  const settings = tenantSettings();
  const d = driver || await init();
  return d.transaction(async client => {
    await d.query(client, SET_TENANT, [settings.tenant, settings.all, true]); // LOCAL: ends with the transaction
    return txStore.run({ client }, fn);
  });
}

async function migrate() {
  const d = driver;
  await d.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await d.transaction(async client => {
    // Serialise concurrent migrators (e.g. release phase + web dyno start).
    if (d.kind === 'pg') await client.query('SELECT pg_advisory_xact_lock(4242001)');
    const res = await d.query(client, 'SELECT id FROM schema_migrations');
    const applied = new Set(res.rows.map(r => r.id));
    for (const m of migrations) {
      if (applied.has(m.id)) continue;
      logger.info(`Applying migration ${m.id}_${m.name}`);
      for (const stmt of m.up) await d.query(client, stmt);
      await d.query(client, 'INSERT INTO schema_migrations (id, name) VALUES ($1, $2)', [m.id, m.name]);
    }
  });
}

async function close() {
  const d = driver;
  driver = null;
  initPromise = null;
  if (d) await d.close();
}

/** Test helper: empties every app table (all tenants). Tenants other than 1 are removed. */
async function truncateAll() {
  const d = driver || await init();
  const sql = 'TRUNCATE leads, messages, handoffs, webhook_events, outbound_messages, ai_usage RESTART IDENTITY CASCADE';
  // RESTART IDENTITY needs the sequences' owner: locally that is the superuser, not the restricted role.
  if (d.kind === 'pglite') await d.exec(`RESET ROLE; ${sql}; SET ROLE app_tenant;`);
  else await tenancy.runAsSystem(() => query(sql));
}

/**
 * Row-level security does not apply to superusers. PGlite (local and tests) runs
 * as one, so after migrations it switches to a plain role and tests see the same
 * isolation as Heroku. Heroku's app role is the table owner; FORCE ROW LEVEL
 * SECURITY covers owners, and checkRlsActive() warns when the role bypasses it.
 */
async function useRestrictedRole() {
  const d = driver || await init();
  if (d.kind !== 'pglite') return;
  await d.exec(`RESET ROLE;
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_tenant') THEN CREATE ROLE app_tenant NOLOGIN; END IF;
    END $$;
    GRANT USAGE, CREATE ON SCHEMA public TO app_tenant;
    GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public TO app_tenant;
    GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_tenant;
    SET ROLE app_tenant;`);
}

/** Back to the superuser for migrations (PGlite only; no-op on Heroku). */
async function useMigrationRole() {
  const d = driver || await init();
  if (d.kind === 'pglite') await d.exec('RESET ROLE');
}

/**
 * Calls fn(payload) for every NOTIFY on `channel` (all tenants: the payload says which).
 * onReconnect() runs each time LISTEN starts working (first connect and every reconnect):
 * anything sent before or in a gap was missed. Returns an async function that stops listening. Used by the CRM's live board (R3).
 */
async function listen(channel, fn, opts = {}) {
  if (!/^[a-z_]{1,63}$/.test(channel)) throw new Error(`Invalid channel name: ${channel}`);
  const d = driver || await init();
  return d.listen(channel, fn, opts);
}

/** True when row-level security applies to this connection's role (not a superuser, not BYPASSRLS). */
async function checkRlsActive() {
  const row = await tenancy.runAsSystem(() => one('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'));
  return Boolean(row) && !row.rolsuper && !row.rolbypassrls;
}

module.exports = {
  init, query, many, one, tx, listen, listenLoop, close, truncateAll, useRestrictedRole, useMigrationRole, checkRlsActive, driverKind: () => driver && driver.kind
};

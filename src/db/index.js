const { AsyncLocalStorage } = require('async_hooks');
const env = require('../config/env');
const logger = require('../utils/logger');
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
 */
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
  return {
    kind: 'pglite',
    async query(client, sql, params = []) {
      const res = await (client || pg).query(sql, params);
      return { rows: res.rows.map(normaliseRow), rowCount: res.affectedRows ?? res.rows.length };
    },
    async exec(sql) { await pg.exec(sql); },
    async transaction(fn) { return pg.transaction(tx => fn(tx)); },
    async close() { await pg.close(); }
  };
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
  return {
    kind: 'pg',
    async query(client, sql, params = []) {
      const res = await (client || pool).query(sql, params);
      return { rows: res.rows.map(normaliseRow), rowCount: res.rowCount };
    },
    async exec(sql) { await pool.query(sql); },
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
      logger.info('Database ready', { driver: d.kind });
      return d;
    })().catch(err => { initPromise = null; driver = null; throw err; });
  }
  return initPromise;
}

async function query(sql, params) {
  const d = driver || await init();
  const store = txStore.getStore();
  return d.query(store ? store.client : null, sql, params);
}

/** All rows. */
async function many(sql, params) { return (await query(sql, params)).rows; }
/** First row or null. */
async function one(sql, params) { return (await query(sql, params)).rows[0] || null; }

async function tx(fn) {
  if (txStore.getStore()) return fn(); // already inside a transaction
  const d = driver || await init();
  return d.transaction(client => txStore.run({ client }, fn));
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

/** Test helper: empties every app table. */
async function truncateAll() {
  await query(`TRUNCATE leads, messages, handoffs, webhook_events, outbound_messages, ai_usage RESTART IDENTITY CASCADE`);
}

module.exports = { init, query, many, one, tx, close, truncateAll, driverKind: () => driver && driver.kind };

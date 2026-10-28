const { AsyncLocalStorage } = require('async_hooks');

/**
 * Postgres access, with the same interface as the WhatsApp bot's db module
 * (GKF-WA src/db/index.js): init, query, many, one, tx, close.
 *
 * Unlike the bot's module this is a factory, so nothing connects at require
 * time. The CRM app only ever uses the db object it is given, which means the
 * bot's own db module can be passed in once the two apps share one process.
 *
 * - postgres://... (Heroku DATABASE_URL): node-postgres pool, SSL unless localhost.
 * - pglite://memory or pglite://./data/pglite: PGlite (dev and tests only).
 *
 * Rows are normalised the same way for both drivers: timestamps as ISO
 * strings, int8 as numbers, jsonb as objects.
 */

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
  const pg = location === 'memory' || location === '' ? new PGlite() : new PGlite(location);
  await pg.waitReady;
  return {
    kind: 'pglite',
    async query(client, sql, params = []) {
      const res = await (client || pg).query(sql, params);
      return { rows: res.rows.map(normaliseRow), rowCount: res.affectedRows ?? res.rows.length };
    },
    async transaction(fn) { return pg.transaction(t => fn(t)); },
    async close() { await pg.close(); }
  };
}

function createPgDriver(url, { poolMax } = {}) {
  const { Pool, types } = require('pg');
  types.setTypeParser(20, v => (v === null ? null : Number(v)));   // int8 -> number
  types.setTypeParser(1700, v => (v === null ? null : Number(v))); // numeric -> number
  const isLocal = /@(localhost|127\.0\.0\.1)(:|\/)/.test(url) || process.env.DATABASE_SSL === 'false';
  const pool = new Pool({
    connectionString: url,
    ssl: isLocal ? false : { rejectUnauthorized: false }, // Heroku Postgres requires SSL
    max: poolMax || Number(process.env.DATABASE_POOL_MAX) || 5,
    idleTimeoutMillis: 30000
  });
  pool.on('error', err => console.error('Postgres pool error:', err.message));
  return {
    kind: 'pg',
    async query(client, sql, params = []) {
      const res = await (client || pool).query(sql, params);
      return { rows: res.rows.map(normaliseRow), rowCount: res.rowCount };
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

/** Creates a db object for `url`. Connects lazily on the first query (or init()). */
function createDb(url, options = {}) {
  if (!url) throw new Error('DATABASE_URL is not set.');
  const txStore = new AsyncLocalStorage();
  let driver = null;
  let initPromise = null;

  async function init() {
    if (driver) return driver;
    if (!initPromise) {
      initPromise = (url.startsWith('pglite://') ? createPgliteDriver(url) : Promise.resolve(createPgDriver(url, options)))
        .then(d => { driver = d; return d; })
        .catch(err => { initPromise = null; throw err; });
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

  /** Runs fn in a transaction; every query() made inside fn uses it. */
  async function tx(fn) {
    if (txStore.getStore()) return fn(); // already inside a transaction
    const d = driver || await init();
    return d.transaction(client => txStore.run({ client }, fn));
  }

  async function close() {
    const d = driver || (initPromise ? await initPromise.catch(() => null) : null);
    driver = null;
    initPromise = null;
    if (d) await d.close();
  }

  return { init, query, many, one, tx, close, kind: () => (driver ? driver.kind : null) };
}

/**
 * Builds a parameter list while writing SQL: `q.p(value)` adds the value and
 * returns its placeholder ($1, $2, ...).
 */
class Params {
  constructor() { this.values = []; }
  p(value) { this.values.push(value); return `$${this.values.length}`; }
}

module.exports = { createDb, Params, normaliseRow };

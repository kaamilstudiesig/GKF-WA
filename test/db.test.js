const { db } = require('./helpers');
const { test, after } = require('node:test');
const assert = require('node:assert');

after(() => db.close());

test('migrations apply once and are recorded', async () => {
  await db.init();
  const rows = await db.many('SELECT id, name FROM schema_migrations');
  assert.deepStrictEqual(rows.map(r => r.id), [1, 2, 3]);
});

test('rows are normalised: timestamps as ISO strings, counts as numbers, jsonb as objects', async () => {
  await db.query(`INSERT INTO leads (wa_id, metadata) VALUES ('919000000001', $1::jsonb)`, [JSON.stringify({ a: 1 })]);
  const row = await db.one('SELECT created_at, metadata, (SELECT COUNT(*) FROM leads) AS n FROM leads LIMIT 1');
  assert.strictEqual(typeof row.created_at, 'string');
  assert.match(row.created_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.strictEqual(row.n, 1);
  assert.deepStrictEqual(row.metadata, { a: 1 });
});

test('tx() rolls back every statement inside it on error, including nested repository calls', async () => {
  await assert.rejects(db.tx(async () => {
    await db.query(`INSERT INTO leads (wa_id) VALUES ('919000000002')`);
    await db.tx(async () => db.query(`INSERT INTO leads (wa_id) VALUES ('919000000003')`));
    throw new Error('boom');
  }));
  const n = await db.one(`SELECT COUNT(*)::int AS n FROM leads WHERE wa_id IN ('919000000002', '919000000003')`);
  assert.strictEqual(n.n, 0);
});

test('a lead can have only one open hand-off', async () => {
  await db.query(`INSERT INTO leads (wa_id) VALUES ('919000000004')`);
  await db.query(`INSERT INTO handoffs (wa_id, reason) VALUES ('919000000004', 'other')`);
  await assert.rejects(db.query(`INSERT INTO handoffs (wa_id, reason) VALUES ('919000000004', 'complaint')`));
  await db.query(`UPDATE handoffs SET status = 'resolved' WHERE wa_id = '919000000004'`);
  await db.query(`INSERT INTO handoffs (wa_id, reason) VALUES ('919000000004', 'complaint')`);
});

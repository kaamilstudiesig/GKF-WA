const { db, converse } = require('./helpers');
const { test, after } = require('node:test');
const assert = require('node:assert');
const { createBackup } = require('../scripts/backup');
const { restore } = require('../scripts/restore');

after(() => db.close());

test('a backup restores into an empty database with identical data', async () => {
  await converse('919855555501', 'hello', { referral: { source_url: 'https://instagram.com/p/1', source_id: 'AD1' } });
  await converse('919855555501', 'I have back pain, can I train?');
  const before = {
    leads: await db.many('SELECT * FROM leads ORDER BY wa_id'),
    messages: await db.many('SELECT * FROM messages ORDER BY id'),
    handoffs: await db.many('SELECT * FROM handoffs ORDER BY id')
  };
  const file = await createBackup();

  await db.close(); // next query opens a fresh, empty in-memory database
  assert.strictEqual((await db.one('SELECT COUNT(*)::int AS n FROM leads')).n, 0);

  const counts = await restore(file);
  assert.strictEqual(counts.leads, 1);
  assert.deepStrictEqual(await db.many('SELECT * FROM leads ORDER BY wa_id'), before.leads);
  assert.deepStrictEqual(await db.many('SELECT * FROM messages ORDER BY id'), before.messages);
  assert.deepStrictEqual(await db.many('SELECT * FROM handoffs ORDER BY id'), before.handoffs);

  // New rows continue after the restored ids.
  await db.query(`INSERT INTO messages (wa_id, direction, text, timestamp) VALUES ('919855555501', 'in', 'new', now())`);
  const max = await db.one('SELECT MAX(id)::int AS id FROM messages');
  assert.strictEqual(max.id, before.messages.length + 1);

  await assert.rejects(restore(file), /already has leads/);
});

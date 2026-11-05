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

test('brand settings, including the logo image, survive a backup and restore', async () => {
  await db.close();
  await converse('919855555502', 'hello');
  await require('../src/migrate').migrateAll(); // CRM tables too
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  await db.query(`INSERT INTO crm_branding (mark, color, logo_type, logo_data) VALUES ('GK', '#112233', 'image/png', $1)`, [png]);
  const file = await createBackup();
  await db.close();
  await restore(file);
  const row = await db.one('SELECT mark, color, logo_data FROM crm_branding');
  assert.strictEqual(row.mark, 'GK');
  assert.strictEqual(row.color, '#112233');
  assert.ok(Buffer.from(row.logo_data).equals(png));
});

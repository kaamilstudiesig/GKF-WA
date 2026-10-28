const test = require('node:test');
const assert = require('node:assert');
const { AsyncLocalStorage } = require('async_hooks');
const express = require('express');
const request = require('supertest');
const { PGlite } = require('@electric-sql/pglite');
const { createCrmApp, migrateCrm, createDb } = require('../src/index');
const { normaliseRow } = require('../src/db');
const { installBotFixture } = require('../dev/bot-fixture');
const { seedUsers } = require('../scripts/seed');
const { creds, SEED_FILE } = require('./helpers');

/**
 * A db object written independently of src/db.js, shaped like the bot's
 * db module (query/many/one/tx with AsyncLocalStorage), to prove the CRM
 * only uses what it is given.
 */
function botLikeDb(pg) {
  const store = new AsyncLocalStorage();
  const calls = { count: 0 };
  const query = async (sql, params = []) => {
    calls.count++;
    const res = await (store.getStore() || pg).query(sql, params);
    return { rows: res.rows.map(normaliseRow), rowCount: res.affectedRows ?? res.rows.length };
  };
  return {
    calls,
    kind: () => 'pglite', // only needed by the dev fixture
    query,
    many: async (sql, params) => (await query(sql, params)).rows,
    one: async (sql, params) => (await query(sql, params)).rows[0] || null,
    tx: fn => (store.getStore() ? fn() : pg.transaction(t => store.run(t, fn))),
    close: () => pg.close()
  };
}

test('createCrmApp works on an injected db, mounted by Host header next to the bot', async () => {
  const db = botLikeDb(new PGlite());
  try {
    // Pretend the bot already ran its migrations.
    await installBotFixture(db);
    await db.query('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    await db.query("INSERT INTO schema_migrations (id, name) VALUES (1, 'initial')");

    await migrateCrm(db);
    await migrateCrm(db); // idempotent
    await seedUsers(db, SEED_FILE);
    await db.query('UPDATE crm_users SET must_change_password = false');

    assert.deepStrictEqual(await db.many('SELECT id, name FROM schema_migrations'), [{ id: 1, name: 'initial' }]);
    assert.deepStrictEqual(await db.many('SELECT id, name FROM crm_migrations'), [{ id: 1, name: 'initial' }]);

    // One process, routed by Host header, like the merged Heroku app.
    const crmApp = createCrmApp({ db, secureCookies: false });
    const main = express();
    main.use((req, res, next) => (req.hostname === 'crm.goldkraftfitness.com' ? crmApp(req, res, next) : next()));
    main.get('/', (req, res) => res.send('bot'));

    const bot = await request(main).get('/').set('Host', 'wa.goldkraftfitness.com');
    assert.strictEqual(bot.text, 'bot');

    const before = db.calls.count;
    const agent = request.agent(main);
    const host = 'crm.goldkraftfitness.com';
    const { email, password } = creds('owner');
    const loginRes = await agent.post('/login').set('Host', host).type('form').send({ email, password });
    assert.strictEqual(loginRes.status, 302);
    const page = await agent.get('/leads/918050443322').set('Host', host);
    assert.strictEqual(page.status, 200);
    assert.ok(page.text.includes('Arjun Reddy'));
    const csrf = /name="_csrf" value="([^"]+)"/.exec(page.text)[1];

    await agent.post('/leads/918050443322/message').set('Host', host).type('form')
      .send({ _csrf: csrf, text: 'Hi from the merged app' }).expect(302);
    const row = await db.one("SELECT status, metadata FROM outbound_messages WHERE text = 'Hi from the merged app'");
    assert.strictEqual(row.status, 'pending');
    assert.strictEqual(row.metadata.source, 'crm');
    assert.ok(db.calls.count > before, 'CRM queries went through the injected db');

    assert.strictEqual((await request(main).get('/health').set('Host', host)).status, 200);
  } finally {
    await db.close();
  }
});

test('migrateCrm fails with a clear message when the bot tables are missing', async () => {
  const db = createDb('pglite://memory');
  try {
    await assert.rejects(() => migrateCrm(db), /WhatsApp bot's tables are not in this database \(missing table leads/);
    assert.strictEqual(await db.one("SELECT to_regclass('crm_users') AS t").then(r => r.t), null);
  } finally {
    await db.close();
  }
});

test('createCrmApp requires a db object', () => {
  assert.throws(() => createCrmApp({}), /needs a db object/);
});

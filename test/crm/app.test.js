const { setup, login, creds } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const { AsyncLocalStorage } = require('async_hooks');
const request = require('supertest');
const { PGlite } = require('@electric-sql/pglite');
const db = require('../../src/db');
const createApp = require('../../src/app');
const { migrateAll } = require('../../src/migrate');
const { createCrmApp, migrateCrm } = require('../../crm/src');
const { createBackup } = require('../../scripts/backup');
const { restore } = require('../../scripts/restore');

const CRM = 'crm.goldkraftfitness.com';
const BOT = 'wa.goldkraftfitness.com';

test('default host gets the bot: health JSON with the strict CSP', async t => {
  const { cleanup } = await setup();
  t.after(cleanup);
  const app = createApp();
  for (const host of [BOT, 'gkf-wa.herokuapp.com', 'localhost:3000']) {
    const res = await request(app).get('/health').set('Host', host);
    assert.strictEqual(res.status, 200, host);
    assert.strictEqual(res.body.status, 'ok');
    assert.strictEqual(res.headers['content-security-policy'], "default-src 'none'");
  }
  const missing = await request(app).get('/login').set('Host', BOT);
  assert.strictEqual(missing.status, 404);
  assert.deepStrictEqual(missing.body, { error: 'Not found' });
});

test('CRM host gets the CRM login page, without the bot CSP or JSON 404', async t => {
  const { cleanup } = await setup();
  t.after(cleanup);
  const app = createApp();
  for (const host of [CRM, 'crm.localhost:3000', 'CRM.GoldKraftFitness.com']) {
    const res = await request(app).get('/login').set('Host', host);
    assert.strictEqual(res.status, 200, host);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.text, /name="password"/);
    assert.notStrictEqual(res.headers['content-security-policy'], "default-src 'none'");
    assert.match(res.headers['content-security-policy'], /default-src 'self'/);
  }
  const home = await request(app).get('/').set('Host', CRM);
  assert.strictEqual(home.status, 302);
  assert.strictEqual(home.headers.location, '/login');

  const missing = await request(app).get('/webhook').set('Host', CRM);
  assert.strictEqual(missing.status, 302, 'bot routes are not reachable on the CRM host');
  // Static files are served on the CRM host (app.css is built at deploy, so check the committed script).
  const js = await request(app).get('/static/js/app.js').set('Host', CRM);
  assert.strictEqual(js.status, 200);

  const custom = createApp({ crmHosts: ['staff.example.test'] });
  assert.strictEqual((await request(custom).get('/login').set('Host', 'staff.example.test')).status, 200);
  assert.strictEqual((await request(custom).get('/login').set('Host', CRM)).status, 404);
});

test('in production, http is redirected to https and https gets HSTS', async t => {
  const { cleanup } = await setup();
  t.after(cleanup);
  const app = createApp({ forceHttps: true });
  const crmHttp = await request(app).get('/login?next=1').set('Host', CRM).set('X-Forwarded-Proto', 'http');
  assert.strictEqual(crmHttp.status, 301);
  assert.strictEqual(crmHttp.headers.location, `https://${CRM}/login?next=1`);
  const botHttp = await request(app).get('/health').set('Host', BOT).set('X-Forwarded-Proto', 'http');
  assert.strictEqual(botHttp.status, 301);
  const postHttp = await request(app).post('/login').set('Host', CRM).set('X-Forwarded-Proto', 'http').type('form').send({ email: 'x', password: 'y' });
  assert.strictEqual(postHttp.status, 403);
  const crmHttps = await request(app).get('/login').set('Host', CRM).set('X-Forwarded-Proto', 'https');
  assert.strictEqual(crmHttps.status, 200);
  assert.match(crmHttps.headers['strict-transport-security'], /max-age=31536000/);
  const botHttps = await request(app).get('/health').set('Host', BOT).set('X-Forwarded-Proto', 'https');
  assert.strictEqual(botHttps.status, 200);
});

test('a staff reply sent on the CRM host goes through the shared db', async t => {
  const { cleanup } = await setup();
  t.after(cleanup);
  const app = createApp();
  const { agent } = await login(app, 'owner', CRM);
  const page = await agent.get('/leads/918050443322').set('Host', CRM);
  assert.strictEqual(page.status, 200);
  assert.ok(page.text.includes('Arjun Reddy'));
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page.text)[1];
  await agent.post('/leads/918050443322/message').set('Host', CRM).type('form')
    .send({ _csrf: csrf, text: 'Hi from the merged app' }).expect(302);
  const row = await db.one("SELECT status, metadata FROM outbound_messages WHERE text = 'Hi from the merged app'");
  assert.strictEqual(row.status, 'pending');
  assert.strictEqual(row.metadata.source, 'crm');
});

test('CRM session cookies are Secure in production behind the Heroku proxy', async t => {
  const { cleanup } = await setup();
  t.after(cleanup);
  const { email, password } = creds('owner');
  const prod = createApp({ secureCookies: true });
  const res = await request(prod).post('/login').set('Host', CRM).set('X-Forwarded-Proto', 'https')
    .type('form').send({ email, password });
  assert.strictEqual(res.status, 302);
  const cookie = res.headers['set-cookie'].join(';');
  assert.match(cookie, /; Secure/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);

  const dev = await request(createApp({ secureCookies: false })).post('/login').set('Host', CRM).type('form').send({ email, password });
  assert.doesNotMatch(dev.headers['set-cookie'].join(';'), /Secure/);
});

test('bot and CRM migrations coexist and are idempotent', async t => {
  t.after(() => db.close());
  await db.close(); // fresh, empty in-memory database
  await migrateAll();
  await migrateAll();
  await migrateCrm(db);
  assert.deepStrictEqual(await db.many('SELECT id, name FROM schema_migrations ORDER BY id'), [{ id: 1, name: 'initial' }, { id: 2, name: 'bsuid_identity' }, { id: 3, name: 'business_profile' }]);
  assert.deepStrictEqual(await db.many('SELECT id, name FROM crm_migrations ORDER BY id'), [{ id: 1, name: 'initial' }, { id: 2, name: 'lead_outcomes' }, { id: 3, name: 'outcome_meta_events' }]);
  const tables = (await db.many(`SELECT table_name FROM information_schema.tables
    WHERE table_schema = current_schema() ORDER BY table_name`)).map(r => r.table_name);
  for (const tname of ['leads', 'messages', 'handoffs', 'webhook_events', 'outbound_messages', 'ai_usage',
    'crm_users', 'crm_sessions', 'crm_lead_assignments', 'crm_lead_notes', 'crm_follow_ups', 'crm_activity_log']) {
    assert.ok(tables.includes(tname), `missing ${tname}`);
  }
  // The bot's test reset still works with the CRM tables referencing leads.
  await db.query("INSERT INTO leads (wa_id) VALUES ('919000000009')");
  await db.truncateAll();
  assert.strictEqual((await db.one('SELECT COUNT(*)::int AS n FROM leads')).n, 0);
});

test('migrateCrm fails with a clear message when the bot tables are missing', async () => {
  const pg = new PGlite();
  const store = new AsyncLocalStorage();
  const query = async (sql, params = []) => {
    const res = await (store.getStore() || pg).query(sql, params);
    return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length };
  };
  const bare = {
    query,
    many: async (sql, params) => (await query(sql, params)).rows,
    one: async (sql, params) => (await query(sql, params)).rows[0] || null,
    tx: fn => (store.getStore() ? fn() : pg.transaction(tx => store.run(tx, fn)))
  };
  try {
    await assert.rejects(() => migrateCrm(bare), /WhatsApp bot's tables are not in this database \(missing table leads/);
    assert.strictEqual((await bare.one("SELECT to_regclass('crm_users') AS t")).t, null);
  } finally {
    await pg.close();
  }
});

test('backups include CRM staff, notes and assignments, and restore them', async t => {
  const { app, cleanup } = await setup();
  t.after(cleanup);
  const { agent, csrf } = await login(app, 'owner');
  await agent.post('/leads/918050443322/notes').type('form').send({ _csrf: csrf, body: 'Called, will visit Saturday' });
  const tables = ['crm_users', 'crm_lead_notes', 'crm_lead_assignments', 'crm_activity_log'];
  const before = {};
  for (const tname of tables) before[tname] = await db.many(`SELECT * FROM ${tname} ORDER BY 1`);
  assert.strictEqual(before.crm_lead_notes.length, 1);
  const file = await createBackup();

  await db.close();
  const counts = await restore(file);
  assert.strictEqual(counts.crm_users, before.crm_users.length);
  for (const tname of tables) assert.deepStrictEqual(await db.many(`SELECT * FROM ${tname} ORDER BY 1`), before[tname], tname);
  assert.strictEqual((await db.one('SELECT COUNT(*)::int AS n FROM crm_sessions')).n, 0, 'login sessions are not backed up');
});

test('createCrmApp requires a db object', () => {
  assert.throws(() => createCrmApp({}), /needs a db object/);
});

// K8: two tenants on one deployment never see each other's data.
const { db, sign, inbound, drainAll, request, reset } = require('./helpers');
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const createApp = require('../src/app');
const tenancy = require('../src/tenancy/context');
const registry = require('../src/tenancy/registry');
const businessProfile = require('../src/services/businessProfile');
const { migrateAll } = require('../src/migrate');
const { migrations: BOT_MIGRATIONS } = require('../src/db/schema');
const { CRM_MIGRATIONS } = require('../crm/src/migrations');
const { TENANT_TABLES } = require('../src/db/platformMigrations');
const { seedUsers } = require('../crm/scripts/seed');
const { createOwner } = require('../crm/scripts/create-owner');
const { SEED_FILE, creds } = require('./crm/helpers');

const SAME_PHONE = '919811100001'; // one person who messages both businesses
const ACME = { slug: 'acme', name: 'Acme Realty', phoneNumberId: '1000200030004', crmHost: 'crm.acme.test' };
const ACME_SECRET = 'acme_app_secret';
const ACME_VERIFY = 'acme_verify_token';
const GKF_CRM = 'crm.gkf.test';

let app;
let acme;

async function addAcme() {
  acme = await registry.create({ ...ACME, secrets: { metaAppSecret: ACME_SECRET, metaVerifyToken: ACME_VERIFY } });
  await tenancy.run(acme.id, () => businessProfile.save(businessProfile.starterProfile({ name: ACME.name, type: 'realestate' }), 'test'));
}

const asTenant = (id, sql, params) => tenancy.run(id, () => db.many(sql, params));
const post = (path, payload, secret = process.env.META_APP_SECRET) => {
  const body = JSON.stringify(payload);
  const sig = `sha256=${crypto.createHmac('sha256', secret).update(Buffer.from(body)).digest('hex')}`;
  return request(app).post(path).set('Content-Type', 'application/json').set('X-Hub-Signature-256', sig).send(body);
};

before(async () => {
  await migrateAll();
  app = createApp({ crmHosts: [GKF_CRM], secureCookies: false, forceHttps: false });
});
beforeEach(async () => {
  await reset();
  await addAcme();
});
after(() => db.close());

test('every table with client data has tenant_id and forced row-level security', async () => {
  const rows = await tenancy.runAsSystem(() => db.many(`
    SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
      EXISTS (SELECT 1 FROM information_schema.columns k WHERE k.table_name = c.relname AND k.column_name = 'tenant_id') AS has_tenant
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relkind = 'r'
      AND c.relname NOT IN ('tenants', 'schema_migrations', 'crm_migrations', 'platform_migrations')`));
  assert.ok(rows.length >= TENANT_TABLES.length);
  for (const r of rows) {
    assert.ok(r.has_tenant, `${r.relname} has no tenant_id`);
    assert.ok(r.relrowsecurity && r.relforcerowsecurity, `${r.relname} has no forced row-level security`);
  }
  assert.strictEqual(await db.checkRlsActive(), true, 'tests must run as a role that row-level security applies to');
});

test('the bot and CRM migration lists are frozen (new migrations go to platformMigrations.js)', () => {
  assert.strictEqual(BOT_MIGRATIONS.length, 3);
  assert.strictEqual(CRM_MIGRATIONS.length, 6);
});

test('a query outside any tenant fails instead of guessing one', async () => {
  tenancy.setTestFallback(null);
  try {
    await assert.rejects(db.one('SELECT 1 FROM leads LIMIT 1'), tenancy.TenancyError);
  } finally {
    tenancy.setTestFallback(1);
  }
});

test('the same person messaging two businesses becomes two separate leads, each answered as its own business', async () => {
  assert.strictEqual((await post('/webhook', inbound({ from: SAME_PHONE, text: 'hi' }, { phoneNumberId: 'PNID_TEST' }))).status, 200);
  assert.strictEqual((await post('/webhook', inbound({ from: SAME_PHONE, text: 'hi' }, { phoneNumberId: ACME.phoneNumberId }))).status, 200);
  await drainAll();

  const gkfLeads = await asTenant(1, 'SELECT wa_id, tenant_id FROM leads');
  const acmeLeads = await asTenant(acme.id, 'SELECT wa_id, tenant_id FROM leads');
  assert.deepStrictEqual(gkfLeads, [{ wa_id: SAME_PHONE, tenant_id: 1 }]);
  assert.deepStrictEqual(acmeLeads, [{ wa_id: SAME_PHONE, tenant_id: acme.id }]);

  // Each business greeted the lead in its own name; nothing of the other leaked in.
  const gkfOut = (await asTenant(1, "SELECT text FROM messages WHERE direction = 'out'")).map(r => r.text).join(' ');
  const acmeOut = (await asTenant(acme.id, "SELECT text FROM messages WHERE direction = 'out'")).map(r => r.text).join(' ');
  assert.match(gkfOut, /Goldkraft/);
  assert.match(acmeOut, /Acme Realty/);
  assert.doesNotMatch(acmeOut, /Goldkraft/);

  // System work sees both.
  const all = await tenancy.runAsSystem(() => db.many('SELECT tenant_id FROM leads ORDER BY tenant_id'));
  assert.deepStrictEqual(all.map(r => r.tenant_id), [1, acme.id]);
});

test('a number no tenant owns is ignored', async () => {
  assert.strictEqual((await post('/webhook', inbound({ from: SAME_PHONE, text: 'hi' }, { phoneNumberId: '999999' }))).status, 200);
  const events = await tenancy.runAsSystem(() => db.many('SELECT id FROM webhook_events'));
  assert.strictEqual(events.length, 0);
});

test("a tenant's own webhook URL checks its own secret, verify token and number", async () => {
  const challenge = 'abc123';
  const ok = await request(app).get(`/webhook/acme?hub.mode=subscribe&hub.verify_token=${ACME_VERIFY}&hub.challenge=${challenge}`);
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.text, challenge);
  const wrongToken = await request(app).get(`/webhook/acme?hub.mode=subscribe&hub.verify_token=${process.env.META_WEBHOOK_VERIFY_TOKEN}&hub.challenge=x`);
  assert.strictEqual(wrongToken.status, 403);
  assert.strictEqual((await request(app).get('/webhook/nobody?hub.mode=subscribe&hub.verify_token=x&hub.challenge=x')).status, 404);

  // Signed with tenant 1's secret: rejected. With Acme's: accepted.
  const payload = inbound({ from: SAME_PHONE, text: 'hello' }, { phoneNumberId: ACME.phoneNumberId });
  assert.strictEqual((await post('/webhook/acme', payload)).status, 403);
  assert.strictEqual((await post('/webhook/acme', payload, ACME_SECRET)).status, 200);
  // Acme's app cannot inject messages for tenant 1's number.
  assert.strictEqual((await post('/webhook/acme', inbound({ from: SAME_PHONE, text: 'x' }, { phoneNumberId: 'PNID_TEST' }), ACME_SECRET)).status, 200);
  const events = await tenancy.runAsSystem(() => db.many('SELECT tenant_id FROM webhook_events'));
  assert.deepStrictEqual(events.map(e => e.tenant_id), [acme.id]);
});

test('tenant secrets are stored encrypted', async () => {
  const row = await tenancy.runAsSystem(() => db.one('SELECT secrets FROM tenants WHERE id = $1', [acme.id]));
  assert.match(row.secrets, /^v1:/);
  assert.ok(!row.secrets.includes(ACME_SECRET));
  assert.strictEqual(registry.config(acme.id).whatsapp.appSecret, ACME_SECRET);
});

test('a tenant never inherits tenant 1 settings from the env vars', async () => {
  const t = registry.config(acme.id);
  assert.strictEqual(t.whatsapp.accessToken, ''); // tenant 1 has META_ACCESS_TOKEN via env in some setups
  assert.strictEqual(t.whatsapp.verifyToken, ACME_VERIFY);
  assert.strictEqual(t.telegram.chatId, '');
  assert.strictEqual(t.razorpay.keyId, '');
});

test('two tenants cannot share a WhatsApp number, CRM host or slug', async () => {
  await assert.rejects(registry.create({ slug: 'other', name: 'Other', phoneNumberId: ACME.phoneNumberId }), /phone number id/);
  await assert.rejects(registry.create({ slug: 'other2', name: 'Other', phoneNumberId: '12345', crmHost: 'crm.localhost' }), /CRM host/);
  await assert.rejects(registry.create({ slug: 'acme', name: 'Again' }), /slug/);
  await assert.rejects(registry.create({ slug: 'Bad Slug', name: 'x' }), /slug/);
  await assert.rejects(registry.create({ slug: 'other3', name: 'x', secrets: { notAKey: 'v' } }), /Unknown secret/);
});

test('the database itself refuses links across tenants (composite foreign keys)', async () => {
  await tenancy.run(1, () => db.query(`INSERT INTO leads (wa_id) VALUES ('919811100009')`));
  const acmeUser = await tenancy.run(acme.id, () => db.one(`INSERT INTO crm_users (email, name, role, password_hash)
    VALUES ('x@acme.test', 'X', 'owner', 'h') RETURNING id`));
  // Tenant 1 tries to assign its lead to Acme's user.
  await assert.rejects(tenancy.run(1, () => db.query(
    'INSERT INTO crm_lead_assignments (wa_id, user_id) VALUES ($1, $2)', ['919811100009', acmeUser.id])));
  // And cannot write a row for another tenant (row-level security WITH CHECK).
  await assert.rejects(tenancy.run(1, () => db.query(
    `INSERT INTO leads (tenant_id, wa_id) VALUES ($1, '919811100010')`, [acme.id])));
});

test('CRM: staff log in only on their own business host and see only its leads', async () => {
  await tenancy.run(1, async () => {
    await db.query(`INSERT INTO leads (wa_id, display_name) VALUES ('919811100011', 'GKF only')`);
    await seedUsers(db, SEED_FILE);
    await db.query('UPDATE crm_users SET must_change_password = false');
  });
  await tenancy.run(acme.id, () => db.query(`INSERT INTO leads (wa_id, display_name) VALUES ('919811100012', 'Acme only')`));
  // Same email at Acme, different password.
  const owner = creds('owner');
  const acmePassword = await tenancy.run(acme.id, () => createOwner(db, { name: 'Acme Owner', email: owner.email }));
  await tenancy.run(acme.id, () => db.query('UPDATE crm_users SET must_change_password = false'));

  const loginOn = async (host, password) => {
    const agent = request.agent(app);
    const res = await agent.post('/login').set('Host', host).type('form').send({ email: owner.email, password });
    return { agent, res };
  };

  // GKF's password does not work on Acme's CRM, and the other way round.
  assert.strictEqual((await loginOn(ACME.crmHost, owner.password)).res.status, 401);
  assert.strictEqual((await loginOn(GKF_CRM, acmePassword)).res.status, 401);

  const { agent, res } = await loginOn(ACME.crmHost, acmePassword);
  assert.strictEqual(res.status, 302);
  const list = await agent.get('/leads').set('Host', ACME.crmHost);
  assert.match(list.text, /Acme only/);
  assert.doesNotMatch(list.text, /GKF only/);
  assert.strictEqual((await agent.get('/leads/919811100011').set('Host', ACME.crmHost)).status, 404);

  // Acme's session cookie means nothing on GKF's CRM.
  const cross = await agent.get('/leads').set('Host', GKF_CRM);
  assert.strictEqual(cross.status, 302);
  assert.match(cross.headers.location, /\/login/);
});

test('a suspended tenant gets no replies and no CRM', async () => {
  await registry.update(acme.id, { status: 'suspended' });
  assert.strictEqual((await post('/webhook', inbound({ from: SAME_PHONE, text: 'hi' }, { phoneNumberId: ACME.phoneNumberId }))).status, 200);
  const events = await tenancy.runAsSystem(() => db.many('SELECT id FROM webhook_events'));
  assert.strictEqual(events.length, 0);
  assert.strictEqual((await request(app).get('/login').set('Host', ACME.crmHost)).status, 403);
});

test('queue jobs run as their own tenant', async () => {
  const outboundRepository = require('../src/db/outboundRepository');
  const outboundWorker = require('../src/workers/outboundWorker');
  const whatsappService = require('../src/services/whatsappService');
  await tenancy.run(acme.id, async () => {
    await db.query(`INSERT INTO leads (wa_id) VALUES ('919811100013')`);
    await outboundRepository.enqueue({ dedupKey: 'k-acme', waId: '919811100013', text: 'from acme' });
  });
  const seen = [];
  whatsappService.transport = async () => { seen.push(tenancy.tenantIdOrNull()); return { messages: [{ id: 'wamid.acme' }] }; };
  try { await outboundWorker.drain(); } finally { whatsappService.transport = null; }
  assert.deepStrictEqual(seen, [acme.id]);
  const msg = await asTenant(acme.id, "SELECT text FROM messages WHERE direction = 'out'");
  assert.deepStrictEqual(msg.map(m => m.text), ['from acme']);
  assert.strictEqual((await asTenant(1, "SELECT COUNT(*)::int AS n FROM messages WHERE wa_id = '919811100013'"))[0].n, 0);
});

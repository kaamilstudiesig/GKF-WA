// K9 Embedded Signup: a client connects its own WhatsApp number from a signed link.
// Every Meta call goes to a fake (metaGraph.transport); nothing reaches Meta.
process.env.META_APP_ID = '111222333444';
process.env.META_ES_CONFIG_ID = '555666777888';
process.env.BOT_BASE_URL = 'https://wa.example.test';

const { db, request, reset } = require('./helpers');
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const createApp = require('../src/app');
const env = require('../src/config/env');
const registry = require('../src/tenancy/registry');
const { migrateAll } = require('../src/migrate');
const { metaGraph, MetaGraphError } = require('../src/services/metaGraph');
const notifyService = require('../src/services/notifyService');
const es = require('../src/services/embeddedSignup');

const WABA = '1098765432101';
const PN = '2012345678901';
const BIZ_TOKEN = 'BIZ_TOKEN_SECRET_VALUE';

let app;
let acme;
let calls;
let alerts;

/** A fake Meta. `fail` maps a step name to an error to throw once. */
function fakeMeta({ numbers = [{ id: PN, display_phone_number: '+971 50 000 0001', verified_name: 'Acme Realty' }], fail = {}, expiresIn = null } = {}) {
  calls = [];
  metaGraph.transport = async req => {
    calls.push(req);
    const p = req.path;
    const failWith = name => {
      if (!fail[name]) return;
      const err = fail[name];
      delete fail[name];
      throw err;
    };
    if (p === 'oauth/access_token') { failWith('exchange'); return { access_token: BIZ_TOKEN, token_type: 'bearer', ...(expiresIn ? { expires_in: expiresIn } : {}) }; }
    if (p === `${WABA}/phone_numbers`) { failWith('verify'); assert.strictEqual(req.token, BIZ_TOKEN); return { data: numbers }; }
    if (p === `${WABA}/subscribed_apps`) { failWith('subscribed'); return { success: true }; }
    if (p === `${PN}/register`) { failWith('registered'); return { success: true }; }
    if (p === `${PN}/smb_app_data`) { failWith(req.body.sync_type); return { request_id: `req-${req.body.sync_type}` }; }
    throw new Error(`unexpected Graph call ${req.method} ${p}`);
  };
}

const token = (id = acme.id, opts) => es.createLinkToken(id, opts);
const finish = (body, t = token()) => request(app).post(`/connect/${t}/session`).send(body);
const CLOUD = { code: 'CODE123', event: 'FINISH', phone_number_id: PN, waba_id: WABA };

before(async () => {
  await migrateAll();
  app = createApp({ crmHosts: ['crm.gkf.test'], secureCookies: false, forceHttps: false });
});
beforeEach(async () => {
  await reset();
  acme = await registry.create({ slug: 'acme', name: 'Acme Realty' });
  env.metaAppId = '111222333444';
  env.metaEsConfigId = '555666777888';
  alerts = [];
  notifyService.sendOverride = async (text, opts) => { alerts.push({ text, opts }); return true; };
  fakeMeta();
});
after(async () => {
  metaGraph.transport = null;
  notifyService.sendOverride = null;
  await db.close();
});

test('connect links are signed, expire, and cannot be edited', () => {
  assert.deepStrictEqual(es.readLinkToken(es.createLinkToken(7)), { tenantId: 7, appNumbers: false });
  assert.deepStrictEqual(es.readLinkToken(es.createLinkToken(7, { appNumbers: true })), { tenantId: 7, appNumbers: true });
  const t = es.createLinkToken(7);
  const [payload, sig] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ t: 1, e: 9999999999 })).toString('base64url');
  assert.strictEqual(es.readLinkToken(`${forged}.${sig}`), null);
  // Allowing app numbers on a new-numbers link breaks the signature.
  const widened = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url')), a: 1 })).toString('base64url');
  assert.strictEqual(es.readLinkToken(`${widened}.${sig}`), null);
  const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1); // always differs from the real signature
  assert.strictEqual(es.readLinkToken(`${payload}.${flipped}`), null);
  assert.strictEqual(es.readLinkToken(es.createLinkToken(7, { hours: 1, now: Date.now() - 2 * 3600 * 1000 })), null);
  assert.strictEqual(es.readLinkToken('junk'), null);
  assert.match(es.linkUrl(7), /^https:\/\/wa\.example\.test\/connect\/[\w-]+\.[\w-]+$/);
});

test('the connect page shows the Facebook button with a strict security header', async () => {
  const res = await request(app).get(`/connect/${token()}`);
  assert.strictEqual(res.status, 200);
  assert.match(res.text, /Connect your WhatsApp number/);
  assert.match(res.text, /Acme Realty/);
  assert.match(res.text, /"configId":"555666777888"/);
  // New numbers only unless the link allows WhatsApp Business app numbers.
  assert.match(res.text, /not on WhatsApp yet/);
  assert.doesNotMatch(res.text, /name="kind" value="app"/);
  const both = await request(app).get(`/connect/${token(acme.id, { appNumbers: true })}`);
  assert.match(both.text, /name="kind" value="app"/);
  assert.match(both.text, /whatsapp_business_app_onboarding/);
  const csp = res.headers['content-security-policy'];
  assert.match(csp, /script-src 'nonce-[^']+' https:\/\/connect\.facebook\.net/);
  assert.match(csp, /frame-src https:\/\/\*\.facebook\.com/);
  assert.strictEqual(res.headers['cache-control'], 'no-store');
  assert.ok(!res.text.includes(process.env.META_APP_SECRET), 'app secret must never reach the page');
});

test('bad links, connected tenants, tenant 1 and missing config get a clear page', async () => {
  assert.strictEqual((await request(app).get('/connect/not-a-token')).status, 404);
  // Tenant 1 has a live number (META_PHONE_NUMBER_ID): a stray link must never replace it.
  const gkf = await request(app).get(`/connect/${token(1)}`);
  assert.strictEqual(gkf.status, 409);
  assert.match(gkf.text, /already connected/);
  const s = await finish(CLOUD, token(1));
  assert.strictEqual(s.status, 409);
  assert.strictEqual(calls.length, 0);

  env.metaEsConfigId = '';
  const off = await request(app).get(`/connect/${token()}`);
  assert.strictEqual(off.status, 409);
  assert.match(off.text, /not switched on yet/);

  env.metaEsConfigId = '555666777888';
  await registry.update(acme.id, { status: 'suspended' });
  assert.match((await request(app).get(`/connect/${token()}`)).text, /paused/);
});

test('a new number: code exchanged, ownership checked, token saved encrypted, webhooks subscribed, number registered', async () => {
  const res = await finish(CLOUD);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, { ok: true, complete: true, mode: 'cloud', number: '+971 50 000 0001', name: 'Acme Realty' });
  assert.ok(!JSON.stringify(res.body).includes(BIZ_TOKEN));

  assert.deepStrictEqual(calls.map(c => `${c.method} ${c.path}`), [
    'POST oauth/access_token', `GET ${WABA}/phone_numbers`, `POST ${WABA}/subscribed_apps`, `POST ${PN}/register`
  ]);
  // The app secret goes in a form body, never in the URL.
  assert.deepStrictEqual(calls[0].form, { client_id: '111222333444', client_secret: process.env.META_APP_SECRET, code: 'CODE123' });
  assert.deepStrictEqual(calls[0].params, {});

  const t = registry.config(acme.id);
  assert.strictEqual(t.whatsapp.phoneNumberId, PN);
  assert.strictEqual(t.whatsapp.wabaId, WABA);
  assert.strictEqual(t.whatsapp.accessToken, BIZ_TOKEN);
  assert.match(t.whatsapp.twoStepPin, /^[0-9]{6}$/);
  assert.deepStrictEqual(calls[3].body, { messaging_product: 'whatsapp', pin: t.whatsapp.twoStepPin });
  assert.ok(t.whatsapp.setup.steps.subscribed && t.whatsapp.setup.steps.registered);
  assert.strictEqual(t.whatsapp.setup.lastError, null);
  assert.strictEqual(t.whatsapp.setup.tokenExpiresAt, null);

  // Stored encrypted, never as plain text.
  const row = await require('../src/tenancy/context').runAsSystem(() => db.one('SELECT secrets FROM tenants WHERE id = $1', [acme.id]));
  assert.ok(!row.secrets.includes(BIZ_TOKEN));

  // Inbound messages for the number now find this client.
  assert.strictEqual((await registry.byPhoneNumberId(PN)).slug, 'acme');
  assert.strictEqual(alerts.length, 1);
  assert.ok(alerts[0].opts.ops);
  assert.match(alerts[0].text, /Acme Realty \(acme\).*setup complete/);

  // The link can't be used again for a second number.
  assert.strictEqual((await request(app).get(`/connect/${token()}`)).status, 409);
  assert.strictEqual((await finish(CLOUD)).status, 409);
});

test('a token with an expiry is kept and reported, so the client can reconnect in time', async () => {
  fakeMeta({ expiresIn: 60 * 24 * 3600 });
  const res = await finish(CLOUD);
  assert.strictEqual(res.status, 200);
  const exp = registry.config(acme.id).whatsapp.setup.tokenExpiresAt;
  assert.ok(Math.abs(new Date(exp) - Date.now() - 60 * 24 * 3600 * 1000) < 60 * 1000);
  assert.match(alerts[0].text, /Token expires \d{4}-\d{2}-\d{2}: they must reconnect/);
});

test('a WhatsApp Business app number needs a link that allows it', async () => {
  const res = await finish({ ...CLOUD, event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' });
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /not on WhatsApp yet/);
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(registry.config(acme.id).whatsapp.phoneNumberId, '');
});

test('a WhatsApp Business app number: no register; contacts and history sync started once', async () => {
  const res = await finish({ ...CLOUD, event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' }, token(acme.id, { appNumbers: true }));
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.mode, 'coexistence');
  assert.ok(!calls.some(c => c.path.endsWith('/register')));
  assert.deepStrictEqual(calls.filter(c => c.path === `${PN}/smb_app_data`).map(c => c.body.sync_type), ['smb_app_state_sync', 'history']);
  const setup = registry.config(acme.id).whatsapp.setup;
  assert.strictEqual(setup.steps.history.requestId, 'req-history');
  assert.strictEqual(registry.config(acme.id).whatsapp.twoStepPin, '');

  // A retry never starts a sync twice (Meta allows each type once).
  calls = [];
  await es.finishSetup(acme.id);
  assert.strictEqual(calls.length, 0);
});

test('a failed setup step is saved and retried later with the same PIN, without a new code', async () => {
  fakeMeta({ fail: { registered: new MetaGraphError('Phone number not verified', { code: 133010 }) } });
  const res = await finish(CLOUD);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.complete, false);
  let t = registry.config(acme.id);
  assert.strictEqual(t.whatsapp.setup.lastError.step, 'registered');
  assert.ok(!t.whatsapp.setup.steps.registered);
  const pin = t.whatsapp.twoStepPin;
  assert.match(alerts[0].text, /setup step failed: registered.*whatsapp-finish acme/);

  calls = [];
  const out = await es.finishSetup(acme.id);
  assert.deepStrictEqual(out.errors, []);
  assert.deepStrictEqual(calls.map(c => c.path), [`${PN}/register`]); // subscribe was already done
  assert.strictEqual(calls[0].body.pin, pin);
  t = registry.config(acme.id);
  assert.ok(t.whatsapp.setup.steps.registered);
  assert.strictEqual(t.whatsapp.setup.lastError, null);
});

test('signup errors leave the client unchanged and say what to do', async () => {
  const unchanged = () => {
    const t = registry.config(acme.id);
    assert.strictEqual(t.whatsapp.phoneNumberId, '');
    assert.strictEqual(t.whatsapp.accessToken, '');
  };

  fakeMeta({ fail: { exchange: new MetaGraphError('Invalid verification code', { code: 100 }) } });
  let r = await finish(CLOUD);
  assert.strictEqual(r.status, 502);
  assert.match(r.body.error, /30 seconds/);
  unchanged();

  // The browser named a number that isn't in the WABA the token can see.
  fakeMeta({ numbers: [{ id: '2099999999999' }] });
  r = await finish(CLOUD);
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /not in the WhatsApp account/);
  unchanged();

  fakeMeta();
  r = await finish({ ...CLOUD, event: 'FINISH_ONLY_WABA' });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /No phone number was chosen/);
  r = await finish({ ...CLOUD, phone_number_id: 'abc' });
  assert.strictEqual(r.status, 400);
  r = await finish({ ...CLOUD, code: '' });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(calls.length, 0);
  unchanged();

  // Another client already has this number.
  await registry.create({ slug: 'other', name: 'Other', phoneNumberId: PN });
  r = await finish(CLOUD);
  assert.strictEqual(r.status, 409);
  assert.match(r.body.error, /another business/);
  assert.strictEqual(calls.length, 0);
  unchanged();
});

test("tenant 1's number from the env var counts as taken", async () => {
  const saved = env.metaPhoneNumberId;
  env.metaPhoneNumberId = PN;
  try {
    const r = await finish(CLOUD);
    assert.strictEqual(r.status, 409);
    assert.strictEqual(calls.length, 0);
  } finally { env.metaPhoneNumberId = saved; }
});

test('cancel and error steps are logged for Meta session logging; bad links are refused', async () => {
  const ok = await request(app).post(`/connect/${token()}/event`).send({ event: 'CANCEL', data: { current_step: 'PHONE_NUMBER_SETUP' } });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual((await request(app).post('/connect/nope/event').send({})).status, 404);
  assert.strictEqual((await request(app).post('/connect/nope/session').send(CLOUD)).status, 404);
  assert.strictEqual(calls.length, 0);
});

test('two signups at once for one client: only the first connects, the second is refused', async () => {
  const [a, b] = await Promise.all([finish(CLOUD), finish({ ...CLOUD, code: 'CODE456' })]);
  assert.deepStrictEqual([a.status, b.status].sort(), [200, 409]);
  assert.strictEqual(calls.filter(c => c.path === 'oauth/access_token').length, 1);
  assert.strictEqual(registry.config(acme.id).whatsapp.phoneNumberId, PN);
});

test('a number with an existing two-step PIN gets a clear fix in the error and the ops alert', async () => {
  fakeMeta({ fail: { registered: new MetaGraphError('Two step verification PIN Mismatch', { code: 133005 }) } });
  const res = await finish(CLOUD);
  assert.strictEqual(res.body.complete, false);
  const err = registry.config(acme.id).whatsapp.setup.lastError;
  assert.strictEqual(err.code, 133005);
  assert.match(err.message, /turn off two-step verification/);
  assert.match(alerts[0].text, /turn off two-step verification.*whatsapp-finish acme/);
});

test('connect links never reach logs or Sentry', () => {
  const { redactConnectLinks, redactConnectLinksDeep } = require('../src/utils/redact');
  const t = token();
  assert.strictEqual(redactConnectLinks(`/connect/${t}/session`), '/connect/[REDACTED]/session');
  const ev = redactConnectLinksDeep({ request: { url: `https://wa.example.test/connect/${t}` }, transaction: `GET /connect/${t}` });
  assert.ok(!JSON.stringify(ev).includes(t));
  assert.strictEqual(redactConnectLinks('/webhook'), '/webhook');
});

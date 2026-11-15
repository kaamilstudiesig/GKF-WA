const crypto = require('crypto');
const { db, request, reset } = require('./helpers');
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const createApp = require('../src/app');
const registry = require('../src/tenancy/registry');
const tenancy = require('../src/tenancy/context');
const { migrateAll } = require('../src/migrate');
const { normalizePhone } = require('../src/services/identity');
const leadRepository = require('../src/db/leadRepository');

// R16 lead intake (contract in docs/TEAM.md). Fakes only: nothing here reaches Meta.
const SECRET = 'intake-test-secret';
const ORIGIN = 'https://www.acme-homes.example';
const FORM_KEY = 'FORMKEY123';
let app; let acme;

const sign = (raw, secret = SECRET) => `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
const api = (body, { secret = SECRET, slug = 'acme', a = app } = {}) => {
  const raw = JSON.stringify(body);
  return request(a).post(`/intake/${slug}`).set('Content-Type', 'application/json').set('X-Intake-Signature', sign(raw, secret)).send(raw);
};
const form = (fields, { origin = ORIGIN, a = app, ip = null } = {}) => {
  let r = request(a).post('/intake/acme').type('form');
  if (origin) r = r.set('Origin', origin);
  if (ip) r = r.set('X-Forwarded-For', ip);
  return r.send({ form_key: FORM_KEY, ...fields });
};
const asAcme = fn => tenancy.run(acme.id, fn);
const one = (sql, params) => asAcme(() => db.one(sql, params));
const many = (sql, params) => asAcme(() => db.many(sql, params));
const DUBAI = '971501234567';

before(async () => {
  await migrateAll();
  app = createApp({ crmHosts: ['crm.gkf.test'], secureCookies: false, forceHttps: false });
});
beforeEach(async () => {
  await reset();
  acme = await registry.create({ slug: 'acme', name: 'Acme Homes', phoneNumberId: '1000200030055', crmHost: 'crm.acme.test' });
  await registry.update(acme.id, {
    settings: { intakeFormKey: FORM_KEY, intakeOrigins: [ORIGIN], phoneCountry: '971', leadWelcomeTemplate: 'lead_welcome' },
    secrets: { intakeSecret: SECRET }
  });
});
after(async () => { await db.close(); });

test('phone numbers: international kept, local numbers get the client\'s country code', () => {
  assert.strictEqual(normalizePhone('+91 98450-12345'), '919845012345');
  assert.strictEqual(normalizePhone('050 123 4567', '971'), DUBAI);
  assert.strictEqual(normalizePhone('971501234567', '971'), DUBAI);
  assert.strictEqual(normalizePhone('098450 12345', '91'), '919845012345');
  assert.strictEqual(normalizePhone('+971 50 123 4567', '91'), DUBAI); // a + number keeps its own code
  assert.strictEqual(normalizePhone('12345', '91'), null);
});

test('signed portal lead: new lead, window closed, note, hand-off, welcome template queued once', async () => {
  const res = await api({ name: 'Layla Q', phone: '050 123 4567', email: 'Layla@Example.com', message: '2BR in Dubai Hills?', source: 'bayut', sourceRef: 'BY-1', utm: { campaign: 'nov' }, consent: true });
  assert.strictEqual(res.status, 202);
  assert.deepStrictEqual(res.body, { ok: true });

  const lead = await one('SELECT * FROM leads WHERE wa_id = $1', [DUBAI]);
  assert.strictEqual(lead.phone, DUBAI);
  assert.strictEqual(lead.source, 'intake_bayut');
  assert.strictEqual(lead.last_inbound_message_at, null); // never wrote on WhatsApp
  assert.strictEqual(leadRepository.format(lead).window_open, false);
  assert.strictEqual(lead.metadata.intake.email, 'layla@example.com');
  assert.strictEqual(lead.metadata.intake.utm.campaign, 'nov');
  assert.ok(!('message' in lead.metadata.intake));
  assert.strictEqual(lead.needs_human, true);

  const note = await one('SELECT user_id, body FROM crm_lead_notes WHERE wa_id = $1', [DUBAI]);
  assert.deepStrictEqual([note.user_id, note.body], [null, 'From the Bayut form: 2BR in Dubai Hills?']);
  const handoff = await one('SELECT reason, status, summary FROM handoffs WHERE wa_id = $1', [DUBAI]);
  assert.strictEqual(handoff.reason, 'form_lead');
  assert.match(handoff.summary, /New lead from the Bayut form: Layla Q, layla@example\.com\. WhatsApp welcome queued\./);

  const out = await many("SELECT wa_id, metadata FROM outbound_messages WHERE metadata ->> 'source' = 'intake'");
  assert.strictEqual(out.length, 1);
  assert.deepStrictEqual(out[0].metadata.template, { name: 'lead_welcome', language: 'en', body: ['Layla Q', 'Acme Homes'] });
  assert.strictEqual(out[0].wa_id, DUBAI);

  // A second submission (another listing) the same day: no second welcome.
  assert.strictEqual((await api({ name: 'Layla Q', phone: DUBAI, source: 'bayut', sourceRef: 'BY-2', consent: true })).status, 202);
  assert.strictEqual((await many("SELECT id FROM outbound_messages WHERE metadata ->> 'source' = 'intake'")).length, 1);

  // When they write on WhatsApp, the window opens (the bot's upsert fills the NULL).
  const updated = await asAcme(() => leadRepository.upsertInbound(DUBAI, 'Layla', new Date().toISOString(), { phone: DUBAI }));
  assert.strictEqual(updated.window_open, true);
});

test('bad signature, no secret, or a regenerated secret: 401 and nothing saved', async () => {
  const body = { name: 'X', phone: DUBAI, source: 'bayut' };
  assert.strictEqual((await api(body, { secret: 'wrong' })).status, 401);
  const raw = JSON.stringify(body);
  assert.strictEqual((await request(app).post('/intake/acme').set('Content-Type', 'application/json').set('X-Intake-Signature', 'sha256=zz').send(raw)).status, 401);
  await registry.update(acme.id, { secrets: { intakeSecret: 'brand-new-secret' } }); // regenerated on Business settings
  assert.strictEqual((await api(body)).status, 401); // the old secret stops working
  assert.strictEqual((await api(body, { secret: 'brand-new-secret' })).status, 202);
  assert.strictEqual((await many('SELECT wa_id FROM leads')).length, 1);
  assert.strictEqual((await request(app).post('/intake/nobody').send({})).status, 404);
});

test('website form: key and origin checked, CORS only for the allowed origin, honeypot is a silent 202', async () => {
  const bad = await form({ name: 'A', phone: '0501234567', consent: 'true' }, { origin: 'https://evil.example' });
  assert.strictEqual(bad.status, 401);
  assert.strictEqual(bad.headers['access-control-allow-origin'], undefined);
  assert.strictEqual((await form({ name: 'A', phone: '0501234567', form_key: 'nope' })).status, 401);
  assert.strictEqual((await form({ name: 'A', phone: '0501234567' }, { origin: null })).status, 401);

  const bot = await form({ name: 'Bot', phone: '0501234568', company_url: 'http://spam.example' });
  assert.strictEqual(bot.status, 202);
  assert.strictEqual((await many("SELECT wa_id FROM leads WHERE wa_id = '971501234568'")).length, 0); // never saved

  const ok = await form({ name: 'Ahmed', phone: '050 123 4567', message: 'Call me', consent: 'true', utm_source: 'google' });
  assert.strictEqual(ok.status, 202);
  assert.strictEqual(ok.headers['access-control-allow-origin'], ORIGIN);
  const lead = await one('SELECT source, metadata FROM leads WHERE wa_id = $1', [DUBAI]);
  assert.strictEqual(lead.source, 'intake_website');
  assert.strictEqual(lead.metadata.intake.utm.source, 'google');
});

test('no phone is refused; no consent and no template mean no WhatsApp, and the hand-off says why', async () => {
  const none = await api({ name: 'Email only', email: 'a@b.com', source: 'website' });
  assert.deepStrictEqual([none.status, none.body.error], [400, 'phone required']);
  assert.strictEqual((await one("SELECT status, error FROM intake_submissions ORDER BY id DESC LIMIT 1")).status, 'rejected');
  assert.strictEqual((await api({ phone: '12', source: 'website' })).status, 400);
  assert.strictEqual((await api({ phone: DUBAI, source: 'craigslist' })).status, 400);

  await api({ name: 'No consent', phone: DUBAI, source: 'website' });
  assert.match((await one('SELECT summary FROM handoffs WHERE wa_id = $1', [DUBAI])).summary, /No WhatsApp consent on the form/);

  await registry.update(acme.id, { settings: { leadWelcomeTemplate: '' } });
  await api({ name: 'No template', phone: '971501234569', source: 'website', consent: true });
  assert.match((await one("SELECT summary FROM handoffs WHERE wa_id = '971501234569'")).summary, /WhatsApp welcome not sent: template not set up/);
  assert.strictEqual((await many("SELECT id FROM outbound_messages WHERE metadata ->> 'source' = 'intake'")).length, 0);
});

test('the same portal reference within 24 hours does nothing the second time', async () => {
  const body = { name: 'Rami', phone: DUBAI, message: 'hi', source: 'property_finder', sourceRef: 'PF-77', consent: true };
  assert.strictEqual((await api(body)).status, 202);
  const again = await api(body);
  assert.deepStrictEqual([again.status, again.body.duplicate], [202, true]);
  assert.strictEqual((await many('SELECT id FROM crm_lead_notes WHERE wa_id = $1', [DUBAI])).length, 1);
  assert.strictEqual((await many('SELECT id FROM handoffs WHERE wa_id = $1', [DUBAI])).length, 1);
  assert.deepStrictEqual((await many('SELECT status FROM intake_submissions ORDER BY id')).map(r => r.status), ['accepted', 'duplicate']);
});

test('existing leads: matched by phone, no second hand-off, no welcome in a live chat, won/lost not reopened', async () => {
  // A lead who is chatting on WhatsApp right now, with an open hand-off.
  await asAcme(async () => {
    await leadRepository.upsertInbound(DUBAI, 'Sara', new Date().toISOString(), { phone: DUBAI });
    await db.query("INSERT INTO handoffs (wa_id, reason) VALUES ($1, 'ready_to_book')", [DUBAI]);
  });
  assert.strictEqual((await api({ name: 'Sara', phone: '0501234567', source: 'bayut', consent: true })).status, 202);
  assert.strictEqual((await many('SELECT id FROM handoffs WHERE wa_id = $1', [DUBAI])).length, 1);
  assert.strictEqual((await many("SELECT id FROM outbound_messages WHERE metadata ->> 'source' = 'intake'")).length, 0); // live chat
  assert.strictEqual((await one('SELECT source FROM leads WHERE wa_id = $1', [DUBAI])).source, 'whatsapp_inbound'); // keeps its first source

  // A lost lead comes back through a form: still lost, and the hand-off says so.
  await asAcme(() => db.query("INSERT INTO leads (wa_id, phone, status, last_inbound_message_at) VALUES ('971509999999', '971509999999', 'lost', now() - interval '10 days')"));
  await api({ name: 'Back', phone: '971509999999', source: 'dubizzle', consent: true });
  const back = await one("SELECT l.status, h.summary FROM leads l JOIN handoffs h ON h.wa_id = l.wa_id WHERE l.wa_id = '971509999999'");
  assert.strictEqual(back.status, 'lost');
  assert.match(back.summary, /Came back through the Dubizzle form \(was lost\)/);
});

test('website form limits hold across two app instances (counted in the database)', async () => {
  const other = createApp({ crmHosts: ['crm.gkf.test'], secureCookies: false, forceHttps: false });
  // Per phone: 3 a day.
  for (let i = 0; i < 3; i++) assert.strictEqual((await form({ name: 'P', phone: '0501111111' }, { a: i % 2 ? other : app })).status, 202);
  const fourth = await form({ name: 'P', phone: '0501111111' }, { a: other });
  assert.strictEqual(fourth.status, 429);
  // Per IP: 10 an hour (the 3 above count too).
  const statuses = [];
  for (let i = 0; i < 8; i++) statuses.push((await form({ name: 'Q', phone: `05022222${10 + i}` }, { a: i % 2 ? other : app })).status);
  assert.deepStrictEqual(statuses, [202, 202, 202, 202, 202, 202, 429, 429]);
  assert.ok((await many("SELECT status FROM intake_submissions WHERE status = 'limited'")).length >= 3);
  // Signed calls are not limited.
  assert.strictEqual((await api({ name: 'API', phone: '0503333333', source: 'bayut' })).status, 202);
});

test('one client\'s intake never touches another client', async () => {
  await api({ name: 'Acme lead', phone: DUBAI, source: 'bayut', consent: true });
  const inDefault = await tenancy.run(1, () => db.many('SELECT wa_id FROM leads WHERE wa_id = $1', [DUBAI]));
  assert.strictEqual(inDefault.length, 0);
  const subs = await tenancy.run(1, () => db.many('SELECT id FROM intake_submissions'));
  assert.strictEqual(subs.length, 0);
  // Tenant 1 has no form key or secret: its endpoint refuses everything.
  const gkf = registry.config(1);
  assert.strictEqual((await api({ phone: DUBAI, source: 'bayut' }, { slug: gkf.slug })).status, 401);
});

test('a lead who wrote STOP (K30) gets no welcome from a form, and stays opted out', async () => {
  await asAcme(() => db.query(`INSERT INTO leads (wa_id, phone, status, last_inbound_message_at, opted_out_at)
    VALUES ($1, $1, 'contacted', now() - interval '3 days', now() - interval '2 days')`, [DUBAI]));
  assert.strictEqual((await api({ name: 'Stopper', phone: DUBAI, source: 'website', consent: true })).status, 202);
  assert.strictEqual((await many("SELECT id FROM outbound_messages WHERE metadata ->> 'source' = 'intake'")).length, 0);
  assert.match((await one('SELECT summary FROM handoffs WHERE wa_id = $1', [DUBAI])).summary, /Opted out of WhatsApp \(wrote STOP\)/);
  assert.ok((await one('SELECT opted_out_at FROM leads WHERE wa_id = $1', [DUBAI])).opted_out_at);
});

test('review fixes: a second submission keeps the first touch and a short history', async () => {
  await api({ name: 'Nadia', phone: DUBAI, source: 'bayut', sourceRef: 'BY-9', utm: { campaign: 'first' }, consent: true });
  await form({ name: 'Nadia', phone: '0501234567', utm_campaign: 'second' });
  const m = (await one('SELECT metadata FROM leads WHERE wa_id = $1', [DUBAI])).metadata;
  assert.strictEqual(m.intake.source, 'website'); // latest
  assert.deepStrictEqual([m.intake_first.source, m.intake_first.sourceRef, m.intake_first.utm.campaign, m.intake_first.consent], ['bayut', 'BY-9', 'first', true]);
  assert.deepStrictEqual(m.intake_history.map(x => x.source), ['bayut', 'website']);
});

test('review fixes: two portal retries arriving together make one lead note and one duplicate', async () => {
  const body = { name: 'Twin', phone: DUBAI, message: 'retry me', source: 'property_finder', sourceRef: 'PF-SAME' };
  const [a, b] = await Promise.all([api(body), api(body)]);
  assert.deepStrictEqual([a.status, b.status], [202, 202]);
  assert.strictEqual([a.body.duplicate, b.body.duplicate].filter(Boolean).length, 1);
  assert.strictEqual((await many('SELECT id FROM crm_lead_notes WHERE wa_id = $1', [DUBAI])).length, 1);
  assert.deepStrictEqual((await many('SELECT status FROM intake_submissions ORDER BY id')).map(r => r.status).sort(), ['accepted', 'duplicate']);
  // Two different submissions for the same new phone at once: one lead, no error.
  const [c, d] = await Promise.all([api({ name: 'N1', phone: '971501112222', source: 'bayut' }), api({ name: 'N2', phone: '971501112222', source: 'dubizzle' })]);
  assert.deepStrictEqual([c.status, d.status], [202, 202]);
  assert.strictEqual((await many("SELECT wa_id FROM leads WHERE wa_id = '971501112222'")).length, 1);
});

test('review fixes: refused requests are recorded and stopped after 30 an hour; honeypot counts too', async () => {
  for (let i = 0; i < 29; i++) assert.strictEqual((await form({ name: 'G', phone: '0501234567', form_key: `guess${i}` })).status, 401);
  assert.strictEqual((await form({ name: 'Bot', phone: '0501234567', company_url: 'x' })).status, 202); // the 30th refusal, silent
  const refused = await many("SELECT error, ip_hash FROM intake_submissions WHERE status = 'rejected'");
  assert.strictEqual(refused.length, 30);
  assert.ok(refused.every(r => /^[0-9a-f]{32}$/.test(r.ip_hash)));
  assert.ok(refused.some(r => r.error === 'honeypot') && refused.some(r => r.error === 'bad form key'));
  const blocked = await form({ name: 'Real', phone: '0501234567' }); // right key, but this address is blocked for the hour
  assert.strictEqual(blocked.status, 429);
  assert.strictEqual((await many('SELECT wa_id FROM leads')).length, 0);
});

test('review fixes: the welcome uses the template\'s language and is "queued", not "sent"', async () => {
  await registry.update(acme.id, { settings: { leadWelcomeLanguage: 'ar' } });
  await api({ name: 'Omar', phone: DUBAI, source: 'bayut', consent: true });
  const out = await one("SELECT metadata FROM outbound_messages WHERE metadata ->> 'source' = 'intake'");
  assert.strictEqual(out.metadata.template.language, 'ar');
  assert.match((await one('SELECT summary FROM handoffs WHERE wa_id = $1', [DUBAI])).summary, /WhatsApp welcome queued\./);
  await registry.update(acme.id, { settings: { leadWelcomeLanguage: 'not a code!' } });
  assert.strictEqual(registry.config(acme.id).intake.welcomeLanguage, 'en'); // bad values fall back
});

test('review fixes: no fixed IP-hash key in production', () => {
  const { ipKey } = require('../src/routes/intake');
  assert.strictEqual(ipKey({ NODE_ENV: 'production' }), null); // the route then answers 503 and logs an error
  assert.strictEqual(ipKey({ NODE_ENV: 'production', TENANT_SECRETS_KEY: 'k' }), 'k');
  assert.strictEqual(ipKey({ NODE_ENV: 'production', INTAKE_IP_KEY: 'i', TENANT_SECRETS_KEY: 'k' }), 'i');
  assert.strictEqual(ipKey({ NODE_ENV: 'test' }), 'local-dev-intake');
});

test('review fixes (2): a portal\'s own 400s never lock it out; a valid signature passes a blocked IP; a retry adds no second note', async () => {
  // 31 signed calls with no phone (the portal's mistake), then a valid lead: accepted.
  for (let i = 0; i < 31; i++) assert.strictEqual((await api({ name: 'No phone', source: 'bayut' })).status, 400);
  assert.strictEqual((await api({ name: 'Good', phone: DUBAI, source: 'bayut' })).status, 202);

  // 30 bad form keys from this address block more guessing, but a correctly signed call still gets in.
  for (let i = 0; i < 30; i++) await form({ name: 'G', phone: '0501234567', form_key: `guess${i}` });
  assert.strictEqual((await form({ name: 'G', phone: '0501234567' })).status, 429);
  assert.strictEqual((await api({ name: 'G', phone: '971507777777', source: 'bayut' }, { secret: 'wrong' })).status, 429);
  assert.strictEqual((await api({ name: 'Signed', phone: '971508888888', source: 'bayut' })).status, 202);

  // A retry after a save that failed half-way (the claim was marked rejected) adds no second note.
  const body = { name: 'Retry', phone: '971509990000', message: 'same text', source: 'property_finder', sourceRef: 'PF-R' };
  assert.strictEqual((await api(body)).status, 202);
  await asAcme(() => db.query("UPDATE intake_submissions SET status = 'rejected', error = 'could not be saved' WHERE source_ref = 'PF-R'"));
  assert.strictEqual((await api(body)).status, 202); // not a duplicate any more, so it runs again
  assert.strictEqual((await many("SELECT id FROM crm_lead_notes WHERE wa_id = '971509990000'")).length, 1);
});

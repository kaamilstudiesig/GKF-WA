// The shared CRM: one address, every client's staff sign in; each session runs as its own client.
const { db, getApp, reset } = require('./helpers');
const { test, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const tenancy = require('../src/tenancy/context');
const registry = require('../src/tenancy/registry');
const { hashPassword } = require('../crm/src/auth');
const { makeTicket, PICK_COOKIE } = require('../src/routes/sharedCrm');

const HOST = 'app.dartit.test';
const PW_A = 'PasswordA123';
const PW_B = 'PasswordB456';
let acme;

const addUser = (tenantId, email, password, role = 'owner') => tenancy.run(tenantId, () => db.one(
  `INSERT INTO crm_users (email, name, role, password_hash, must_change_password, active) VALUES ($1, $2, $3, $4, false, true) RETURNING id`,
  [email, `${role} ${tenantId}`, role, hashPassword(password)]));
const addLead = (tenantId, waId, name) => tenancy.run(tenantId, () => db.query(
  "INSERT INTO leads (wa_id, phone, display_name, status) VALUES ($1, $1, $2, 'new')", [waId, name]));

/** A cookie-keeping client on the shared host. */
const agent = () => {
  const a = request.agent(getApp());
  const on = r => r.set('Host', HOST);
  return { get: p => on(a.get(p)), post: p => on(a.post(p)).type('form') };
};

beforeEach(async () => {
  await reset();
  await tenancy.runAsSystem(() => db.query("DELETE FROM crm_users WHERE email LIKE '%@example.com'")); // sessions cascade
  process.env.SHARED_CRM_HOSTS = HOST;
  acme = await registry.create({ slug: 'acme', name: 'Acme Homes' });
  await addLead(1, '919800001111', 'Gym Lead Riya');
  await addLead(acme.id, '919800002222', 'Acme Lead Arjun');
});
afterEach(() => { delete process.env.SHARED_CRM_HOSTS; });
after(() => db.close());

test('off unless SHARED_CRM_HOSTS is set; client CRM hosts are unchanged', async () => {
  delete process.env.SHARED_CRM_HOSTS;
  const off = await request(getApp()).get('/login').set('Host', HOST);
  assert.notStrictEqual(off.status, 200);
  assert.doesNotMatch(off.text, /Sign in/);
  const own = await request(getApp()).get('/login').set('Host', 'crm.localhost');
  assert.strictEqual(own.status, 200);
  assert.match(own.text, /data-theme="brand"/);
});

test('the sign-in page and app identity are Dartit', async () => {
  const a = agent();
  const page = await a.get('/login');
  assert.strictEqual(page.status, 200);
  assert.match(page.text, /data-theme="dartit"/);
  assert.match(page.text, /dartit-logo-light-transparent\.svg/);
  const manifest = JSON.parse((await a.get('/manifest.webmanifest')).text);
  assert.strictEqual(manifest.name, 'Dartit');
  assert.strictEqual((await a.get('/static/brand/dartit/dartit-mark-light.svg')).status, 200);
  assert.strictEqual((await a.get('/leads')).headers.location, '/login'); // signed out: nothing else
});

test('same email in two clients, different passwords: each password opens only its own client', async () => {
  await addUser(1, 'sam@example.com', PW_A);
  await addUser(acme.id, 'sam@example.com', PW_B);
  const a = agent();
  const res = await a.post('/login').send({ login: 'sam@example.com', password: PW_B });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.location, '/');
  const leads = await a.get('/leads');
  assert.strictEqual(leads.status, 200);
  assert.match(leads.text, /Acme Lead Arjun/);
  assert.doesNotMatch(leads.text, /Gym Lead Riya/);
  assert.match(leads.text, /Acme Homes/); // business name next to the Dartit logo
  assert.match(leads.text, /data-theme="dartit"/);
});

test('same email and password in two clients: choose a business; a tampered or expired choice is refused', async () => {
  const u1 = await addUser(1, 'pat@example.com', PW_A);
  const u2 = await addUser(acme.id, 'pat@example.com', PW_A);
  const a = agent();
  const choose = await a.post('/login').send({ login: 'pat@example.com', password: PW_A });
  assert.strictEqual(choose.status, 200);
  assert.match(choose.text, /Choose your business/);
  assert.match(choose.text, /Acme Homes/);
  const tickets = [...choose.text.matchAll(/name="ticket" value="([^"]+)"/g)].map(m => m[1]);
  assert.strictEqual(tickets.length, 2);
  const pickCookie = choose.headers['set-cookie'].find(c => c.startsWith(`${PICK_COOKIE}=`));
  assert.match(pickCookie, /HttpOnly/i);
  assert.match(pickCookie, /Path=\/login(?:;|$)/);
  const pick = pickCookie.split(';')[0].slice(`${PICK_COOKIE}=`.length);
  const acmeTicket = tickets.find(ticket => JSON.parse(Buffer.from(ticket.split('.')[0], 'base64url')).t === acme.id);
  assert.ok(acmeTicket);

  // Tampered: swap the client id inside the ticket body but keep the signature.
  const [body, sig] = acmeTicket.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), t: 1, u: u1.id })).toString('base64url');
  assert.strictEqual((await a.post('/login/choose').send({ ticket: `${forged}.${sig}` })).status, 401);
  // Expired.
  const old = makeTicket(acme.id, u2.id, pick, Date.now() - 10 * 60 * 1000);
  assert.strictEqual((await a.post('/login/choose').send({ ticket: old })).status, 401);

  const ok = await a.post('/login/choose').send({ ticket: acmeTicket });
  assert.strictEqual(ok.status, 302);
  assert.match((await a.get('/leads')).text, /Acme Lead Arjun/);
});

test('a business choice is bound to the browser that received the list', async () => {
  await addUser(1, 'browser@example.com', PW_A);
  await addUser(acme.id, 'browser@example.com', PW_A);
  const a = agent();
  const list = await a.post('/login').send({ login: 'browser@example.com', password: PW_A });
  assert.strictEqual(list.status, 200);
  const ticket = /name="ticket" value="([^"]+)"/.exec(list.text)[1];
  const refused = await agent().post('/login/choose').send({ ticket });
  assert.strictEqual(refused.status, 401);
  assert.match(refused.text, /That choice expired/);
  assert.strictEqual((await a.post('/login/choose').send({ ticket })).status, 302);
});

test('a business choice cannot be reused even with its original browser cookie', async () => {
  await addUser(1, 'replay@example.com', PW_A);
  await addUser(acme.id, 'replay@example.com', PW_A);
  const a = agent();
  const list = await a.post('/login').send({ login: 'replay@example.com', password: PW_A });
  assert.strictEqual(list.status, 200);
  const ticket = /name="ticket" value="([^"]+)"/.exec(list.text)[1];
  const cookie = list.headers['set-cookie'].find(c => c.startsWith(`${PICK_COOKIE}=`)).split(';')[0];
  assert.strictEqual((await a.post('/login/choose').send({ ticket })).status, 302);
  // Restore the cookie cleared by success so this checks one-use enforcement.
  const replay = await a.post('/login/choose').set('Cookie', cookie).send({ ticket });
  assert.strictEqual(replay.status, 401);
  assert.match(replay.text, /That choice expired/);
});

test('sign-in posts require an Origin matching the shared host', async () => {
  await addUser(1, 'origin@example.com', PW_A);
  await addUser(acme.id, 'origin@example.com', PW_A);
  const a = agent();
  const credentials = { login: 'origin@example.com', password: PW_A };
  assert.strictEqual((await a.post('/login').set('Origin', 'https://evil.example').send(credentials)).status, 403);
  const list = await a.post('/login').set('Origin', `http://${HOST}`).send(credentials);
  assert.strictEqual(list.status, 200);
  assert.match(list.text, /Choose your business/);
  const ticket = /name="ticket" value="([^"]+)"/.exec(list.text)[1];
  assert.strictEqual((await a.post('/login/choose').set('Origin', 'https://evil.example').send({ ticket })).status, 403);
  assert.strictEqual((await a.post('/login/choose').set('Origin', `http://${HOST}`).send({ ticket })).status, 302);
});

test('eight wrong passwords block even the right password for that login', async () => {
  await addUser(acme.id, 'throttle@example.com', PW_A);
  const a = agent();
  for (let i = 0; i < 8; i++) {
    const bad = await a.post('/login').send({ login: 'throttle@example.com', password: PW_B });
    assert.strictEqual(bad.status, 401);
    if (i === 3) {
      // A successful sign-in must not clear the failures already counted.
      assert.strictEqual((await a.post('/login').send({ login: 'throttle@example.com', password: PW_A })).status, 302);
    }
  }
  const blocked = await a.post('/login').send({ login: 'throttle@example.com', password: PW_A });
  assert.strictEqual(blocked.status, 429);
  assert.match(blocked.text, /Too many failed attempts/);
});

test('a business where the password is wrong is never listed; wrong everywhere gives the generic error', async () => {
  await addUser(1, 'kim@example.com', PW_A);
  await addUser(acme.id, 'kim@example.com', PW_B);
  const a = agent();
  const one = await a.post('/login').send({ login: 'kim@example.com', password: PW_A });
  assert.strictEqual(one.status, 302); // straight in: only the matching client, no list
  const bad = await agent().post('/login').send({ login: 'kim@example.com', password: 'Nope12345678' });
  assert.strictEqual(bad.status, 401);
  assert.match(bad.text, /Phone number, email or password is incorrect/);
  assert.doesNotMatch(bad.text, /Acme/);
});

test('suspended clients: no sign-in, and an open session stops working', async () => {
  await addUser(acme.id, 'lee@example.com', PW_B);
  const a = agent();
  assert.strictEqual((await a.post('/login').send({ login: 'lee@example.com', password: PW_B })).status, 302);
  assert.strictEqual((await a.get('/leads')).status, 200);
  await registry.update(acme.id, { status: 'suspended' });
  assert.strictEqual((await a.get('/leads')).status, 403);
  assert.strictEqual((await agent().post('/login').send({ login: 'lee@example.com', password: PW_B })).status, 401);
});

test('a client cannot take the shared host, and alerts link to it when a client has no CRM host', async () => {
  await assert.rejects(registry.create({ slug: 'grab', name: 'Grab', crmHost: HOST }), /shared CRM host/);
  assert.strictEqual(registry.config(acme.id).crm.baseUrl, `https://${HOST}`);
});

test('on the shared host the business keeps its name, and the Brand form edits its own colour, not Dartit\'s', async () => {
  await addUser(acme.id, 'ann@example.com', PW_B);
  const a = agent();
  await a.post('/login').send({ login: 'ann@example.com', password: PW_B });
  const reports = await a.get('/reports');
  assert.match(reports.text, /All of Acme Homes/);
  const settings = await a.get('/settings');
  assert.strictEqual(settings.status, 200);
  assert.match(settings.text, /data-color-pick/);
  assert.match(settings.text, /type="color" value="#d4af37"/); // the client's default colour
  assert.doesNotMatch(settings.text, /type="color" value="#1B4532"/i);
});

test('sign out on the shared host ends the session and returns to the Dartit sign-in', async () => {
  await addUser(acme.id, 'max@example.com', PW_B);
  const a = agent();
  await a.post('/login').send({ login: 'max@example.com', password: PW_B });
  const page = await a.get('/account/password');
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page.text)[1];
  const out = await a.post('/logout').send({ _csrf: csrf });
  assert.strictEqual(out.headers.location, '/login');
  assert.strictEqual((await a.get('/leads')).headers.location, '/login');
});

const { setup, login, creds } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { parseLogin } = require('../../crm/src/users');
const { createOwner } = require('../../crm/scripts/create-owner');

const SALES_PHONE = '919800000003';
const signIn = (app, login, password) => request(app).post('/login').type('form').send({ login, password });

async function setSalesPhone(ctx, phone = '+91 98000-00003') {
  const owner = await login(ctx.app, 'owner');
  const salesId = await ctx.userId('sales');
  const res = await owner.agent.post(`/users/${salesId}/login-phone`).type('form').send({ _csrf: owner.csrf, login_phone: phone });
  return { owner, salesId, res };
}

test('parseLogin tells emails, phones and junk apart', () => {
  assert.deepStrictEqual(parseLogin('  '), { kind: 'empty' });
  assert.strictEqual(parseLogin('a@b.co').kind, 'email');
  assert.deepStrictEqual(parseLogin('+91 98000-00003'), { kind: 'phone', digits: SALES_PHONE, local: false });
  assert.deepStrictEqual(parseLogin('0091 98000 00003'), { kind: 'phone', digits: SALES_PHONE, local: false });
  assert.deepStrictEqual(parseLogin('98000 00003'), { kind: 'phone', digits: '9800000003', local: true });
  assert.strictEqual(parseLogin('hello').kind, 'invalid');
  assert.strictEqual(parseLogin('12345').kind, 'invalid');
});

test('the owner sets a sign-in phone and the user signs in with it, with or without +91', async () => {
  const ctx = await setup();
  try {
    const { owner, salesId, res } = await setSalesPhone(ctx);
    assert.strictEqual(res.status, 302);
    assert.strictEqual((await ctx.db.one('SELECT login_phone FROM crm_users WHERE id = $1', [salesId])).login_phone, SALES_PHONE);
    assert.match((await owner.agent.get('/users')).text, /\+919800000003/);

    const { password } = creds('sales');
    for (const typed of ['+91 98000 00003', '919800000003', '98000 00003', '098000 00003']) {
      const r = await signIn(ctx.app, typed, password);
      assert.strictEqual(r.status, 302, `sign-in with "${typed}"`);
      assert.strictEqual(r.headers.location, '/');
    }
    // Email still works.
    assert.strictEqual((await signIn(ctx.app, creds('sales').email, password)).status, 302);
    // Old form field name still works.
    assert.strictEqual((await request(ctx.app).post('/login').type('form').send({ email: '+919800000003', password })).status, 302);
  } finally { await ctx.cleanup(); }
});

test('sign-in errors are clear and never say whether an account exists', async () => {
  const ctx = await setup();
  try {
    await setSalesPhone(ctx);
    const wrongPw = await signIn(ctx.app, '+919800000003', 'wrong-pass-123');
    assert.strictEqual(wrongPw.status, 401);
    assert.match(wrongPw.text, /Phone number, email or password is incorrect/);
    const unknown = await signIn(ctx.app, '+919811111111', creds('sales').password);
    assert.strictEqual(unknown.status, 401);
    assert.match(unknown.text, /Phone number, email or password is incorrect/);
    // What they typed comes back in the box.
    assert.match(unknown.text, /value="\+919811111111"/);

    const junk = await signIn(ctx.app, 'not a number', 'x');
    assert.strictEqual(junk.status, 400);
    assert.match(junk.text, /Enter your phone number/);
    assert.strictEqual((await signIn(ctx.app, '', 'x')).status, 400);

    // A disabled user can't sign in with their phone.
    await ctx.db.query("UPDATE crm_users SET active = false WHERE login_phone = '919800000003'");
    assert.strictEqual((await signIn(ctx.app, '+919800000003', creds('sales').password)).status, 401);
  } finally { await ctx.cleanup(); }
});

test('repeated wrong passwords on one phone are throttled however the number is typed', async () => {
  const ctx = await setup();
  try {
    await setSalesPhone(ctx);
    for (let i = 0; i < 8; i++) await signIn(ctx.app, i % 2 ? '+91 98000 00003' : '+91-98000-00003', 'wrong-pass-123');
    assert.strictEqual((await signIn(ctx.app, '+919800000003', creds('sales').password)).status, 429);
  } finally { await ctx.cleanup(); }
});

test('bad and duplicate sign-in phones are rejected with a message; empty clears it', async () => {
  const ctx = await setup();
  try {
    const { owner, salesId } = await setSalesPhone(ctx);
    const managerId = await ctx.userId('manager');
    const post = (id, phone) => owner.agent.post(`/users/${id}/login-phone`).type('form').send({ _csrf: owner.csrf, login_phone: phone });

    const bad = await post(managerId, '12345');
    assert.strictEqual(bad.status, 400);
    assert.match(bad.text, /country code/);

    const dup = await post(managerId, '+91 98000 00003');
    assert.strictEqual(dup.status, 409);
    assert.match(dup.text, /Another user already signs in with that phone number/);

    // Saving the same number on the same user is fine.
    assert.strictEqual((await post(salesId, '+919800000003')).status, 302);

    assert.strictEqual((await post(salesId, '')).status, 302);
    assert.strictEqual((await ctx.db.one('SELECT login_phone FROM crm_users WHERE id = $1', [salesId])).login_phone, null);

    // Only owners manage sign-in phones.
    const sales = await login(ctx.app, 'sales');
    const denied = await sales.agent.post(`/users/${salesId}/login-phone`).type('form').send({ _csrf: sales.csrf, login_phone: '+919800000009' });
    assert.strictEqual(denied.status, 403);
  } finally { await ctx.cleanup(); }
});

test('a phone typed without a country code that matches two people asks for the code', async () => {
  const ctx = await setup();
  try {
    const { owner } = await setSalesPhone(ctx, '+91 98000 00003');
    const managerId = await ctx.userId('manager');
    await owner.agent.post(`/users/${managerId}/login-phone`).type('form').send({ _csrf: owner.csrf, login_phone: '+971 98000 00003' });
    const r = await signIn(ctx.app, '98000 00003', creds('sales').password);
    assert.strictEqual(r.status, 400);
    assert.match(r.text, /Add your country code/);
    assert.strictEqual((await signIn(ctx.app, '+91 98000 00003', creds('sales').password)).status, 302);
  } finally { await ctx.cleanup(); }
});

test('new staff and new owners can get a sign-in phone when created', async () => {
  const ctx = await setup();
  try {
    const owner = await login(ctx.app, 'owner');
    const created = await owner.agent.post('/users').type('form').send({
      _csrf: owner.csrf, name: 'New Sales', email: 'new.sales@example.test', role: 'sales', password: 'TempPass12345', login_phone: '+91 98000 00007'
    });
    assert.strictEqual(created.status, 302);
    assert.strictEqual((await ctx.db.one("SELECT login_phone FROM crm_users WHERE email = 'new.sales@example.test'")).login_phone, '919800000007');

    const dup = await owner.agent.post('/users').type('form').send({
      _csrf: owner.csrf, name: 'Dup', email: 'dup@example.test', role: 'sales', password: 'TempPass12345', login_phone: '+919800000007'
    });
    assert.strictEqual(dup.status, 409);
    assert.match(dup.text, /Another user already signs in with that phone number/);
    assert.strictEqual(await ctx.db.one("SELECT id FROM crm_users WHERE email = 'dup@example.test'"), null);

    const pw = await createOwner(ctx.db, { name: 'Phone Owner', email: 'phone.owner@example.test', phone: '+91 98000 00008' });
    assert.ok(pw);
    const r = await signIn(ctx.app, '9800000008', pw);
    assert.strictEqual(r.status, 302);
    assert.match(r.headers.location, /\/account\/password/);
  } finally { await ctx.cleanup(); }
});

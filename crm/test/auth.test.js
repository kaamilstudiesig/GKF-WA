const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { hashPassword, verifyPassword, validateNewPassword } = require('../src/auth');
const { setup, login, creds } = require('./helpers');

test('passwords are hashed with scrypt and verify correctly', async () => {
  const h = hashPassword('Secret12345');
  assert.match(h, /^scrypt\$/);
  assert.ok(!h.includes('Secret12345'));
  assert.ok(verifyPassword('Secret12345', h));
  assert.ok(!verifyPassword('wrong-password1', h));
  assert.ok(validateNewPassword('short1'));
  assert.ok(validateNewPassword('onlyletterslong'));
  assert.strictEqual(validateNewPassword('GoodPassword123'), null);
});

test('seeded users are stored hashed, one per role', async () => {
  const ctx = await setup();
  try {
    const rows = await ctx.db.many('SELECT role, password_hash FROM crm_users ORDER BY id');
    assert.deepStrictEqual(rows.map(r => r.role).sort(), ['manager', 'owner', 'sales']);
    for (const r of rows) assert.match(r.password_hash, /^scrypt\$/);
  } finally { await ctx.cleanup(); }
});

test('unauthenticated users are sent to login; bad passwords rejected', async () => {
  const ctx = await setup();
  try {
    const r1 = await request(ctx.app).get('/leads');
    assert.strictEqual(r1.status, 302);
    assert.strictEqual(r1.headers.location, '/login');
    const r2 = await request(ctx.app).post('/login').type('form').send({ email: creds('owner').email, password: 'nope-nope-1' });
    assert.strictEqual(r2.status, 401);
  } finally { await ctx.cleanup(); }
});

test('first login forces a password change, which then works', async () => {
  const ctx = await setup({ clearMustChange: false });
  try {
    const { agent, csrf } = await login(ctx.app, 'sales');
    const r1 = await agent.get('/');
    assert.strictEqual(r1.status, 302);
    assert.match(r1.headers.location, /\/account\/password/);

    const bad = await agent.post('/account/password').type('form')
      .send({ _csrf: csrf, current_password: creds('sales').password, new_password: 'abc', confirm_password: 'abc' });
    assert.strictEqual(bad.status, 400);

    const ok = await agent.post('/account/password').type('form')
      .send({ _csrf: csrf, current_password: creds('sales').password, new_password: 'BrandNewPass99', confirm_password: 'BrandNewPass99' });
    assert.strictEqual(ok.status, 302);
    assert.strictEqual((await agent.get('/')).status, 200);

    const relog = await request(ctx.app).post('/login').type('form').send({ email: creds('sales').email, password: 'BrandNewPass99' });
    assert.strictEqual(relog.status, 302);
  } finally { await ctx.cleanup(); }
});

test('POSTs without a CSRF token are rejected', async () => {
  const ctx = await setup();
  try {
    const { agent } = await login(ctx.app, 'owner');
    const r = await agent.post('/leads/919845012345/status').type('form').send({ status: 'lost' });
    assert.strictEqual(r.status, 403);
  } finally { await ctx.cleanup(); }
});

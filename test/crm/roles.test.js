const { setup, login } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');

const HOT_LEAD = '919845012345';   // Rahul, needs human
const OTHER_LEAD = '919900112233'; // Priya

test('sales only sees leads assigned to them', async () => {
  const ctx = await setup();
  try {
    const owner = await login(ctx.app, 'owner');
    const sales = await login(ctx.app, 'sales');

    assert.strictEqual((await sales.agent.get(`/leads/${HOT_LEAD}`)).status, 404);
    const before = await sales.agent.get('/leads');
    assert.ok(!before.text.includes(HOT_LEAD));

    const r = await owner.agent.post(`/leads/${HOT_LEAD}/assign`).type('form').send({ _csrf: owner.csrf, user_id: await ctx.userId('sales') });
    assert.strictEqual(r.status, 302);

    assert.strictEqual((await sales.agent.get(`/leads/${HOT_LEAD}`)).status, 200);
    const after = await sales.agent.get('/leads');
    assert.ok(after.text.includes(HOT_LEAD));
    assert.ok(!after.text.includes(OTHER_LEAD));

    // Assignment is mirrored on the WA handoff record.
    const h = await ctx.db.one('SELECT status, assigned_to FROM handoffs WHERE wa_id = $1', [HOT_LEAD]);
    assert.strictEqual(h.status, 'assigned');
    assert.strictEqual(h.assigned_to, 'sales@goldkraftfitness.com');
  } finally { await ctx.cleanup(); }
});

test('sales cannot assign leads, manage users or view reports', async () => {
  const ctx = await setup();
  try {
    const sales = await login(ctx.app, 'sales');
    const assign = await sales.agent.post(`/leads/${HOT_LEAD}/assign`).type('form').send({ _csrf: sales.csrf, user_id: await ctx.userId('sales') });
    assert.strictEqual(assign.status, 403);
    assert.strictEqual((await sales.agent.get('/users')).status, 403);
    assert.strictEqual((await sales.agent.get('/reports')).status, 403);
    assert.strictEqual((await sales.agent.get('/reports/leads.csv')).status, 403);
  } finally { await ctx.cleanup(); }
});

test('manager sees reports and can assign to their team, but cannot manage users or see AI cost', async () => {
  const ctx = await setup();
  try {
    const mgr = await login(ctx.app, 'manager');
    const rep = await mgr.agent.get('/reports');
    assert.strictEqual(rep.status, 200);
    assert.ok(!rep.text.includes('AI usage'));
    assert.strictEqual((await mgr.agent.get('/users')).status, 403);
    const r = await mgr.agent.post(`/leads/${OTHER_LEAD}/assign`).type('form').send({ _csrf: mgr.csrf, user_id: await ctx.userId('sales') });
    assert.strictEqual(r.status, 302);
    // Manager cannot assign to the owner (not on their team).
    const r2 = await mgr.agent.post(`/leads/${OTHER_LEAD}/assign`).type('form').send({ _csrf: mgr.csrf, user_id: await ctx.userId('owner') });
    assert.strictEqual(r2.status, 403);
  } finally { await ctx.cleanup(); }
});

test('owner sees everything including AI cost, and can create staff', async () => {
  const ctx = await setup();
  try {
    const owner = await login(ctx.app, 'owner');
    const rep = await owner.agent.get('/reports');
    assert.ok(rep.text.includes('AI usage'));
    const csv = await owner.agent.get('/reports/leads.csv');
    assert.strictEqual(csv.status, 200);
    assert.match(csv.headers['content-type'], /text\/csv/);
    assert.strictEqual(csv.text.trim().split('\n').length, 13); // header + 12 demo leads

    const c = await owner.agent.post('/users').type('form').send({
      _csrf: owner.csrf, name: 'New Rep', email: 'rep2@goldkraftfitness.com', role: 'sales', manager_id: await ctx.userId('manager'), password: 'TempPass1234'
    });
    assert.strictEqual(c.status, 302);
    const u = await ctx.db.one("SELECT * FROM crm_users WHERE email = 'rep2@goldkraftfitness.com'");
    assert.strictEqual(u.must_change_password, true);
    assert.strictEqual(u.manager_id, await ctx.userId('manager'));
  } finally { await ctx.cleanup(); }
});

test('owner cannot demote the last owner', async () => {
  const ctx = await setup();
  try {
    const owner = await login(ctx.app, 'owner');
    const r = await owner.agent.post(`/users/${await ctx.userId('owner')}`).type('form').send({
      _csrf: owner.csrf, name: 'GKF Owner', email: 'owner@goldkraftfitness.com', role: 'manager', active: '1'
    });
    assert.strictEqual(r.status, 400);
    assert.strictEqual((await ctx.db.one('SELECT role FROM crm_users WHERE id = $1', [await ctx.userId('owner')])).role, 'owner');
  } finally { await ctx.cleanup(); }
});

test('reports show lead sources and Instagram/Facebook ads; lead page shows the ad', async () => {
  const ctx = await setup();
  try {
    const owner = await login(ctx.app, 'owner');
    const rep = await owner.agent.get('/reports');
    assert.ok(rep.text.includes('Free 3-day trial at GKF'));
    assert.ok(rep.text.includes('instagram ad'));
    const lead = await owner.agent.get(`/leads/${HOT_LEAD}`);
    assert.ok(lead.text.includes('Free 3-day trial at GKF'));
  } finally { await ctx.cleanup(); }
});

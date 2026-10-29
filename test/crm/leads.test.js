const { setup, login } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');

const LEAD = '918050443322'; // Arjun, status new, messaged 30 min ago
const STALE = '919611223344'; // Kavya, last message 72h ago

test('status changes are written to the WA leads table and logged', async () => {
  const ctx = await setup();
  try {
    const { agent, csrf } = await login(ctx.app, 'owner');
    const r = await agent.post(`/leads/${LEAD}/status`).type('form').send({ _csrf: csrf, status: 'qualified' });
    assert.strictEqual(r.status, 302);
    assert.strictEqual((await ctx.db.one('SELECT status FROM leads WHERE wa_id = $1', [LEAD])).status, 'qualified');
    const log = await ctx.db.one("SELECT details FROM crm_activity_log WHERE wa_id = $1 AND action = 'status_change'", [LEAD]);
    assert.deepStrictEqual(log.details, { from: 'new', to: 'qualified' });

    const bad = await agent.post(`/leads/${LEAD}/status`).type('form').send({ _csrf: csrf, status: 'banana' });
    assert.strictEqual(bad.status, 302);
    assert.match(bad.headers.location, /err=/);
  } finally { await ctx.cleanup(); }
});

test('staff replies are queued in WA outbound_messages for the bot to send', async () => {
  const ctx = await setup();
  try {
    const { agent, csrf } = await login(ctx.app, 'owner');
    await agent.post(`/leads/${LEAD}/message`).type('form').send({ _csrf: csrf, text: 'Hi Arjun, this is GKF!' }).expect(302);
    const row = await ctx.db.one('SELECT * FROM outbound_messages WHERE wa_id = $1', [LEAD]);
    assert.strictEqual(row.status, 'pending');
    assert.strictEqual(row.text, 'Hi Arjun, this is GKF!');
    assert.match(row.dedup_key, /^crm:[0-9a-f-]{36}$/);
    assert.strictEqual(row.metadata.source, 'crm');
    assert.strictEqual(row.metadata.user_id, await ctx.userId('owner'));
    assert.strictEqual(row.metadata.user_name, 'GKF Owner');
    // A new lead becomes "contacted" once staff reply.
    assert.strictEqual((await ctx.db.one('SELECT status FROM leads WHERE wa_id = $1', [LEAD])).status, 'contacted');
    const page = await agent.get(`/leads/${LEAD}`);
    assert.ok(page.text.includes('Queued, waiting for the WhatsApp bot'));
  } finally { await ctx.cleanup(); }
});

test('replies are blocked when the 24h WhatsApp window is closed', async () => {
  const ctx = await setup();
  try {
    const { agent, csrf } = await login(ctx.app, 'owner');
    const r = await agent.post(`/leads/${STALE}/message`).type('form').send({ _csrf: csrf, text: 'Hello?' });
    assert.match(r.headers.location, /err=/);
    assert.strictEqual((await ctx.db.one('SELECT COUNT(*)::int AS c FROM outbound_messages WHERE wa_id = $1', [STALE])).c, 0);
  } finally { await ctx.cleanup(); }
});

test('notes, follow-ups and handoff resolution work for an assigned sales rep', async () => {
  const ctx = await setup();
  try {
    const owner = await login(ctx.app, 'owner');
    const HOT = '919845012345';
    await owner.agent.post(`/leads/${HOT}/assign`).type('form').send({ _csrf: owner.csrf, user_id: await ctx.userId('sales') }).expect(302);

    const sales = await login(ctx.app, 'sales');
    await sales.agent.post(`/leads/${HOT}/notes`).type('form').send({ _csrf: sales.csrf, body: 'Prefers 7am slot' }).expect(302);
    await sales.agent.post(`/leads/${HOT}/followups`).type('form')
      .send({ _csrf: sales.csrf, title: 'Confirm trial', due_at: '2020-01-01T10:00' }).expect(302);

    const f = await ctx.db.one('SELECT * FROM crm_follow_ups WHERE wa_id = $1', [HOT]);
    assert.strictEqual(f.user_id, await ctx.userId('sales'));
    assert.strictEqual(f.due_at, '2020-01-01T04:30:00.000Z'); // 10:00 IST

    const dash = await sales.agent.get('/');
    assert.ok(dash.text.includes('Confirm trial'));
    await sales.agent.post(`/followups/${f.id}/done`).type('form').send({ _csrf: sales.csrf }).expect(302);
    assert.strictEqual((await ctx.db.one('SELECT status FROM crm_follow_ups WHERE id = $1', [f.id])).status, 'done');

    await sales.agent.post(`/leads/${HOT}/handoff/resolve`).type('form').send({ _csrf: sales.csrf }).expect(302);
    const lead = await ctx.db.one('SELECT needs_human, handoff_reason FROM leads WHERE wa_id = $1', [HOT]);
    assert.strictEqual(lead.needs_human, false);
    assert.strictEqual(lead.handoff_reason, null);
    assert.strictEqual((await ctx.db.one('SELECT status FROM handoffs WHERE wa_id = $1', [HOT])).status, 'resolved');

    const page = await sales.agent.get(`/leads/${HOT}`);
    assert.ok(page.text.includes('Prefers 7am slot'));
  } finally { await ctx.cleanup(); }
});

test('pages render for every role', async () => {
  const ctx = await setup();
  try {
    for (const role of ['owner', 'manager', 'sales']) {
      const { agent } = await login(ctx.app, role);
      for (const p of ['/', '/leads', '/pipeline', '/followups', '/account/password']) {
        const r = await agent.get(p);
        assert.strictEqual(r.status, 200, `${role} ${p}`);
      }
    }
  } finally { await ctx.cleanup(); }
});

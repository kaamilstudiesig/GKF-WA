const { setup, login } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const staffAlerts = require('../../src/services/staffAlerts');
const handoffRepository = require('../../src/db/handoffRepository');
const eventRepository = require('../../src/db/eventRepository');
const whatsappService = require('../../src/services/whatsappService');
const outboundWorker = require('../../src/workers/outboundWorker');
const webhookWorker = require('../../src/workers/webhookWorker');

const LEAD = '919845012345';
const PHONES = { owner: '919800000001', manager: '919800000002', sales: '919800000003' };

const alertJobs = db => db.many(`SELECT wa_id, metadata FROM outbound_messages WHERE metadata ? 'staff_alert' ORDER BY wa_id`);
const setMode = (db, role, mode) => db.query('UPDATE crm_users SET alert_phone = $1, alert_mode = $2 WHERE role = $3', [PHONES[role], mode, role]);

test('the owner sets a WhatsApp number and alert mode on the Staff page', async () => {
  const ctx = await setup();
  try {
    const owner = await login(ctx.app, 'owner');
    const salesId = await ctx.userId('sales');
    const ok = await owner.agent.post(`/users/${salesId}/alerts`).type('form')
      .send({ _csrf: owner.csrf, alert_phone: '+91 98000-00003', alert_mode: 'mine' });
    assert.strictEqual(ok.status, 302);
    assert.deepStrictEqual(await ctx.db.one('SELECT alert_phone, alert_mode FROM crm_users WHERE id = $1', [salesId]),
      { alert_phone: PHONES.sales, alert_mode: 'mine' });
    assert.match((await owner.agent.get('/users')).text, /\+919800000003/);

    const bad = await owner.agent.post(`/users/${salesId}/alerts`).type('form').send({ _csrf: owner.csrf, alert_phone: '12345', alert_mode: 'all' });
    assert.strictEqual(bad.status, 400);
    assert.match(bad.text, /country code/);
    const noPhone = await owner.agent.post(`/users/${salesId}/alerts`).type('form').send({ _csrf: owner.csrf, alert_phone: '', alert_mode: 'all' });
    assert.strictEqual(noPhone.status, 400);

    const sales = await login(ctx.app, 'sales');
    const denied = await sales.agent.post(`/users/${salesId}/alerts`).type('form').send({ _csrf: sales.csrf, alert_phone: PHONES.sales, alert_mode: 'all' });
    assert.strictEqual(denied.status, 403);
  } finally { await ctx.cleanup(); }
});

test('"all" gets every lead; "mine" gets assigned leads (managers: their team too)', async () => {
  const ctx = await setup();
  try {
    await setMode(ctx.db, 'owner', 'all');
    await setMode(ctx.db, 'manager', 'mine');
    await setMode(ctx.db, 'sales', 'mine');
    await ctx.db.query('DELETE FROM crm_lead_assignments WHERE wa_id = $1', [LEAD]);
    assert.deepStrictEqual((await staffAlerts.recipients(LEAD)).map(r => r.alert_phone), [PHONES.owner]);

    await ctx.db.query('INSERT INTO crm_lead_assignments (wa_id, user_id) VALUES ($1, $2)', [LEAD, await ctx.userId('sales')]);
    assert.deepStrictEqual((await staffAlerts.recipients(LEAD)).map(r => r.alert_phone).sort(), Object.values(PHONES).sort());

    await setMode(ctx.db, 'sales', 'off');
    assert.strictEqual((await staffAlerts.recipients(LEAD)).length, 2);
  } finally { await ctx.cleanup(); }
});

test('a new hand-off queues one template alert per person, sent as a Meta template', async () => {
  const ctx = await setup();
  try {
    await setMode(ctx.db, 'owner', 'all');
    await ctx.db.query(`UPDATE handoffs SET status = 'resolved' WHERE wa_id = $1`, [LEAD]);
    await handoffRepository.open({ waId: LEAD, reason: 'human_requested', summary: 'Wants a call\nafter 6 pm' });
    await new Promise(res => setTimeout(res, 50)); // alert is fire-and-forget

    const jobs = await alertJobs(ctx.db);
    assert.strictEqual(jobs.length, 1);
    assert.strictEqual(jobs[0].wa_id, PHONES.owner);
    const tpl = jobs[0].metadata.template;
    assert.strictEqual(tpl.name, 'staff_lead_alert');
    assert.strictEqual(tpl.body[0], 'Lead needs a person');
    assert.match(tpl.body[1], /\(\+919845012345\)$/);
    assert.strictEqual(tpl.body[2], 'Asked for a human: Wants a call after 6 pm'); // no new lines (Meta rule)
    assert.strictEqual(tpl.button, LEAD);

    // The same event again in the same window is not sent twice.
    assert.strictEqual(await staffAlerts.alert({ waId: LEAD, event: 'handoff', details: 'again' }), 0);

    const sent = [];
    whatsappService.transport = async p => { sent.push(p); return { messages: [{ id: 'wamid.alert1' }] }; };
    try { await outboundWorker.drain(); } finally { whatsappService.transport = null; }
    const payload = sent.find(p => p.type === 'template');
    assert.strictEqual(payload.to, PHONES.owner);
    assert.strictEqual(payload.template.name, 'staff_lead_alert');
    assert.deepStrictEqual(payload.template.components[1], { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: LEAD }] });
    assert.strictEqual((await ctx.db.one(`SELECT count(*)::int AS n FROM messages WHERE wa_id = $1`, [PHONES.owner])).n, 0);
  } finally { await ctx.cleanup(); }
});

test('the AI does not answer a staff number', async () => {
  const ctx = await setup();
  try {
    await setMode(ctx.db, 'sales', 'mine');
    await eventRepository.record({
      eventKey: 'msg:staff1', waId: PHONES.sales, messageId: 'wamid.staff1',
      payload: { msg: { id: 'wamid.staff1', type: 'text', text: { body: 'ok, calling them' } }, contact: null }
    });
    await webhookWorker.drain();
    assert.strictEqual(await ctx.db.one('SELECT 1 FROM leads WHERE wa_id = $1', [PHONES.sales]), null);
    assert.strictEqual((await ctx.db.one('SELECT count(*)::int AS n FROM outbound_messages WHERE wa_id = $1', [PHONES.sales])).n, 0);
    assert.strictEqual((await ctx.db.one(`SELECT status FROM webhook_events WHERE event_key = 'msg:staff1'`)).status, 'completed');
  } finally { await ctx.cleanup(); }
});

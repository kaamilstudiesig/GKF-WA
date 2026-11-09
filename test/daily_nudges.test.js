const { setup } = require('./crm/helpers');
const test = require('node:test');
const assert = require('node:assert');
const notifyService = require('../src/services/notifyService');
const tenancy = require('../src/tenancy/context');
const dailyNudges = require('../src/services/dailyNudges');
const { LeadQueue } = require('../crm/src/queue');

const sleep = ms => new Promise(r => setTimeout(r, ms));
test.beforeEach(() => dailyNudges.resetForTests());
const alertsTo = (db, phone) => db.many("SELECT dedup_key, text FROM outbound_messages WHERE wa_id = $1 AND dedup_key LIKE 'staff_alert:daily_nudge:%' ORDER BY id", [phone]);

test('R11b: the morning reminder goes out once a day at the start of the working day, to the right people', async () => {
  const ctx = await setup();
  const sent = [];
  notifyService.sendOverride = async text => { sent.push(text); return true; };
  try {
    const db = ctx.db;
    const ids = { owner: await ctx.userId('owner'), manager: await ctx.userId('manager'), sales: await ctx.userId('sales') };
    await db.query("UPDATE crm_users SET alert_phone = '919000000011', alert_mode = 'mine' WHERE id = $1", [ids.sales]);
    await db.query("UPDATE crm_users SET alert_phone = '919000000012', alert_mode = 'mine' WHERE id = $1", [ids.manager]);
    await db.query("UPDATE crm_users SET alert_phone = '919000000013', alert_mode = 'off' WHERE id = $1", [ids.owner]);
    await new LeadQueue(db).saveSettings({ autoAssign: false, workStart: '09:00', workEnd: '21:00', timezone: 'Asia/Kolkata' }, 'test');

    // Two leads on the sales person, one with nobody on it; all handed off yesterday, no outcome since.
    const lead = async (waId, name, handoffAt, assignee) => {
      await db.query("INSERT INTO leads (wa_id, display_name, status) VALUES ($1, $2, 'hot')", [waId, name]);
      await db.query("INSERT INTO handoffs (wa_id, reason, created_at) VALUES ($1, 'ready_to_book', $2)", [waId, handoffAt]);
      if (assignee) await db.query('INSERT INTO crm_lead_assignments (wa_id, user_id, assigned_at) VALUES ($1, $2, $3)', [waId, assignee, handoffAt]);
    };
    await lead('919811200001', 'Riya', '2030-03-09T05:00:00Z', ids.sales);
    await lead('919811200002', 'Arjun', '2030-03-09T09:00:00Z', ids.sales);
    await lead('919811200003', 'Meera', '2030-03-09T07:00:00Z', null);

    const run = now => tenancy.run(1, () => dailyNudges.runTenant(new Date(now)));
    assert.deepStrictEqual(await run('2030-03-10T03:00:00Z'), { sent: false, reason: 'before_start' }); // 08:30 in India

    const r = await run('2030-03-10T04:00:00Z'); // 09:30 in India
    assert.strictEqual(r.sent, true);
    const toSales = await alertsTo(db, '919000000011');
    assert.strictEqual(toSales.length, 1);
    assert.match(toSales[0].text, /2 leads waiting for an outcome: Riya, Arjun \(oldest 23 h\)/);
    const toManager = await alertsTo(db, '919000000012');
    assert.strictEqual(toManager.length, 1); // only the unassigned list: the manager has no leads of their own
    assert.match(toManager[0].text, /Nobody is on these\. 1 lead waiting for an outcome: Meera/);
    assert.strictEqual((await alertsTo(db, '919000000013')).length, 0); // owner switched alerts off

    await sleep(30);
    const post = sent.find(t => /waiting for an outcome/.test(t));
    assert.ok(post, 'one Telegram summary');
    assert.match(post, /3 leads are waiting for an outcome/);
    assert.match(post, /GKF Sales: 2 leads/);
    assert.match(post, /Unassigned: 1 lead/);

    // Same day again: nothing. Next morning: again.
    assert.deepStrictEqual(await run('2030-03-10T10:00:00Z'), { sent: false, reason: 'already_sent' });
    assert.strictEqual((await alertsTo(db, '919000000011')).length, 1);
    assert.strictEqual((await run('2030-03-11T04:00:00Z')).sent, true);
    assert.strictEqual((await alertsTo(db, '919000000011')).length, 2);
  } finally { notifyService.sendOverride = null; await ctx.cleanup(); }
});

test('R11b: the start time follows the client\'s time zone, and an empty day sends nothing', async () => {
  const ctx = await setup();
  const sent = [];
  notifyService.sendOverride = async text => { sent.push(text); return true; };
  try {
    await new LeadQueue(ctx.db).saveSettings({ autoAssign: false, workStart: '10:00', workEnd: '20:00', timezone: 'Asia/Dubai' }, 'test');
    const run = now => tenancy.run(1, () => dailyNudges.runTenant(new Date(now)));
    assert.strictEqual((await run('2030-03-10T05:30:00Z')).reason, 'before_start'); // 09:30 in Dubai
    const r = await run('2030-03-10T06:30:00Z'); // 10:30 in Dubai, no waiting leads in 2030
    assert.deepStrictEqual(r, { sent: true, people: 0, telegram: false });
    await sleep(20);
    assert.ok(!sent.some(t => /waiting for an outcome/.test(t)));
  } finally { notifyService.sendOverride = null; await ctx.cleanup(); }
});

test('R11b review: not at night; a failure gives the day back; two runs at once send once; template and button', async () => {
  const ctx = await setup();
  const sent = [];
  notifyService.sendOverride = async (text, opts) => { sent.push({ text, buttons: opts && opts.buttons }); return true; };
  const savedCrm = process.env.CRM_BASE_URL;
  process.env.CRM_BASE_URL = 'https://crm.example.com';
  try {
    const db = ctx.db;
    const sales = await ctx.userId('sales');
    await db.query("UPDATE crm_users SET alert_phone = '919000000021', alert_mode = 'mine' WHERE id = $1", [sales]);
    await new LeadQueue(db).saveSettings({ autoAssign: false, workStart: '09:00', workEnd: '21:00', timezone: 'Asia/Kolkata' }, 'test');
    await db.query("INSERT INTO leads (wa_id, display_name, status) VALUES ('919811300001', 'Kabir', 'hot')");
    await db.query("INSERT INTO handoffs (wa_id, reason, created_at) VALUES ('919811300001', 'ready_to_book', '2030-04-01T05:00:00Z')");
    await db.query("INSERT INTO crm_lead_assignments (wa_id, user_id, assigned_at) VALUES ('919811300001', $1, '2030-04-01T05:00:00Z')", [sales]);
    const run = now => tenancy.run(1, () => dailyNudges.runTenant(new Date(now)));

    // A restart at 22:00 in India sends nothing until tomorrow morning.
    assert.deepStrictEqual(await run('2030-04-02T16:30:00Z'), { sent: false, reason: 'after_end' });

    // Building the list fails: the day is given back and the next minute sends.
    const { Nudges } = require('../crm/src/nudges');
    const origDaily = Nudges.prototype.daily;
    Nudges.prototype.daily = async () => { throw new Error('db hiccup'); };
    try {
      await assert.rejects(run('2030-04-03T04:00:00Z'), /db hiccup/);
    } finally { Nudges.prototype.daily = origDaily; }
    // Queueing the WhatsApp fails: also given back.
    const outbound = require('../src/db/outboundRepository');
    const origEnqueue = outbound.enqueue;
    outbound.enqueue = async () => { throw new Error('queue down'); };
    try {
      await assert.rejects(run('2030-04-03T04:01:00Z'), /queue down/);
    } finally { outbound.enqueue = origEnqueue; }

    // Two processes at the same minute: exactly one sends.
    const [a, b] = await Promise.all([run('2030-04-03T04:02:00Z'), run('2030-04-03T04:02:00Z')]);
    assert.deepStrictEqual([a.sent, b.sent].sort(), [false, true]);
    const alerts = await db.many("SELECT metadata FROM outbound_messages WHERE wa_id = '919000000021' AND dedup_key LIKE 'staff_alert:daily_nudge:%'");
    assert.strictEqual(alerts.length, 1);
    const tpl = alerts[0].metadata.template;
    assert.strictEqual(tpl.name, 'staff_lead_alert');
    assert.strictEqual(tpl.button, '919811300001'); // opens the oldest waiting lead
    assert.strictEqual(tpl.body[0], 'Leads waiting for an outcome');

    await sleep(30);
    const post = sent.find(x => /waiting for an outcome/.test(x.text));
    assert.ok(post);
    assert.strictEqual(post.buttons[0][0].url, 'https://crm.example.com/leads?waiting=1&sort=waiting');
  } finally {
    notifyService.sendOverride = null;
    if (savedCrm === undefined) delete process.env.CRM_BASE_URL; else process.env.CRM_BASE_URL = savedCrm;
    await ctx.cleanup();
  }
});

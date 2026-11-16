const { setup } = require('./crm/helpers');
const test = require('node:test');
const assert = require('node:assert');
const notifyService = require('../src/services/notifyService');
const handoffRepository = require('../src/db/handoffRepository');
const leadQueue = require('../src/services/leadQueue');
const { LeadQueue } = require('../crm/src/queue');

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Auto-assign on (all day), one sales person with WhatsApp alerts, the manager and owner with alert numbers. */
async function queueOn(ctx) {
  const db = ctx.db;
  const ids = { owner: await ctx.userId('owner'), manager: await ctx.userId('manager'), sales: await ctx.userId('sales') };
  await db.query("UPDATE crm_users SET alert_phone = '919000000001', alert_mode = 'mine' WHERE id = $1", [ids.sales]);
  await db.query("UPDATE crm_users SET alert_phone = '919000000002', alert_mode = 'mine' WHERE id = $1", [ids.manager]);
  await db.query("UPDATE crm_users SET alert_phone = '919000000003', alert_mode = 'off' WHERE id = $1", [ids.owner]);
  await new LeadQueue(db).saveSettings({ autoAssign: true, workStart: '00:00', workEnd: '23:59', timezone: 'Asia/Kolkata' }, 'test');
  const lead = async waId => db.query("INSERT INTO leads (wa_id, display_name, status) VALUES ($1, 'Riya', 'hot')", [waId]);
  return { db, ids, lead };
}
const alertsTo = (db, phone) => db.many("SELECT dedup_key, text FROM outbound_messages WHERE wa_id = $1 ORDER BY id", [phone]);

test('K19: the bot wires the queue in (Business settings no longer says "needs the bot update")', () => {
  assert.strictEqual(LeadQueue.botWired, true);
});

test('K19: a new hand-off is assigned before the alerts, so the salesperson gets it and Telegram names them', async () => {
  const ctx = await setup();
  const sent = [];
  notifyService.sendOverride = async text => { sent.push(text); return true; };
  try {
    const { db, ids, lead } = await queueOn(ctx);
    await lead('919811100001');
    await handoffRepository.open({ waId: '919811100001', reason: 'ready_to_book', summary: 'Wants a visit' });
    assert.strictEqual((await db.one("SELECT user_id FROM crm_lead_assignments WHERE wa_id = '919811100001'")).user_id, ids.sales);
    assert.strictEqual((await db.one("SELECT status FROM handoffs WHERE wa_id = '919811100001'")).status, 'assigned');
    // "Their leads only": the assignee and their manager get the hand-off on WhatsApp (queued in the background).
    await sleep(100);
    assert.strictEqual((await alertsTo(db, '919000000001')).length, 1);
    assert.strictEqual((await alertsTo(db, '919000000002')).length, 1);
    await sleep(20);
    assert.ok(sent.some(t => /Assigned to <b>GKF Sales<\/b>/.test(t)), 'Telegram names the assignee');
  } finally { notifyService.sendOverride = null; await ctx.cleanup(); }
});

test('K19: a queue error never blocks the hand-off', async () => {
  const ctx = await setup();
  const orig = LeadQueue.prototype.autoAssign;
  LeadQueue.prototype.autoAssign = async () => { throw new Error('boom'); };
  try {
    const { db, lead } = await queueOn(ctx);
    await lead('919811100002');
    const id = await handoffRepository.open({ waId: '919811100002', reason: 'human_requested' });
    assert.ok(id);
    assert.strictEqual((await db.one("SELECT status FROM handoffs WHERE wa_id = '919811100002'")).status, 'pending');
  } finally { LeadQueue.prototype.autoAssign = orig; await ctx.cleanup(); }
});

test('K19: not picked up in 5 min alerts the manager, 15 min the owners (once each); Telegram says so', async () => {
  const ctx = await setup();
  const sent = [];
  notifyService.sendOverride = async text => { sent.push(text); return true; };
  try {
    const { db, ids, lead } = await queueOn(ctx);
    await db.query("UPDATE crm_users SET alert_mode = 'mine' WHERE id = $1", [ids.owner]);
    await lead('919811100003');
    await handoffRepository.open({ waId: '919811100003', reason: 'ready_to_book' });
    const t0 = new Date((await db.one("SELECT assigned_at FROM crm_lead_assignments WHERE wa_id = '919811100003'")).assigned_at);
    const at = m => new Date(t0.getTime() + m * 60000);

    assert.strictEqual(await leadQueue.sweepAll(at(3)), 0);
    assert.strictEqual(await leadQueue.sweepAll(at(6)), 1);
    const toManager = (await alertsTo(db, '919000000002')).filter(a => a.dedup_key.startsWith('staff_alert:not_picked_up:'));
    assert.strictEqual(toManager.length, 1);
    assert.match(toManager[0].text, /Not picked up in 5 min \(assigned to GKF Sales\)/);
    assert.strictEqual(await leadQueue.sweepAll(at(7)), 0); // never twice

    assert.strictEqual(await leadQueue.sweepAll(at(16)), 1);
    const toOwner = (await alertsTo(db, '919000000003')).filter(a => a.dedup_key.startsWith('staff_alert:not_picked_up:'));
    assert.strictEqual(toOwner.length, 1);
    assert.match(toOwner[0].text, /Not picked up in 15 min/);
    await sleep(20);
    assert.ok(sent.some(t => /Not picked up in 5 min/.test(t) && /alerted: GKF Manager on WhatsApp/.test(t)));
    assert.ok(sent.some(t => /Not picked up in 15 min/.test(t) && /alerted: GKF Owner on WhatsApp/.test(t)));

    // An owner with alerts off still gets nothing on WhatsApp.
    await db.query("UPDATE crm_users SET alert_mode = 'off' WHERE id = $1", [ids.owner]);
    await lead('919811100004');
    await handoffRepository.open({ waId: '919811100004', reason: 'ready_to_book' });
    const t1 = new Date((await db.one("SELECT assigned_at FROM crm_lead_assignments WHERE wa_id = '919811100004'")).assigned_at);
    await leadQueue.sweepAll(new Date(t1.getTime() + 20 * 60000));
    assert.strictEqual((await alertsTo(db, '919000000003')).filter(a => a.dedup_key.includes('919811100004')).length, 0);
  } finally { notifyService.sendOverride = null; await ctx.cleanup(); }
});

test('K19: with auto-assign off, nothing is assigned or escalated (as before)', async () => {
  const ctx = await setup();
  try {
    const db = ctx.db;
    await db.query("INSERT INTO leads (wa_id, status) VALUES ('919811100005', 'hot')");
    await handoffRepository.open({ waId: '919811100005', reason: 'ready_to_book' });
    assert.strictEqual(await db.one("SELECT 1 AS x FROM crm_lead_assignments WHERE wa_id = '919811100005'"), null);
    assert.strictEqual(await leadQueue.sweepAll(new Date(Date.now() + 60 * 60000)), 0);
  } finally { await ctx.cleanup(); }
});

test('K19 review: a lead handed off again escalates again; Telegram says when nobody got a WhatsApp; one failure does not stop the rest', async () => {
  const ctx = await setup();
  const sent = [];
  notifyService.sendOverride = async text => { sent.push(text); return true; };
  try {
    const { db, ids, lead } = await queueOn(ctx);
    await lead('919811100006');
    await handoffRepository.open({ waId: '919811100006', reason: 'ready_to_book' });
    const first = new Date((await db.one("SELECT assigned_at FROM crm_lead_assignments WHERE wa_id = '919811100006'")).assigned_at);
    await leadQueue.sweepAll(new Date(first.getTime() + 6 * 60000));
    // Picked up, resolved, and next week the lead needs a person again: a new assignment.
    await handoffRepository.resolve('919811100006');
    await db.query("UPDATE crm_lead_assignments SET assigned_at = now() + interval '7 days', escalation_level = 0 WHERE wa_id = '919811100006'");
    await db.query("INSERT INTO handoffs (wa_id, reason, status) VALUES ('919811100006', 'ready_to_book', 'assigned')");
    const second = new Date((await db.one("SELECT assigned_at FROM crm_lead_assignments WHERE wa_id = '919811100006'")).assigned_at);
    await leadQueue.sweepAll(new Date(second.getTime() + 6 * 60000));
    const toManager = (await alertsTo(db, '919000000002')).filter(a => a.dedup_key.startsWith('staff_alert:not_picked_up:919811100006:'));
    assert.strictEqual(toManager.length, 2, 'one WhatsApp per assignment, not one ever');

    // The owner has alerts off: Telegram must not claim someone was alerted.
    await db.query("UPDATE crm_users SET alert_phone = NULL WHERE id = $1", [ids.manager]);
    await lead('919811100007');
    await handoffRepository.open({ waId: '919811100007', reason: 'ready_to_book' });
    const t = new Date((await db.one("SELECT assigned_at FROM crm_lead_assignments WHERE wa_id = '919811100007'")).assigned_at);
    await leadQueue.sweepAll(new Date(t.getTime() + 6 * 60000));
    await sleep(20);
    assert.ok(sent.some(x => /nobody on WhatsApp \(GKF Manager: no number or alerts off\)/.test(x)));

    // One alert failing (here: the first) is logged; the next lead is still escalated.
    await db.query("UPDATE crm_users SET alert_phone = '919000000002' WHERE id = $1", [ids.manager]);
    await lead('919811100008'); await lead('919811100009');
    await handoffRepository.open({ waId: '919811100008', reason: 'ready_to_book' });
    await handoffRepository.open({ waId: '919811100009', reason: 'ready_to_book' });
    const staffAlerts = require('../src/services/staffAlerts');
    const orig = staffAlerts.alertUsers;
    let calls = 0;
    staffAlerts.alertUsers = async args => { if (++calls === 1) throw new Error('boom'); return orig(args); };
    try {
      await leadQueue.sweepAll(new Date(Date.now() + 30 * 60000));
    } finally { staffAlerts.alertUsers = orig; }
    const later = (await alertsTo(db, '919000000002')).filter(a => /91981110000[89]/.test(a.dedup_key) && a.dedup_key.startsWith('staff_alert:not_picked_up:'));
    assert.ok(later.length >= 1, 'the other lead still escalated');
  } finally { notifyService.sendOverride = null; await ctx.cleanup(); }
});

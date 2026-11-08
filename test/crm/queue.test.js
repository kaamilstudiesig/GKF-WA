const { setup } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const tenancy = require('../../src/tenancy/context');
const registry = require('../../src/tenancy/registry');
const { LeadQueue, workingMinutes } = require('../../crm/src/queue');

const IST = { work_start: '09:00', work_end: '21:00', timezone: 'Asia/Kolkata' };
const GST = { work_start: '09:00', work_end: '21:00', timezone: 'Asia/Dubai' };

test('workingMinutes: only minutes inside working hours count', () => {
  // 10:00 to 10:07 IST (04:30Z to 04:37Z) -> 7.
  assert.strictEqual(workingMinutes('2030-01-07T04:30:00Z', '2030-01-07T04:37:00Z', IST), 7);
  // Assigned 02:00 IST, now 09:06 IST: the clock starts at 09:00 -> 6.
  assert.strictEqual(workingMinutes('2030-01-06T20:30:00Z', '2030-01-07T03:36:00Z', IST), 6);
  // Overnight: 20:55 IST to 09:05 next day -> 5 before closing + 5 after opening.
  assert.strictEqual(workingMinutes('2030-01-07T15:25:00Z', '2030-01-08T03:35:00Z', IST), 10);
  // Entirely at night -> 0, so nobody is alerted at night.
  assert.strictEqual(workingMinutes('2030-01-07T16:00:00Z', '2030-01-08T03:00:00Z', IST), 0);
  // Weekends are working days like any other: Saturday 10:00 to 10:20 IST.
  assert.strictEqual(workingMinutes('2030-01-05T04:30:00Z', '2030-01-05T04:50:00Z', IST), 20);
  // Same instant, different time zones: 05:00Z is 10:30 in India (working) but 09:00 in Dubai (just opening).
  assert.strictEqual(workingMinutes('2030-01-07T04:50:00Z', '2030-01-07T05:10:00Z', IST), 20);
  assert.strictEqual(workingMinutes('2030-01-07T04:50:00Z', '2030-01-07T05:10:00Z', GST), 10);
  // A shift past midnight (18:00 to 02:00 IST): 01:00 to 03:00 IST counts one hour.
  assert.strictEqual(workingMinutes('2030-01-07T19:30:00Z', '2030-01-07T21:30:00Z', { ...IST, work_start: '18:00', work_end: '02:00' }), 60);
  assert.strictEqual(workingMinutes('2030-01-07T05:00:00Z', '2030-01-07T04:00:00Z', IST), 0);
});

/** Three sales people under the seeded manager, plus leads with open hand-offs. */
async function queueSetup({ autoAssign = true } = {}) {
  const ctx = await setup();
  const db = ctx.db;
  const managerId = await ctx.userId('manager');
  await db.query('UPDATE crm_users SET active = false WHERE role = \'sales\''); // the seeded rep is out of these tests
  const rep = async (name, extra = {}) => (await db.one(`INSERT INTO crm_users (email, name, role, manager_id, password_hash, accepting)
    VALUES ($1, $2, 'sales', $3, 'x', $4) RETURNING id`, [`${name.toLowerCase()}@client.com`, name, extra.manager === undefined ? managerId : extra.manager, extra.accepting ?? true])).id;
  const ids = { manager: managerId, owner: await ctx.userId('owner'), a: await rep('Asha'), b: await rep('Bala'), c: await rep('Chetan') };
  const queue = new LeadQueue(db);
  if (autoAssign) await queue.saveSettings({ autoAssign: true, workStart: '00:00', workEnd: '23:59', timezone: 'Asia/Kolkata' }, 'test');
  let n = 0;
  const lead = async () => {
    const waId = `9166000000${String(++n).padStart(2, '0')}`;
    await db.query("INSERT INTO leads (wa_id, status) VALUES ($1, 'hot')", [waId]);
    await db.query("INSERT INTO handoffs (wa_id, reason) VALUES ($1, 'ready_to_book')", [waId]);
    return waId;
  };
  return { ctx, db, ids, queue, lead };
}
const assignee = async (db, waId) => (await db.one('SELECT user_id FROM crm_lead_assignments WHERE wa_id = $1', [waId]) || {}).user_id;

test('autoAssign: off by default, then round-robin, keeps a good assignee', async () => {
  const { ctx, db, ids, queue, lead } = await queueSetup({ autoAssign: false });
  try {
    const w0 = await lead();
    assert.strictEqual(await queue.autoAssign(w0), null); // off: hand-off stays pending
    assert.strictEqual((await db.one('SELECT status FROM handoffs WHERE wa_id = $1', [w0])).status, 'pending');

    await queue.saveSettings({ autoAssign: true, workStart: '09:00', workEnd: '21:00', timezone: 'Asia/Kolkata' }, 'owner');
    const picks = [];
    for (let i = 0; i < 4; i++) picks.push((await queue.autoAssign(await lead())).id);
    assert.deepStrictEqual(picks, [ids.a, ids.b, ids.c, ids.a]); // never assigned first (lowest id), then oldest assignment

    const w1 = '916600000002';
    const h = await db.one('SELECT status, assigned_to FROM handoffs WHERE wa_id = $1', [w1]);
    assert.deepStrictEqual(h, { status: 'assigned', assigned_to: 'asha@client.com' });
    const log = await db.one("SELECT user_id, details FROM crm_activity_log WHERE action = 'auto_assigned' AND wa_id = $1", [w1]);
    assert.strictEqual(log.user_id, null);
    assert.strictEqual(log.details.to, 'Asha');

    // A new hand-off on a lead whose assignee is fine stays with them.
    assert.strictEqual((await queue.autoAssign(w1)).id, ids.a);
    // Not taking leads -> someone else.
    await db.query('UPDATE crm_users SET accepting = false WHERE id = $1', [ids.a]);
    assert.notStrictEqual((await queue.autoAssign(w1)).id, ids.a);
    // Nobody available -> null.
    await db.query("UPDATE crm_users SET accepting = false WHERE role = 'sales'");
    assert.strictEqual(await queue.autoAssign(await lead(), {}), null);
  } finally { await ctx.cleanup(); }
});

test('autoAssign: the previous assignee\'s team comes first; two at once pick different people', async () => {
  const { ctx, db, ids, queue, lead } = await queueSetup();
  try {
    // A second team under another manager.
    const m2 = (await db.one("INSERT INTO crm_users (email, name, role, password_hash) VALUES ('m2@client.com', 'M2', 'manager', 'x') RETURNING id")).id;
    const d = (await db.one("INSERT INTO crm_users (email, name, role, manager_id, password_hash) VALUES ('dev@client.com', 'Dev', 'sales', $1, 'x') RETURNING id", [m2])).id;
    const e = (await db.one("INSERT INTO crm_users (email, name, role, manager_id, password_hash) VALUES ('esha@client.com', 'Esha', 'sales', $1, 'x') RETURNING id", [m2])).id;
    const w = await lead();
    await db.query('INSERT INTO crm_lead_assignments (wa_id, user_id) VALUES ($1, $2)', [w, d]);
    await db.query('UPDATE crm_users SET accepting = false WHERE id = $1', [d]);
    assert.strictEqual((await queue.autoAssign(w)).id, e); // Dev's teammate, not Asha (who has never had a lead)

    const [x, y] = await Promise.all([queue.autoAssign(await lead()), queue.autoAssign(await lead())]);
    assert.notStrictEqual(x.id, y.id);
    assert.ok([ids.a, ids.b, ids.c].includes(x.id) && [ids.a, ids.b, ids.c].includes(y.id));
  } finally { await ctx.cleanup(); }
});

test('release moves only leads not picked up yet', async () => {
  const { ctx, db, ids, queue, lead } = await queueSetup();
  try {
    const fresh = await lead(); const talking = await lead(); const done = await lead();
    for (const w of [fresh, talking, done]) {
      await db.query('INSERT INTO crm_lead_assignments (wa_id, user_id, assigned_at) VALUES ($1, $2, now() - interval \'10 minutes\')', [w, ids.a]);
      await db.query("UPDATE handoffs SET status = 'assigned' WHERE wa_id = $1", [w]);
    }
    await db.query(`INSERT INTO outbound_messages (dedup_key, wa_id, text, metadata) VALUES ('crm:x', $1, 'Hi', '{"source":"crm"}'::jsonb)`, [talking]);
    await db.query("UPDATE handoffs SET status = 'resolved' WHERE wa_id = $1", [done]);
    await db.query('UPDATE crm_users SET accepting = false WHERE id = $1', [ids.a]);

    assert.strictEqual(await queue.release(ids.a), 1);
    assert.notStrictEqual(await assignee(db, fresh), ids.a);
    assert.strictEqual(await assignee(db, talking), ids.a); // mid-conversation, stays
    assert.strictEqual(await assignee(db, done), ids.a); // no open hand-off
  } finally { await ctx.cleanup(); }
});

test('sweep: 5 minutes to the manager, 15 to the owners, once each; old leads and night are quiet', async () => {
  const { ctx, db, ids, queue, lead } = await queueSetup();
  try {
    const w = await lead();
    await queue.autoAssign(w); // Asha, under the seeded manager
    const t0 = new Date((await db.one('SELECT assigned_at FROM crm_lead_assignments WHERE wa_id = $1', [w])).assigned_at);
    const at = mins => new Date(t0.getTime() + mins * 60000);

    assert.deepStrictEqual(await queue.sweep(at(4)), []);
    assert.deepStrictEqual(await queue.sweep(at(6)), [{ waId: w, userId: ids.manager, level: 1, assigneeId: ids.a }]);
    assert.deepStrictEqual(await queue.sweep(at(7)), []); // never repeats
    const owners = await queue.sweep(at(16));
    assert.deepStrictEqual(owners, [{ waId: w, userId: ids.owner, level: 2, assigneeId: ids.a }]);
    assert.deepStrictEqual(await queue.sweep(at(60)), []);

    // A reply picks the lead up: nothing to escalate.
    const w2 = await lead();
    await queue.autoAssign(w2);
    await db.query(`INSERT INTO outbound_messages (dedup_key, wa_id, text, metadata) VALUES ('crm:y', $1, 'Hi', '{"source":"crm"}'::jsonb)`, [w2]);
    assert.ok(!(await queue.sweep(at(30))).some(x => x.waId === w2));

    // Sales person with no manager -> level 1 goes to the owners. Missed sweeps alert each level once.
    const w3 = await lead();
    await db.query('UPDATE crm_users SET manager_id = NULL');
    await queue.autoAssign(w3);
    assert.deepStrictEqual((await queue.sweep(at(30))).filter(x => x.waId === w3).map(x => [x.userId, x.level]), [[ids.owner, 1], [ids.owner, 2]]);

    // A manual reassignment restarts the clock.
    await db.query('UPDATE crm_lead_assignments SET escalation_level = 2 WHERE wa_id = $1', [w]);
    const { Crm } = require('../../crm/src/crm');
    const owner = await db.one('SELECT * FROM crm_users WHERE id = $1', [ids.owner]);
    await new Crm(db).assign(owner, w, ids.b);
    assert.strictEqual((await db.one('SELECT escalation_level FROM crm_lead_assignments WHERE wa_id = $1', [w])).escalation_level, 0);
  } finally { await ctx.cleanup(); }
});

test('sweep: leads assigned before auto-assign was turned on never escalate; nights don\'t count', async () => {
  const { ctx, db, ids, queue, lead } = await queueSetup({ autoAssign: false });
  try {
    const old = await lead();
    await db.query("INSERT INTO crm_lead_assignments (wa_id, user_id, assigned_at) VALUES ($1, $2, now() - interval '2 hours')", [old, ids.a]);
    await db.query("UPDATE handoffs SET status = 'assigned' WHERE wa_id = $1", [old]);
    await queue.saveSettings({ autoAssign: true, workStart: '09:00', workEnd: '21:00', timezone: 'Asia/Kolkata' }, 'owner');
    assert.deepStrictEqual(await queue.sweep(new Date(Date.now() + 3 * 3600000)), []);

    // Assigned at night (simulated: 23:00 IST), swept at 08:59 IST: no working minutes yet, no alert.
    const night = await lead();
    await queue.autoAssign(night);
    await db.query("UPDATE crm_lead_assignments SET assigned_at = '2030-01-07T17:30:00Z' WHERE wa_id = $1", [night]);
    await db.query("UPDATE crm_settings SET auto_assign_since = '2030-01-01T00:00:00Z'");
    assert.deepStrictEqual((await queue.sweep(new Date('2030-01-08T03:29:00Z'))).filter(x => x.waId === night), []);
    assert.strictEqual((await queue.sweep(new Date('2030-01-08T03:36:00Z'))).filter(x => x.waId === night)[0].level, 1); // 09:06 IST
  } finally { await ctx.cleanup(); }
});

test('one client\'s queue never sees another client\'s staff', async () => {
  const { ctx, ids, queue, lead } = await queueSetup();
  try {
    const acme = await registry.create({ slug: 'acmeq', name: 'Acme Q', phoneNumberId: '1000200030099', crmHost: 'crm.acmeq.test' });
    await tenancy.run(acme.id, async () => {
      await ctx.db.query("INSERT INTO crm_users (email, name, role, password_hash) VALUES ('rep@acme.com', 'Acme Rep', 'sales', 'x')");
      await ctx.db.query("INSERT INTO crm_settings (auto_assign, auto_assign_since) VALUES (true, now())");
      await ctx.db.query("INSERT INTO leads (wa_id, status) VALUES ('916600000099', 'hot')");
      await ctx.db.query("INSERT INTO handoffs (wa_id, reason) VALUES ('916600000099', 'ready_to_book')");
      assert.strictEqual((await new LeadQueue(ctx.db).autoAssign('916600000099')).name, 'Acme Rep');
      assert.deepStrictEqual(await new LeadQueue(ctx.db).settings().then(s => s.work_start), '09:00');
    });
    // Back in GKF: Acme's rep is never picked, and Acme's settings are not ours.
    const picks = [];
    for (let i = 0; i < 4; i++) picks.push((await queue.autoAssign(await lead())).id);
    assert.ok(picks.every(id => [ids.a, ids.b, ids.c].includes(id)));
    assert.strictEqual((await queue.settings()).work_start, '00:00');
  } finally { await ctx.cleanup(); }
});

test('screens: owner turns the queue on; Taking leads off and deactivation hand leads back; timer shows', async () => {
  const { login } = require('./helpers');
  const { LeadQueue } = require('../../crm/src/queue');
  const { ctx, db, ids, lead } = await queueSetup({ autoAssign: false });
  try {
    const owner = await login(ctx.app, 'owner');
    assert.match((await owner.agent.get('/settings')).text, /action="\/settings\/queue"/);

    // Until the bot assigns hand-offs (K19), the switch says so and can't be turned on.
    LeadQueue.botWired = false;
    const before = (await owner.agent.get('/settings')).text;
    assert.match(before, /Needs the WhatsApp bot update/);
    assert.match(before, /name="auto_assign" value="1" class="toggle toggle-primary"\s+disabled/);
    await owner.agent.post('/settings/queue').type('form').send({ _csrf: owner.csrf, auto_assign: '1', work_start: '09:00', work_end: '21:00', timezone: 'Asia/Kolkata' });
    assert.strictEqual((await db.one('SELECT auto_assign FROM crm_settings')).auto_assign, false);
    LeadQueue.botWired = true; // as after K19
    assert.doesNotMatch((await owner.agent.get('/settings')).text, /Needs the WhatsApp bot update/);
    const bad = await owner.agent.post('/settings/queue').type('form').send({ _csrf: owner.csrf, auto_assign: '1', work_start: '09:00', work_end: '09:00', timezone: 'Asia/Kolkata' });
    assert.strictEqual(bad.status, 400);
    assert.match(bad.text, /different start and end/);
    const r = await owner.agent.post('/settings/queue').type('form').send({ _csrf: owner.csrf, auto_assign: '1', work_start: '00:00', work_end: '23:59', timezone: 'Asia/Dubai' });
    assert.strictEqual(r.status, 302);
    const s = await db.one('SELECT auto_assign, auto_assign_since, timezone, updated_by FROM crm_settings');
    assert.ok(s.auto_assign && s.auto_assign_since);
    assert.deepStrictEqual([s.timezone, s.updated_by], ['Asia/Dubai', 'owner@goldkraftfitness.com']);
    const manager = await login(ctx.app, 'manager');
    assert.strictEqual((await manager.agent.post('/settings/queue').type('form')
      .send({ _csrf: manager.csrf, auto_assign: '0', work_start: '09:00', work_end: '21:00', timezone: 'Asia/Kolkata' })).status, 403);

    // Only the seeded sales person (S) and Bala take leads: S, Bala, S.
    const S = await ctx.userId('sales');
    await db.query('UPDATE crm_users SET active = true WHERE id = $1', [S]);
    await db.query('UPDATE crm_users SET active = false WHERE id = ANY($1::int[])', [[ids.a, ids.c]]);
    const queue = new LeadQueue(db);
    const w1 = await lead(); const w2 = await lead(); const w3 = await lead();
    assert.deepStrictEqual([(await queue.autoAssign(w1)).id, (await queue.autoAssign(w2)).id, (await queue.autoAssign(w3)).id], [S, ids.b, S]);

    const sales = await login(ctx.app, 'sales');
    assert.match((await sales.agent.get(`/leads/${w1}`)).text, /Waiting \d+ min/); // timer while not picked up
    assert.match((await sales.agent.get('/leads')).text, /Waiting \d+ min/);
    assert.match((await sales.agent.get('/')).text, /name="accepting"[^>]*checked/);
    const off = await sales.agent.post('/account/accepting').type('form').send({ _csrf: sales.csrf });
    assert.match(decodeURIComponent(off.headers.location.replace(/\+/g, " ")), /2 leads went to someone else/);
    assert.deepStrictEqual([await assignee(db, w1), await assignee(db, w3)], [ids.b, ids.b]);
    assert.strictEqual((await db.one('SELECT accepting FROM crm_users WHERE id = $1', [S])).accepting, false);
    assert.match((await owner.agent.get('/users')).text, /Not taking leads/);
    const on = await sales.agent.post('/account/accepting').type('form').send({ _csrf: sales.csrf, accepting: '1' });
    assert.match(decodeURIComponent(on.headers.location.replace(/\+/g, " ")), /You are taking new leads/);

    // Owner deactivates Bala: Bala's leads nobody picked up go to the next person (S, taking leads again).
    const bala = await db.one('SELECT * FROM crm_users WHERE id = $1', [ids.b]);
    const deact = await owner.agent.post(`/users/${ids.b}`).type('form')
      .send({ _csrf: owner.csrf, name: bala.name, email: bala.email, role: 'sales', manager_id: String(ids.manager) });
    assert.match(decodeURIComponent(deact.headers.location.replace(/\+/g, " ")), /3 leads went to someone else/);
    assert.deepStrictEqual([await assignee(db, w1), await assignee(db, w2), await assignee(db, w3)], [S, S, S]);
  } finally { LeadQueue.botWired = false; await ctx.cleanup(); }
});

test('R2 review fixes: role change hands leads back, only sales use Taking leads, hand-assigned leads also escalate', async () => {
  const { login } = require('./helpers');
  const { ctx, db, ids, queue, lead } = await queueSetup();
  try {
    // An owner makes Asha a manager: her leads nobody picked up go to someone else.
    const w = await lead();
    await queue.autoAssign(w);
    assert.strictEqual(await assignee(db, w), ids.a);
    const owner = await login(ctx.app, 'owner');
    const asha = await db.one('SELECT * FROM crm_users WHERE id = $1', [ids.a]);
    const res = await owner.agent.post(`/users/${ids.a}`).type('form').send({ _csrf: owner.csrf, name: asha.name, email: asha.email, role: 'manager', active: '1' });
    assert.match(decodeURIComponent(res.headers.location.replace(/\+/g, ' ')), /1 lead went to someone else/);
    assert.notStrictEqual(await assignee(db, w), ids.a);

    // Owners and managers can't flip a Taking leads flag that means nothing for them.
    assert.strictEqual((await owner.agent.post('/account/accepting').type('form').send({ _csrf: owner.csrf })).status, 403);
    assert.strictEqual((await db.one("SELECT accepting FROM crm_users WHERE role = 'owner' LIMIT 1")).accepting, true);

    // A lead a manager assigns by hand after auto-assign is on also escalates (the customer is waiting either way).
    const w2 = await lead();
    const { Crm } = require('../../crm/src/crm');
    const mgr = await db.one('SELECT * FROM crm_users WHERE id = $1', [ids.manager]);
    await new Crm(db).assign(mgr, w2, ids.b);
    const t0 = new Date((await db.one('SELECT assigned_at FROM crm_lead_assignments WHERE wa_id = $1', [w2])).assigned_at);
    const alerts = await queue.sweep(new Date(t0.getTime() + 6 * 60000));
    assert.deepStrictEqual(alerts.filter(x => x.waId === w2).map(x => [x.userId, x.level]), [[ids.manager, 1]]);
  } finally { await ctx.cleanup(); }
});

const { setup, login } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const { Nudges } = require('../../crm/src/nudges');

const ago = hours => new Date(Date.now() - hours * 3600000).toISOString();

/**
 * W1 hot, hand-off 3h ago, nothing logged            -> waiting (sales)
 * W2 hand-off 3h ago, "No answer" logged after it     -> not waiting
 * W3 hand-off 30 min ago                              -> not yet (too fresh)
 * W4 converted                                        -> not waiting
 * W5 hot, no hand-off, first message 5h ago            -> waiting (unassigned)
 * W6 hand-off 40 days ago                             -> too old, not waiting
 * W7 outcome 10h ago, then a new hand-off 3h ago       -> waiting again (manager)
 * W8 hand-off 4h ago, assigned to a disabled person    -> waiting, counts as unassigned
 */
async function seed(db, ids) {
  const lead = (waId, status, firstHoursAgo = 6) => db.query('INSERT INTO leads (wa_id, status, display_name, first_contact_at, last_inbound_message_at) VALUES ($1, $2, $3, $4, $4)',
    [waId, status, `Lead ${waId.slice(-1)}`, ago(firstHoursAgo)]);
  const handoff = (waId, hoursAgo, status = 'assigned') => db.query("INSERT INTO handoffs (wa_id, reason, status, created_at) VALUES ($1, 'ready_to_book', $2, $3)", [waId, status, ago(hoursAgo)]);
  const outcome = (waId, hoursAgo) => db.query("INSERT INTO crm_lead_outcomes (wa_id, user_id, outcome, created_at) VALUES ($1, $2, 'no_answer', $3)", [waId, ids.sales, ago(hoursAgo)]);
  const assign = (waId, userId) => db.query('INSERT INTO crm_lead_assignments (wa_id, user_id) VALUES ($1, $2)', [waId, userId]);

  await lead('917700000001', 'hot'); await handoff('917700000001', 3); await assign('917700000001', ids.sales);
  await lead('917700000002', 'hot'); await handoff('917700000002', 3); await outcome('917700000002', 2); await assign('917700000002', ids.sales);
  await lead('917700000003', 'hot'); await handoff('917700000003', 0.5); await assign('917700000003', ids.sales);
  await lead('917700000004', 'converted'); await handoff('917700000004', 3, 'resolved'); await assign('917700000004', ids.sales);
  await lead('917700000005', 'hot', 5);
  await lead('917700000006', 'hot', 24 * 41); await handoff('917700000006', 24 * 40);
  await lead('917700000007', 'qualified', 12); await outcome('917700000007', 10); await handoff('917700000007', 3); await assign('917700000007', ids.manager);
  await lead('917700000008', 'new'); await handoff('917700000008', 4); await assign('917700000008', ids.disabled);
}

async function context() {
  const ctx = await setup();
  const ids = { sales: await ctx.userId('sales'), manager: await ctx.userId('manager') };
  ids.disabled = (await ctx.db.one(`INSERT INTO crm_users (email, name, role, password_hash, active)
    VALUES ('gone@client.com', 'Gone', 'sales', 'x', false) RETURNING id`)).id;
  await seed(ctx.db, ids);
  return { ctx, ids };
}

const mine = list => list.filter(l => l.waId.startsWith('9177'));

test('daily list: who has leads waiting for an outcome', async () => {
  const { ctx, ids } = await context();
  try {
    const list = await new Nudges(ctx.db).daily();
    const byUser = Object.fromEntries(list.map(g => [g.user ? g.user.id : 'unassigned', mine(g.leads).map(l => l.waId)]));
    assert.deepStrictEqual(byUser[ids.sales], ['917700000001']);
    assert.deepStrictEqual(byUser[ids.manager], ['917700000007']);
    assert.deepStrictEqual(byUser.unassigned, ['917700000005', '917700000008']); // oldest first; disabled assignee counts as unassigned
    assert.strictEqual(list[list.length - 1].user, null); // unassigned group comes last
    const w1 = list.find(g => g.user && g.user.id === ids.sales).leads.find(l => l.waId === '917700000001');
    assert.strictEqual(w1.hours, 3);
    assert.strictEqual(w1.name, 'Lead 1');
    assert.ok(!list.some(g => g.user && g.user.id === ids.disabled));
  } finally { await ctx.cleanup(); }
});

test('dashboard and Leads filter show waiting leads within each role', async () => {
  const { ctx } = await context();
  try {
    const sales = await login(ctx.app, 'sales');
    const dash = await sales.agent.get('/');
    assert.match(dash.text, /No outcome yet/);
    assert.match(dash.text, /Log what happened/);
    assert.match(dash.text, /href="\/leads\/917700000001#outcome"/); // one tap to the outcome buttons

    const list = (await sales.agent.get('/leads?waiting=1&sort=waiting')).text;
    assert.ok(list.includes('917700000001'));
    for (const id of ['917700000002', '917700000003', '917700000004', '917700000005']) assert.ok(!list.includes(id), id);

    const owner = await login(ctx.app, 'owner');
    const all = (await owner.agent.get('/leads?waiting=1&sort=waiting')).text;
    for (const id of ['917700000001', '917700000005', '917700000007', '917700000008']) assert.ok(all.includes(id), id);
    for (const id of ['917700000002', '917700000003', '917700000004', '917700000006']) assert.ok(!all.includes(id), id);
    // Longest waiting first: W5 (5h) before W1 (3h).
    assert.ok(all.indexOf('917700000005') < all.indexOf('917700000001'));

    // Logging any outcome takes the lead off the list.
    await sales.agent.post('/leads/917700000001/outcome').type('form').send({ _csrf: sales.csrf, outcome: 'called_connected' });
    assert.ok(!(await sales.agent.get('/leads?waiting=1')).text.includes('917700000001'));
  } finally { await ctx.cleanup(); }
});

test('daily list with a fixed time: exact 2-hour and 30-day edges, resolved hand-offs, alert mode', async () => {
  const ctx = await setup();
  try {
    const NOW = new Date('2030-05-10T12:00:00Z');
    const at = mins => new Date(NOW.getTime() - mins * 60000).toISOString();
    const salesId = await ctx.userId('sales');
    await ctx.db.query("UPDATE crm_users SET alert_phone = '919845000001', alert_mode = 'mine' WHERE id = $1", [salesId]);
    const add = async (waId, handoffMinsAgo, status = 'assigned') => {
      await ctx.db.query("INSERT INTO leads (wa_id, status, first_contact_at) VALUES ($1, 'qualified', $2)", [waId, at(handoffMinsAgo + 60)]);
      await ctx.db.query("INSERT INTO handoffs (wa_id, reason, status, created_at) VALUES ($1, 'ready_to_book', $2, $3)", [waId, status, at(handoffMinsAgo)]);
      await ctx.db.query('INSERT INTO crm_lead_assignments (wa_id, user_id) VALUES ($1, $2)', [waId, salesId]);
    };
    await add('917800000001', 120); // exactly 2 hours: waiting
    await add('917800000002', 119); // 1 minute short: not yet
    await add('917800000003', 30 * 24 * 60); // exactly 30 days: still waiting
    await add('917800000004', 30 * 24 * 60 + 1); // 1 minute past 30 days: too old
    await add('917800000005', 300, 'resolved'); // staff resolved it but logged nothing: still waiting

    const list = await new Nudges(ctx.db).daily(NOW);
    const mine = list.find(g => g.user && g.user.id === salesId);
    assert.deepStrictEqual(mine.leads.map(l => l.waId).filter(w => w.startsWith('9178')).sort(), ['917800000001', '917800000003', '917800000005']);
    assert.deepStrictEqual([mine.user.alertPhone, mine.user.alertMode], ['919845000001', 'mine']);
    assert.strictEqual(mine.leads.find(l => l.waId === '917800000001').hours, 2);

    // Alerts turned off: the list says so, so the sender skips WhatsApp.
    await ctx.db.query("UPDATE crm_users SET alert_mode = 'off' WHERE id = $1", [salesId]);
    assert.strictEqual((await new Nudges(ctx.db).daily(NOW)).find(g => g.user && g.user.id === salesId).user.alertMode, 'off');
  } finally { await ctx.cleanup(); }
});

test('Leads chips: with both "Needs human" and "No outcome" on, neither single chip is highlighted', async () => {
  const ctx = await setup();
  try {
    const owner = await login(ctx.app, 'owner');
    const chip = (html, label) => new RegExp(`class="[^"]*btn-primary[^"]*">${label}</a>`).test(html);
    const both = (await owner.agent.get('/leads?waiting=1&needs_human=1')).text;
    assert.ok(!chip(both, 'Needs human') && !chip(both, 'No outcome'));
    assert.ok(chip((await owner.agent.get('/leads?waiting=1&sort=waiting')).text, 'No outcome'));
    assert.ok(chip((await owner.agent.get('/leads?needs_human=1')).text, 'Needs human'));
  } finally { await ctx.cleanup(); }
});

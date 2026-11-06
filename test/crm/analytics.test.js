const { setup, login } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const { Analytics } = require('../../crm/src/analytics');

// A fixed month far from the demo data, so only the rows below count.
const NOW = new Date('2030-01-31T12:00:00Z');
const at = (iso, plusMin = 0) => new Date(new Date(iso).getTime() + plusMin * 60000).toISOString();

/**
 * L1 converted: hand-off, CRM reply after 2 min, outcomes up to Joined ₹5,000 paid by link.
 * L2 lost: hand-off, "No answer" after 30 min, Lost (price) two days later.
 * L3 hot: hand-off never contacted (over 24 h old).
 * L4 new: hand-off an hour ago, nothing yet (not due for the logging rate).
 * L5 qualified: no hand-off.
 * L6 first seen before the period, Lost (timing) inside it: counts in lost reasons only.
 */
async function seed(db, salesId) {
  const lead = (waId, status, first) => db.query('INSERT INTO leads (wa_id, status, first_contact_at) VALUES ($1, $2, $3)', [waId, status, first]);
  const handoff = (waId, created) => db.query("INSERT INTO handoffs (wa_id, reason, status, created_at) VALUES ($1, 'ready_to_book', 'assigned', $2)", [waId, created]);
  const outcome = (waId, outcome, created, extra = {}) => db.query(`INSERT INTO crm_lead_outcomes (wa_id, user_id, outcome, amount_inr, lost_reason, created_at)
    VALUES ($1, $2, $3, $4, $5, $6)`, [waId, salesId, outcome, extra.amount || null, extra.reason || null, created]);
  const assign = waId => db.query('INSERT INTO crm_lead_assignments (wa_id, user_id, assigned_at) VALUES ($1, $2, $3)', [waId, salesId, '2030-01-01T00:00:00Z']);

  await lead('918000000001', 'converted', '2030-01-10T09:00:00Z');
  await handoff('918000000001', '2030-01-10T10:00:00Z');
  await db.query(`INSERT INTO outbound_messages (dedup_key, wa_id, text, metadata, created_at) VALUES ('crm:t1', '918000000001', 'Hi', $1::jsonb, $2)`,
    [JSON.stringify({ source: 'crm', user_id: salesId }), at('2030-01-10T10:00:00Z', 2)]);
  await db.query(`INSERT INTO outbound_messages (dedup_key, wa_id, text, metadata, created_at) VALUES ('bot:t1', '918000000001', 'Bot', '{}'::jsonb, $1)`,
    [at('2030-01-10T10:00:00Z', 1)]); // the bot's own reply is not a human contact
  await outcome('918000000001', 'called_connected', at('2030-01-10T10:00:00Z', 3));
  await outcome('918000000001', 'visit_booked', at('2030-01-10T10:00:00Z', 4));
  await outcome('918000000001', 'visited', '2030-01-12T10:00:00Z');
  await outcome('918000000001', 'joined', '2030-01-12T11:00:00Z', { amount: 5000 });
  await db.query(`INSERT INTO crm_payment_links (wa_id, user_id, reference_id, plan, amount_inr, status, paid_at)
    VALUES ('918000000001', $1, 'ref-1', 'Monthly', 5000, 'paid', '2030-01-12T11:00:30Z')`, [salesId]);
  await assign('918000000001');

  await lead('918000000002', 'lost', '2030-01-11T09:00:00Z');
  await handoff('918000000002', '2030-01-11T10:00:00Z');
  await outcome('918000000002', 'no_answer', at('2030-01-11T10:00:00Z', 30));
  await outcome('918000000002', 'lost', '2030-01-13T10:00:00Z', { reason: 'price' });
  await assign('918000000002');

  await lead('918000000003', 'hot', '2030-01-12T09:00:00Z');
  await handoff('918000000003', '2030-01-12T10:00:00Z');
  await assign('918000000003');

  await lead('918000000004', 'new', '2030-01-31T10:00:00Z');
  await handoff('918000000004', at(NOW.toISOString(), -60));

  await lead('918000000005', 'qualified', '2030-01-15T09:00:00Z');

  await lead('918000000006', 'lost', '2029-12-01T09:00:00Z');
  await outcome('918000000006', 'lost', '2030-01-20T10:00:00Z', { reason: 'timing' });
}

test('analytics: funnel, speed to lead, logging rate, lost reasons, per person', async () => {
  const ctx = await setup();
  try {
    const salesId = await ctx.userId('sales');
    await seed(ctx.db, salesId);
    const a = await new Analytics(ctx.db).summary(undefined, { days: 30, now: NOW, names: { joined: 'Booked' } });

    const f = Object.fromEntries(a.funnel.stages.map(s => [s.key, s.count]));
    assert.deepStrictEqual(f, { leads: 5, contacted: 3, qualified: 3, visit_booked: 1, visited: 1, won: 1 });
    assert.strictEqual(a.funnel.stages.find(s => s.key === 'won').label, 'Booked'); // business-type name
    assert.strictEqual(a.funnel.stages.find(s => s.key === 'qualified').fromPrevious, 100);
    assert.deepStrictEqual([a.funnel.revenueInr, a.funnel.lost, a.funnel.winRate], [5000, 1, 20]);

    assert.deepStrictEqual(a.speedToLead, { handoffs: 4, contacted: 2, notContacted: 2, medianMinutes: 16, withinFiveMinutes: 25 });
    assert.deepStrictEqual(a.logging, {
      handoffs: 3, loggedWithin24h: 2, rate: 66.7, salesRecorded: 1, salesRecordedAutomatically: 1, autoRate: 100
    });
    assert.deepStrictEqual(a.lostReasons.map(r => [r.reason, r.count, r.share]), [['price', 1, 50], ['timing', 1, 50]]);

    const sales = a.people.find(p => p.id === salesId);
    assert.deepStrictEqual(
      { firstContacts: sales.firstContacts, medianMinutes: sales.medianMinutes, outcomes: sales.outcomes, won: sales.won,
        revenueInr: sales.revenueInr, lost: sales.lost, assignedHandoffs: sales.assignedHandoffs, loggingRate: sales.loggingRate },
      { firstContacts: 2, medianMinutes: 16, outcomes: 7, won: 1, revenueInr: 5000, lost: 2, assignedHandoffs: 3, loggingRate: 66.7 }
    );
    assert.ok(!a.people.some(p => p.role === 'owner'));

    // Scope: a sales person only counts their own leads.
    const user = await ctx.db.one('SELECT * FROM crm_users WHERE id = $1', [salesId]);
    const mine = await new Analytics(ctx.db).summary(user, { days: 30, now: NOW });
    assert.strictEqual(mine.funnel.leads, 3);
    assert.strictEqual(mine.speedToLead.handoffs, 3);
    assert.deepStrictEqual(mine.people.map(p => p.id), [salesId]);

    // An empty period gives zeros and nulls, not errors.
    const empty = await new Analytics(ctx.db).summary(undefined, { days: 7, now: new Date('2031-06-01T00:00:00Z') });
    assert.strictEqual(empty.funnel.leads, 0);
    assert.strictEqual(empty.funnel.winRate, null);
    assert.strictEqual(empty.speedToLead.medianMinutes, null);
    assert.strictEqual(empty.logging.rate, null);
  } finally { await ctx.cleanup(); }
});

test('Reports page shows the follow-up numbers; sales cannot see reports', async () => {
  const ctx = await setup();
  try {
    const owner = await login(ctx.app, 'owner');
    const page = await owner.agent.get('/reports?days=30');
    assert.strictEqual(page.status, 200);
    for (const text of ['Speed to lead', 'Logging rate', 'Funnel', 'Why leads were lost', 'Sales team (30d)', 'Workload now']) {
      assert.ok(page.text.includes(text), text);
    }
    const manager = await login(ctx.app, 'manager');
    assert.strictEqual((await manager.agent.get('/reports')).status, 200);
    const sales = await login(ctx.app, 'sales');
    assert.strictEqual((await sales.agent.get('/reports')).status, 403);
  } finally { await ctx.cleanup(); }
});

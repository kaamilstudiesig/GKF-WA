const { setup, login } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');

const NEW_LEAD = '918050443322'; // Arjun, status new
const HOT_LEAD = '919845012345'; // Rahul, hot, open hand-off (ready_to_book)

const post = (who, waId, body) => who.agent.post(`/leads/${waId}/outcome`).type('form').send({ _csrf: who.csrf, ...body });
const outcomes = (db, waId) => db.many('SELECT * FROM crm_lead_outcomes WHERE wa_id = $1 ORDER BY id', [waId]);
const openFollowUps = (db, waId) => db.many("SELECT title, due_at, source FROM crm_follow_ups WHERE wa_id = $1 AND status = 'open' ORDER BY id", [waId]);
const lead = (db, waId) => db.one('SELECT status, needs_human FROM leads WHERE wa_id = $1', [waId]);
const hoursFromNow = iso => (new Date(iso).getTime() - Date.now()) / 3600000;

test('the lead page has the one-tap outcome section at #outcome', async () => {
  const ctx = await setup();
  try {
    const owner = await login(ctx.app, 'owner');
    const page = await owner.agent.get(`/leads/${NEW_LEAD}`);
    assert.strictEqual(page.status, 200);
    assert.match(page.text, /id="outcome"/);
    assert.match(page.text, /value="no_answer"/);
    assert.match(page.text, /Joined…/);
    assert.match(page.text, /Monthly \(₹4,040\/month\)/); // plan suggestions from the business config
  } finally { await ctx.cleanup(); }
});

test('no answer keeps the hand-off open and books a retry: 2h, then next day', async () => {
  const ctx = await setup();
  try {
    const owner = await login(ctx.app, 'owner');
    const r = await post(owner, HOT_LEAD, { outcome: 'no_answer' });
    assert.strictEqual(r.status, 302);
    assert.match(r.headers.location, /ok=Saved.*#outcome$/);
    assert.strictEqual((await lead(ctx.db, HOT_LEAD)).needs_human, true);
    let fu = await openFollowUps(ctx.db, HOT_LEAD);
    assert.strictEqual(fu.length, 1);
    assert.strictEqual(fu[0].source, 'outcome');
    assert.ok(Math.abs(hoursFromNow(fu[0].due_at) - 2) < 0.1);

    await post(owner, HOT_LEAD, { outcome: 'no_answer' });
    fu = await openFollowUps(ctx.db, HOT_LEAD);
    assert.strictEqual(fu.length, 1, 'the previous automatic retry is closed');
    assert.match(fu[0].title, /x2/);
    assert.ok(Math.abs(hoursFromNow(fu[0].due_at) - 24) < 0.1);
  } finally { await ctx.cleanup(); }
});

test('speaking to a new lead marks it contacted and resolves the hand-off', async () => {
  const ctx = await setup();
  try {
    const owner = await login(ctx.app, 'owner');
    await post(owner, NEW_LEAD, { outcome: 'called_connected' });
    assert.strictEqual((await lead(ctx.db, NEW_LEAD)).status, 'contacted');
    await post(owner, HOT_LEAD, { outcome: 'whatsapp_sent' });
    const h = await lead(ctx.db, HOT_LEAD);
    assert.strictEqual(h.needs_human, false);
    assert.strictEqual((await ctx.db.one('SELECT status FROM handoffs WHERE wa_id = $1', [HOT_LEAD])).status, 'resolved');
  } finally { await ctx.cleanup(); }
});

test('visit booked needs a time and books a check 2h after the visit', async () => {
  const ctx = await setup();
  try {
    const owner = await login(ctx.app, 'owner');
    const bad = await post(owner, NEW_LEAD, { outcome: 'visit_booked' });
    assert.match(bad.headers.location, /err=/);
    assert.strictEqual((await outcomes(ctx.db, NEW_LEAD)).length, 0);

    const visit = new Date(Date.now() + 48 * 3600 * 1000);
    const local = new Date(visit.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 16); // IST wall time
    await post(owner, NEW_LEAD, { outcome: 'visit_booked', visit_at: local });
    const [o] = await outcomes(ctx.db, NEW_LEAD);
    assert.ok(o.visit_at);
    assert.strictEqual((await lead(ctx.db, NEW_LEAD)).status, 'hot');
    const [fu] = await openFollowUps(ctx.db, NEW_LEAD);
    assert.match(fu.title, /visit/);
    assert.ok(Math.abs(hoursFromNow(fu.due_at) - 50) < 0.2);
  } finally { await ctx.cleanup(); }
});

test('joined records plan and rupees, converts the lead and clears follow-ups', async () => {
  const ctx = await setup();
  try {
    const owner = await login(ctx.app, 'owner');
    await post(owner, HOT_LEAD, { outcome: 'no_answer' });
    const noAmount = await post(owner, HOT_LEAD, { outcome: 'joined', plan: 'Quarterly Elite' });
    assert.match(noAmount.headers.location, /err=/);

    await post(owner, HOT_LEAD, { outcome: 'joined', plan: 'Quarterly Elite (₹7,080/3 months)', amount: '₹7,080' });
    const last = (await outcomes(ctx.db, HOT_LEAD)).pop();
    assert.strictEqual(last.outcome, 'joined');
    assert.strictEqual(last.amount_inr, 7080);
    assert.strictEqual((await lead(ctx.db, HOT_LEAD)).status, 'converted');
    assert.strictEqual((await openFollowUps(ctx.db, HOT_LEAD)).length, 0);

    // A later "visited" never undoes the sale.
    await post(owner, HOT_LEAD, { outcome: 'visited' });
    assert.strictEqual((await lead(ctx.db, HOT_LEAD)).status, 'converted');
    const page = await owner.agent.get(`/leads/${HOT_LEAD}`);
    assert.match(page.text, /₹7,080/);
  } finally { await ctx.cleanup(); }
});

test('lost needs a reason from the list', async () => {
  const ctx = await setup();
  try {
    const owner = await login(ctx.app, 'owner');
    const bad = await post(owner, NEW_LEAD, { outcome: 'lost', lost_reason: 'aliens' });
    assert.match(bad.headers.location, /err=/);
    await post(owner, NEW_LEAD, { outcome: 'lost', lost_reason: 'distance', note: 'Lives in Whitefield' });
    const [o] = await outcomes(ctx.db, NEW_LEAD);
    assert.deepStrictEqual([o.lost_reason, o.note], ['distance', 'Lives in Whitefield']);
    assert.strictEqual((await lead(ctx.db, NEW_LEAD)).status, 'lost');
  } finally { await ctx.cleanup(); }
});

test('sales can only log outcomes on their own leads', async () => {
  const ctx = await setup();
  try {
    const sales = await login(ctx.app, 'sales');
    const r = await post(sales, HOT_LEAD, { outcome: 'called_connected' });
    assert.match(r.headers.location, /err=/);
    assert.strictEqual((await outcomes(ctx.db, HOT_LEAD)).length, 0);

    const owner = await login(ctx.app, 'owner');
    await owner.agent.post(`/leads/${HOT_LEAD}/assign`).type('form').send({ _csrf: owner.csrf, user_id: await ctx.userId('sales') });
    await post(sales, HOT_LEAD, { outcome: 'no_answer' });
    const [o] = await outcomes(ctx.db, HOT_LEAD);
    assert.strictEqual(o.user_id, await ctx.userId('sales'));
    const [fu] = await openFollowUps(ctx.db, HOT_LEAD);
    assert.ok(fu, 'retry follow-up booked for the assigned salesperson');
  } finally { await ctx.cleanup(); }
});

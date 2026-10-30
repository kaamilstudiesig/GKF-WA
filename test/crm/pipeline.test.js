const { setup, login } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');

const NEW_LEAD = '918050443322'; // Arjun, status new
const HOT_LEAD = '919845012345'; // Rahul, hot

/** The board column (by its label) that a lead's card is in, or null. */
function columnOf(html, waId) {
  const sections = html.split('<section ').slice(1);
  for (const s of sections) {
    const label = /aria-label="([^"]+)"/.exec(s);
    if (label && s.includes(`data-wa="${waId}"`)) return label[1];
  }
  return null;
}
const move = (who, waId, body, json = false) => {
  const r = who.agent.post(`/leads/${waId}/stage`).type('form').send({ _csrf: who.csrf, ...body });
  return json ? r.set('Accept', 'application/json') : r;
};

test('the board shows journey stages and puts leads in the right column', async () => {
  const ctx = await setup();
  try {
    const owner = await login(ctx.app, 'owner');
    const page = await owner.agent.get('/pipeline');
    assert.strictEqual(page.status, 200);
    for (const label of ['New', 'Contacted', 'Visit booked', 'Visited', 'Joined', 'Lost']) assert.match(page.text, new RegExp(`aria-label="${label}"`));
    assert.strictEqual(columnOf(page.text, NEW_LEAD), 'New');
    assert.strictEqual(columnOf(page.text, HOT_LEAD), 'Contacted');
    assert.match(page.text, /\/static\/vendor\/sortable\.min\.js/);
    const vendor = await owner.agent.get('/static/vendor/sortable.min.js');
    assert.strictEqual(vendor.status, 200);
    assert.match(vendor.headers['content-type'], /javascript/);
  } finally { await ctx.cleanup(); }
});

test('moving to Contacted is a status change (form post redirects back to the board)', async () => {
  const ctx = await setup();
  try {
    const owner = await login(ctx.app, 'owner');
    const r = await move(owner, NEW_LEAD, { stage: 'contacted' });
    assert.strictEqual(r.status, 302);
    assert.match(r.headers.location, /^\/pipeline\?ok=Moved/);
    assert.strictEqual((await ctx.db.one('SELECT status FROM leads WHERE wa_id = $1', [NEW_LEAD])).status, 'contacted');
  } finally { await ctx.cleanup(); }
});

test('drag-and-drop moves answer JSON; detail stages need their details', async () => {
  const ctx = await setup();
  try {
    const owner = await login(ctx.app, 'owner');
    const ok = await move(owner, HOT_LEAD, { stage: 'visited' }, true);
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual(ok.body, { ok: true, stage: 'visited' });
    assert.strictEqual(columnOf((await owner.agent.get('/pipeline')).text, HOT_LEAD), 'Visited');

    const noDetails = await move(owner, HOT_LEAD, { stage: 'joined' }, true);
    assert.strictEqual(noDetails.status, 400);
    assert.strictEqual(noDetails.body.ok, false);
    assert.match(noDetails.body.error, /plan/i);

    await move(owner, HOT_LEAD, { stage: 'joined', plan: 'Monthly', amount: '4040' }, true);
    const board = (await owner.agent.get('/pipeline')).text;
    assert.strictEqual(columnOf(board, HOT_LEAD), 'Joined');
    assert.match(board, /₹4,040 joined/);
    const unknown = await move(owner, HOT_LEAD, { stage: 'banana' }, true);
    assert.strictEqual(unknown.status, 400);
  } finally { await ctx.cleanup(); }
});

test('a visit booked on the board logs the outcome and shows in Visit booked', async () => {
  const ctx = await setup();
  try {
    const owner = await login(ctx.app, 'owner');
    const local = new Date(Date.now() + (24 + 5.5) * 3600 * 1000).toISOString().slice(0, 16);
    await move(owner, NEW_LEAD, { stage: 'visit_booked', visit_at: local });
    const o = await ctx.db.one("SELECT outcome FROM crm_lead_outcomes WHERE wa_id = $1", [NEW_LEAD]);
    assert.strictEqual(o.outcome, 'visit_booked');
    assert.strictEqual(columnOf((await owner.agent.get('/pipeline')).text, NEW_LEAD), 'Visit booked');
  } finally { await ctx.cleanup(); }
});

test('sales only see and move their own leads on the board', async () => {
  const ctx = await setup();
  try {
    const sales = await login(ctx.app, 'sales');
    assert.strictEqual(columnOf((await sales.agent.get('/pipeline')).text, HOT_LEAD), null);
    const r = await move(sales, HOT_LEAD, { stage: 'contacted' }, true);
    assert.strictEqual(r.status, 404);
  } finally { await ctx.cleanup(); }
});

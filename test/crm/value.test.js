const { setup, login } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const gymConfig = require('../../src/config/gymConfig');
const { Analytics } = require('../../crm/src/analytics');
const { ValueReport } = require('../../crm/src/valueReport');

// A fixed month far from the demo data, so only the rows below count.
const NOW = new Date('2030-01-31T12:00:00Z');
const at = (iso, plusMin = 0) => new Date(new Date(iso).getTime() + plusMin * 60000).toISOString();

async function seed(db, salesId) {
  const lead = (waId, status, first, source = 'whatsapp_inbound', metadata = {}) => db.query(
    'INSERT INTO leads (wa_id, status, first_contact_at, source, metadata) VALUES ($1, $2, $3, $4, $5::jsonb)', [waId, status, first, source, JSON.stringify(metadata)]);
  const out = (key, waId, metadata, status, created) => db.query(
    "INSERT INTO outbound_messages (dedup_key, wa_id, text, metadata, status, created_at) VALUES ($1, $2, 'x', $3::jsonb, $4, $5)",
    [key, waId, JSON.stringify(metadata), status, created]);

  // This period (2030-01-01 .. 01-31): a sale from an ad, a form lead, a qualified lead.
  await lead('918300000001', 'converted', '2030-01-10T09:00:00Z', 'instagram_ad', { referral: { source_id: '777', headline: 'January offer', platform: 'instagram' } });
  await db.query("INSERT INTO handoffs (wa_id, reason, status, created_at) VALUES ('918300000001', 'ready_to_book', 'assigned', '2030-01-10T10:00:00Z')");
  await out('crm:v1', '918300000001', { source: 'crm', user_id: salesId }, 'sent', at('2030-01-10T10:00:00Z', 3)); // staff reply
  await out('bot:v1', '918300000001', {}, 'sent', at('2030-01-10T09:00:00Z', 1)); // the assistant's reply
  await out('bot:v2', '918300000001', {}, 'failed', at('2030-01-10T09:00:00Z', 2)); // not sent: not counted
  await out('alert:v1', '919999999999', { staff_alert: { event: 'handoff' }, template: { name: 'staff_lead_alert' } }, 'sent', '2030-01-10T10:00:01Z'); // to staff
  await db.query(`INSERT INTO crm_lead_outcomes (wa_id, user_id, outcome, amount_inr, created_at, meta_status)
    VALUES ('918300000001', $1, 'joined', 5000, '2030-01-12T11:00:00Z', 'sent')`, [salesId]);

  await lead('918300000002', 'new', '2030-01-15T09:00:00Z', 'intake_website');
  await out('intake:v1', '918300000002', { source: 'intake', template: { name: 'lead_welcome' } }, 'sent', '2030-01-15T09:00:05Z'); // R16 welcome

  await lead('918300000003', 'qualified', '2030-01-20T09:00:00Z');

  // The period before (2029-12-02 .. 2030-01-01): one lead.
  await lead('918300000009', 'new', '2029-12-15T09:00:00Z');
}

test('R18 value numbers: this period against the one before, and what the system did', async () => {
  const ctx = await setup();
  try {
    await seed(ctx.db, await ctx.userId('sales'));
    const analytics = new Analytics(ctx.db);
    const v = await new ValueReport(ctx.db, analytics).build(undefined, { days: 30, now: NOW });
    const c = v.current;
    assert.deepStrictEqual([c.leads, c.qualified, c.sales, c.revenue], [3, 2, 1, 5000]); // qualified: the sale and the qualified lead
    assert.deepStrictEqual(c.work, { botReplies: 1, welcomes: 1, formLeads: 1, salesToMeta: 1 });
    assert.deepStrictEqual([c.handoffs, c.handoffsTimed], [1, 1]);
    assert.strictEqual(typeof c.medianMinutes, 'number'); // the staff reply after the hand-off was timed
    assert.strictEqual(c.bestAd.adId, '777');
    assert.strictEqual(c.costPerCustomer, null); // no ad spend yet (K5)
    assert.strictEqual(v.previous.leads, 1);
    assert.strictEqual(v.changes.leads, 200); // 3 vs 1
    assert.strictEqual(v.previous.revenue, 0);
    assert.strictEqual(v.changes.revenue, null); // no % change from zero

    // With ad spend (K5): cost per customer = spend / sales.
    analytics.adSpend = async () => new Map([['777', { spend: 1200 }]]);
    const withSpend = await new ValueReport(ctx.db, analytics).build(undefined, { days: 30, now: NOW });
    assert.deepStrictEqual([withSpend.current.spend, withSpend.current.costPerCustomer], [1200, 1200]);

    // An empty period: zeros and dashes, no errors.
    const empty = await new ValueReport(ctx.db, new Analytics(ctx.db)).build(undefined, { days: 7, now: new Date('2031-06-01T00:00:00Z') });
    assert.deepStrictEqual([empty.current.leads, empty.current.work.botReplies, empty.current.bestAd, empty.changes.leads], [0, 0, null, null]);
  } finally { await ctx.cleanup(); }
});

test('R18 value page: owners and managers, print button and print colours, money in the business currency', async () => {
  const ctx = await setup();
  try {
    const owner = await login(ctx.app, 'owner');
    let page = await owner.agent.get('/value?days=30');
    assert.strictEqual(page.status, 200);
    assert.match(page.text, /What your leads turned into/);
    assert.match(page.text, /data-print>/); // "Save as PDF" opens the print dialog (app.js; no inline script)
    assert.match(page.text, /print:\[--color-base-content:#111827\]/); // readable on paper in a dark theme
    assert.match(page.text, /What the system did/);
    assert.match(page.text, /shown once ad spend is imported/);
    assert.match(page.text, /href="\/value"/); // in the menu
    assert.match(page.text, /class="[^"]*print:hidden[^"]*"/);

    gymConfig.setProfile({ ...gymConfig.DEFAULT_PROFILE, type: 'realestate', currency: 'AED' });
    page = await owner.agent.get('/value');
    assert.match(page.text, />AED \d/);
    gymConfig.resetToDefault();

    const manager = await login(ctx.app, 'manager');
    const mp = await manager.agent.get('/value');
    assert.strictEqual(mp.status, 200);
    assert.match(mp.text, /Your team and unassigned leads only/);
    const sales = await login(ctx.app, 'sales');
    assert.strictEqual((await sales.agent.get('/value')).status, 403);
  } finally { gymConfig.resetToDefault(); await ctx.cleanup(); }
});

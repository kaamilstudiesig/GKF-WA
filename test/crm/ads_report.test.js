const { setup, login } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const { Analytics, gradeFor, GRADE_MIN_LEADS } = require('../../crm/src/analytics');

// A fixed month far from the demo data, so only the rows below count.
const NOW = new Date('2030-01-31T12:00:00Z');
const at = (iso, plusMin = 0) => new Date(new Date(iso).getTime() + plusMin * 60000).toISOString();
const ad = (id, headline, platform = 'instagram') => ({ referral: { source_id: id, headline, platform, source_type: 'ad' } });

/**
 * Ad A (2 leads): one booked a visit and paid ₹5,000 (CRM reply 4 min after the hand-off), one qualified.
 * Ad B (1 lead): lost after "No answer". Ad C (1 lead, headline that looks like a formula): new.
 * One lead with no ad, converted for ₹2,000. Only ad A's leads are assigned to the sales person.
 */
async function seed(db, salesId) {
  const lead = (waId, status, first, metadata = {}) => db.query('INSERT INTO leads (wa_id, status, first_contact_at, metadata) VALUES ($1, $2, $3, $4::jsonb)',
    [waId, status, first, JSON.stringify(metadata)]);
  const outcome = (waId, outcome, created, amount = null) => db.query(`INSERT INTO crm_lead_outcomes (wa_id, user_id, outcome, amount_inr, created_at)
    VALUES ($1, $2, $3, $4, $5)`, [waId, salesId, outcome, amount, created]);
  const assign = waId => db.query("INSERT INTO crm_lead_assignments (wa_id, user_id, assigned_at) VALUES ($1, $2, '2030-01-01T00:00:00Z')", [waId, salesId]);

  await lead('918200000001', 'converted', '2030-01-10T09:00:00Z', ad('111', 'Free trial week'));
  await db.query("INSERT INTO handoffs (wa_id, reason, status, created_at) VALUES ('918200000001', 'ready_to_book', 'assigned', '2030-01-10T10:00:00Z')");
  await db.query(`INSERT INTO outbound_messages (dedup_key, wa_id, text, metadata, created_at) VALUES ('crm:ad1', '918200000001', 'Hi', $1::jsonb, $2)`,
    [JSON.stringify({ source: 'crm', user_id: salesId }), at('2030-01-10T10:00:00Z', 4)]);
  await outcome('918200000001', 'visit_booked', at('2030-01-10T10:00:00Z', 5));
  await outcome('918200000001', 'joined', '2030-01-12T11:00:00Z', 5000);
  await assign('918200000001');

  await lead('918200000002', 'qualified', '2030-01-11T09:00:00Z', ad('111', 'Free trial week'));
  await assign('918200000002');

  await lead('918200000003', 'lost', '2030-01-12T09:00:00Z', ad('222', 'Summer offer', 'facebook'));
  await outcome('918200000003', 'no_answer', '2030-01-12T12:00:00Z');
  await outcome('918200000003', 'lost', '2030-01-13T12:00:00Z');

  await lead('918200000004', 'new', '2030-01-20T09:00:00Z', ad('333', '=HYPERLINK("http://x")'));

  await lead('918200000005', 'converted', '2030-01-15T09:00:00Z');
  await outcome('918200000005', 'joined', '2030-01-16T09:00:00Z', 2000);
}

test('R6 by ad: funnel, revenue, speed and win rate per ad; no-ad leads last; same totals as the funnel', async () => {
  const ctx = await setup();
  try {
    const salesId = await ctx.userId('sales');
    await seed(ctx.db, salesId);
    const analytics = new Analytics(ctx.db);
    const range = await analytics.range({ days: 30, now: NOW });
    const rows = await analytics.byAd(undefined, range);

    assert.deepStrictEqual(rows.map(r => r.adId), ['111', '222', '333', null]); // revenue first, then leads; no ad last
    const a = rows[0];
    assert.deepStrictEqual(
      { headline: a.headline, platform: a.platform, leads: a.leads, contacted: a.contacted, qualified: a.qualified, visitBooked: a.visitBooked,
        won: a.won, revenueInr: a.revenueInr, qualifiedRate: a.qualifiedRate, winRate: a.winRate },
      { headline: 'Free trial week', platform: 'instagram', leads: 2, contacted: 2, qualified: 2, visitBooked: 1, won: 1, revenueInr: 5000, qualifiedRate: 100, winRate: 50 }
    );
    assert.strictEqual(typeof a.medianMinutes, 'number'); // its one hand-off was contacted
    assert.strictEqual(a.grade, null); // too few leads to grade
    assert.deepStrictEqual([a.spend, a.costPerSale, a.roas, a.campaignName], [null, null, null, null]); // no ad spend yet (K5)

    const b = rows[1];
    assert.deepStrictEqual([b.leads, b.qualified, b.won, b.revenueInr, b.winRate, b.medianMinutes], [1, 0, 0, 0, 0, null]);
    const none = rows[3];
    assert.deepStrictEqual([none.leads, none.won, none.revenueInr, none.grade], [1, 1, 2000, null]);

    // Rows add up to the funnel (same rules, same leads).
    const funnel = await analytics.funnel(undefined, range);
    assert.strictEqual(rows.reduce((s, r) => s + r.leads, 0), funnel.leads);
    assert.strictEqual(rows.reduce((s, r) => s + r.won, 0), funnel.won);
    assert.strictEqual(rows.reduce((s, r) => s + r.revenueInr, 0), funnel.revenueInr);

    // Scope: a sales person sees only the ads their own leads came from.
    const user = await ctx.db.one('SELECT * FROM crm_users WHERE id = $1', [salesId]);
    assert.deepStrictEqual((await analytics.byAd(user, range)).map(r => [r.adId, r.leads]), [['111', 2]]);

    // An empty period is an empty list, not an error.
    assert.deepStrictEqual(await analytics.byAd(undefined, await analytics.range({ days: 7, now: new Date('2031-06-01T00:00:00Z') })), []);
  } finally { await ctx.cleanup(); }
});

test('R6 by ad: spend from the ad spend import gives cost per sale, ROAS and campaign', async () => {
  const ctx = await setup();
  try {
    await seed(ctx.db, await ctx.userId('sales'));
    const analytics = new Analytics(ctx.db);
    analytics.adSpend = async () => new Map([['111', { spend: 2000, campaignId: 'c1', campaignName: 'January trials' }], ['222', { spend: 500 }]]);
    const rows = await analytics.byAd(undefined, await analytics.range({ days: 30, now: NOW }));
    const a = rows.find(r => r.adId === '111'); const b = rows.find(r => r.adId === '222');
    assert.deepStrictEqual([a.spend, a.costPerSale, a.roas, a.campaignName], [2000, 2000, 2.5, 'January trials']);
    assert.deepStrictEqual([b.spend, b.costPerSale, b.roas], [500, null, 0]); // no sale: no cost per sale; ROAS 0
    assert.strictEqual(rows.find(r => r.adId === null).spend, null);
  } finally { await ctx.cleanup(); }
});

test('R6 grade: only from enough leads, by the share that reached Qualified', () => {
  assert.strictEqual(gradeFor(GRADE_MIN_LEADS - 1, 90), null);
  assert.strictEqual(gradeFor(GRADE_MIN_LEADS, 50), 'A');
  assert.strictEqual(gradeFor(20, 30), 'B');
  assert.strictEqual(gradeFor(20, 15), 'C');
  assert.strictEqual(gradeFor(20, 14.9), 'D');
  assert.strictEqual(gradeFor(20, null), null);
});

test('R6 Reports page: "By ad" section, sort by leads, CSV with safe cells, owners and managers only', async () => {
  const ctx = await setup();
  try {
    const now = new Date();
    const recent = h => new Date(now.getTime() - h * 3600000).toISOString();
    const db = ctx.db;
    await db.query('INSERT INTO leads (wa_id, status, first_contact_at, metadata) VALUES ($1, $2, $3, $4::jsonb)',
      ['918200000011', 'converted', recent(30), JSON.stringify(ad('901', 'Big win ad'))]);
    await db.query("INSERT INTO crm_lead_outcomes (wa_id, user_id, outcome, amount_inr, created_at) VALUES ('918200000011', $1, 'joined', 7000, $2)",
      [await ctx.userId('sales'), recent(20)]);
    for (const n of [12, 13, 14]) {
      await db.query('INSERT INTO leads (wa_id, status, first_contact_at, metadata) VALUES ($1, $2, $3, $4::jsonb)',
        [`9182000000${n}`, 'new', recent(10), JSON.stringify(ad('902', '=HYPERLINK("http://evil")'))]);
    }

    const owner = await login(ctx.app, 'owner');
    const page = (await owner.agent.get('/reports?days=7')).text;
    assert.match(page, /<h2>By ad \(7d\)<\/h2>/);
    assert.match(page, /Big win ad/);
    assert.match(page, /Not from an ad/);
    assert.match(page, /appear once ad spend is imported/);
    assert.ok(page.indexOf('Big win ad') < page.indexOf('=HYPERLINK'), 'revenue first');
    assert.doesNotMatch(page, /<h2 class="mb-3">Ads \(/); // the old table is gone

    const byLeads = (await owner.agent.get('/reports?days=7&adsort=leads')).text;
    assert.ok(byLeads.indexOf('=HYPERLINK') < byLeads.indexOf('Big win ad'), 'leads first');
    assert.ok(byLeads.lastIndexOf('Not from an ad') > byLeads.indexOf('Big win ad'), 'no-ad row stays last');

    const csv = await owner.agent.get('/reports/ads.csv?days=7');
    assert.strictEqual(csv.status, 200);
    assert.match(csv.headers['content-type'], /text\/csv/);
    assert.match(csv.headers['content-disposition'], /-ads-7d-/);
    const lines = csv.text.split('\n');
    assert.match(lines[0], /^ad_id,platform,headline,campaign,leads,qualified,/);
    assert.ok(lines.some(l => l.startsWith('901,instagram,Big win ad,,1,') && l.includes(',7000,')));
    assert.ok(lines.some(l => l.includes(`"'=HYPERLINK(""http://evil"")"`)), 'formula made inert');
    assert.ok(lines.some(l => l.includes('Not from an ad')));

    const manager = await login(ctx.app, 'manager');
    assert.strictEqual((await manager.agent.get('/reports/ads.csv?days=7')).status, 200);
    const sales = await login(ctx.app, 'sales');
    assert.strictEqual((await sales.agent.get('/reports/ads.csv')).status, 403);
  } finally { await ctx.cleanup(); }
});

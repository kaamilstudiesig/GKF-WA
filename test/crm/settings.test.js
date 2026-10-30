const { setup, login } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const gymConfig = require('../../src/config/gymConfig');

const form = (csrf, overrides = {}) => ({
  _csrf: csrf, name: 'Goldkraft Fitness', type: 'gym', facility: 'Big gym', area: 'J.P. Nagar', address: 'ITI Layout, Bengaluru',
  parking: 'Free parking', latitude: '', longitude: '', hours: 'Mon-Sat 5 AM - 10 PM\nSunday 8 AM - 2 PM',
  programs: 'CrossFit\nYoga', selling_points: 'Fat loss: conditioning batches',
  plan_name: ['Monthly', 'Quarterly', ''], plan_price: ['₹4,500/month', '₹7,500/3 months', ''], plan_details: ['All access', '', ''],
  policy_name: ['Trial', ''], policy_text: ['Book a free trial', ''],
  voice: 'Friendly', fallback_error: 'We will get back to you.', fallback_media: 'Got your file.', ...overrides
});

test('only the owner sees Business settings', async () => {
  const ctx = await setup();
  try {
    const owner = await login(ctx.app, 'owner');
    const page = await owner.agent.get('/settings');
    assert.strictEqual(page.status, 200);
    assert.match(page.text, /value="Goldkraft Fitness"/);
    assert.match(page.text, /What the assistant is told/);
    const sales = await login(ctx.app, 'sales');
    assert.strictEqual((await sales.agent.get('/settings')).status, 403);
    assert.strictEqual((await sales.agent.post('/settings').type('form').send(form(sales.csrf))).status, 403);
  } finally { await ctx.cleanup(); gymConfig.resetToDefault(); }
});

test('saving updates the database and what the assistant says', async () => {
  const ctx = await setup();
  try {
    const owner = await login(ctx.app, 'owner');
    const r = await owner.agent.post('/settings').type('form').send(form(owner.csrf));
    assert.strictEqual(r.status, 302);
    assert.match(r.headers.location, /^\/settings\?ok=Saved/);
    const row = await ctx.db.one('SELECT profile, updated_by FROM business_profile WHERE id = 1');
    assert.deepStrictEqual(row.profile.plans.map(p => p.price), ['₹4,500/month', '₹7,500/3 months']);
    assert.deepStrictEqual(row.profile.policies, [{ name: 'Trial', text: 'Book a free trial' }]);
    assert.strictEqual(row.updated_by, 'owner@goldkraftfitness.com');
    assert.match(gymConfig.getSystemPrompt(), /Monthly: ₹4,500\/month \(All access\)/);
    // The lead page offers the new plans when logging "Joined".
    const lead = await owner.agent.get('/leads/918050443322');
    assert.match(lead.text, /Monthly \(₹4,500\/month\)/);
  } finally { await ctx.cleanup(); gymConfig.resetToDefault(); }
});

test('a bad form shows the problem and keeps what was typed', async () => {
  const ctx = await setup();
  try {
    const owner = await login(ctx.app, 'owner');
    const r = await owner.agent.post('/settings').type('form').send(form(owner.csrf, { plan_price: ['', '', ''], name: 'New Name' }));
    assert.strictEqual(r.status, 400);
    assert.match(r.text, /Add at least one plan/);
    assert.match(r.text, /value="New Name"/);
    assert.strictEqual(gymConfig.gymName, 'Goldkraft Fitness');
  } finally { await ctx.cleanup(); gymConfig.resetToDefault(); }
});

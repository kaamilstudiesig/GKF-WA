// K26: the lead count on Business settings (owner) and the dashboard (owners and managers, not sales).
const { setup, login } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const tenancy = require('../../src/tenancy/context');
const registry = require('../../src/tenancy/registry');
const leadUsage = require('../../src/services/leadUsage');

test('owners and managers see "Leads this month"; sales do not; 80% turns amber', async () => {
  const ctx = await setup();
  try {
    await registry.update(1, { settings: { leadMonthlyLimit: '5' } });
    await tenancy.run(1, async () => {
      for (const p of ['919800000001', '919800000002', '919800000003', '919800000004']) await leadUsage.record({ wa_id: p, phone: p });
    });

    const owner = await login(ctx.app, 'owner');
    const settings = await owner.agent.get('/settings');
    assert.strictEqual(settings.status, 200);
    assert.match(settings.text, /Leads this month/);
    assert.match(settings.text, /text-warning">4<span[^>]*> of 5</);
    assert.match(settings.text, /billed as overage/);
    const dash = await owner.agent.get('/');
    assert.match(dash.text, /Leads this month/);
    assert.match(dash.text, /lg:grid-cols-8/);

    const manager = await login(ctx.app, 'manager');
    assert.match((await manager.agent.get('/')).text, /Leads this month/);

    const sales = await login(ctx.app, 'sales');
    const salesDash = await sales.agent.get('/');
    assert.strictEqual(salesDash.status, 200);
    assert.doesNotMatch(salesDash.text, /Leads this month/);
  } finally {
    await registry.update(1, { settings: { leadMonthlyLimit: '' } });
    await ctx.cleanup();
  }
});

test('with no limit, the count shows alone', async () => {
  const ctx = await setup();
  try {
    await tenancy.run(1, () => leadUsage.record({ wa_id: '919800000009', phone: '919800000009' }));
    const owner = await login(ctx.app, 'owner');
    const page = await owner.agent.get('/settings');
    assert.match(page.text, /tabular-nums ">1<\/div>/);
    assert.doesNotMatch(page.text, / of \d+<\/span>/);
  } finally { await ctx.cleanup(); }
});

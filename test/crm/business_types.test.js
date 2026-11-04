const { setup, login } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const gymConfig = require('../../src/config/gymConfig');
const router = require('../../src/services/deterministicRouter');
const { initials } = require('../../crm/src/branding');

const HOT_LEAD = '919845012345';

test('real estate: site visit wording, buttons that route back, projects in the prompt', () => {
  try {
    gymConfig.setProfile({ ...gymConfig.profile, type: 'realestate' });
    const hi = router.routeMessage('hi', {}, {});
    assert.deepStrictEqual(hi.buttons.map(b => b.title), ['Prices', 'Book site visit', 'Location']);
    assert.strictEqual(router.routeMessage('Book site visit', {}, {}).intent, 'trial');
    assert.strictEqual(router.routeMessage('Talk to advisor', {}, {}).intent, 'human');
    assert.match(router.routeMessage('book site visit', {}, {}).replyText, /site visit.*property advisor/s);
    const prompt = gymConfig.getSystemPrompt();
    assert.match(prompt, /- Projects and properties:/);
    assert.match(prompt, /- Unit types and prices:/);
    assert.doesNotMatch(prompt, /coach|trial|fat loss/i);
  } finally { gymConfig.resetToDefault(); }
});

test('the CRM names outcomes and stages for the business type', async () => {
  const ctx = await setup();
  try {
    const owner = await login(ctx.app, 'owner');
    assert.match((await owner.agent.get('/pipeline')).text, /aria-label="Joined"/); // gym unchanged
    gymConfig.setProfile({ ...gymConfig.profile, type: 'realestate' });
    const board = (await owner.agent.get('/pipeline')).text;
    for (const name of ['Site visit booked', 'Site visited', 'Booked']) assert.match(board, new RegExp(`aria-label="${name}"`));
    assert.match((await owner.agent.get(`/leads/${HOT_LEAD}`)).text, /Booked…/);
    assert.match((await owner.agent.get('/settings')).text, /Projects and properties/);

    // A home sale can be far above a gym plan.
    const r = await owner.agent.post(`/leads/${HOT_LEAD}/outcome`).type('form')
      .send({ _csrf: owner.csrf, outcome: 'joined', plan: '3 BHK', amount: '1,25,00,000' });
    assert.match(r.headers.location, /Saved.*Booked/);
    const o = await ctx.db.one('SELECT amount_inr FROM crm_lead_outcomes WHERE wa_id = $1', [HOT_LEAD]);
    assert.strictEqual(Number(o.amount_inr), 12500000);
  } finally { gymConfig.resetToDefault(); await ctx.cleanup(); }
});

test('logo letters skip punctuation', () => {
  assert.strictEqual(initials('(Demo) Realty'), 'DR');
  assert.strictEqual(initials('Goldkraft Fitness'), 'GF');
});

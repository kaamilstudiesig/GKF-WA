const { setup, login } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const gymConfig = require('../../src/config/gymConfig');
const { VERTICALS, lostReasonsFor } = require('../../src/config/verticals');
const { LOST_REASONS } = require('../../crm/src/constants');
const { Analytics } = require('../../crm/src/analytics');

const LEAD = '919845012345';

test('lost reasons: same keys for every business type, each in its own words', () => {
  for (const type of Object.keys(VERTICALS)) {
    assert.deepStrictEqual(Object.keys(lostReasonsFor(type)), Object.keys(LOST_REASONS), type); // keys never change
    for (const k of Object.keys(VERTICALS[type].lostReasons || {})) assert.ok(k in LOST_REASONS, `${type}: unknown key ${k}`);
  }
  assert.strictEqual(lostReasonsFor('gym').joined_elsewhere, 'Joined another gym');
  assert.strictEqual(lostReasonsFor('realestate').joined_elsewhere, 'Bought elsewhere');
  assert.strictEqual(lostReasonsFor('realestate').price, 'Budget');
  assert.strictEqual(lostReasonsFor('services').joined_elsewhere, 'Went with someone else'); // neutral default
  assert.ok(!/gym/i.test(Object.values(lostReasonsFor('realestate')).join(' ')));
});

test('lead page and reports use the business type\'s wording', async () => {
  const ctx = await setup();
  try {
    const owner = await login(ctx.app, 'owner');
    assert.match((await owner.agent.get(`/leads/${LEAD}`)).text, /<option value="joined_elsewhere">Joined another gym<\/option>/); // GKF is a gym

    gymConfig.setProfile({ ...gymConfig.DEFAULT_PROFILE, type: 'realestate' });
    const page = (await owner.agent.get(`/leads/${LEAD}`)).text;
    assert.match(page, /<option value="joined_elsewhere">Bought elsewhere<\/option>/);
    assert.match(page, /<option value="price">Budget<\/option>/);
    assert.doesNotMatch(page, /Joined another gym/);
    assert.match((await owner.agent.get('/pipeline')).text, /<option value="joined_elsewhere">Bought elsewhere<\/option>/);

    // A logged lost reason shows in the new words in the history and in reports.
    await owner.agent.post(`/leads/${LEAD}/outcome`).type('form').send({ _csrf: owner.csrf, outcome: 'lost', lost_reason: 'joined_elsewhere' });
    assert.match((await owner.agent.get(`/leads/${LEAD}`)).text, /· Bought elsewhere/);
    const a = await new Analytics(ctx.db).summary(undefined, { days: 7, lostNames: lostReasonsFor('realestate') });
    assert.deepStrictEqual(a.lostReasons.map(r => [r.reason, r.label]), [['joined_elsewhere', 'Bought elsewhere']]);
    assert.match((await owner.agent.get('/reports?days=7')).text, /Bought elsewhere/);
  } finally { await ctx.cleanup(); gymConfig.resetToDefault(); }
});

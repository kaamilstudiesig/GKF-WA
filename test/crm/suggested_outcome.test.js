const { setup, login } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const suggestedOutcome = require('../../src/services/suggestedOutcome');
const { AIService } = require('../../src/services/aiService');

const HOT_LEAD = '919845012345'; // Rahul, hot, owner can see

const suggest = (db, waId, s) => db.query(
  `UPDATE leads SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('suggested_outcome', $2::jsonb) WHERE wa_id = $1`,
  [waId, JSON.stringify({ label: s.type, ...s })]);

test('the AI answer can carry an outcome; only clear, valid ones are kept', () => {
  const ai = new AIService();
  const parsed = ai.parseStructured(JSON.stringify({ reply: 'Welcome aboard!', lead: {}, notify_staff: null,
    outcome: { type: 'joined', plan: 'Annual Pinnacle', amount_inr: '₹14,000', evidence: 'paid for annual today' } }));
  assert.deepStrictEqual({ type: parsed.suggestion.type, plan: parsed.suggestion.plan, amount: parsed.suggestion.amount_inr },
    { type: 'joined', plan: 'Annual Pinnacle', amount: 14000 });
  assert.strictEqual(ai.parseStructured(JSON.stringify({ reply: 'ok', outcome: null })).suggestion, null);
  assert.strictEqual(suggestedOutcome.normalize({ type: 'converted' }), null);
  assert.strictEqual(suggestedOutcome.normalize({ type: 'lost', lost_reason: 'made-up' }).lost_reason, 'other');
  assert.strictEqual(suggestedOutcome.normalize({ type: 'joined', amount_inr: -5 }).amount_inr, null);
});

test('staff see the suggestion and confirm a sale in one tap', async () => {
  const ctx = await setup();
  try {
    await suggest(ctx.db, HOT_LEAD, { type: 'joined', plan: 'Monthly', amount_inr: 4040, evidence: 'paid just now' });
    const owner = await login(ctx.app, 'owner');
    const page = await owner.agent.get(`/leads/${HOT_LEAD}`);
    assert.match(page.text, /aria-label="Suggested outcome"/);
    assert.match(page.text, /paid just now/);
    await owner.agent.post(`/leads/${HOT_LEAD}/outcome`).type('form')
      .send({ _csrf: owner.csrf, outcome: 'joined', plan: 'Monthly', amount: '4040', note: 'Confirmed from the chat' });
    const o = await ctx.db.one('SELECT outcome, amount_inr FROM crm_lead_outcomes WHERE wa_id = $1', [HOT_LEAD]);
    assert.deepStrictEqual({ outcome: o.outcome, amount: Number(o.amount_inr) }, { outcome: 'joined', amount: 4040 });
    const lead = await ctx.db.one('SELECT metadata FROM leads WHERE wa_id = $1', [HOT_LEAD]);
    const meta = typeof lead.metadata === 'string' ? JSON.parse(lead.metadata) : lead.metadata;
    assert.strictEqual(meta.suggested_outcome, undefined);
  } finally { await ctx.cleanup(); }
});

test('staff can dismiss a suggestion; visit times still need a person', async () => {
  const ctx = await setup();
  try {
    await suggest(ctx.db, HOT_LEAD, { type: 'visit_booked', when: 'Saturday 7am', evidence: 'see you saturday 7' });
    const owner = await login(ctx.app, 'owner');
    const page = await owner.agent.get(`/leads/${HOT_LEAD}`);
    assert.match(page.text, /Add details/);
    const r = await owner.agent.post(`/leads/${HOT_LEAD}/suggestion/dismiss`).type('form').send({ _csrf: owner.csrf });
    assert.strictEqual(r.status, 302);
    assert.doesNotMatch((await owner.agent.get(`/leads/${HOT_LEAD}`)).text, /aria-label="Suggested outcome"/);
  } finally { await ctx.cleanup(); }
});

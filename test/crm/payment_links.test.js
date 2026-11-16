const { setup, login } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const request = require('supertest');
const razorpay = require('../../src/services/razorpay');

const HOT_LEAD = '919845012345';
const KEYS = { RAZORPAY_KEY_ID: 'rzp_test_x', RAZORPAY_KEY_SECRET: 'secret', RAZORPAY_WEBHOOK_SECRET: 'whsec' };

function withRazorpay(fn) {
  return async () => {
    const saved = { ...process.env };
    const orig = razorpay.createLink;
    Object.assign(process.env, KEYS);
    const created = [];
    razorpay.createLink = async args => { created.push(args); return { id: `plink_${created.length}`, short_url: `https://rzp.io/i/test${created.length}` }; };
    try { await fn(created); } finally {
      razorpay.createLink = orig;
      for (const k of Object.keys(KEYS)) { if (k in saved) process.env[k] = saved[k]; else delete process.env[k]; }
    }
  };
}

const paidEvent = (linkId, paise) => JSON.stringify({ event: 'payment_link.paid', payload: {
  payment_link: { entity: { id: linkId, amount_paid: paise } }, payment: { entity: { id: 'pay_123', amount: paise } } } });
const sign = body => crypto.createHmac('sha256', KEYS.RAZORPAY_WEBHOOK_SECRET).update(body).digest('hex');

test('payment links are hidden and refused until Razorpay is set up', async () => {
  const ctx = await setup();
  try {
    const owner = await login(ctx.app, 'owner');
    assert.doesNotMatch((await owner.agent.get(`/leads/${HOT_LEAD}`)).text, /Send payment link/);
    const r = await owner.agent.post(`/leads/${HOT_LEAD}/payment-link`).type('form').send({ _csrf: owner.csrf, plan: 'Monthly', amount: '4040' });
    assert.strictEqual(r.status, 503);
  } finally { await ctx.cleanup(); }
});

test('staff send a link; a signed paid webhook logs Joined + rupees once', withRazorpay(async created => {
  const ctx = await setup();
  try {
    const owner = await login(ctx.app, 'owner');
    assert.match((await owner.agent.get(`/leads/${HOT_LEAD}`)).text, /Send payment link/);
    await owner.agent.post(`/leads/${HOT_LEAD}/payment-link`).type('form').send({ _csrf: owner.csrf, plan: 'Monthly', amount: '4,040' });
    assert.strictEqual(created[0].amountInr, 4040);
    const link = await ctx.db.one('SELECT razorpay_id, status FROM crm_payment_links WHERE wa_id = $1', [HOT_LEAD]);
    assert.strictEqual(link.status, 'created');

    const bot = request(require('../../src/app')());
    const body = paidEvent(link.razorpay_id, 404000);
    const bad = await bot.post('/razorpay/webhook').set('Content-Type', 'application/json').set('x-razorpay-signature', 'nope').send(body);
    assert.strictEqual(bad.status, 401);
    for (let i = 0; i < 2; i++) { // Razorpay retries: only one outcome
      const ok = await bot.post('/razorpay/webhook').set('Content-Type', 'application/json').set('x-razorpay-signature', sign(body)).send(body);
      assert.strictEqual(ok.status, 200);
    }
    const rows = await ctx.db.query("SELECT outcome, plan, amount_inr FROM crm_lead_outcomes WHERE wa_id = $1", [HOT_LEAD]);
    assert.strictEqual(rows.rows.length, 1);
    assert.deepStrictEqual({ ...rows.rows[0], amount_inr: Number(rows.rows[0].amount_inr) }, { outcome: 'joined', plan: 'Monthly', amount_inr: 4040 });
    assert.strictEqual((await ctx.db.one('SELECT status FROM leads WHERE wa_id = $1', [HOT_LEAD])).status, 'converted');
  } finally { await ctx.cleanup(); }
}));

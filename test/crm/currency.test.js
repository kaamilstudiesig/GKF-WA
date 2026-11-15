const { setup, login } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const gymConfig = require('../../src/config/gymConfig');
const businessProfile = require('../../src/services/businessProfile');
const razorpay = require('../../src/services/razorpay');
const { money, parseAmount, currencyCode, currencyOptions } = require('../../src/config/currency');
const { labelsFor } = require('../../src/config/verticals');
const { profile: demoProfile } = require('../../scripts/demo/realestate');

const LEAD = '919845012345'; // Rahul in the demo data
const KEYS = { RAZORPAY_KEY_ID: 'rzp_test_x', RAZORPAY_KEY_SECRET: 'secret', RAZORPAY_WEBHOOK_SECRET: 'whsec' };
const asDubai = () => gymConfig.setProfile({ ...gymConfig.DEFAULT_PROFILE, type: 'realestate', currency: 'AED' });

test('R15 money: each currency, Indian grouping only for INR', () => {
  assert.strictEqual(money(7080), '₹7,080');
  assert.strictEqual(money(950000, 'INR'), '₹9,50,000');
  assert.strictEqual(money(950000, 'AED'), 'AED 950,000');
  assert.strictEqual(money(950000, 'SAR'), 'SAR 950,000');
  assert.strictEqual(money(950000, 'USD'), '$950,000');
  assert.strictEqual(money(null, 'AED'), 'AED 0');
  assert.strictEqual(money(1200, 'xyz'), '₹1,200'); // unknown codes are INR
  assert.deepStrictEqual(currencyOptions().map(c => c.code), ['INR', 'AED', 'SAR', 'USD']);
  assert.deepStrictEqual(['AED', 'aed', ' usd ', 'EUR', '', null].map(currencyCode), ['AED', 'AED', 'USD', 'INR', 'INR', 'INR']);
});

test('R15 parseAmount: symbols, codes and commas; whole numbers only', () => {
  for (const [typed, amount] of [['₹7,080', 7080], ['Rs 7080', 7080], ['Rs. 7,080', 7080], ['INR 7080', 7080], ['AED 950,000', 950000],
    ['aed950000', 950000], ['Dhs 1,200', 1200], ['SAR 12,000', 12000], ['$1,200', 1200], ['USD 99', 99], [' 950000 ', 950000]]) {
    assert.deepStrictEqual(parseAmount(typed), { amount }, typed);
  }
  for (const typed of ['7080.50', '1.1M', '', 'abc', '-500', '12 lakh', null]) assert.ok(parseAmount(typed).error, String(typed));
});

test('R15 profile: currency is one of four codes, else INR; examples follow it', () => {
  const base = { ...gymConfig.DEFAULT_PROFILE };
  assert.strictEqual(businessProfile.normalize({ ...base, currency: 'AED' }).currency, 'AED');
  assert.strictEqual(businessProfile.normalize({ ...base, currency: 'EUR' }).currency, 'INR');
  const { currency, ...old } = base; // a profile saved before R15
  assert.strictEqual(businessProfile.normalize(old).currency, 'INR');
  assert.strictEqual(labelsFor('realestate', 'AED').planPrice, 'AED 1.1M onwards');
  assert.strictEqual(labelsFor('realestate').planPrice, '₹85L onwards');
  assert.strictEqual(labelsFor('gym', 'USD').planPrice, '$100/month');
  assert.ok(!('planPriceByCurrency' in labelsFor('gym')));
  // R14 demo kit: the region sets the currency.
  assert.strictEqual(demoProfile('Demo', 'ae').currency, 'AED');
  assert.strictEqual(demoProfile('Demo', 'in').currency, 'INR');
});

test('R15 Dubai client: AED on the lead page, outcome sheet, pipeline and reports; typed amounts read', async () => {
  const ctx = await setup();
  try {
    asDubai();
    const owner = await login(ctx.app, 'owner');
    let page = (await owner.agent.get(`/leads/${LEAD}`)).text;
    assert.match(page, /Amount paid \(AED\)/);
    assert.doesNotMatch(page, /Amount paid \(₹\)/);

    const res = await owner.agent.post(`/leads/${LEAD}/outcome`).type('form')
      .send({ _csrf: owner.csrf, outcome: 'joined', plan: '2 Bedroom', amount: 'AED 1,850,000' });
    assert.strictEqual(res.status, 302);
    const row = await ctx.db.one("SELECT amount_inr FROM crm_lead_outcomes WHERE wa_id = $1 AND outcome = 'joined' ORDER BY id DESC LIMIT 1", [LEAD]);
    assert.strictEqual(Number(row.amount_inr), 1850000); // stored as whole AED

    page = (await owner.agent.get(`/leads/${LEAD}`)).text;
    assert.match(page, /AED 1,850,000/);
    assert.doesNotMatch(page, /₹18,50,000/);

    const pipeline = (await owner.agent.get('/pipeline')).text;
    assert.match(pipeline, /AED 1,850,000/);
    assert.match(pipeline, /Amount paid \(AED\)/);

    const reports = (await owner.agent.get('/reports?days=7')).text;
    assert.match(reports, /Revenue \(AED\)/);
    assert.match(reports, /AED 1,850,000/);
    assert.doesNotMatch(reports, /₹1,850,000|₹18,50,000/);
    const csv = await owner.agent.get('/reports/ads.csv?days=7');
    assert.match(csv.text.split('\n')[0], /,revenue_aed,/);

    // A decimal amount is refused with a message in the business's currency.
    const bad = await owner.agent.post(`/leads/${LEAD}/outcome`).type('form')
      .send({ _csrf: owner.csrf, outcome: 'joined', plan: '2 Bedroom', amount: '1850000.50' });
    assert.ok(bad.status >= 300);
    assert.strictEqual((await ctx.db.one("SELECT COUNT(*)::int AS c FROM crm_lead_outcomes WHERE wa_id = $1 AND outcome = 'joined'", [LEAD])).c, 1);
  } finally { await ctx.cleanup(); gymConfig.resetToDefault(); }
});

test('R15 GKF (INR) looks as before', async () => {
  const ctx = await setup();
  try {
    const owner = await login(ctx.app, 'owner');
    await owner.agent.post(`/leads/${LEAD}/outcome`).type('form').send({ _csrf: owner.csrf, outcome: 'joined', plan: 'Monthly', amount: '₹7,080' });
    const page = (await owner.agent.get(`/leads/${LEAD}`)).text;
    assert.match(page, /Amount paid \(₹\)/);
    assert.match(page, /₹7,080/);
    const reports = (await owner.agent.get('/reports?days=7')).text;
    assert.match(reports, /text-base-content\/60">Revenue<\/div>/); // no "(INR)" for GKF
    assert.doesNotMatch(reports, /Revenue \(INR\)/);
    // The ads CSV keeps its "revenue" column, so sheets that read it by name still work.
    const header = (await owner.agent.get('/reports/ads.csv?days=7')).text.split('\n')[0];
    assert.match(header, /,revenue,/);
    assert.doesNotMatch(header, /revenue_inr/);
  } finally { await ctx.cleanup(); }
});

test('R15 payment links: hidden and refused when the currency is not INR', async () => {
  const ctx = await setup();
  const saved = { ...process.env };
  const orig = razorpay.createLink;
  Object.assign(process.env, KEYS);
  const created = [];
  razorpay.createLink = async args => { created.push(args); return { id: 'plink_1', short_url: 'https://rzp.io/i/test1' }; };
  try {
    const owner = await login(ctx.app, 'owner');
    assert.match((await owner.agent.get(`/leads/${LEAD}`)).text, /Send payment link/); // INR: shown

    asDubai();
    assert.doesNotMatch((await owner.agent.get(`/leads/${LEAD}`)).text, /Send payment link/);
    const res = await owner.agent.post(`/leads/${LEAD}/payment-link`).type('form').send({ _csrf: owner.csrf, plan: '2 Bedroom', amount: '5000' });
    assert.ok(res.status === 400 || /err=/.test(res.headers.location || ''), `status ${res.status}`);
    assert.strictEqual(created.length, 0); // Razorpay never called
  } finally {
    razorpay.createLink = orig;
    for (const k of Object.keys(KEYS)) { if (k in saved) process.env[k] = saved[k]; else delete process.env[k]; }
    gymConfig.resetToDefault();
    await ctx.cleanup();
  }
});

test('R15 Business settings: currency select saves, warning once sales exist', async () => {
  const ctx = await setup();
  const form = (csrf, currency) => ({
    _csrf: csrf, name: 'Goldkraft Fitness', type: 'gym', currency, facility: 'Big gym', area: 'J.P. Nagar', address: 'ITI Layout, Bengaluru',
    parking: '', latitude: '', longitude: '', hours: 'Mon-Sat 5 AM - 10 PM', programs: 'CrossFit', selling_points: '',
    plan_name: ['Monthly', ''], plan_price: ['₹4,500/month', ''], plan_details: ['', ''], policy_name: [''], policy_text: [''],
    voice: 'Friendly', fallback_error: 'We will get back to you.', fallback_media: 'Got your file.'
  });
  try {
    const owner = await login(ctx.app, 'owner');
    let page = (await owner.agent.get('/settings')).text;
    assert.match(page, /<select name="currency"/);
    assert.match(page, /<option value="INR" selected>/);
    assert.doesNotMatch(page, /doesn't convert them/); // no sales yet

    await ctx.db.query("INSERT INTO crm_lead_outcomes (wa_id, user_id, outcome, plan, amount_inr) VALUES ($1, $2, 'joined', 'Monthly', 7080)", [LEAD, await ctx.userId('sales')]);
    page = (await owner.agent.get('/settings')).text;
    assert.match(page, /You have 1 recorded sale\. Changing the currency doesn't convert them/);
    assert.match(page, /name="currency_confirm"/);

    // With sales, changing the currency needs the box ticked; nothing changes without it.
    const refused = await owner.agent.post('/settings').type('form').send(form(owner.csrf, 'AED'));
    assert.strictEqual(refused.status, 400);
    assert.match(refused.text, /Tick the box under Currency to change it from INR to AED/);
    assert.strictEqual(gymConfig.profile.currency, 'INR');
    // Saving other fields with the same currency needs no box.
    assert.strictEqual((await owner.agent.post('/settings').type('form').send(form(owner.csrf, 'INR'))).status, 302);

    assert.strictEqual((await owner.agent.post('/settings').type('form').send({ ...form(owner.csrf, 'AED'), currency_confirm: '1' })).status, 302);
    assert.strictEqual(gymConfig.profile.currency, 'AED');
    const logged = await ctx.db.one("SELECT details FROM crm_activity_log WHERE action = 'currency_changed' ORDER BY id DESC LIMIT 1");
    assert.deepStrictEqual([logged.details.from, logged.details.to], ['INR', 'AED']);
    assert.strictEqual((await ctx.db.one('SELECT profile FROM business_profile')).profile.currency, 'AED');
    page = (await owner.agent.get('/settings')).text;
    assert.match(page, /<option value="AED" selected>/);
    assert.match(page, /placeholder="AED 400\/month"/); // the plan-price example follows the currency
    assert.match((await owner.agent.get(`/leads/${LEAD}`)).text, /AED 7,080/); // existing amount, now shown in AED (not converted)

    // A made-up code is saved as INR.
    await owner.agent.post('/settings').type('form').send({ ...form(owner.csrf, 'EUR'), currency_confirm: '1' });
    assert.strictEqual(gymConfig.profile.currency, 'INR');
  } finally { await ctx.cleanup(); gymConfig.resetToDefault(); }
});

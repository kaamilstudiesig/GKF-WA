const { setup: setupApp, login } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const gymConfig = require('../../src/config/gymConfig');
const businessProfile = require('../../src/services/businessProfile');
const registry = require('../../src/tenancy/registry');
const tenancy = require('../../src/tenancy/context');
const env = require('../../src/config/env');
const aiService = require('../../src/services/aiService');
const { Setup, testItems, profileMissing, whatsappState, LIVE_LEADS } = require('../../crm/src/setup');
const { replyPreview } = require('../../crm/src/replyPreview');

const none = () => null;
const yes = () => true;
const CONNECTED = { state: 'connected', steps: [] };
const step = (s, key) => s.steps.find(x => x.key === key);

test('R8 profile step: what a new client still has from the starting profile', () => {
  const starter = businessProfile.starterProfile({ name: 'Acme' });
  assert.deepStrictEqual(profileMissing(starter, starter), ['address', 'opening hours', 'what you offer', 'prices']);
  assert.deepStrictEqual(profileMissing(starter, starter, { programs: 'Projects and properties', plans: 'Unit types and prices' }).slice(2),
    ['projects and properties', 'unit types and prices']); // the business type's words
  assert.deepStrictEqual(profileMissing(gymConfig.DEFAULT_PROFILE, starter), []);
});

test('R8 WhatsApp step (K9 contract): blocked, ready, connected, problem; never a token', () => {
  const base = { status: 'active', whatsapp: { phoneNumberId: '', accessToken: 'SECRET_TOKEN', appSecret: 'SECRET_APP', twoStepPin: '123456', setup: null } };
  assert.deepStrictEqual(whatsappState(base, { blockedReason: () => 'Not yet.', canLink: yes }), { state: 'blocked', reason: 'Not yet.' });
  assert.deepStrictEqual(whatsappState(base, { blockedReason: none, canLink: yes }), { state: 'ready' });
  assert.strictEqual(whatsappState(base, { blockedReason: none, canLink: () => false }).state, 'blocked'); // no BOT_BASE_URL or key yet

  const now = Date.parse('2026-11-22T00:00:00Z');
  const setup = { mode: 'cloud', number: '+971 50 000 0001', verifiedName: 'Acme Homes', tokenExpiresAt: '2026-12-02T00:00:00Z', steps: { subscribed: { at: 'x' } }, lastError: null };
  const on = { ...base, whatsapp: { ...base.whatsapp, phoneNumberId: '123', setup } };
  const w = whatsappState(on, { blockedReason: () => 'already', canLink: yes, now });
  assert.deepStrictEqual([w.state, w.number, w.name, w.steps, w.daysLeft], ['connected', '+971 50 000 0001', 'Acme Homes', ['Messages reach us'], 10]);
  const bad = whatsappState({ ...on, whatsapp: { ...on.whatsapp, setup: { ...setup, lastError: { step: 'registered', message: 'Pin '.repeat(200) } } } }, { blockedReason: none, canLink: yes, now });
  assert.strictEqual(bad.state, 'problem');
  assert.strictEqual(bad.error.length, 200);
  assert.doesNotMatch(JSON.stringify([w, bad]), /SECRET|123456/);
  // Connected by hand (no connect link used): connected, with nothing to show about the setup.
  assert.deepStrictEqual(whatsappState({ ...base, whatsapp: { ...base.whatsapp, phoneNumberId: '9' } }, { blockedReason: none, canLink: yes }).state, 'connected');
});

test('R8 status: worked out from what is there, for a brand-new client', async () => {
  const ctx = await setupApp();
  try {
    const acme = await registry.create({ slug: 'acmes', name: 'Acme Setup', crmHost: 'crm.acmes.test' });
    await tenancy.run(acme.id, async () => {
      const starter = businessProfile.starterProfile({ name: 'Acme Setup' });
      const s = new Setup(ctx.db);
      let st = await s.status({ profile: starter, starter, visit: 'visit', whatsapp: { state: 'ready' } });
      assert.deepStrictEqual([st.done, st.total, st.complete, st.next], [0, 4, false, 'profile']);
      assert.ok(step(st, 'brand').optional && step(st, 'ads').optional);

      const profile = { ...starter, address: '1 Road', hours: ['Daily 9-6'], programs: ['Homes'], plans: [{ name: '2 BHK', price: '₹85L', details: '' }] };
      const q = (sql, p) => ctx.db.query(sql, p);
      await q("INSERT INTO crm_users (email, name, role, password_hash, active) VALUES ('o@acme.com', 'Owner', 'owner', 'x', true)");
      st = await s.status({ profile, starter, visit: 'visit', whatsapp: CONNECTED });
      assert.deepStrictEqual([step(st, 'profile').done, step(st, 'team').done, step(st, 'whatsapp').done, st.next], [true, false, true, 'team']);
      // Working alone: the owner's own alert number is enough.
      await q("UPDATE crm_users SET alert_phone = '919800000001', alert_mode = 'all'");
      assert.strictEqual(step(await s.status({ profile, starter, whatsapp: CONNECTED }), 'team').done, true);

      // Test step: all four seen AND every item ticked...
      await q("INSERT INTO leads (wa_id, status) VALUES ('919800000100', 'new')");
      await q("INSERT INTO messages (wa_id, direction, text, timestamp) VALUES ('919800000100', 'in', 'hi', now()), ('919800000100', 'out', 'hello', now())");
      await q("INSERT INTO handoffs (wa_id, reason) VALUES ('919800000100', 'human_requested')");
      st = await s.status({ profile, starter, whatsapp: CONNECTED });
      assert.deepStrictEqual(step(st, 'test').seen.map(x => x.done), [true, true, true, false]);
      await q("INSERT INTO crm_lead_outcomes (wa_id, outcome) VALUES ('919800000100', 'called_connected')");
      for (const i of testItems()) await q("INSERT INTO crm_activity_log (action, details) VALUES ('setup_check', $1::jsonb)", [JSON.stringify({ key: i.key, done: true })]);
      st = await s.status({ profile, starter, whatsapp: CONNECTED });
      assert.deepStrictEqual([step(st, 'test').done, st.complete, st.next], [true, true, null]);
      // ...the latest tick wins...
      await q("INSERT INTO crm_activity_log (action, details) VALUES ('setup_check', '{\"key\": \"stop\", \"done\": false}')");
      st = await s.status({ profile, starter, whatsapp: CONNECTED });
      assert.deepStrictEqual([step(st, 'test').done, step(st, 'test').ticked], [false, testItems().length - 1]);
      // ...and a business with real leads isn't asked to tick.
      for (let i = 0; i < LIVE_LEADS; i++) await q('INSERT INTO leads (wa_id, status, last_inbound_message_at) VALUES ($1, \'new\', now())', [`9198000002${String(i).padStart(2, '0')}`]);
      assert.strictEqual((await s.status({ profile, starter, whatsapp: CONNECTED })).complete, true);
    });
    // One client's ticks and facts never show for another.
    const mine = await new Setup(ctx.db).checks();
    assert.deepStrictEqual(mine, {});
  } finally { await ctx.cleanup(); }
});

test('R8 preview: the bot\'s fixed answers in its order, no AI, nothing saved', () => {
  const transport = aiService.transport;
  aiService.transport = () => { throw new Error('the preview must never call the AI'); };
  try {
    const hi = replyPreview('Hi', gymConfig.profile);
    assert.deepStrictEqual([hi.kind, hi.buttons], ['fixed', ['Prices', 'Book a trial', 'Location']]);
    assert.match(replyPreview('price kya hai', gymConfig.profile).reply, /₹4,040/);
    const human = replyPreview('call me', gymConfig.profile);
    assert.deepStrictEqual([human.kind, human.handoff], ['fixed', true]);
    assert.strictEqual(replyPreview('STOP', gymConfig.profile).kind, 'fixed'); // opt-out comes first
    assert.match(replyPreview('STOP', gymConfig.profile).reply, /message/i);
    assert.strictEqual(replyPreview('I have a slipped disc, which plan is best for someone like me?', gymConfig.profile).handoff, true); // medical safety before anything else
    assert.deepStrictEqual(replyPreview('Can my cousin share my locker on alternate weekends if we both come?', gymConfig.profile).kind, 'ai');
    assert.strictEqual(replyPreview('   '), null);
    assert.strictEqual(replyPreview('x'.repeat(999), gymConfig.profile).text.length, 300);
  } finally { aiService.transport = transport; }
});

test('R8 pages: owners only; short profile form keeps the rest; preview; ticks; dashboard card', async () => {
  const ctx = await setupApp();
  try {
    const owner = await login(ctx.app, 'owner');
    let page = (await owner.agent.get('/setup')).text;
    assert.match(page, /Get Goldkraft Fitness live on WhatsApp/);
    assert.match(page, /id="step-whatsapp"/);
    assert.match((await owner.agent.get('/settings')).text, /href="\/setup"/);
    assert.match((await owner.agent.get('/')).text, /Finish setup/);
    for (const role of ['manager', 'sales']) {
      const u = await login(ctx.app, role);
      for (const path of ['/setup', '/setup/connect']) assert.strictEqual((await u.agent.get(path)).status, 403, `${role} ${path}`);
      for (const path of ['/setup/profile', '/setup/try', '/setup/check']) assert.strictEqual((await u.agent.post(path).type('form').send({ _csrf: u.csrf })).status, 403, `${role} ${path}`);
      assert.doesNotMatch((await u.agent.get('/')).text, /Finish setup/);
    }

    // The short form changes its fields and keeps everything else (policies, parking, plan details, health mode).
    gymConfig.setProfile({ ...gymConfig.DEFAULT_PROFILE, healthRelated: true });
    const before = gymConfig.profile;
    const form = extra => ({
      _csrf: owner.csrf, name: 'GKF New', type: 'gym', currency: 'INR', area: 'J.P. Nagar', address: '2 New Road', hours: 'Daily 6-10', programs: 'Yoga\nBoxing',
      plan_name: ['Monthly', ''], plan_price: ['₹5,000/month', ''], plan_details: [before.plans[0].details, ''], ...extra
    });
    let r = await owner.agent.post('/setup/profile').type('form').send(form());
    assert.strictEqual(r.status, 302);
    const saved = (await ctx.db.one('SELECT profile FROM business_profile')).profile;
    assert.deepStrictEqual([saved.name, saved.address, saved.hours, saved.programs], ['GKF New', '2 New Road', ['Daily 6-10'], ['Yoga', 'Boxing']]);
    assert.deepStrictEqual(saved.plans, [{ name: 'Monthly', price: '₹5,000/month', details: before.plans[0].details }]);
    assert.deepStrictEqual([saved.policies, saved.parking, saved.sellingPoints, saved.voice, saved.healthRelated],
      [before.policies, before.parking, before.sellingPoints, before.voice, true]);

    // A mistake: the message, what was typed, the step open, nothing saved.
    r = await owner.agent.post('/setup/profile').type('form').send(form({ address: '', hours: 'Typed hours' }));
    assert.strictEqual(r.status, 400);
    assert.match(r.text, /Address is required/);
    assert.match(r.text, /Typed hours/);
    assert.match(r.text, /id="step-profile">\s*<details class="collapse collapse-arrow" open>/);
    assert.strictEqual(gymConfig.profile.address, '2 New Road');

    // Currency: free until sales have amounts, then only on Business settings (where it is confirmed).
    r = await owner.agent.post('/setup/profile').type('form').send(form({ currency: 'AED' }));
    assert.strictEqual(gymConfig.profile.currency, 'AED');
    await ctx.db.query("INSERT INTO crm_lead_outcomes (wa_id, user_id, outcome, plan, amount_inr) VALUES ('919845012345', $1, 'joined', 'Monthly', 5000)", [await ctx.userId('sales')]);
    r = await owner.agent.post('/setup/profile').type('form').send(form({ currency: 'INR' }));
    assert.strictEqual(r.status, 400);
    assert.match(r.text, /Change the currency on Business settings/);
    assert.strictEqual(gymConfig.profile.currency, 'AED');
    const { currency, ...noCurrency } = form(); // the disabled select sends nothing
    assert.strictEqual((await owner.agent.post('/setup/profile').type('form').send(noCurrency)).status, 302);
    assert.strictEqual(gymConfig.profile.currency, 'AED');

    // Preview on the page: the reply, escaped input, nothing stored.
    const counts = () => ctx.db.one('SELECT (SELECT COUNT(*) FROM leads)::int AS l, (SELECT COUNT(*) FROM messages)::int AS m, (SELECT COUNT(*) FROM outbound_messages)::int AS o, (SELECT COUNT(*) FROM handoffs)::int AS h');
    const was = await counts();
    page = (await owner.agent.post('/setup/try').type('form').send({ _csrf: owner.csrf, text: 'price?' })).text;
    assert.match(page, /₹5,000\/month/);
    page = (await owner.agent.post('/setup/try').type('form').send({ _csrf: owner.csrf, text: '<script>x</script> tell me a long story about your history' })).text;
    assert.match(page, /The AI answers this one/);
    assert.doesNotMatch(page, /<script>x/);
    assert.deepStrictEqual(await counts(), was);

    // Ticks: who and when, undo, unknown keys refused.
    await owner.agent.post('/setup/check').type('form').send({ _csrf: owner.csrf, key: 'hi', done: '1' });
    assert.match((await owner.agent.get('/setup?step=test')).text, /aria-label="Hi: done, tap to undo"/);
    await owner.agent.post('/setup/check').type('form').send({ _csrf: owner.csrf, key: 'hi', done: '0' });
    assert.match((await owner.agent.get('/setup?step=test')).text, /aria-label="Hi: mark as right"/);
    r = await owner.agent.post('/setup/check').type('form').send({ _csrf: owner.csrf, key: 'nope', done: '1' });
    assert.match(r.headers.location, /err=Unknown\+test/);
  } finally { gymConfig.resetToDefault(); await ctx.cleanup(); }
});

test('R8 Connect WhatsApp: a one-hour link to the bot host when allowed, the reason when not; tokens never on the page', async () => {
  const ctx = await setupApp();
  const was = { id: env.metaAppId, cfg: env.metaEsConfigId, secret: env.metaAppSecret, base: env.botBaseUrl, key: process.env.TENANT_SECRETS_KEY, pn: env.metaPhoneNumberId };
  try {
    process.env.TENANT_SECRETS_KEY = process.env.TENANT_SECRETS_KEY || Buffer.alloc(32, 7).toString('base64');
    Object.assign(env, { metaAppId: '111', metaEsConfigId: '222', metaAppSecret: 'app-secret-x', botBaseUrl: 'https://wa.example.test', metaPhoneNumberId: '' });
    const owner = await login(ctx.app, 'owner');
    let page = (await owner.agent.get('/setup?step=whatsapp')).text;
    assert.match(page, /href="\/setup\/connect" target="_blank" rel="noopener noreferrer"/);
    assert.doesNotMatch(page, /wa\.example\.test\/connect\//); // the link is only made on the click

    let r = await owner.agent.get('/setup/connect');
    assert.strictEqual(r.status, 302);
    assert.deepStrictEqual([r.headers['cache-control'], r.headers['referrer-policy']], ['no-store', 'no-referrer']);
    const token = /^https:\/\/wa\.example\.test\/connect\/(.+)$/.exec(r.headers.location)[1];
    const { readLinkToken } = require('../../src/services/embeddedSignup');
    assert.deepStrictEqual(readLinkToken(token), { tenantId: 1, appNumbers: false });
    assert.strictEqual(readLinkToken(token, { now: Date.now() + 61 * 60000 }), null); // one hour
    assert.strictEqual((await ctx.db.one("SELECT COUNT(*)::int AS c FROM crm_activity_log WHERE action = 'whatsapp_connect_opened'")).c, 1);

    // No bot address yet: no button, a plain reason, and the route refuses.
    env.botBaseUrl = '';
    page = (await owner.agent.get('/setup?step=whatsapp')).text;
    assert.doesNotMatch(page, /href="\/setup\/connect"/);
    assert.match(page, /not switched on yet/);
    assert.strictEqual((await owner.agent.get('/setup/connect')).status, 503);

    // Connected: the number and any failed step, no button; a second connect is refused.
    env.botBaseUrl = 'https://wa.example.test';
    await registry.update(1, {
      phoneNumberId: '1000200030044', secrets: { metaAccessToken: 'EAAG_SECRET_TOKEN' },
      settings: { whatsappSetup: { mode: 'cloud', number: '+971 50 000 0002', verifiedName: 'GKF Dubai', tokenExpiresAt: null, steps: { subscribed: { at: 'x' } }, lastError: { step: 'registered', message: 'Needs a <b>PIN</b>' } } }
    });
    page = (await owner.agent.get('/setup?step=whatsapp')).text;
    assert.match(page, /\+971 50 000 0002<\/strong> is connected as GKF Dubai/);
    assert.match(page, /Needs a &lt;b&gt;PIN/);
    assert.doesNotMatch(page, /href="\/setup\/connect"|EAAG_SECRET|app-secret-x/);
    assert.strictEqual((await owner.agent.get('/setup/connect')).status, 409);
  } finally {
    await registry.update(1, { phoneNumberId: null, secrets: { metaAccessToken: '' }, settings: { whatsappSetup: null } }).catch(() => {});
    Object.assign(env, { metaAppId: was.id, metaEsConfigId: was.cfg, metaAppSecret: was.secret, botBaseUrl: was.base, metaPhoneNumberId: was.pn });
    if (was.key === undefined) delete process.env.TENANT_SECRETS_KEY; else process.env.TENANT_SECRETS_KEY = was.key;
    await ctx.cleanup();
  }
});

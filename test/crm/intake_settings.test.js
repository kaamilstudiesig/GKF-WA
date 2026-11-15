const { setup, login } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const registry = require('../../src/tenancy/registry');
const { parseOrigins, parseCountry, snippet } = require('../../crm/src/intakeSettings');

const clearIntake = () => registry.update(1, {
  settings: { intakeFormKey: '', intakeOrigins: [], phoneCountry: '', leadWelcomeTemplate: '' }, secrets: { intakeSecret: '' }
});

test('R16 settings helpers: origins, country code, snippet', () => {
  assert.deepStrictEqual(parseOrigins('www.acme.example\nhttps://acme.example/contact\nhttps://acme.example'), ['https://www.acme.example', 'https://acme.example']);
  assert.deepStrictEqual(parseOrigins('http://localhost:8080'), ['http://localhost:8080']); // testing a site locally
  assert.throws(() => parseOrigins('http://acme.example'), /https address/);
  assert.throws(() => parseOrigins('not a site at all'), /not a website address|https address/);
  assert.strictEqual(parseCountry('+971'), '971');
  assert.throws(() => parseCountry('0'), /digits only/);
  const s = snippet({ endpoint: 'https://wa.example/intake/acme', formKey: 'K1', businessName: 'Acme <Homes>' });
  assert.match(s, /fetch\('https:\/\/wa\.example\/intake\/acme'/);
  assert.match(s, /d\.set\('form_key', 'K1'\)/);
  assert.match(s, /name="company_url"/); // the honeypot
  assert.match(s, /Acme &lt;Homes> may message me on WhatsApp/); // consent names the business, escaped
  assert.doesNotMatch(s, /type="checkbox" name="consent" value="true" checked/); // unticked by default
});

test('R16 Lead sources on Business settings: save, form key + snippet, secret shown once, last submissions', async () => {
  const ctx = await setup();
  try {
    const owner = await login(ctx.app, 'owner');
    let page = (await owner.agent.get('/settings')).text;
    assert.match(page, /id="lead-sources"/);
    assert.match(page, /\/intake\//);
    assert.match(page, /Make a form key to get the code/);

    let r = await owner.agent.post('/settings/intake').type('form').send({ _csrf: owner.csrf, origins: 'http://acme.example', phone_country: '971' });
    assert.strictEqual(r.status, 400);
    assert.match(r.text, /https address/);
    r = await owner.agent.post('/settings/intake').type('form').send({ _csrf: owner.csrf, origins: 'www.acme.example', phone_country: '971' });
    assert.strictEqual(r.status, 302);
    assert.deepStrictEqual([registry.config(1).intake.origins, registry.config(1).intake.phoneCountry], [['https://www.acme.example'], '971']);

    await owner.agent.post('/settings/intake/form-key').type('form').send({ _csrf: owner.csrf });
    const key = registry.config(1).intake.formKey;
    assert.ok(key.length >= 20);
    page = (await owner.agent.get('/settings')).text;
    assert.ok(page.includes(`d.set(&#39;form_key&#39;, &#39;${key}&#39;)`), 'snippet carries the form key');
    assert.match(page, /data-confirm="Forms already on your website stop working/);

    r = await owner.agent.post('/settings/intake/secret').type('form').send({ _csrf: owner.csrf });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['cache-control'], 'no-store');
    const secret = registry.config(1).intake.secret;
    assert.match(secret, /^[0-9a-f]{64}$/);
    assert.ok(r.text.includes(secret));
    assert.match(r.text, /It is not shown again/);
    page = (await owner.agent.get('/settings')).text;
    assert.ok(!page.includes(secret), 'the secret is never shown again');
    assert.match(page, /A signing secret is set/);

    await ctx.db.query(`INSERT INTO intake_submissions (channel, source, wa_id, status) VALUES ('api', 'bayut', '919845012345', 'accepted'), ('form', 'website', NULL, 'rejected')`);
    page = (await owner.agent.get('/settings')).text;
    assert.match(page, />Added</);
    assert.match(page, />Refused</);
    assert.match(page, /Bayut ·/);

    const log = (await ctx.db.many("SELECT action FROM crm_activity_log WHERE action LIKE 'intake_%' ORDER BY id")).map(x => x.action);
    assert.deepStrictEqual(log, ['intake_settings_updated', 'intake_form_key_created', 'intake_secret_regenerated']);

    // Owners only.
    const manager = await login(ctx.app, 'manager');
    for (const path of ['/settings/intake', '/settings/intake/form-key', '/settings/intake/secret']) {
      assert.strictEqual((await manager.agent.post(path).type('form').send({ _csrf: manager.csrf })).status, 403, path);
    }
  } finally { await clearIntake(); await ctx.cleanup(); }
});

test('R16 form leads in the CRM: source badge, "Lead form" notes, window closed, sorted after leads that wrote', async () => {
  const ctx = await setup();
  try {
    await ctx.db.query(`INSERT INTO leads (wa_id, phone, display_name, source, first_contact_at, last_inbound_message_at)
      VALUES ('971501230000', '971501230000', 'Portal Pat', 'intake_bayut', now(), NULL)`);
    await ctx.db.query(`INSERT INTO crm_lead_notes (wa_id, user_id, body) VALUES ('971501230000', NULL, 'From the Bayut form: 2BR please')`);
    const owner = await login(ctx.app, 'owner');

    const page = (await owner.agent.get('/leads/971501230000')).text;
    assert.match(page, /Lead form ·/);
    assert.match(page, /<dd>Bayut<\/dd>/);
    assert.match(page, />Reply window closed</); // never wrote on WhatsApp: staff can't send free text
    assert.match(page, /id="reply"[^>]* disabled /);
    const list = (await owner.agent.get('/leads?sort=recent')).text;
    assert.match(list, /badge-info badge-soft badge-xs[^"]*">Bayut</);
    const order = [...list.matchAll(/href="\/leads\/([^"#?]+)"/g)].map(m => m[1]);
    assert.strictEqual(order.filter((v, i, a) => a.indexOf(v) === i).pop(), '971501230000'); // no message yet: last, not first
  } finally { await ctx.cleanup(); }
});

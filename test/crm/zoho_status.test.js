const { setup, login } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const registry = require('../../src/tenancy/registry');
const { webDomain, recordUrl } = require('../../crm/src/zohoStatus');

const LEAD = '919845012345'; // Rahul in the demo data

test('Zoho links: data centre domain and the best record to open', () => {
  assert.strictEqual(webDomain('https://accounts.zoho.in'), 'https://crm.zoho.in');
  assert.strictEqual(webDomain('https://accounts.zoho.ae/'), 'https://crm.zoho.ae');
  assert.strictEqual(webDomain('https://evil.example/accounts.zoho.in'), null);
  const d = 'https://crm.zoho.in';
  assert.deepStrictEqual(recordUrl(d, { zoho_lead_id: '111', zoho_contact_id: '222', zoho_deal_id: '333' }), { url: `${d}/crm/tab/Deals/333`, label: 'deal' });
  assert.deepStrictEqual(recordUrl(d, { zoho_lead_id: '111' }), { url: `${d}/crm/tab/Leads/111`, label: 'lead' });
  assert.strictEqual(recordUrl(d, { zoho_lead_id: '1/../x' }), null); // only numeric Zoho ids
  assert.strictEqual(recordUrl(null, { zoho_lead_id: '111' }), null);
});

test('Business settings and lead page show the Zoho sync state', async () => {
  const ctx = await setup();
  try {
    const owner = await login(ctx.app, 'owner');
    // Off: an explanation, no link on the lead page.
    let settings = (await owner.agent.get('/settings')).text;
    assert.match(settings, /Zoho CRM/);
    assert.match(settings, /Ask your setup contact to connect it/);
    assert.doesNotMatch((await owner.agent.get(`/leads/${LEAD}`)).text, /in Zoho/);

    await registry.update(1, {
      settings: { zohoSync: 'on', zohoAccountsUrl: 'https://accounts.zoho.in', zohoApiDomain: 'https://www.zohoapis.in' },
      secrets: { zohoClientId: 'CID', zohoClientSecret: 'CSECRET', zohoRefreshToken: 'RT' }
    });
    await ctx.db.query('DELETE FROM zoho_links');
    await ctx.db.query(`INSERT INTO zoho_links (wa_id, zoho_lead_id, dirty, status) VALUES ($1, '5550001', false, 'synced')`, [LEAD]);
    await ctx.db.query(`INSERT INTO zoho_links (wa_id, dirty, status, last_error) VALUES ('919900112233', true, 'dead', 'MANDATORY_NOT_FOUND: Last_Name')`);
    await ctx.db.query(`INSERT INTO zoho_cursors (pulled_until) VALUES (now() - interval '3 minutes')`);

    settings = (await owner.agent.get('/settings')).text;
    assert.match(settings, /Connected/);
    assert.match(settings, /last up to <strong[^>]*>3m ago/);
    assert.match(settings, /Zoho refused these leads/);
    assert.match(settings, /MANDATORY_NOT_FOUND: Last_Name/);
    assert.match(settings, /href="https:\/\/crm.zoho.in\/crm"/);
    assert.doesNotMatch(settings, /CSECRET|RT"/); // secrets never on the page

    const lead = (await owner.agent.get(`/leads/${LEAD}`)).text;
    assert.match(lead, /href="https:\/\/crm.zoho.in\/crm\/tab\/Leads\/5550001" target="_blank" rel="noopener noreferrer">Open lead in Zoho/);
    assert.match(lead, /In sync/);
    const refused = (await owner.agent.get('/leads/919900112233')).text;
    assert.match(refused, /Not sent/);
    assert.match(refused, /MANDATORY_NOT_FOUND/);

    // Every bucket counts: synced 1, waiting 3 (dirty, sending, no status), retrying 1, not sent 1; skipped is left out.
    const demo = await ctx.db.many("SELECT wa_id FROM leads WHERE wa_id NOT IN ($1, '919900112233') ORDER BY wa_id LIMIT 5", [LEAD]);
    const [w1, w2, w3, w4, w5] = demo.map(r => r.wa_id);
    await ctx.db.query(`INSERT INTO zoho_links (wa_id, dirty, status) VALUES ($1, true, 'synced'), ($2, false, 'sending'), ($3, false, NULL)`, [w1, w2, w3]);
    await ctx.db.query(`INSERT INTO zoho_links (wa_id, dirty, status, last_error) VALUES ($1, true, 'failed', 'HTTP 503')`, [w4]);
    await ctx.db.query(`INSERT INTO zoho_links (wa_id, dirty, status) VALUES ($1, false, 'skipped')`, [w5]);
    const { ZohoStatus } = require('../../crm/src/zohoStatus');
    const tenancy = require('../../src/tenancy/context');
    const sum = await tenancy.run(1, () => new ZohoStatus(ctx.db, registry).summary());
    assert.deepStrictEqual(sum.counts, { synced: 1, waiting: 3, retrying: 1, notSent: 1 });
    assert.match((await owner.agent.get(`/leads/${w4}`)).text, /Retrying/);

    // A lead with no Zoho row yet says so, instead of "Waiting" forever.
    const other = (await ctx.db.one('SELECT wa_id FROM leads l WHERE NOT EXISTS (SELECT 1 FROM zoho_links z WHERE z.wa_id = l.wa_id) LIMIT 1')).wa_id;
    assert.match((await owner.agent.get(`/leads/${other}`)).text, /Not in Zoho yet/);

    // A long read error is shortened on the page.
    await ctx.db.query(`UPDATE zoho_cursors SET last_error = $1`, ['x'.repeat(500)]);
    assert.strictEqual((await tenancy.run(1, () => new ZohoStatus(ctx.db, registry).summary())).readError.length, 200);

    // A broken registry is an error, not "Off".
    assert.throws(() => new ZohoStatus(ctx.db, { config: () => { throw new Error('boom'); } }).config(), /boom/);
  } finally {
    await registry.update(1, { settings: { zohoSync: 'off' } });
    await ctx.cleanup();
  }
});

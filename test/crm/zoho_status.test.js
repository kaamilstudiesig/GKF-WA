const { setup, login } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const registry = require('../../src/tenancy/registry');
const { ZohoStatus, webDomain, recordUrl } = require('../../crm/src/zohoStatus');

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
    // One row per state, so each count is checked (skipped is left out on purpose).
    await ctx.db.query(`INSERT INTO zoho_links (wa_id, dirty, status, last_error) VALUES ('918050443322', true, 'failed', 'Zoho is busy, try later')`);
    await ctx.db.query(`INSERT INTO zoho_links (wa_id, dirty, status) VALUES ('919731556677', true, NULL)`); // new, not claimed yet
    await ctx.db.query(`INSERT INTO zoho_links (wa_id, dirty, status) VALUES ('917204889900', false, 'sending')`); // being sent now
    await ctx.db.query(`INSERT INTO zoho_links (wa_id, dirty, status) VALUES ('919611223344', false, 'skipped')`);
    await ctx.db.query(`INSERT INTO zoho_cursors (pulled_until, last_error) VALUES (now() - interval '3 minutes', $1)`, ['Zoho said: ' + 'x'.repeat(500)]);

    settings = (await owner.agent.get('/settings')).text;
    assert.match(settings, /Connected/);
    assert.match(settings, /last up to <strong[^>]*>3m ago/);
    assert.match(settings, /Zoho refused these leads/);
    const counts = await new ZohoStatus(ctx.db, registry).summary();
    assert.deepStrictEqual(counts.counts, { synced: 1, waiting: 2, retrying: 1, notSent: 1 });
    for (const [label, n] of [['In sync', 1], ['Waiting to send', 2], ['Retrying', 1], ['Not sent', 1]]) {
      assert.match(settings, new RegExp(`>${label}</div><div class="[^"]*">${n}</div>`), label);
    }
    assert.strictEqual(counts.readError.length, 200); // Zoho's long read error is shortened
    assert.doesNotMatch(settings, /x{201}/);
    assert.match(settings, /MANDATORY_NOT_FOUND: Last_Name/);
    assert.match(settings, /href="https:\/\/crm.zoho.in\/crm"/);
    assert.doesNotMatch(settings, /CSECRET|RT"/); // secrets never on the page

    const lead = (await owner.agent.get(`/leads/${LEAD}`)).text;
    assert.match(lead, /href="https:\/\/crm.zoho.in\/crm\/tab\/Leads\/5550001" target="_blank" rel="noopener noreferrer">Open lead in Zoho/);
    assert.match(lead, /In sync/);
    const refused = (await owner.agent.get('/leads/919900112233')).text;
    assert.match(refused, /Not sent/);
    assert.match(refused, /MANDATORY_NOT_FOUND/);
    const retrying = (await owner.agent.get('/leads/918050443322')).text;
    assert.match(retrying, /text-warning">Retrying</);
    assert.match(retrying, /Zoho is busy, try later/);
    // A lead from before Zoho was on (no row): not shown as waiting forever.
    const old = (await owner.agent.get('/leads/919886554433')).text;
    assert.match(old, /Not in Zoho yet/);
    assert.doesNotMatch(old, /Waiting to send/);
  } finally {
    await registry.update(1, { settings: { zohoSync: 'off' } });
    await ctx.cleanup();
  }
});

test('Zoho status: unknown client is off, a broken registry is not hidden as off', async () => {
  const off = new ZohoStatus({}, { config: () => null });
  assert.deepStrictEqual(await off.summary(), { on: false });
  assert.strictEqual(await off.forLead('919845012345'), null);
  const broken = new ZohoStatus({}, { config: () => { throw new Error('registry not loaded'); } });
  await assert.rejects(broken.summary(), /registry not loaded/);
  await assert.rejects(broken.forLead('919845012345'), /registry not loaded/);
});

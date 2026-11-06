const { setup } = require('./crm/helpers');
const test = require('node:test');
const assert = require('node:assert');
const registry = require('../src/tenancy/registry');
const tenancy = require('../src/tenancy/context');
const zoho = require('../src/services/zoho/client');
const sync = require('../src/services/zoho/sync');
const zohoWorker = require('../src/workers/zohoWorker');
const { Crm } = require('../crm/src/crm');

const API = 'https://www.zohoapis.in/crm/v8';

/** A small fake Zoho: records every call, keeps Leads and Deals, returns changes the test sets. */
function fakeZoho() {
  const f = { calls: [], leads: {}, deals: {}, changed: { Leads: [], Deals: [] }, seq: 100, tokenError: null };
  zoho.transport = async req => {
    const path = req.url.replace(API, '');
    f.calls.push({ method: req.method, path, data: req.data, params: req.params, headers: req.headers });
    if (req.url.endsWith('/oauth/v2/token')) {
      if (f.tokenError) return { status: 400, data: { error: f.tokenError } };
      return { status: 200, data: { access_token: 'AT', api_domain: 'https://www.zohoapis.in', expires_in: 3600 } };
    }
    const ok = id => ({ status: 200, data: { data: [{ status: 'success', code: 'SUCCESS', details: { id } }] } });
    let m;
    if (req.method === 'get' && path === '/Leads/search') {
      const hit = Object.entries(f.leads).find(([, r]) => r.Mobile === req.params.phone);
      return hit ? { status: 200, data: { data: [{ id: hit[0] }] } } : { status: 204, data: null };
    }
    if (req.method === 'post' && (path === '/Leads' || path === '/Leads/upsert')) {
      const id = String(++f.seq);
      f.leads[id] = { ...req.data.data[0] };
      return { status: 201, data: { data: [{ status: 'success', code: 'SUCCESS', action: 'insert', details: { id } }] } };
    }
    if (req.method === 'put' && (m = /^\/Leads\/(\w+)$/.exec(path))) {
      Object.assign(f.leads[m[1]], req.data.data[0]);
      return ok(m[1]);
    }
    if (req.method === 'post' && (m = /^\/Leads\/(\w+)\/actions\/convert$/.exec(path))) {
      const dealId = String(++f.seq);
      const contactId = String(++f.seq);
      f.deals[dealId] = { ...req.data.data[0].Deals };
      delete f.leads[m[1]];
      return { status: 200, data: { data: [{ status: 'success', code: 'SUCCESS', details: { Contacts: { id: contactId }, Deals: { id: dealId }, Accounts: null } }] } };
    }
    if (req.method === 'put' && (m = /^\/Deals\/(\w+)$/.exec(path))) {
      Object.assign(f.deals[m[1]], req.data.data[0]);
      return ok(m[1]);
    }
    if (req.method === 'get' && (path === '/Leads' || path === '/Deals')) {
      const list = f.changed[path.slice(1)];
      return list.length ? { status: 200, data: { data: list, info: { more_records: false } } } : { status: 304, data: null };
    }
    if (req.method === 'get' && path === '/org') return { status: 200, data: { org: [{ company_name: 'Test Co' }] } };
    return { status: 404, data: { code: 'NOT_FOUND', message: path } };
  };
  return f;
}

async function connectZoho(tenantId = 1, settings = {}) {
  await registry.update(tenantId, {
    settings: { zohoSync: 'on', zohoAccountsUrl: 'https://accounts.zoho.in', zohoApiDomain: 'https://www.zohoapis.in', ...settings },
    secrets: { zohoClientId: 'CID', zohoClientSecret: 'CSECRET', zohoRefreshToken: 'RT' }
  });
}

const addLead = (db, waId, name = 'Rahul Kumar Sharma') => db.query(
  "INSERT INTO leads (wa_id, display_name, phone, status, interest) VALUES ($1, $2, $1, 'new', 'Monthly plan')", [waId, name]);
const link = (db, waId) => db.one('SELECT * FROM zoho_links WHERE wa_id = $1', [waId]);
const owner = async db => ({ ...(await db.one("SELECT id, name FROM crm_users WHERE role = 'owner' ORDER BY id LIMIT 1")), role: 'owner' });

async function withZoho(fn, settings) {
  const ctx = await setup();
  zoho.resetForTests();
  const fake = fakeZoho();
  try {
    await connectZoho(1, settings);
    await fn(ctx, fake);
  } finally {
    zoho.resetForTests();
    await ctx.cleanup();
  }
}

test('helpers: names, lead fields and what Zoho changes mean', () => {
  assert.deepStrictEqual(sync.splitName('Rahul Kumar Sharma'), { First_Name: 'Rahul Kumar', Last_Name: 'Sharma' });
  assert.deepStrictEqual(sync.splitName(''), { Last_Name: 'WhatsApp lead' });
  const cfg = registry.config(1).zoho; // defaults
  const rec = sync.leadRecord({ wa_id: 'IN.ABC', display_name: 'Asha', phone: null, status: 'hot' }, { ...cfg, idField: 'Lead_Engine_ID' }, { create: true });
  assert.strictEqual(rec.Mobile, undefined); // hidden phone: no Mobile
  assert.strictEqual(rec.Lead_Status, 'Pre-Qualified');
  assert.strictEqual(rec.Lead_Engine_ID, 'IN.ABC');
  assert.match(rec.Description, /Lead from WhatsApp/);
  assert.strictEqual(sync.leadRecord({ wa_id: '91', status: 'new' }, cfg, { sendStatus: false }).Lead_Status, undefined);
  assert.deepStrictEqual(sync.convertedIds({ Contacts: '1', Deals: '2' }), { contactId: '1', dealId: '2' });
  assert.deepStrictEqual(sync.convertedIds({ details: { Contacts: { id: '3' }, Deals: { id: '4' } } }), { contactId: '3', dealId: '4' });
  assert.strictEqual(sync.sinceHeader('2026-11-06T10:00:00.123Z'), '2026-11-06T10:00:00+00:00');

  const lead = { status: 'hot' };
  assert.strictEqual(sync.inboundAction('Deals', { Stage: 'Closed Won', Amount: '4999.6', Deal_Name: 'Gold' }, lead, cfg).amount, 5000);
  assert.deepStrictEqual(sync.inboundAction('Deals', { Stage: 'Closed Won', Amount: null }, lead, cfg), { skip: 'won_without_amount' });
  assert.strictEqual(sync.inboundAction('Leads', { Lead_Status: 'Junk Lead' }, lead, cfg).outcome, 'lost');
  assert.strictEqual(sync.inboundAction('Leads', { Lead_Status: 'Junk Lead' }, { status: 'converted' }, cfg), null); // a sale is never undone
  assert.deepStrictEqual(sync.inboundAction('Leads', { Lead_Status: 'Contacted' }, { status: 'new' }, cfg), { status: 'contacted' });
});

test('only tenants with Zoho on get leads marked, and only on changes Zoho cares about', async () => {
  const ctx = await setup();
  try {
    await addLead(ctx.db, '919800000001');
    assert.strictEqual(await link(ctx.db, '919800000001'), null); // Zoho off: nothing queued
    await connectZoho();
    await addLead(ctx.db, '919800000002');
    assert.strictEqual((await link(ctx.db, '919800000002')).dirty, true);
    await ctx.db.query('UPDATE zoho_links SET dirty = false');
    await ctx.db.query("UPDATE leads SET last_inbound_message_at = now(), metadata = '{\"x\":1}' WHERE wa_id = '919800000002'");
    assert.strictEqual((await link(ctx.db, '919800000002')).dirty, false); // a new message alone is not a Zoho change
    await ctx.db.query("UPDATE leads SET status = 'hot' WHERE wa_id = '919800000002'");
    assert.strictEqual((await link(ctx.db, '919800000002')).dirty, true);

    // A second tenant without Zoho: its leads are never queued, and the worker never claims across tenants.
    const acme = await registry.create({ slug: 'acme', name: 'Acme', phoneNumberId: '55501' });
    await tenancy.run(acme.id, () => ctx.db.query("INSERT INTO leads (wa_id, display_name) VALUES ('919800000003', 'Acme lead')"));
    const all = await tenancy.runAsSystem(() => ctx.db.many('SELECT tenant_id, wa_id FROM zoho_links ORDER BY wa_id'));
    assert.deepStrictEqual(all.map(r => r.tenant_id), [1]);
  } finally {
    await ctx.cleanup();
  }
});

test('a lead goes to Zoho, then a won sale converts it into a Deal with the amount', async () => {
  await withZoho(async (ctx, fake) => {
    const waId = '919845000001';
    await addLead(ctx.db, waId);
    assert.strictEqual(await zohoWorker.drain(), 1);
    const created = fake.calls.find(c => c.method === 'post' && c.path === '/Leads');
    assert.ok(created, 'created a Zoho lead');
    const rec = created.data.data[0];
    assert.deepStrictEqual([rec.First_Name, rec.Last_Name, rec.Mobile, rec.Lead_Status], ['Rahul Kumar', 'Sharma', `+${waId}`, 'Not Contacted']);
    assert.strictEqual(created.headers.Authorization, 'Zoho-oauthtoken AT');
    const l1 = await link(ctx.db, waId);
    assert.strictEqual(l1.status, 'synced');
    assert.ok(l1.zoho_lead_id);

    await new Crm(ctx.db).logOutcome(await owner(ctx.db), waId, { outcome: 'joined', plan: 'Quarterly', amount: '7080' });
    assert.strictEqual(await zohoWorker.drain(), 1);
    const convert = fake.calls.find(c => c.path === `/Leads/${l1.zoho_lead_id}/actions/convert`);
    assert.ok(convert, 'converted the lead');
    const deal = convert.data.data[0].Deals;
    assert.deepStrictEqual([deal.Stage, deal.Amount, deal.Deal_Name], ['Closed Won', 7080, 'Rahul Kumar Sharma - Quarterly']);
    const l2 = await link(ctx.db, waId);
    assert.ok(l2.zoho_deal_id && l2.zoho_contact_id);
    assert.strictEqual(await zohoWorker.drain(), 0); // nothing left to send

    // Reading Zoho afterwards sees our own deal in the won stage: no echo, no second sale.
    fake.changed.Deals = [{ id: l2.zoho_deal_id, Stage: 'Closed Won', Amount: 7080, Deal_Name: 'x' }];
    const r = await zohoWorker.pullAll();
    assert.deepStrictEqual(r[1], { unchanged: 1 });
    const { n } = await ctx.db.one("SELECT COUNT(*)::int AS n FROM crm_lead_outcomes WHERE wa_id = $1 AND outcome = 'joined'", [waId]);
    assert.strictEqual(n, 1);
  });
});

test('an existing Zoho lead with the same mobile is matched, not duplicated', async () => {
  await withZoho(async (ctx, fake) => {
    fake.leads['77'] = { Mobile: '+919845000002', Last_Name: 'Already there' };
    await addLead(ctx.db, '919845000002');
    await zohoWorker.drain();
    assert.strictEqual((await link(ctx.db, '919845000002')).zoho_lead_id, '77');
    assert.ok(!fake.calls.some(c => c.method === 'post' && c.path === '/Leads'));
  });
});

test('changes made in Zoho come back: Contacted, then Junk Lead logs Lost, without being overwritten', async () => {
  await withZoho(async (ctx, fake) => {
    const waId = '919845000003';
    await addLead(ctx.db, waId);
    await zohoWorker.drain();
    const { zoho_lead_id: id } = await link(ctx.db, waId);

    fake.changed.Leads = [{ id, Lead_Status: 'Contacted' }];
    await zohoWorker.pullAll();
    assert.strictEqual((await ctx.db.one('SELECT status FROM leads WHERE wa_id = $1', [waId])).status, 'contacted');
    fake.calls.length = 0;
    await zohoWorker.drain(); // our status changed, but because of Zoho: don't send Lead_Status back
    const put = fake.calls.find(c => c.method === 'put');
    assert.ok(put && !('Lead_Status' in put.data.data[0]));

    fake.changed.Leads = [{ id, Lead_Status: 'Junk Lead' }];
    await zohoWorker.pullAll();
    const out = await ctx.db.one('SELECT outcome, lost_reason, note FROM crm_lead_outcomes WHERE wa_id = $1 ORDER BY id DESC LIMIT 1', [waId]);
    assert.deepStrictEqual([out.outcome, out.lost_reason], ['lost', 'other']);
    assert.match(out.note, /Junk Lead/);
    fake.leads[id].Lead_Status = 'Junk Lead'; // what staff set in Zoho
    await zohoWorker.drain();
    assert.strictEqual(fake.leads[id].Lead_Status, 'Junk Lead'); // not replaced by our "Lost Lead"

    const again = await zohoWorker.pullAll(); // same change read twice (overlap): nothing new
    assert.deepStrictEqual(again[1], { unchanged: 1 });
    const cursor = await ctx.db.one('SELECT pulled_until FROM zoho_cursors');
    assert.ok(cursor.pulled_until);
    const lastRead = fake.calls.filter(c => c.path === '/Leads' && c.method === 'get').pop();
    assert.match(lastRead.headers['If-Modified-Since'], /\+00:00$/);
  });
});

test('with a lead-key field, upsert by it, and a Deal won in Zoho logs Joined here', async () => {
  await withZoho(async (ctx, fake) => {
    const waId = '919845000004';
    await addLead(ctx.db, waId, 'Priya');
    await zohoWorker.drain();
    const up = fake.calls.find(c => c.path === '/Leads/upsert');
    assert.deepStrictEqual(up.data.duplicate_check_fields, ['Lead_Engine_ID']);
    assert.strictEqual(up.data.data[0].Lead_Engine_ID, waId);

    // Staff converted the lead in Zoho themselves; the conversion mapping copied our lead key to the Deal.
    fake.changed.Deals = [{ id: 'D9', Stage: 'Closed Won', Amount: 12000, Deal_Name: 'Gold annual', Lead_Engine_ID: waId }];
    const r = await zohoWorker.pullAll();
    assert.deepStrictEqual(r[1], { joined: 1 });
    const out = await ctx.db.one("SELECT plan, amount_inr, user_id FROM crm_lead_outcomes WHERE wa_id = $1 AND outcome = 'joined'", [waId]);
    assert.deepStrictEqual([out.plan, out.amount_inr], ['Gold annual', 12000]);
    assert.strictEqual(out.user_id, (await owner(ctx.db)).id); // unassigned lead: logged as the owner
    assert.strictEqual((await ctx.db.one('SELECT status FROM leads WHERE wa_id = $1', [waId])).status, 'converted');
    assert.strictEqual((await link(ctx.db, waId)).zoho_deal_id, 'D9');
    fake.calls.length = 0;
    await zohoWorker.drain(); // the Deal already says won with this amount: no write back
    assert.ok(!fake.calls.some(c => c.method === 'put' || c.method === 'post'));
  }, { zohoIdField: 'Lead_Engine_ID' });
});

test('a broken Zoho connection is retried later and does not lose the change', async () => {
  await withZoho(async (ctx, fake) => {
    fake.tokenError = 'invalid_code';
    await addLead(ctx.db, '919845000005');
    await zohoWorker.drain();
    const l = await link(ctx.db, '919845000005');
    assert.strictEqual(l.status, 'failed');
    assert.strictEqual(l.dirty, true);
    assert.ok(new Date(l.next_attempt_at) > new Date());
    assert.match(l.last_error, /invalid_code/);
    assert.strictEqual(await zohoWorker.drain(), 0); // waits for its retry time

    fake.tokenError = null;
    await ctx.db.query('UPDATE zoho_links SET next_attempt_at = now()');
    await zohoWorker.drain();
    assert.strictEqual((await link(ctx.db, '919845000005')).status, 'synced');
  });
});

test('turning Zoho off stops new leads being queued', async () => {
  await withZoho(async ctx => {
    await registry.update(1, { settings: { zohoSync: 'off' } });
    await addLead(ctx.db, '919845000006');
    assert.strictEqual(await link(ctx.db, '919845000006'), null);
    assert.strictEqual(await zohoWorker.claimNext(), null);
  });
});

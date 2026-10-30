const { setup } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const env = require('../../src/config/env');
const conversionsApi = require('../../src/services/conversionsApi');
const conversionsWorker = require('../../src/workers/conversionsWorker');

const AD_LEAD = '919845012345';  // Rahul: we'll give him an ad click ID
const PLAIN_LEAD = '918050443322'; // Arjun: no click ID

async function withCapi(fn, { pageId = '' } = {}) {
  const saved = { ds: env.metaDatasetId, waba: env.metaWabaId, page: env.metaPageId };
  Object.assign(env, { metaDatasetId: 'DS1', metaWabaId: 'WABA1', metaPageId: pageId });
  const sent = [];
  conversionsApi.transport = async body => { sent.push(body); return { events_received: body.data.length }; };
  try { await fn(sent); } finally {
    Object.assign(env, { metaDatasetId: saved.ds, metaWabaId: saved.waba, metaPageId: saved.page });
    conversionsApi.transport = null;
  }
}
const addOutcome = (db, waId, outcome, extra = {}) => db.one(`
  INSERT INTO crm_lead_outcomes (wa_id, outcome, amount_inr, plan, created_at)
  VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, now())) RETURNING id`,
[waId, outcome, extra.amount || null, extra.plan || null, extra.at || null]);
const state = (db, id) => db.one('SELECT meta_status, meta_event, meta_error, sent_to_meta_at, meta_attempts FROM crm_lead_outcomes WHERE id = $1', [id]);

test('a Joined outcome from an ad lead is sent once as a Purchase in rupees', async () => {
  const ctx = await setup();
  try {
    await ctx.db.query(`UPDATE leads SET metadata = jsonb_set(metadata, '{referral}', '{"ctwa_clid":"CLID123","source_id":"AD9"}') WHERE wa_id = $1`, [AD_LEAD]);
    const { id } = await addOutcome(ctx.db, AD_LEAD, 'joined', { amount: 7080, plan: 'Quarterly' });
    await addOutcome(ctx.db, AD_LEAD, 'no_answer'); // not a Meta event, never claimed
    await withCapi(async sent => {
      assert.strictEqual(await conversionsWorker.drain(), 1);
      assert.strictEqual(sent.length, 1);
      const [ev] = sent[0].data;
      assert.strictEqual(ev.event_name, 'Purchase');
      assert.strictEqual(ev.action_source, 'business_messaging');
      assert.strictEqual(ev.messaging_channel, 'whatsapp');
      assert.deepStrictEqual(ev.user_data, { whatsapp_business_account_id: 'WABA1', ctwa_clid: 'CLID123' });
      assert.deepStrictEqual(ev.custom_data, { currency: 'INR', value: 7080 });
      const s = await state(ctx.db, id);
      assert.strictEqual(s.meta_status, 'sent');
      assert.strictEqual(s.meta_event, 'Purchase');
      assert.ok(s.sent_to_meta_at);
      assert.strictEqual(await conversionsWorker.drain(), 0, 'never sent twice');
    });
  } finally { await ctx.cleanup(); }
});

test('without a click ID: skipped, unless a Page ID allows the hashed-phone match', async () => {
  const ctx = await setup();
  try {
    const first = await addOutcome(ctx.db, PLAIN_LEAD, 'visit_booked');
    await withCapi(async sent => {
      await conversionsWorker.drain();
      assert.strictEqual(sent.length, 0);
      assert.deepStrictEqual([(await state(ctx.db, first.id)).meta_status, (await state(ctx.db, first.id)).meta_error], ['skipped', 'no_ad_click_id']);
    });
    const second = await addOutcome(ctx.db, PLAIN_LEAD, 'visit_booked');
    await withCapi(async sent => {
      await conversionsWorker.drain();
      const [ev] = sent[0].data;
      assert.strictEqual(ev.event_name, 'QualifiedLead');
      assert.strictEqual(ev.user_data.page_id, 'PAGE1');
      assert.deepStrictEqual(ev.user_data.ph, [crypto.createHash('sha256').update(PLAIN_LEAD).digest('hex')]);
      assert.strictEqual(ev.custom_data, undefined);
      assert.strictEqual((await state(ctx.db, second.id)).meta_status, 'sent');
    }, { pageId: 'PAGE1' });
  } finally { await ctx.cleanup(); }
});

test('temporary Meta errors are retried; a bad request is not', async () => {
  const ctx = await setup();
  try {
    await ctx.db.query(`UPDATE leads SET metadata = jsonb_set(metadata, '{referral}', '{"ctwa_clid":"C1"}') WHERE wa_id = $1`, [AD_LEAD]);
    const flaky = await addOutcome(ctx.db, AD_LEAD, 'joined', { amount: 4040 });
    await withCapi(async () => {
      let calls = 0;
      conversionsApi.transport = async () => {
        calls++;
        if (calls === 1) throw Object.assign(new Error('boom'), { response: { status: 503, data: { error: { message: 'temporarily unavailable' } } } });
        return { events_received: 1 };
      };
      await conversionsWorker.drain(1);
      assert.strictEqual((await state(ctx.db, flaky.id)).meta_status, 'failed');
      await conversionsWorker.drain();
      const s = await state(ctx.db, flaky.id);
      assert.deepStrictEqual([s.meta_status, s.meta_attempts], ['sent', 2]);

      const bad = await addOutcome(ctx.db, AD_LEAD, 'visit_booked');
      conversionsApi.transport = async () => { throw Object.assign(new Error('400'), { response: { status: 400, data: { error: { message: 'Invalid parameter' } } } }); };
      await conversionsWorker.drain();
      const b = await state(ctx.db, bad.id);
      assert.deepStrictEqual([b.meta_status, b.meta_error], ['dead', 'Invalid parameter']);
      assert.strictEqual(await conversionsWorker.drain(), 0);
    });
  } finally { await ctx.cleanup(); }
});

test('outcomes older than 7 days are not sent (Meta would not attribute them)', async () => {
  const ctx = await setup();
  try {
    await ctx.db.query(`UPDATE leads SET metadata = jsonb_set(metadata, '{referral}', '{"ctwa_clid":"C1"}') WHERE wa_id = $1`, [AD_LEAD]);
    await addOutcome(ctx.db, AD_LEAD, 'joined', { amount: 4040, at: new Date(Date.now() - 9 * 86400000).toISOString() });
    await withCapi(async sent => {
      assert.strictEqual(await conversionsWorker.drain(), 0);
      assert.strictEqual(sent.length, 0);
    });
  } finally { await ctx.cleanup(); }
});

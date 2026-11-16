// R15 bot side: the Meta Purchase event carries the business's own currency.
const { setup } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const env = require('../../src/config/env');
const gymConfig = require('../../src/config/gymConfig');
const conversionsApi = require('../../src/services/conversionsApi');
const conversionsWorker = require('../../src/workers/conversionsWorker');

test('a Purchase for a dirham business is sent in AED, not INR', async () => {
  const ctx = await setup();
  const saved = { ds: env.metaDatasetId, waba: env.metaWabaId };
  try {
    gymConfig.setProfile({ ...gymConfig.profileFor(1), currency: 'AED' }, 1);
    const lead = '919845012345';
    await ctx.db.query(`UPDATE leads SET metadata = jsonb_set(metadata, '{referral}', '{"ctwa_clid":"CLID9"}') WHERE wa_id = $1`, [lead]);
    await ctx.db.query("INSERT INTO crm_lead_outcomes (wa_id, outcome, amount_inr, plan) VALUES ($1, 'joined', 950000, '2BR')", [lead]);
    Object.assign(env, { metaDatasetId: 'DS1', metaWabaId: 'WABA1' });
    const sent = [];
    conversionsApi.transport = async body => { sent.push(body); return { events_received: body.data.length }; };
    assert.strictEqual(await conversionsWorker.drain(), 1);
    assert.deepStrictEqual(sent[0].data[0].custom_data, { currency: 'AED', value: 950000 });
  } finally {
    conversionsApi.transport = null;
    Object.assign(env, { metaDatasetId: saved.ds, metaWabaId: saved.waba });
    gymConfig.resetToDefault(1);
    await ctx.cleanup();
  }
});

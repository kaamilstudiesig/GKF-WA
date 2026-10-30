const { db, reset, postWebhook } = require('./helpers');
const { test, describe, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert');
const { classify } = require('../src/services/metaErrors');
const opsAlerts = require('../src/services/opsAlerts');
const notifyService = require('../src/services/notifyService');
const whatsappService = require('../src/services/whatsappService');
const outboundRepository = require('../src/db/outboundRepository');
const leadRepository = require('../src/db/leadRepository');
const outboundWorker = require('../src/workers/outboundWorker');

after(() => db.close());
let alerts;
beforeEach(async () => {
  await reset();
  opsAlerts.reset();
  alerts = [];
  notifyService.sendOverride = async (text, opts) => { alerts.push({ text, ops: opts?.ops }); };
  await leadRepository.upsertInbound('919866660001', 'Asha');
});
afterEach(() => { notifyService.sendOverride = null; whatsappService.transport = null; delete process.env.OPS_ALERT_COOLDOWN_MINUTES; });

const tick = () => new Promise(r => setImmediate(r));
const metaError = (status, code, subcode) => Object.assign(new Error(`HTTP ${status}`), {
  response: { status, data: { error: { code, error_subcode: subcode, message: 'boom' } } }
});
const failSend = async (err, key) => {
  whatsappService.transport = async () => { throw err; };
  await outboundRepository.enqueue({ dedupKey: key, waId: '919866660001', text: 'hi' });
  await outboundWorker.drain();
  await tick();
};
const accountWebhook = (field, value) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA', changes: [{ field, value }] }]
});

describe('classifying Meta errors', () => {
  test('account, limit, message and transient errors', () => {
    assert.strictEqual(classify(metaError(400, 100, 33)).kind, 'account');
    assert.strictEqual(classify(metaError(401, 190)).kind, 'account');
    assert.strictEqual(classify(metaError(400, 131042)).kind, 'account');
    assert.strictEqual(classify(metaError(429, 130429)).kind, 'limit');
    assert.strictEqual(classify(metaError(400, 131047)).kind, 'message');
    assert.strictEqual(classify(metaError(400, 132001)).kind, 'message');
    assert.strictEqual(classify(new Error('ECONNRESET')).kind, 'transient');
    assert.strictEqual(classify({ code: 131026, title: 'Message undeliverable' }).kind, 'message');
  });
});

describe('alerts on failed sends', () => {
  test('a token that lost permissions alerts once, with the fix', async () => {
    await failSend(metaError(400, 100, 33), 'a1');
    await failSend(metaError(400, 100, 33), 'a2');
    assert.strictEqual(alerts.length, 1);
    assert.strictEqual(alerts[0].ops, true);
    assert.match(alerts[0].text, /WhatsApp replies are failing/);
    assert.match(alerts[0].text, /100\/33/);
    assert.match(alerts[0].text, /whatsapp_business_messaging/);
  });

  test('the same problem alerts again after the cooldown', async () => {
    process.env.OPS_ALERT_COOLDOWN_MINUTES = '0';
    await failSend(metaError(401, 190), 'b1');
    await failSend(metaError(401, 190), 'b2');
    assert.strictEqual(alerts.length, 2);
  });

  test('one closed 24h window does not alert', async () => {
    await failSend(metaError(400, 131047), 'c1');
    assert.strictEqual(alerts.length, 0);
  });

  test('three unexplained failures in 10 minutes alert once', async () => {
    for (const k of ['d1', 'd2']) await failSend(metaError(400, 999001), k);
    assert.strictEqual(alerts.length, 0);
    await failSend(metaError(400, 999001), 'd3');
    assert.strictEqual(alerts.length, 1);
    assert.match(alerts[0].text, /Several WhatsApp sends failed/);
  });
});

describe('alerts from Meta webhooks', () => {
  test('an account restriction alerts and is not treated as a message', async () => {
    const res = await postWebhook(accountWebhook('account_update', {
      phone_number: '919900000000', event: 'ACCOUNT_RESTRICTION', restriction_info: [{ restriction_type: 'RESTRICTED_BIZ_INITIATED_MESSAGING' }]
    }));
    assert.strictEqual(res.status, 200);
    await tick();
    assert.strictEqual(alerts.length, 1);
    assert.match(alerts[0].text, /needs attention/);
    assert.match(alerts[0].text, /ACCOUNT_RESTRICTION/);
    assert.strictEqual((await db.one('SELECT COUNT(*)::int AS n FROM webhook_events')).n, 0);
  });

  test('a quality upgrade is sent as info', async () => {
    await postWebhook(accountWebhook('phone_number_quality_update', { display_phone_number: '+91 99000 00000', event: 'UPGRADE', current_limit: 'TIER_10K' }));
    await tick();
    assert.match(alerts[0].text, /account update/);
    assert.match(alerts[0].text, /TIER_10K/);
  });

  test('a failed delivery for a payment problem alerts', async () => {
    await postWebhook({
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
        messaging_product: 'whatsapp', metadata: { phone_number_id: 'PNID_TEST' },
        statuses: [{ id: 'wamid.x', status: 'failed', errors: [{ code: 131042, title: 'Business eligibility payment issue' }] }]
      } }] }]
    });
    await tick();
    assert.strictEqual(alerts.length, 1);
    assert.match(alerts[0].text, /payment/i);
  });
});

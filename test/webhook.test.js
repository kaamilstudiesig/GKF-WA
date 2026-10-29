const { db, getApp, request, inbound, postWebhook, sign, reset } = require('./helpers');
const { test, describe, beforeEach, after } = require('node:test');
const assert = require('node:assert');

after(() => db.close());
beforeEach(() => reset());

const eventCount = async () => (await db.one('SELECT COUNT(*)::int AS n FROM webhook_events')).n;

describe('GET /webhook (Meta verification)', () => {
  test('echoes the challenge when the token matches', async () => {
    const res = await request(getApp()).get('/webhook')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'test_verify_token', 'hub.challenge': 'abc123' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.text, 'abc123');
  });

  test('rejects a wrong token and missing parameters', async () => {
    const bad = await request(getApp()).get('/webhook').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '1' });
    assert.strictEqual(bad.status, 403);
    assert.strictEqual((await request(getApp()).get('/webhook')).status, 400);
  });
});

describe('POST /webhook', () => {
  test('requires a valid Meta signature', async () => {
    const body = JSON.stringify(inbound({ from: '919811111111', text: 'hi' }));
    const missing = await request(getApp()).post('/webhook').set('Content-Type', 'application/json').send(body);
    assert.strictEqual(missing.status, 401);
    const wrong = await request(getApp()).post('/webhook').set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body + ' ')).send(body);
    assert.strictEqual(wrong.status, 403);
    assert.strictEqual(await eventCount(), 0);
  });

  test('queues a valid message once, even when Meta delivers it twice', async () => {
    const payload = inbound({ from: '919811111112', text: 'hello', id: 'wamid.dup1' });
    assert.strictEqual((await postWebhook(payload)).status, 200);
    assert.strictEqual((await postWebhook(payload)).status, 200);
    assert.strictEqual(await eventCount(), 1);
    const ev = await db.one('SELECT * FROM webhook_events');
    assert.strictEqual(ev.wa_id, '919811111112');
    assert.strictEqual(ev.payload.msg.text.body, 'hello');
    assert.strictEqual(ev.payload.contact.profile.name, 'Test Lead');
  });

  test('splits a batch from different senders into separate events with the right contact', async () => {
    await postWebhook(inbound([
      { from: '919811111113', text: 'a', name: 'Asha' },
      { from: '919811111114', text: 'b', name: 'Bala' }
    ]));
    const rows = await db.many('SELECT wa_id, payload FROM webhook_events ORDER BY id');
    assert.deepStrictEqual(rows.map(r => [r.wa_id, r.payload.contact.profile.name]), [['919811111113', 'Asha'], ['919811111114', 'Bala']]);
  });

  test('ignores traffic for a different WhatsApp number', async () => {
    await postWebhook(inbound({ from: '919811111115', text: 'hi' }, { phoneNumberId: 'SOMEONE_ELSE' }));
    assert.strictEqual(await eventCount(), 0);
  });

  test('does not store delivery receipts', async () => {
    const res = await postWebhook({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ value: { metadata: { phone_number_id: 'PNID_TEST' }, statuses: [{ id: 'wamid.x', status: 'delivered', recipient_id: '91981' }] } }] }]
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(await eventCount(), 0);
  });

  test('rejects non-WhatsApp objects and bad JSON', async () => {
    assert.strictEqual((await postWebhook({ object: 'page', entry: [] })).status, 404);
    const body = '{not json';
    const res = await request(getApp()).post('/webhook').set('Content-Type', 'application/json').set('X-Hub-Signature-256', sign(body)).send(body);
    assert.strictEqual(res.status, 400);
  });
});

describe('health and headers', () => {
  test('health endpoints report ok and ready', async () => {
    assert.strictEqual((await request(getApp()).get('/health')).body.status, 'ok');
    const ready = await request(getApp()).get('/health/ready');
    assert.strictEqual(ready.status, 200);
    assert.strictEqual(ready.body.database, 'connected');
  });

  test('sets security headers and hides the framework', async () => {
    const res = await request(getApp()).get('/');
    assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
    assert.strictEqual(res.headers['x-frame-options'], 'DENY');
    assert.strictEqual(res.headers['x-powered-by'], undefined);
  });

  test('the old demo and leads API are gone', async () => {
    for (const p of ['/demo', '/leads', '/dashboard/summary']) {
      assert.strictEqual((await request(getApp()).get(p)).status, 404, p);
    }
  });
});

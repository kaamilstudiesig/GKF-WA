const { db, reset } = require('./helpers');
const { test, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert');
const outboundRepository = require('../src/db/outboundRepository');
const leadRepository = require('../src/db/leadRepository');
const outboundWorker = require('../src/workers/outboundWorker');
const whatsappService = require('../src/services/whatsappService');

after(() => db.close());
beforeEach(async () => { await reset(); await leadRepository.upsertInbound('919844444401', 'Neha'); });
afterEach(() => { whatsappService.transport = null; });

const httpError = status => Object.assign(new Error(`HTTP ${status}`), { response: { status, data: { error: { code: status } } } });

test('classifies which send errors are worth retrying', () => {
  assert.strictEqual(outboundWorker.isRetryable(new Error('ETIMEDOUT')), true);
  assert.strictEqual(outboundWorker.isRetryable(httpError(429)), true);
  assert.strictEqual(outboundWorker.isRetryable(httpError(503)), true);
  assert.strictEqual(outboundWorker.isRetryable(httpError(400)), false);
});

test('a live send posts the right payload and records the message', async () => {
  const sent = [];
  whatsappService.transport = async payload => { sent.push(payload); return { messages: [{ id: 'wamid.real1' }] }; };
  await outboundRepository.enqueue({ dedupKey: 'k1', waId: '919844444401', text: 'Hello Neha' });
  await outboundWorker.drain();
  assert.deepStrictEqual(sent[0].text, { preview_url: false, body: 'Hello Neha' });
  assert.strictEqual(sent[0].to, '919844444401');
  const row = await db.one(`SELECT status, provider_message_id FROM outbound_messages WHERE dedup_key = 'k1'`);
  assert.deepStrictEqual(row, { status: 'sent', provider_message_id: 'wamid.real1' });
  const msg = await db.one(`SELECT direction, text, message_id FROM messages WHERE wa_id = '919844444401'`);
  assert.deepStrictEqual(msg, { direction: 'out', text: 'Hello Neha', message_id: 'wamid.real1' });
});

test('a 400 from Meta (e.g. 24h window closed) fails without retrying', async () => {
  whatsappService.transport = async () => { throw httpError(400); };
  await outboundRepository.enqueue({ dedupKey: 'k2', waId: '919844444401', text: 'late reply' });
  await outboundWorker.drain();
  const row = await db.one(`SELECT status, attempts FROM outbound_messages WHERE dedup_key = 'k2'`);
  assert.deepStrictEqual(row, { status: 'failed', attempts: 1 });
});

test('a 503 is retried later and then succeeds', async () => {
  let n = 0;
  whatsappService.transport = async () => { if (n++ === 0) throw httpError(503); return { messages: [{ id: 'wamid.ok' }] }; };
  await outboundRepository.enqueue({ dedupKey: 'k3', waId: '919844444401', text: 'retry me' });
  await outboundWorker.drain();
  let row = await db.one(`SELECT status FROM outbound_messages WHERE dedup_key = 'k3'`);
  assert.strictEqual(row.status, 'pending');
  await db.query(`UPDATE outbound_messages SET available_at = now() WHERE dedup_key = 'k3'`);
  await outboundWorker.drain();
  row = await db.one(`SELECT status, attempts FROM outbound_messages WHERE dedup_key = 'k3'`);
  assert.deepStrictEqual(row, { status: 'sent', attempts: 2 });
});

test('enqueueing is idempotent on the dedup key', async () => {
  assert.ok(await outboundRepository.enqueue({ dedupKey: 'same', waId: '919844444401', text: 'a' }));
  assert.strictEqual(await outboundRepository.enqueue({ dedupKey: 'same', waId: '919844444401', text: 'a' }), null);
});

test('marks inbound messages read with a typing indicator when live', async () => {
  const sent = [];
  whatsappService.transport = async p => { sent.push(p); return {}; };
  await whatsappService.markReadWithTyping('wamid.in1');
  assert.deepStrictEqual(sent[0], { messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.in1', typing_indicator: { type: 'text' } });
});

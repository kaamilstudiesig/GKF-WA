const { db, postWebhook, inbound, drainAll, reset } = require('./helpers');
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const outboundRepository = require('../src/db/outboundRepository');
const signals = require('../src/workers/signals');
require('../src/workers/outboundWorker');

after(() => db.close());
beforeEach(() => reset());

const repliesTo = async waId => (await db.one('SELECT COUNT(*)::int AS n FROM outbound_messages WHERE wa_id = $1', [waId])).n;

test('a burst of texts from one lead gets one reply', async () => {
  const from = '919811100001';
  await postWebhook(inbound([{ from, text: 'hi' }, { from, text: 'I am a beginner, what time do you open and how much is it' }]));
  await drainAll();
  assert.strictEqual(await repliesTo(from), 1);
  const saved = await db.one("SELECT COUNT(*)::int AS n FROM messages WHERE wa_id = $1 AND direction = 'in'", [from]);
  assert.strictEqual(saved.n, 2); // both messages are kept for staff and the AI
});

test('separate messages still get separate replies', async () => {
  const from = '919811100002';
  await postWebhook(inbound({ from, text: 'hi' }));
  await drainAll();
  await postWebhook(inbound({ from, text: 'what are the timings' }));
  await drainAll();
  assert.strictEqual(await repliesTo(from), 2);
});

test('replies to one lead go out one at a time, oldest first', async () => {
  const waId = '919811100003';
  await db.query("INSERT INTO leads (wa_id, status) VALUES ($1, 'new'), ('919811100004', 'new')", [waId]);
  await outboundRepository.enqueue({ dedupKey: 'o1', waId, text: 'first', metadata: {} });
  await outboundRepository.enqueue({ dedupKey: 'o2', waId, text: 'second', metadata: {} });
  await outboundRepository.enqueue({ dedupKey: 'o3', waId: '919811100004', text: 'other lead', metadata: {} });

  const a = await outboundRepository.claimNext();
  assert.strictEqual(a.text, 'first');
  const b = await outboundRepository.claimNext();
  assert.strictEqual(b.text, 'other lead'); // other leads are not held up
  assert.strictEqual(await outboundRepository.claimNext(), null); // 'second' waits for 'first'
  await outboundRepository.markSent(a.id);
  assert.strictEqual((await outboundRepository.claimNext()).text, 'second');
});

test('queued staff replies wake the sender instead of waiting for a poll', () => {
  assert.ok(signals.listenerCount('outbound') >= 1);
});

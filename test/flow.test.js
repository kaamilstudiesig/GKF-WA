const { db, inbound, postWebhook, converse, drainAll, reset } = require('./helpers');
const { test, describe, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const eventRepository = require('../src/db/eventRepository');
const webhookWorker = require('../src/workers/webhookWorker');
const notifyService = require('../src/services/notifyService');

after(() => db.close());
beforeEach(() => reset());

const lead = waId => db.one('SELECT * FROM leads WHERE wa_id = $1', [waId]);
const chat = waId => db.many('SELECT direction, text FROM messages WHERE wa_id = $1 ORDER BY timestamp, id', [waId]);

describe('end-to-end conversation (offline AI)', () => {
  test('a new lead gets a reply that is sent and stored', async () => {
    await converse('919822222201', 'Hi, I want to get fit', { name: 'Ravi' });
    const l = await lead('919822222201');
    assert.strictEqual(l.display_name, 'Ravi');
    assert.strictEqual(l.status, 'contacted');
    assert.ok(l.last_outbound_message_at);
    const msgs = await chat('919822222201');
    assert.deepStrictEqual(msgs.map(m => m.direction), ['in', 'out']);
    const out = await db.one(`SELECT status FROM outbound_messages WHERE wa_id = '919822222201'`);
    assert.strictEqual(out.status, 'sent');
  });

  test('opening hours are answered by a fixed reply without the AI', async () => {
    await converse('919822222202', 'What are your gym timings?');
    const msgs = await chat('919822222202');
    assert.match(msgs[1].text, /5:00 AM/);
    assert.strictEqual((await db.one('SELECT COUNT(*)::int AS n FROM ai_usage')).n, 0);
  });

  test('medical questions get a safe disclaimer and a staff hand-off', async () => {
    await converse('919822222203', 'I have a herniated disc, can I train?');
    const msgs = await chat('919822222203');
    assert.match(msgs[1].text, /do not diagnose injuries/);
    const l = await lead('919822222203');
    assert.strictEqual(l.needs_human, true);
    assert.strictEqual(l.handoff_reason, 'injury_question');
    assert.strictEqual((await db.one(`SELECT reason FROM handoffs WHERE wa_id = '919822222203'`)).reason, 'injury_question');
  });

  test('images and other media get a polite fallback reply', async () => {
    await converse('919822222204', null, { type: 'image', extra: { image: { id: 'media1' } } });
    const msgs = await chat('919822222204');
    assert.strictEqual(msgs[0].text, '[IMAGE message]');
    assert.match(msgs[1].text, /received your attachment/);
  });

  test('button taps are treated as text', async () => {
    await converse('919822222205', null, { type: 'button', extra: { button: { text: 'Book free trial', payload: 'trial' } } });
    const msgs = await chat('919822222205');
    assert.strictEqual(msgs[0].text, 'Book free trial');
    assert.strictEqual((await lead('919822222205')).status, 'hot');
  });

  test('ad details are saved and staff are alerted once per hand-off', async () => {
    const alerts = [];
    notifyService.sendOverride = async text => { alerts.push(text); };
    try {
      await converse('919822222206', 'I want to book a free trial', {
        referral: { source_url: 'https://www.instagram.com/p/x', source_id: 'AD9', headline: '3-day free trial' }
      });
      await converse('919822222206', 'can I book trial tomorrow?');
      await new Promise(r => setImmediate(r));
      const l = await lead('919822222206');
      assert.strictEqual(l.source, 'instagram_ad');
      assert.strictEqual(l.metadata.referral.headline, '3-day free trial');
      assert.strictEqual(alerts.length, 1);
      assert.match(alerts[0], /3-day free trial/);
    } finally {
      notifyService.sendOverride = null;
    }
  });
});

describe('queue reliability', () => {
  test('a replayed event does not send a second reply', async () => {
    await converse('919822222210', 'hello', { id: 'wamid.replay' });
    // Simulate a crash after the reply was queued: the event is processed again.
    await db.query(`UPDATE webhook_events SET status = 'pending' WHERE message_id = 'wamid.replay'`);
    await drainAll();
    const outs = await db.many(`SELECT * FROM outbound_messages WHERE wa_id = '919822222210'`);
    assert.strictEqual(outs.length, 1);
  });

  test('messages from one lead are handled in order, other leads in parallel', async () => {
    await postWebhook(inbound([{ from: '919822222211', text: 'first' }]));
    await postWebhook(inbound([{ from: '919822222211', text: 'second' }]));
    await postWebhook(inbound([{ from: '919822222212', text: 'other lead' }]));
    const a = await eventRepository.claimNext();
    const b = await eventRepository.claimNext();
    const c = await eventRepository.claimNext();
    assert.strictEqual(a.payload.msg.text.body, 'first');
    assert.strictEqual(b.payload.msg.text.body, 'other lead'); // 'second' must wait for 'first'
    assert.strictEqual(c, null);
    await eventRepository.complete(a.id);
    const d = await eventRepository.claimNext();
    assert.strictEqual(d.payload.msg.text.body, 'second');
  });

  test('a failing event is retried with backoff and parked after max attempts', async () => {
    await postWebhook(inbound({ from: '919822222213', text: 'hi' }));
    const ev = await eventRepository.claimNext();
    await eventRepository.fail(ev.id, 'temporary', 5);
    let row = await db.one('SELECT status, available_at FROM webhook_events WHERE id = $1', [ev.id]);
    assert.strictEqual(row.status, 'pending');
    assert.ok(new Date(row.available_at) > new Date());
    assert.strictEqual(await eventRepository.claimNext(), null); // not ready yet

    await db.query('UPDATE webhook_events SET attempts = max_attempts WHERE id = $1', [ev.id]);
    await eventRepository.fail(ev.id, 'still broken', 0);
    row = await db.one('SELECT status FROM webhook_events WHERE id = $1', [ev.id]);
    assert.strictEqual(row.status, 'dead_letter');
  });

  test('work held by a crashed worker is picked up again after the lock goes stale', async () => {
    await postWebhook(inbound({ from: '919822222214', text: 'hi' }));
    const ev = await eventRepository.claimNext();
    assert.strictEqual(await eventRepository.claimNext(), null);
    await db.query(`UPDATE webhook_events SET locked_at = now() - interval '10 minutes' WHERE id = $1`, [ev.id]);
    const again = await eventRepository.claimNext();
    assert.strictEqual(again.id, ev.id);
    assert.strictEqual(again.attempts, 2);
  });

  test('housekeeping removes old finished queue rows but keeps dead letters', async () => {
    await converse('919822222215', 'hello');
    await db.query(`UPDATE webhook_events SET updated_at = now() - interval '30 days'`);
    await db.query(`INSERT INTO webhook_events (event_key, payload, status, updated_at) VALUES ('dead', '{}'::jsonb, 'dead_letter', now() - interval '30 days')`);
    assert.strictEqual(await eventRepository.cleanup(14), 1);
    assert.strictEqual((await db.one('SELECT COUNT(*)::int AS n FROM webhook_events')).n, 1);
  });

  test('a malformed event is marked failed rather than retried forever', async () => {
    await db.query(`INSERT INTO webhook_events (event_key, payload) VALUES ('bad', '{}'::jsonb)`);
    await webhookWorker.drain();
    assert.strictEqual((await db.one(`SELECT status FROM webhook_events WHERE event_key = 'bad'`)).status, 'failed');
  });
});

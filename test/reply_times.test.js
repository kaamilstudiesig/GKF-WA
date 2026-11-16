// K27 reply time: automatic replies only, from when we received the lead's message to dispatch.
const { db, converse, reset } = require('./helpers');
const { test, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert');
const tenancy = require('../src/tenancy/context');
const replyTimes = require('../src/services/replyTimes');
const clientMonth = require('../src/services/clientMonth');
const whatsappService = require('../src/services/whatsappService');
const outboundRepository = require('../src/db/outboundRepository');
const outboundWorker = require('../src/workers/outboundWorker');

const LEAD = '919877700201';
const rows = () => tenancy.runAsSystem(() => db.many('SELECT * FROM reply_times ORDER BY outbound_id'));

beforeEach(async () => {
  await reset();
  await tenancy.runAsSystem(() => db.query('DELETE FROM reply_times'));
  clientMonth._cache.clear();
  whatsappService.transport = async () => ({ messages: [{ id: 'wamid.r' }] });
});
afterEach(() => { whatsappService.transport = null; });
after(() => db.close());

test('a bot reply records its reply time; staff replies and templates do not', async () => {
  await converse(LEAD, 'hi');
  const r = await rows();
  assert.strictEqual(r.length, 1);
  assert.ok(r[0].reply_ms >= 0 && r[0].reply_ms < 30000, `reply_ms ${r[0].reply_ms}`);
  assert.ok(new Date(r[0].sent_at) >= new Date(r[0].received_at));

  await tenancy.run(1, async () => {
    await outboundRepository.enqueue({ dedupKey: 'staff:r1', waId: LEAD, text: 'Hi, this is Riya from the team' });
    await outboundRepository.enqueue({ dedupKey: 'tpl:r1', waId: LEAD, text: '[template]', metadata: { template: { name: 'welcome', body: [] } } });
  });
  await outboundWorker.drain();
  assert.strictEqual((await rows()).length, 1);
});

test('the month: 95% within 30 s and the 95th percentile', async () => {
  await tenancy.run(1, async () => {
    const sent = new Date();
    for (let i = 1; i <= 20; i++) {
      const ms = i === 20 ? 60000 : 2000;
      await db.query('INSERT INTO reply_times (outbound_id, received_at, sent_at, reply_ms) VALUES ($1, $2, $3, $4)',
        [i, new Date(sent.getTime() - ms), sent, ms]);
    }
    const s = await replyTimes.monthStats();
    assert.strictEqual(s.replies, 20);
    assert.strictEqual(s.withinTargetPct, 95);
    assert.strictEqual(s.p95Ms, 2000);
    const empty = await replyTimes.monthStats({ month: '2020-01' });
    assert.deepStrictEqual([empty.replies, empty.p95Ms, empty.withinTargetPct], [0, null, null]);
  });
  const all = await replyTimes.allClients((await tenancy.run(1, () => clientMonth.current())));
  assert.strictEqual(all[0].replies, 20);
  await assert.rejects(replyTimes.allClients('Nov'), /YYYY-MM/);
});

test('months follow the client\'s time zone', () => {
  const { start, end } = clientMonth.monthRange('2026-11', 'Asia/Kolkata');
  assert.strictEqual(start.toISOString(), '2026-10-31T18:30:00.000Z');
  assert.strictEqual(end.toISOString(), '2026-11-30T18:30:00.000Z');
  assert.strictEqual(clientMonth.monthRange('2026-12', 'Asia/Dubai').end.toISOString(), '2026-12-31T20:00:00.000Z');
  assert.strictEqual(clientMonth.monthOf(new Date('2026-11-30T19:00:00Z'), 'Asia/Kolkata'), '2026-12');
  assert.throws(() => clientMonth.monthRange('2026/11', 'Asia/Kolkata'), /YYYY-MM/);
  assert.throws(() => clientMonth.monthRange('2026-13', 'Asia/Kolkata'), /YYYY-MM/);
  assert.throws(() => clientMonth.monthRange('2026-00', 'Asia/Kolkata'), /YYYY-MM/);
});

test('a reply that fails for good counts as a miss, so an outage cannot flatter the figure', async () => {
  // markRead and the reply both go through the transport; the reply send gets a permanent 400.
  whatsappService.transport = async p => {
    if (p.status !== 'read') throw Object.assign(new Error('bad request'), { response: { status: 400, data: { error: { message: 'bad' } } } });
    return { messages: [{ id: 'wamid.r' }] };
  };
  await converse(LEAD, 'hi');
  const r = await rows();
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].outcome, 'failed');
  const s = await tenancy.run(1, () => replyTimes.monthStats());
  assert.deepStrictEqual([s.replies, s.failed, s.withinTargetPct, s.p95Ms], [1, 1, 0, null]);
});

test('a missing message never breaks sending', async () => {
  const ms = await tenancy.run(1, () => replyTimes.record({ id: 999, metadata: { in_reply_to: 'wamid.unknown' } }));
  assert.strictEqual(ms, null);
});

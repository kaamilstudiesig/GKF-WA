// K30 opt-out: STOP marks the lead, gets a fixed reply (no AI), and blocks templates.
const { db, converse, reset } = require('./helpers');
const { test, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert');
const optOut = require('../src/services/optOut');
const whatsappService = require('../src/services/whatsappService');
const aiService = require('../src/services/aiService');
const outboundRepository = require('../src/db/outboundRepository');
const outboundWorker = require('../src/workers/outboundWorker');
const leadRepository = require('../src/db/leadRepository');

const LEAD = '919877700001';
let sent;
let aiCalls;
let savedReply;

const optedOut = async (waId = LEAD) => (await db.one('SELECT opted_out_at FROM leads WHERE wa_id = $1', [waId])).opted_out_at;
const lastOut = async (waId = LEAD) => db.one('SELECT text, status, metadata FROM outbound_messages WHERE wa_id = $1 ORDER BY id DESC LIMIT 1', [waId]);

beforeEach(async () => {
  await reset();
  sent = [];
  aiCalls = 0;
  whatsappService.transport = async p => { sent.push(p); return { messages: [{ id: `wamid.o${sent.length}` }] }; };
  savedReply = aiService.reply;
  aiService.reply = async function (...args) { aiCalls++; return savedReply.apply(this, args); };
});
afterEach(() => { whatsappService.transport = null; aiService.reply = savedReply; });
after(() => db.close());

test('STOP, UNSUBSCRIBE and "don\'t message me" in each language are opt-outs; everyday text is not', () => {
  for (const t of ['STOP', 'Stop.', 'unsubscribe', 'Opt out', "please don't message me again", 'Stop sending me these messages',
    'mujhe message mat karo', 'message mat bhejo', 'मुझे मैसेज मत करो', 'ನಿಲ್ಲಿಸಿ', 'ಮೆಸೇಜ್ ಮಾಡಬೇಡಿ', 'توقف', 'لا ترسل لي']) {
    assert.strictEqual(optOut.classify(t), 'stop', t);
  }
  assert.strictEqual(optOut.classify('START'), 'start');
  for (const t of ['can you stop by tomorrow?', 'what time do you stop serving?', 'I want to stop my membership', 'remove my number',
    'band hai kya gym sunday ko?', 'hi', 'ok thanks', 'how much is the stop and shop membership', '']) {
    assert.strictEqual(optOut.classify(t), null, t);
  }
  assert.strictEqual(optOut.languageOf('mujhe message mat karo'), 'hi');
  assert.strictEqual(optOut.languageOf('ನಿಲ್ಲಿಸಿ'), 'kn');
  assert.strictEqual(optOut.languageOf('توقف'), 'ar');
});

test('STOP marks the lead, sends a fixed confirmation in their language, and never calls the AI', async () => {
  await converse(LEAD, 'hi');
  const before = aiCalls;
  await converse(LEAD, 'mujhe message mat karo');
  assert.ok(await optedOut());
  const out = await lastOut();
  assert.strictEqual(out.text, optOut.REPLIES.stop.hi);
  assert.strictEqual(out.metadata.opt_out, 'stop');
  assert.strictEqual(aiCalls, before);
});

test('templates to an opted-out lead are refused without retries or alerts; START opts back in', async () => {
  await converse(LEAD, 'STOP');
  assert.ok(await optedOut());
  await assert.rejects(whatsappService.sendTemplate(LEAD, { name: 'welcome', body: [] }), err => err.optedOut === true);

  // Through the queue: marked failed for good, nothing sent.
  const id = await outboundRepository.enqueue({ dedupKey: 'tpl:1', waId: LEAD, text: '[template welcome]', metadata: { template: { name: 'welcome', body: [] } } });
  const before = sent.length;
  await outboundWorker.drain();
  assert.strictEqual(sent.length, before);
  const job = await db.one("SELECT status, attempts, last_error FROM outbound_messages WHERE dedup_key = 'tpl:1'");
  assert.strictEqual(job.status, 'failed');
  assert.match(job.last_error, /opted out/);
  assert.ok(id !== undefined);

  await converse(LEAD, 'START');
  assert.strictEqual(await optedOut(), null);
  assert.strictEqual((await lastOut()).text, optOut.REPLIES.start.en);
  await whatsappService.sendTemplate(LEAD, { name: 'welcome', body: [] }); // allowed again
});

test('any new message from an opted-out lead opts them back in and gets a normal reply', async () => {
  await converse(LEAD, 'Unsubscribe');
  assert.ok(await optedOut());
  await converse(LEAD, 'what are your timings?');
  assert.strictEqual(await optedOut(), null);
  const out = await lastOut();
  assert.notStrictEqual(out.text, optOut.REPLIES.stop.en);
  assert.ok(!out.metadata.opt_out);
});

test('START from a lead who never opted out is just a normal message', async () => {
  await converse(LEAD, 'start');
  const out = await lastOut();
  assert.ok(!out.metadata.opt_out);
  assert.strictEqual(await optedOut(), null);
});

test('isOptedOut finds a lead by phone when their key is a business-scoped user id', async () => {
  await db.query(`INSERT INTO leads (wa_id, phone, status, opted_out_at) VALUES ('IN.12345678901234', '919877700009', 'new', now())`);
  assert.strictEqual(await leadRepository.isOptedOut('919877700009'), true);
  assert.strictEqual(await leadRepository.isOptedOut('919877700010'), false);
});

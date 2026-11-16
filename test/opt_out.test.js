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

test('reviewed opt-out wording is recognized with the right reply language', () => {
  const phrasesByLanguage = {
    kn: [
      'ನನಗೆ ಮೆಸೇಜ್ ಬೇಡ', 'ಸಂದೇಶಗಳನ್ನು ಕಳುಹಿಸಬೇಡಿ', 'ಮೆಸೇಜ್ ಕಳಿಸ್ಬೇಡಿ',
      'nanage message beda', 'message kalisabedi', 'msg maadabedi'
    ],
    hi: ['msg mt kro', 'msg mat bhejiye', 'message band kar do', 'मैसेज मत भेजिए', 'मैसेज नहीं चाहिए'],
    ar: ['ما أبي رسايل', 'ما أبغى رسائل', 'وقفوا الرسايل', 'شيلوني من القائمة', 'لا عاد ترسل']
  };
  for (const [language, phrases] of Object.entries(phrasesByLanguage)) {
    for (const t of phrases) {
      assert.strictEqual(optOut.classify(t), 'stop', t);
      assert.strictEqual(optOut.languageOf(t), language, t);
    }
  }
});

test('cancel and instructions about a specific item are not opt-outs', () => {
  for (const t of ['الغاء', 'إلغاء', 'paise mat bhejo', 'paise na bhejo', 'पैसे मत भेजो',
    'لا ترسل الفاتورة الآن', 'لا ترسل', 'لا ترسل ليث',
    'لا ترسل لي الفاتورة', 'لا ترسل لي الفاتورة الآن', 'لا ترسلوا لي الفاتورة الآن',
    'لا ترسل رسالة الغاء', 'لا ترسل لي رسالة الغاء', 'لا ترسل لي رسائل الفاتورة الآن',
    'please paise mat bhejo', 'कृपया पैसे मत भेजो',
    'message bedazzled', 'ಮೆಸೇಜ್ ಬೇಡಿಕೆ', 'मैसेज नहीं चाहिएगा']) {
    assert.strictEqual(optOut.classify(t), null, t);
  }
});

test('clear Hindi and Kannada opt-outs allow prefixes and suffixes', () => {
  const phrasesByLanguage = {
    hi: ['please msg mt kro', 'msg mat bhejiye please', 'mujhe message band kar do',
      'कृपया मैसेज मत भेजिए', 'मैसेज नहीं चाहिए अब', 'आगे मत भेजो', 'please aage mat bhejo'],
    kn: ['ದಯವಿಟ್ಟು ನನಗೆ ಮೆಸೇಜ್ ಬೇಡ', 'ದಯವಿಟ್ಟು ಸಂದೇಶಗಳನ್ನು ಕಳುಹಿಸಬೇಡಿ', 'ಮೆಸೇಜ್ ಕಳಿಸ್ಬೇಡಿ ದಯವಿಟ್ಟು',
      'please nanage message beda', 'message kalisabedi please', 'please msg maadabedi', 'msg beda please']
  };
  for (const [language, phrases] of Object.entries(phrasesByLanguage)) {
    for (const t of phrases) {
      assert.strictEqual(optOut.classify(t), 'stop', t);
      assert.strictEqual(optOut.languageOf(t), language, t);
    }
  }
  assert.notStrictEqual(optOut.languageOf('beda'), 'kn');
  assert.notStrictEqual(optOut.languageOf('hello beda'), 'kn');
});

test('Arabic send-me commands accept only message or again endings', () => {
  for (const t of ['لا ترسل لي رسائل', 'لا ترسلوا لي رسايل', 'لا ترسل لي مرة ثانية',
    'لا ترسلوا لي ثاني', 'لا ترسل لي بعد الآن', 'لا ترسل لي رسائل مرة ثانية',
    'لا ترسلوا لي رسايل بعد الآن', 'لا ترسل لي رسالة', 'لا ترسلوا رسالة', 'لا ترسل لي!']) {
    assert.strictEqual(optOut.classify(t), 'stop', t);
  }
});

test('bare stop commands, subscription cancellation and Arabic message objects remain opt-outs', () => {
  for (const t of ['mat bhejo', 'na bhejo', 'मत भेजो', 'band karo', 'बंद करो', 'ನಿಲ್ಲಿಸಿ', 'ನಿಲ್ಲಿಸು', 'توقف', 'قف',
    'الغاء الاشتراك', 'إلغاء الاشتراك', 'لا ترسل لي', 'لا ترسل رسائل', 'لا ترسل رسايل', 'لا ترسل رسالة',
    'لا ترسلوا لي', 'لا تراسلني', 'لا تراسلوني']) {
    assert.strictEqual(optOut.classify(t), 'stop', t);
  }
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

test('"ok" or 👍 after STOP keeps the opt-out and gets no reply; a real question opts back in', async () => {
  await converse(LEAD, 'STOP');
  const count = async () => (await db.one('SELECT COUNT(*)::int AS n FROM outbound_messages WHERE wa_id = $1', [LEAD])).n;
  const n = await count();
  await converse(LEAD, 'ok thanks');
  await converse(LEAD, '👍');
  assert.ok(await optedOut());
  assert.strictEqual(await count(), n);
  await converse(LEAD, 'what are your prices?');
  assert.strictEqual(await optedOut(), null);
  assert.strictEqual(await count(), n + 1);
});

test('staff alerts still reach a staff number that once wrote STOP as a lead', async () => {
  await converse(LEAD, 'STOP');
  await whatsappService.sendTemplate(LEAD, { name: 'staff_lead_alert', body: [] }, { staffAlert: true });
  await outboundRepository.enqueue({ dedupKey: 'staff:1', waId: LEAD, text: '[staff alert]', metadata: { template: { name: 'staff_lead_alert', body: [] }, staff_alert: { event: 'handoff' } } });
  await outboundWorker.drain();
  assert.strictEqual((await db.one("SELECT status FROM outbound_messages WHERE dedup_key = 'staff:1'")).status, 'sent');
});

test('a reply queued before the lead wrote STOP is dropped, not sent after the confirmation', async () => {
  await converse(LEAD, 'hi');
  await db.query(`INSERT INTO outbound_messages (dedup_key, wa_id, text, status, metadata, created_at)
    VALUES ('late:1', $1, 'Hi! How can we help?', 'pending', '{}', now() - interval '1 minute')`, [LEAD]);
  await leadRepository.setOptedOut(LEAD, true);
  const before = sent.length;
  await outboundWorker.drain();
  const job = await db.one("SELECT status, last_error FROM outbound_messages WHERE dedup_key = 'late:1'");
  assert.strictEqual(job.status, 'failed');
  assert.match(job.last_error, /opted out after this reply was queued/);
  assert.ok(!sent.slice(before).some(p => p.text?.body === 'Hi! How can we help?'));
});

test('a button tap titled "Stop" is not an opt-out (only typed text counts)', async () => {
  await converse(LEAD, 'hi');
  const { postWebhook, inbound, drainAll } = require('./helpers');
  await postWebhook(inbound({ from: LEAD, type: 'button', extra: { button: { text: 'Stop', payload: 'stop' } } }));
  await drainAll();
  assert.strictEqual(await optedOut(), null);
});

test('Kannada and Arabic STOP get a confirmation in that language', async () => {
  await converse(LEAD, 'ಮೆಸೇಜ್ ಮಾಡಬೇಡಿ');
  assert.ok(await optedOut());
  assert.strictEqual((await lastOut()).text, optOut.REPLIES.stop.kn);
  const AR = '971500000071';
  await converse(AR, 'توقف');
  assert.ok(await optedOut(AR));
  assert.strictEqual((await lastOut(AR)).text, optOut.REPLIES.stop.ar);
});

const { db, converse, reset } = require('./helpers');
const { test, describe, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert');
const env = require('../src/config/env');
const router = require('../src/services/deterministicRouter');
const whatsappService = require('../src/services/whatsappService');

after(() => db.close());
beforeEach(() => reset());

const chat = waId => db.many('SELECT direction, text FROM messages WHERE wa_id = $1 ORDER BY timestamp, id', [waId]);
// Inbound timestamps come from Meta in whole seconds, so count directions instead of relying on order.
const count = (msgs, dir) => msgs.filter(m => m.direction === dir).length;
const aiCalls = async () => (await db.one('SELECT COUNT(*)::int AS n FROM ai_usage')).n;

describe('fixed answers in English, Hinglish and Kannada', () => {
  test('detects the language of a message', () => {
    assert.strictEqual(router.detectLanguage('what are your prices'), 'en');
    assert.strictEqual(router.detectLanguage('fees kitni hai bhai'), 'hi');
    assert.strictEqual(router.detectLanguage('gym yelli ide'), 'kn');
    assert.strictEqual(router.detectLanguage('ಬೆಲೆ ಎಷ್ಟು'), 'kn');
  });

  test('prices are answered in the lead\'s language without the AI', () => {
    const en = router.routeMessage('what are your prices?');
    assert.strictEqual(en.intent, 'prices');
    assert.match(en.replyText, /₹4,040/);
    assert.match(router.routeMessage('fees kitni hai?').replyText, /Aapka main goal kya hai/);
    assert.match(router.routeMessage('ಬೆಲೆ ಎಷ್ಟು?').replyText, /ಸದಸ್ಯತ್ವ/);
  });

  test('hours and location have Hinglish and Kannada versions', () => {
    assert.match(router.routeMessage('gym kitne baje khulta hai').replyText, /ki timings/);
    assert.match(router.routeMessage('ಜಿಮ್ ಸಮಯ ಏನು').replyText, /ಸಮಯ:/);
    assert.match(router.routeMessage('gym kahan hai?').replyText, /Hum yahan hain/);
    assert.match(router.routeMessage('gym yelli ide').replyText, /ನಮ್ಮ ವಿಳಾಸ/);
  });

  test('discount requests, long messages and Hindi script go to the AI', () => {
    assert.strictEqual(router.routeMessage('any discount on the fees?').matched, false);
    assert.strictEqual(router.routeMessage('I am a beginner and want to lose weight, what is the price and do you have trainers for women in the evening').matched, false);
    assert.strictEqual(router.routeMessage('फीस कितनी है').matched, false);
  });

  test('a first hello gets the welcome menu; later greetings go to the AI', () => {
    const first = router.routeMessage('Hello!', {}, {});
    assert.strictEqual(first.intent, 'greeting');
    assert.deepStrictEqual(first.buttons.map(b => b.title), ['Prices', 'Book a trial', 'Location']);
    assert.strictEqual(router.routeMessage('hi', {}, { last_outbound_message_at: new Date().toISOString() }).matched, false);
  });
});

describe('reply buttons and map pin', () => {
  afterEach(() => { whatsappService.transport = null; env.gymLatitude = NaN; env.gymLongitude = NaN; });

  test('the welcome reply is sent with tap-to-answer buttons, and a tap gets the fixed answer', async () => {
    const sent = [];
    whatsappService.transport = async p => { sent.push(p); return { messages: [{ id: `wamid.b${sent.length}` }] }; };
    await converse('919877777701', 'hi');
    assert.strictEqual(sent.find(p => p.to).type, 'interactive');
    const welcome = sent.find(p => p.type === 'interactive');
    assert.deepStrictEqual(welcome.interactive.action.buttons.map(b => b.reply.title), ['Prices', 'Book a trial', 'Location']);

    await converse('919877777701', null, { type: 'interactive', extra: { interactive: { type: 'button_reply', button_reply: { id: 'prices', title: 'Prices' } } } });
    const msgs = await chat('919877777701');
    assert.ok(msgs.some(m => m.direction === 'in' && m.text === 'Prices'));
    assert.ok(msgs.some(m => m.direction === 'out' && /membership plans/.test(m.text)));
    assert.strictEqual(await aiCalls(), 0);
  });

  test('the location answer is followed by a map pin when coordinates are set', async () => {
    env.gymLatitude = 12.9; env.gymLongitude = 77.58;
    const sent = [];
    whatsappService.transport = async p => { sent.push(p); return { messages: [{ id: `wamid.l${sent.length}` }] }; };
    await converse('919877777702', 'where is the gym located?');
    const pin = sent.find(p => p.type === 'location');
    assert.ok(pin, 'a location message was sent');
    assert.strictEqual(pin.location.latitude, 12.9);
    assert.strictEqual(pin.location.name, 'Goldkraft Fitness');
    const msgs = await chat('919877777702');
    assert.ok(msgs.some(m => m.direction === 'out' && /^\[Location pin\]/.test(m.text)));
  });
});

describe('bot pause and per-lead cap', () => {
  afterEach(() => { env.maxBotRepliesPerLeadPerDay = 30; });

  const staffReply = (waId, hoursAgo) => db.query(`
    INSERT INTO outbound_messages (dedup_key, wa_id, text, status, metadata, created_at)
    VALUES ($1, $2, 'Hi, this is Coach Arun', 'sent', '{"source":"crm"}'::jsonb, now() - ($3::float8 * interval '1 hour'))`,
  [`crm:${waId}:${hoursAgo}`, waId, hoursAgo]);

  test('the bot stays quiet after a staff member replies from the CRM', async () => {
    await converse('919877777703', 'I want to get fit');
    await staffReply('919877777703', 1);
    await converse('919877777703', 'ok see you at 6pm');
    const msgs = await chat('919877777703');
    assert.deepStrictEqual([count(msgs, 'in'), count(msgs, 'out')], [2, 1]);
    assert.ok(msgs.some(m => m.text === 'ok see you at 6pm'));
  });

  test('the bot answers again once the staff reply is older than the pause', async () => {
    await converse('919877777704', 'I want to get fit');
    await staffReply('919877777704', 13);
    await converse('919877777704', 'are you there?');
    const msgs = await chat('919877777704');
    assert.deepStrictEqual([count(msgs, 'in'), count(msgs, 'out')], [2, 2]);
  });

  test('a lead over the daily cap gets one last reply, a hand-off, then silence', async () => {
    env.maxBotRepliesPerLeadPerDay = 2;
    for (const t of ['I want to get fit', 'tell me more', 'and then?', 'hello??']) await converse('919877777705', t);
    const msgs = await chat('919877777705');
    assert.deepStrictEqual([count(msgs, 'in'), count(msgs, 'out')], [4, 3]);
    assert.ok(msgs.some(m => m.direction === 'out' && /get back to you shortly/.test(m.text)));
    const h = await db.one(`SELECT reason, status FROM handoffs WHERE wa_id = '919877777705'`);
    assert.deepStrictEqual(h, { reason: 'other', status: 'pending' });
  });
});

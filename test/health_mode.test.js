// K33: health-related businesses. Health questions go to staff with a fixed reply; no AI.
const { db, converse, reset } = require('./helpers');
const { test, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert');
const aiPolicy = require('../src/services/aiPolicy');
const aiService = require('../src/services/aiService');
const gymConfig = require('../src/config/gymConfig');
const businessProfile = require('../src/services/businessProfile');
const whatsappService = require('../src/services/whatsappService');

const LEAD = '919877700301';
let aiCalls; let savedReply;
const setHealth = on => gymConfig.setProfile({ ...gymConfig.profileFor(1) || gymConfig.DEFAULT_PROFILE, healthRelated: on }, 1);
const lastOut = () => db.one('SELECT text FROM outbound_messages WHERE wa_id = $1 ORDER BY id DESC LIMIT 1', [LEAD]);

beforeEach(async () => {
  await reset();
  aiCalls = 0;
  whatsappService.transport = async () => ({ messages: [{ id: 'wamid.h' }] });
  savedReply = aiService.reply;
  aiService.reply = async function (...args) { aiCalls++; return savedReply.apply(this, args); };
});
afterEach(() => { whatsappService.transport = null; aiService.reply = savedReply; gymConfig.resetToDefault(1); });
after(() => db.close());

test('health questions are recognised in every supported language; admin questions are not', () => {
  for (const t of ['I have back pain, can you help?', 'is it safe to take this tablet', 'my child has fever since 2 days',
    'pregnant hu, kya kar sakti hu', 'bahut dard ho raha hai', 'मुझे बुखार है', 'ನನಗೆ ಜ್ವರ ಇದೆ', 'عندي ألم في الظهر', 'what are the side effects?']) {
    assert.strictEqual(aiPolicy.checkHealthQuestion(t).isHealthQuestion, true, t);
  }
  for (const t of ['what are your timings?', 'how much is a consultation?', 'where are you located', 'can I book an appointment on Saturday?',
    'is the root canal treatment painless?', 'do you have parking']) {
    assert.strictEqual(aiPolicy.checkHealthQuestion(t).isHealthQuestion, false, t);
  }
});

test('health mode on: a symptom gets the fixed reply, a generic hand-off summary, and no AI call', async () => {
  setHealth(true);
  await converse(LEAD, 'hi');
  const before = aiCalls;
  await converse(LEAD, 'I have chest pain when I walk, what should I do?');
  assert.strictEqual(aiCalls, before);
  assert.match((await lastOut()).text, /can't give medical advice/);
  const lead = await db.one('SELECT needs_human, handoff_reason FROM leads WHERE wa_id = $1', [LEAD]);
  assert.deepStrictEqual([lead.needs_human, lead.handoff_reason], [true, 'injury_question']);
  const h = await db.one('SELECT summary FROM handoffs WHERE wa_id = $1 ORDER BY id DESC LIMIT 1', [LEAD]);
  assert.strictEqual(h.summary, 'Asked a health question.');
  assert.doesNotMatch(h.summary, /chest/);
});

test('health mode on: admin questions still get the assistant, and the prompt carries the health rule', async () => {
  setHealth(true);
  assert.match(gymConfig.getSystemPrompt(), /HEALTH-RELATED BUSINESS/);
  await converse(LEAD, 'what are your timings on Sunday?');
  assert.doesNotMatch((await lastOut()).text, /medical advice/);
});

test('health mode off: everyday words like "pain" are not intercepted, and the prompt has no health rule', async () => {
  setHealth(false);
  assert.doesNotMatch(gymConfig.getSystemPrompt(), /HEALTH-RELATED BUSINESS/);
  await converse(LEAD, 'no pain no gain, what are the plans?');
  assert.doesNotMatch((await lastOut()).text, /can't give medical advice/);
});

test('the setting is saved with the business profile', () => {
  assert.strictEqual(businessProfile.normalize({ ...gymConfig.DEFAULT_PROFILE, healthRelated: '1' }).healthRelated, true);
  assert.strictEqual(businessProfile.normalize({ ...gymConfig.DEFAULT_PROFILE }).healthRelated, false);
});

test('review cases: missed phrasings are caught; clinic admin questions are not blocked; reply in their language', () => {
  for (const t of ['My fingers are numb and tingling. How do I fix this?', 'Saans lene mein dikkat ho rahi hai, kya karun?', 'मुझे साँस लेने में दिक्कत हो रही है, क्या करूँ?',
    'ನನಗೆ ಉಸಿರಾಡಲು ಕಷ್ಟವಾಗುತ್ತಿದೆ, ಏನು ಮಾಡಲಿ?', 'عندي ضيق في التنفس، ماذا أفعل؟', 'How many milligrams of ibuprofen for a six year old?', 'my sugar is 300, which tablet should i take']) {
    assert.strictEqual(aiPolicy.checkHealthQuestion(t).isHealthQuestion, true, t);
  }
  for (const t of ['How much is a blood test?', 'What are your diabetes clinic timings?', 'Can I book an appointment for a pregnancy scan?', 'दवा की दुकान कितने बजे खुलती है?',
    'ಔಷಧ ಅಂಗಡಿ ಯಾವ ಸಮಯಕ್ಕೆ ತೆರೆಯುತ್ತದೆ?', 'ما هي مواعيد عيادة السكري؟', 'can I take an appointment on Saturday?', 'do you deliver medicines?', 'medicine price list']) {
    assert.strictEqual(aiPolicy.checkHealthQuestion(t).isHealthQuestion, false, t);
  }
  assert.match(aiPolicy.checkHealthQuestion('मुझे बुखार है').replyText, /Batane ke liye/);
  assert.match(aiPolicy.checkHealthQuestion('ನನಗೆ ಜ್ವರ ಇದೆ').replyText, /ಧನ್ಯವಾದ/);
  assert.match(aiPolicy.checkHealthQuestion('عندي ألم في الظهر').replyText, /شكرًا/);
  assert.strictEqual(aiPolicy.looksLikeAdvice('Take 500 mg twice a day.'), true);
  assert.strictEqual(aiPolicy.looksLikeAdvice('We are open 9 to 9. Want to book a visit?'), false);
});

test('a health question earlier in a burst is caught even when the last message is harmless', async () => {
  setHealth(true);
  await converse(LEAD, 'hi');
  await db.query("INSERT INTO messages (message_id, wa_id, direction, text, timestamp) VALUES ('wamid.burst1', $1, 'in', 'I have chest pain, what should I do?', now())", [LEAD]);
  const before = aiCalls;
  await converse(LEAD, 'Please help');
  assert.strictEqual(aiCalls, before);
  assert.match((await lastOut()).text, /can't give medical advice/);
});

test('while a health hand-off is open, the assistant stays out (no AI, a short hold reply)', async () => {
  setHealth(true);
  await converse(LEAD, 'I have chest pain, what should I do?');
  const before = aiCalls;
  await converse(LEAD, 'Please answer my previous question');
  assert.strictEqual(aiCalls, before);
  assert.match((await lastOut()).text, /Our team has your message/);
});

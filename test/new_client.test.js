process.env.NODE_ENV = 'test';
require('../src/tenancy/context').setTestFallback(1); // profiles are per tenant (K8)
const test = require('node:test');
const assert = require('node:assert');
const router = require('../src/services/deterministicRouter');
const gymConfig = require('../src/config/gymConfig');
const notifyService = require('../src/services/notifyService');
const { VERTICALS } = require('../src/config/verticals');

test('the gym preset keeps its fixed-reply wording', () => {
  gymConfig.resetToDefault();
  assert.match(router.routeMessage('book a trial', {}, {}).replyText, /^Sure, let's get you in for a trial\. .* A coach will message you to confirm\.$/);
  assert.deepStrictEqual(router.routeMessage('hi', {}, {}).buttons.map(b => b.title), ['Prices', 'Book a trial', 'Location']);
});

test('a non-gym business gets general wording and buttons that route back', () => {
  try {
    gymConfig.setProfile({ ...gymConfig.profile, type: 'services', name: 'Acme Clinic' });
    const hi = router.routeMessage('hi', {}, {});
    assert.match(hi.replyText, /welcome to Acme Clinic/);
    assert.doesNotMatch(hi.replyText, /trial|coach/i);
    const titles = hi.buttons.map(b => b.title);
    assert.deepStrictEqual(titles, ['Prices', 'Book a visit', 'Location']);
    assert.strictEqual(router.routeMessage('Book a visit', {}, {}).intent, 'trial');
    assert.strictEqual(router.routeMessage('Talk to us', {}, {}).intent, 'human');
    for (const t of ['book a visit', 'talk to us', 'location', 'prices', 'trial chahiye']) {
      const r = router.routeMessage(t, {}, {});
      if (r.replyText) assert.doesNotMatch(r.replyText, /coach|membership|fat loss|undefined/i, t);
    }
    assert.match(gymConfig.getSystemPrompt(), /Acme Clinic, a business/);
  } finally { gymConfig.resetToDefault(); }
});

test('every business type defines the words the fixed replies need', () => {
  for (const v of Object.values(VERTICALS)) {
    for (const k of ['visit', 'staff', 'plans', 'pricesAsk']) assert.ok(v.words[k], `${v.type}.words.${k}`);
    assert.ok(v.words.bookButton.length <= 20 && v.words.staffButton.length <= 20, 'button titles max 20 chars');
  }
});

test('ops alerts name the client; staff alerts are unchanged', async () => {
  const sent = [];
  const axios = require('axios');
  const orig = axios.post;
  axios.post = async (url, body) => { sent.push(body); return {}; };
  const saved = { ...process.env };
  Object.assign(process.env, { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '1', TELEGRAM_OPS_CHAT_ID: '2' });
  try {
    await notifyService.send('Send failed', { ops: true });
    await notifyService.send('New lead');
    assert.strictEqual(sent[0].text, `<b>[${gymConfig.gymName}]</b> Send failed`);
    assert.strictEqual(sent[1].text, 'New lead');
  } finally {
    axios.post = orig;
    for (const k of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TELEGRAM_OPS_CHAT_ID']) { if (k in saved) process.env[k] = saved[k]; else delete process.env[k]; }
  }
});

const { db, reset } = require('./helpers');
const { test, describe, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const leadRepository = require('../src/db/leadRepository');
const handoffRepository = require('../src/db/handoffRepository');
const notifyService = require('../src/services/notifyService');
const { extractReferral, applyReferral } = require('../src/services/adAttribution');

const tick = () => new Promise(r => setTimeout(r, 20));

after(() => { notifyService.sendOverride = null; return db.close(); });
beforeEach(() => reset());

describe('Telegram staff alerts', () => {
  test('alerts are off unless Telegram is configured', () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    assert.strictEqual(notifyService.isEnabled(), false);
  });

  test('a new hand-off sends one alert; updating the open hand-off does not', async () => {
    const sent = [];
    const opts = [];
    notifyService.sendOverride = async (text, o) => { sent.push(text); opts.push(o); };
    process.env.CRM_BASE_URL = 'https://crm.example.test/';
    await leadRepository.upsertInbound('919800000001', 'Asha <Test>');
    await handoffRepository.open({ waId: '919800000001', reason: 'ready_to_book', summary: 'Wants 7am trial' });
    await tick();
    await handoffRepository.open({ waId: '919800000001', reason: 'price_negotiation' });
    await tick();
    assert.strictEqual(sent.length, 1);
    assert.match(sent[0], /Ready to book a trial/);
    assert.match(sent[0], /Asha &lt;Test&gt;/);
    // Links are tap buttons: log outcome, open lead, WhatsApp.
    const [row1, row2] = opts[0].buttons;
    assert.deepStrictEqual(row1.map(b => b.url), [
      'https://crm.example.test/leads/919800000001#outcome',
      'https://crm.example.test/leads/919800000001'
    ]);
    assert.strictEqual(row2[0].url, 'https://wa.me/919800000001');
    assert.doesNotMatch(sent[0], /<a href/);
    const open = await db.one(`SELECT reason FROM handoffs WHERE wa_id = '919800000001'`);
    assert.strictEqual(open.reason, 'price_negotiation');
    notifyService.sendOverride = null;
  });

  test('alert buttons: no WhatsApp link when the phone is hidden, text link when the CRM URL is local', () => {
    process.env.CRM_BASE_URL = 'https://crm.example.test';
    const hidden = notifyService.leadLinks('IN.12345', { user_id: 'IN.12345', phone: null });
    assert.strictEqual(hidden.buttons.length, 1);
    assert.strictEqual(hidden.buttons[0][0].url, 'https://crm.example.test/leads/IN.12345#outcome');

    process.env.CRM_BASE_URL = 'http://crm.localhost:3000';
    const local = notifyService.leadLinks('919800000004', { phone: '919800000004' });
    assert.deepStrictEqual(local.buttons, [[{ text: '💬 WhatsApp', url: 'https://wa.me/919800000004' }]]);
    assert.match(local.fallbackLinks[0], /http:\/\/crm\.localhost:3000\/leads\/919800000004/);
    delete process.env.CRM_BASE_URL;
  });

  test('a failing alert never breaks the bot', async () => {
    notifyService.sendOverride = async () => { throw new Error('telegram down'); };
    await leadRepository.upsertInbound('919800000002', 'Ravi');
    await handoffRepository.open({ waId: '919800000002', reason: 'complaint' });
    await tick();
    notifyService.sendOverride = null;
  });
});

describe('Click-to-WhatsApp ad tracking', () => {
  test('extracts Instagram ad details from a referral', () => {
    const r = extractReferral({ referral: { source_url: 'https://www.instagram.com/p/abc', source_type: 'ad', source_id: '120200', headline: 'Free trial at GKF', ctwa_clid: 'c1' } });
    assert.strictEqual(r.platform, 'instagram');
    assert.strictEqual(r.source_id, '120200');
    assert.strictEqual(extractReferral({ text: { body: 'hi' } }), null);
  });

  test('keeps the first ad that brought the lead', async () => {
    let lead = await leadRepository.upsertInbound('919800000003', 'Meera');
    lead = await applyReferral(lead, { referral: { source_url: 'https://fb.me/xyz', source_id: 'ad1', headline: 'Ad one' } });
    assert.strictEqual(lead.source, 'facebook_ad');
    lead = await applyReferral(lead, { referral: { source_url: 'https://instagram.com/p/2', source_id: 'ad2' } });
    assert.strictEqual(lead.metadata.referral.source_id, 'ad1');
  });
});

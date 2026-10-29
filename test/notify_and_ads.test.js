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
    notifyService.sendOverride = async text => { sent.push(text); };
    process.env.CRM_BASE_URL = 'https://crm.example.test/';
    await leadRepository.upsertInbound('919800000001', 'Asha <Test>');
    await handoffRepository.open({ waId: '919800000001', reason: 'ready_to_book', summary: 'Wants 7am trial' });
    await tick();
    await handoffRepository.open({ waId: '919800000001', reason: 'price_negotiation' });
    await tick();
    assert.strictEqual(sent.length, 1);
    assert.match(sent[0], /Ready to book a trial/);
    assert.match(sent[0], /Asha &lt;Test&gt;/);
    assert.match(sent[0], /https:\/\/crm\.example\.test\/leads\/919800000001/);
    const open = await db.one(`SELECT reason FROM handoffs WHERE wa_id = '919800000001'`);
    assert.strictEqual(open.reason, 'price_negotiation');
    notifyService.sendOverride = null;
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

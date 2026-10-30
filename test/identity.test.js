const { db, converse, postWebhook, drainAll, reset, getApp, request } = require('./helpers');
const { test, describe, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert');
const identity = require('../src/services/identity');
const whatsappService = require('../src/services/whatsappService');
const leadRepository = require('../src/db/leadRepository');
const { contactLabel } = require('../src/services/notifyService');
const crmUtil = require('../crm/src/util');

after(() => db.close());
beforeEach(() => reset());
afterEach(() => { whatsappService.transport = null; });

const BSUID = 'IN.13491208655302741918';
const lead = key => db.one('SELECT * FROM leads WHERE wa_id = $1', [key]);
const countLeads = async () => (await db.one('SELECT COUNT(*)::int AS n FROM leads')).n;
const capture = () => {
  const sent = [];
  whatsappService.transport = async p => { sent.push(p); return { messages: [{ id: `wamid.out${sent.length}` }] }; };
  return sent;
};

describe('identity helpers', () => {
  test('recognise phones and business-scoped user IDs', () => {
    assert.strictEqual(identity.isBsuid(BSUID), true);
    assert.strictEqual(identity.isBsuid('US.ENT.11815799212886844830'), true);
    assert.strictEqual(identity.isBsuid('919800000001'), false);
    assert.strictEqual(identity.toPhone('+919800000001'), '919800000001');
    assert.strictEqual(identity.toPhone(BSUID), null);
  });

  test('read the sender from a webhook, phone or not', () => {
    assert.deepStrictEqual(
      identity.fromWebhook({ from: '919800000001', from_user_id: BSUID }, { wa_id: '919800000001', user_id: BSUID, profile: { username: 'ravi_fit' } }),
      { phone: '919800000001', userId: BSUID, username: 'ravi_fit' });
    assert.deepStrictEqual(identity.fromWebhook({ from_user_id: BSUID }, { user_id: BSUID }), { phone: null, userId: BSUID, username: null });
  });

  test('send to the phone when known, else to the user ID', () => {
    assert.deepStrictEqual(identity.sendTarget({ phone: '919800000001', user_id: BSUID }, '919800000001'), { to: '919800000001' });
    assert.deepStrictEqual(identity.sendTarget({ phone: null, user_id: BSUID }, BSUID), { recipient: BSUID });
    assert.deepStrictEqual(identity.sendTarget(null, BSUID), { recipient: BSUID });
    assert.strictEqual(identity.sendTarget(null, 'garbage!'), null);
  });
});

describe('WhatsApp users with a hidden phone number', () => {
  test('a username-only user becomes a lead keyed by their user ID and gets a reply via recipient', async () => {
    const sent = capture();
    await converse(null, 'hi', { userId: BSUID, username: 'ravi_fit', name: 'Ravi' });
    const l = await lead(BSUID);
    assert.ok(l, 'lead keyed by BSUID');
    assert.strictEqual(l.phone, null);
    assert.strictEqual(l.user_id, BSUID);
    assert.strictEqual(l.username, 'ravi_fit');
    const reply = sent.find(p => p.type && p.type !== undefined && (p.recipient || p.to));
    assert.strictEqual(reply.recipient, BSUID);
    assert.strictEqual(reply.to, undefined);
    const out = await db.one(`SELECT status FROM outbound_messages WHERE wa_id = $1`, [BSUID]);
    assert.strictEqual(out.status, 'sent');
  });

  test('a known phone lead stays one lead when a later message hides the phone', async () => {
    capture();
    await converse('919811110001', 'hi', { userId: BSUID });
    assert.strictEqual((await lead('919811110001')).user_id, BSUID);
    await converse(null, 'what are your timings?', { userId: BSUID });
    assert.strictEqual(await countLeads(), 1);
    const msgs = await db.many(`SELECT direction FROM messages WHERE wa_id = '919811110001'`);
    assert.strictEqual(msgs.filter(m => m.direction === 'in').length, 2);
  });

  test('existing leads keep working and pick up their user ID', async () => {
    await leadRepository.upsertInbound('919811110002', 'Old Lead');
    const before = await lead('919811110002');
    assert.strictEqual(before.phone, '919811110002');
    capture();
    await converse('919811110002', 'hello again', { userId: 'IN.555' });
    assert.strictEqual(await countLeads(), 1);
    assert.strictEqual((await lead('919811110002')).user_id, 'IN.555');
  });

  test('a user ID change from Meta moves to the same lead and is not answered', async () => {
    const sent = capture();
    await converse(null, 'hi', { userId: BSUID });
    const sendsBefore = sent.length;
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
        messaging_product: 'whatsapp', metadata: { phone_number_id: 'PNID_TEST' },
        messages: [{ id: 'wamid.sys1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'system', from_user_id: 'IN.999',
          system: { type: 'user_changed_user_id', body: 'User changed', user_id: 'IN.999', previous_user_id: BSUID } }]
      } }] }]
    };
    assert.strictEqual((await postWebhook(payload)).status, 200);
    await drainAll();
    assert.strictEqual((await lead(BSUID)).user_id, 'IN.999');
    assert.strictEqual(sent.length, sendsBefore, 'no reply to a system message');
    await converse(null, 'still me', { userId: 'IN.999' });
    assert.strictEqual(await countLeads(), 1);
  });

  test('labels show the phone, the username, or "phone hidden"', () => {
    assert.strictEqual(contactLabel({ phone: '919800000001' }, '919800000001'), '+919800000001');
    assert.strictEqual(contactLabel({ username: 'ravi_fit' }, BSUID), '@ravi_fit');
    assert.strictEqual(contactLabel({}, BSUID), 'phone hidden');
    assert.strictEqual(crmUtil.contactLabel({ wa_id: BSUID }), 'Phone hidden');
    assert.strictEqual(crmUtil.contactLabel({ wa_id: '919800000001' }), '+919800000001');
    assert.strictEqual(crmUtil.cleanWaId(`${BSUID}<script>`), `${BSUID}script`);
  });
});

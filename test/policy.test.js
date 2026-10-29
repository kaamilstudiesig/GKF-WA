// Pure rules: no database needed.
process.env.NODE_ENV = 'test';
const { test, describe } = require('node:test');
const assert = require('node:assert');
const aiPolicy = require('../src/services/aiPolicy');
const router = require('../src/services/deterministicRouter');
const { textOf } = require('../src/workers/webhookWorker');

describe('AI policy', () => {
  const lead = { wa_id: '91900', status: 'new', display_name: null, notes: null };

  test('blocks converted and unknown statuses, allows normal stages', () => {
    assert.strictEqual(aiPolicy.validateAndSanitizeUpdates(lead, { status: 'converted' }).status, undefined);
    assert.strictEqual(aiPolicy.validateAndSanitizeUpdates(lead, { status: 'vip' }).status, undefined);
    assert.strictEqual(aiPolicy.validateAndSanitizeUpdates(lead, { status: 'hot' }).status, 'hot');
  });

  test('does not demote a hot lead back to contacted', () => {
    assert.strictEqual(aiPolicy.validateAndSanitizeUpdates({ ...lead, status: 'hot' }, { status: 'contacted' }).status, undefined);
  });

  test('unknown hand-off reasons become "other"', () => {
    assert.strictEqual(aiPolicy.validateAndSanitizeUpdates(lead, { needs_human: true, handoff_reason: 'wants pizza' }).handoff_reason, 'other');
  });

  test('detects injury questions but not ordinary training questions', () => {
    assert.strictEqual(aiPolicy.checkMedicalInjurySafety('I tore my ACL, acl tear last year').isMedicalQuery, true);
    assert.strictEqual(aiPolicy.checkMedicalInjurySafety('How do I build bigger arms?').isMedicalQuery, false);
  });
});

describe('fixed replies (no AI cost)', () => {
  test('hours, location, human request and trial booking are answered directly', () => {
    assert.match(router.routeMessage('what are the gym timings').replyText, /5:00 AM/);
    assert.match(router.routeMessage('where is the gym located?').replyText, /J\.P\. Nagar/);
    assert.strictEqual(router.routeMessage('I want to talk to a real person').updates.handoff_reason, 'human_requested');
    assert.strictEqual(router.routeMessage('book a trial please').updates.status, 'hot');
  });

  test('open-ended messages go to the AI', () => {
    assert.strictEqual(router.routeMessage('I want to lose 10kg before my wedding').matched, false);
  });
});

describe('reading WhatsApp message types', () => {
  test('text, buttons and list replies become text; media does not', () => {
    assert.strictEqual(textOf({ type: 'text', text: { body: 'hi' } }), 'hi');
    assert.strictEqual(textOf({ type: 'button', button: { text: 'Yes' } }), 'Yes');
    assert.strictEqual(textOf({ type: 'interactive', interactive: { list_reply: { title: 'Monthly' } } }), 'Monthly');
    assert.strictEqual(textOf({ type: 'image', image: {} }), null);
  });
});

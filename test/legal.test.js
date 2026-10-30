const { db, getApp, request, converse, reset } = require('./helpers');
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const router = require('../src/services/deterministicRouter');
const { deleteLead } = require('../scripts/delete-lead');

after(() => db.close());
beforeEach(() => reset());

test('privacy, terms and data-deletion pages are public HTML on the bot host', async () => {
  for (const [path, text] of [['/privacy', /Privacy policy/], ['/terms', /Terms of service/], ['/data-deletion', /DELETE MY DATA/]]) {
    const res = await request(getApp()).get(path);
    assert.strictEqual(res.status, 200, path);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.text, text);
    assert.match(res.headers['content-security-policy'], /default-src 'none'/);
    assert.doesNotMatch(res.text, /<script/i);
  }
  assert.match((await request(getApp()).get('/privacy')).text, /OpenRouter/);
});

test('"delete my data" gets a confirmation and goes to staff', async () => {
  const r = router.routeMessage('Please delete my data');
  assert.strictEqual(r.intent, 'deletion');
  assert.strictEqual(r.updates.needs_human, true);
  assert.match(r.updates.summary, /DATA DELETION REQUEST/);
  assert.match(router.routeMessage('mera data delete karo bhai, delete my data').replyText, /delete karke/);
});

test('delete-lead removes the lead and everything linked to it', async () => {
  await converse('919877700001', 'I want to get fit');
  await converse('919877700002', 'hello');
  const dry = await deleteLead('919877700001');
  assert.strictEqual(dry.deleted, false);
  assert.ok(dry.counts.messages >= 2);
  const done = await deleteLead('919877700001', { confirm: true });
  assert.strictEqual(done.deleted, true);
  for (const t of ['leads', 'messages', 'outbound_messages', 'webhook_events']) {
    assert.strictEqual((await db.one(`SELECT COUNT(*)::int AS n FROM ${t} WHERE wa_id = '919877700001'`)).n, 0, t);
  }
  assert.strictEqual((await db.one(`SELECT COUNT(*)::int AS n FROM leads WHERE wa_id = '919877700002'`)).n, 1);
  assert.strictEqual((await deleteLead('919800000000')).found, false);
});

const { setup, login } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const botGuard = require('../../src/services/botGuard');

const HOT_LEAD = '919845012345';

test('a staff reply pauses the AI; staff can turn it back on from the lead page', async () => {
  const ctx = await setup();
  try {
    await ctx.db.query('UPDATE leads SET last_inbound_message_at = now() WHERE wa_id = $1', [HOT_LEAD]); // reply window open
    const owner = await login(ctx.app, 'owner');
    await owner.agent.post(`/leads/${HOT_LEAD}/message`).type('form').send({ _csrf: owner.csrf, text: 'Hi, this is the manager' });

    assert.strictEqual((await botGuard.check(HOT_LEAD)).paused, true);
    assert.ok(await botGuard.pausedUntil(HOT_LEAD));
    assert.match((await owner.agent.get(`/leads/${HOT_LEAD}`)).text, /Turn AI back on/);

    const r = await owner.agent.post(`/leads/${HOT_LEAD}/bot/resume`).type('form').send({ _csrf: owner.csrf });
    assert.strictEqual(r.status, 302);
    assert.strictEqual((await botGuard.check(HOT_LEAD)).paused, false);
    assert.strictEqual(await botGuard.pausedUntil(HOT_LEAD), null);
    assert.doesNotMatch((await owner.agent.get(`/leads/${HOT_LEAD}`)).text, /Turn AI back on/);

    // A new staff reply after that pauses it again.
    await new Promise(res => setTimeout(res, 20));
    await owner.agent.post(`/leads/${HOT_LEAD}/message`).type('form').send({ _csrf: owner.csrf, text: 'One more thing' });
    assert.strictEqual((await botGuard.check(HOT_LEAD)).paused, true);
  } finally { await ctx.cleanup(); }
});

test('sales cannot resume the AI on leads that are not theirs', async () => {
  const ctx = await setup();
  try {
    const sales = await login(ctx.app, 'sales');
    const r = await sales.agent.post(`/leads/${HOT_LEAD}/bot/resume`).type('form').send({ _csrf: sales.csrf });
    assert.strictEqual(r.status, 404);
  } finally { await ctx.cleanup(); }
});

// K27: the owner's "Reply time this month" line in Reports; managers don't see it.
const { setup, login } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const tenancy = require('../../src/tenancy/context');

test('owners see the reply-time line in Reports, managers do not', async () => {
  const ctx = await setup();
  try {
    await tenancy.run(1, async () => {
      const now = new Date();
      for (let i = 1; i <= 4; i++) {
        await ctx.db.query('INSERT INTO reply_times (outbound_id, received_at, sent_at, reply_ms) VALUES ($1, $2, $3, $4)', [i, new Date(now - 3000), now, 3000]);
      }
    });
    const owner = await login(ctx.app, 'owner');
    const page = await owner.agent.get('/reports');
    assert.strictEqual(page.status, 200);
    assert.match(page.text, /Reply time this month/);
    assert.match(page.text, /100% within 30 s/);
    assert.match(page.text, /4 automatic replies/);
    const manager = await login(ctx.app, 'manager');
    const mpage = await manager.agent.get('/reports');
    assert.strictEqual(mpage.status, 200);
    assert.doesNotMatch(mpage.text, /Reply time this month/);
  } finally { await ctx.cleanup(); }
});

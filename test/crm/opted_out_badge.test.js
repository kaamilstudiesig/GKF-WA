// K30: the lead page shows "Opted out" for a lead who wrote STOP, and nothing otherwise.
const { setup, login } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');

test('a lead who wrote STOP shows the Opted out badge; others do not', async () => {
  const ctx = await setup();
  try {
    const [a, b] = await ctx.db.many('SELECT wa_id FROM leads ORDER BY wa_id LIMIT 2');
    await ctx.db.query('UPDATE leads SET opted_out_at = now() WHERE wa_id = $1', [a.wa_id]);
    const owner = await login(ctx.app, 'owner');
    const page = await owner.agent.get(`/leads/${encodeURIComponent(a.wa_id)}`);
    assert.strictEqual(page.status, 200);
    assert.match(page.text, />Opted out<\/span>/);
    assert.match(page.text, /No template messages until they write again/);
    const other = await owner.agent.get(`/leads/${encodeURIComponent(b.wa_id)}`);
    assert.doesNotMatch(other.text, />Opted out<\/span>/);
  } finally { await ctx.cleanup(); }
});

const { setup } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const { createOwner } = require('../../crm/scripts/create-owner');

test('crm:owner creates one owner with a random password that must be changed', async () => {
  const ctx = await setup();
  try {
    const pw = await createOwner(ctx.db, { name: 'Client Owner', email: 'owner@client.test' });
    assert.ok(pw && pw.length >= 16);
    const u = await ctx.db.one("SELECT role, must_change_password FROM crm_users WHERE email = 'owner@client.test'");
    assert.strictEqual(u.role, 'owner');
    assert.strictEqual(u.must_change_password, true);
    assert.strictEqual(await createOwner(ctx.db, { name: 'Again', email: 'owner@client.test' }), null);
    assert.notStrictEqual(await createOwner(ctx.db, { name: 'B', email: 'b@client.test' }), pw);
  } finally { await ctx.cleanup(); }
});

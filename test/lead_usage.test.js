// K26 lead usage meter: each person once per calendar month, alerts at 80% and 100% once each.
const { db, converse, reset } = require('./helpers');
const { test, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert');
const leadUsage = require('../src/services/leadUsage');
const registry = require('../src/tenancy/registry');
const tenancy = require('../src/tenancy/context');
const notifyService = require('../src/services/notifyService');
const whatsappService = require('../src/services/whatsappService');

let alerts;
const setLimit = n => registry.update(1, { settings: { leadMonthlyLimit: n === null ? '' : String(n) } });
const rows = () => tenancy.runAsSystem(() => db.many('SELECT * FROM lead_usage ORDER BY first_at'));
const phone = i => `91987770${String(i).padStart(4, '0')}`;

beforeEach(async () => {
  await reset();
  await tenancy.runAsSystem(async () => {
    await db.query('DELETE FROM lead_usage');
    await db.query('DELETE FROM lead_usage_alerts');
  });
  leadUsage._tzCache.clear();
  alerts = [];
  notifyService.sendOverride = async (text, opts) => { alerts.push({ text, ops: Boolean(opts?.ops) }); };
  whatsappService.transport = async () => ({ messages: [{ id: 'wamid.x' }] });
});
afterEach(async () => {
  notifyService.sendOverride = null;
  whatsappService.transport = null;
  await setLimit(null);
});
after(() => db.close());

test('one person counts once a month however many messages they send; no phone number is stored', async () => {
  await converse(phone(1), 'hi');
  await converse(phone(1), 'what are your prices?');
  await converse(phone(2), 'hello');
  const u = await tenancy.run(1, () => leadUsage.usage());
  assert.strictEqual(u.count, 2);
  assert.strictEqual(u.limit, null);
  assert.strictEqual(u.percent, null);
  for (const r of await rows()) {
    assert.ok(!r.person_key.includes('9877700'), 'person_key must be a hash');
    assert.strictEqual(r.channel, 'whatsapp');
  }
});

test('the month is the client\'s: 30 Nov 19:00 UTC is already December in India, still November in Dubai', () => {
  const at = new Date('2026-11-30T19:00:00Z');
  assert.strictEqual(leadUsage.monthOf(at, 'Asia/Kolkata'), '2026-12');
  assert.strictEqual(leadUsage.monthOf(at, 'Asia/Dubai'), '2026-11');
});

test('a deleted lead still counts for the month (a deletion request never changes an invoice)', async () => {
  await converse(phone(1), 'hi');
  const { deleteLead } = require('../scripts/delete-lead');
  await tenancy.run(1, async () => {
    assert.strictEqual((await deleteLead(phone(1), { confirm: true })).deleted, true);
    assert.strictEqual(await db.one('SELECT wa_id FROM leads WHERE wa_id = $1', [phone(1)]), null);
    assert.strictEqual((await leadUsage.usage()).count, 1);
  });
});

test('with a limit, owners and ops get one alert at 80% and one at 100%, never repeated', async () => {
  await setLimit(5);
  for (let i = 1; i <= 3; i++) await converse(phone(i), 'hi');
  assert.strictEqual(alerts.length, 0);
  await converse(phone(4), 'hi'); // 4 of 5 = 80%
  assert.deepStrictEqual(alerts.map(a => a.ops), [false, true]);
  assert.match(alerts[0].text, /80% of this month's leads used<\/b>: 4 of 5/);
  await converse(phone(4), 'again'); // same person: no change
  await converse(phone(5), 'hi'); // 5 of 5 = 100%
  await converse(phone(6), 'hi'); // over: no new alert
  assert.strictEqual(alerts.length, 4);
  assert.match(alerts[2].text, /Lead limit reached<\/b>: 5 of 5/);
  const u = await tenancy.run(1, () => leadUsage.usage());
  assert.deepStrictEqual([u.count, u.limit, u.percent], [6, 5, 120]);
});

test('no limit set: count only, no alerts', async () => {
  for (let i = 1; i <= 6; i++) await converse(phone(i), 'hi');
  assert.strictEqual(alerts.length, 0);
});

test('a failed alert is tried again with the next new lead, and the reply still goes out', async () => {
  await setLimit(2);
  let fail = true;
  notifyService.sendOverride = async (text, opts) => {
    if (fail && !opts?.ops) throw new Error('telegram down');
    alerts.push({ text, ops: Boolean(opts?.ops) });
  };
  await converse(phone(1), 'hi'); // 1 of 2 = 50%
  await converse(phone(2), 'hi'); // 100% (and 80%): sending fails
  assert.strictEqual(alerts.length, 0);
  const replies = await tenancy.run(1, () => db.one('SELECT COUNT(*)::int AS n FROM outbound_messages WHERE wa_id = $1', [phone(2)]));
  assert.ok(replies.n >= 1, 'the lead still got a reply');
  fail = false;
  await converse(phone(3), 'hi');
  assert.ok(alerts.some(a => !a.ops && /80%/.test(a.text)));
  assert.ok(alerts.some(a => !a.ops && /Lead limit reached/.test(a.text)));
});

test('each client has its own count; the invoicing list shows every client and the overage', async () => {
  await setLimit(1);
  await converse(phone(1), 'hi');
  await converse(phone(2), 'hi');
  const other = await registry.create({ slug: 'acme', name: 'Acme', settings: { leadMonthlyLimit: '100' } });
  await tenancy.run(other.id, () => leadUsage.record({ wa_id: phone(1), phone: phone(1) }));
  const month = (await tenancy.run(1, () => leadUsage.usage())).month;
  const list = await leadUsage.allClients(month);
  const byslug = Object.fromEntries(list.map(r => [r.slug, r]));
  assert.strictEqual(byslug.acme.leads, 1);
  assert.strictEqual(byslug.acme.limit, 100);
  assert.strictEqual(byslug.acme.over, 0);
  const gkf = list.find(r => r.slug !== 'acme');
  assert.deepStrictEqual([gkf.leads, gkf.limit, gkf.over], [2, 1, 1]);
  await assert.rejects(leadUsage.allClients('Nov'), /YYYY-MM/);
});

test('no staff Telegram group yet: the alert is not marked sent, and goes out once a group exists', async () => {
  await setLimit(1);
  const savedToken = process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_BOT_TOKEN;
  notifyService.sendOverride = null; // nothing configured: isEnabled() is false
  try {
    await converse(phone(1), 'hi'); // 100% reached, but nowhere to send it
    const pending = await tenancy.runAsSystem(() => db.many('SELECT level FROM lead_usage_alerts'));
    assert.deepStrictEqual(pending, []);
  } finally {
    if (savedToken !== undefined) process.env.TELEGRAM_BOT_TOKEN = savedToken;
  }
  notifyService.sendOverride = async (text, opts) => { alerts.push({ text, ops: Boolean(opts?.ops) }); };
  await converse(phone(2), 'hi');
  assert.ok(alerts.some(a => !a.ops && /80%/.test(a.text)));
  assert.ok(alerts.some(a => !a.ops && /Lead limit reached/.test(a.text)));
});

test('a late message from last month counts in that month but sends no alert', async () => {
  await setLimit(1);
  const old = new Date('2026-01-15T10:00:00Z');
  const r = await tenancy.run(1, () => leadUsage.record({ wa_id: phone(7), phone: phone(7) }, { at: old }));
  assert.deepStrictEqual(r, { month: '2026-01', counted: true });
  assert.strictEqual((await tenancy.run(1, () => leadUsage.usage({ month: '2026-01' }))).count, 1);
  assert.strictEqual(alerts.length, 0);
});

test('a lead the meter cannot identify is skipped without throwing', async () => {
  const r = await tenancy.run(1, () => leadUsage.record(null));
  assert.deepStrictEqual(r, { counted: false });
});

// K31: automatic deletion uses the latest activity and preserves billing counts.
const { db, reset } = require('./helpers');
const { test, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert');
const retention = require('../src/services/retention');
const leadUsage = require('../src/services/leadUsage');
const registry = require('../src/tenancy/registry');
const tenancy = require('../src/tenancy/context');
const notifyService = require('../src/services/notifyService');

const NOW = new Date('2030-11-17T22:05:00Z');
const OLD = '2028-10-17T12:00:00Z'; // 25 months before NOW.
const RECENT = '2030-10-17T12:00:00Z';
const ACTIVITY_COLUMNS = [
  'last_inbound_message_at', 'last_outbound_message_at', 'first_contact_at', 'updated_at'
];
const phone = i => `91983100${String(i).padStart(4, '0')}`;
const setMonths = value => registry.update(1, { settings: { retentionMonths: value } });
const run = (tenantId = 1, now = NOW) => tenancy.run(tenantId, () => retention.runTenant(now));
const leadKeys = (tenantId = 1) => tenancy.run(tenantId, async () =>
  (await db.many('SELECT wa_id FROM leads ORDER BY wa_id')).map(row => row.wa_id));
const claims = (tenantId = 1) => tenancy.run(tenantId, () =>
  db.many("SELECT wa_id, details FROM crm_activity_log WHERE action = 'retention_run' ORDER BY id"));

function insertLead(tenantId, waId, activity = {}) {
  const timestamps = Object.fromEntries(ACTIVITY_COLUMNS.map(column => [column, OLD]));
  Object.assign(timestamps, activity);
  return tenancy.run(tenantId, () => db.query(`INSERT INTO leads
    (wa_id, phone, status, first_contact_at, last_inbound_message_at, last_outbound_message_at, updated_at)
    VALUES ($1, $1, 'new', $2, $3, $4, $5)`, [waId, timestamps.first_contact_at,
    timestamps.last_inbound_message_at, timestamps.last_outbound_message_at, timestamps.updated_at]));
}

// Keep the large cap fixture fast without calling the bot or relying on the wall clock.
function insertBatch(tenantId, prefix, count, at) {
  return tenancy.run(tenantId, () => db.query(`INSERT INTO leads
    (wa_id, phone, status, first_contact_at, last_inbound_message_at, last_outbound_message_at, updated_at)
    SELECT $1::text || n::text, $1::text || n::text, 'new',
      $3::timestamptz, $3::timestamptz, $3::timestamptz, $3::timestamptz
    FROM generate_series(1, $2::int) AS series(n)`, [prefix, count, at]));
}

let alerts;
let savedEnv;
let savedSendOverride;
beforeEach(async () => {
  savedEnv = { LEAD_RETENTION: process.env.LEAD_RETENTION, RETENTION_HOUR_UTC: process.env.RETENTION_HOUR_UTC };
  delete process.env.LEAD_RETENTION;
  delete process.env.RETENTION_HOUR_UTC; // Exercise the default 22:00 UTC slot.
  retention._state.doneDay = null;
  await reset();
  await tenancy.runAsSystem(async () => {
    await db.query("DELETE FROM crm_activity_log WHERE action = 'retention_run'");
    await db.query('DELETE FROM lead_usage');
    await db.query('DELETE FROM lead_usage_alerts');
  });
  await setMonths('');
  leadUsage._tzCache.clear();
  alerts = [];
  savedSendOverride = notifyService.sendOverride;
  notifyService.sendOverride = async (text, opts) => { alerts.push({ text, ops: Boolean(opts?.ops) }); };
});
afterEach(async () => {
  notifyService.sendOverride = savedSendOverride;
  retention._state.doneDay = null;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await setMonths('');
});
after(() => db.close());

test('deletes a lead only when all four activity timestamps are older than 24 months', async () => {
  await insertLead(1, phone(1), {
    first_contact_at: '2027-01-01T12:00:00Z',
    last_inbound_message_at: '2027-06-01T12:00:00Z',
    last_outbound_message_at: '2028-01-01T12:00:00Z'
  });
  assert.deepStrictEqual(await tenancy.run(1, () => retention.dueLeads(24, NOW)), [{ wa_id: phone(1) }]);
  assert.deepStrictEqual(await run(), { deleted: 1, due: 1, months: 24 });
  assert.deepStrictEqual(await leadKeys(), []);
});

for (const column of ACTIVITY_COLUMNS) {
  test(`keeps a lead with recent ${column}, even when every other activity timestamp is old`, async () => {
    await insertLead(1, phone(1));
    await insertLead(1, phone(2), { [column]: RECENT });
    assert.deepStrictEqual(await tenancy.run(1, () => retention.dueLeads(24, NOW)), [{ wa_id: phone(1) }]);
    assert.deepStrictEqual(await run(), { deleted: 1, due: 1, months: 24 });
    assert.deepStrictEqual(await leadKeys(), [phone(2)]);
  });
}

// Form leads (no WhatsApp message yet) exist once R16's migration 7 makes last_inbound_message_at nullable.
const inboundNullable = async () => (await tenancy.runAsSystem(() => db.one(`SELECT is_nullable FROM information_schema.columns
  WHERE table_name = 'leads' AND column_name = 'last_inbound_message_at'`))).is_nullable === 'YES';

test('keeps a form lead with no WhatsApp messages and a recent first contact', async t => {
  if (!(await inboundNullable())) return t.skip('needs R16 migration 7');
  await insertLead(1, phone(1), {
    last_inbound_message_at: null, last_outbound_message_at: null, first_contact_at: RECENT
  });
  assert.deepStrictEqual(await tenancy.run(1, () => retention.dueLeads(24, NOW)), []);
  assert.deepStrictEqual(await run(), { deleted: 0, due: 0, months: 24 });
  assert.deepStrictEqual(await leadKeys(), [phone(1)]);
});

test('deletes a form lead with no WhatsApp messages and an old first contact', async t => {
  if (!(await inboundNullable())) return t.skip('needs R16 migration 7');
  await insertLead(1, phone(1), { last_inbound_message_at: null, last_outbound_message_at: null });
  assert.deepStrictEqual(await tenancy.run(1, () => retention.dueLeads(24, NOW)), [{ wa_id: phone(1) }]);
  assert.deepStrictEqual(await run(), { deleted: 1, due: 1, months: 24 });
  assert.deepStrictEqual(await leadKeys(), []);
});

test('deletion removes lead data, including payment links and activity, but keeps billing usage', async () => {
  const waId = phone(1);
  const tables = ['messages', 'handoffs', 'crm_lead_notes', 'crm_lead_outcomes',
    'outbound_messages', 'crm_payment_links', 'crm_activity_log'];
  await insertLead(1, waId);
  await tenancy.run(1, async () => {
    const user = await db.one(`INSERT INTO crm_users (email, name, role, password_hash)
      VALUES ('retention@example.test', 'Retention staff', 'owner', 'unused-test-hash') RETURNING id`);
    await db.query("INSERT INTO messages (wa_id, direction, text, timestamp) VALUES ($1, 'in', 'Hello', $2)", [waId, OLD]);
    await db.query("INSERT INTO handoffs (wa_id, reason) VALUES ($1, 'other')", [waId]);
    await db.query("INSERT INTO crm_lead_notes (wa_id, user_id, body) VALUES ($1, $2, 'Staff note')", [waId, user.id]);
    await db.query("INSERT INTO crm_lead_outcomes (wa_id, user_id, outcome) VALUES ($1, $2, 'no_answer')", [waId, user.id]);
    await db.query("INSERT INTO outbound_messages (dedup_key, wa_id, text) VALUES ('retention:reply', $1, 'Reply')", [waId]);
    await db.query(`INSERT INTO crm_payment_links (wa_id, user_id, reference_id, plan, amount_inr)
      VALUES ($1, $2, 'retention-payment', 'Monthly', 5000)`, [waId, user.id]);
    await db.query("INSERT INTO crm_activity_log (wa_id, user_id, action) VALUES ($1, $2, 'note_added')", [waId, user.id]);
    const recorded = await leadUsage.record({ wa_id: waId, phone: waId }, { at: NOW });
    assert.strictEqual(recorded.counted, true);
    const usageBefore = await db.many('SELECT * FROM lead_usage');
    assert.strictEqual(usageBefore.length, 1);
    for (const table of tables) {
      assert.strictEqual((await db.one(`SELECT COUNT(*)::int AS n FROM ${table} WHERE wa_id = $1`, [waId])).n, 1, table);
    }

    assert.deepStrictEqual(await retention.runTenant(NOW), { deleted: 1, due: 1, months: 24 });
    assert.strictEqual(await db.one('SELECT wa_id FROM leads WHERE wa_id = $1', [waId]), null);
    for (const table of tables) {
      assert.strictEqual((await db.one(`SELECT COUNT(*)::int AS n FROM ${table} WHERE wa_id = $1`, [waId])).n, 0, table);
    }
    assert.deepStrictEqual(await db.many('SELECT * FROM lead_usage'), usageBefore);
    assert.strictEqual((await leadUsage.usage({ now: NOW })).count, 1);
  });
});

test('uses the tenant retentionMonths setting instead of the default 24 months', async () => {
  const sevenMonthsAgo = '2030-04-17T12:00:00Z';
  await insertLead(1, phone(1), Object.fromEntries(ACTIVITY_COLUMNS.map(column => [column, sevenMonthsAgo])));
  assert.deepStrictEqual(await run(), { deleted: 0, due: 0, months: 24 });
  await registry.update(1, { settings: { retentionMonths: '6' } });
  assert.deepStrictEqual(await run(), { deleted: 1, due: 1, months: 6 });
  assert.deepStrictEqual(await leadKeys(), []);
  // afterEach restores retentionMonths to ''.
});

test('LEAD_RETENTION=off disables tick without deleting or claiming the day', async () => {
  await insertLead(1, phone(1));
  process.env.LEAD_RETENTION = 'off';
  assert.deepStrictEqual(await retention.tick(NOW), { ran: false, reason: 'off' });
  assert.deepStrictEqual(await leadKeys(), [phone(1)]);
  assert.deepStrictEqual(await claims(), []);
  assert.strictEqual(retention._state.doneDay, null);
  assert.deepStrictEqual(alerts, []);
  // afterEach restores the original environment, including absent variables.
});

test('tick waits until 22:00 UTC and runs once a day, even after its in-memory state resets', async () => {
  await insertLead(1, phone(1));
  const before = new Date('2030-11-17T21:59:00Z');
  assert.deepStrictEqual(await retention.tick(before), { ran: false, reason: 'not_yet' });
  assert.deepStrictEqual(await leadKeys(), [phone(1)]);
  assert.deepStrictEqual(await claims(), []);
  assert.strictEqual(retention._state.doneDay, null);

  retention._state.doneDay = null;
  const slug = registry.config(1).slug;
  const first = await retention.tick(NOW);
  assert.strictEqual(first.ran, true);
  assert.deepStrictEqual(first.results[slug], { deleted: 1, due: 1, months: 24 });
  assert.deepStrictEqual(await leadKeys(), []);
  assert.deepStrictEqual(await claims(), [{ wa_id: null, details: { day: '2030-11-17' } }]);

  await insertLead(1, phone(2));
  // Deliberately keep state for this call to verify the in-memory 'done' guard.
  assert.deepStrictEqual(await retention.tick(new Date('2030-11-17T22:06:00Z')), { ran: false, reason: 'done' });
  assert.deepStrictEqual(await leadKeys(), [phone(2)]);

  retention._state.doneDay = null; // Simulate a different process or a restart.
  const claimed = await retention.tick(new Date('2030-11-17T22:07:00Z'));
  assert.strictEqual(claimed.ran, true);
  assert.deepStrictEqual(claimed.results[slug], { skipped: 'claimed' });
  assert.deepStrictEqual(await leadKeys(), [phone(2)]);
  assert.strictEqual((await claims()).length, 1);

  retention._state.doneDay = null;
  const tomorrow = await retention.tick(new Date('2030-11-18T22:05:00Z'));
  assert.strictEqual(tomorrow.ran, true);
  assert.deepStrictEqual(tomorrow.results[slug], { deleted: 1, due: 1, months: 24 });
  assert.deepStrictEqual(await leadKeys(), []);
  assert.deepStrictEqual((await claims()).map(row => row.details.day), ['2030-11-17', '2030-11-18']);
});

test('surge guard deletes nothing and alerts ops when too many leads are due', async () => {
  const count = retention.SURGE_MIN + 1;
  await insertBatch(1, '918310', count, OLD);
  const before = await leadKeys();
  const result = await run();
  assert.deepStrictEqual(result, { deleted: 0, due: count, months: 24, skipped: 'surge' });
  assert.deepStrictEqual(await leadKeys(), before);
  assert.ok(alerts.some(alert => alert.ops && /Automatic deletion stopped/.test(alert.text)));
});

test('deletes exactly MAX_PER_RUN when the due leads are below the surge share', async () => {
  const oldCount = retention.MAX_PER_RUN + 5;
  const recentCount = Math.ceil(oldCount / retention.SURGE_SHARE);
  assert.ok(oldCount / (oldCount + recentCount) < retention.SURGE_SHARE);
  await insertBatch(1, '918311', oldCount, OLD);
  await insertBatch(1, '918312', recentCount, RECENT);
  const result = await run();
  assert.deepStrictEqual(result, { deleted: retention.MAX_PER_RUN, due: retention.MAX_PER_RUN + 1, months: 24 });
  const remainingDue = await tenancy.run(1, () => retention.dueLeads(24, NOW, oldCount));
  assert.strictEqual(remainingDue.length, oldCount - retention.MAX_PER_RUN);
  const remaining = await leadKeys();
  assert.strictEqual(remaining.length, oldCount + recentCount - retention.MAX_PER_RUN);
  assert.strictEqual(remaining.filter(key => key.startsWith('918312')).length, recentCount);
});

test('a tenant run deletes only its own old leads, even with a shared wa_id', async () => {
  const other = await registry.create({ slug: 'retention-other', name: 'Other client' });
  await insertLead(1, phone(1));
  await insertLead(other.id, phone(1));
  assert.deepStrictEqual(await run(1), { deleted: 1, due: 1, months: 24 });
  assert.deepStrictEqual(await leadKeys(1), []);
  assert.deepStrictEqual(await leadKeys(other.id), [phone(1)]);
  assert.deepStrictEqual(await run(other.id), { deleted: 1, due: 1, months: 24 });
  assert.deepStrictEqual(await leadKeys(other.id), []);
});

test('tick processes active tenants and skips suspended tenants without claiming their day', async () => {
  const active = await registry.create({ slug: 'retention-active', name: 'Active client' });
  const suspended = await registry.create({ slug: 'retention-suspended', name: 'Suspended client' });
  await registry.update(suspended.id, { status: 'suspended' });
  await insertLead(1, phone(1));
  await insertLead(active.id, phone(1));
  await insertLead(suspended.id, phone(1));
  const result = await retention.tick(NOW);
  assert.strictEqual(result.ran, true);
  assert.deepStrictEqual(result.results[registry.config(1).slug], { deleted: 1, due: 1, months: 24 });
  assert.deepStrictEqual(result.results[active.slug], { deleted: 1, due: 1, months: 24 });
  assert.strictEqual(Object.hasOwn(result.results, suspended.slug), false);
  assert.deepStrictEqual(await leadKeys(1), []);
  assert.deepStrictEqual(await leadKeys(active.id), []);
  assert.deepStrictEqual(await leadKeys(suspended.id), [phone(1)]);
  assert.deepStrictEqual(await claims(suspended.id), []);
});

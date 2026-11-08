const { db } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const tenancy = require('../src/tenancy/context');
const registry = require('../src/tenancy/registry');
const { migrateAll } = require('../src/migrate');
const { planLeads, seedDemo, assertAllowed, JOURNEYS, LEADS } = require('../scripts/demo');

const NOW = new Date('2030-03-15T10:00:00Z');

test('the plan: 60 leads through every step, test phone numbers, same every run', () => {
  const plan = planLeads({ slug: 'palmcrest', region: 'ae', now: NOW });
  assert.strictEqual(plan.length, LEADS);
  assert.strictEqual(JOURNEYS.reduce((s, [, n]) => s + n, 0), LEADS);
  for (const [kind, n] of JOURNEYS) assert.strictEqual(plan.filter(l => l.kind === kind).length, n, kind);
  assert.ok(plan.every(l => /^97150000\d{4}$/.test(l.waId)), 'UAE test range only');
  assert.strictEqual(new Set(plan.map(l => l.waId)).size, LEADS);
  assert.ok(planLeads({ slug: 'lakeview', region: 'in', now: NOW }).every(l => /^9198000\d{5}$/.test(l.waId)), 'India test range only');

  // Nothing happens in the future, except site visits that are booked and not done yet.
  for (const l of plan) {
    for (const [, , at] of l.chat) assert.ok(at <= NOW, `chat in the future for ${l.kind}`);
    for (const o of l.outcomes) assert.ok(o.at <= NOW, `${o.outcome} in the future for ${l.kind}`);
    if (l.visitAt && l.kind !== 'visit_booked') assert.ok(l.visitAt <= NOW, `visit in the future for ${l.kind}`);
  }
  // Bookings have a plan and a realistic AED amount; lost leads have a reason.
  for (const l of plan.filter(x => x.kind === 'won')) {
    const sale = l.outcomes.find(o => o.outcome === 'joined');
    assert.ok(sale.amount >= 750000 && sale.amount <= 3900000 && sale.plan);
  }
  assert.ok(plan.filter(x => x.kind === 'lost').every(l => l.outcomes.some(o => o.outcome === 'lost' && o.reason)));
  // Every placeholder is filled in ({p}, {u}, {b}, {price}).
  assert.ok(plan.every(l => l.chat.every(([, text]) => !/\{\w+\}/.test(text))), 'no {placeholder} left in a chat');
  assert.ok(plan.some(l => l.chat.some(([, text]) => /AED [\d.]+[KM] onwards/.test(text))), 'bot quotes a price');
  // Chats in more than one language for Dubai.
  assert.ok(new Set(plan.map(l => l.lang)).size >= 2);
  assert.ok(plan.some(l => l.chat.some(([, text]) => /[؀-ۿ]/.test(text))), 'some Arabic');

  // Same slug -> same data; another client -> different data.
  assert.deepStrictEqual(planLeads({ slug: 'palmcrest', region: 'ae', now: NOW }).map(l => [l.waId, l.kind, l.name]), plan.map(l => [l.waId, l.kind, l.name]));
  assert.notDeepStrictEqual(planLeads({ slug: 'other', region: 'ae', now: NOW }).map(l => l.kind), plan.map(l => l.kind));
});

test('guard: never tenant 1; off local PGlite only clients marked as demos, whatever NODE_ENV says', () => {
  const demo = { slug: 'palmcrest', demo: true, isDefault: false };
  assert.doesNotThrow(() => assertAllowed(demo, { dbKind: 'pg' }));
  assert.throws(() => assertAllowed({ ...demo, demo: false }, { dbKind: 'pg' }), /not marked as a demo/); // a laptop pointed at Heroku
  assert.throws(() => assertAllowed({ ...demo, isDefault: true, slug: 'gkf' }, { dbKind: 'pg' }), /tenant 1/);
  assert.throws(() => assertAllowed({ ...demo, isDefault: true, slug: 'gkf' }, { dbKind: 'pglite' }), /tenant 1/); // even locally
  assert.doesNotThrow(() => assertAllowed({ ...demo, demo: false }, { dbKind: 'pglite' })); // local playground
});

test('seeding a demo client: realistic data, safe to run twice, --reset, other clients untouched', async () => {
  await db.close();
  await migrateAll();
  const t = await registry.create({ slug: 'palmcrest', name: 'Palm Crest Realty', phoneNumberId: '1000200030555', crmHost: 'crm.palmcrest.test', settings: { demo: true } });
  assert.strictEqual(registry.config(t.id).demo, true);
  const gkfLeadsBefore = (await db.one('SELECT COUNT(*)::int AS n FROM leads')).n;
  const run = opts => tenancy.run(t.id, () => seedDemo(db, { slug: 'palmcrest', name: 'Palm Crest Realty', region: 'ae', now: NOW, ...opts }));
  const inTenant = (sql, p) => tenancy.run(t.id, () => db.many(sql, p));

  const first = await run();
  assert.strictEqual(first.added, LEADS);
  assert.ok(first.profileWritten, 'starter profile replaced with projects and prices');
  assert.deepStrictEqual(first.staff.map(s => s.role), ['manager', 'sales', 'sales', 'sales', 'sales']);
  assert.ok(first.staff.every(s => s.email.endsWith('@demo-palmcrest.test') && s.password.length >= 16));

  const profile = (await inTenant('SELECT profile FROM business_profile'))[0].profile;
  assert.strictEqual(profile.type, 'realestate');
  assert.match(profile.plans.map(p => p.price).join(' '), /AED/);
  assert.strictEqual(profile.name, 'Palm Crest Realty');

  const team = await inTenant("SELECT role, manager_id FROM crm_users WHERE email LIKE '%@demo-palmcrest.test' ORDER BY role, id");
  const managerRows = await inTenant("SELECT id FROM crm_users WHERE role = 'manager' AND email LIKE '%@demo-palmcrest.test'");
  assert.ok(team.filter(u => u.role === 'sales').every(u => u.manager_id === managerRows[0].id));

  const statuses = Object.fromEntries((await inTenant('SELECT status, COUNT(*)::int AS n FROM leads GROUP BY status')).map(r => [r.status, r.n]));
  for (const s of ['new', 'qualified', 'hot', 'contacted', 'converted', 'lost']) assert.ok(statuses[s] > 0, `status ${s}`);
  const outcomes = (await inTenant('SELECT DISTINCT outcome FROM crm_lead_outcomes')).map(r => r.outcome);
  for (const o of ['called_connected', 'no_answer', 'visit_booked', 'visited', 'no_show', 'joined', 'lost']) assert.ok(outcomes.includes(o), o);
  // Nothing will ever be sent: outcomes are not for Meta, staff replies are already "sent".
  assert.deepStrictEqual((await inTenant('SELECT DISTINCT meta_status FROM crm_lead_outcomes')).map(r => r.meta_status), ['skipped']);
  assert.ok((await inTenant('SELECT status FROM outbound_messages')).every(r => r.status === 'sent'));
  // Leads waiting for a person (open hand-offs), some unassigned; an overdue follow-up.
  assert.ok((await inTenant("SELECT COUNT(*)::int AS n FROM handoffs WHERE status IN ('pending', 'assigned')"))[0].n >= 6);
  assert.ok((await inTenant("SELECT COUNT(*)::int AS n FROM handoffs WHERE status = 'pending'"))[0].n >= 1);
  assert.ok((await inTenant("SELECT COUNT(*)::int AS n FROM crm_follow_ups WHERE status = 'open'"))[0].n >= 1);
  const revenue = (await inTenant("SELECT SUM(amount_inr)::bigint AS s FROM crm_lead_outcomes WHERE outcome = 'joined'"))[0].s;
  assert.ok(revenue >= 6 * 750000);

  // Second run: nothing new, no new staff, profile left alone.
  const second = await run();
  assert.deepStrictEqual([second.added, second.staff.length, second.profileWritten], [0, 0, false]);
  assert.strictEqual((await inTenant('SELECT COUNT(*)::int AS n FROM leads'))[0].n, LEADS);

  // A real lead the client added themselves survives --reset.
  await tenancy.run(t.id, () => db.query("INSERT INTO leads (wa_id, status) VALUES ('971551234567', 'new')"));
  const third = await run({ reset: true, now: new Date(NOW.getTime() + 7 * 86400000) });
  assert.deepStrictEqual([third.removed, third.added], [LEADS, LEADS]);
  assert.strictEqual((await inTenant("SELECT COUNT(*)::int AS n FROM leads WHERE wa_id = '971551234567'"))[0].n, 1);
  assert.strictEqual((await inTenant('SELECT COUNT(*)::int AS n FROM crm_users'))[0].n, 5); // team kept

  // GKF (tenant 1) untouched.
  assert.strictEqual((await db.one('SELECT COUNT(*)::int AS n FROM leads')).n, gkfLeadsBefore);

  // An edited profile is kept without --profile, and replacing it is reported.
  const businessProfile = require('../src/services/businessProfile');
  await tenancy.run(t.id, async () => {
    const p = (await db.one('SELECT profile FROM business_profile')).profile;
    await businessProfile.save({ ...p, hours: 'Sun-Thu 9-6 (edited by the client)' }, 'owner');
  });
  const kept = await run();
  assert.deepStrictEqual([kept.profileWritten, kept.profileReplaced], [false, false]);
  assert.match([].concat((await inTenant('SELECT profile FROM business_profile'))[0].profile.hours).join(' '), /edited by the client/);
  const replaced = await run({ writeProfile: true });
  assert.deepStrictEqual([replaced.profileWritten, replaced.profileReplaced], [true, true]);

  // --reset only deletes this client's own AI usage rows: "demo_palmcrest_" must not match "demo_palmcrestX".
  await tenancy.run(t.id, () => db.query("INSERT INTO ai_usage (request_id, model, success) VALUES ('demo_palmcrestX1', 'm', true)"));
  await run({ reset: true });
  assert.strictEqual((await inTenant("SELECT COUNT(*)::int AS n FROM ai_usage WHERE request_id = 'demo_palmcrestX1'"))[0].n, 1);
  await db.close();
});

test('a failed seed creates no staff (passwords would never be shown)', async () => {
  await db.close();
  await migrateAll();
  const t = await registry.create({ slug: 'lakeview', name: 'Lakeview Homes', phoneNumberId: '1000200030666', settings: { demo: true } });
  // A failure part-way through the leads (here: the third chat message) must roll back the staff too.
  const plan = planLeads({ slug: 'lakeview', region: 'ae', now: NOW });
  const orig = db.query;
  let calls = 0;
  db.query = async (sql, p) => { if (/INSERT INTO messages/.test(sql) && ++calls === 3) throw new Error('disk full'); return orig(sql, p); };
  try {
    await assert.rejects(tenancy.run(t.id, () => seedDemo(db, { slug: 'lakeview', name: 'Lakeview Homes', region: 'ae', now: NOW })), /disk full/);
  } finally { db.query = orig; }
  const staff = await tenancy.run(t.id, () => db.many("SELECT id FROM crm_users WHERE email LIKE '%@demo-lakeview.test'"));
  assert.strictEqual(staff.length, 0);
  assert.strictEqual((await tenancy.run(t.id, () => db.many('SELECT wa_id FROM leads'))).length, 0);
  assert.ok(plan.length > 0);
  await db.close();
});

test('India region: rupee prices and Bengaluru projects', async () => {
  await db.close();
  await migrateAll();
  const t = await registry.create({ slug: 'lakeview', name: 'Lakeview Homes', phoneNumberId: '1000200030666', crmHost: 'crm.lakeview.test', settings: { demo: true } });
  const r = await tenancy.run(t.id, () => seedDemo(db, { slug: 'lakeview', name: 'Lakeview Homes', region: 'in', now: NOW }));
  assert.strictEqual(r.added, LEADS);
  const profile = await tenancy.run(t.id, () => db.one('SELECT profile FROM business_profile'));
  assert.match(profile.profile.plans[0].price, /₹/);
  const min = await tenancy.run(t.id, () => db.one("SELECT MIN(amount_inr)::bigint AS m FROM crm_lead_outcomes WHERE outcome = 'joined'"));
  assert.ok(min.m >= 8500000);
  await assert.rejects(tenancy.run(t.id, () => seedDemo(db, { slug: 'lakeview', name: 'x', region: 'uk' })), /Unknown region/);
  await db.close();
});

test('rollback and starter detection: a failed --reset run changes nothing; an edited starter is not overwritten', async () => {
  await db.close();
  await migrateAll();
  const businessProfile = require('../src/services/businessProfile');
  const { isStarterProfile } = require('../scripts/demo');
  const t = await registry.create({ slug: 'harbour', name: 'Harbour Homes', phoneNumberId: '1000200030777', settings: { demo: true } });
  const run = opts => tenancy.run(t.id, () => seedDemo(db, { slug: 'harbour', name: 'Harbour Homes', region: 'ae', now: NOW, ...opts }));
  const inTenant = (sql, p) => tenancy.run(t.id, () => db.many(sql, p));

  // A client who edited hours but never filled in an address is not a "starter" any more.
  const starter = businessProfile.starterProfile({ name: 'Harbour Homes', type: 'realestate' });
  assert.ok(isStarterProfile(starter, businessProfile.starterProfile));
  await tenancy.run(t.id, () => businessProfile.save({ ...starter, hours: ['Sat-Thu 10-7'] }, 'owner'));
  assert.ok(!isStarterProfile((await inTenant('SELECT profile FROM business_profile'))[0].profile, businessProfile.starterProfile));
  const first = await run();
  assert.deepStrictEqual([first.added > 0, first.profileWritten], [true, false]);
  assert.deepStrictEqual((await inTenant('SELECT profile FROM business_profile'))[0].profile.hours, ['Sat-Thu 10-7']);

  // --reset with --profile, failing part-way: the old demo leads and the profile are still there.
  const leadsBefore = (await inTenant('SELECT COUNT(*)::int AS n FROM leads'))[0].n;
  const orig = db.query;
  let calls = 0;
  db.query = async (sql, p) => { if (/INSERT INTO messages/.test(sql) && ++calls === 5) throw new Error('disk full'); return orig(sql, p); };
  try {
    await assert.rejects(run({ reset: true, writeProfile: true }), /disk full/);
  } finally { db.query = orig; }
  assert.strictEqual((await inTenant('SELECT COUNT(*)::int AS n FROM leads'))[0].n, leadsBefore);
  assert.deepStrictEqual((await inTenant('SELECT profile FROM business_profile'))[0].profile.hours, ['Sat-Thu 10-7']);
  await db.close();
});

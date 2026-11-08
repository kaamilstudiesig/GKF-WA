/**
 * R14: fill one client with realistic sample data, so every CRM screen looks alive in a demo.
 *
 *   npm run demo -- --tenant <slug> --preset realestate --region ae   (Dubai: AED, Arabic)
 *   npm run demo -- --tenant <slug> --preset realestate --region in   (Bengaluru: ₹, Hinglish)
 *   add --profile to also write the business profile (projects, unit prices, policies);
 *   it is written anyway while the profile is still the blank starter.
 *   add --reset to delete this client's demo leads first and recreate them with fresh dates.
 *
 * Safe:
 * - Never for tenant 1 (the live business). On any database other than local PGlite, only for a
 *   client marked as a demo (tenant setting demo: true), whatever NODE_ENV says: a laptop pointed
 *   at Heroku's DATABASE_URL is treated like production.
 * - Same data every run (seeded by the client's slug): lead keys and staff emails repeat,
 *   so a second run adds nothing. --reset touches only rows marked metadata.demo.
 * - Phones are test ranges only (+971 50 000 xxxx, +91 98000 xxxxx), names are made up.
 * - Nothing leaves the database: outcomes are marked as not for Meta (meta_status skipped),
 *   staff replies are stored as already sent, so no worker ever sends them.
 */
const { REGIONS, profile: buildProfile } = require('./demo/realestate');

const PRESETS = { realestate: REGIONS };
const HOUR = 3600 * 1000;
const MIN = 60 * 1000;
const LEADS = 60;

// How many leads take each path through the funnel (adds up to LEADS).
const JOURNEYS = [
  ['new', 8], ['qualified', 6], ['waiting', 6], ['contacted', 8], ['no_answer', 5],
  ['visit_booked', 7], ['visited', 5], ['no_show', 3], ['won', 6], ['lost', 6]
];
const LOST_REASONS = ['price', 'distance', 'timing', 'joined_elsewhere', 'not_interested', 'no_response'];
const STATUS = {
  new: 'new', qualified: 'qualified', waiting: 'hot', contacted: 'contacted', no_answer: 'qualified',
  visit_booked: 'hot', visited: 'hot', no_show: 'hot', won: 'converted', lost: 'lost'
};

/** Small seeded random generator (mulberry32), so every run builds the same data. */
function seeded(text) {
  let h = 1779033703 ^ text.length;
  for (let i = 0; i < text.length; i++) { h = Math.imul(h ^ text.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = h >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)), pick: list => list[Math.floor(next() * list.length)] };
}

const fill = (text, v) => text.replace(/\{(\w+)\}/g, (m, k) => (v[k] !== undefined ? v[k] : m));
const emailFor = (first, last, slug) => `${first}.${last}`.toLowerCase().replace(/[^a-z.]/g, '') + `@demo-${slug}.test`;

/** Builds the plan for every lead: pure, no database. Exported for tests. */
function planLeads({ slug, region, now = new Date(), preset = 'realestate' }) {
  const r = PRESETS[preset][region];
  const rng = seeded(`${slug}:${region}`);
  const kinds = JOURNEYS.flatMap(([k, n]) => Array(n).fill(k));
  for (let i = kinds.length - 1; i > 0; i--) { const j = Math.floor(rng.next() * (i + 1)); [kinds[i], kinds[j]] = [kinds[j], kinds[i]]; }
  const t = ms => new Date(now.getTime() - ms);

  return kinds.map((kind, i) => {
    const lang = rng.pick(r.langs);
    const project = rng.pick(r.projects);
    const unit = rng.pick(r.units);
    const v = { p: project.name, u: unit.name, b: rng.pick(r.budgets), price: unit.price };
    const ad = rng.next() < 0.65 ? rng.pick(r.ads) : null;
    const name = i % 20 === 7 ? null : `${r.firstNames[i % r.firstNames.length]} ${r.lastNames[(i * 7) % r.lastNames.length]}`;
    // Age of the lead: fresh ones for new/waiting, others spread over 30 days.
    // Journeys with a past visit or a sale need older leads, so every date lands before now.
    const ageH = kind === 'new' ? rng.int(1, 30) : kind === 'waiting' ? rng.int(3, 20)
      : kind === 'visit_booked' ? rng.int(12, 60)
      : kind === 'won' ? rng.int(12 * 24, 30 * 24)
      : ['visited', 'no_show', 'lost'].includes(kind) ? rng.int(8 * 24, 30 * 24)
      : rng.int(36, 30 * 24);
    const first = t(ageH * HOUR);
    const at = m => new Date(first.getTime() + m * MIN);
    const line = map => map[lang] || map.en;

    const chat = [['in', fill(rng.pick(r.opener[lang] || r.opener.en), v), at(0)], ['out', fill(line(r.botPrice), v), at(1)]];
    const engaged = kind !== 'new';
    if (engaged) chat.push(['in', fill(line(r.budgetLine), v), at(rng.int(4, 40))]);
    const wantsVisit = !['new', 'qualified'].includes(kind);
    if (wantsVisit) {
      chat.push(['in', line(r.visitLine), at(rng.int(45, 90))], ['out', line(r.botVisit), at(91)]);
      if (kind === 'no_answer') chat.push(['in', line(r.laterLine), at(rng.int(95, 140))]);
    }
    const handoffAt = wantsVisit ? at(92) : null;
    // First human contact: usually within minutes, sometimes much later.
    const contactAt = handoffAt && new Date(handoffAt.getTime() + (rng.next() < 0.75 ? rng.int(2, 25) : rng.int(60, 600)) * MIN);
    const day = d => new Date(contactAt.getTime() + d * 24 * HOUR);
    const outcomes = [];
    const add = (outcome, when, extra = {}) => outcomes.push({ outcome, at: when > now ? new Date(now.getTime() - MIN) : when, ...extra });
    let visitAt = null;
    if (kind === 'contacted') add(rng.next() < 0.6 ? 'called_connected' : 'whatsapp_sent', contactAt);
    if (kind === 'no_answer') add('no_answer', contactAt);
    if (['visit_booked', 'visited', 'no_show', 'won'].includes(kind)) {
      add('called_connected', contactAt);
      visitAt = kind === 'visit_booked' ? new Date(now.getTime() + rng.int(1, 4) * 24 * HOUR) : day(rng.int(2, 4));
      add('visit_booked', new Date(contactAt.getTime() + 5 * MIN), { visitAt });
    }
    if (['visited', 'won'].includes(kind)) add('visited', new Date(visitAt.getTime() + 2 * HOUR));
    if (kind === 'no_show') add('no_show', new Date(visitAt.getTime() + 3 * HOUR));
    if (kind === 'won') {
      const amount = Math.round((unit.from + rng.next() * (unit.to - unit.from)) / 10000) * 10000;
      add('joined', new Date(visitAt.getTime() + rng.int(1, 6) * 24 * HOUR), { plan: `${unit.name}, ${project.name}`, amount });
    }
    if (kind === 'lost') {
      add(rng.next() < 0.5 ? 'called_connected' : 'no_answer', contactAt);
      add('lost', day(rng.int(1, 6)), { reason: rng.pick(LOST_REASONS) });
    }
    return {
      waId: r.phone(i), name, kind, status: STATUS[kind], lang, ad, interest: `${unit.name}, ${project.name}`,
      chat, firstAt: first, handoffAt, contactAt, outcomes: outcomes.sort((a, b) => a.at - b.at), visitAt,
      // Waiting leads: two left unassigned for the manager to pick up.
      rep: kind === 'waiting' && i % 3 === 0 ? null : i % 4
    };
  });
}

/** Creates the demo team (one manager, four sales) once. Returns the new people with one-time passwords. */
async function ensureStaff(db, { slug, region, preset = 'realestate' }) {
  const { hashPassword, oneTimePassword } = require('../crm/src/auth');
  const r = PRESETS[preset][region];
  const created = [];
  const upsert = async (first, last, role, managerId) => {
    const email = emailFor(first, last, slug);
    const found = await db.one('SELECT id FROM crm_users WHERE lower(email) = lower($1)', [email]);
    if (found) return found.id;
    const password = oneTimePassword();
    const row = await db.one(`INSERT INTO crm_users (email, name, role, manager_id, password_hash, must_change_password, active)
      VALUES ($1, $2, $3, $4, $5, true, true) RETURNING id`, [email, `${first} ${last}`, role, managerId, hashPassword(password)]);
    created.push({ name: `${first} ${last}`, email, role, password });
    return row.id;
  };
  const managerId = await upsert(...r.staff.manager, 'manager', null);
  const reps = [];
  for (const [first, last] of r.staff.sales) reps.push(await upsert(first, last, 'sales', managerId));
  return { managerId, reps, created };
}

/** Deletes this client's demo leads and everything hanging off them (only rows marked demo). */
async function resetDemo(db, { slug }) {
  const rows = await db.many("SELECT wa_id FROM leads WHERE metadata ->> 'demo' = 'true'");
  const ids = rows.map(r => r.wa_id);
  if (ids.length) {
    for (const table of ['crm_follow_ups', 'crm_lead_outcomes', 'crm_lead_notes', 'crm_lead_assignments', 'crm_activity_log',
      'outbound_messages', 'messages', 'handoffs']) {
      await db.query(`DELETE FROM ${table} WHERE wa_id = ANY($1::text[])`, [ids]);
    }
    await db.query('DELETE FROM leads WHERE wa_id = ANY($1::text[])', [ids]);
  }
  await db.query('DELETE FROM ai_usage WHERE left(request_id, length($1)) = $1', [`demo_${slug}_`]); // no LIKE: _ is a wildcard
  return ids.length;
}

/** Same keys and values in any order (for comparing saved JSON with a freshly built one). */
const stable = v => (Array.isArray(v) ? v.map(stable) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v);

/** True when a saved profile is still the untouched starter (name and type aside). */
function isStarterProfile(profile, starterProfile) {
  const starter = starterProfile({ name: profile.name, type: profile.type });
  const strip = p => { const { name, type, ...rest } = p; return JSON.stringify(stable(rest)); };
  return strip(profile) === strip(starter);
}

/**
 * Fills the current tenant (run inside tenancy.run) with demo data. Returns
 * { added, removed, staff, profileWritten }. Skips leads that already exist.
 */
async function seedDemo(db, { slug, name, region = 'ae', preset = 'realestate', reset = false, writeProfile = false, now = new Date() }) {
  if (!PRESETS[preset]) throw new Error(`Unknown preset "${preset}". Available: ${Object.keys(PRESETS).join(', ')}`);
  if (!PRESETS[preset][region]) throw new Error(`Unknown region "${region}". Available: ${Object.keys(PRESETS[preset]).join(', ')}`);
  const businessProfile = require('../src/services/businessProfile');
  const current = await db.one('SELECT profile FROM business_profile');
  // The blank starter profile is replaced freely; anything the client edited (hours, plans,
  // policies, address...) only with --profile, and the output says so.
  const isStarter = !current || isStarterProfile(current.profile, businessProfile.starterProfile);
  const profileWritten = writeProfile || isStarter;
  const profileReplaced = profileWritten && !isStarter;
  const plan = planLeads({ slug, region, now, preset });
  const pack = PRESETS[preset][region];

  // Everything in one transaction: if any step fails, nothing changes (no leads deleted by
  // --reset, no profile replaced, no staff whose one-time passwords were never shown).
  let added = 0; let team; let removed = 0;
  await db.tx(async () => {
    if (reset) removed = await resetDemo(db, { slug });
    // Staff in the same transaction as the leads: if anything fails, nobody is created whose
    // one-time password was never shown.
    team = await ensureStaff(db, { slug, region, preset });
    const repEmail = {};
    for (const r of await db.many('SELECT id, email FROM crm_users WHERE id = ANY($1::int[])', [team.reps])) repEmail[r.id] = r.email;
    for (const l of plan) {
      const lastIn = [...l.chat].reverse().find(c => c[0] === 'in')[2];
      const lastOut = [...l.chat].reverse().find(c => c[0] === 'out')[2];
      const openHandoff = ['waiting', 'no_answer'].includes(l.kind);
      const metadata = { demo: true, ...(l.ad ? { referral: { platform: l.ad.platform, source_id: l.ad.id, headline: l.ad.headline, source_type: 'ad' } } : {}) };
      const res = await db.query(`INSERT INTO leads (wa_id, phone, display_name, status, interest, source, first_contact_at, last_inbound_message_at,
          last_outbound_message_at, needs_human, handoff_reason, metadata, created_at, updated_at)
        VALUES ($1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $6, $7)
        ON CONFLICT (tenant_id, wa_id) DO NOTHING`,
      [l.waId, l.name, l.status, l.interest, l.ad ? `${l.ad.platform}_ad` : 'whatsapp_inbound', l.firstAt.toISOString(),
        lastIn.toISOString(), lastOut.toISOString(), openHandoff, l.handoffAt ? 'ready_to_book' : null, JSON.stringify(metadata)]);
      if (!res.rowCount) continue; // already there from an earlier run
      added++;

      for (let i = 0; i < l.chat.length; i++) {
        const [dir, text, when] = l.chat[i];
        await db.query(`INSERT INTO messages (message_id, wa_id, direction, text, timestamp, created_at)
          VALUES ($1, $2, $3, $4, $5, $5) ON CONFLICT (tenant_id, message_id) DO NOTHING`,
        [`wamid.demo_${l.waId}_${i}`, l.waId, dir, text, when.toISOString()]);
      }
      const userId = l.rep === null ? null : team.reps[l.rep % team.reps.length];
      if (l.handoffAt) {
        const status = openHandoff ? (userId ? 'assigned' : 'pending') : 'resolved';
        await db.query(`INSERT INTO handoffs (wa_id, status, reason, summary, assigned_to, resolved_at, created_at, updated_at)
          VALUES ($1, $2, 'ready_to_book', $3, $4, $5, $6, $6)`,
        [l.waId, status, pack.handoffSummary(l.interest), userId ? repEmail[userId] : null,
          status === 'resolved' ? (l.contactAt || l.handoffAt).toISOString() : null, l.handoffAt.toISOString()]);
      }
      if (userId && l.handoffAt) {
        await db.query('INSERT INTO crm_lead_assignments (wa_id, user_id, assigned_at) VALUES ($1, $2, $3)',
          [l.waId, userId, new Date(l.handoffAt.getTime() + MIN).toISOString()]);
      }
      for (const o of userId ? l.outcomes : []) {
        await db.query(`INSERT INTO crm_lead_outcomes (wa_id, user_id, outcome, visit_at, plan, amount_inr, lost_reason, meta_status, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, 'skipped', $8)`,
        [l.waId, userId, o.outcome, o.visitAt ? o.visitAt.toISOString() : null, o.plan || null, o.amount || null, o.reason || null, o.at.toISOString()]);
        if (o.outcome === 'whatsapp_sent') {
          // A staff reply from the CRM, stored as already sent (never queued for WhatsApp).
          await db.query(`INSERT INTO outbound_messages (dedup_key, wa_id, text, status, sent_at, metadata, created_at)
            VALUES ($1, $2, $3, 'sent', $4, $5::jsonb, $4)`,
          [`crm:demo_${l.waId}`, l.waId, pack.staffReply, o.at.toISOString(),
            JSON.stringify({ source: 'crm', user_id: userId, demo: true })]);
        }
      }
      // Open follow-ups: retries after no answer (some overdue), "did they come?" after a booked visit.
      if (userId && l.kind === 'no_answer') {
        await db.query(`INSERT INTO crm_follow_ups (wa_id, user_id, title, due_at, source) VALUES ($1, $2, $3, $4, 'outcome')`,
          [l.waId, userId, pack.followUps.noAnswer, new Date(l.contactAt.getTime() + 2 * HOUR).toISOString()]);
      }
      if (userId && l.kind === 'visit_booked') {
        await db.query(`INSERT INTO crm_follow_ups (wa_id, user_id, title, due_at, source) VALUES ($1, $2, $3, $4, 'outcome')`,
          [l.waId, userId, pack.followUps.visit, new Date(l.visitAt.getTime() + 2 * HOUR).toISOString()]);
      }
    }
    const { n } = await db.one('SELECT COUNT(*)::int AS n FROM ai_usage WHERE left(request_id, length($1)) = $1', [`demo_${slug}_`]);
    if (n === 0) {
      for (let i = 0; i < 30; i++) {
        await db.query(`INSERT INTO ai_usage (request_id, model, input_tokens, output_tokens, cost_usd, latency_ms, success, created_at)
          VALUES ($1, 'deepseek/deepseek-v4.1-flash', $2, $3, $4, $5, true, $6)`,
        [`demo_${slug}_${i}`, 1100 + i * 9, 140 + i, 0.00025 + (i % 5) * 0.00004, 900 + i * 11, new Date(now.getTime() - i * 23 * HOUR).toISOString()]);
      }
    }
    // Last, so a failure above leaves the profile (and its in-memory copy) untouched.
    // Keep the business name the client already has (a new client's starter profile carries it).
    if (profileWritten) await businessProfile.save(buildProfile((current && current.profile.name) || name, region), 'demo');
  });
  return { added, removed, staff: team.created, profileWritten, profileReplaced };
}

/**
 * Guard: never tenant 1 (the live business), and on any database other than local PGlite only
 * clients marked as demos. NODE_ENV is not trusted: a laptop with Heroku's DATABASE_URL counts as live.
 */
function assertAllowed(tenant, { dbKind } = {}) {
  if (tenant.isDefault) throw new Error(`Refusing: "${tenant.slug}" is tenant 1, the live business. Demo data only goes into a separate demo client.`);
  if (dbKind !== 'pglite' && !tenant.demo) {
    throw new Error(`Refusing: "${tenant.slug}" is not marked as a demo client. Set its "demo" setting to true first (npm run tenant -- set ${tenant.slug} <file>).`);
  }
}

if (require.main === module) {
  const db = require('../src/db');
  const { migrateAll } = require('../src/migrate');
  const tenancy = require('../src/tenancy/context');
  const { tenantFromArgs } = require('./lib/tenantArg');
  const flag = (args, n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  (async () => {
    try {
      await migrateAll();
      const { tenant, args } = await tenantFromArgs();
      assertAllowed(tenant, { dbKind: db.driverKind() });
      const preset = flag(args, '--preset') || 'realestate';
      const region = flag(args, '--region') || 'ae';
      const r = await tenancy.run(tenant.id, () => seedDemo(db, {
        slug: tenant.slug, name: tenant.name, region, preset, reset: args.includes('--reset'), writeProfile: args.includes('--profile')
      }));
      console.log(`Demo data for ${tenant.name} (${tenant.slug}, ${preset}, ${region}):`);
      if (r.profileReplaced) console.log('- business profile REPLACED (it had been edited): the name is kept; projects, unit prices, hours and policies are now sample data');
      else if (r.profileWritten) console.log('- business profile: projects, unit prices and policies written');
      if (r.removed) console.log(`- removed ${r.removed} old demo leads`);
      console.log(r.added ? `- added ${r.added} leads with chats, hand-offs, site visits, bookings and follow-ups` : '- demo leads are already there (use --reset for fresh dates)');
      if (r.staff.length) {
        console.log('- demo team created. One-time passwords (shown once; they change it at first login):');
        for (const s of r.staff) console.log(`    ${s.role.padEnd(7)} ${s.email}  ${s.password}`);
      }
    } finally {
      await db.close();
    }
  })().catch(err => { console.error(err.message); process.exit(1); });
}

module.exports = { seedDemo, planLeads, resetDemo, assertAllowed, ensureStaff, isStarterProfile, JOURNEYS, LEADS };

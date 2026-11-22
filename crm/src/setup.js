const { HttpError } = require('./crm');

/**
 * R8: the setup wizard (/setup, owners). Each step's state is worked out from what is really there
 * (the saved profile, staff, the connected number, messages), so it can't drift from the truth.
 * Nothing here calls Meta or the AI, and tokens are never read (contract K9 <-> R8 in docs/TEAM.md):
 * the number's state comes from tenant.whatsapp.setup only.
 *
 * The owner's ticks on the test checklist are rows in crm_activity_log (action setup_check, the
 * latest per key wins), like dailyNudges and retention keep theirs: no table, and it shows who ticked.
 */

// A business this busy has tested the assistant for real; it isn't asked to tick the checklist.
const LIVE_LEADS = 25;

/** The test conversation (docs/ONBOARDING.md, "Test checklist"), in this business's words. */
function testItems({ visit = 'visit', businessName = 'your business' } = {}) {
  return [
    { key: 'hi', say: 'Hi', expect: `A greeting with the name ${businessName} and at most one question` },
    { key: 'price', say: 'What are your prices?', expect: 'Only prices from your profile' },
    { key: 'visit', say: `Can I book a ${visit}?`, expect: 'It asks for a day or hands over to your team, and the alert arrives' },
    { key: 'language', say: 'The same question in another language your leads use', expect: 'A reply in that language' },
    { key: 'discount', say: 'Any discount for me?', expect: 'No invented offers' },
    { key: 'human', say: 'Call me', expect: 'A hand-off: the lead shows here under Needs human, with the reason' },
    { key: 'unknown', say: 'Something your profile does not say', expect: 'It says the team will check, and makes nothing up' },
    { key: 'offtopic', say: 'A sensitive or off-topic question', expect: 'It stays on your business' },
    { key: 'thanks', say: 'ok thanks', expect: 'A short goodbye, no new question' },
    { key: 'image', say: 'Send a photo', expect: 'It answers without an error' },
    { key: 'stop', say: 'STOP, then Hi', expect: 'It confirms it will not message you; then Hi gets a normal reply' }
  ];
}

/** Step names of the number's setup (K9), in words. */
const WA_STEPS = { subscribed: 'Messages reach us', registered: 'Number registered', smb_app_state_sync: 'Contacts sync started', history: 'Chat history sync started' };

/** The profile facts a new client still has from the starting profile (or doesn't have at all). */
function profileMissing(profile, starter, labels = {}) {
  const missing = [];
  if (!profile.address || profile.address === starter.address) missing.push('address');
  if (!(profile.hours || []).length || profile.hours[0] === starter.hours[0]) missing.push('opening hours');
  if (!(profile.programs || []).length) missing.push((labels.programs || 'what you offer').toLowerCase());
  if (!(profile.plans || []).length || profile.plans[0].price === starter.plans[0].price) missing.push((labels.plans || 'prices').toLowerCase());
  return missing;
}

/**
 * What the owner sees about the WhatsApp number. Picks fields; never passes the tenant (or a token) on.
 * state: connected | problem (a setup step failed) | ready (show the button) | blocked (say why).
 */
function whatsappState(tenant, { blockedReason, canLink, now = Date.now() }) {
  const wa = (tenant && tenant.whatsapp) || {};
  const s = wa.setup || null;
  if (wa.phoneNumberId) {
    const steps = s ? Object.keys(WA_STEPS).filter(k => s.steps && s.steps[k]).map(k => WA_STEPS[k]) : [];
    const daysLeft = s && s.tokenExpiresAt ? Math.floor((new Date(s.tokenExpiresAt).getTime() - now) / 86400000) : null;
    return {
      state: s && s.lastError ? 'problem' : 'connected',
      number: (s && s.number) || null, name: (s && s.verifiedName) || null, mode: (s && s.mode) || null, steps,
      error: s && s.lastError ? String(s.lastError.message || 'A setup step failed').slice(0, 200) : null,
      daysLeft
    };
  }
  const reason = blockedReason(tenant);
  if (reason) return { state: 'blocked', reason };
  return canLink() ? { state: 'ready' } : { state: 'blocked', reason: 'WhatsApp connection is not switched on yet. Contact us.' };
}

class Setup {
  constructor(db) { this.db = db; }

  /** Facts from the database, in one query (row-level security keeps it to this client). */
  async facts() {
    return this.db.one(`SELECT
      (SELECT COUNT(*) FROM crm_users WHERE active AND role <> 'owner')::int AS staff,
      (SELECT COUNT(*) FROM crm_users WHERE active AND role = 'sales')::int AS sales,
      (SELECT COUNT(*) FROM crm_users WHERE active AND alert_mode <> 'off' AND alert_phone IS NOT NULL)::int AS alerts,
      EXISTS (SELECT 1 FROM crm_branding WHERE logo_data IS NOT NULL) AS logo,
      EXISTS (SELECT 1 FROM crm_branding) AS branded,
      EXISTS (SELECT 1 FROM messages WHERE direction = 'in') AS got_message,
      EXISTS (SELECT 1 FROM messages WHERE direction = 'out') AS replied,
      EXISTS (SELECT 1 FROM handoffs) AS handed_off,
      EXISTS (SELECT 1 FROM crm_lead_outcomes) AS logged,
      (SELECT COUNT(*) FROM (SELECT 1 FROM leads WHERE last_inbound_message_at IS NOT NULL LIMIT ${LIVE_LEADS}) x)::int AS wrote`);
  }

  /** { key: { by, at } } for the ticked test items. */
  async checks() {
    const rows = await this.db.many(`SELECT DISTINCT ON (al.details ->> 'key') al.details ->> 'key' AS key, al.details ->> 'done' AS done,
        u.name AS by, al.created_at AS at
      FROM crm_activity_log al LEFT JOIN crm_users u ON u.id = al.user_id
      WHERE al.action = 'setup_check' ORDER BY al.details ->> 'key', al.id DESC`);
    return Object.fromEntries(rows.filter(r => r.done === 'true').map(r => [r.key, { by: r.by, at: r.at }]));
  }

  /** Checks the tick's key; the caller logs it (crm.log setup_check). */
  static checkInput(body) {
    const key = String((body && body.key) || '');
    if (!testItems().some(i => i.key === key)) throw new HttpError(400, 'Unknown test.');
    return { key, done: body.done === '1' };
  }

  /**
   * The whole wizard. profile/starter: the saved and the starting business profile. labels: the
   * business type's words. whatsapp: whatsappState(). reportsToMeta: Conversions API on (optional step).
   */
  async status({ profile, starter, labels = {}, visit, whatsapp, reportsToMeta = false }) {
    const f = await this.facts();
    const ticks = await this.checks();
    const items = testItems({ visit, businessName: profile.name }).map(i => ({ ...i, tick: ticks[i.key] || null }));
    const ticked = items.filter(i => i.tick).length;
    const missing = profileMissing(profile, starter, labels);
    const live = f.wrote >= LIVE_LEADS;
    const seen = [
      { label: 'A message arrived', done: f.got_message },
      { label: 'A reply went out', done: f.replied },
      { label: 'A lead was handed to your team', done: f.handed_off },
      { label: 'Someone logged an outcome', done: f.logged }
    ];
    const steps = [
      { key: 'profile', title: 'Your business', done: !missing.length, missing },
      { key: 'brand', title: 'Your brand', done: f.branded, optional: true, logo: f.logo },
      { key: 'team', title: 'Your team', done: f.staff > 0 || f.alerts > 0, staff: f.staff, sales: f.sales, alerts: f.alerts },
      { key: 'whatsapp', title: 'WhatsApp', done: whatsapp.state === 'connected', whatsapp },
      { key: 'test', title: 'Test it', done: seen.every(s => s.done) && (live || ticked === items.length), seen, items, ticked, live },
      { key: 'ads', title: 'Ads', done: reportsToMeta, optional: true }
    ];
    const required = steps.filter(s => !s.optional);
    const done = required.filter(s => s.done).length;
    return { steps, done, total: required.length, complete: done === required.length, next: (required.find(s => !s.done) || { key: null }).key };
  }
}

module.exports = { Setup, testItems, profileMissing, whatsappState, LIVE_LEADS };

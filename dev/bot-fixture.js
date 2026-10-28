/**
 * DEV / TEST ONLY. DELETE THIS FILE AFTER MERGING THE CRM INTO THE BOT APP.
 *
 * A copy of the WhatsApp bot's Postgres tables (GKF-WA, branch heroku-postgres,
 * src/db/schema.js migration 1) plus sample leads, so the CRM runs on PGlite
 * without the bot. In production the bot owns and migrates these tables; the
 * CRM never creates them. Bot-only tables (webhook_events, schema_migrations)
 * are left out on purpose.
 *
 * src/server.js loads this only when DATABASE_URL is pglite:// and the bot
 * tables are missing. It refuses to run against any other database.
 */
const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'hot', 'cold', 'converted', 'lost'];
const HANDOFF_REASONS = [
  'ready_to_book', 'price_negotiation', 'custom_program', 'injury_question', 'human_requested',
  'complaint', 'rate_limit_exceeded', 'ai_service_unavailable', 'ai_network_error', 'budget_exceeded', 'other'
];
const list = values => values.map(v => `'${v}'`).join(', ');

// ---- copy of the bot's schema (keep in sync with GKF-WA src/db/schema.js) ----
const BOT_TABLES = [
  `CREATE TABLE leads (
    wa_id TEXT PRIMARY KEY,
    display_name TEXT,
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN (${list(LEAD_STATUSES)})),
    interest TEXT,
    source TEXT NOT NULL DEFAULT 'whatsapp_inbound',
    first_contact_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_inbound_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_outbound_message_at TIMESTAMPTZ,
    needs_human BOOLEAN NOT NULL DEFAULT false,
    handoff_reason TEXT,
    notes TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE messages (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    message_id TEXT UNIQUE,
    wa_id TEXT NOT NULL REFERENCES leads (wa_id) ON DELETE CASCADE,
    direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
    text TEXT NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE handoffs (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    wa_id TEXT NOT NULL REFERENCES leads (wa_id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'assigned', 'resolved')),
    reason TEXT NOT NULL CHECK (reason IN (${list(HANDOFF_REASONS)})),
    summary TEXT,
    assigned_to TEXT,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX handoffs_one_open_per_lead ON handoffs (wa_id) WHERE status IN ('pending', 'assigned')`,
  `CREATE TABLE outbound_messages (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    dedup_key TEXT UNIQUE,
    wa_id TEXT NOT NULL,
    text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
    provider_message_id TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    locked_at TIMESTAMPTZ,
    sent_at TIMESTAMPTZ,
    failed_at TIMESTAMPTZ,
    last_error TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE ai_usage (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    request_id TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cost_usd DOUBLE PRECISION,
    latency_ms INTEGER,
    success BOOLEAN NOT NULL DEFAULT true,
    error_type TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`
];
// ---- end of copy ----

const HOUR = 3600 * 1000;
const iso = msAgo => new Date(Date.now() - msAgo).toISOString();

const SAMPLE_LEADS = [
  { wa: '919845012345', name: 'Rahul Sharma', status: 'hot', interest: 'trial_booking', hoursAgo: 1, handoff: 'ready_to_book', ad: ['instagram', '120211', 'Free 3-day trial at GKF'],
    chat: [['in', 'Hi, I want to join the gym. What are the timings?'], ['out', 'Hi Rahul! Goldkraft Fitness is open 5 AM to 11 PM on weekdays. Would you like to book a free trial session?'], ['in', 'Yes, can I come tomorrow morning at 7?']] },
  { wa: '919900112233', name: 'Priya Nair', status: 'qualified', interest: 'personal_training', hoursAgo: 3, handoff: 'custom_program',
    chat: [['in', 'Do you have personal trainers for women?'], ['out', 'Yes! We have certified trainers, including women trainers. What are your goals?'], ['in', 'Weight loss, about 8 kg. Need a custom plan.']] },
  { wa: '918050443322', name: 'Arjun Reddy', status: 'new', interest: 'membership_pricing', hoursAgo: 0.5, ad: ['instagram', '120211', 'Free 3-day trial at GKF'],
    chat: [['in', 'Monthly fees kitna hai?'], ['out', 'Our monthly membership is ₹4,040. Quarterly and yearly plans save more. Want the full price list?']] },
  { wa: '919731556677', name: 'Sneha Kulkarni', status: 'contacted', interest: 'crossfit', hoursAgo: 20,
    chat: [['in', 'Is there a CrossFit batch in the evening?'], ['out', 'Yes, our functional training batch runs 6–7 PM, Mon–Sat.']] },
  { wa: '917204889900', name: 'Mohammed Imran', status: 'hot', interest: 'annual_membership', hoursAgo: 5, handoff: 'price_negotiation',
    chat: [['in', 'If I take yearly membership can you give discount?'], ['out', 'Let me connect you with our team for the best yearly offer.'], ['in', 'Ok please call me after 6.']] },
  { wa: '919611223344', name: 'Kavya Gowda', status: 'cold', interest: 'yoga', hoursAgo: 72,
    chat: [['in', 'Do you have yoga classes?'], ['out', 'We focus on strength and functional training; we do have mobility sessions on weekends.'], ['in', 'Ok will think about it']] },
  { wa: '918123456789', name: 'Vikram Rao', status: 'converted', interest: 'annual_membership', hoursAgo: 120, ad: ['facebook', '120345', 'Annual plan offer'],
    chat: [['in', 'Signed up today, thanks!'], ['out', 'Welcome to the Goldkraft family, Vikram! 💪']] },
  { wa: '919886554433', name: 'Ananya Iyer', status: 'lost', interest: 'membership_pricing', hoursAgo: 200,
    chat: [['in', 'Too far from my place, sorry'], ['out', 'No problem, Ananya. Reach out anytime!']] },
  { wa: '919008877665', name: 'Karthik M', status: 'new', interest: null, hoursAgo: 2, handoff: 'injury_question',
    chat: [['in', 'I had a knee surgery last year. Can I still train?'], ['out', 'Please consult your doctor first. I am connecting you with our coach for a safe plan.']] },
  { wa: '917676543210', name: 'Deepa Hegde', status: 'qualified', interest: 'trial_booking', hoursAgo: 9,
    chat: [['in', 'Can I bring my friend for the trial too?'], ['out', 'Of course! Both of you can try a free session.']] },
  { wa: '919535667788', name: null, status: 'new', interest: null, hoursAgo: 30,
    chat: [['in', 'Hello'], ['out', 'Hi! Welcome to Goldkraft Fitness, JP Nagar. How can I help you today?']] },
  { wa: '918197334455', name: 'Suresh Babu', status: 'contacted', interest: 'personal_training', hoursAgo: 48, handoff: 'human_requested',
    chat: [['in', 'I want to talk to a real person'], ['out', 'Sure, our team will reach out to you shortly.']] }
];

/** Creates the copy of the bot tables and fills them with SAMPLE_LEADS. Only for empty dev/test databases. */
async function installBotFixture(db) {
  if (typeof db.kind !== 'function' || db.kind() !== 'pglite') {
    throw new Error('The bot fixture only runs on PGlite (dev/test). Real databases get these tables from the bot.');
  }
  await db.tx(async () => {
    for (const stmt of BOT_TABLES) await db.query(stmt);

    let n = 0;
    for (const l of SAMPLE_LEADS) {
      const lastInMs = l.hoursAgo * HOUR;
      const firstMs = lastInMs + l.chat.length * 10 * 60 * 1000 + 6 * HOUR;
      const lastIn = iso(lastInMs);
      const lastOutIdx = l.chat.map(c => c[0]).lastIndexOf('out');
      const msgTime = i => iso(lastInMs + (l.chat.length - 1 - i) * 5 * 60 * 1000 - (l.chat[i][0] === 'out' ? -60000 : 0));
      const metadata = l.ad ? { referral: { platform: l.ad[0], source_id: l.ad[1], headline: l.ad[2], source_type: 'ad' } } : {};
      await db.query(`INSERT INTO leads (wa_id, display_name, status, interest, source, first_contact_at, last_inbound_message_at,
          last_outbound_message_at, needs_human, handoff_reason, notes, metadata, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $6, $7)`,
      [l.wa, l.name, l.status, l.interest, l.ad ? `${l.ad[0]}_ad` : 'whatsapp_inbound', iso(firstMs), lastIn,
        lastOutIdx >= 0 ? msgTime(lastOutIdx) : null, Boolean(l.handoff), l.handoff || null,
        l.handoff ? `Bot: ${l.handoff.replace(/_/g, ' ')}` : null, JSON.stringify(metadata)]);
      for (let i = 0; i < l.chat.length; i++) {
        const [dir, text] = l.chat[i];
        await db.query('INSERT INTO messages (message_id, wa_id, direction, text, timestamp, created_at) VALUES ($1, $2, $3, $4, $5, $5)',
          [`wamid.demo_${++n}`, l.wa, dir, text, msgTime(i)]);
      }
      if (l.handoff) {
        await db.query("INSERT INTO handoffs (wa_id, status, reason, summary, created_at, updated_at) VALUES ($1, 'pending', $2, $3, $4, $4)",
          [l.wa, l.handoff, l.chat[l.chat.length - 1][1], lastIn]);
      }
    }
    for (let i = 0; i < 40; i++) {
      const model = i % 5 === 0 ? 'google/gemini-2.5-flash-lite' : 'z-ai/glm-5.3-flash';
      await db.query(`INSERT INTO ai_usage (request_id, model, input_tokens, output_tokens, cost_usd, latency_ms, success, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [`demo_${i}${i % 5 === 0 ? '_fallback' : ''}`, model, 900 + i * 7, 120 + i, 0.0002 + (i % 7) * 0.00005, 800 + i * 13, i % 13 !== 0, iso(i * 9 * HOUR)]);
    }
  });
  return SAMPLE_LEADS.length;
}

module.exports = { installBotFixture, SAMPLE_LEADS, BOT_TABLES };

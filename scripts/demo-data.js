/**
 * `npm run dev:demo-data`: inserts a dozen demo leads, with chats, hand-offs and
 * AI usage rows, into the bot's tables so the CRM has something to show locally.
 * Safe to run more than once (existing rows are skipped). Refuses to run with
 * NODE_ENV=production.
 *
 * Uses the same DATABASE_URL as `npm run dev` (PGlite in ./data/pglite by
 * default). PGlite allows one process at a time, so stop `npm run dev` first.
 */
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

/** Inserts SAMPLE_LEADS into the bot tables (which must already exist). Returns the number of new leads. */
async function insertDemoData(db) {
  return db.tx(async () => {
    let added = 0;
    for (const l of SAMPLE_LEADS) {
      const lastInMs = l.hoursAgo * HOUR;
      const firstMs = lastInMs + l.chat.length * 10 * 60 * 1000 + 6 * HOUR;
      const lastIn = iso(lastInMs);
      const lastOutIdx = l.chat.map(c => c[0]).lastIndexOf('out');
      const msgTime = i => iso(lastInMs + (l.chat.length - 1 - i) * 5 * 60 * 1000 - (l.chat[i][0] === 'out' ? -60000 : 0));
      const metadata = l.ad ? { referral: { platform: l.ad[0], source_id: l.ad[1], headline: l.ad[2], source_type: 'ad' } } : {};
      const res = await db.query(`INSERT INTO leads (wa_id, display_name, status, interest, source, first_contact_at, last_inbound_message_at,
          last_outbound_message_at, needs_human, handoff_reason, notes, metadata, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $6, $7)
        ON CONFLICT (wa_id) DO NOTHING`,
      [l.wa, l.name, l.status, l.interest, l.ad ? `${l.ad[0]}_ad` : 'whatsapp_inbound', iso(firstMs), lastIn,
        lastOutIdx >= 0 ? msgTime(lastOutIdx) : null, Boolean(l.handoff), l.handoff || null,
        l.handoff ? `Bot: ${l.handoff.replace(/_/g, ' ')}` : null, JSON.stringify(metadata)]);
      if (!res.rowCount) continue; // lead already there: leave it and its history alone
      added++;
      for (let i = 0; i < l.chat.length; i++) {
        const [dir, text] = l.chat[i];
        await db.query(`INSERT INTO messages (message_id, wa_id, direction, text, timestamp, created_at)
          VALUES ($1, $2, $3, $4, $5, $5) ON CONFLICT (message_id) DO NOTHING`,
        [`wamid.demo_${l.wa}_${i}`, l.wa, dir, text, msgTime(i)]);
      }
      if (l.handoff) {
        await db.query(`INSERT INTO handoffs (wa_id, status, reason, summary, created_at, updated_at)
          VALUES ($1, 'pending', $2, $3, $4, $4) ON CONFLICT DO NOTHING`,
        [l.wa, l.handoff, l.chat[l.chat.length - 1][1], lastIn]);
      }
    }
    const { n } = await db.one("SELECT COUNT(*)::int AS n FROM ai_usage WHERE request_id LIKE 'demo\\_%'");
    if (n === 0) {
      for (let i = 0; i < 40; i++) {
        const fallback = i % 5 === 0;
        await db.query(`INSERT INTO ai_usage (request_id, model, input_tokens, output_tokens, cost_usd, latency_ms, success, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [`demo_${i}${fallback ? '_fallback' : ''}`, fallback ? 'google/gemini-3.5-flash-lite' : 'deepseek/deepseek-v4.1-flash',
          900 + i * 7, 120 + i, 0.0002 + (i % 7) * 0.00005, 800 + i * 13, i % 13 !== 0, iso(i * 9 * HOUR)]);
      }
    }
    return added;
  });
}

if (require.main === module) {
  const db = require('../src/db');
  const { migrateAll } = require('../src/migrate');
  (async () => {
    if ((process.env.NODE_ENV || 'development') === 'production') {
      throw new Error('Refusing to insert demo data with NODE_ENV=production.');
    }
    try {
      await migrateAll();
      const added = await insertDemoData(db);
      console.log(added ? `Added ${added} demo leads with chats and hand-offs.` : 'Demo leads are already there.');
    } finally {
      await db.close();
    }
  })().catch(err => { console.error(err.message); process.exit(1); });
}

module.exports = { insertDemoData, SAMPLE_LEADS };

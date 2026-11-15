const db = require('../db');
const logger = require('../utils/logger');
const identity = require('./identity');
const registry = require('../tenancy/registry');
const signals = require('../workers/signals');

/**
 * R16: leads from portals and website forms (contract in docs/TEAM.md, "R16: lead intake").
 * accept() runs inside the client's tenant context (src/routes/intake.js does tenancy.run).
 * It never calls Meta itself: the welcome template goes through the outbound queue.
 *
 * Every submission is recorded in intake_submissions (accepted, duplicate, rejected or limited),
 * which gives the duplicate check, rate limits that hold across dynos, and the CRM's list.
 */

const SOURCES = ['website', 'property_finder', 'bayut', 'dubizzle', 'other'];
const SOURCE_LABELS = { website: 'website', property_finder: 'Property Finder', bayut: 'Bayut', dubizzle: 'Dubizzle', other: 'portal' };
const LIMITS = { formPerIpPerHour: 10, formPerPhonePerDay: 3 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAY_MS = 24 * 60 * 60 * 1000;

const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const truthy = v => v === true || ['true', 'on', '1', 'yes'].includes(String(v ?? '').toLowerCase());

/** Cleans a body ({ name, phone, email, message, source, sourceRef, utm, consent }). Returns { input } or { error }. */
function clean(body = {}, { phoneCountry = '91', channel = 'api' } = {}) {
  const source = channel === 'form' ? 'website' : text(body.source, 30).toLowerCase() || 'other';
  if (!SOURCES.includes(source)) return { error: `source must be one of ${SOURCES.join(', ')}.` };
  if (!text(body.phone, 40)) return { error: 'phone required' }; // v1: the lead key is a phone (contract change 1)
  const phone = identity.normalizePhone(body.phone, phoneCountry);
  if (!phone) return { error: 'phone is not a valid number' };
  const email = text(body.email, 120).toLowerCase();
  if (email && !EMAIL_RE.test(email)) return { error: 'email is not valid' };
  const utmIn = body.utm && typeof body.utm === 'object' ? body.utm
    : { source: body.utm_source, medium: body.utm_medium, campaign: body.utm_campaign, content: body.utm_content };
  const utm = Object.fromEntries(['source', 'medium', 'campaign', 'content'].map(k => [k, text(utmIn[k], 100)]).filter(([, v]) => v));
  return {
    input: {
      name: text(body.name, 80), phone, email: email || null, message: String(body.message ?? '').trim().slice(0, 2000),
      source, sourceRef: text(body.sourceRef ?? body.source_ref, 100) || null, utm, consent: truthy(body.consent)
    }
  };
}

const record = (row) => db.one(`INSERT INTO intake_submissions (channel, source, source_ref, wa_id, ip_hash, status, error)
  VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
[row.channel, row.source || null, row.sourceRef || null, row.waId || null, row.ipHash || null, row.status, row.error || null]);

/** The lead this phone belongs to: by leads.phone first, then by wa_id. */
const findLead = phone => db.one(`SELECT * FROM leads WHERE phone = $1 OR wa_id = $1
  ORDER BY (phone = $1) DESC, first_contact_at LIMIT 1`, [phone]);

const windowOpen = lead => {
  const t = lead && lead.last_inbound_message_at ? new Date(lead.last_inbound_message_at).getTime() : NaN;
  return Number.isFinite(t) && Date.now() - t <= DAY_MS && Date.now() >= t;
};

/**
 * Handles one submission. channel: 'form' (website snippet) or 'api' (signed, server to server).
 * Returns { status: 202 | 400 | 429, body }.
 */
async function accept({ channel, body, ipHash = null, businessName = '' }) {
  const cfg = registry.config().intake;
  const cleaned = clean(body, { phoneCountry: cfg.phoneCountry, channel });
  if (cleaned.error) {
    await record({ channel, source: text(body && body.source, 30) || null, ipHash, status: 'rejected', error: cleaned.error });
    return { status: 400, body: { ok: false, error: cleaned.error } };
  }
  const input = cleaned.input;
  const base = { channel, source: input.source, sourceRef: input.sourceRef, waId: input.phone, ipHash };

  // Website forms are limited per IP and per phone (signed calls only get the duplicate check).
  if (channel === 'form') {
    const c = await db.one(`SELECT
        (SELECT COUNT(*) FROM intake_submissions WHERE channel = 'form' AND ip_hash = $1 AND received_at > now() - interval '1 hour')::int AS ip,
        (SELECT COUNT(*) FROM intake_submissions WHERE channel = 'form' AND wa_id = $2 AND status = 'accepted' AND received_at > now() - interval '1 day')::int AS phone`,
    [ipHash, input.phone]);
    if (c.ip >= LIMITS.formPerIpPerHour || c.phone >= LIMITS.formPerPhonePerDay) {
      await record({ ...base, status: 'limited', error: c.ip >= LIMITS.formPerIpPerHour ? 'too many from this address' : 'too many for this phone' });
      return { status: 429, body: { ok: false, error: 'Too many submissions. Try again later.' } };
    }
  }

  // The same portal reference within 24 hours does nothing (portals retry).
  if (input.sourceRef) {
    const dup = await db.one(`SELECT id FROM intake_submissions WHERE source = $1 AND source_ref = $2 AND status = 'accepted'
      AND received_at > now() - interval '1 day' LIMIT 1`, [input.source, input.sourceRef]);
    if (dup) {
      await record({ ...base, status: 'duplicate' });
      return { status: 202, body: { ok: true, duplicate: true } };
    }
  }

  const label = SOURCE_LABELS[input.source];
  const intakeMeta = { channel, source: input.source, sourceRef: input.sourceRef, name: input.name || null, email: input.email,
    utm: input.utm, consent: input.consent, at: new Date().toISOString() };
  let lead = await findLead(input.phone);
  const isNew = !lead;
  if (isNew) {
    // last_inbound_message_at stays NULL: they haven't written on WhatsApp, so the 24-hour window is closed.
    lead = await db.one(`INSERT INTO leads (wa_id, phone, display_name, source, first_contact_at, last_inbound_message_at, metadata)
      VALUES ($1, $1, $2, $3, now(), NULL, $4::jsonb) RETURNING *`,
    [input.phone, input.name || null, `intake_${input.source}`, JSON.stringify({ intake: intakeMeta })]);
  } else {
    lead = await db.one(`UPDATE leads SET metadata = metadata || $2::jsonb, display_name = COALESCE(display_name, $3), updated_at = now()
      WHERE wa_id = $1 RETURNING *`, [lead.wa_id, JSON.stringify({ intake: intakeMeta }), input.name || null]);
  }
  const waId = lead.wa_id;

  if (input.message) {
    await db.query('INSERT INTO crm_lead_notes (wa_id, user_id, body) VALUES ($1, NULL, $2)', [waId, `From the ${label} form: ${input.message}`]);
  }

  // The first WhatsApp message: the approved welcome template, only with consent, never during a live
  // conversation, at most once per phone per 24 hours. K30 (opt-out) refuses it at send time for STOP leads.
  let welcome;
  if (lead.opted_out_at) welcome = 'Opted out of WhatsApp (wrote STOP): not messaged.'; // K30; a form is not a WhatsApp message, so it stays opted out
  else if (!input.consent) welcome = 'No WhatsApp consent on the form: not messaged.';
  else if (!cfg.welcomeTemplate) welcome = 'WhatsApp welcome not sent: template not set up.';
  else if (windowOpen(lead)) welcome = null; // they are chatting with us already
  else {
    const recent = await db.one(`SELECT id FROM outbound_messages WHERE wa_id = $1 AND metadata ->> 'source' = 'intake'
      AND created_at > now() - interval '1 day' LIMIT 1`, [input.phone]);
    if (recent) welcome = null;
    else {
      const outboundRepository = require('../db/outboundRepository');
      const queued = await outboundRepository.enqueue({
        dedupKey: `lead_welcome:${input.phone}:${Math.floor(Date.now() / DAY_MS)}`,
        waId: input.phone,
        text: `[Welcome template ${cfg.welcomeTemplate}] ${input.name || 'there'} · ${businessName}`,
        metadata: { source: 'intake', template: { name: cfg.welcomeTemplate, language: 'en', body: [input.name || 'there', businessName] } }
      });
      if (queued) signals.emit('outbound');
      welcome = queued ? 'WhatsApp welcome sent.' : null;
    }
  }

  // A hand-off, so the lead queue assigns it and staff are alerted. One open hand-off per lead: if
  // there is one, staff get one alert about the new submission instead.
  const who = [input.name, input.email].filter(Boolean).join(', ');
  const back = !isNew && ['lost', 'converted'].includes(lead.status) ? ` Came back through the ${label} form (was ${lead.status}).` : '';
  const summary = `${isNew ? 'New lead' : 'Lead'} from the ${label} form${who ? `: ${who}` : ''}.${back}${welcome ? ` ${welcome}` : ''}`.slice(0, 500);
  const open = await db.one("SELECT id FROM handoffs WHERE wa_id = $1 AND status IN ('pending', 'assigned')", [waId]);
  if (open) {
    const staffAlerts = require('./staffAlerts');
    staffAlerts.alert({ waId, event: 'handoff', details: summary });
  } else {
    const handoffRepository = require('../db/handoffRepository'); // lazy: it pulls in the lead queue
    await handoffRepository.open({ waId, reason: 'form_lead', summary });
  }
  await db.query("UPDATE leads SET needs_human = true, handoff_reason = 'form_lead', updated_at = now() WHERE wa_id = $1", [waId]);

  await record({ ...base, waId, status: 'accepted' });
  logger.info('Lead intake accepted', { channel, source: input.source, new_lead: isNew, wa_suffix: waId.slice(-4) });
  return { status: 202, body: { ok: true } };
}

module.exports = { accept, clean, SOURCES, SOURCE_LABELS, LIMITS };

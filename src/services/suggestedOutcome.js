const { OUTCOMES } = require('../../crm/src/constants');
const { LOST_REASONS } = require('../config/lostReasons');
const leadRepository = require('../db/leadRepository');
const notifyService = require('./notifyService');
const logger = require('../utils/logger');

/**
 * K13: the AI's reply can include an outcome it noticed in the chat ("paid for
 * the annual plan", "joined another gym"). It is only a suggestion: it is saved
 * on the lead (metadata.suggested_outcome) and staff confirm or dismiss it in
 * the CRM. The AI never logs an outcome itself.
 */
const TYPES = ['visit_booked', 'visited', 'joined', 'lost'];
const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/** Cleans the model's "outcome" field. Returns null when it is missing or invalid. */
function normalize(raw) {
  if (!raw || typeof raw !== 'object' || !TYPES.includes(raw.type)) return null;
  const s = { type: raw.type, label: OUTCOMES[raw.type], evidence: str(raw.evidence, 200), when: str(raw.when, 80) };
  if (raw.type === 'joined') {
    s.plan = str(raw.plan, 100);
    const amount = Number(String(raw.amount_inr ?? '').replace(/[₹,\s]/g, ''));
    s.amount_inr = Number.isInteger(amount) && amount > 0 && amount <= 100000000 ? amount : null; // up to ₹10 crore (real estate)
  }
  if (raw.type === 'lost') s.lost_reason = LOST_REASONS[raw.lost_reason] ? raw.lost_reason : 'other';
  return s;
}

/** Saves the suggestion on the lead and tells staff once. Skips repeats and sales already logged. */
async function save(lead, suggestion) {
  if (!suggestion || !lead) return lead;
  const current = (lead.metadata || {}).suggested_outcome;
  if (current && current.type === suggestion.type) return lead;
  if (lead.status === 'converted' && suggestion.type !== 'lost') return lead;
  if (lead.status === 'lost' && suggestion.type === 'lost') return lead;

  const metadata = { ...(lead.metadata || {}), suggested_outcome: { ...suggestion, at: new Date().toISOString() } };
  const updated = await leadRepository.update(lead.wa_id, { metadata });
  logger.info('Outcome suggested from chat', { wa_id: lead.wa_id, type: suggestion.type });

  const extra = [suggestion.plan, suggestion.amount_inr ? `₹${suggestion.amount_inr.toLocaleString('en-IN')}` : null, suggestion.when].filter(Boolean).join(' · ');
  const name = lead.display_name || lead.wa_id;
  const text = [`🤖 Possible outcome for <b>${esc(name)}</b>: ${esc(suggestion.label)}${extra ? ` (${esc(extra)})` : ''}`,
    suggestion.evidence ? `“${esc(suggestion.evidence)}”` : null, 'Confirm or dismiss it in the CRM.'].filter(Boolean).join('\n');
  const { buttons } = notifyService.leadLinks(lead.wa_id, updated || lead, { replyLabel: 'Open in CRM' });
  notifyService.send(text, { buttons }).catch(err => logger.warn('Suggestion alert failed', { error: err.message }));
  return updated || lead;
}

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

module.exports = { normalize, save, TYPES };

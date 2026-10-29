const leadRepository = require('../db/leadRepository');
const handoffRepository = require('../db/handoffRepository');
const aiPolicy = require('./aiPolicy');
const logger = require('../utils/logger');

/**
 * Applies updates proposed by the AI or the fixed-reply router after the
 * policy layer has checked them (e.g. the AI can never mark a lead converted).
 * Opens a staff hand-off when the update asks for a human.
 */
async function applyLeadUpdates(lead, proposed = {}) {
  const safe = aiPolicy.validateAndSanitizeUpdates(lead, proposed);
  // Only staff clear a hand-off; the bot can raise one but never lower it.
  if (safe.needs_human === false) { delete safe.needs_human; delete safe.handoff_reason; }
  if (Object.keys(safe).length === 0) return lead;

  if (safe.needs_human) {
    await handoffRepository.open({
      waId: lead.wa_id,
      reason: safe.handoff_reason || 'other',
      summary: proposed.summary || proposed.notes || null
    });
  }
  logger.info('Lead updated', { wa_id: lead.wa_id, fields: Object.keys(safe) });
  return leadRepository.update(lead.wa_id, safe);
}

module.exports = { applyLeadUpdates };

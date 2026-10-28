const leadRepository = require('../db/leadRepository');
const logger = require('../utils/logger');

/**
 * Click-to-WhatsApp ads (Instagram / Facebook) attach a `referral` object to the
 * first message a lead sends from the ad. This keeps the first ad that brought
 * each lead, so the CRM can report leads and sign-ups per ad.
 */
function extractReferral(msg) {
  const r = msg && msg.referral;
  if (!r || typeof r !== 'object') return null;
  const url = String(r.source_url || '');
  const platform = /instagram\.com/i.test(url) ? 'instagram' : /facebook\.com|fb\.me|fb\.com/i.test(url) ? 'facebook' : 'meta';
  const clip = (v, n) => (v === undefined || v === null ? null : String(v).slice(0, n));
  return {
    platform,
    source_type: clip(r.source_type, 20),
    source_id: clip(r.source_id, 64),
    source_url: clip(r.source_url, 500),
    headline: clip(r.headline, 200),
    body: clip(r.body, 500),
    media_type: clip(r.media_type, 20),
    ctwa_clid: clip(r.ctwa_clid, 200),
    captured_at: new Date().toISOString()
  };
}

/** Saves the ad on the lead if it doesn't already have one (first touch wins). */
async function applyReferral(lead, msg) {
  const referral = extractReferral(msg);
  if (!lead || !referral) return lead;
  if (lead.metadata && lead.metadata.referral) return lead;
  logger.info('Lead arrived from a Click-to-WhatsApp ad', { wa_id: lead.wa_id, platform: referral.platform, source_id: referral.source_id });
  return leadRepository.update(lead.wa_id, {
    source: `${referral.platform}_ad`,
    metadata: { ...(lead.metadata || {}), referral }
  });
}

module.exports = { extractReferral, applyReferral };

const crypto = require('crypto');
const axios = require('axios');
const env = require('../config/env');
const identity = require('./identity');

/**
 * Meta Conversions API for business messaging (click-to-WhatsApp ads).
 * Tells Meta which chats turned into real results so ads find more people like them:
 *   Visit booked -> QualifiedLead, Joined -> Purchase (₹ value).
 * https://developers.facebook.com/docs/marketing-api/conversions-api/business-messaging/
 * Meta does not de-duplicate these events; the caller must send each one once.
 */

const EVENTS = { visit_booked: 'QualifiedLead', joined: 'Purchase' };
const sha256 = v => crypto.createHash('sha256').update(String(v)).digest('hex');

class ConversionsApi {
  constructor() {
    this.transport = null; // tests replace this
  }

  get enabled() {
    return Boolean(env.metaDatasetId && env.metaWabaId && (this.transport || env.metaAccessToken));
  }

  /**
   * Builds the event for one outcome, or { skip } with the reason it can't be matched.
   * Matching: the ad click ID when the lead came from a click-to-WhatsApp ad, else the
   * hashed phone + Facebook Page ID (Meta only attributes those within 7 days of the ad).
   */
  buildEvent(outcome, lead) {
    const eventName = EVENTS[outcome.outcome];
    if (!eventName) return { skip: 'not_a_meta_event' };
    const userData = { whatsapp_business_account_id: env.metaWabaId };
    const clid = lead?.metadata?.referral?.ctwa_clid;
    if (clid) {
      userData.ctwa_clid = clid;
    } else {
      const phone = identity.toPhone(lead?.phone) || identity.toPhone(lead?.wa_id);
      if (!phone || !env.metaPageId) return { skip: 'no_ad_click_id' };
      userData.page_id = env.metaPageId;
      userData.ph = [sha256(phone)];
    }
    const event = {
      event_name: eventName,
      event_time: Math.floor(new Date(outcome.created_at).getTime() / 1000),
      action_source: 'business_messaging',
      messaging_channel: 'whatsapp',
      user_data: userData
    };
    if (eventName === 'Purchase') event.custom_data = { currency: 'INR', value: Number(outcome.amount_inr) || 0 };
    return { event };
  }

  /** Sends events. Returns Meta's response body; throws on HTTP errors (axios error). */
  async send(events) {
    const body = { data: events, partner_agent: 'lead-engine' };
    if (env.metaCapiTestEventCode) body.test_event_code = env.metaCapiTestEventCode;
    if (this.transport) return this.transport(body);
    const url = `https://graph.facebook.com/${env.metaGraphApiVersion}/${env.metaDatasetId}/events`;
    const res = await axios.post(url, body, {
      headers: { Authorization: `Bearer ${env.metaAccessToken}`, 'Content-Type': 'application/json' },
      timeout: 15000
    });
    return res.data;
  }
}

module.exports = new ConversionsApi();
module.exports.ConversionsApi = ConversionsApi;
module.exports.EVENTS = EVENTS;

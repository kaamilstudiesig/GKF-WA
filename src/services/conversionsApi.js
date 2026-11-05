const crypto = require('crypto');
const axios = require('axios');
const env = require('../config/env');
const identity = require('./identity');
const registry = require('../tenancy/registry');

/** The current tenant's dataset, WABA, page and token (tenant 1: the env vars). */
function capi() {
  const t = registry.config();
  return t ? { ...t.capi, wabaId: t.whatsapp.wabaId, accessToken: t.whatsapp.accessToken } : {};
}

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

  /** Whether the current tenant sends sales to Meta. */
  get enabled() {
    const c = capi();
    return Boolean(c.datasetId && c.wabaId && (this.transport || c.accessToken));
  }

  /** Whether any tenant does (starts the worker). */
  get enabledForAny() {
    return registry.list().some(t => t.capi.datasetId && t.whatsapp.wabaId && (this.transport || t.whatsapp.accessToken));
  }

  /**
   * Builds the event for one outcome, or { skip } with the reason it can't be matched.
   * Matching: the ad click ID when the lead came from a click-to-WhatsApp ad, else the
   * hashed phone + Facebook Page ID (Meta only attributes those within 7 days of the ad).
   */
  buildEvent(outcome, lead) {
    const eventName = EVENTS[outcome.outcome];
    if (!eventName) return { skip: 'not_a_meta_event' };
    const c = capi();
    const userData = { whatsapp_business_account_id: c.wabaId };
    const clid = lead?.metadata?.referral?.ctwa_clid;
    if (clid) {
      userData.ctwa_clid = clid;
    } else {
      const phone = identity.toPhone(lead?.phone) || identity.toPhone(lead?.wa_id);
      if (!phone || !c.pageId) return { skip: 'no_ad_click_id' };
      userData.page_id = c.pageId;
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
    const c = capi();
    const body = { data: events, partner_agent: 'lead-engine' };
    if (c.testEventCode) body.test_event_code = c.testEventCode;
    if (this.transport) return this.transport(body);
    const url = `https://graph.facebook.com/${env.metaGraphApiVersion}/${c.datasetId}/events`;
    const res = await axios.post(url, body, {
      headers: { Authorization: `Bearer ${c.accessToken}`, 'Content-Type': 'application/json' },
      timeout: 15000
    });
    return res.data;
  }
}

module.exports = new ConversionsApi();
module.exports.ConversionsApi = ConversionsApi;
module.exports.EVENTS = EVENTS;

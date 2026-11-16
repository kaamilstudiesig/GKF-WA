const db = require('../../db');
const registry = require('../../tenancy/registry');
const logger = require('../../utils/logger');
const zoho = require('./client');
const { ZohoError } = require('./client');

/**
 * K20: two-way sync between our leads and the client's Zoho CRM.
 *
 * Out (pushLead): a lead becomes a Zoho Lead (name, mobile, Lead Status). When it is won
 * (Joined with ₹), the Zoho Lead is converted into a Contact + Deal with the amount, in the
 * won stage. Lost sets Lead Status (or the Deal's lost stage).
 * In (pullChanges): Leads and Deals changed in Zoho since the last read. A Deal moved to the
 * won stage logs Joined here; a lost Lead Status or Deal stage logs Lost. Those go through the
 * CRM's normal outcome logic, so follow-ups close and the sale reaches Meta (K7).
 *
 * Matching: the Zoho record id we stored, else the lead key in an optional custom field
 * (zohoIdField, e.g. Lead_Engine_ID), else the mobile number. Loops are avoided by
 * remembering the last values on each side (zoho_links.zoho_state).
 */

const SYSTEM_NAME = 'Zoho';
const PULL_PAGES = 10; // 200 records a page; more than 2,000 changes between reads waits for the next read

// ---- pure helpers (tested directly) ----

/** "Rahul Kumar Sharma" -> { First_Name: 'Rahul Kumar', Last_Name: 'Sharma' }. Zoho requires Last_Name. */
function splitName(name) {
  const words = String(name || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (!words.length) return { Last_Name: 'WhatsApp lead' };
  if (words.length === 1) return { Last_Name: words[0].slice(0, 80) };
  return { First_Name: words.slice(0, -1).join(' ').slice(0, 40), Last_Name: words[words.length - 1].slice(0, 80) };
}

const mobile = phone => (phone && /^\d{6,15}$/.test(String(phone)) ? `+${phone}` : null);
const zohoDate = d => new Date(d).toISOString().slice(0, 10);
/** Zoho wants If-Modified-Since as ISO 8601 with an offset and no milliseconds. */
const sinceHeader = d => new Date(d).toISOString().replace(/\.\d{3}Z$/, '+00:00');

/**
 * The Zoho Lead fields for one of our leads.
 * create: first push (adds a short description). sendStatus: our status changed since the last push.
 */
function leadRecord(lead, cfg, { create = false, sendStatus = true, crmBaseUrl = '' } = {}) {
  const rec = { ...splitName(lead.display_name) };
  const m = mobile(lead.phone);
  if (m) rec.Mobile = m;
  if (sendStatus && cfg.statusMap[lead.status]) rec.Lead_Status = cfg.statusMap[lead.status];
  if (cfg.idField) rec[cfg.idField] = lead.wa_id;
  const link = crmBaseUrl ? `${crmBaseUrl}/leads/${encodeURIComponent(lead.wa_id)}` : '';
  if (cfg.linkField && link) rec[cfg.linkField] = link;
  if (create) {
    if (cfg.leadSource) rec.Lead_Source = cfg.leadSource;
    rec.Description = ['Lead from WhatsApp.', lead.interest ? `Interested in: ${lead.interest}.` : '', link ? `CRM: ${link}` : '']
      .filter(Boolean).join(' ').slice(0, 2000);
  }
  return rec;
}

/** The Deal created when a won lead is converted. */
function dealRecord(lead, joined, cfg) {
  const name = String(lead.display_name || '').trim() || mobile(lead.phone) || 'WhatsApp lead';
  const deal = {
    Deal_Name: `${name} - ${joined.plan || 'Sale'}`.slice(0, 120),
    Stage: cfg.wonStage,
    Amount: joined.amount_inr,
    Closing_Date: zohoDate(joined.created_at)
  };
  if (cfg.pipeline) deal.Pipeline = cfg.pipeline;
  if (cfg.idField) deal[cfg.idField] = lead.wa_id;
  return deal;
}

/** Ids from a convert result; Zoho has returned both { Deals: 'id' } and { Deals: { id } }. */
function convertedIds(result) {
  const src = result.details || result;
  const id = v => (v && typeof v === 'object' ? v.id : v) || null;
  return { contactId: id(src.Contacts), dealId: id(src.Deals) };
}

/** What a change seen in Zoho means here: { outcome: 'joined'|'lost', ... } or { status } or null. */
function inboundAction(module, rec, lead, cfg) {
  if (!lead || lead.status === 'converted') return null; // a won sale is never undone from Zoho
  if (module === 'Deals') {
    if (rec.Stage === cfg.wonStage) {
      const amount = Math.round(Number(rec.Amount));
      if (!Number.isFinite(amount) || amount <= 0) return { skip: 'won_without_amount' };
      return { outcome: 'joined', plan: String(rec.Deal_Name || 'Zoho deal').slice(0, 100), amount, note: `Won in Zoho (deal ${rec.id})` };
    }
    if (rec.Stage === cfg.lostStage && lead.status !== 'lost') {
      return { outcome: 'lost', lostReason: 'other', note: `Deal lost in Zoho: ${rec.Stage}` };
    }
    return null;
  }
  const st = rec.Lead_Status;
  if (st && cfg.lostStatuses.includes(st) && lead.status !== 'lost') {
    return { outcome: 'lost', lostReason: 'other', note: `Zoho lead status: ${st}` };
  }
  if (st && st === cfg.statusMap.contacted && lead.status === 'new') return { status: 'contacted' };
  return null;
}

// ---- database ----

const getLead = waId => db.one('SELECT wa_id, display_name, phone, status, interest, created_at FROM leads WHERE wa_id = $1', [waId]);
const latestJoined = waId => db.one(`SELECT plan, amount_inr, created_at FROM crm_lead_outcomes
  WHERE wa_id = $1 AND outcome = 'joined' ORDER BY id DESC LIMIT 1`, [waId]);

async function saveLink(waId, fields) {
  const cols = Object.keys(fields);
  const sets = cols.map((c, i) => (c === 'zoho_state' ? `zoho_state = zoho_state || $${i + 2}::jsonb` : `${c} = $${i + 2}`));
  await db.query(`UPDATE zoho_links SET ${sets.join(', ')} WHERE wa_id = $1`,
    [waId, ...cols.map(c => (c === 'zoho_state' ? JSON.stringify(fields[c]) : fields[c]))]);
}

// ---- out: one lead to Zoho ----

async function findLeadId(lead, cfg) {
  if (cfg.idField) return null; // upsert by the custom field instead
  const m = mobile(lead.phone);
  if (!m) return null;
  const res = await zoho.api('get', '/Leads/search', { params: { phone: m, fields: 'id' } });
  const hit = res.data && Array.isArray(res.data.data) ? res.data.data[0] : null;
  return hit ? String(hit.id) : null;
}

/**
 * Brings Zoho up to date with one lead. Returns what it did (for logs and tests).
 * Throws ZohoError; the worker decides about retries.
 */
async function pushLead(link) {
  const cfg = zoho.cfg();
  const lead = await getLead(link.wa_id);
  if (!lead) return { action: 'gone' };
  const state = link.zoho_state || {};
  const crmBaseUrl = (registry.config() || { crm: {} }).crm.baseUrl;
  const done = { zoho_state: { pushed_status: lead.status } };
  let action = 'none';

  if (!link.zoho_deal_id) {
    let leadId = link.zoho_lead_id || null;
    const sendStatus = state.pushed_status !== lead.status;
    if (leadId) {
      zoho.one(await zoho.api('put', `/Leads/${leadId}`, { data: { data: [leadRecord(lead, cfg, { sendStatus, crmBaseUrl })] } }));
      action = 'updated';
    } else {
      leadId = await findLeadId(lead, cfg);
      if (leadId) {
        zoho.one(await zoho.api('put', `/Leads/${leadId}`, { data: { data: [leadRecord(lead, cfg, { crmBaseUrl })] } }));
        action = 'matched';
      } else {
        const rec = leadRecord(lead, cfg, { create: true, crmBaseUrl });
        const res = cfg.idField
          ? await zoho.api('post', '/Leads/upsert', { data: { data: [rec], duplicate_check_fields: [cfg.idField] } })
          : await zoho.api('post', '/Leads', { data: { data: [rec] } });
        leadId = String(zoho.one(res).details.id);
        action = 'created';
      }
      done.zoho_lead_id = leadId;
    }
    if (sendStatus || action !== 'updated') done.zoho_state.lead_status = cfg.statusMap[lead.status] || null;

    // Won: convert the Zoho Lead into a Contact + Deal with the amount.
    const joined = lead.status === 'converted' ? await latestJoined(lead.wa_id) : null;
    if (joined && joined.amount_inr) {
      const res = await zoho.api('post', `/Leads/${leadId}/actions/convert`, {
        data: { data: [{ overwrite: true, notify_lead_owner: false, notify_new_entity_owner: false, Deals: dealRecord(lead, joined, cfg) }] }
      });
      const ids = convertedIds(zoho.one(res));
      Object.assign(done, { zoho_contact_id: ids.contactId, zoho_deal_id: ids.dealId });
      done.zoho_state.deal_stage = cfg.wonStage;
      action = 'converted';
    }
  } else {
    // Already a Deal: keep its stage and amount in step with ours.
    const deal = {};
    if (lead.status === 'converted') {
      const joined = await latestJoined(lead.wa_id);
      deal.Stage = cfg.wonStage;
      if (joined && joined.amount_inr) deal.Amount = joined.amount_inr;
    } else if (lead.status === 'lost') {
      deal.Stage = cfg.lostStage;
    }
    if (deal.Stage && (deal.Stage !== state.deal_stage || deal.Amount !== state.deal_amount)) {
      zoho.one(await zoho.api('put', `/Deals/${link.zoho_deal_id}`, { data: { data: [deal] } }));
      done.zoho_state.deal_stage = deal.Stage;
      if (deal.Amount) done.zoho_state.deal_amount = deal.Amount;
      action = 'deal_updated';
    }
  }
  await saveLink(lead.wa_id, done);
  return { action, leadId: done.zoho_lead_id || link.zoho_lead_id || null, dealId: done.zoho_deal_id || link.zoho_deal_id || null };
}

// ---- in: changes made in Zoho ----

/** The person a change from Zoho is logged as: the lead's salesperson, else the first owner. */
async function actorFor(waId) {
  const u = await db.one(`
    SELECT u.id FROM crm_users u LEFT JOIN crm_lead_assignments a ON a.user_id = u.id AND a.wa_id = $1
    WHERE u.active AND (a.wa_id IS NOT NULL OR u.role = 'owner')
    ORDER BY (a.wa_id IS NOT NULL) DESC, u.id LIMIT 1`, [waId]);
  return { id: u ? u.id : null, name: SYSTEM_NAME, role: 'owner' };
}

let crmInstance = null;
const crm = () => {
  if (!crmInstance) {
    const { Crm } = require('../../../crm/src/crm'); // the CRM's outcome rules (follow-ups, status, K7)
    crmInstance = new Crm(db);
  }
  return crmInstance;
};

async function findLink(module, rec, cfg) {
  const col = module === 'Deals' ? 'zoho_deal_id' : 'zoho_lead_id';
  let link = await db.one(`SELECT * FROM zoho_links WHERE ${col} = $1`, [String(rec.id)]);
  if (!link && cfg.idField && rec[cfg.idField]) {
    // e.g. staff converted the lead in Zoho and the conversion mapping copied our lead key to the Deal.
    link = await db.one('SELECT * FROM zoho_links WHERE wa_id = $1', [String(rec[cfg.idField])]);
    if (link) {
      await db.query(`UPDATE zoho_links SET ${col} = $2 WHERE wa_id = $1`, [link.wa_id, String(rec.id)]);
      link[col] = String(rec.id);
    }
  }
  return link;
}

/** Handles one changed Zoho record. Returns what happened. */
async function applyRecord(module, rec, cfg) {
  const link = await findLink(module, rec, cfg);
  if (!link) return 'unknown';
  const state = link.zoho_state || {};
  const key = module === 'Deals' ? 'deal_stage' : 'lead_status';
  const value = module === 'Deals' ? rec.Stage : rec.Lead_Status;
  if (!value || value === state[key]) return 'unchanged'; // includes the echo of our own push
  const lead = await getLead(link.wa_id);
  const act = inboundAction(module, rec, lead, cfg);
  await saveLink(link.wa_id, { zoho_state: { [key]: value } });
  if (!act) return 'noted';
  if (act.skip) {
    logger.warn('Zoho change not applied', { wa_id: link.wa_id, module, reason: act.skip });
    return act.skip;
  }
  const actor = await actorFor(link.wa_id);
  if (act.status) await crm().setStatus(actor, link.wa_id, act.status);
  else await crm().logOutcome(actor, link.wa_id, act);
  // Our side now matches Zoho: the push this causes must not send the status back over Zoho's value.
  const after = await getLead(link.wa_id);
  await saveLink(link.wa_id, { zoho_state: { pushed_status: after.status, ...(module === 'Deals' && act.amount ? { deal_amount: act.amount } : {}) } });
  logger.info('Zoho change applied', { wa_id: link.wa_id, module, value, applied: act.outcome || act.status });
  return act.outcome || act.status;
}

const FIELDS = {
  Leads: cfg => ['Lead_Status', 'Modified_Time', cfg.idField].filter(Boolean).join(','),
  Deals: cfg => ['Stage', 'Amount', 'Deal_Name', 'Modified_Time', cfg.idField].filter(Boolean).join(',')
};

/** Reads Leads and Deals changed in Zoho since the last read and applies them. */
async function pullChanges({ now = new Date() } = {}) {
  const cfg = zoho.cfg();
  const cursor = await db.one('SELECT pulled_until FROM zoho_cursors');
  // First read: the last hour. Each read overlaps the previous by 2 minutes (clock drift); applying is idempotent.
  const since = cursor && cursor.pulled_until ? new Date(cursor.pulled_until) : new Date(now.getTime() - 60 * 60 * 1000);
  const counts = {};
  for (const module of ['Leads', 'Deals']) {
    for (let page = 1; page <= PULL_PAGES; page++) {
      const res = await zoho.api('get', `/${module}`, {
        params: { fields: FIELDS[module](cfg), per_page: 200, page, sort_by: 'Modified_Time', sort_order: 'asc' },
        headers: { 'If-Modified-Since': sinceHeader(since) }
      });
      const records = (res.data && res.data.data) || [];
      for (const rec of records) {
        try {
          const r = await applyRecord(module, rec, cfg);
          counts[r] = (counts[r] || 0) + 1;
        } catch (err) {
          counts.error = (counts.error || 0) + 1;
          logger.warn('Zoho change failed to apply', { module, id: rec.id, error: err.message });
        }
      }
      if (!(res.data && res.data.info && res.data.info.more_records)) break;
    }
  }
  const until = new Date(now.getTime() - 2 * 60 * 1000);
  await db.query(`INSERT INTO zoho_cursors (pulled_until, last_error, updated_at) VALUES ($1, NULL, now())
    ON CONFLICT (tenant_id) DO UPDATE SET pulled_until = EXCLUDED.pulled_until, last_error = NULL, updated_at = now()`, [until.toISOString()]);
  return counts;
}

module.exports = {
  pushLead, pullChanges, applyRecord,
  splitName, leadRecord, dealRecord, convertedIds, inboundAction, sinceHeader, ZohoError
};

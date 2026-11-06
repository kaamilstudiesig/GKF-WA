const db = require('../db');
const env = require('../config/env');
const tenancy = require('./context');
const secrets = require('./secrets');
const logger = require('../utils/logger');

/**
 * The tenants (client businesses) and their settings, cached in memory.
 *
 * Tenant 1 is the business this deployment ran before K8. Any of its settings
 * that are not stored in the tenants table come from the env vars, so an
 * existing deployment keeps working unchanged. Other tenants never fall back to
 * the env vars: a missing token stays missing instead of borrowing tenant 1's.
 *
 * The list is small, so all of it is cached and re-read every minute. A lookup
 * that misses (a new tenant added by another process) re-reads at most every 10s.
 */
const DEFAULT_TENANT_ID = 1;
const REFRESH_MS = 60 * 1000;
const MISS_RELOAD_MS = 10 * 1000;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,29}$/;
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;
const SECRET_KEYS = ['metaAccessToken', 'metaAppSecret', 'metaVerifyToken', 'razorpayKeyId', 'razorpayKeySecret', 'razorpayWebhookSecret',
  'zohoClientId', 'zohoClientSecret', 'zohoRefreshToken'];
const SETTING_KEYS = ['crmBaseUrl', 'telegramChatId', 'telegramOpsChatId', 'metaDatasetId', 'metaPageId', 'metaCapiTestEventCode',
  'botPauseHours', 'dailyReplyCap', 'aiMonthlyTokenBudget', 'aiMonthlyRequestBudget', 'staffAlertTemplate',
  // K20 Zoho CRM sync (scripts/zoho-connect.js sets these). No env fallback, tenant 1 included:
  // the database trigger that marks leads for sync reads zohoSync from the tenants row.
  'zohoSync', 'zohoAccountsUrl', 'zohoApiDomain', 'zohoIdField', 'zohoLinkField', 'zohoLeadSource',
  'zohoDealPipeline', 'zohoWonStage', 'zohoLostStage', 'zohoLostStatuses', 'zohoStatusMap'];

// Our lead status -> Zoho's standard Lead Status values. A client can override any of them (zohoStatusMap).
const ZOHO_STATUS_MAP = {
  new: 'Not Contacted', contacted: 'Contacted', qualified: 'Pre-Qualified', hot: 'Pre-Qualified',
  cold: 'Contact in Future', converted: 'Pre-Qualified', lost: 'Lost Lead'
};
const ZOHO_LOST_STATUSES = ['Lost Lead', 'Junk Lead', 'Not Qualified'];

let rows = new Map(); // id -> { row, secrets, secretsError }
// Tenant 1 before the tenants table has been read: settings come from the env vars.
const DEFAULT_ENTRY = () => ({
  row: { id: DEFAULT_TENANT_ID, slug: env.clientId, name: 'Default', status: 'active', settings: {} },
  secrets: {}, secretsError: null
});
let loadedAt = 0;
let lastMissReload = 0;
let loading = null;

const blank = v => v === undefined || v === null || v === '';

function decode(row) {
  try {
    return { row, secrets: row.secrets ? secrets.decrypt(row.secrets) : {}, secretsError: null };
  } catch (err) {
    logger.error('Tenant secrets cannot be read; the tenant is unavailable', { tenant: row.slug, error: err.message });
    return { row, secrets: {}, secretsError: err.message };
  }
}

/** The settings a service needs for one tenant. Built on each call so env changes (tests) apply. */
function resolve(entry) {
  const { row, secrets: sec, secretsError } = entry;
  const isDefault = row.id === DEFAULT_TENANT_ID;
  const s = row.settings || {};
  // Tenant 1 falls back to the env var; other tenants get only what is stored for them.
  const pick = (stored, fallback) => (!blank(stored) ? stored : (isDefault ? (fallback || '') : ''));
  const limit = (stored, fallback) => (!blank(stored) && Number.isFinite(Number(stored)) ? Number(stored) : fallback);
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    isDefault,
    active: row.status === 'active' && !secretsError,
    whatsapp: {
      phoneNumberId: pick(row.phone_number_id, env.metaPhoneNumberId),
      wabaId: pick(row.waba_id, env.metaWabaId),
      accessToken: pick(sec.metaAccessToken, env.metaAccessToken),
      appSecret: pick(sec.metaAppSecret, env.metaAppSecret),
      verifyToken: pick(sec.metaVerifyToken, env.metaWebhookVerifyToken)
    },
    crm: {
      host: row.crm_host || null,
      baseUrl: String(pick(s.crmBaseUrl, process.env.CRM_BASE_URL) || (row.crm_host ? `https://${row.crm_host}` : '')).replace(/\/+$/, '')
    },
    telegram: {
      chatId: pick(s.telegramChatId, process.env.TELEGRAM_CHAT_ID),
      opsChatId: pick(s.telegramOpsChatId, process.env.TELEGRAM_OPS_CHAT_ID || process.env.TELEGRAM_CHAT_ID)
    },
    razorpay: {
      keyId: pick(sec.razorpayKeyId, process.env.RAZORPAY_KEY_ID),
      keySecret: pick(sec.razorpayKeySecret, process.env.RAZORPAY_KEY_SECRET),
      webhookSecret: pick(sec.razorpayWebhookSecret, process.env.RAZORPAY_WEBHOOK_SECRET)
    },
    capi: {
      datasetId: pick(s.metaDatasetId, env.metaDatasetId),
      pageId: pick(s.metaPageId, env.metaPageId),
      testEventCode: pick(s.metaCapiTestEventCode, env.metaCapiTestEventCode)
    },
    limits: {
      botPauseHours: limit(s.botPauseHours, env.botPauseHoursAfterStaffReply),
      dailyReplyCap: limit(s.dailyReplyCap, env.maxBotRepliesPerLeadPerDay),
      aiMonthlyTokenBudget: limit(s.aiMonthlyTokenBudget, env.aiMonthlyTokenBudget),
      aiMonthlyRequestBudget: limit(s.aiMonthlyRequestBudget, env.aiMonthlyRequestBudget)
    },
    staffAlertTemplate: s.staffAlertTemplate || env.staffAlertTemplate,
    zoho: {
      on: s.zohoSync === 'on' && Boolean(sec.zohoClientId && sec.zohoClientSecret && sec.zohoRefreshToken),
      accountsUrl: String(s.zohoAccountsUrl || 'https://accounts.zoho.com').replace(/\/+$/, ''),
      apiDomain: String(s.zohoApiDomain || '').replace(/\/+$/, ''),
      clientId: sec.zohoClientId || '',
      clientSecret: sec.zohoClientSecret || '',
      refreshToken: sec.zohoRefreshToken || '',
      idField: s.zohoIdField || '',
      linkField: s.zohoLinkField || '',
      leadSource: s.zohoLeadSource || '',
      pipeline: s.zohoDealPipeline || '',
      wonStage: s.zohoWonStage || 'Closed Won',
      lostStage: s.zohoLostStage || 'Closed Lost',
      lostStatuses: Array.isArray(s.zohoLostStatuses) && s.zohoLostStatuses.length ? s.zohoLostStatuses : ZOHO_LOST_STATUSES,
      statusMap: { ...ZOHO_STATUS_MAP, ...(s.zohoStatusMap && typeof s.zohoStatusMap === 'object' ? s.zohoStatusMap : {}) }
    }
  };
}

const registry = {
  DEFAULT_TENANT_ID,
  SECRET_KEYS,
  SETTING_KEYS,

  /** Reads all tenants. */
  async load() {
    if (loading) return loading;
    loading = tenancy.runAsSystem(async () => {
      const list = await db.many('SELECT * FROM tenants ORDER BY id');
      rows = new Map(list.map(r => [r.id, decode(r)]));
      loadedAt = Date.now();
      if (!rows.has(DEFAULT_TENANT_ID)) logger.error('Tenant 1 is missing from the tenants table');
      return rows.size;
    }).finally(() => { loading = null; });
    return loading;
  },

  async ensureLoaded() {
    if (!loadedAt || Date.now() - loadedAt > REFRESH_MS) await this.load();
  },

  /** Re-reads after a lookup missed, at most every 10 seconds (unknown ids can't flood the database). */
  async reloadAfterMiss() {
    if (Date.now() - lastMissReload < MISS_RELOAD_MS) return false;
    lastMissReload = Date.now();
    await this.load();
    return true;
  },

  invalidate() { loadedAt = 0; },

  /**
   * Resolved settings for a tenant id (default: the current tenant). Null when unknown.
   * Tenant 1 always exists (the migration creates it), so before the first load it
   * resolves from the env vars alone.
   */
  config(tenantId = tenancy.tenantId()) {
    const id = Number(tenantId);
    const entry = rows.get(id) || (id === DEFAULT_TENANT_ID ? DEFAULT_ENTRY() : null);
    return entry ? resolve(entry) : null;
  },

  list() {
    const all = [...rows.values()];
    if (!rows.has(DEFAULT_TENANT_ID)) all.unshift(DEFAULT_ENTRY());
    return all.map(resolve);
  },

  /** The tenant that owns a WhatsApp phone number id, or null. */
  async byPhoneNumberId(phoneNumberId) {
    if (!phoneNumberId) return null;
    await this.ensureLoaded();
    const find = () => this.list().find(t => t.whatsapp.phoneNumberId === String(phoneNumberId)) || null;
    return find() || ((await this.reloadAfterMiss()) ? find() : null);
  },

  /** The tenant whose CRM runs on this stored hostname, or null. (Tenant 1's CRM_HOSTS are matched by src/app.js.) */
  async byCrmHost(host) {
    const h = String(host || '').toLowerCase();
    if (!h) return null;
    await this.ensureLoaded();
    const find = () => this.list().find(t => t.crm.host === h) || null;
    return find() || ((await this.reloadAfterMiss()) ? find() : null);
  },

  async bySlug(slug) {
    const s = String(slug || '').toLowerCase();
    if (!SLUG_RE.test(s)) return null;
    await this.ensureLoaded();
    const find = () => this.list().find(t => t.slug === s) || null;
    return find() || ((await this.reloadAfterMiss()) ? find() : null);
  },

  /**
   * Checks a new or changed tenant. Throws with a message an operator can act on.
   * Stops two tenants from sharing a WhatsApp number or CRM host, including the
   * ones tenant 1 uses through env vars.
   */
  validate(input, { existingId = null } = {}) {
    const slug = String(input.slug || '').toLowerCase();
    if (!SLUG_RE.test(slug)) throw new Error('slug: 2-30 lowercase letters, digits or dashes, starting with a letter or digit.');
    if (!String(input.name || '').trim()) throw new Error('name is required.');
    if (input.phoneNumberId && !/^[0-9]{5,30}$/.test(String(input.phoneNumberId))) throw new Error('phoneNumberId must be digits (from WhatsApp Manager).');
    if (input.wabaId && !/^[0-9]{5,30}$/.test(String(input.wabaId))) throw new Error('wabaId must be digits.');
    const host = input.crmHost ? String(input.crmHost).toLowerCase() : null;
    if (host && !HOST_RE.test(host)) throw new Error('crmHost must be a hostname like crm.client.com (no https://, no path).');
    const others = this.list().filter(t => t.id !== existingId);
    if (input.phoneNumberId && others.some(t => t.whatsapp.phoneNumberId === String(input.phoneNumberId))) {
      throw new Error('Another tenant already uses this WhatsApp phone number id.');
    }
    if (host && (others.some(t => t.crm.host === host) || (existingId !== DEFAULT_TENANT_ID && env.crmHosts.includes(host)))) {
      throw new Error('Another tenant already uses this CRM host.');
    }
    if (others.some(t => t.slug === slug)) throw new Error('Another tenant already uses this slug.');
    for (const k of Object.keys(input.secrets || {})) if (!SECRET_KEYS.includes(k)) throw new Error(`Unknown secret: ${k}`);
    for (const k of Object.keys(input.settings || {})) if (!SETTING_KEYS.includes(k)) throw new Error(`Unknown setting: ${k}`);
    return { slug, host };
  },

  /** Creates a tenant. Returns its resolved settings. */
  async create(input) {
    await this.load();
    const { slug, host } = this.validate(input);
    const secretsText = input.secrets && Object.keys(input.secrets).length ? secrets.encrypt(input.secrets) : null;
    const row = await tenancy.runAsSystem(() => db.one(`
      INSERT INTO tenants (slug, name, phone_number_id, waba_id, crm_host, settings, secrets)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) RETURNING id`,
    [slug, String(input.name).trim(), input.phoneNumberId || null, input.wabaId || null, host, JSON.stringify(input.settings || {}), secretsText]));
    await this.load();
    logger.info('Tenant created', { tenant: slug, id: row.id });
    return this.config(row.id);
  },

  /** Changes a tenant. Secrets and settings are merged into the stored ones. */
  async update(id, input) {
    await this.load();
    const entry = rows.get(Number(id));
    if (!entry) throw new Error(`No tenant ${id}`);
    const merged = {
      slug: input.slug ?? entry.row.slug,
      name: input.name ?? entry.row.name,
      phoneNumberId: input.phoneNumberId !== undefined ? input.phoneNumberId : entry.row.phone_number_id,
      wabaId: input.wabaId !== undefined ? input.wabaId : entry.row.waba_id,
      crmHost: input.crmHost !== undefined ? input.crmHost : entry.row.crm_host,
      settings: { ...(entry.row.settings || {}), ...(input.settings || {}) },
      secrets: { ...entry.secrets, ...(input.secrets || {}) }
    };
    if (entry.secretsError && input.secrets) throw new Error('Stored secrets cannot be read; fix TENANT_SECRETS_KEY first.');
    const { slug, host } = this.validate(merged, { existingId: entry.row.id });
    const status = input.status || entry.row.status;
    if (!['active', 'suspended'].includes(status)) throw new Error('status must be active or suspended.');
    const secretsText = Object.keys(merged.secrets).length ? secrets.encrypt(merged.secrets) : null;
    await tenancy.runAsSystem(() => db.query(`
      UPDATE tenants SET slug = $2, name = $3, phone_number_id = $4, waba_id = $5, crm_host = $6,
        settings = $7::jsonb, secrets = $8, status = $9, updated_at = now() WHERE id = $1`,
    [entry.row.id, slug, String(merged.name).trim(), merged.phoneNumberId || null, merged.wabaId || null, host,
      JSON.stringify(merged.settings), secretsText, status]));
    await this.load();
    return this.config(entry.row.id);
  },

  startRefresh(ms = REFRESH_MS) {
    const t = setInterval(() => this.load().catch(err => logger.warn('Tenant refresh failed', { error: err.message })), ms);
    t.unref();
    return t;
  },

  /** Tests only: forget the cache. */
  resetForTests() { rows = new Map(); loadedAt = 0; lastMissReload = 0; }
};

module.exports = registry;

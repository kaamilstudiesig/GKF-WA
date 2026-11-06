const axios = require('axios');
const registry = require('../../tenancy/registry');
const tenancy = require('../../tenancy/context');

/**
 * K20: Zoho CRM API (v8) for the current tenant.
 *
 * Each tenant connects its own Zoho account once (scripts/zoho-connect.js). We keep its
 * refresh token (encrypted, in tenants.secrets) and trade it for a 1-hour access token
 * when needed. Zoho runs separate data centres (zoho.com, .in, .eu, .ae, .sa...): the
 * accounts URL and API domain are stored per tenant.
 *
 * Tests set zoho.transport = async ({ method, url, params, data, headers }) => ({ status, data })
 * so nothing reaches Zoho.
 */
const API_VERSION = 'v8';
const TOKEN_EARLY_MS = 5 * 60 * 1000; // refresh 5 minutes before the token runs out

class ZohoError extends Error {
  constructor(message, { status = null, code = null, retryable = false, auth = false } = {}) {
    super(message);
    this.name = 'ZohoError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.auth = auth; // the connection itself is broken: reconnect Zoho
  }
}

const zoho = {
  transport: null,
  tokens: new Map(), // tenant id -> { token, apiDomain, expiresAt }

  cfg() { return (registry.config() || {}).zoho || { on: false }; },
  enabled() { return Boolean(this.cfg().on); },

  async http(req) {
    if (this.transport) return this.transport(req);
    const res = await axios({ ...req, timeout: 20000, validateStatus: () => true });
    return { status: res.status, data: res.data };
  },

  /** Trades a one-time grant code (Zoho API console, Self Client) for a refresh token. */
  async exchangeCode({ accountsUrl, clientId, clientSecret, code }) {
    const res = await this.http({
      method: 'post',
      url: `${accountsUrl.replace(/\/+$/, '')}/oauth/v2/token`,
      params: { grant_type: 'authorization_code', client_id: clientId, client_secret: clientSecret, code }
    });
    if (res.status !== 200 || !res.data || !res.data.refresh_token) {
      throw new ZohoError(`Zoho did not accept the code: ${(res.data && res.data.error) || res.status}`, { status: res.status, auth: true });
    }
    return { refreshToken: res.data.refresh_token, apiDomain: res.data.api_domain || '' };
  },

  async accessToken(force = false) {
    const id = tenancy.tenantId();
    const hit = this.tokens.get(id);
    if (!force && hit && hit.expiresAt > Date.now()) return hit;
    const c = this.cfg();
    if (!c.on) throw new ZohoError('Zoho is not connected for this business.', { auth: true });
    let res;
    try {
      res = await this.http({
        method: 'post',
        url: `${c.accountsUrl}/oauth/v2/token`,
        params: { grant_type: 'refresh_token', client_id: c.clientId, client_secret: c.clientSecret, refresh_token: c.refreshToken }
      });
    } catch (err) {
      throw new ZohoError(`Zoho sign-in failed: ${err.message}`, { retryable: true });
    }
    const d = res.data || {};
    if (res.status !== 200 || !d.access_token) {
      // invalid_code / invalid_client: the refresh token was revoked or the client deleted.
      const retryable = res.status === 429 || res.status >= 500 || d.error === 'Access Denied';
      throw new ZohoError(`Zoho sign-in failed: ${d.error || res.status}`, { status: res.status, code: d.error || null, retryable, auth: !retryable });
    }
    const apiDomain = (c.apiDomain || d.api_domain || '').replace(/\/+$/, '');
    if (!apiDomain) throw new ZohoError('Zoho did not say which API domain to use; set zohoApiDomain.', { auth: true });
    const entry = { token: d.access_token, apiDomain, expiresAt: Date.now() + Number(d.expires_in || 3600) * 1000 - TOKEN_EARLY_MS };
    this.tokens.set(id, entry);
    return entry;
  },

  /**
   * One API call. Returns { status, data } (data is null for 204/304: nothing found or not modified).
   * Throws ZohoError for errors; retryable tells the worker to try again later.
   */
  async api(method, path, { params, data, headers } = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { token, apiDomain } = await this.accessToken(attempt > 0);
      let res;
      try {
        res = await this.http({
          method, url: `${apiDomain}/crm/${API_VERSION}${path}`, params, data,
          headers: { ...headers, Authorization: `Zoho-oauthtoken ${token}` }
        });
      } catch (err) {
        throw new ZohoError(`Zoho request failed: ${err.message}`, { retryable: true });
      }
      const body = res.data || null;
      if (res.status === 401 && attempt === 0) continue; // token expired early: refresh once
      if (res.status === 204 || res.status === 304) return { status: res.status, data: null };
      if (res.status >= 200 && res.status < 300) return { status: res.status, data: body };
      const first = body && Array.isArray(body.data) ? body.data[0] : body;
      const code = (first && first.code) || null;
      const message = (first && first.message) || `HTTP ${res.status}`;
      throw new ZohoError(`Zoho: ${code ? `${code}: ` : ''}${message}`, {
        status: res.status, code, retryable: res.status === 429 || res.status >= 500, auth: res.status === 401
      });
    }
    throw new ZohoError('Zoho rejected the access token twice.', { status: 401, auth: true });
  },

  /** The result of a single-record write (create, update, upsert, convert), or throws its error. */
  one(res) {
    const first = res.data && Array.isArray(res.data.data) ? res.data.data[0] : null;
    if (!first) throw new ZohoError('Zoho returned no result for the record.', { retryable: true });
    if (first.status === 'error') {
      throw new ZohoError(`Zoho: ${first.code}: ${first.message}${first.details && first.details.api_name ? ` (${first.details.api_name})` : ''}`,
        { code: first.code });
    }
    return first;
  },

  /** Tests only. */
  resetForTests() { this.tokens.clear(); this.transport = null; }
};

module.exports = zoho;
module.exports.ZohoError = ZohoError;
module.exports.API_VERSION = API_VERSION;

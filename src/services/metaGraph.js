const axios = require('axios');
const env = require('../config/env');

/**
 * Small Graph API client for setup calls (K9 Embedded Signup). Tests replace
 * `transport` with a fake; nothing here ever runs against Meta in tests.
 * Errors carry Meta's message and code so callers can show something useful.
 */
class MetaGraphError extends Error {
  constructor(message, { status = null, code = null, subcode = null, step = null } = {}) {
    super(message);
    this.name = 'MetaGraphError';
    Object.assign(this, { status, code, subcode, step });
  }
}

const metaGraph = {
  transport: null,

  /**
   * { method, path, params, body, form, token } -> response data. `path` has no version prefix.
   * `form` is sent as a form-encoded POST body: use it for secrets, so they never sit in a URL
   * (request URLs can end up in logs and performance traces).
   */
  async request({ method = 'GET', path, params = {}, body = null, form = null, token = null }) {
    if (this.transport) return this.transport({ method, path, params, body, form, token });
    try {
      const res = await axios({
        method,
        url: `https://graph.facebook.com/${env.metaGraphApiVersion}/${String(path).replace(/^\/+/, '')}`,
        params,
        data: form ? new URLSearchParams(form) : (body || undefined),
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        timeout: 15000
      });
      return res.data;
    } catch (err) {
      const e = err.response?.data?.error || {};
      throw new MetaGraphError(e.error_user_msg || e.message || err.message, {
        status: err.response?.status || null, code: e.code ?? null, subcode: e.error_subcode ?? null
      });
    }
  }
};

module.exports = { metaGraph, MetaGraphError };

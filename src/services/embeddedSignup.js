const crypto = require('crypto');
const env = require('../config/env');
const registry = require('../tenancy/registry');
const tenancy = require('../tenancy/context');
const notifyService = require('./notifyService');
const logger = require('../utils/logger');
const { metaGraph, MetaGraphError } = require('./metaGraph');

/**
 * K9 Embedded Signup: a client connects its own WhatsApp number to our Meta app
 * (we are a Tech Provider). Flow:
 *   1. The operator makes a signed connect link for a tenant (`npm run tenant -- connect-link <slug>`).
 *   2. The client opens it on the bot host and logs in with Facebook (src/routes/connect.js).
 *   3. We exchange the 30-second code for a business token, check that the token really
 *      controls the WABA and number the browser named, save it encrypted, then run the
 *      setup steps: subscribe our app to the WABA's webhooks and register the number
 *      (new numbers) or start the contacts and history sync (WhatsApp Business app numbers).
 * Setup steps are saved one by one, so `npm run tenant -- whatsapp-finish <slug>` can
 * retry a failed step later without a new code.
 */

const LINK_HOURS = 72;
const ID_RE = /^[0-9]{5,25}$/;
const SYNC_TYPES = ['smb_app_state_sync', 'history'];

class SignupError extends Error {
  constructor(status, message, step = null) {
    super(message);
    this.status = status;
    this.step = step;
  }
}

const enabled = () => Boolean(env.metaAppId && env.metaEsConfigId && env.metaAppSecret);

// ---- connect links ----

function linkKey() {
  const raw = Buffer.from(process.env.TENANT_SECRETS_KEY || '', 'base64');
  if (raw.length !== 32) throw new Error('TENANT_SECRETS_KEY must be set to make connect links.');
  return crypto.createHmac('sha256', raw).update('k9-connect-link').digest();
}

const sign = payload => crypto.createHmac('sha256', linkKey()).update(payload).digest('base64url');

/**
 * A signed token for one tenant's connect page, valid for `hours`. `appNumbers` also offers
 * numbers already on the WhatsApp Business app (coexistence); off unless asked for.
 */
function createLinkToken(tenantId, { hours = LINK_HOURS, appNumbers = false, now = Date.now() } = {}) {
  const payload = Buffer.from(JSON.stringify({ t: Number(tenantId), e: Math.floor(now / 1000) + Math.round(hours * 3600), ...(appNumbers ? { a: 1 } : {}) })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

/** { tenantId, appNumbers } for a valid, unexpired token, else null. */
function readLinkToken(token, { now = Date.now() } = {}) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  try {
    const { t, e, a } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!Number.isInteger(t) || !Number.isInteger(e) || e * 1000 < now) return null;
    return { tenantId: t, appNumbers: a === 1 };
  } catch {
    return null;
  }
}

function linkUrl(tenantId, opts) {
  if (!env.botBaseUrl) throw new Error('Set BOT_BASE_URL (the bot host, e.g. https://wa.example.com) to make connect links.');
  return `${env.botBaseUrl}/connect/${createLinkToken(tenantId, opts)}`;
}

// ---- checks ----

/** Why this tenant can't connect a number right now, or null when it can. */
function blockedReason(tenant) {
  if (!tenant) return 'This link is not valid any more. Ask us for a new one.';
  if (tenant.status !== 'active') return 'This account is paused. Contact us.';
  if (tenant.whatsapp.phoneNumberId) return 'A WhatsApp number is already connected for this business. Contact us to change it.';
  if (!enabled()) return 'WhatsApp connection is not switched on yet. Contact us.';
  return null;
}

const modeFor = event => ({ FINISH: 'cloud', FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING: 'coexistence' })[event] || null;

// ---- the signup ----

/** { token, expiresAt } for a signup code. expiresAt is null when Meta gives no expiry. */
async function exchangeCode(code) {
  const data = await metaGraph.request({
    method: 'POST',
    path: 'oauth/access_token',
    form: { client_id: env.metaAppId, client_secret: env.metaAppSecret, code }
  });
  if (!data || !data.access_token) throw new MetaGraphError('Meta did not return a token.');
  const secs = Number(data.expires_in);
  return { token: data.access_token, expiresAt: Number.isFinite(secs) && secs > 0 ? new Date(Date.now() + secs * 1000).toISOString() : null };
}

/** The number's details, only if the token's WABA really has this number. */
async function findNumber(token, wabaId, phoneNumberId) {
  const data = await metaGraph.request({
    path: `${wabaId}/phone_numbers`,
    params: { fields: 'id,display_phone_number,verified_name,quality_rating' },
    token
  });
  return (data?.data || []).find(n => String(n.id) === String(phoneNumberId)) || null;
}

/**
 * Finishes a signup from the connect page. `session` is what the browser sent:
 * { code, event, phone_number_id, waba_id }. `appNumbers`: the link allows WhatsApp
 * Business app numbers. Returns { setup, errors }.
 */
async function completeSignup(tenantId, session, { appNumbers = false } = {}) {
  const tenant = registry.config(tenantId);
  const blocked = blockedReason(tenant);
  if (blocked) throw new SignupError(409, blocked);

  const code = String(session.code || '');
  const phoneNumberId = String(session.phone_number_id || '');
  const wabaId = String(session.waba_id || '');
  const mode = modeFor(session.event);
  if (session.event === 'FINISH_ONLY_WABA') throw new SignupError(400, 'No phone number was chosen. Start again and add or pick a number.');
  if (!code || !mode || !ID_RE.test(phoneNumberId) || !ID_RE.test(wabaId)) {
    throw new SignupError(400, 'Facebook did not send the details we need. Please try again.');
  }
  if (mode === 'coexistence' && !appNumbers) {
    throw new SignupError(400, 'This link is for a number that is not on WhatsApp yet. Contact us to connect a WhatsApp Business app number.');
  }
  const owner = await registry.byPhoneNumberId(phoneNumberId);
  if (owner && owner.id !== tenant.id) throw new SignupError(409, 'This WhatsApp number is already connected to another business. Contact us.');

  let token;
  let tokenExpiresAt;
  try {
    ({ token, expiresAt: tokenExpiresAt } = await exchangeCode(code));
  } catch (err) {
    logger.warn('Embedded Signup code exchange failed', { tenant: tenant.slug, error: err.message, code: err.code });
    throw new SignupError(502, 'Facebook did not accept the login (it expires after 30 seconds). Please try again.', 'exchange');
  }

  let number;
  try {
    number = await findNumber(token, wabaId, phoneNumberId);
  } catch (err) {
    logger.warn('Embedded Signup number check failed', { tenant: tenant.slug, error: err.message, code: err.code });
    throw new SignupError(502, 'We could not read your WhatsApp account from Meta. Please try again.', 'verify');
  }
  if (!number) throw new SignupError(400, 'That number is not in the WhatsApp account you shared. Please try again.', 'verify');

  const setup = {
    mode,
    connectedAt: new Date().toISOString(),
    number: number.display_phone_number || null,
    verifiedName: number.verified_name || null,
    tokenExpiresAt, // null = no expiry given by Meta. A date here means the client must reconnect before it.
    steps: {}
  };
  try {
    await registry.update(tenant.id, { phoneNumberId, wabaId, secrets: { metaAccessToken: token }, settings: { whatsappSetup: setup } });
  } catch (err) {
    if (err.code === '23505' || /phone_number_id/.test(err.message)) {
      throw new SignupError(409, 'This WhatsApp number is already connected to another business. Contact us.');
    }
    throw err;
  }
  logger.info('Embedded Signup connected a number', { tenant: tenant.slug, mode, phone_number_id: phoneNumberId, waba: wabaId });

  const result = await finishSetup(tenant.id);
  await alertOps(registry.config(tenant.id), result);
  return result;
}

/**
 * Runs the setup steps that are not done yet. Safe to run again: done steps are
 * skipped. Returns { setup, errors }.
 */
async function finishSetup(tenantId) {
  const tenant = registry.config(tenantId);
  const wa = tenant && tenant.whatsapp;
  if (!wa || !wa.setup || !wa.accessToken || !wa.phoneNumberId || !wa.wabaId) {
    throw new SignupError(400, 'This business has no number connected through the connect link.');
  }
  const setup = { ...wa.setup, steps: { ...(wa.setup.steps || {}) } };
  const errors = [];
  const step = async (name, fn) => {
    if (setup.steps[name]) return;
    try {
      const out = await fn();
      setup.steps[name] = { at: new Date().toISOString(), ...(out || {}) };
    } catch (err) {
      errors.push({ step: name, message: err.message, code: err.code ?? null });
      logger.warn('Embedded Signup setup step failed', { tenant: tenant.slug, step: name, error: err.message, code: err.code });
    }
  };

  await step('subscribed', () => metaGraph.request({ method: 'POST', path: `${wa.wabaId}/subscribed_apps`, token: wa.accessToken }).then(() => null));

  if (setup.mode === 'cloud') {
    await step('registered', async () => {
      let pin = wa.twoStepPin;
      if (!pin) { // saved before the call, so a retry uses the same PIN
        pin = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
        await registry.update(tenant.id, { secrets: { metaTwoStepPin: pin } });
      }
      await metaGraph.request({ method: 'POST', path: `${wa.phoneNumberId}/register`, token: wa.accessToken, body: { messaging_product: 'whatsapp', pin } });
      return null;
    });
  } else {
    // WhatsApp Business app numbers are registered already. Meta wants the contacts and
    // history sync started within 24 hours of onboarding; each type can run only once.
    for (const type of SYNC_TYPES) {
      await step(type, async () => {
        const out = await metaGraph.request({ method: 'POST', path: `${wa.phoneNumberId}/smb_app_data`, token: wa.accessToken, body: { messaging_product: 'whatsapp', sync_type: type } });
        return { requestId: out?.request_id || null };
      });
    }
  }

  setup.lastError = errors.length ? { ...errors[0], at: new Date().toISOString() } : null;
  await registry.update(tenant.id, { settings: { whatsappSetup: setup } });
  return { setup, errors };
}

/** One line to our ops group (tenant 1's), never the client's staff group. */
async function alertOps(tenant, { setup, errors }) {
  const expiry = setup.tokenExpiresAt ? ` Token expires ${setup.tokenExpiresAt.slice(0, 10)}: they must reconnect before then.` : '';
  const status = errors.length ? `setup step failed: ${errors.map(e => e.step).join(', ')}. Run npm run tenant -- whatsapp-finish ${tenant.slug}` : 'setup complete';
  const text = `WhatsApp connected for ${tenant.name} (${tenant.slug}): ${setup.number || 'number'} (${setup.mode === 'coexistence' ? 'WhatsApp Business app number' : 'new Cloud API number'}), ${status}.${expiry}`;
  try {
    await tenancy.run(registry.DEFAULT_TENANT_ID, () => {
      const { token, opsChatId } = notifyService.config;
      if (!notifyService.sendOverride && (!token || !opsChatId)) return null; // Telegram not set up (local dev)
      return notifyService.send(text.replace(/[<>&]/g, ''), { ops: true });
    });
  } catch (err) {
    logger.warn('Could not send the Embedded Signup ops alert', { error: err.message });
  }
}

module.exports = {
  enabled, createLinkToken, readLinkToken, linkUrl, blockedReason, modeFor,
  completeSignup, finishSetup, SignupError, LINK_HOURS
};

const express = require('express');
const crypto = require('crypto');
const registry = require('../tenancy/registry');
const tenancy = require('../tenancy/context');
const logger = require('../utils/logger');
const leadIntake = require('../services/leadIntake');

/**
 * R16 lead intake on the bot host: POST /intake/:slug (contract in docs/TEAM.md).
 *  - Signed JSON (portals, Zapier, a client's CRM): X-Intake-Signature: sha256=<HMAC-SHA256 of the
 *    raw body with the client's intakeSecret>.
 *  - Website form (the snippet on Business settings -> Lead sources): urlencoded, so the browser
 *    sends no CORS preflight; needs the client's public form_key and an allowed Origin. A filled
 *    honeypot field gets a silent 202 and is never saved.
 * Responses: 202 { ok: true }, 400 with a reason, 401 bad signature or key, 404 unknown client, 429.
 */

const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const HONEYPOT = 'company_url'; // hidden in the snippet; people never fill it, bots do

// IPs are stored only as a keyed hash (rate limits). The key is server-side, so a hash can't be
// reversed by trying every address. Production must have INTAKE_IP_KEY or TENANT_SECRETS_KEY (which
// production needs anyway for client secrets); the fixed fallback is for tests and local dev only.
function ipKey(env = process.env) {
  return env.INTAKE_IP_KEY || env.TENANT_SECRETS_KEY || (env.NODE_ENV === 'production' ? null : 'local-dev-intake');
}
function ipHash(ip, slug, key) {
  return crypto.createHmac('sha256', key).update(`${slug}:${ip}`).digest('hex').slice(0, 32);
}

function signatureOk(raw, header, secret) {
  if (!secret || !raw || !/^sha256=[0-9a-f]{64}$/i.test(String(header || ''))) return false;
  const expected = crypto.createHmac('sha256', secret).update(raw).digest();
  const given = Buffer.from(String(header).slice(7), 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

const sameKey = (a, b) => {
  const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
};

function intakeRouter() {
  const router = express.Router();
  const form = express.urlencoded({ extended: false, limit: '20kb', parameterLimit: 40 });

  router.post('/intake/:slug', form, h(async (req, res) => {
    const tenant = await registry.bySlug(req.params.slug);
    if (!tenant || tenant.status !== 'active') return res.status(404).json({ ok: false, error: 'Not found' });
    const cfg = tenant.intake;
    res.setHeader('Cache-Control', 'no-store');
    const key = ipKey();
    if (!key) {
      logger.error('Lead intake is off: set INTAKE_IP_KEY or TENANT_SECRETS_KEY');
      return res.status(503).json({ ok: false, error: 'Lead intake is not set up yet' });
    }
    const hash = ipHash(req.ip, tenant.slug, key);
    const asTenant = fn => tenancy.run(tenant.id, fn);
    // Refused requests are recorded per IP (hashed); after too many in an hour, that address gets 429,
    // so a form key or signature can't be guessed at full speed. A valid signature always gets through
    // (a shared office or mobile IP must not block a portal); the public form key is no proof, so
    // website forms are checked first.
    const blocked = () => asTenant(() => leadIntake.tooManyFailures(hash));
    const tooMany = () => res.status(429).json({ ok: false, error: 'Too many refused requests. Try again later.' });
    const refuse = async (channelName, error, status, message) => {
      await asTenant(() => leadIntake.recordRefused({ channel: channelName, ipHash: hash, error }));
      return res.status(status).json(status === 202 ? { ok: true } : { ok: false, error: message });
    };

    let channel;
    if (req.get('x-intake-signature') !== undefined) {
      channel = 'api';
      if (!req.is('application/json') || !signatureOk(req.rawBody, req.get('x-intake-signature'), cfg.secret)) {
        if (await blocked()) return tooMany();
        return refuse('api', 'bad signature', 401, 'Bad signature');
      }
    } else {
      channel = 'form';
      if (await blocked()) return tooMany();
      const origin = String(req.get('origin') || '').toLowerCase().replace(/\/+$/, '');
      const allowed = origin && cfg.origins.includes(origin);
      if (allowed) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
      const notAllowed = 'This website is not allowed to send leads here';
      if (!allowed) return refuse('form', 'website not allowed', 401, notAllowed);
      if (!sameKey(req.body && req.body.form_key, cfg.formKey)) return refuse('form', 'bad form key', 401, notAllowed);
      // A bot filled the hidden field: recorded (it counts towards the limit), but it is told nothing.
      if (String((req.body && req.body[HONEYPOT]) || '').trim()) return refuse('form', 'honeypot', 202);
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const result = await asTenant(async () => {
      // Load this client's profile first: without it, gymConfig falls back to the default
      // profile and the welcome message would carry another business's name.
      await require('../services/businessProfile').ensureLoaded();
      const gymConfig = require('../config/gymConfig');
      return leadIntake.accept({ channel, body, ipHash: hash, businessName: gymConfig.profile.name || tenant.name });
    });
    res.status(result.status).json(result.body);
  }));

  // Errors: a JSON reason, never a stack (the caller is a website or a portal).
  router.use('/intake', (err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') return res.status(400).json({ ok: false, error: 'Body not readable' });
    logger.error('Lead intake failed', { error: err.message });
    res.status(500).json({ ok: false, error: 'Something went wrong' });
  });
  return router;
}

module.exports = { intakeRouter, signatureOk, ipKey, HONEYPOT };

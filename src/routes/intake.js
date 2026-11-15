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
// reversed by trying every address.
function ipHash(ip, slug) {
  const key = process.env.INTAKE_IP_KEY || process.env.TENANT_SECRETS_KEY || 'local-dev-intake';
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

    let channel;
    if (req.get('x-intake-signature') !== undefined) {
      channel = 'api';
      if (!req.is('application/json') || !signatureOk(req.rawBody, req.get('x-intake-signature'), cfg.secret)) {
        return res.status(401).json({ ok: false, error: 'Bad signature' });
      }
    } else {
      channel = 'form';
      const origin = String(req.get('origin') || '').toLowerCase().replace(/\/+$/, '');
      const allowed = origin && cfg.origins.includes(origin);
      if (allowed) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
      if (!allowed || !sameKey(req.body && req.body.form_key, cfg.formKey)) {
        return res.status(401).json({ ok: false, error: 'This website is not allowed to send leads here' });
      }
      if (String((req.body && req.body[HONEYPOT]) || '').trim()) return res.status(202).json({ ok: true }); // a bot: say nothing
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const result = await tenancy.run(tenant.id, async () => {
      // Load this client's profile first: without it, gymConfig falls back to the default
      // profile and the welcome message would carry another business's name.
      await require('../services/businessProfile').ensureLoaded();
      const gymConfig = require('../config/gymConfig');
      return leadIntake.accept({ channel, body, ipHash: ipHash(req.ip, tenant.slug), businessName: gymConfig.profile.name || tenant.name });
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

module.exports = { intakeRouter, signatureOk, HONEYPOT };

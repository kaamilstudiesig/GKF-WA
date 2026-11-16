const express = require('express');
const crypto = require('crypto');
const env = require('../config/env');
const registry = require('../tenancy/registry');
const logger = require('../utils/logger');
const embeddedSignup = require('../services/embeddedSignup');
const { connectRateLimiter } = require('../middleware/rateLimiter');

/**
 * K9 Embedded Signup pages on the bot host (one fixed host, allow-listed in our Meta app):
 *   GET  /connect/:token          the "Connect WhatsApp" page for one client
 *   POST /connect/:token/session  the browser sends Facebook's code + chosen WABA and number
 *   POST /connect/:token/event    session logging: cancel / error steps (Meta asks for it)
 * The token is a signed, expiring link made with `npm run tenant -- connect-link <slug>`.
 */

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function page(res, { title, body, nonce = null, status = 200 }) {
  const fb = nonce
    ? ` script-src 'nonce-${nonce}' https://connect.facebook.net; connect-src 'self' https://*.facebook.com https://*.facebook.net;` +
      ' frame-src https://*.facebook.com; img-src data: https://*.facebook.com https://*.fbcdn.net;'
    : '';
  res.setHeader('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline';${fb} base-uri 'none'; form-action 'none'`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer'); // the link itself is the key
  res.status(status).type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; background: Canvas; color: CanvasText; }
  main { max-width: 520px; margin: 0 auto; padding: 32px 16px 56px; }
  h1 { font-size: 1.5rem; line-height: 1.25; margin: 0 0 8px; }
  p, li { margin: 0 0 10px; }
  .muted { opacity: .72; font-size: .92rem; }
  ol { padding-left: 20px; margin: 16px 0; }
  fieldset { border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 12px; padding: 4px 14px 10px; margin: 18px 0; }
  legend { font-weight: 600; padding: 0 6px; }
  label { display: flex; gap: 10px; align-items: flex-start; padding: 10px 0; cursor: pointer; }
  input[type=radio] { margin-top: 5px; width: 18px; height: 18px; flex: none; }
  button { width: 100%; min-height: 48px; border: 0; border-radius: 12px; background: #1877f2; color: #fff; font: 600 1rem system-ui, sans-serif; cursor: pointer; }
  button[disabled] { opacity: .6; cursor: progress; }
  .box { border-radius: 12px; padding: 12px 14px; margin: 18px 0 0; }
  .ok { background: color-mix(in srgb, #16a34a 16%, Canvas); }
  .err { background: color-mix(in srgb, #dc2626 16%, Canvas); }
  .info { background: color-mix(in srgb, #2563eb 12%, Canvas); }
  [hidden] { display: none !important; }
</style></head><body><main>${body}</main></body></html>`);
}

function messagePage(res, title, text, status = 200) {
  page(res, { title, status, body: `<h1>${esc(title)}</h1><p>${esc(text)}</p>` });
}

/** { tenant, appNumbers } for a link token, or null (bad, expired or unknown). */
function linkFor(token) {
  const link = embeddedSignup.readLinkToken(token);
  const tenant = link ? registry.config(link.tenantId) : null;
  return tenant ? { tenant, appNumbers: link.appNumbers } : null;
}

function connectRouter() {
  const router = express.Router();

  router.get('/connect/:token', connectRateLimiter, h(async (req, res) => {
    await registry.ensureLoaded();
    const link = linkFor(req.params.token);
    if (!link) return messagePage(res, 'Link not valid', 'This link is not valid any more. Ask us for a new one.', 404);
    const { tenant, appNumbers } = link;
    const blocked = embeddedSignup.blockedReason(tenant);
    if (blocked) return messagePage(res, 'Connect WhatsApp', blocked, 409);

    const nonce = crypto.randomBytes(16).toString('base64');
    const cfg = JSON.stringify({
      appId: env.metaAppId,
      configId: env.metaEsConfigId,
      version: env.metaGraphApiVersion,
      sessionUrl: `/connect/${req.params.token}/session`,
      eventUrl: `/connect/${req.params.token}/event`
    }).replace(/</g, '\\u003c');

    page(res, {
      title: `Connect WhatsApp · ${tenant.name}`,
      nonce,
      body: `
<h1>Connect your WhatsApp number</h1>
<p>For <strong>${esc(tenant.name)}</strong>. Takes about 5 minutes.</p>
<ol>
  <li>Log in with the Facebook account that manages your business.</li>
  <li>Choose your business (or create it) and your WhatsApp number.</li>
  <li>Meta sends a code to that number by SMS or call. Enter it.</li>
</ol>
${appNumbers ? `<fieldset>
  <legend>Which number?</legend>
  <label><input type="radio" name="kind" value="new" checked><span><strong>A number not on WhatsApp yet</strong><br><span class="muted">A new SIM or a number you can receive a code on. The AI and your team reply from our CRM.</span></span></label>
  <label><input type="radio" name="kind" value="app"><span><strong>A number I already use on the WhatsApp Business app</strong><br><span class="muted">Keep using the app on your phone. Update the app first. Your contacts and recent chats are shared with us.</span></span></label>
</fieldset>` : '<p class="muted">Use a number that is <strong>not on WhatsApp yet</strong> (a new SIM, or a number you can get an SMS or call on). A number on personal WhatsApp or the WhatsApp Business app won\'t work with this link.</p>'}
<button id="go" type="button" disabled>Loading Facebook…</button>
<div id="status" class="box info" role="status" aria-live="polite" hidden></div>
<p class="muted" style="margin-top:22px">You keep ownership of your WhatsApp account. Meta bills you directly for messages. You can remove our access any time in Meta Business Settings.</p>
<script type="application/json" id="cfg">${cfg}</script>
<script nonce="${nonce}">
(function () {
  var cfg = JSON.parse(document.getElementById('cfg').textContent);
  var go = document.getElementById('go');
  var box = document.getElementById('status');
  var session = null;

  function show(kind, html) { box.className = 'box ' + kind; box.innerHTML = html; box.hidden = false; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function post(url, data) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), credentials: 'same-origin' })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j.httpStatus = r.status; return j; }); });
  }
  function ready() { go.disabled = false; go.textContent = 'Connect with Facebook'; }

  // Session logging: Facebook tells this page which number was picked, or where the person stopped.
  window.addEventListener('message', function (ev) {
    var host = '';
    try { host = new URL(ev.origin).hostname; } catch (e) { return; }
    if (host !== 'facebook.com' && !/\\.facebook\\.com$/.test(host)) return;
    var d = ev.data;
    try { if (typeof d === 'string') d = JSON.parse(d); } catch (e) { return; }
    if (!d || d.type !== 'WA_EMBEDDED_SIGNUP') return;
    if (d.event === 'CANCEL' || d.event === 'ERROR') {
      post(cfg.eventUrl, { event: d.event, data: d.data || {} });
      return;
    }
    session = { event: d.event, phone_number_id: d.data && d.data.phone_number_id, waba_id: d.data && d.data.waba_id };
  });

  function finish(code, triesLeft) {
    // The number details usually arrive just before the code; wait a moment if not.
    if (!session && triesLeft > 0) return setTimeout(function () { finish(code, triesLeft - 1); }, 250);
    show('info', 'Connecting your number… please keep this page open.');
    var s = session || {};
    post(cfg.sessionUrl, { code: code, event: s.event, phone_number_id: s.phone_number_id, waba_id: s.waba_id })
      .then(function (j) {
        if (!j.ok) { show('err', esc(j.error || 'Something went wrong. Please try again.')); ready(); return; }
        var lines = '<strong>Connected: ' + esc(j.number || 'your number') + (j.name ? ' (' + esc(j.name) + ')' : '') + '</strong>';
        lines += j.complete ? '<br>All set. We will confirm when the assistant is live.' : '<br>One setup step needs us to finish it. We have been told; you don\\'t need to do anything.';
        if (j.mode === 'cloud') lines += '<br><br>Last step for you: add a payment method in Meta Business Suite → WhatsApp Manager, so Meta can bill you for messages.';
        show('ok', lines);
        go.hidden = true;
      })
      .catch(function () { show('err', 'Could not reach our server. Check your internet and try again.'); ready(); });
  }

  go.addEventListener('click', function () {
    if (!window.FB) return;
    session = null;
    go.disabled = true; go.textContent = 'Waiting for Facebook…';
    var extras = { setup: {}, sessionInfoVersion: '3' };
    var kind = document.querySelector('input[name=kind]:checked');
    if (kind && kind.value === 'app') extras.featureType = 'whatsapp_business_app_onboarding';
    window.FB.login(function (response) {
      if (response && response.authResponse && response.authResponse.code) return finish(response.authResponse.code, 12);
      show('info', 'Not finished. When you are ready, press the button again.');
      ready();
    }, { config_id: cfg.configId, response_type: 'code', override_default_response_type: true, extras: extras });
  });

  window.fbAsyncInit = function () {
    window.FB.init({ appId: cfg.appId, autoLogAppEvents: true, xfbml: false, version: cfg.version });
    ready();
  };
  var sdk = document.createElement('script');
  sdk.src = 'https://connect.facebook.net/en_US/sdk.js';
  sdk.async = true; sdk.defer = true; sdk.crossOrigin = 'anonymous'; sdk.nonce = '${nonce}';
  sdk.onerror = function () { go.textContent = 'Facebook did not load'; show('err', 'Facebook could not load. Turn off ad or tracker blockers for this page, then reload.'); };
  document.head.appendChild(sdk);
})();
</script>`
    });
  }));

  router.post('/connect/:token/session', connectRateLimiter, h(async (req, res) => {
    await registry.ensureLoaded();
    const link = linkFor(req.params.token);
    if (!link) return res.status(404).json({ ok: false, error: 'This link is not valid any more. Ask us for a new one.' });
    try {
      const { setup, errors } = await embeddedSignup.completeSignup(link.tenant.id, req.body || {}, { appNumbers: link.appNumbers });
      res.json({ ok: true, complete: errors.length === 0, mode: setup.mode, number: setup.number, name: setup.verifiedName });
    } catch (err) {
      if (!(err instanceof embeddedSignup.SignupError)) throw err;
      res.status(err.status).json({ ok: false, error: err.message, step: err.step });
    }
  }));

  router.post('/connect/:token/event', connectRateLimiter, h(async (req, res) => {
    await registry.ensureLoaded();
    const link = linkFor(req.params.token);
    if (!link) return res.status(404).json({ ok: false });
    const { tenant } = link;
    const d = (req.body && req.body.data) || {};
    const clip = v => (v === undefined || v === null ? undefined : String(v).slice(0, 200));
    logger.info('Embedded Signup session event', {
      tenant: tenant.slug,
      event: clip(req.body && req.body.event),
      current_step: clip(d.current_step),
      error_code: clip(d.error_code),
      error_message: clip(d.error_message),
      session_id: clip(d.session_id)
    });
    res.json({ ok: true });
  }));

  return router;
}

module.exports = { connectRouter };

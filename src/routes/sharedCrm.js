const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const env = require('../config/env');
const logger = require('../utils/logger');
const tenancy = require('../tenancy/context');
const registry = require('../tenancy/registry');
const auth = require('../../crm/src/auth');
const crmConfig = require('../../crm/src/config');
const { Users, parseLogin } = require('../../crm/src/users');
const { PLATFORM: PLATFORM_BRAND } = require('../../crm/src/branding');

/**
 * The shared CRM: one address where staff of any client sign in (SHARED_CRM_HOSTS, off when empty).
 * A client's own CRM host (tenants.crm_host, CRM_HOSTS for tenant 1) keeps working as before.
 *
 * - Which client: taken from the sign-in session itself. The session row (crm_sessions, one per
 *   client) is looked up by its token hash in system context, and only its tenant_id comes back;
 *   then the CRM runs as that client, where row-level security applies as usual. No second cookie.
 * - Signed out: this layer serves the Dartit sign-in page, static files, the app manifest and
 *   icons (always Dartit on this host), and the service worker. Nothing else is reachable.
 * - Sign-in: the phone or email is looked up in every active client (the same rules as a client's
 *   own sign-in page) and the password checked against each match. One match signs in. Several
 *   (one person in two businesses) show a "choose your business" list; each choice is a signed,
 *   short-lived ticket bound to that client and user. A business where the password was wrong is
 *   never listed. Errors are the same generic ones as the client's own page.
 * - The choice is bound to this browser: the list sets a random httpOnly cookie and each ticket
 *   carries its hash, so a ticket from another browser (or a cross-site form) is refused. A ticket
 *   works once. Sign-in posts from another site (Origin header) are refused.
 * - Throttles: per typed login (never reset by a success, so a known password in one client can't
 *   clear failed guesses for another) and per IP.
 * - Suspended clients are refused at sign-in and on every request.
 */

const TICKET_MS = 5 * 60 * 1000;
const PICK_COOKIE = 'crm_pick';
const usedTickets = new Map(); // nonce -> expiry (one dyno; tickets live 5 minutes)
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'crm', 'public');
const CRM_VIEWS = path.join(__dirname, '..', '..', 'crm', 'views');

const sharedHosts = () => env.sharedCrmHosts();
const isSharedHost = host => sharedHosts().includes(String(host || '').toLowerCase());

function ticketKey() {
  const raw = Buffer.from(process.env.TENANT_SECRETS_KEY || '', 'base64');
  if (raw.length === 32) return crypto.createHmac('sha256', raw).update('shared-crm-ticket').digest();
  // A public fallback key only on a developer's machine and in tests; anywhere else, no tickets.
  if (!['development', 'test'].includes(process.env.NODE_ENV || 'development')) throw new Error('TENANT_SECRETS_KEY must be set for the shared CRM.');
  return Buffer.from('local-dev-shared-crm');
}

const hashPick = pick => crypto.createHash('sha256').update(String(pick || '')).digest('base64url').slice(0, 22);

/** A signed "this user proved their password for this client, in this browser" ticket: 5 minutes, one use. */
function makeTicket(tenantId, userId, pick, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({ t: tenantId, u: userId, e: now + TICKET_MS, b: hashPick(pick), n: crypto.randomBytes(9).toString('base64url') })).toString('base64url');
  const sig = crypto.createHmac('sha256', ticketKey()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/** { tenantId, userId, nonce } for a valid ticket from this browser (its pick cookie), else null. */
function readTicket(ticket, pick, now = Date.now()) {
  const [body, sig] = String(ticket || '').split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', ticketKey()).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!Number.isInteger(p.t) || !Number.isInteger(p.u) || !(p.e > now) || !pick || p.b !== hashPick(pick)) return null;
    return { tenantId: p.t, userId: p.u, nonce: String(p.n || '') };
  } catch (e) { return null; }
}

/** The client a session token belongs to (system lookup by token hash), or null. */
async function tenantForSession(token) {
  if (!token) return null;
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const row = await tenancy.runAsSystem(() => db.one('SELECT tenant_id FROM crm_sessions WHERE token_hash = $1 AND expires_at > now()', [hash]));
  return row ? row.tenant_id : null;
}

/** Every active client where this login exists and the password is right: [{ tenant, user }]. */
async function matchesFor(login, password) {
  await registry.ensureLoaded();
  const out = [];
  for (const tenant of registry.list()) {
    if (tenant.status !== 'active') continue;
    const user = await tenancy.run(tenant.id, async () => {
      const found = await new Users(db).findByLogin(login);
      const u = found.user;
      return u && u.active && auth.verifyPassword(String(password || ''), u.password_hash) ? u : null;
    });
    if (user) out.push({ tenant, user });
  }
  return out;
}

/** Marks a ticket used; false when it was used before. */
function useTicket(nonce, now = Date.now()) {
  for (const [n, exp] of usedTickets) if (exp < now) usedTickets.delete(n);
  if (!nonce || usedTickets.has(nonce)) return false;
  usedTickets.set(nonce, now + TICKET_MS);
  return true;
}

function sharedCrmLayer({ crmApp, secureCookies, throttle = new auth.LoginThrottle(), ipThrottle = new auth.LoginThrottle(30), sessionTtlHours = crmConfig.sessionTtlHours }) {
  const router = express.Router();
  const assetV = crmApp.locals.assetV || '';

  const render = (res, view, locals, status = 200) => {
    const all = { brand: PLATFORM_BRAND, assetV, flash: null, error: null, user: null, ...locals };
    crmApp.render(view, all, (err, html) => {
      if (err) { logger.error('Shared CRM page failed', { view, error: err.message }); return res.status(500).send('Something went wrong'); }
      res.status(status).type('html').send(html);
    });
  };

  router.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; script-src 'self'; form-action 'self'; frame-ancestors 'none'");
    next();
  });
  router.use('/static', express.static(PUBLIC_DIR, { maxAge: env.nodeEnv === 'production' ? '1d' : 0 }));

  // Installed-app identity on this host is always Dartit.
  router.get('/manifest.webmanifest', (req, res) => {
    res.set('Content-Type', 'application/manifest+json; charset=utf-8').set('Cache-Control', 'no-cache');
    res.send(JSON.stringify({
      name: 'Dartit', short_name: 'Dartit', start_url: '/', scope: '/', display: 'standalone',
      background_color: '#EEE2CB', theme_color: '#1B4532',
      icons: [{ src: '/static/brand/dartit/dartit-mark-light-bg.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }]
    }));
  });
  router.get(['/brand/icon.svg', '/brand/apple-touch-icon.png', '/brand/icon-192.png', '/brand/icon-512.png'], (req, res) => {
    res.redirect(302, '/static/brand/dartit/dartit-mark-light-bg.svg');
  });
  const SW = fs.readFileSync(path.join(PUBLIC_DIR, 'sw.js'), 'utf8').replace('__ASSET_VERSION__', assetV).replace('__BRAND_VERSION__', PLATFORM_BRAND.key);
  router.get('/sw.js', (req, res) => res.set('Content-Type', 'text/javascript; charset=utf-8').set('Cache-Control', 'no-cache').send(SW));
  router.get('/offline', (req, res) => render(res, 'offline', {}));

  router.use(express.urlencoded({ extended: false, limit: '20kb' }));
  // Sign-in only from our own pages: a cross-site form can't sign a browser into someone else's account.
  const sameOrigin = (req, res, next) => {
    const origin = req.get('origin');
    if (origin && origin !== 'null') {
      let host = '';
      try { host = new URL(origin).host; } catch (e) { /* bad origin */ }
      if (host.toLowerCase() !== String(req.get('host') || '').toLowerCase()) return res.status(403).send('Sign in from the Dartit page.');
    }
    next();
  };

  const startSession = async (res, tenantId, userId) => {
    const { token, expires } = await tenancy.run(tenantId, async () => {
      await db.query('UPDATE crm_users SET last_login_at = now() WHERE id = $1', [userId]);
      return auth.createSession(db, userId, sessionTtlHours);
    });
    res.cookie(auth.SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: secureCookies, expires, path: '/' });
  };
  const afterLogin = user => (user.must_change_password ? '/account/password?first=1' : '/');

  router.get('/login', async (req, res, next) => {
    try {
      const token = auth.parseCookies(req.headers.cookie)[auth.SESSION_COOKIE];
      if (await tenantForSession(token)) return res.redirect('/');
      render(res, 'login', { login: '' });
    } catch (err) { next(err); }
  });

  router.post('/login', sameOrigin, async (req, res, next) => {
    try {
      const login = String(req.body.login ?? req.body.email ?? '').trim();
      const key = Users.throttleKey(login);
      if (throttle.blocked(req.ip, key) || ipThrottle.blocked(req.ip, '*')) return render(res, 'login', { login, error: 'Too many failed attempts. Try again in 15 minutes.' }, 429);
      const p = parseLogin(login);
      if (p.kind === 'empty' || p.kind === 'invalid') {
        throttle.fail(req.ip, key); ipThrottle.fail(req.ip, '*');
        const error = p.kind === 'empty' ? 'Enter your phone number or email.' : 'Enter your phone number (for example +91 98450 12345) or your email.';
        return render(res, 'login', { login, error }, 400);
      }
      const matches = await matchesFor(login, req.body.password);
      if (!matches.length) {
        throttle.fail(req.ip, key); ipThrottle.fail(req.ip, '*');
        const hint = p.local ? ' If you typed a phone number, try it with the country code, for example +91 98450 12345.' : '';
        return render(res, 'login', { login, error: 'Phone number, email or password is incorrect.' + hint }, 401);
      }
      // No throttle reset on success: failures for this login expire on their own (15 minutes).
      if (matches.length === 1) {
        await startSession(res, matches[0].tenant.id, matches[0].user.id);
        return res.redirect(afterLogin(matches[0].user));
      }
      const pick = crypto.randomBytes(18).toString('base64url');
      res.cookie(PICK_COOKIE, pick, { httpOnly: true, sameSite: 'strict', secure: secureCookies, maxAge: TICKET_MS, path: '/login' });
      const choices = matches.map(m => ({ name: m.tenant.name, ticket: makeTicket(m.tenant.id, m.user.id, pick) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return render(res, 'choose-business', { choices });
    } catch (err) { next(err); }
  });

  router.post('/login/choose', sameOrigin, async (req, res, next) => {
    try {
      const pick = auth.parseCookies(req.headers.cookie)[PICK_COOKIE];
      const t = readTicket(req.body.ticket, pick);
      const tenant = t && useTicket(t.nonce) ? registry.config(t.tenantId) : null;
      const user = tenant && tenant.status === 'active'
        ? await tenancy.run(tenant.id, () => db.one('SELECT id, must_change_password FROM crm_users WHERE id = $1 AND active', [t.userId]))
        : null;
      if (!user) return render(res, 'login', { login: '', error: 'That choice expired. Sign in again.' }, 401);
      res.clearCookie(PICK_COOKIE, { path: '/login' });
      await startSession(res, tenant.id, user.id);
      res.redirect(afterLogin(user));
    } catch (err) { next(err); }
  });

  // Everything else runs as the signed-in user's client.
  router.use(async (req, res, next) => {
    try {
      const token = auth.parseCookies(req.headers.cookie)[auth.SESSION_COOKIE];
      const tenantId = await tenantForSession(token);
      if (!tenantId) {
        if (req.method === 'GET' || req.method === 'HEAD') return res.redirect('/login');
        return res.status(401).send('Sign in again.');
      }
      await registry.ensureLoaded();
      const tenant = registry.config(tenantId);
      if (!tenant || tenant.status !== 'active') {
        res.clearCookie(auth.SESSION_COOKIE, { path: '/' });
        return res.status(403).send('This business is suspended. Contact Dartit support.');
      }
      req.sharedCrm = true;
      tenancy.run(tenant.id, () => crmApp(req, res, next));
    } catch (err) { next(err); }
  });
  return router;
}

module.exports = { sharedCrmLayer, isSharedHost, sharedHosts, makeTicket, readTicket, tenantForSession, PLATFORM_BRAND, PICK_COOKIE };

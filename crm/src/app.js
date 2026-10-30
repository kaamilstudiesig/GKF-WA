const path = require('path');
const express = require('express');
const config = require('./config');
const auth = require('./auth');
const { Crm, HttpError } = require('./crm');
const { Users } = require('./users');
const { can } = require('./permissions');
const { LEAD_STATUSES, ROLE_LABELS, ROLES } = require('./constants');
const util = require('./util');

/** Express 4 does not catch rejected promises; pass them to the error handler. */
const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Builds the CRM Express app on the given db object (the bot's src/db module,
 * or anything with query/many/one/tx). It opens no
 * connection of its own. Run migrateCrm(db) before serving requests.
 */
function createCrmApp({
  db, sessionTtlHours = config.sessionTtlHours, secureCookies = config.isProd, usdToInr = config.usdToInr
} = {}) {
  if (!db || typeof db.query !== 'function' || typeof db.tx !== 'function') {
    throw new Error('createCrmApp needs a db object with query/many/one/tx (see src/db.js).');
  }
  const app = express();
  const crm = new Crm(db);
  const users = new Users(db);
  const throttle = new auth.LoginThrottle();

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.locals.crm = crm;

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; script-src 'self'; form-action 'self'; frame-ancestors 'none'");
    next();
  });
  app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: config.isProd ? '1d' : 0 }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));

  // ---- session + view helpers ----
  app.use(h(async (req, res, next) => {
    const token = auth.parseCookies(req.headers.cookie)[auth.SESSION_COOKIE];
    const session = await auth.getSession(db, token);
    req.sessionToken = token;
    req.user = session ? session.user : null;
    req.csrfToken = session ? session.csrfToken : null;
    Object.assign(res.locals, {
      user: req.user, csrfToken: req.csrfToken, can, util, LEAD_STATUSES, ROLE_LABELS, ROLES,
      path: req.path, query: req.query, flash: req.query.ok || null, error: req.query.err || null
    });
    next();
  }));

  const setSessionCookie = (res, token, expires) => {
    res.cookie(auth.SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: secureCookies, expires, path: '/' });
  };

  const requireLogin = (req, res, next) => {
    if (!req.user) return res.redirect('/login');
    if (req.user.must_change_password && !['/account/password', '/logout'].includes(req.path)) {
      return res.redirect('/account/password?first=1');
    }
    next();
  };

  const requireCsrf = (req, res, next) => {
    if (req.method === 'POST' && (!req.csrfToken || req.body._csrf !== req.csrfToken)) {
      return res.status(403).render('error', { status: 403, message: 'Your session expired or the form was tampered with. Reload and try again.' });
    }
    next();
  };

  const allow = check => (req, res, next) => (check(req.user)
    ? next()
    : res.status(403).render('error', { status: 403, message: 'Your role does not have access to this page.' }));

  const back = (req, fallback) => {
    const ref = req.get('referer');
    try { const u = new URL(ref); if (u.host === req.get('host')) return u.pathname + u.search; } catch (e) { /* ignore */ }
    return fallback;
  };
  const withOk = (url, msg) => `${url.split('?')[0]}?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(url.split('?')[1] || '')), ok: msg })}`;

  // ---- auth ----
  app.get('/login', (req, res) => (req.user ? res.redirect('/') : res.render('login', { email: '' })));

  app.post('/login', h(async (req, res) => {
    const email = String(req.body.email || '').trim();
    if (throttle.blocked(req.ip, email)) {
      return res.status(429).render('login', { email, error: 'Too many failed attempts. Try again in 15 minutes.' });
    }
    const user = await users.findByEmail(email);
    if (!user || !user.active || !auth.verifyPassword(String(req.body.password || ''), user.password_hash)) {
      throttle.fail(req.ip, email);
      return res.status(401).render('login', { email, error: 'Email or password is incorrect.' });
    }
    throttle.reset(req.ip, email);
    await db.query('UPDATE crm_users SET last_login_at = now() WHERE id = $1', [user.id]);
    const { token, expires } = await auth.createSession(db, user.id, sessionTtlHours);
    setSessionCookie(res, token, expires);
    res.redirect(user.must_change_password ? '/account/password?first=1' : '/');
  }));

  app.post('/logout', requireCsrf, h(async (req, res) => {
    await auth.destroySession(db, req.sessionToken);
    res.clearCookie(auth.SESSION_COOKIE, { path: '/' });
    res.redirect('/login');
  }));

  app.get('/health', h(async (req, res) => {
    await db.query('SELECT 1 FROM leads LIMIT 1');
    await db.query('SELECT 1 FROM crm_users LIMIT 1');
    res.json({ status: 'ok' });
  }));

  // Everything below needs a logged-in user.
  app.use(requireLogin, requireCsrf);

  // ---- account ----
  app.get('/account/password', (req, res) => res.render('password', { first: req.query.first === '1' || req.user.must_change_password }));
  app.post('/account/password', h(async (req, res) => {
    try {
      await users.changeOwnPassword(req.user.id, req.body.current_password, req.body.new_password, req.body.confirm_password);
      res.redirect('/?ok=' + encodeURIComponent('Password updated.'));
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      res.status(err.status).render('password', { first: req.user.must_change_password, error: err.message });
    }
  }));

  // ---- dashboard ----
  app.get('/', h(async (req, res) => res.render('dashboard', { d: await crm.dashboard(req.user) })));

  // ---- leads ----
  app.get('/leads', h(async (req, res) => {
    const filters = {
      status: req.query.status || '', assignee: req.query.assignee || '', q: req.query.q || '',
      needsHuman: req.query.needs_human === '1', sort: req.query.sort || 'attention', page: req.query.page || 1
    };
    res.render('leads', { result: await crm.listLeads(req.user, filters), filters, staff: await crm.assignableUsers(req.user) });
  }));

  app.get('/pipeline', h(async (req, res) => {
    const columns = [];
    for (const status of LEAD_STATUSES) columns.push({ status, ...await crm.listLeads(req.user, { status, sort: 'recent', pageSize: 50 }) });
    res.render('pipeline', { columns });
  }));

  app.get('/leads/:waId', h(async (req, res) => {
    const waId = util.cleanWaId(req.params.waId);
    const lead = await crm.getLead(req.user, waId);
    if (!lead) return res.status(404).render('error', { status: 404, message: 'Lead not found, or it is not assigned to you.' });
    res.render('lead', {
      lead,
      messages: await crm.messages(waId),
      queued: await crm.queuedMessages(waId),
      handoffs: await crm.handoffs(waId),
      notes: await crm.notes(waId),
      followUps: await crm.leadFollowUps(waId),
      activity: await crm.leadActivity(waId),
      staff: await crm.assignableUsers(req.user)
    });
  }));

  const leadAction = (fn, okMsg) => h(async (req, res) => {
    const waId = util.cleanWaId(req.params.waId);
    await fn(req, waId);
    res.redirect(withOk(back(req, `/leads/${waId}`), okMsg));
  });

  app.post('/leads/:waId/status', leadAction((req, waId) => crm.setStatus(req.user, waId, req.body.status), 'Status updated.'));
  app.post('/leads/:waId/assign', allow(can.assignLeads), leadAction((req, waId) => crm.assign(req.user, waId, req.body.user_id || null), 'Assignment updated.'));
  app.post('/leads/:waId/notes', leadAction((req, waId) => crm.addNote(req.user, waId, req.body.body), 'Note added.'));
  app.post('/leads/:waId/message', leadAction((req, waId) => crm.queueMessage(req.user, waId, req.body.text), 'Reply queued for WhatsApp.'));
  app.post('/leads/:waId/handoff/resolve', leadAction((req, waId) => crm.resolveHandoff(req.user, waId), 'Handoff resolved.'));
  app.post('/leads/:waId/followups', leadAction((req, waId) => crm.addFollowUp(req.user, waId, {
    title: req.body.title, dueAt: util.localInputToIso(req.body.due_at), assigneeId: req.body.user_id || null
  }), 'Follow-up scheduled.'));

  // ---- follow-ups ----
  app.get('/followups', h(async (req, res) => {
    const view = can.viewTeamFollowUps(req.user) && req.query.view === 'team' ? 'team' : 'mine';
    const status = req.query.status === 'done' ? 'done' : 'open';
    res.render('followups', { items: await crm.listFollowUps(req.user, { mine: view === 'mine', status }), view, status });
  }));
  app.post('/followups/:id/done', h(async (req, res) => {
    await crm.completeFollowUp(req.user, req.params.id);
    res.redirect(withOk(back(req, '/followups'), 'Follow-up completed.'));
  }));

  // ---- reports ----
  app.get('/reports', allow(can.viewReports), h(async (req, res) => {
    const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
    res.render('reports', { r: await crm.reports(req.user, { days, includeAiCost: can.viewAiCost(req.user), usdToInr }) });
  }));
  app.get('/reports/leads.csv', allow(can.exportLeads), h(async (req, res) => {
    const cols = ['wa_id', 'phone', 'username', 'display_name', 'status', 'interest', 'source', 'assignee_name', 'needs_human', 'handoff_reason',
      'open_followups', 'first_contact_at', 'last_inbound_message_at', 'last_outbound_message_at'];
    const esc = v => {
      let s = v === null || v === undefined ? '' : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // block spreadsheet formula injection
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [cols.join(','), ...(await crm.exportLeads(req.user)).map(l => cols.map(c => esc(l[c])).join(','))];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="gkf-leads-${util.localDay(new Date().toISOString())}.csv"`);
    res.send(lines.join('\n'));
  }));

  // ---- users (owner only) ----
  const usersPage = async (res, extra = {}) => res.render('users', { list: await users.list(), managers: await users.managers(), form: {}, ...extra });
  app.get('/users', allow(can.manageUsers), h((req, res) => usersPage(res)));
  app.post('/users', allow(can.manageUsers), h(async (req, res) => {
    try {
      await users.create({ name: req.body.name, email: req.body.email, role: req.body.role, managerId: req.body.manager_id || null, password: req.body.password });
      res.redirect('/users?ok=' + encodeURIComponent('User created. They must change the password at first login.'));
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      res.status(err.status); await usersPage(res, { error: err.message, form: req.body });
    }
  }));
  app.post('/users/:id', allow(can.manageUsers), h(async (req, res) => {
    try {
      await users.update(req.user, req.params.id, {
        name: req.body.name, email: req.body.email, role: req.body.role, managerId: req.body.manager_id || null, active: req.body.active === '1'
      });
      res.redirect('/users?ok=' + encodeURIComponent('User updated.'));
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      res.status(err.status); await usersPage(res, { error: err.message });
    }
  }));
  app.post('/users/:id/password', allow(can.manageUsers), h(async (req, res) => {
    try {
      await users.resetPassword(req.params.id, req.body.password);
      res.redirect('/users?ok=' + encodeURIComponent('Temporary password set. The user must change it at next login.'));
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      res.status(err.status); await usersPage(res, { error: err.message });
    }
  }));

  // ---- errors ----
  app.use((req, res) => res.status(404).render('error', { status: 404, message: 'Page not found.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) {
      // Validation errors on lead actions: bounce back with the message.
      if (req.method === 'POST' && err.status < 500 && err.status !== 404 && err.status !== 403) {
        const url = back(req, '/');
        return res.redirect(`${url.split('?')[0]}?${new URLSearchParams({ err: err.message })}`);
      }
      return res.status(err.status).render('error', { status: err.status, message: err.message });
    }
    console.error(err);
    res.status(500).render('error', { status: 500, message: config.isProd ? 'Something went wrong.' : err.message });
  });

  return app;
}

module.exports = { createCrmApp };

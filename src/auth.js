const crypto = require('crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const SESSION_COOKIE = 'gkf_crm_session';
const MIN_PASSWORD_LENGTH = 10;

/** Hashes a password with scrypt. Format: scrypt$N$r$p$salt$hash (base64). */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p)
  });
  return crypto.timingSafeEqual(expected, actual);
}

function validateNewPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    return 'Password must contain both letters and numbers.';
  }
  return null;
}

const sha256 = v => crypto.createHash('sha256').update(v).digest('hex');

async function createSession(db, userId, ttlHours) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  const expires = new Date(Date.now() + ttlHours * 3600 * 1000);
  await db.query('DELETE FROM crm_sessions WHERE expires_at < now()');
  await db.query('INSERT INTO crm_sessions (token_hash, user_id, csrf_token, expires_at) VALUES ($1, $2, $3, $4)',
    [sha256(token), userId, csrf, expires.toISOString()]);
  return { token, expires };
}

async function getSession(db, token) {
  if (!token) return null;
  const row = await db.one(`
    SELECT s.csrf_token, u.id, u.email, u.name, u.role, u.manager_id, u.must_change_password
    FROM crm_sessions s JOIN crm_users u ON u.id = s.user_id
    WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active
  `, [sha256(token)]);
  if (!row) return null;
  return {
    csrfToken: row.csrf_token,
    user: { id: row.id, email: row.email, name: row.name, role: row.role, manager_id: row.manager_id, must_change_password: Boolean(row.must_change_password) }
  };
}

async function destroySession(db, token) {
  if (token) await db.query('DELETE FROM crm_sessions WHERE token_hash = $1', [sha256(token)]);
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Simple in-memory login throttle: 8 failures per 15 minutes per IP+email. */
class LoginThrottle {
  constructor(limit = 8, windowMs = 15 * 60 * 1000) { this.limit = limit; this.windowMs = windowMs; this.hits = new Map(); }
  key(ip, email) { return `${ip}|${String(email).toLowerCase()}`; }
  blocked(ip, email) {
    const h = this.hits.get(this.key(ip, email));
    return Boolean(h && h.count >= this.limit && Date.now() - h.first < this.windowMs);
  }
  fail(ip, email) {
    const k = this.key(ip, email); const h = this.hits.get(k);
    if (!h || Date.now() - h.first >= this.windowMs) this.hits.set(k, { count: 1, first: Date.now() });
    else h.count++;
  }
  reset(ip, email) { this.hits.delete(this.key(ip, email)); }
}

module.exports = {
  SESSION_COOKIE, MIN_PASSWORD_LENGTH, hashPassword, verifyPassword, validateNewPassword,
  createSession, getSession, destroySession, parseCookies, LoginThrottle
};

const { hashPassword, verifyPassword, validateNewPassword } = require('./auth');
const { ROLES } = require('./constants');
const { HttpError } = require('./crm');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isId = id => Number.isInteger(id) && id > 0 && id <= 2147483647;
const ALERT_MODES = ['off', 'mine', 'all'];

/** "+91 98450-12345" -> "919845012345"; null when empty or not a full international number. */
function normalizePhone(phone) {
  const raw = String(phone || '').trim();
  if (!raw) return null;
  const digits = raw.replace(/[\s\-().]/g, '').replace(/^\+/, '').replace(/^00/, '');
  return /^[1-9][0-9]{9,14}$/.test(digits) ? digits : null;
}

const PHONE_FORMAT_ERROR = 'Enter the phone number with the country code, for example +91 98450 12345.';
const PHONE_TAKEN_ERROR = 'Another user already signs in with that phone number.';

/**
 * What a person typed in the sign-in box: an email, a phone number, or neither.
 * Phone numbers keep only digits; `local` is true when no country code was typed
 * (no leading + or 00), e.g. "98450 12345" or "098450 12345".
 */
function parseLogin(input) {
  const raw = String(input || '').trim();
  if (!raw) return { kind: 'empty' };
  if (raw.includes('@')) return { kind: 'email', email: raw };
  if (!/^[+0-9\s\-().]+$/.test(raw)) return { kind: 'invalid' };
  const local = !/^(\+|00)/.test(raw.replace(/[\s\-().]/g, ''));
  const digits = raw.replace(/[^0-9]/g, '').replace(/^00/, '');
  if (digits.length < 8 || digits.length > 15) return { kind: 'invalid' };
  return { kind: 'phone', digits, local };
}

class Users {
  constructor(db) { this.db = db; }

  /**
   * Finds the user for a sign-in box value (email or phone).
   * Returns { user } (user may be null), or { error } when the input can't be used.
   * A phone typed without the country code matches the one stored number that ends
   * with it (leading 0 dropped); two matches means the country code is needed.
   */
  async findByLogin(input) {
    const p = parseLogin(input);
    if (p.kind === 'empty') return { error: 'Enter your phone number or email.' };
    if (p.kind === 'invalid') return { error: 'Enter your phone number (for example +91 98450 12345) or your email.' };
    if (p.kind === 'email') return { user: await this.findByEmail(p.email) };
    const exact = await this.db.one('SELECT * FROM crm_users WHERE login_phone = $1', [p.digits]);
    if (exact || !p.local) return { user: exact };
    const national = p.digits.replace(/^0/, '');
    if (national.length < 8) return { user: null };
    const rows = await this.db.many('SELECT * FROM crm_users WHERE login_phone LIKE $1 LIMIT 2', ['%' + national]);
    if (rows.length > 1) return { error: 'Add your country code, for example +91 98450 12345.' };
    return { user: rows[0] || null };
  }

  /** null for empty; throws a 400 for a number we can't use. */
  static loginPhoneOrNull(phone) {
    if (!String(phone || '').trim()) return null;
    const digits = normalizePhone(phone);
    if (!digits) throw new HttpError(400, PHONE_FORMAT_ERROR);
    return digits;
  }

  async assertLoginPhoneFree(digits, exceptId = null) {
    if (!digits) return;
    const other = await this.db.one('SELECT id FROM crm_users WHERE login_phone = $1', [digits]);
    if (other && other.id !== exceptId) throw new HttpError(409, PHONE_TAKEN_ERROR);
  }

  /** Sets or clears (empty) the phone number a user signs in with. */
  async setLoginPhone(id, phone) {
    const user = await this.get(id);
    if (!user) throw new HttpError(404, 'User not found.');
    const digits = Users.loginPhoneOrNull(phone);
    await this.assertLoginPhoneFree(digits, user.id);
    try {
      await this.db.query('UPDATE crm_users SET login_phone = $1, updated_at = now() WHERE id = $2', [digits, user.id]);
    } catch (err) {
      if (err.code === '23505') throw new HttpError(409, PHONE_TAKEN_ERROR); // raced another save
      throw err;
    }
    return this.get(user.id);
  }

  /** Emails are matched case-insensitively (unique index on lower(email)). */
  async findByEmail(email) {
    return this.db.one('SELECT * FROM crm_users WHERE lower(email) = lower($1)', [String(email || '').trim()]);
  }

  async get(id) {
    const n = Number(id);
    return isId(n) ? this.db.one('SELECT * FROM crm_users WHERE id = $1', [n]) : null;
  }

  async list() {
    return this.db.many(`
      SELECT u.*, m.name AS manager_name,
        (SELECT COUNT(*)::int FROM crm_lead_assignments a WHERE a.user_id = u.id) AS lead_count
      FROM crm_users u LEFT JOIN crm_users m ON m.id = u.manager_id
      ORDER BY u.active DESC, CASE u.role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, u.name
    `);
  }

  async managers() {
    return this.db.many("SELECT id, name, email FROM crm_users WHERE role = 'manager' AND active ORDER BY name");
  }

  async validate({ name, email, role, managerId }) {
    if (!String(name || '').trim()) throw new HttpError(400, 'Name is required.');
    if (!EMAIL_RE.test(String(email || '').trim())) throw new HttpError(400, 'A valid email is required.');
    if (!ROLES.includes(role)) throw new HttpError(400, 'Invalid role.');
    if (managerId) {
      const m = await this.get(managerId);
      if (!m || m.role !== 'manager') throw new HttpError(400, 'Selected manager is not a manager.');
    }
  }

  async create({ name, email, role, managerId, password, mustChange = true, loginPhone = null }) {
    await this.validate({ name, email, role, managerId });
    const pwErr = validateNewPassword(password);
    if (pwErr) throw new HttpError(400, pwErr);
    const phone = Users.loginPhoneOrNull(loginPhone);
    if (await this.findByEmail(email)) throw new HttpError(409, 'A user with that email already exists.');
    await this.assertLoginPhoneFree(phone);
    let row;
    try {
      row = await this.db.one(`INSERT INTO crm_users (email, name, role, manager_id, password_hash, must_change_password, active, login_phone)
        VALUES ($1, $2, $3, $4, $5, $6, true, $7) RETURNING id`, [String(email).trim(), String(name).trim(), role,
        role === 'sales' && managerId ? Number(managerId) : null, hashPassword(password), Boolean(mustChange), phone]);
    } catch (err) {
      // Raced another insert: say which unique value clashed.
      if (err.code === '23505') throw new HttpError(409, /login_phone/.test(err.constraint || err.message || '') ? PHONE_TAKEN_ERROR : 'A user with that email already exists.');
      throw err;
    }
    return this.get(row.id);
  }

  async update(actor, id, { name, email, role, managerId, active }) {
    const user = await this.get(id);
    if (!user) throw new HttpError(404, 'User not found.');
    await this.validate({ name, email, role, managerId });
    const other = await this.findByEmail(email);
    if (other && other.id !== user.id) throw new HttpError(409, 'A user with that email already exists.');
    const isActive = Boolean(active);
    if (user.id === actor.id && (role !== 'owner' || !isActive)) {
      throw new HttpError(400, 'You cannot remove your own owner access.');
    }
    await this.db.tx(async () => {
      if (user.role === 'owner' && (role !== 'owner' || !isActive)) {
        // Lock the active owners so two concurrent demotions cannot remove the last one.
        const owners = await this.db.many("SELECT id FROM crm_users WHERE role = 'owner' AND active FOR UPDATE");
        if (owners.length <= 1) throw new HttpError(400, 'There must be at least one active owner.');
      }
      await this.db.query('UPDATE crm_users SET name = $1, email = $2, role = $3, manager_id = $4, active = $5, updated_at = now() WHERE id = $6',
        [String(name).trim(), String(email).trim(), role, role === 'sales' && managerId ? Number(managerId) : null, isActive, user.id]);
      if (role !== 'manager') await this.db.query('UPDATE crm_users SET manager_id = NULL WHERE manager_id = $1', [user.id]);
      if (!isActive) await this.db.query('DELETE FROM crm_sessions WHERE user_id = $1', [user.id]);
    });
    return this.get(user.id);
  }

  /**
   * WhatsApp alerts for one staff member. mode: 'off', 'mine' (their leads, and
   * their team's leads for a manager) or 'all'. The phone needs the country code.
   */
  async setAlerts(id, { phone, mode }) {
    const user = await this.get(id);
    if (!user) throw new HttpError(404, 'User not found.');
    if (!ALERT_MODES.includes(mode)) throw new HttpError(400, 'Choose which alerts to send.');
    const digits = normalizePhone(phone);
    if (String(phone || '').trim() && !digits) {
      throw new HttpError(400, 'Enter the WhatsApp number with the country code, for example +91 98450 12345.');
    }
    if (mode !== 'off' && !digits) throw new HttpError(400, 'Add a WhatsApp number to turn alerts on.');
    await this.db.query('UPDATE crm_users SET alert_phone = $1, alert_mode = $2, updated_at = now() WHERE id = $3',
      [digits, mode, user.id]);
    return this.get(user.id);
  }

  /** Owner sets a temporary password; the user must change it at next login. */
  async resetPassword(id, password) {
    const user = await this.get(id);
    if (!user) throw new HttpError(404, 'User not found.');
    const pwErr = validateNewPassword(password);
    if (pwErr) throw new HttpError(400, pwErr);
    await this.db.tx(async () => {
      await this.db.query('UPDATE crm_users SET password_hash = $1, must_change_password = true, updated_at = now() WHERE id = $2',
        [hashPassword(password), user.id]);
      await this.db.query('DELETE FROM crm_sessions WHERE user_id = $1', [user.id]);
    });
  }

  async changeOwnPassword(id, current, next, confirm) {
    const user = await this.get(id);
    if (!user || !verifyPassword(current, user.password_hash)) throw new HttpError(400, 'Current password is incorrect.');
    if (next !== confirm) throw new HttpError(400, 'New passwords do not match.');
    if (next === current) throw new HttpError(400, 'New password must be different from the current one.');
    const pwErr = validateNewPassword(next);
    if (pwErr) throw new HttpError(400, pwErr);
    await this.db.query('UPDATE crm_users SET password_hash = $1, must_change_password = false, updated_at = now() WHERE id = $2',
      [hashPassword(next), user.id]);
  }
}

module.exports = { Users, normalizePhone, parseLogin, ALERT_MODES };

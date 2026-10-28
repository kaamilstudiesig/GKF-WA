const { hashPassword, verifyPassword, validateNewPassword } = require('./auth');
const { ROLES } = require('./constants');
const { HttpError } = require('./crm');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isId = id => Number.isInteger(id) && id > 0 && id <= 2147483647;

class Users {
  constructor(db) { this.db = db; }

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
    return this.db.many("SELECT id, name FROM crm_users WHERE role = 'manager' AND active ORDER BY name");
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

  async create({ name, email, role, managerId, password, mustChange = true }) {
    await this.validate({ name, email, role, managerId });
    const pwErr = validateNewPassword(password);
    if (pwErr) throw new HttpError(400, pwErr);
    if (await this.findByEmail(email)) throw new HttpError(409, 'A user with that email already exists.');
    let row;
    try {
      row = await this.db.one(`INSERT INTO crm_users (email, name, role, manager_id, password_hash, must_change_password, active)
        VALUES ($1, $2, $3, $4, $5, $6, true) RETURNING id`, [String(email).trim(), String(name).trim(), role,
        role === 'sales' && managerId ? Number(managerId) : null, hashPassword(password), Boolean(mustChange)]);
    } catch (err) {
      if (err.code === '23505') throw new HttpError(409, 'A user with that email already exists.'); // raced another insert
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

module.exports = { Users };

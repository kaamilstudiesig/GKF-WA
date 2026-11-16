const { hashPasswordAsync, oneTimePassword } = require('./auth');
const { ROLES } = require('./constants');
const { HttpError } = require('./crm');
const { normalizePhone } = require('./users');

/**
 * R13: add many staff at once. Rows come from pasted CSV and/or the form's rows:
 *   name, email, role, manager email, WhatsApp alert number (optional)
 * Every row is checked first; then all are saved in one transaction, or none.
 * Each new person gets a random one-time password, returned once and never stored in plain text.
 */

const MAX_ROWS = 100;
const COLUMNS = ['name', 'email', 'role', 'manager', 'phone'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class BulkError extends HttpError {
  /** rows: the cleaned rows, each with errors: [] so the form can show them in place. */
  constructor(message, rows) { super(400, message); this.rows = rows; }
}

/** Minimal CSV: commas or tabs (pasted from a spreadsheet), "quoted, values" and "" escapes. */
function parseCsv(text) {
  const src = String(text || '').replace(/\r\n?/g, '\n');
  const firstLine = src.split('\n').find(l => l.trim()) || '';
  const sep = firstLine.includes('\t') && !firstLine.includes(',') ? '\t' : ',';
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"' && !cell.trim()) { quoted = true; cell = ''; } else if (c === sep) { row.push(cell); cell = ''; } else if (c === '\n') {
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  row.push(cell); rows.push(row);
  const out = rows.map(r => Object.fromEntries(COLUMNS.map((k, i) => [k, String(r[i] ?? '').trim()])))
    .filter(r => COLUMNS.some(k => r[k]));
  // Skip a header row ("name, email, role, ...").
  if (out.length && !EMAIL_RE.test(out[0].email) && /e-?mail/i.test(out[0].email)) out.shift();
  return out;
}

/** The form's row inputs (row_name[], row_email[], ...) -> rows, skipping empty ones. */
function rowsFromForm(body) {
  const arr = v => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
  const cols = Object.fromEntries(COLUMNS.map(k => [k, arr(body[`row_${k}`])]));
  const n = Math.max(...COLUMNS.map(k => cols[k].length), 0);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const r = Object.fromEntries(COLUMNS.map(k => [k, String(cols[k][i] ?? '').trim()]));
    // The role dropdown always sends a value, so a row only counts when something else is filled in.
    if (COLUMNS.some(k => k !== 'role' && r[k])) rows.push(r);
  }
  return [...rows, ...parseCsv(body.csv)];
}

/** "Sales", "sales rep", "" -> 'sales'; unknown -> null. */
function parseRole(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return 'sales';
  if (ROLES.includes(s)) return s;
  if (/^sales/.test(s)) return 'sales';
  if (/^manager|^team lead/.test(s)) return 'manager';
  return null;
}

/**
 * Checks every row against the batch and the database. Returns cleaned rows with
 * errors: [] each; throws nothing (the caller decides).
 */
async function checkRows(db, input) {
  const existing = new Map((await db.many('SELECT id, lower(email) AS email, role, active FROM crm_users'))
    .map(u => [u.email, u]));
  const seen = new Map();
  const rows = input.map((r, i) => ({ ...r, line: i + 1, errors: [] }));
  for (const r of rows) {
    const key = r.email.toLowerCase();
    if (seen.has(key)) seen.get(key).push(r); else seen.set(key, [r]);
  }
  const batchManagers = new Set(rows.filter(r => parseRole(r.role) === 'manager').map(r => r.email.toLowerCase()));

  for (const r of rows) {
    const key = r.email.toLowerCase();
    if (!r.name) r.errors.push('Name is missing.');
    if (r.name.length > 100) r.errors.push('Name is too long.');
    if (!EMAIL_RE.test(r.email)) r.errors.push('Email is not valid.');
    else if (existing.has(key)) r.errors.push('Someone with this email already has an account.');
    else if (seen.get(key).length > 1) r.errors.push('This email is in the list more than once.');
    r.roleKey = parseRole(r.role);
    if (!r.roleKey) r.errors.push('Role must be owner, manager or sales.');
    if (r.manager) {
      const mKey = r.manager.toLowerCase();
      const m = existing.get(mKey);
      if (r.roleKey && r.roleKey !== 'sales') r.errors.push('Only sales staff have a manager. Leave it empty.');
      else if (!(m && m.role === 'manager' && m.active) && !batchManagers.has(mKey)) {
        r.errors.push('Manager email is not an active manager here or in this list.');
      }
    }
    r.phoneDigits = normalizePhone(r.phone);
    if (r.phone && !r.phoneDigits) r.errors.push('WhatsApp number needs the country code, like +91 98450 12345.');
  }
  return { rows, existing };
}

/**
 * Saves all rows or none. Returns [{ name, email, role, password }] for the one-time list.
 * Managers are created first so sales rows can point to a manager added in the same batch.
 */
async function bulkCreate(db, input) {
  if (!input.length) throw new BulkError('Add at least one person.', []);
  if (input.length > MAX_ROWS) throw new BulkError(`Add at most ${MAX_ROWS} people at a time.`, []);
  const { rows, existing } = await checkRows(db, input);
  const bad = rows.filter(r => r.errors.length);
  if (bad.length) {
    throw new BulkError(`${bad.length} of ${rows.length} rows need fixing. Nobody was added.`, rows);
  }

  const people = await Promise.all(rows.map(async r => {
    const password = oneTimePassword();
    return { r, password, hash: await hashPasswordAsync(password) };
  }));
  const order = { owner: 0, manager: 1, sales: 2 };
  people.sort((a, b) => order[a.r.roleKey] - order[b.r.roleKey]);

  try {
    await db.tx(async () => {
      const ids = new Map([...existing].map(([email, u]) => [email, u.id]));
      for (const { r, hash } of people) {
        const managerId = r.roleKey === 'sales' && r.manager ? ids.get(r.manager.toLowerCase()) : null;
        const row = await db.one(`INSERT INTO crm_users (email, name, role, manager_id, password_hash, must_change_password, active, alert_phone, alert_mode)
          VALUES ($1, $2, $3, $4, $5, true, true, $6, $7) RETURNING id`,
        [r.email, r.name, r.roleKey, managerId || null, hash, r.phoneDigits, r.phoneDigits ? 'mine' : 'off']);
        ids.set(r.email.toLowerCase(), row.id);
      }
    });
  } catch (err) {
    // Someone added one of these emails between the check and the save.
    if (err.code === '23505') throw new BulkError('Someone with one of these emails was just added. Nobody was added; check the list and try again.', rows);
    throw err;
  }
  return people.map(({ r, password }) => ({ name: r.name, email: r.email, role: r.roleKey, password }));
}

module.exports = { bulkCreate, parseCsv, rowsFromForm, parseRole, BulkError, MAX_ROWS, COLUMNS };

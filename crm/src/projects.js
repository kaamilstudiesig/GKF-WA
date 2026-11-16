const { HttpError } = require('./crm');
const { parseAmount, money } = require('./util');

/**
 * R17: projects and the units under them (contract in docs/TEAM.md, "R17: projects and units").
 * The CRM is the source of truth; K24 (Kaamil) later pushes units to the client's Meta catalog.
 * Runs inside the client's tenant context (row-level security). Removing hides (status archived):
 * units already sent to leads stay readable in their history, and retailer ids are never reused.
 */

const STATUSES = ['active', 'sold_out', 'archived'];
// Meta's limits for one product list message: 30 products in at most 10 sections (one per project).
const SEND_LIMITS = { units: 30, projects: 10 };
const MAX_PRICE = 2000000000; // 2 billion units (₹200 crore): fits crm_units.price_from INTEGER (max 2,147,483,647)
const MAX_TEXT = 4096; // WhatsApp's limit for one text message

const str = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const isId = v => Number.isInteger(Number(v)) && Number(v) > 0 && Number(v) <= 2147483647;

/** An https address or null; anything else is refused (no uploads in v1). */
function httpsUrl(v, label) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  let u;
  try { u = new URL(s); } catch (e) { throw new HttpError(400, `${label}: not a web address.`); }
  if (u.protocol !== 'https:') throw new HttpError(400, `${label}: use an https:// address.`);
  return u.toString().slice(0, 500);
}

function projectInput(b) {
  const name = str(b.name, 80);
  if (!name) throw new HttpError(400, 'Give the project a name.');
  return {
    name, area: str(b.area, 80) || null, kind: str(b.kind, 40) || null, handover: str(b.handover, 40) || null,
    brochure_url: httpsUrl(b.brochure_url, 'Brochure link'), photo_url: httpsUrl(b.photo_url, 'Photo link')
  };
}

function unitInput(b) {
  const name = str(b.name, 60);
  if (!name) throw new HttpError(400, 'Give the unit a name, like "2 BHK" or "Studio".');
  let size = null;
  if (String(b.size_sqft ?? '').trim()) {
    size = Number(String(b.size_sqft).replace(/[,\s]/g, ''));
    if (!Number.isInteger(size) || size <= 0 || size > 1000000) throw new HttpError(400, 'Size: a whole number of square feet.');
  }
  let price = null;
  if (String(b.price_from ?? '').trim()) {
    const p = parseAmount(b.price_from);
    if (p.error || p.amount <= 0 || p.amount > MAX_PRICE) throw new HttpError(400, `Price from: ${p.error || 'a whole number up to 2,000,000,000.'}`);
    price = p.amount;
  }
  return { name, size_sqft: size, price_from: price, photo_url: httpsUrl(b.photo_url, 'Photo link') };
}

/** What a unit still needs before it can go to a Meta catalog (contract change 2). */
function catalogNeeds(unit, project, { website = null } = {}) {
  const needs = [];
  if (!(unit.photo_url || project.photo_url)) needs.push('photo');
  if (!(project.brochure_url || website)) needs.push('link');
  if (!unit.price_from) needs.push('price');
  return needs;
}

class Projects {
  constructor(db) { this.db = db; }

  /** Projects with their units, in order. Archived ones only with { archived: true }. */
  async list({ archived = false } = {}) {
    const projects = await this.db.many(`SELECT * FROM crm_projects ${archived ? '' : "WHERE status <> 'archived'"} ORDER BY sort, id`);
    const units = await this.db.many(`SELECT * FROM crm_units ${archived ? '' : "WHERE status <> 'archived'"} ORDER BY sort, id`);
    return projects.map(p => ({ ...p, units: units.filter(u => u.project_id === p.id) }));
  }

  async project(id) {
    if (!isId(id)) throw new HttpError(404, 'Project not found.');
    const p = await this.db.one('SELECT * FROM crm_projects WHERE id = $1', [Number(id)]);
    if (!p) throw new HttpError(404, 'Project not found.');
    return p;
  }

  async unit(id) {
    if (!isId(id)) throw new HttpError(404, 'Unit not found.');
    const u = await this.db.one('SELECT * FROM crm_units WHERE id = $1', [Number(id)]);
    if (!u) throw new HttpError(404, 'Unit not found.');
    return u;
  }

  async addProject(body) {
    const p = projectInput(body);
    return this.db.one(`INSERT INTO crm_projects (name, area, kind, handover, brochure_url, photo_url, sort)
      VALUES ($1, $2, $3, $4, $5, $6, (SELECT COALESCE(MAX(sort), 0) + 1 FROM crm_projects)) RETURNING *`,
    [p.name, p.area, p.kind, p.handover, p.brochure_url, p.photo_url]);
  }

  async updateProject(id, body) {
    const before = await this.project(id);
    const p = projectInput(body);
    await this.db.tx(async () => {
      await this.db.query(`UPDATE crm_projects SET name = $2, area = $3, kind = $4, handover = $5, brochure_url = $6, photo_url = $7,
        updated_at = now() WHERE id = $1`, [before.id, p.name, p.area, p.kind, p.handover, p.brochure_url, p.photo_url]);
      // Catalog titles and descriptions use the project: its units need sending again (K24).
      await this.db.query('UPDATE crm_units SET dirty = true, updated_at = now() WHERE project_id = $1', [before.id]);
    });
    return this.project(before.id);
  }

  async addUnit(projectId, body) {
    const project = await this.project(projectId);
    if (project.status === 'archived') throw new HttpError(400, 'This project is archived.');
    const u = unitInput(body);
    return this.db.tx(async () => {
      const row = await this.db.one(`INSERT INTO crm_units (project_id, name, size_sqft, price_from, photo_url, sort)
        VALUES ($1, $2, $3, $4, $5, (SELECT COALESCE(MAX(sort), 0) + 1 FROM crm_units WHERE project_id = $1)) RETURNING id`,
      [project.id, u.name, u.size_sqft, u.price_from, u.photo_url]);
      // The catalog id: set once from the row id, never edited or reused.
      return this.db.one("UPDATE crm_units SET retailer_id = 'u' || id WHERE id = $1 RETURNING *", [row.id]);
    });
  }

  async updateUnit(id, body) {
    const before = await this.unit(id);
    const u = unitInput(body);
    await this.db.query(`UPDATE crm_units SET name = $2, size_sqft = $3, price_from = $4, photo_url = $5, dirty = true, updated_at = now()
      WHERE id = $1`, [before.id, u.name, u.size_sqft, u.price_from, u.photo_url]);
    return this.unit(before.id);
  }

  /** active / sold_out / archived, for a project or a unit. */
  async setStatus(kind, id, status) {
    if (!STATUSES.includes(status)) throw new HttpError(400, 'Unknown status.');
    if (kind === 'project') {
      const p = await this.project(id);
      await this.db.tx(async () => {
        await this.db.query('UPDATE crm_projects SET status = $2, updated_at = now() WHERE id = $1', [p.id, status]);
        await this.db.query('UPDATE crm_units SET dirty = true, updated_at = now() WHERE project_id = $1', [p.id]);
      });
      return p;
    }
    const u = await this.unit(id);
    await this.db.query('UPDATE crm_units SET status = $2, dirty = true, updated_at = now() WHERE id = $1', [u.id, status]);
    return u;
  }

  /** Moves a project, or a unit within its project, one place up or down. */
  async move(kind, id, direction) {
    const table = kind === 'project' ? 'crm_projects' : 'crm_units';
    const row = kind === 'project' ? await this.project(id) : await this.unit(id);
    const scope = kind === 'project' ? '' : 'AND project_id = $3';
    const params = kind === 'project' ? [row.sort, row.id] : [row.sort, row.id, row.project_id];
    const up = direction === 'up';
    const other = await this.db.one(`SELECT id, sort FROM ${table} WHERE status <> 'archived' AND id <> $2 ${scope}
      AND (sort ${up ? '<' : '>'} $1 OR (sort = $1 AND id ${up ? '<' : '>'} $2)) ORDER BY sort ${up ? 'DESC' : 'ASC'}, id ${up ? 'DESC' : 'ASC'} LIMIT 1`, params);
    if (!other) return;
    await this.db.tx(async () => {
      // Swap; if both had the same sort, give them distinct ones.
      const [a, b] = other.sort === row.sort ? (up ? [row.sort - 1, row.sort] : [row.sort + 1, row.sort]) : [other.sort, row.sort];
      await this.db.query(`UPDATE ${table} SET sort = $2, updated_at = now() WHERE id = $1`, [row.id, a]);
      await this.db.query(`UPDATE ${table} SET sort = $2, updated_at = now() WHERE id = $1`, [other.id, b]);
    });
  }

  /** Units that can be sent to a lead: active units of active projects. */
  async sendable() {
    return this.db.many(`SELECT u.*, p.name AS project_name, p.area, p.kind, p.handover, p.brochure_url, p.photo_url AS project_photo, p.sort AS project_sort
      FROM crm_units u JOIN crm_projects p ON p.id = u.project_id
      WHERE u.status = 'active' AND p.status = 'active' ORDER BY p.sort, p.id, u.sort, u.id`);
  }

  /**
   * The WhatsApp message for the chosen units (plain text: works without a catalog; K24 adds the
   * product list). Checks Meta's limits so the same choice also works as a product list later.
   * Returns { text, units, projects }.
   */
  async message(unitIds, { businessName = '', currency = 'INR' } = {}) {
    const ids = [...new Set((Array.isArray(unitIds) ? unitIds : [unitIds]).filter(isId).map(Number))];
    if (!ids.length) throw new HttpError(400, 'Pick at least one unit to send.');
    if (ids.length > SEND_LIMITS.units) throw new HttpError(400, `Pick up to ${SEND_LIMITS.units} units at a time.`);
    const units = (await this.sendable()).filter(u => ids.includes(u.id));
    if (units.length !== ids.length) throw new HttpError(400, 'Some of those units are sold out or no longer listed. Refresh and pick again.');
    const projectIds = [...new Set(units.map(u => u.project_id))];
    if (projectIds.length > SEND_LIMITS.projects) throw new HttpError(400, `Pick units from up to ${SEND_LIMITS.projects} projects at a time.`);

    const blocks = projectIds.map(pid => {
      const us = units.filter(u => u.project_id === pid);
      const p = us[0];
      const head = [p.project_name, p.area ? `, ${p.area}` : '', p.handover ? ` (handover ${p.handover})` : ''].join('');
      const lines = us.map(u => `- ${[u.name, u.size_sqft ? `${u.size_sqft.toLocaleString('en-US')} sq ft` : null,
        u.price_from ? `from ${money(u.price_from, currency)}` : null].filter(Boolean).join(', ')}`);
      return [head, ...lines, ...(p.brochure_url ? [`Brochure: ${p.brochure_url}`] : [])].join('\n');
    });
    const text = [`Here are the options${businessName ? ` from ${businessName}` : ''}:`, ...blocks,
      'Tell me which one you like and I will share more details or set up a visit.'].join('\n\n');
    // Long brochure links can push 30 units past WhatsApp's limit even inside Meta's product limits.
    if (text.length > MAX_TEXT) throw new HttpError(400, 'That is too long for one WhatsApp message. Pick fewer units or projects and send the rest next.');
    return { text, units: units.map(u => u.id), projects: projectIds };
  }
}

module.exports = { Projects, catalogNeeds, SEND_LIMITS, STATUSES, unitInput, MAX_PRICE };

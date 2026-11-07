const tenancy = require('../../src/tenancy/context');

/**
 * What the CRM shows about the Zoho CRM sync (K20, built by Kaamil in src/services/zoho/).
 * Reads only our own tables (zoho_links, zoho_cursors) and the client's settings:
 * it never calls Zoho, so the pages stay fast and work when Zoho is down.
 */

/** "https://accounts.zoho.in" -> "https://crm.zoho.in" (Zoho runs one site per data centre). */
function webDomain(accountsUrl) {
  const m = /^https:\/\/accounts\.(zoho\.[a-z.]+)\/?$/.exec(String(accountsUrl || ''));
  return m ? `https://crm.${m[1]}` : null;
}

/** Web link to the most useful Zoho record for a lead: its Deal, else Contact, else Lead. */
function recordUrl(domain, link) {
  if (!domain || !link) return null;
  const id = v => (/^\d{1,30}$/.test(String(v || '')) ? String(v) : null);
  for (const [module, field, label] of [['Deals', 'zoho_deal_id', 'deal'], ['Contacts', 'zoho_contact_id', 'contact'], ['Leads', 'zoho_lead_id', 'lead']]) {
    if (id(link[field])) return { url: `${domain}/crm/tab/${module}/${id(link[field])}`, label };
  }
  return null;
}

const STATE_LABELS = { synced: 'In sync', sending: 'Sending', failed: 'Retrying', dead: 'Not sent', skipped: 'Skipped', waiting: 'Waiting to send', none: 'Not in Zoho yet' };
const ERROR_CHARS = 200; // Zoho's errors can be long; the pages show the start

class ZohoStatus {
  /** registry: src/tenancy/registry (config(tenantId).zoho). */
  constructor(db, registry) { this.db = db; this.registry = registry; }

  /** The client's Zoho settings, or null when off. An unknown client (no config) is off; real errors throw. */
  config() {
    const cfg = this.registry.config(tenancy.tenantId());
    return (cfg && cfg.zoho) || null;
  }

  /** For Business settings: on/off, last read, counts, and the leads Zoho refused. */
  async summary() {
    const z = this.config();
    if (!z || !z.on) return { on: false };
    const counts = await this.db.many(`SELECT COALESCE(status, 'waiting') AS status, dirty, COUNT(*)::int AS n FROM zoho_links GROUP BY 1, 2`);
    const c = { synced: 0, waiting: 0, retrying: 0, notSent: 0 };
    // Every row lands in one bucket except 'skipped': the worker claimed it while Zoho was being
    // turned off; it isn't waiting and goes out again on the lead's next change.
    for (const r of counts) {
      if (r.status === 'dead') c.notSent += r.n;
      else if (r.status === 'failed') c.retrying += r.n;
      else if (r.dirty || r.status === 'sending' || r.status === 'waiting') c.waiting += r.n;
      else if (r.status === 'synced') c.synced += r.n;
    }
    const cursor = await this.db.one('SELECT pulled_until, last_error FROM zoho_cursors');
    const notSent = await this.db.many(`SELECT z.wa_id, z.last_error, COALESCE(NULLIF(l.display_name, ''), l.username, l.phone, z.wa_id) AS name
      FROM zoho_links z LEFT JOIN leads l ON l.wa_id = z.wa_id WHERE z.status = 'dead' ORDER BY z.dirty_at DESC LIMIT 5`);
    return {
      on: true,
      domain: webDomain(z.accountsUrl),
      pulledUntil: cursor ? cursor.pulled_until : null,
      readError: cursor && cursor.last_error ? String(cursor.last_error).slice(0, ERROR_CHARS) : null,
      counts: c,
      notSent: notSent.map(r => ({ waId: r.wa_id, name: r.name, error: String(r.last_error || '').slice(0, ERROR_CHARS) }))
    };
  }

  /** For the lead page: { url, label, state, stateLabel, error } or null when Zoho is off. */
  async forLead(waId) {
    const z = this.config();
    if (!z || !z.on) return null;
    const link = await this.db.one(`SELECT zoho_lead_id, zoho_contact_id, zoho_deal_id, status, dirty, last_error FROM zoho_links WHERE wa_id = $1`, [waId]);
    // No row: the lead existed before Zoho was turned on and wasn't in the backfill
    // (npm run zoho -- backfill --days 30), and hasn't changed since.
    const state = !link ? 'none' : link.status === 'dead' ? 'dead' : link.status === 'failed' ? 'failed' : link.dirty ? 'waiting' : link.status || 'waiting';
    const rec = recordUrl(webDomain(z.accountsUrl), link);
    return {
      url: rec && rec.url, label: rec && rec.label, state, stateLabel: STATE_LABELS[state] || state,
      error: link && ['dead', 'failed'].includes(state) ? String(link.last_error || '').slice(0, ERROR_CHARS) : null
    };
  }
}

module.exports = { ZohoStatus, webDomain, recordUrl };

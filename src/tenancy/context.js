const { AsyncLocalStorage } = require('async_hooks');

/**
 * Which client (tenant) the current work belongs to.
 *
 * Every database query runs as one tenant, and Postgres row-level security only
 * shows that tenant's rows (see src/db/platformMigrations.js). Entry points set
 * the tenant once and everything they call inherits it:
 *   - a webhook change: the tenant that owns the WhatsApp number
 *   - a queue job: the tenant stored on the job row
 *   - a CRM request: the tenant that owns the CRM hostname
 * Work that spans all tenants (claiming queue jobs, housekeeping, migrations,
 * loading the tenant list) runs with runAsSystem().
 *
 * A query with no tenant and no system flag throws: it fails closed instead of
 * guessing a tenant.
 */
const store = new AsyncLocalStorage();
let testFallback = null; // tests only: the tenant for code that runs outside any entry point

class TenancyError extends Error {}

const isTenantId = id => Number.isInteger(id) && id > 0;

const tenancy = {
  TenancyError,

  /** Runs fn as tenant `tenantId`. */
  run(tenantId, fn) {
    const id = Number(tenantId);
    if (!isTenantId(id)) throw new TenancyError(`Invalid tenant id: ${tenantId}`);
    return store.run({ tenantId: id, system: false }, fn);
  },

  /** Runs fn across all tenants (queue claims, housekeeping, tenant list). Inserts must name tenant_id. */
  runAsSystem(fn) {
    return store.run({ tenantId: null, system: true }, fn);
  },

  /** { tenantId, system } for the current work, or null outside any context. */
  current() {
    const s = store.getStore();
    if (s) return s;
    if (testFallback) return { tenantId: testFallback, system: false };
    return null;
  },

  /** The current tenant id. Throws when there is none (fail closed). */
  tenantId() {
    const s = this.current();
    if (!s || !s.tenantId) throw new TenancyError('No tenant for this work. Wrap it in tenancy.run(tenantId, fn).');
    return s.tenantId;
  },

  /** The current tenant id, or null (for logs and tags). */
  tenantIdOrNull() {
    const s = this.current();
    return s && s.tenantId ? s.tenantId : null;
  },

  /** Tests only: the tenant used when no context is set. */
  setTestFallback(tenantId) {
    if (process.env.NODE_ENV !== 'test') throw new TenancyError('setTestFallback is for tests only');
    testFallback = tenantId ? Number(tenantId) : null;
  }
};

module.exports = tenancy;

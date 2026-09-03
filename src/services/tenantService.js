const { getDatabase } = require('../db/database');
const gymConfig = require('../config/gymConfig');
const logger = require('../utils/logger');

class TenantService {
  constructor(db = null) {
    this.customDb = db;
  }

  get db() {
    return this.customDb || getDatabase();
  }

  /**
   * Resolves a tenant by Meta WhatsApp phone_number_id.
   * Falls back to default 'goldkraft' tenant if unmapped for backward compatibility.
   * @param {string} phoneNumberId
   * @returns {object} Tenant record
   */
  resolveTenantByPhoneNumberId(phoneNumberId) {
    if (phoneNumberId) {
      const stmt = this.db.prepare('SELECT * FROM tenants WHERE whatsapp_phone_number_id = ? LIMIT 1');
      const tenant = stmt.get(phoneNumberId);
      if (tenant) {
        return this.formatTenant(tenant);
      }
    }

    // Default fallback to Goldkraft Fitness
    return this.getTenantById('goldkraft') || {
      id: 'goldkraft',
      name: 'Goldkraft Fitness',
      status: 'active',
      timezone: 'Asia/Kolkata',
      whatsapp_phone_number_id: phoneNumberId || 'default',
      configuration: {
        gymName: gymConfig.gymName,
        pricing_monthly: 4040,
        monthly_token_budget: 500000,
        monthly_request_budget: 5000
      }
    };
  }

  /**
   * Retrieves tenant by ID
   * @param {string} tenantId
   * @returns {object|null}
   */
  getTenantById(tenantId) {
    const stmt = this.db.prepare('SELECT * FROM tenants WHERE id = ?');
    const row = stmt.get(tenantId);
    return this.formatTenant(row);
  }

  /**
   * Creates a new tenant
   */
  createTenant({ id, name, timezone = 'Asia/Kolkata', whatsappPhoneNumberId = null, configuration = {} }) {
    const now = new Date().toISOString();
    const configJson = JSON.stringify(configuration);

    const stmt = this.db.prepare(`
      INSERT INTO tenants (id, name, status, timezone, whatsapp_phone_number_id, configuration_json, created_at, updated_at)
      VALUES (?, ?, 'active', ?, ?, ?, ?, ?)
    `);

    stmt.run(id, name, timezone, whatsappPhoneNumberId, configJson, now, now);
    return this.getTenantById(id);
  }

  /**
   * Formats tenant row for application use
   */
  formatTenant(row) {
    if (!row) return null;
    let configuration = {};
    try {
      configuration = row.configuration_json ? JSON.parse(row.configuration_json) : {};
    } catch (e) {}

    return {
      id: row.id,
      name: row.name,
      status: row.status,
      timezone: row.timezone,
      whatsapp_phone_number_id: row.whatsapp_phone_number_id,
      configuration,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }
}

module.exports = new TenantService();
module.exports.TenantService = TenantService;

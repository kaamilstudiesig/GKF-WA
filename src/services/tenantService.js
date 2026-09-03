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
   * In production, returns null if the phone number is unmapped to prevent cross-tenant data pollution.
   * In development and test environments, falls back to default 'goldkraft' for convenience.
   * @param {string} phoneNumberId
   * @returns {object|null} Tenant record
   */
  resolveTenantByPhoneNumberId(phoneNumberId) {
    if (phoneNumberId) {
      const stmt = this.db.prepare('SELECT * FROM tenants WHERE whatsapp_phone_number_id = ? LIMIT 1');
      const tenant = stmt.get(phoneNumberId);
      if (tenant) {
        return this.formatTenant(tenant);
      }
      if (process.env.NODE_ENV === 'production') {
        logger.error('Unknown WhatsApp phone_number_id received in production. Silent fallback rejected.', {
          phone_number_id: phoneNumberId
        });
        return null;
      }
    }

    if (process.env.NODE_ENV === 'production') {
      logger.error('Missing or unmapped WhatsApp phone_number_id in production. Silent fallback rejected.');
      return null;
    }

    // Default fallback to Goldkraft Fitness for local dev and tests
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

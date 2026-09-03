const crypto = require('crypto');
const { getDatabase } = require('../db/database');
const logger = require('../utils/logger');

class AuthService {
  constructor(db = null) {
    this.customDb = db;
  }

  get db() {
    return this.customDb || getDatabase();
  }

  /**
   * Hashes an API key using SHA-256 for secure DB storage
   */
  hashApiKey(key) {
    if (!key) return null;
    return crypto.createHash('sha256').update(key).digest('hex');
  }

  /**
   * Generates and registers a user with a secure API key
   */
  createUser({ id = null, tenantId = 'goldkraft', email, name, role = 'staff', rawApiKey = null }) {
    const userId = id || `user_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const apiKey = rawApiKey || `gkf_${crypto.randomBytes(24).toString('hex')}`;
    const apiKeyHash = this.hashApiKey(apiKey);
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO users (id, tenant_id, email, name, role, api_key_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(userId, tenantId, email, name, role, apiKeyHash, now, now);

    return {
      user: {
        id: userId,
        tenant_id: tenantId,
        email,
        name,
        role,
        created_at: now
      },
      apiKey
    };
  }

  /**
   * Finds user by raw API key
   */
  authenticateApiKey(providedKey) {
    if (!providedKey) return null;
    const hash = this.hashApiKey(providedKey);

    const stmt = this.db.prepare('SELECT * FROM users WHERE api_key_hash = ? LIMIT 1');
    return stmt.get(hash) || null;
  }
}

module.exports = new AuthService();
module.exports.AuthService = AuthService;

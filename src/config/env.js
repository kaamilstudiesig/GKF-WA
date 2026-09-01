const dotenv = require('dotenv');
const path = require('path');

// Load environment variables from .env if present
dotenv.config();

const env = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  
  // Dashboard & API Auth
  dashboardApiKey: process.env.DASHBOARD_API_KEY || '',
  
  // Meta Cloud API
  metaAccessToken: process.env.META_ACCESS_TOKEN || '',
  metaPhoneNumberId: process.env.META_PHONE_NUMBER_ID || '',
  metaWebhookVerifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN || '',
  metaAppSecret: process.env.META_APP_SECRET || '',
  metaGraphApiVersion: process.env.META_GRAPH_API_VERSION || 'v23.0',
  
  // OpenRouter
  openRouterApiKey: process.env.OPENROUTER_API_KEY || '',
  openRouterModel: process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash',
  openRouterBaseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
  
  // SQLite Database path
  databasePath: process.env.DATABASE_PATH || path.join(__dirname, '../../data/goldkraft_leads.db'),
  
  /**
   * Validates required configuration for production environments.
   * In production (NODE_ENV === 'production'), throws an Error and halts startup if required vars are missing.
   * In development/test, logs a warning and returns false.
   */
  validateForProduction() {
    const requiredVars = [
      { key: 'META_ACCESS_TOKEN', val: this.metaAccessToken },
      { key: 'META_PHONE_NUMBER_ID', val: this.metaPhoneNumberId },
      { key: 'META_WEBHOOK_VERIFY_TOKEN', val: this.metaWebhookVerifyToken },
      { key: 'META_APP_SECRET', val: this.metaAppSecret },
      { key: 'OPENROUTER_API_KEY', val: this.openRouterApiKey },
      { key: 'DASHBOARD_API_KEY', val: this.dashboardApiKey }
    ];

    const missing = requiredVars.filter(item => !item.val).map(item => item.key);

    if (missing.length > 0) {
      const msg = `[Config Error] Missing required environment variables: ${missing.join(', ')}`;
      if (this.nodeEnv === 'production') {
        throw new Error(`CRITICAL: Server cannot start in production mode with missing configuration.\n${msg}`);
      }
      if (this.nodeEnv !== 'test') {
        console.warn(`\x1b[33m${msg}\x1b[0m`);
      }
      return false;
    }
    return true;
  }
};

module.exports = env;

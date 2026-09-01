const dotenv = require('dotenv');
const path = require('path');

// Load environment variables from .env if present
dotenv.config();

const env = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  
  // Meta Cloud API
  metaAccessToken: process.env.META_ACCESS_TOKEN || '',
  metaPhoneNumberId: process.env.META_PHONE_NUMBER_ID || '',
  metaWebhookVerifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN || 'goldkraft_verify_token_default',
  metaAppSecret: process.env.META_APP_SECRET || '',
  metaGraphApiVersion: process.env.META_GRAPH_API_VERSION || 'v23.0',
  
  // OpenRouter
  openRouterApiKey: process.env.OPENROUTER_API_KEY || '',
  openRouterModel: process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash',
  openRouterBaseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
  
  // SQLite Database path
  databasePath: process.env.DATABASE_PATH || path.join(__dirname, '../../data/goldkraft_leads.db'),
  
  // Validation helper
  validateForProduction() {
    const missing = [];
    if (!this.metaAccessToken) missing.push('META_ACCESS_TOKEN');
    if (!this.metaPhoneNumberId) missing.push('META_PHONE_NUMBER_ID');
    if (!this.metaWebhookVerifyToken) missing.push('META_WEBHOOK_VERIFY_TOKEN');
    if (!this.metaAppSecret) missing.push('META_APP_SECRET');
    if (!this.openRouterApiKey) missing.push('OPENROUTER_API_KEY');
    
    if (missing.length > 0) {
      console.warn(`[Config Warning] Missing environment variables for full Meta/OpenRouter operation: ${missing.join(', ')}`);
      return false;
    }
    return true;
  }
};

module.exports = env;

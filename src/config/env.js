const dotenv = require('dotenv');

// Tests must not pick up real keys from a developer's .env file.
if (process.env.NODE_ENV !== 'test') dotenv.config({ quiet: true });

const num = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);

const env = {
  port: num(process.env.PORT, 3000),
  nodeEnv: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),

  // Postgres. Heroku sets DATABASE_URL. Locally, leave empty to use PGlite in ./data/pglite.
  databaseUrl: process.env.DATABASE_URL || '',

  // Meta WhatsApp Cloud API
  metaAccessToken: process.env.META_ACCESS_TOKEN || '',
  metaPhoneNumberId: process.env.META_PHONE_NUMBER_ID || '',
  metaWebhookVerifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN || '',
  metaAppSecret: process.env.META_APP_SECRET || '',
  metaGraphApiVersion: process.env.META_GRAPH_API_VERSION || 'v23.0',

  // OpenRouter
  openRouterApiKey: process.env.OPENROUTER_API_KEY || '',
  openRouterModel: process.env.OPENROUTER_MODEL || 'deepseek/deepseek-v4.1-flash',
  openRouterFallbackModel: process.env.OPENROUTER_FALLBACK_MODEL || 'google/gemini-3.5-flash-lite',
  openRouterBaseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',

  // AI cost guardrails (per calendar month, UTC). When hit, leads go to staff instead.
  aiMonthlyTokenBudget: num(process.env.AI_MONTHLY_TOKEN_BUDGET, 5000000),
  aiMonthlyRequestBudget: num(process.env.AI_MONTHLY_REQUEST_BUDGET, 20000),
  // How many earlier chat messages the AI sees with each reply.
  aiHistoryMessages: num(process.env.AI_HISTORY_MESSAGES, 10),
  // Most bot replies one lead can get in 24 hours; past it the lead goes to staff (stops spam and runaway cost).
  maxBotRepliesPerLeadPerDay: num(process.env.MAX_BOT_REPLIES_PER_LEAD_PER_DAY, 30),
  // The bot stays quiet for this many hours after a staff member replies from the CRM.
  botPauseHoursAfterStaffReply: num(process.env.BOT_PAUSE_HOURS_AFTER_STAFF_REPLY, 12),

  // Gym map pin sent with the location answer. Leave empty to send the address only.
  gymLatitude: num(process.env.GYM_LATITUDE, NaN),
  gymLongitude: num(process.env.GYM_LONGITUDE, NaN),

  // Hostnames that get the staff CRM instead of the bot (comma list, matched without the port).
  crmHosts: (process.env.CRM_HOSTS || 'crm.goldkraftfitness.com,crm.localhost')
    .split(',').map(h => h.trim().toLowerCase()).filter(Boolean),

  validateForProduction() {
    const required = {
      DATABASE_URL: this.databaseUrl,
      META_ACCESS_TOKEN: this.metaAccessToken,
      META_PHONE_NUMBER_ID: this.metaPhoneNumberId,
      META_WEBHOOK_VERIFY_TOKEN: this.metaWebhookVerifyToken,
      META_APP_SECRET: this.metaAppSecret,
      OPENROUTER_API_KEY: this.openRouterApiKey
    };
    const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length === 0) return true;
    const msg = `[Config Error] Missing required environment variables: ${missing.join(', ')}`;
    if (this.nodeEnv === 'production') {
      throw new Error(`CRITICAL: Server cannot start in production mode with missing configuration.\n${msg}`);
    }
    if (this.nodeEnv !== 'test') console.warn(`\x1b[33m${msg}\x1b[0m`);
    return false;
  }
};

module.exports = env;

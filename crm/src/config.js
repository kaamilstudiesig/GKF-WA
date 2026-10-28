const path = require('path');
require('dotenv').config({ quiet: true });

const root = path.join(__dirname, '..');
const resolve = (p, fallback) => path.resolve(root, p || fallback);
const nodeEnv = process.env.NODE_ENV || 'development';

/**
 * DATABASE_URL: the bot's Postgres database (Heroku sets this), or
 * pglite://memory / pglite://./data/pglite for local dev and tests.
 */
function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (nodeEnv === 'production') throw new Error('DATABASE_URL is not set.');
  return nodeEnv === 'test' ? 'pglite://memory' : 'pglite://./data/pglite';
}

const config = {
  port: Number(process.env.PORT) || 4000,
  nodeEnv,
  databaseUrl,
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS) || 12,
  timezone: process.env.DISPLAY_TIMEZONE || 'Asia/Kolkata',
  usdToInr: Number(process.env.USD_TO_INR) || 85,
  seedUsersFile: resolve(process.env.SEED_USERS_FILE, './seed/users.example.json')
};

config.isProd = config.nodeEnv === 'production';

module.exports = config;

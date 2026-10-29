const path = require('path');
require('../../src/config/env'); // loads .env (outside tests) before anything reads process.env

const nodeEnv = process.env.NODE_ENV || 'development';

const config = {
  nodeEnv,
  isProd: nodeEnv === 'production',
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS) || 12,
  timezone: process.env.DISPLAY_TIMEZONE || 'Asia/Kolkata',
  usdToInr: Number(process.env.USD_TO_INR) || 85,
  // Starting staff accounts for `npm run crm:seed`. A relative SEED_USERS_FILE is
  // resolved from the directory you run the command in (the repo root).
  seedUsersFile: process.env.SEED_USERS_FILE
    ? path.resolve(process.env.SEED_USERS_FILE)
    : path.join(__dirname, '..', 'seed', 'users.example.json')
};

module.exports = config;

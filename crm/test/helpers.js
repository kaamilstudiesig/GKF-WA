const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { createDb } = require('../src/db');
const { createCrmApp, migrateCrm } = require('../src/index');
const { installBotFixture } = require('../dev/bot-fixture');
const { seedUsers } = require('../scripts/seed');

const SEED_FILE = path.join(__dirname, '..', 'seed', 'users.example.json');
const SEED = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')).users;
const creds = role => SEED.find(u => u.role === role);

/** Fresh in-memory PGlite db with the bot fixture, CRM tables and seeded users. */
async function freshDb({ clearMustChange = true } = {}) {
  const db = createDb('pglite://memory');
  await db.init();
  await installBotFixture(db);
  await migrateCrm(db);
  await seedUsers(db, SEED_FILE);
  if (clearMustChange) await db.query('UPDATE crm_users SET must_change_password = false');
  return db;
}

async function setup(opts = {}) {
  const db = await freshDb(opts);
  const app = createCrmApp({ db, secureCookies: false });
  const userId = async role => (await db.one('SELECT id FROM crm_users WHERE role = $1 ORDER BY id LIMIT 1', [role])).id;
  const cleanup = () => db.close();
  return { app, db, userId, cleanup };
}

/** Logs in as a role; returns { agent, csrf }. */
async function login(app, role) {
  const agent = request.agent(app);
  const { email, password } = creds(role);
  const res = await agent.post('/login').type('form').send({ email, password });
  if (res.status !== 302) throw new Error(`login failed for ${role}: ${res.status}`);
  const page = await agent.get('/account/password');
  const m = /name="_csrf" value="([^"]+)"/.exec(page.text);
  return { agent, csrf: m && m[1] };
}

module.exports = { setup, freshDb, login, creds, SEED_FILE };

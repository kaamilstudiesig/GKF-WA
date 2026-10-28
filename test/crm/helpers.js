// CRM test setup on the bot's own db module (PGlite in memory), like production.
const { db } = require('../helpers'); // sets the test env before anything from src/ loads
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { createCrmApp } = require('../../crm/src');
const { migrateAll } = require('../../src/migrate');
const { insertDemoData } = require('../../scripts/demo-data');
const { seedUsers } = require('../../crm/scripts/seed');

const SEED_FILE = path.join(__dirname, '..', '..', 'crm', 'seed', 'users.example.json');
const SEED = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')).users;
const creds = role => SEED.find(u => u.role === role);

/**
 * Fresh in-memory database: bot + CRM migrations, demo leads, seeded users.
 * db.close() drops the in-memory database, so each call starts empty.
 */
async function freshDb({ clearMustChange = true } = {}) {
  await db.close();
  await migrateAll();
  await insertDemoData(db);
  await seedUsers(db, SEED_FILE);
  if (clearMustChange) await db.query('UPDATE crm_users SET must_change_password = false');
  return db;
}

async function setup(opts = {}) {
  await freshDb(opts);
  const app = createCrmApp({ db, secureCookies: false });
  const userId = async role => (await db.one('SELECT id FROM crm_users WHERE role = $1 ORDER BY id LIMIT 1', [role])).id;
  const cleanup = () => db.close();
  return { app, db, userId, cleanup };
}

/** Logs in as a role; returns { agent, csrf }. */
async function login(app, role, host) {
  const agent = request.agent(app);
  const withHost = r => (host ? r.set('Host', host) : r);
  const { email, password } = creds(role);
  const res = await withHost(agent.post('/login')).type('form').send({ email, password });
  if (res.status !== 302) throw new Error(`login failed for ${role}: ${res.status}`);
  const page = await withHost(agent.get('/account/password'));
  const m = /name="_csrf" value="([^"]+)"/.exec(page.text);
  return { agent, csrf: m && m[1] };
}

module.exports = { setup, freshDb, login, creds, SEED_FILE };

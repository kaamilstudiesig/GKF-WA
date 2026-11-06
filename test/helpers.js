// Shared setup for tests. Must be required before anything from src/.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'pglite://memory';
process.env.META_APP_SECRET = 'test_app_secret';
process.env.META_WEBHOOK_VERIFY_TOKEN = 'test_verify_token';
process.env.META_PHONE_NUMBER_ID = 'PNID_TEST';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';
process.env.TENANT_SECRETS_KEY = Buffer.alloc(32, 7).toString('base64'); // test-only key

// K8: code that tests call directly (repositories, services) runs as tenant 1.
// Entry points (webhooks, workers, CRM) set their own tenant; test/tenancy.test.js
// checks those with a second tenant, where this fallback would show up as a leak.
require('../src/tenancy/context').setTestFallback(1);

const crypto = require('crypto');
const request = require('supertest');
const db = require('../src/db');
const createApp = require('../src/app');
const webhookWorker = require('../src/workers/webhookWorker');
const outboundWorker = require('../src/workers/outboundWorker');

let app;
const getApp = () => (app ||= createApp());

const sign = body => `sha256=${crypto.createHmac('sha256', process.env.META_APP_SECRET).update(Buffer.from(body)).digest('hex')}`;

let seq = 0;
/** A Meta webhook payload with one or more inbound messages. */
function inbound(messages, { phoneNumberId = 'PNID_TEST' } = {}) {
  const list = Array.isArray(messages) ? messages : [messages];
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WABA',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { phone_number_id: phoneNumberId },
          // m.userId = Meta's business-scoped user ID; m.from = null means the phone is hidden (username user).
          contacts: list.map(m => {
            const c = { profile: { name: m.name || 'Test Lead' } };
            if (m.from) c.wa_id = m.from;
            if (m.userId) c.user_id = m.userId;
            if (m.username) c.profile.username = m.username;
            return c;
          }),
          messages: list.map(m => {
            const msg = {
              id: m.id || `wamid.test_${++seq}_${Date.now()}`,
              timestamp: String(Math.floor((m.at || Date.now()) / 1000)), type: m.type || 'text'
            };
            if (m.from) msg.from = m.from;
            if (m.userId) msg.from_user_id = m.userId;
            if (msg.type === 'text') msg.text = { body: m.text };
            if (m.referral) msg.referral = m.referral;
            if (m.extra) Object.assign(msg, m.extra);
            return msg;
          })
        }
      }]
    }]
  };
}

async function postWebhook(payload) {
  const body = JSON.stringify(payload);
  return request(getApp()).post('/webhook').set('Content-Type', 'application/json').set('X-Hub-Signature-256', sign(body)).send(body);
}

/** Runs both queues until nothing is left. */
async function drainAll() {
  for (let i = 0; i < 5; i++) {
    const n = (await webhookWorker.drain()) + (await outboundWorker.drain());
    if (!n) break;
  }
}

/** Sends a WhatsApp text from `from` and processes it end to end. */
async function converse(from, text, opts = {}) {
  const res = await postWebhook(inbound({ from, text, ...opts }));
  if (res.status !== 200) throw new Error(`webhook returned ${res.status}`);
  await drainAll();
}

const registry = require('../src/tenancy/registry');

/** Empties every table; removes tenants other than 1. */
async function reset() {
  await db.truncateAll();
  const { ALL_TENANT_TABLES } = require('../src/db/platformMigrations');
  await require('../src/tenancy/context').runAsSystem(async () => {
    await db.query('DELETE FROM zoho_cursors');
    for (const t of [...ALL_TENANT_TABLES].reverse()) await db.query(`DELETE FROM ${t} WHERE tenant_id <> 1`); // children first
    await db.query('DELETE FROM tenants WHERE id <> 1');
  });
  registry.resetForTests();
}

module.exports = { db, getApp, sign, inbound, postWebhook, drainAll, converse, reset, request };

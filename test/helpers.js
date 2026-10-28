// Shared setup for tests. Must be required before anything from src/.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'pglite://memory';
process.env.META_APP_SECRET = 'test_app_secret';
process.env.META_WEBHOOK_VERIFY_TOKEN = 'test_verify_token';
process.env.META_PHONE_NUMBER_ID = 'PNID_TEST';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

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
          contacts: list.map(m => ({ wa_id: m.from, profile: { name: m.name || 'Test Lead' } })),
          messages: list.map(m => {
            const msg = {
              from: m.from, id: m.id || `wamid.test_${++seq}_${Date.now()}`,
              timestamp: String(Math.floor((m.at || Date.now()) / 1000)), type: m.type || 'text'
            };
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

const reset = () => db.truncateAll();

module.exports = { db, getApp, sign, inbound, postWebhook, drainAll, converse, reset, request };

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Set environment for testing
process.env.NODE_ENV = 'test';
process.env.META_WEBHOOK_VERIFY_TOKEN = 'test_verify_token_123';
process.env.META_APP_SECRET = 'test_secret_abc456';
process.env.DATABASE_PATH = path.join(__dirname, '../data/test_webhook.db');

const createApp = require('../src/app');
const { getDatabase, closeDatabase } = require('../src/db/database');
const leadRepository = require('../src/db/leadRepository');

describe('Meta WhatsApp Webhook Integration', () => {
  let app;
  const testSecret = 'test_secret_abc456';
  const verifyToken = 'test_verify_token_123';

  before(() => {
    // Ensure clean test DB
    if (fs.existsSync(process.env.DATABASE_PATH)) {
      fs.unlinkSync(process.env.DATABASE_PATH);
    }
    getDatabase(process.env.DATABASE_PATH);
    app = createApp();
  });

  after(() => {
    closeDatabase();
    if (fs.existsSync(process.env.DATABASE_PATH)) {
      try { fs.unlinkSync(process.env.DATABASE_PATH); } catch (e) {}
    }
  });

  function generateSignature(payloadObj, secret = testSecret) {
    const jsonStr = JSON.stringify(payloadObj);
    const hash = crypto.createHmac('sha256', secret).update(Buffer.from(jsonStr)).digest('hex');
    return `sha256=${hash}`;
  }

  describe('GET /webhook (Verification Handshake)', () => {
    test('returns 200 and challenge string when mode and token match', async () => {
      const challenge = 'random_meta_challenge_str_98765';
      const response = await request(app)
        .get('/webhook')
        .query({
          'hub.mode': 'subscribe',
          'hub.verify_token': verifyToken,
          'hub.challenge': challenge
        });

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.text, challenge);
    });

    test('returns 403 when verify_token does not match', async () => {
      const response = await request(app)
        .get('/webhook')
        .query({
          'hub.mode': 'subscribe',
          'hub.verify_token': 'wrong_token',
          'hub.challenge': '12345'
        });

      assert.strictEqual(response.status, 403);
    });

    test('returns 400 when hub parameters are missing', async () => {
      const response = await request(app).get('/webhook');
      assert.strictEqual(response.status, 400);
    });
  });

  describe('POST /webhook (Signature Verification & Inbound Ingestion)', () => {
    test('rejects request with 401 when signature header is missing and secret is configured', async () => {
      const payload = {
        object: 'whatsapp_business_account',
        entry: []
      };

      const response = await request(app)
        .post('/webhook')
        .send(payload);

      assert.strictEqual(response.status, 401);
    });

    test('rejects request with 403 when signature is invalid', async () => {
      const payload = {
        object: 'whatsapp_business_account',
        entry: []
      };

      const response = await request(app)
        .post('/webhook')
        .set('X-Hub-Signature-256', 'sha256=invalid_hex_hash_0000000000000000000000000000000000000000000000000000000000000000')
        .send(payload);

      assert.strictEqual(response.status, 403);
    });

    test('accepts valid status updates payload and acknowledges with 200 without creating messages', async () => {
      const payload = {
        object: 'whatsapp_business_account',
        entry: [{
          id: 'WHATSAPP_BUSINESS_ACCOUNT_ID',
          changes: [{
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '919876543210', phone_number_id: '123456' },
              statuses: [{
                id: 'wamid.HBgLMTIzNDU2Nzg5MA==',
                status: 'delivered',
                timestamp: '1725200000',
                recipient_id: '919876543210'
              }]
            },
            field: 'messages'
          }]
        }]
      };

      const signature = generateSignature(payload);
      const response = await request(app)
        .post('/webhook')
        .set('X-Hub-Signature-256', signature)
        .send(payload);

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.status, 'success');
    });

    test('processes inbound text message, creates lead, saves history, and deduplicates retry', async () => {
      const messageId = `wamid.test_${Date.now()}_dedup`;
      const waId = '919988776655';
      const senderName = 'Arjun Sharma';
      const userText = 'Hi! What are your monthly membership prices for Goldkraft?';

      const payload = {
        object: 'whatsapp_business_account',
        entry: [{
          id: 'WABA_123',
          changes: [{
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '918000000000', phone_number_id: 'PHONE_ID_1' },
              contacts: [{ profile: { name: senderName }, wa_id: waId }],
              messages: [{
                from: waId,
                id: messageId,
                timestamp: Math.floor(Date.now() / 1000).toString(),
                text: { body: userText },
                type: 'text'
              }]
            },
            field: 'messages'
          }]
        }]
      };

      const signature = generateSignature(payload);

      // First webhook post
      const response1 = await request(app)
        .post('/webhook')
        .set('X-Hub-Signature-256', signature)
        .send(payload);

      assert.strictEqual(response1.status, 200);

      // Verify Lead was created in DB
      const lead = leadRepository.findByWaId(waId);
      assert.ok(lead, 'Lead should exist');
      assert.strictEqual(lead.wa_id, waId);
      assert.strictEqual(lead.display_name, senderName);
      assert.strictEqual(lead.window_open, true);

      // Verify Message History
      const history = leadRepository.getConversationHistory(waId);
      assert.ok(history.length >= 2, 'Should contain inbound and outbound messages');
      assert.strictEqual(history[0].text, userText);

      // Second webhook post with SAME message ID (Meta retry simulation)
      const response2 = await request(app)
        .post('/webhook')
        .set('X-Hub-Signature-256', signature)
        .send(payload);

      assert.strictEqual(response2.status, 200);

      // Verify no duplicate inbound message was added
      const historyAfterRetry = leadRepository.getConversationHistory(waId);
      assert.strictEqual(historyAfterRetry.length, history.length, 'Duplicate message should be skipped');
    });

    test('gracefully handles non-text media messages (e.g. image)', async () => {
      const messageId = `wamid.image_${Date.now()}`;
      const waId = '919911223344';

      const payload = {
        object: 'whatsapp_business_account',
        entry: [{
          id: 'WABA_123',
          changes: [{
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '918000000000', phone_number_id: 'PHONE_ID_1' },
              contacts: [{ profile: { name: 'Priya Patel' }, wa_id: waId }],
              messages: [{
                from: waId,
                id: messageId,
                timestamp: Math.floor(Date.now() / 1000).toString(),
                image: { id: 'IMG_9999', mime_type: 'image/jpeg' },
                type: 'image'
              }]
            },
            field: 'messages'
          }]
        }]
      };

      const signature = generateSignature(payload);
      const response = await request(app)
        .post('/webhook')
        .set('X-Hub-Signature-256', signature)
        .send(payload);

      assert.strictEqual(response.status, 200);

      const history = leadRepository.getConversationHistory(waId);
      assert.ok(history.some(m => m.text.includes('[Received IMAGE message]')));
    });
  });
});

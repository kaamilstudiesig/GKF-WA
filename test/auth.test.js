const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const fs = require('fs');
const path = require('path');

const testApiKey = 'test_secret_dashboard_key_777';

process.env.NODE_ENV = 'test';
process.env.DASHBOARD_API_KEY = testApiKey;
process.env.DATABASE_PATH = path.join(__dirname, '../data/test_auth.db');

const createApp = require('../src/app');
const { getDatabase, closeDatabase } = require('../src/db/database');
const leadRepository = require('../src/db/leadRepository');

describe('Dashboard Authentication & Security Middleware', () => {
  let app;

  before(() => {
    if (fs.existsSync(process.env.DATABASE_PATH)) {
      fs.unlinkSync(process.env.DATABASE_PATH);
    }
    getDatabase(process.env.DATABASE_PATH);
    app = createApp();

    // Create a dummy lead
    leadRepository.getOrCreateLead('919800112233', 'Test User', new Date().toISOString());
  });

  after(() => {
    closeDatabase();
    if (fs.existsSync(process.env.DATABASE_PATH)) {
      try { fs.unlinkSync(process.env.DATABASE_PATH); } catch (e) {}
    }
  });

  describe('Public Endpoints', () => {
    test('GET /health is public and returns 200 with status ok and uptime', async () => {
      const res = await request(app).get('/health');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.status, 'ok');
      assert.ok(typeof res.body.uptime_seconds === 'number');
    });

    test('GET / is public and returns 200 with facility details', async () => {
      const res = await request(app).get('/');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.service, 'Goldkraft Fitness WhatsApp AI Lead Manager');
      assert.ok(res.body.facility.location.includes('JP Nagar') || res.body.facility.location.includes('J.P. Nagar'));
    });
  });

  describe('Protected /leads Endpoints', () => {
    test('GET /leads returns 401 when Authorization header is missing', async () => {
      const res = await request(app).get('/leads');
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.success, false);
      assert.ok(res.body.error.includes('Unauthorized'));
    });

    test('GET /leads returns 401 when Bearer token is incorrect', async () => {
      const res = await request(app)
        .get('/leads')
        .set('Authorization', 'Bearer invalid_wrong_token');
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.success, false);
    });

    test('GET /leads returns 401 when x-api-key is incorrect', async () => {
      const res = await request(app)
        .get('/leads')
        .set('x-api-key', 'invalid_api_key_123');
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.success, false);
    });

    test('GET /leads returns 200 when valid Authorization Bearer token is provided', async () => {
      const res = await request(app)
        .get('/leads')
        .set('Authorization', `Bearer ${testApiKey}`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.ok(Array.isArray(res.body.data));
    });

    test('GET /leads returns 200 when valid x-api-key header is provided', async () => {
      const res = await request(app)
        .get('/leads')
        .set('x-api-key', testApiKey);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
    });

    test('GET /leads/:wa_id returns 401 without auth', async () => {
      const res = await request(app).get('/leads/919800112233');
      assert.strictEqual(res.status, 401);
    });

    test('GET /leads/:wa_id returns 200 with valid Bearer auth', async () => {
      const res = await request(app)
        .get('/leads/919800112233')
        .set('Authorization', `Bearer ${testApiKey}`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.data.wa_id, '919800112233');
    });
  });
});

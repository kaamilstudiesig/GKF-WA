const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const createApp = require('../src/app');
const { getDatabase, closeDatabase } = require('../src/db/database');

describe('WhatsApp Demo UI & Static Assets', () => {
  let app;

  before(() => {
    getDatabase();
    app = createApp();
  });

  after(() => {
    closeDatabase();
  });

  test('GET /demo returns 200 and serves WhatsApp Demo HTML page', async () => {
    const res = await request(app).get('/demo');
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers['content-type'].includes('text/html'));
    assert.ok(res.text.includes('Goldkraft Fitness &bull; WhatsApp AI Assistant'));
    assert.ok(res.text.includes('phone-frame'));
    assert.ok(res.text.includes('CRM Lead Summary'));
    assert.ok(res.text.includes('chat-input-field'));
  });

  test('GET /css/style.css returns 200 and serves mobile-first CSS stylesheet', async () => {
    const res = await request(app).get('/css/style.css');
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers['content-type'].includes('text/css'));
    assert.ok(res.text.includes('--device-width: 390px;'));
    assert.ok(res.text.includes('.phone-frame'));
    assert.ok(res.text.includes('.msg-bubble'));
  });

  test('GET /js/app.js returns 200 and serves demo client logic', async () => {
    const res = await request(app).get('/js/app.js');
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers['content-type'].includes('javascript'));
    assert.ok(res.text.includes('PREPARED_SCRIPT'));
    assert.ok(res.text.includes('getDeterministicReply'));
    assert.ok(res.text.includes('Rahul Sharma'));
  });

  test('GET / continues to return facility JSON for API clients', async () => {
    const res = await request(app).get('/');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.service, 'Goldkraft Fitness WhatsApp AI Lead Manager');
    assert.strictEqual(res.body.demo_url, '/demo');
  });
});

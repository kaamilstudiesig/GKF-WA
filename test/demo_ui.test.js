const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const createApp = require('../src/app');
const { getDatabase, closeDatabase } = require('../src/db/database');

const demoService = require('../src/services/demoService');

describe('WhatsApp Demo UI & Static Assets', () => {
  let app;
  const UI_TEST_WA_ID = 'demo_ui_919876543210';
  let origDemoWaId;

  before(() => {
    origDemoWaId = demoService.demoWaId;
    demoService.demoWaId = UI_TEST_WA_ID;
    getDatabase();
    app = createApp();
  });

  after(() => {
    try {
      const db = getDatabase();
      db.prepare('DELETE FROM messages WHERE wa_id = ?').run(UI_TEST_WA_ID);
      db.prepare('DELETE FROM outbound_messages WHERE wa_id = ?').run(UI_TEST_WA_ID);
      db.prepare('DELETE FROM handoffs WHERE wa_id = ?').run(UI_TEST_WA_ID);
      db.prepare('DELETE FROM leads WHERE wa_id = ?').run(UI_TEST_WA_ID);
    } catch (e) {}
    demoService.demoWaId = origDemoWaId;
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

  test('GET /js/app.js returns 200 and serves backend-integrated demo client logic', async () => {
    const res = await request(app).get('/js/app.js');
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers['content-type'].includes('javascript'));
    assert.ok(res.text.includes('/demo/chat'));
    assert.ok(res.text.includes('/demo/conversation'));
    assert.ok(res.text.includes('/demo/reset'));
    assert.ok(res.text.includes('AUTO_PLAY_TURNS'));
    assert.ok(res.text.includes('Rahul Sharma'));
  });

  test('GET / continues to return facility JSON for API clients', async () => {
    const res = await request(app).get('/');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.service, 'Goldkraft Fitness WhatsApp AI Lead Manager');
    assert.strictEqual(res.body.demo_url, '/demo');
  });

  test('POST /demo/chat endpoint returns 200 and processes valid messages', async () => {
    const res = await request(app)
      .post('/demo/chat')
      .send({ message: 'What are your gym operating hours?' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.ok(typeof res.body.reply === 'string' && res.body.reply.length > 0);
    assert.ok(res.body.lead);
    assert.strictEqual(res.body.lead.name, 'Rahul Sharma');
  });

  test('POST /demo/chat returns 400 when message is missing or empty', async () => {
    const res = await request(app)
      .post('/demo/chat')
      .send({});
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.success, false);
  });

  test('GET /demo/conversation returns 200 with message history and lead profile', async () => {
    const res = await request(app).get('/demo/conversation');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.ok(Array.isArray(res.body.messages));
    assert.ok(res.body.lead);
    assert.strictEqual(res.body.lead.name, 'Rahul Sharma');
  });

  test('GET /demo/lead returns 200 with current lead state', async () => {
    const res = await request(app).get('/demo/lead');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.ok(res.body.data);
    assert.strictEqual(res.body.data.name, 'Rahul Sharma');
  });

  test('POST /demo/reset returns 200 and resets conversation and lead state', async () => {
    const res = await request(app).post('/demo/reset');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.ok(res.body.message.includes('reset'));
    assert.ok(res.body.lead);
    assert.strictEqual(res.body.lead.status, 'new');
  });
});

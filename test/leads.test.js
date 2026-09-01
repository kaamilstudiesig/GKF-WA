const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const fs = require('fs');
const path = require('path');

process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = path.join(__dirname, '../data/test_leads.db');

const createApp = require('../src/app');
const { getDatabase, closeDatabase } = require('../src/db/database');
const leadRepository = require('../src/db/leadRepository');

describe('Leads CRM & Query API', () => {
  let app;

  before(() => {
    if (fs.existsSync(process.env.DATABASE_PATH)) {
      fs.unlinkSync(process.env.DATABASE_PATH);
    }
    getDatabase(process.env.DATABASE_PATH);
    app = createApp();

    // Seed test leads
    const now = Date.now();
    const twentyFiveHoursAgo = new Date(now - 25 * 60 * 60 * 1000).toISOString();
    const oneHourAgo = new Date(now - 1 * 60 * 60 * 1000).toISOString();

    // Lead 1: Open 24h window, qualified
    const lead1 = leadRepository.getOrCreateLead('919100000001', 'Rahul Dravid', oneHourAgo);
    leadRepository.updateLead('919100000001', {
      status: 'qualified',
      interest: 'Quarterly Elite Membership',
      notes: 'Interested in strength & hypertrophy'
    });
    leadRepository.saveMessage({
      messageId: 'msg_lead1_1',
      waId: '919100000001',
      direction: 'in',
      text: 'Tell me about your Quarterly Elite program',
      timestamp: oneHourAgo
    });

    // Lead 2: Closed 24h window, needs human
    const lead2 = leadRepository.getOrCreateLead('919100000002', 'Ananya Roy', twentyFiveHoursAgo);
    leadRepository.updateLead('919100000002', {
      status: 'hot',
      interest: 'Trial Booking',
      needs_human: 1,
      handoff_reason: 'ready_to_book',
      last_inbound_message_at: twentyFiveHoursAgo
    });

    // Lead 3: Open window, new
    leadRepository.getOrCreateLead('919100000003', 'Karan Mehta', oneHourAgo);
  });

  after(() => {
    closeDatabase();
    if (fs.existsSync(process.env.DATABASE_PATH)) {
      try { fs.unlinkSync(process.env.DATABASE_PATH); } catch (e) {}
    }
  });

  describe('24-Hour Window Calculation', () => {
    test('computes window_open = true for messages within 24h', () => {
      const lead = leadRepository.findByWaId('919100000001');
      assert.strictEqual(lead.window_open, true);
    });

    test('computes window_open = false for messages older than 24h', () => {
      const lead = leadRepository.findByWaId('919100000002');
      assert.strictEqual(lead.window_open, false);
    });
  });

  describe('GET /leads (List & Filter)', () => {
    test('lists all leads with default pagination', async () => {
      const res = await request(app).get('/leads');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.pagination.total, 3);
      assert.strictEqual(res.body.data.length, 3);
    });

    test('filters leads by status', async () => {
      const res = await request(app).get('/leads?status=qualified');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.data.length, 1);
      assert.strictEqual(res.body.data[0].wa_id, '919100000001');
    });

    test('filters leads by needs_human=true', async () => {
      const res = await request(app).get('/leads?needs_human=true');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.data.length, 1);
      assert.strictEqual(res.body.data[0].wa_id, '919100000002');
      assert.strictEqual(res.body.data[0].handoff_reason, 'ready_to_book');
    });

    test('filters leads by needs_human=false', async () => {
      const res = await request(app).get('/leads?needs_human=false');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.data.length, 2);
    });
  });

  describe('GET /leads/:wa_id (Detail & Conversation History)', () => {
    test('fetches full details and conversation history for valid wa_id', async () => {
      const res = await request(app).get('/leads/919100000001');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.data.display_name, 'Rahul Dravid');
      assert.strictEqual(res.body.data.interest, 'Quarterly Elite Membership');
      assert.ok(Array.isArray(res.body.data.conversation_history));
      assert.strictEqual(res.body.data.conversation_history.length, 1);
      assert.strictEqual(res.body.data.conversation_history[0].text, 'Tell me about your Quarterly Elite program');
    });

    test('returns 404 for non-existent lead wa_id', async () => {
      const res = await request(app).get('/leads/919999999999');
      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.body.success, false);
    });
  });
});

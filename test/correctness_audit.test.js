const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const fs = require('fs');
const path = require('path');

const testDbPath = path.join(__dirname, '../data/test_correctness_audit.db');
const testKey = 'audit_secret_master_key_123';

process.env.NODE_ENV = 'test';
process.env.DASHBOARD_API_KEY = testKey;
process.env.DATABASE_PATH = testDbPath;

const createApp = require('../src/app');
const { getDatabase, closeDatabase } = require('../src/db/database');
const leadRepository = require('../src/db/leadRepository');
const eventRepository = require('../src/db/eventRepository');
const handoffRepository = require('../src/db/handoffRepository');
const auditService = require('../src/services/auditService');
const tenantService = require('../src/services/tenantService');
const aiCostTracker = require('../src/services/aiCostTracker');
const aiService = require('../src/services/aiService');
const deterministicRouter = require('../src/services/deterministicRouter');
const gymConfig = require('../src/config/gymConfig');
const logger = require('../src/utils/logger');

describe('Production Correctness Audit Verification & Regression Tests', () => {
  let app;

  before(() => {
    closeDatabase();
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch (e) {}
    }
    getDatabase(testDbPath);
    app = createApp();

    // Create 2 test tenants
    tenantService.createTenant({
      id: 'tenant_omega',
      name: 'Omega Strength Club',
      whatsappPhoneNumberId: 'PHONE_OMEGA_999',
      configuration: {
        gymName: 'Omega Strength Club',
        location: 'Koramangala, Bengaluru',
        pricing_monthly: 3500
      }
    });

    tenantService.createTenant({
      id: 'tenant_sigma',
      name: 'Sigma Cross Club',
      whatsappPhoneNumberId: 'PHONE_SIGMA_888',
      configuration: {
        gymName: 'Sigma Cross Club',
        location: 'Indiranagar, Bengaluru',
        pricing_monthly: 5000
      }
    });
  });

  after(() => {
    closeDatabase();
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch (e) {}
    }
  });

  describe('P0.1 & P0.2: Composite Primary Key (tenant_id, wa_id) & Isolation', () => {
    test('same WhatsApp phone number creates separate, isolated leads in different tenants', () => {
      const sharedWaId = '919876543210';
      const now = new Date().toISOString();

      const leadOmega = leadRepository.getOrCreateLead(sharedWaId, 'Omega John', now, 'tenant_omega');
      const leadSigma = leadRepository.getOrCreateLead(sharedWaId, 'Sigma John', now, 'tenant_sigma');

      assert.strictEqual(leadOmega.tenant_id, 'tenant_omega');
      assert.strictEqual(leadOmega.display_name, 'Omega John');

      assert.strictEqual(leadSigma.tenant_id, 'tenant_sigma');
      assert.strictEqual(leadSigma.display_name, 'Sigma John');

      // Update lead in Omega must NOT affect Sigma
      leadRepository.updateLead(sharedWaId, { status: 'hot', notes: 'Omega private notes' }, 'tenant_omega');

      const reloadedOmega = leadRepository.findByWaId(sharedWaId, 'tenant_omega');
      const reloadedSigma = leadRepository.findByWaId(sharedWaId, 'tenant_sigma');

      assert.strictEqual(reloadedOmega.status, 'hot');
      assert.strictEqual(reloadedOmega.notes, 'Omega private notes');

      assert.strictEqual(reloadedSigma.status, 'new');
      assert.strictEqual(reloadedSigma.notes, null);
    });

    test('messages are strictly scoped by composite (tenant_id, wa_id)', () => {
      const sharedWaId = '919876543210';

      leadRepository.saveMessage({
        messageId: 'msg_omega_001',
        waId: sharedWaId,
        direction: 'in',
        text: 'Omega secret message',
        tenantId: 'tenant_omega'
      });

      leadRepository.saveMessage({
        messageId: 'msg_sigma_001',
        waId: sharedWaId,
        direction: 'in',
        text: 'Sigma secret message',
        tenantId: 'tenant_sigma'
      });

      const historyOmega = leadRepository.getConversationHistory(sharedWaId, 50, 'tenant_omega');
      const historySigma = leadRepository.getConversationHistory(sharedWaId, 50, 'tenant_sigma');

      assert.strictEqual(historyOmega.length, 1);
      assert.strictEqual(historyOmega[0].text, 'Omega secret message');

      assert.strictEqual(historySigma.length, 1);
      assert.strictEqual(historySigma[0].text, 'Sigma secret message');
    });
  });

  describe('P0.3: No Silent Fallback for Unknown WhatsApp phone_number_id in Production', () => {
    test('rejects unmapped phone_number_id when NODE_ENV is production', () => {
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      try {
        const resolved = tenantService.resolveTenantByPhoneNumberId('UNKNOWN_PHONE_ID_666');
        assert.strictEqual(resolved, null, 'Production must reject unmapped phone numbers');
      } finally {
        process.env.NODE_ENV = origEnv;
      }
    });

    test('permits fallback to goldkraft only in non-production environments', () => {
      assert.strictEqual(process.env.NODE_ENV, 'test');
      const resolved = tenantService.resolveTenantByPhoneNumberId('UNKNOWN_IN_TEST');
      assert.ok(resolved);
      assert.strictEqual(resolved.id, 'goldkraft');
    });
  });

  describe('P0.4: Tenant-Specific AI Configuration and Business Facts', () => {
    test('system prompt dynamically incorporates tenant name, location, and pricing', () => {
      const tenantConfig = {
        gymName: 'Apex Bouldering & Fitness',
        location: 'Whitefield, Bengaluru',
        pricing_monthly: 2999,
        brandVoice: 'Hyper-focused, climbing community tone'
      };

      const prompt = gymConfig.getSystemPrompt(tenantConfig);
      assert.ok(prompt.includes('Apex Bouldering & Fitness'));
      assert.ok(prompt.includes('Whitefield, Bengaluru'));
      assert.ok(prompt.includes('₹2999/mo'));
      assert.ok(prompt.includes('Hyper-focused, climbing community tone'));
      assert.strictEqual(prompt.includes('Goldkraft Fitness'), false);
    });

    test('deterministic router uses tenant gymName and details', () => {
      const tenantConfig = {
        gymName: 'Titan CrossFit',
        location: 'HSR Layout Sector 2',
        facility: { location: 'HSR Layout Sector 2', parking: 'Valet' }
      };

      const hoursRoute = deterministicRouter.routeMessage('opening hours', tenantConfig, { wa_id: '918888888888' });
      assert.ok(hoursRoute.replyText.includes('Titan CrossFit operating hours:'));

      const staffRoute = deterministicRouter.routeMessage('talk to human coach', tenantConfig, { wa_id: '918888888888' });
      assert.ok(staffRoute.replyText.includes('Titan CrossFit'));
    });
  });

  describe('P0.6 & P0.7: Model-Aware AI Cost Accounting & Follow-up Call Accounting', () => {
    test('calculates different INR costs based on model pricing tiers', () => {
      const db = getDatabase(testDbPath);

      aiCostTracker.recordUsage({
        tenantId: 'tenant_omega',
        requestId: 'req_model_flash',
        model: 'google/gemini-2.5-flash',
        inputTokens: 1000000,
        outputTokens: 1000000
      });

      aiCostTracker.recordUsage({
        tenantId: 'tenant_omega',
        requestId: 'req_model_free',
        model: 'openrouter/free',
        inputTokens: 1000000,
        outputTokens: 1000000
      });

      const rowFlash = db.prepare('SELECT estimated_cost_inr FROM ai_usage WHERE request_id = ?').get('req_model_flash');
      const rowFree = db.prepare('SELECT estimated_cost_inr FROM ai_usage WHERE request_id = ?').get('req_model_free');

      // Gemini 2.5 Flash: ($0.10 + $0.40) * 85 = 42.50 INR
      assert.strictEqual(rowFlash.estimated_cost_inr, 42.5);
      // openrouter/free: $0 cost
      assert.strictEqual(rowFree.estimated_cost_inr, 0);
    });
  });

  describe('P0.9: Queue Locking Concurrency Safety', () => {
    test('atomic event claim prevents double-locking when updated concurrently', () => {
      const { id } = eventRepository.recordEvent({
        eventKey: 'concurrent_test_event_001',
        tenantId: 'tenant_omega',
        payload: { test: true }
      });
      assert.ok(id);

      const event1 = eventRepository.getNextPendingEvent(60);
      assert.ok(event1);
      assert.strictEqual(event1.id, id);

      // Second worker attempting to fetch right away should get null (already locked)
      const event2 = eventRepository.getNextPendingEvent(60);
      assert.strictEqual(event2, null);
    });
  });

  describe('P1.12: Handoff Records Persistence in handoffs Table', () => {
    test('persists record in handoffs table when needs_human is triggered', () => {
      const waId = '917777777777';
      const lead = leadRepository.getOrCreateLead(waId, 'Handoff User', new Date().toISOString(), 'tenant_omega');

      aiService.applyLeadUpdates(lead, {
        needs_human: true,
        handoff_reason: 'price_negotiation',
        summary: 'User asked for student discount'
      }, 'tenant_omega');

      const handoffs = handoffRepository.listHandoffs('tenant_omega', 'pending');
      assert.ok(handoffs.length > 0);
      const h = handoffs.find(item => item.wa_id === waId);
      assert.ok(h);
      assert.strictEqual(h.reason, 'price_negotiation');
      assert.strictEqual(h.status, 'pending');
    });
  });

  describe('P1.13: PATCH /leads/:wa_id Endpoint & Audit Logging', () => {
    test('authorized staff can update lead status and records audit log', async () => {
      const waId = '916666666666';
      leadRepository.getOrCreateLead(waId, 'Lead To Convert', new Date().toISOString(), 'tenant_omega');

      const res = await request(app)
        .patch(`/leads/${waId}`)
        .set('Authorization', `Bearer ${testKey}`)
        .set('x-tenant-id', 'tenant_omega')
        .send({
          status: 'converted',
          notes: 'Customer signed up for 1-year pinnacle plan'
        });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.data.status, 'converted');

      // Verify audit log was recorded
      const logs = auditService.listAuditLogs('tenant_omega', 5);
      assert.ok(logs.length > 0);
      const audit = logs.find(l => l.target_id === waId);
      assert.ok(audit);
      assert.strictEqual(audit.action, 'lead_update');
      assert.strictEqual(audit.changes.after.status, 'converted');
    });

    test('resolving needs_human closes active handoff', async () => {
      const waId = '917777777777';

      const res = await request(app)
        .patch(`/leads/${waId}`)
        .set('Authorization', `Bearer ${testKey}`)
        .set('x-tenant-id', 'tenant_omega')
        .send({
          needs_human: false
        });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.data.needs_human, false);

      const pendingHandoffs = handoffRepository.listHandoffs('tenant_omega', 'pending');
      const resolved = pendingHandoffs.find(h => h.wa_id === waId);
      assert.strictEqual(resolved, undefined, 'Handoff should no longer be pending');
    });
  });

  describe('P1.18: Readiness Endpoint During Shutdown', () => {
    test('/health/ready returns 503 when app is marked as shutting down', async () => {
      // Temporarily mark shutdown flag
      app.locals.isShuttingDown = true;
      try {
        const res = await request(app).get('/health/ready');
        assert.strictEqual(res.status, 503);
        assert.strictEqual(res.body.status, 'not_ready');
        assert.strictEqual(res.body.database, 'shutting_down');
      } finally {
        app.locals.isShuttingDown = false;
      }

      // Normal state returns 200
      const readyRes = await request(app).get('/health/ready');
      assert.strictEqual(readyRes.status, 200);
    });
  });

  describe('P1.19: Production Logging Sanitization', () => {
    test('sanitizes tokens, secrets, authorization headers, and phone numbers', () => {
      const rawMeta = {
        wa_id: '919876543210',
        recipient_id: '918765432109',
        authorization: 'Bearer secret_token_xyz',
        api_key: 'super_secret_key',
        nested: {
          token: 'jwt_secret_token',
          safe_val: 123
        }
      };

      const clean = logger.sanitizeMeta(rawMeta, 'info');

      assert.strictEqual(clean.wa_id, '91*****3210');
      assert.strictEqual(clean.recipient_id, '91*****2109');
      assert.strictEqual(clean.authorization, '[REDACTED SECRET]');
      assert.strictEqual(clean.api_key, '[REDACTED SECRET]');
      assert.strictEqual(clean.nested.token, '[REDACTED SECRET]');
      assert.strictEqual(clean.nested.safe_val, 123);
    });
  });
});

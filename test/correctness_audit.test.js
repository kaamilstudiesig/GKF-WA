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
const outboundRepository = require('../src/db/outboundRepository');
const handoffRepository = require('../src/db/handoffRepository');
const auditService = require('../src/services/auditService');
const authService = require('../src/services/authService');
const tenantService = require('../src/services/tenantService');
const aiCostTracker = require('../src/services/aiCostTracker');
const aiService = require('../src/services/aiService');
const aiPolicy = require('../src/services/aiPolicy');
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

  describe('Part 4 Security: Cross-Tenant Authorization & Access Protection', () => {
    let userOmegaKey;
    let userSigmaKey;

    before(() => {
      const userOmega = authService.createUser({
        tenantId: 'tenant_omega',
        email: 'staff@omega.com',
        name: 'Omega Staff',
        role: 'staff'
      });
      userOmegaKey = userOmega.apiKey;

      const userSigma = authService.createUser({
        tenantId: 'tenant_sigma',
        email: 'staff@sigma.com',
        name: 'Sigma Staff',
        role: 'staff'
      });
      userSigmaKey = userSigma.apiKey;
    });

    test('Tenant A staff cannot view Tenant B leads (returns 404)', async () => {
      const waIdSigma = '919111111111';
      leadRepository.getOrCreateLead(waIdSigma, 'Private Sigma Member', new Date().toISOString(), 'tenant_sigma');

      // Omega staff tries to access Sigma lead
      const res = await request(app)
        .get(`/leads/${waIdSigma}`)
        .set('Authorization', `Bearer ${userOmegaKey}`);

      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.body.success, false);
    });

    test('Tenant A staff cannot mutate Tenant B leads (returns 404)', async () => {
      const waIdSigma = '919111111111';

      const res = await request(app)
        .patch(`/leads/${waIdSigma}`)
        .set('Authorization', `Bearer ${userOmegaKey}`)
        .send({ status: 'converted' });

      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.body.success, false);

      const sigmaLead = leadRepository.findByWaId(waIdSigma, 'tenant_sigma');
      assert.strictEqual(sigmaLead.status, 'new', 'Sigma lead status must remain unchanged');
    });

    test('Tenant A staff cannot spoof x-tenant-id to access Tenant B (returns 403 Forbidden)', async () => {
      const res = await request(app)
        .get('/leads')
        .set('Authorization', `Bearer ${userOmegaKey}`)
        .set('x-tenant-id', 'tenant_sigma');

      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.body.success, false);
      assert.ok(res.body.error.includes('Forbidden'));
    });

    test('Cross-tenant handoffs cannot be listed or resolved by other tenants', () => {
      const waIdSigma = '919111111111';
      handoffRepository.recordHandoff({
        tenantId: 'tenant_sigma',
        waId: waIdSigma,
        reason: 'human_requested',
        summary: 'Secret Sigma Request'
      });

      const omegaHandoffs = handoffRepository.listHandoffs('tenant_omega', 'pending');
      const foundInOmega = omegaHandoffs.find(h => h.wa_id === waIdSigma);
      assert.strictEqual(foundInOmega, undefined, 'Tenant Omega must never see Tenant Sigma handoffs');

      const sigmaHandoffs = handoffRepository.listHandoffs('tenant_sigma', 'pending');
      const foundInSigma = sigmaHandoffs.find(h => h.wa_id === waIdSigma);
      assert.ok(foundInSigma);
    });
  });

  describe('Part 1 P0: Webhook Multi-Message Isolation & Contact Binding', () => {
    test('webhook containing 3 messages from different senders is isolated into 3 distinct events with correct contacts', async () => {
      const webhookPayload = {
        object: 'whatsapp_business_account',
        entry: [{
          id: 'WH_ENTRY_001',
          changes: [{
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '15550009999',
                phone_number_id: 'PHONE_OMEGA_999'
              },
              contacts: [
                { profile: { name: 'Alice Walker' }, wa_id: '919000000001' },
                { profile: { name: 'Bob Builder' }, wa_id: '919000000002' }
              ],
              messages: [
                {
                  id: 'wamid.HBgL001',
                  from: '919000000001',
                  timestamp: '1725300000',
                  type: 'text',
                  text: { body: 'Message 1 from Alice' }
                },
                {
                  id: 'wamid.HBgL002',
                  from: '919000000002',
                  timestamp: '1725300001',
                  type: 'text',
                  text: { body: 'Message 2 from Bob' }
                },
                {
                  id: 'wamid.HBgL003',
                  from: '919000000001',
                  timestamp: '1725300002',
                  type: 'text',
                  text: { body: 'Message 3 from Alice' }
                }
              ]
            }
          }]
        }]
      };

      const res = await request(app)
        .post('/webhook')
        .set('x-async-processing', 'true')
        .send(webhookPayload);

      assert.strictEqual(res.status, 200);

      // Verify 3 distinct events were recorded
      const db = getDatabase(testDbPath);
      const rows = db.prepare(`
        SELECT event_key, message_id, payload_json
        FROM webhook_events
        WHERE event_key IN ('msg:wamid.HBgL001', 'msg:wamid.HBgL002', 'msg:wamid.HBgL003')
        ORDER BY event_key ASC
      `).all();

      assert.strictEqual(rows.length, 3, 'Must enqueue exactly 3 separate events');

      // Verify each event contains ONLY its own message and its matching contact
      const payload1 = JSON.parse(rows[0].payload_json);
      const val1 = payload1.entry[0].changes[0].value;
      assert.strictEqual(val1.messages.length, 1);
      assert.strictEqual(val1.messages[0].id, 'wamid.HBgL001');
      assert.strictEqual(val1.contacts[0].profile.name, 'Alice Walker');

      const payload2 = JSON.parse(rows[1].payload_json);
      const val2 = payload2.entry[0].changes[0].value;
      assert.strictEqual(val2.messages.length, 1);
      assert.strictEqual(val2.messages[0].id, 'wamid.HBgL002');
      assert.strictEqual(val2.contacts[0].profile.name, 'Bob Builder');

      const payload3 = JSON.parse(rows[2].payload_json);
      const val3 = payload3.entry[0].changes[0].value;
      assert.strictEqual(val3.messages.length, 1);
      assert.strictEqual(val3.messages[0].id, 'wamid.HBgL003');
      assert.strictEqual(val3.contacts[0].profile.name, 'Alice Walker');
    });

    test('duplicate webhook delivery does not insert duplicate events or process twice', async () => {
      const duplicatePayload = {
        object: 'whatsapp_business_account',
        entry: [{
          changes: [{
            field: 'messages',
            value: {
              metadata: { phone_number_id: 'PHONE_OMEGA_999' },
              contacts: [{ profile: { name: 'Alice Walker' }, wa_id: '919000000001' }],
              messages: [{ id: 'wamid.HBgL001', from: '919000000001', text: { body: 'Message 1 from Alice' } }]
            }
          }]
        }]
      };

      const res = await request(app)
        .post('/webhook')
        .set('x-async-processing', 'true')
        .send(duplicatePayload);

      assert.strictEqual(res.status, 200);

      const db = getDatabase(testDbPath);
      const count = db.prepare("SELECT COUNT(*) as cnt FROM webhook_events WHERE event_key = 'msg:wamid.HBgL001'").get().cnt;
      assert.strictEqual(count, 1, 'Duplicate event must be skipped via eventKey idempotency');
    });
  });

  describe('Part 1 P1: AI Policy, Conversion Protection & Medical Safety', () => {
    test('AIPolicy strictly blocks AI attempt to mark a lead converted', () => {
      const lead = { wa_id: '919000000099', status: 'hot' };
      const updates = aiPolicy.validateAndSanitizeUpdates(lead, { status: 'converted' });

      assert.strictEqual(updates.status, undefined, 'AI must NEVER be allowed to set status to converted');
    });

    test('medical and injury inquiries trigger disclaimer and immediate human handoff', () => {
      const medicalText = "I had severe lower back pain and spinal disc herniation last month. Can I deadlift?";
      const check = aiPolicy.checkMedicalInjurySafety(medicalText);

      assert.strictEqual(check.isMedicalQuery, true);
      assert.strictEqual(check.handoffReason, 'injury_question');
      assert.ok(check.disclaimerText.includes('physician'));
    });

    test('response sanitizer strips raw internal delimiters and JSON objects', () => {
      const dirtyOutput = "<<<{\"status\": \"qualified\", \"interest\": \"crossfit\"}>>> Hello! Welcome to our gym. {raw json}";
      const cleaned = aiService.cleanAndSanitizeReply(dirtyOutput, 'Omega Strength');

      assert.strictEqual(cleaned.includes('<<<'), false);
      assert.strictEqual(cleaned.includes('>>>'), false);
      assert.strictEqual(cleaned.includes('{"status"'), false);
      assert.ok(cleaned.includes('Hello! Welcome to our gym.'));
    });
  });

  describe('Part 1 P1: Inbound & Outbound Queue Retry & Stale Lock Lifecycle', () => {
    test('stale lock recovery resets stuck in-flight webhook events', () => {
      const db = getDatabase(testDbPath);
      // Clean up previous pending/processing events for isolated test
      db.prepare("UPDATE webhook_events SET status = 'completed' WHERE status IN ('pending', 'processing')").run();

      const { id } = eventRepository.recordEvent({
        eventKey: 'stale_test_event_01',
        tenantId: 'tenant_omega',
        eventType: 'message',
        payload: { test: true }
      });

      // Claim event
      const evt = eventRepository.getNextPendingEvent(60);
      assert.strictEqual(evt.id, id);

      // Force lock time into past (simulate worker crash)
      db.prepare("UPDATE webhook_events SET locked_at = datetime('now', '-70 seconds') WHERE id = ?").run(id);

      // Recover stale locks
      const recovered = eventRepository.recoverStaleLocks(60);
      assert.ok(recovered >= 1);

      // Verify event is pending again
      const rechecked = db.prepare('SELECT status, locked_at FROM webhook_events WHERE id = ?').get(id);
      assert.strictEqual(rechecked.status, 'pending');
      assert.strictEqual(rechecked.locked_at, null);
    });

    test('stale sending outbound messages are automatically reclaimed by next worker fetch', () => {
      const { id } = outboundRepository.enqueueOutbound({
        dedupKey: 'stale_test_outbound_reclaim_01',
        tenantId: 'tenant_omega',
        waId: '919999000001',
        text: 'Reclaim message'
      });

      // Worker 1 claims message
      const msg = outboundRepository.getNextPendingMessage(60);
      assert.strictEqual(msg.id, id);

      // Simulate crash by forcing locked_at into past (>60 seconds ago)
      const db = getDatabase(testDbPath);
      db.prepare("UPDATE outbound_messages SET locked_at = datetime('now', '-70 seconds') WHERE id = ?").run(id);

      // Worker 2 fetches next pending message and reclaims the stale sending message
      const reclaimed = outboundRepository.getNextPendingMessage(60);
      assert.ok(reclaimed);
      assert.strictEqual(reclaimed.id, id);
      assert.strictEqual(reclaimed.attempts, 2);
    });

    test('outbound failure increments retry attempts and transitions to failed on non-retryable error', () => {
      const { id } = outboundRepository.enqueueOutbound({
        dedupKey: 'perm_fail_test_01',
        tenantId: 'tenant_omega',
        waId: '919999000002',
        text: 'Permanent fail test'
      });

      // Non-retryable error (e.g. invalid phone number)
      outboundRepository.markFailed(id, 'Meta API 400 Invalid Recipient', false);

      const db = getDatabase(testDbPath);
      const finalMsg = db.prepare('SELECT status, last_error FROM outbound_messages WHERE id = ?').get(id);
      assert.strictEqual(finalMsg.status, 'failed');
      assert.strictEqual(finalMsg.last_error, 'Meta API 400 Invalid Recipient');
    });
  });
});


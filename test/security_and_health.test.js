const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const fs = require('fs');
const path = require('path');

const testDbPath = path.join(__dirname, '../data/test_security_health.db');
const testKey = 'test_security_secret_123';

process.env.NODE_ENV = 'test';
process.env.DASHBOARD_API_KEY = testKey;
process.env.DATABASE_PATH = testDbPath;

const createApp = require('../src/app');
const { getDatabase, closeDatabase } = require('../src/db/database');
const auditService = require('../src/services/auditService');
const leadRepository = require('../src/db/leadRepository');

describe('Security Headers, Health Readiness & Observability Dashboard (Phase F)', () => {
  let app;

  before(() => {
    closeDatabase();
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch (e) {}
    }
    getDatabase(testDbPath);
    app = createApp();

    // Seed test leads
    leadRepository.getOrCreateLead('917700000001', 'Test Lead 1', new Date().toISOString(), 'goldkraft');
    leadRepository.updateLead('917700000001', { status: 'qualified' }, 'goldkraft');
  });

  after(() => {
    closeDatabase();
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch (e) {}
    }
  });

  describe('Security Headers & Request ID Tracing', () => {
    test('attaches production security headers on all responses', async () => {
      const res = await request(app).get('/health');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
      assert.strictEqual(res.headers['x-frame-options'], 'DENY');
      assert.strictEqual(res.headers['x-xss-protection'], '0');
      assert.strictEqual(res.headers['content-security-policy'], "default-src 'self'");
    });

    test('generates and propagates x-request-id header', async () => {
      const res = await request(app).get('/health');
      assert.ok(res.headers['x-request-id'], 'Should contain x-request-id');

      // Honors client-supplied x-request-id
      const customId = 'req_custom_trace_999';
      const customRes = await request(app)
        .get('/health')
        .set('x-request-id', customId);
      assert.strictEqual(customRes.headers['x-request-id'], customId);
    });
  });

  describe('Health Readiness Check (/health/ready)', () => {
    test('returns 200 ready when SQLite database is responsive', async () => {
      const res = await request(app).get('/health/ready');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.status, 'ready');
      assert.strictEqual(res.body.database, 'connected');
      assert.ok(typeof res.body.uptime_seconds === 'number');
    });
  });

  describe('Dashboard Metrics & Summary Endpoint (/dashboard/summary)', () => {
    test('rejects unauthenticated requests with 401', async () => {
      const res = await request(app).get('/dashboard/summary');
      assert.strictEqual(res.status, 401);
    });

    test('returns aggregated metrics scoped to tenant when authenticated', async () => {
      const res = await request(app)
        .get('/dashboard/summary')
        .set('Authorization', `Bearer ${testKey}`);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.data.tenant_id, 'goldkraft');
      assert.strictEqual(res.body.data.leads.total, 1);
      assert.strictEqual(res.body.data.leads.qualified, 1);
      assert.ok(res.body.data.queue !== undefined);
      assert.ok(res.body.data.ai_usage !== undefined);
    });
  });

  describe('Audit Logging Service (Phase 58)', () => {
    test('records and retrieves sensitive administrative actions', () => {
      auditService.recordAudit({
        tenantId: 'goldkraft',
        actorId: 'admin_1',
        actorRole: 'owner',
        action: 'lead_status_override',
        targetType: 'lead',
        targetId: '917700000001',
        changes: { before: 'qualified', after: 'converted' },
        ipAddress: '127.0.0.1'
      });

      const logs = auditService.listAuditLogs('goldkraft', 10);
      assert.ok(logs.length > 0);
      assert.strictEqual(logs[0].action, 'lead_status_override');
      assert.strictEqual(logs[0].target_id, '917700000001');
      assert.strictEqual(logs[0].changes.after, 'converted');
    });
  });
});

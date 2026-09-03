const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const fs = require('fs');
const path = require('path');

const testDbPath = path.join(__dirname, '../data/test_multitenancy.db');
const masterAdminKey = 'master_admin_secret_key_999';

process.env.NODE_ENV = 'test';
process.env.DASHBOARD_API_KEY = masterAdminKey;
process.env.DATABASE_PATH = testDbPath;

const createApp = require('../src/app');
const { getDatabase, closeDatabase } = require('../src/db/database');
const tenantService = require('../src/services/tenantService');
const authService = require('../src/services/authService');
const leadRepository = require('../src/db/leadRepository');

describe('Multi-Tenant Isolation & Cross-Tenant Security Boundaries (Invariant 3)', () => {
  let app;
  let userAlphaKey;
  let userBetaKey;

  before(() => {
    closeDatabase();
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch (e) {}
    }
    getDatabase(testDbPath);
    app = createApp();

    // 1. Create two distinct gym tenants
    tenantService.createTenant({
      id: 'gym_alpha',
      name: 'Alpha Iron Fitness',
      whatsappPhoneNumberId: 'PHONE_ALPHA_101',
      configuration: { gymName: 'Alpha Iron Fitness' }
    });

    tenantService.createTenant({
      id: 'gym_beta',
      name: 'Beta Functional Club',
      whatsappPhoneNumberId: 'PHONE_BETA_202',
      configuration: { gymName: 'Beta Functional Club' }
    });

    // 2. Register users for each gym
    const alphaReg = authService.createUser({
      tenantId: 'gym_alpha',
      email: 'manager@alphafitness.com',
      name: 'Alpha Manager',
      role: 'manager'
    });
    userAlphaKey = alphaReg.apiKey;

    const betaReg = authService.createUser({
      tenantId: 'gym_beta',
      email: 'coach@betafitness.com',
      name: 'Beta Coach',
      role: 'staff'
    });
    userBetaKey = betaReg.apiKey;

    // 3. Seed leads for Gym Alpha
    const now = new Date().toISOString();
    leadRepository.getOrCreateLead('918800000001', 'Alpha Member One', now, 'gym_alpha');
    leadRepository.saveMessage({
      messageId: 'msg_alpha_1',
      tenantId: 'gym_alpha',
      waId: '918800000001',
      direction: 'in',
      text: 'Private message for Alpha gym'
    });

    // 4. Seed leads for Gym Beta
    leadRepository.getOrCreateLead('918800000002', 'Beta Member Two', now, 'gym_beta');
    leadRepository.saveMessage({
      messageId: 'msg_beta_1',
      tenantId: 'gym_beta',
      waId: '918800000002',
      direction: 'in',
      text: 'Confidential message for Beta gym'
    });
  });

  after(() => {
    closeDatabase();
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch (e) {}
    }
  });

  describe('GET /leads (Tenant Scoping)', () => {
    test('Gym Alpha user only retrieves Gym Alpha leads', async () => {
      const res = await request(app)
        .get('/leads')
        .set('Authorization', `Bearer ${userAlphaKey}`);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.data.length, 1);
      assert.strictEqual(res.body.data[0].wa_id, '918800000001');
      assert.strictEqual(res.body.data[0].display_name, 'Alpha Member One');
      assert.strictEqual(res.body.data[0].tenant_id, 'gym_alpha');
    });

    test('Gym Beta user only retrieves Gym Beta leads', async () => {
      const res = await request(app)
        .get('/leads')
        .set('Authorization', `Bearer ${userBetaKey}`);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.data.length, 1);
      assert.strictEqual(res.body.data[0].wa_id, '918800000002');
      assert.strictEqual(res.body.data[0].display_name, 'Beta Member Two');
      assert.strictEqual(res.body.data[0].tenant_id, 'gym_beta');
    });
  });

  describe('GET /leads/:wa_id (Cross-Tenant Data Leakage Prevention)', () => {
    test('Gym Alpha user receives 404 when attempting to view Gym Beta lead', async () => {
      const res = await request(app)
        .get('/leads/918800000002')
        .set('Authorization', `Bearer ${userAlphaKey}`);

      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.body.success, false);
      assert.ok(res.body.error.includes('not found'));
    });

    test('Gym Beta user receives 404 when attempting to view Gym Alpha lead', async () => {
      const res = await request(app)
        .get('/leads/918800000001')
        .set('Authorization', `Bearer ${userBetaKey}`);

      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.body.success, false);
    });
  });

  describe('Cross-Tenant Header Manipulation Prevention', () => {
    test('Gym Alpha user passing x-tenant-id for Gym Beta receives 403 Forbidden', async () => {
      const res = await request(app)
        .get('/leads')
        .set('Authorization', `Bearer ${userAlphaKey}`)
        .set('x-tenant-id', 'gym_beta');

      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.body.success, false);
      assert.ok(res.body.error.includes('permission to access another tenant'));
    });

    test('Platform admin can safely switch tenant context using x-tenant-id', async () => {
      const resAlpha = await request(app)
        .get('/leads')
        .set('Authorization', `Bearer ${masterAdminKey}`)
        .set('x-tenant-id', 'gym_alpha');

      assert.strictEqual(resAlpha.status, 200);
      assert.strictEqual(resAlpha.body.data.length, 1);
      assert.strictEqual(resAlpha.body.data[0].tenant_id, 'gym_alpha');

      const resBeta = await request(app)
        .get('/leads')
        .set('Authorization', `Bearer ${masterAdminKey}`)
        .set('x-tenant-id', 'gym_beta');

      assert.strictEqual(resBeta.status, 200);
      assert.strictEqual(resBeta.body.data.length, 1);
      assert.strictEqual(resBeta.body.data[0].tenant_id, 'gym_beta');
    });
  });

  describe('DAL Isolation Invariant', () => {
    test('leadRepository enforces tenant separation even if queried directly', () => {
      const leadUnderAlpha = leadRepository.findByWaId('918800000002', 'gym_alpha');
      assert.strictEqual(leadUnderAlpha, null, 'Beta lead must be invisible when scoped to Alpha');

      const leadUnderBeta = leadRepository.findByWaId('918800000002', 'gym_beta');
      assert.ok(leadUnderBeta, 'Beta lead must be visible when scoped to Beta');
    });
  });
});

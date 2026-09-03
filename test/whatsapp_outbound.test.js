const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const axios = require('axios');
const { getDatabase, closeDatabase } = require('../src/db/database');
const tenantService = require('../src/services/tenantService');
const leadRepository = require('../src/db/leadRepository');
const whatsappService = require('../src/services/whatsappService');
const env = require('../src/config/env');

describe('Multi-Tenant Outbound WhatsApp Messaging (Live Network Path)', () => {
  let db;
  let origAxiosPost;
  let origMetaPhoneId;

  function cleanupTestTenants() {
    if (!db) return;
    db.exec(`
      DELETE FROM messages WHERE tenant_id LIKE 'gym_%' AND tenant_id != 'goldkraft';
      DELETE FROM leads WHERE tenant_id LIKE 'gym_%' AND tenant_id != 'goldkraft';
      DELETE FROM tenants WHERE id LIKE 'gym_%' AND id != 'goldkraft';
    `);
  }

  before(() => {
    db = getDatabase();
    origMetaPhoneId = env.metaPhoneNumberId;
    env.metaPhoneNumberId = '100000000000000'; // Default Goldkraft phone ID
    cleanupTestTenants();
  });

  after(() => {
    env.metaPhoneNumberId = origMetaPhoneId;
    cleanupTestTenants();
    closeDatabase();
  });

  beforeEach(() => {
    origAxiosPost = axios.post;
    cleanupTestTenants();
    // Ensure foreign keys are strictly enforced
    db.exec('PRAGMA foreign_keys = ON;');
  });

  afterEach(() => {
    axios.post = origAxiosPost;
  });

  test('Test 1 — Non-default tenant uses its own phone number in Meta API URL', async () => {
    const titanPhoneId = '998877665544332';
    const tenantId = 'gym_test_titan_url';
    tenantService.createTenant({
      id: tenantId,
      name: 'Titan Fitness Club',
      whatsappPhoneNumberId: titanPhoneId,
      configuration: { gymName: 'Titan Fitness' }
    });

    const waId = '919111111111';
    leadRepository.getOrCreateLead(waId, 'Titan Member 1', null, tenantId);

    let requestedUrl = null;
    axios.post = async (url, data, config) => {
      requestedUrl = url;
      return {
        data: {
          messaging_product: 'whatsapp',
          contacts: [{ input: waId, wa_id: waId }],
          messages: [{ id: 'wamid.titan_live_01' }]
        }
      };
    };

    await whatsappService.sendTextMessage(waId, 'Welcome to Titan Fitness!', {
      tenantId,
      forceLiveNetwork: true
    });

    assert.ok(requestedUrl, 'axios.post should have been called');
    assert.ok(
      requestedUrl.includes(`/${titanPhoneId}/messages`),
      `URL '${requestedUrl}' must contain tenant-specific phone number ID '${titanPhoneId}'`
    );
    assert.ok(
      !requestedUrl.includes('/100000000000000/messages'),
      `URL must NOT contain Goldkraft's default phone number ID`
    );
  });

  test('Test 2 — Tenant ID is persisted correctly in messages table on live success', async () => {
    const tenantId = 'gym_test_titan_persist';
    tenantService.createTenant({
      id: tenantId,
      name: 'Titan Persist Club',
      whatsappPhoneNumberId: '887766554433221',
      configuration: {}
    });

    const waId = '919222222222';
    leadRepository.getOrCreateLead(waId, 'Titan Member 2', null, tenantId);

    const liveMsgId = 'wamid.live_persist_success_999';
    axios.post = async (url, data, config) => {
      return {
        data: {
          messaging_product: 'whatsapp',
          contacts: [{ input: waId, wa_id: waId }],
          messages: [{ id: liveMsgId }]
        }
      };
    };

    await whatsappService.sendTextMessage(waId, 'Your trial session is confirmed.', {
      tenantId,
      forceLiveNetwork: true
    });

    // Verify database row
    const row = db.prepare('SELECT * FROM messages WHERE message_id = ?').get(liveMsgId);
    assert.ok(row, 'Message must be stored in database');
    assert.strictEqual(row.tenant_id, tenantId, `Row tenant_id must be '${tenantId}'`);
    assert.strictEqual(row.wa_id, waId);
    assert.strictEqual(row.direction, 'out');
  });

  test('Test 3 — Global fallback remains backward-compatible when tenant has no override', async () => {
    const tenantId = 'gym_test_no_override';
    tenantService.createTenant({
      id: tenantId,
      name: 'No Override Gym',
      whatsappPhoneNumberId: null,
      configuration: {}
    });

    const waId = '919333333333';
    leadRepository.getOrCreateLead(waId, 'No Override Lead', null, tenantId);

    let requestedUrl = null;
    axios.post = async (url, data, config) => {
      requestedUrl = url;
      return {
        data: {
          messaging_product: 'whatsapp',
          contacts: [{ input: waId, wa_id: waId }],
          messages: [{ id: 'wamid.fallback_test_01' }]
        }
      };
    };

    await whatsappService.sendTextMessage(waId, 'Checking fallback phone ID', {
      tenantId,
      forceLiveNetwork: true
    });

    assert.ok(requestedUrl);
    assert.ok(
      requestedUrl.includes(`/${env.metaPhoneNumberId}/messages`),
      `URL '${requestedUrl}' must use fallback env.metaPhoneNumberId '${env.metaPhoneNumberId}'`
    );
  });

  test('Test 4 — Live success does not produce a cross-tenant FK violation', async () => {
    const tenantId = 'gym_test_titan_fk';
    tenantService.createTenant({
      id: tenantId,
      name: 'Titan FK Safety Gym',
      whatsappPhoneNumberId: '776655443322110',
      configuration: {}
    });

    const waId = '919444444444';
    // Lead exists ONLY in gym_test_titan_fk, NOT in goldkraft
    leadRepository.getOrCreateLead(waId, 'Titan FK Lead', null, tenantId);

    // Verify lead does NOT exist under goldkraft
    const goldkraftLead = db.prepare('SELECT * FROM leads WHERE tenant_id = ? AND wa_id = ?').get('goldkraft', waId);
    assert.strictEqual(goldkraftLead, undefined, 'Lead must not exist under goldkraft');

    const liveMsgId = 'wamid.fk_safety_live_msg';
    axios.post = async (url, data, config) => {
      return {
        data: {
          messaging_product: 'whatsapp',
          contacts: [{ input: waId, wa_id: waId }],
          messages: [{ id: liveMsgId }]
        }
      };
    };

    // If tenantId was lost and defaulted to 'goldkraft', this would throw a FOREIGN KEY constraint violation
    await assert.doesNotReject(async () => {
      await whatsappService.sendTextMessage(waId, 'FK safety verified message', {
        tenantId,
        forceLiveNetwork: true
      });
    }, 'Must not throw foreign key constraint violation');

    const msgRow = db.prepare('SELECT * FROM messages WHERE message_id = ?').get(liveMsgId);
    assert.ok(msgRow);
    assert.strictEqual(msgRow.tenant_id, tenantId);
    assert.strictEqual(msgRow.wa_id, waId);
  });

  test('Test 5 — Live Meta failure preserves tenant identity in failure message record', async () => {
    const tenantId = 'gym_test_titan_fail';
    tenantService.createTenant({
      id: tenantId,
      name: 'Titan Fail Record Gym',
      whatsappPhoneNumberId: '665544332211009',
      configuration: {}
    });

    const waId = '919555555555';
    leadRepository.getOrCreateLead(waId, 'Titan Fail Lead', null, tenantId);

    // Mock axios.post to reject with simulated Meta 400 Bad Request
    axios.post = async () => {
      const error = new Error('Meta API error: invalid recipient phone');
      error.response = { status: 400, data: { error: { message: 'Invalid recipient' } } };
      throw error;
    };

    await assert.rejects(async () => {
      await whatsappService.sendTextMessage(waId, 'This send will fail', {
        tenantId,
        forceLiveNetwork: true
      });
    });

    // Check failed message written to database
    const failedMsg = db.prepare(
      "SELECT * FROM messages WHERE tenant_id = ? AND wa_id = ? AND text LIKE '[FAILED SEND]%'"
    ).get(tenantId, waId);

    assert.ok(failedMsg, 'Failed message record must be created');
    assert.strictEqual(failedMsg.tenant_id, tenantId, `Failed message must retain tenant_id '${tenantId}'`);
    assert.strictEqual(failedMsg.wa_id, waId);
  });

  test('Test 6 — Missing or invalid tenant fails safely and does not silently send as Goldkraft', async () => {
    const unknownTenantId = 'completely_unknown_nonexistent_gym';
    const waId = '919666666666';

    let networkCalled = false;
    axios.post = async () => {
      networkCalled = true;
      return { data: { messages: [{ id: 'fake' }] } };
    };

    await assert.rejects(
      async () => {
        await whatsappService.sendTextMessage(waId, 'Should fail before network', {
          tenantId: unknownTenantId,
          forceLiveNetwork: true
        });
      },
      /Unknown tenant ID 'completely_unknown_nonexistent_gym'/,
      'Must reject with unknown tenant error'
    );

    assert.strictEqual(networkCalled, false, 'No outbound network call should be made for unknown tenant');
  });
});

const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const axios = require('axios');
const createApp = require('../src/app');
const { getDatabase, closeDatabase } = require('../src/db/database');
const aiService = require('../src/services/aiService');
const tenantService = require('../src/services/tenantService');
const leadRepository = require('../src/db/leadRepository');
const env = require('../src/config/env');

describe('GKF-WA Demo Backend & AI Pipeline Regression Tests', () => {
  let app;
  let db;
  let origAxiosPost;
  let origNodeEnv;
  let origApiKey;
  let origForceNetwork;

  const DEMO_WA_ID = process.env.DEMO_WA_ID || 'demo_919876543210';
  const DEMO_TENANT = 'goldkraft';

  function cleanupDemoData() {
    if (!db) return;
    try {
      db.prepare('DELETE FROM outbound_messages WHERE tenant_id = ? AND wa_id = ?').run(DEMO_TENANT, DEMO_WA_ID);
      db.prepare('DELETE FROM handoffs WHERE tenant_id = ? AND wa_id = ?').run(DEMO_TENANT, DEMO_WA_ID);
      db.prepare('DELETE FROM messages WHERE tenant_id = ? AND wa_id = ?').run(DEMO_TENANT, DEMO_WA_ID);
      db.prepare('DELETE FROM leads WHERE tenant_id = ? AND wa_id = ?').run(DEMO_TENANT, DEMO_WA_ID);
    } catch (e) {}
  }

  before(() => {
    db = getDatabase();
    app = createApp();
    origNodeEnv = process.env.NODE_ENV;
    origApiKey = env.openRouterApiKey;
    origForceNetwork = aiService.forceNetworkInTest;
  });

  after(() => {
    cleanupDemoData();
    closeDatabase();
    process.env.NODE_ENV = origNodeEnv;
    env.openRouterApiKey = origApiKey;
    aiService.forceNetworkInTest = origForceNetwork;
  });

  beforeEach(() => {
    origAxiosPost = axios.post;
    cleanupDemoData();
    env.openRouterApiKey = 'sk-or-v1-mock-test-key-12345';
    aiService.forceNetworkInTest = true;
  });

  afterEach(() => {
    axios.post = origAxiosPost;
    aiService.forceNetworkInTest = origForceNetwork;
    cleanupDemoData();
  });

  test('Test 1 — Demo endpoint returns a real backend response (Stubbed OpenRouter)', async () => {
    let openRouterCalled = false;
    let requestPayload = null;
    let requestHeaders = null;

    axios.post = async (url, payload, config) => {
      openRouterCalled = true;
      requestPayload = payload;
      requestHeaders = config?.headers;
      return {
        data: {
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Welcome to Goldkraft Fitness! Our state-of-the-art facility is open 6 days a week.'
              }
            }
          ],
          usage: { prompt_tokens: 120, completion_tokens: 30 }
        }
      };
    };

    const res = await request(app)
      .post('/demo/chat')
      .send({ message: 'What equipment do you have in the gym?' });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.source, 'ai');
    assert.strictEqual(
      res.body.reply,
      'Welcome to Goldkraft Fitness! Our state-of-the-art facility is open 6 days a week.'
    );
    assert.ok(openRouterCalled, 'OpenRouter network path must be reached');
    assert.ok(requestPayload.messages.length >= 2, 'Must include system prompt and user message');
    assert.strictEqual(requestHeaders['Authorization'], 'Bearer sk-or-v1-mock-test-key-12345');
  });

  test('Test 2 — Conversation is persisted according to existing repository conventions', async () => {
    axios.post = async () => ({
      data: {
        choices: [{ message: { role: 'assistant', content: 'We offer full barbell setups and cardio zones.' } }],
        usage: { prompt_tokens: 100, completion_tokens: 25 }
      }
    });

    // Message 1
    const res1 = await request(app)
      .post('/demo/chat')
      .send({ message: 'Tell me about your weightlifting area' });
    assert.strictEqual(res1.status, 200);

    // Message 2
    const res2 = await request(app)
      .post('/demo/chat')
      .send({ message: 'Do you have Olympic bumper plates?' });
    assert.strictEqual(res2.status, 200);

    // Verify messages table
    const storedMessages = db.prepare(
      'SELECT * FROM messages WHERE tenant_id = ? AND wa_id = ? ORDER BY id ASC'
    ).all(DEMO_TENANT, DEMO_WA_ID);

    assert.strictEqual(storedMessages.length, 4, 'Must have 2 inbound and 2 outbound persisted messages');
    assert.strictEqual(storedMessages[0].direction, 'in');
    assert.strictEqual(storedMessages[0].text, 'Tell me about your weightlifting area');
    assert.strictEqual(storedMessages[1].direction, 'out');
    assert.strictEqual(storedMessages[1].text, 'We offer full barbell setups and cardio zones.');
    assert.strictEqual(storedMessages[2].direction, 'in');
    assert.strictEqual(storedMessages[2].text, 'Do you have Olympic bumper plates?');
    assert.strictEqual(storedMessages[3].direction, 'out');

    // Verify outbound_messages queue table
    const outboundQueue = db.prepare(
      'SELECT * FROM outbound_messages WHERE tenant_id = ? AND wa_id = ?'
    ).all(DEMO_TENANT, DEMO_WA_ID);
    assert.strictEqual(outboundQueue.length, 2, 'Both outbound replies should be recorded in outbound_messages');
  });

  test('Test 3 — Conversation history is used on subsequent turns', async () => {
    const capturedPayloads = [];

    axios.post = async (url, payload) => {
      capturedPayloads.push(payload);
      return {
        data: {
          choices: [{ message: { role: 'assistant', content: 'Got it, we can help with that!' } }],
          usage: { prompt_tokens: 150, completion_tokens: 20 }
        }
      };
    };

    // First turn
    await request(app)
      .post('/demo/chat')
      .send({ message: 'I want to lose 10kg in 3 months.' });

    // Second turn
    await request(app)
      .post('/demo/chat')
      .send({ message: 'What kind of diet plan goes with this?' });

    assert.strictEqual(capturedPayloads.length, 2);
    const secondTurnMessages = capturedPayloads[1].messages;

    // Check that second turn messages contain turn 1 user input and turn 1 assistant reply
    const historyUser = secondTurnMessages.find(m => m.role === 'user' && m.content.includes('I want to lose 10kg in 3 months.'));
    const historyAssistant = secondTurnMessages.find(m => m.role === 'assistant' && m.content.includes('Got it, we can help with that!'));

    assert.ok(historyUser, 'Turn 2 must receive Turn 1 user message in conversation history');
    assert.ok(historyAssistant, 'Turn 2 must receive Turn 1 assistant reply in conversation history');
  });

  test('Test 4 — CRM / Tool updates work (save_lead & notify_staff)', async () => {
    let callCount = 0;

    axios.post = async (url, payload) => {
      callCount++;
      if (callCount === 1) {
        // Model requests tool calls: save_lead and notify_staff
        return {
          data: {
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_save_lead_01',
                      type: 'function',
                      function: {
                        name: 'save_lead',
                        arguments: JSON.stringify({
                          name: 'Rahul Sharma',
                          interest: 'CrossFit & Fat Loss',
                          status: 'qualified',
                          notes: 'Wants high-intensity interval training'
                        })
                      }
                    },
                    {
                      id: 'call_notify_staff_01',
                      type: 'function',
                      function: {
                        name: 'notify_staff',
                        arguments: JSON.stringify({
                          needs_human: true,
                          handoff_reason: 'custom_program'
                        })
                      }
                    }
                  ]
                }
              }
            ],
            usage: { prompt_tokens: 150, completion_tokens: 50 }
          }
        };
      }

      // Second call after tool results
      return {
        data: {
          choices: [
            {
              message: {
                role: 'assistant',
                content: "I've noted your interest in CrossFit! Our coach will reach out to discuss your custom plan."
              }
            }
          ],
          usage: { prompt_tokens: 220, completion_tokens: 40 }
        }
      };
    };

    const res = await request(app)
      .post('/demo/chat')
      .send({ message: 'I want a custom CrossFit program for fat loss.' });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.lead.status, 'qualified');
    assert.strictEqual(res.body.lead.interest, 'CrossFit & Fat Loss');
    assert.strictEqual(res.body.lead.needs_human, true);
    assert.strictEqual(res.body.lead.handoff_reason, 'custom_program');

    // Verify lead in SQLite database
    const lead = leadRepository.findByWaId(DEMO_WA_ID, DEMO_TENANT);
    assert.ok(lead, 'Lead record must exist');
    assert.strictEqual(lead.display_name, 'Rahul Sharma');
    assert.strictEqual(lead.interest, 'CrossFit & Fat Loss');
    assert.strictEqual(lead.status, 'qualified');
    assert.strictEqual(lead.needs_human, true);
    assert.strictEqual(lead.handoff_reason, 'custom_program');
    assert.ok(lead.notes.includes('high-intensity interval training'));

    // Verify handoffs table entry
    const handoff = db.prepare(
      'SELECT * FROM handoffs WHERE tenant_id = ? AND wa_id = ?'
    ).get(DEMO_TENANT, DEMO_WA_ID);
    assert.ok(handoff, 'Handoff record must be inserted');
    assert.strictEqual(handoff.reason, 'custom_program');
  });

  test('Test 5 — Safety layer is preserved (Medical / Injury check)', async () => {
    let networkCalled = false;
    axios.post = async () => {
      networkCalled = true;
      return { data: { choices: [{ message: { content: 'LLM reply' } }] } };
    };

    const res = await request(app)
      .post('/demo/chat')
      .send({ message: 'I suffered an acute lumbar herniated disc. Should I do heavy deadlifts?' });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.source, 'safety');
    assert.ok(res.body.reply.includes('do not diagnose injuries or provide medical advice'));
    assert.strictEqual(networkCalled, false, 'LLM network call must NOT be triggered for medical injury queries');

    // Verify CRM lead updated with medical handoff
    const lead = leadRepository.findByWaId(DEMO_WA_ID, DEMO_TENANT);
    assert.strictEqual(lead.needs_human, true);
    assert.strictEqual(lead.handoff_reason, 'injury_question');
  });

  test('Test 6 — Deterministic router is preserved', async () => {
    let networkCalled = false;
    axios.post = async () => {
      networkCalled = true;
      return { data: { choices: [{ message: { content: 'LLM reply' } }] } };
    };

    const res = await request(app)
      .post('/demo/chat')
      .send({ message: 'What are your gym operating hours on weekdays?' });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.source, 'deterministic');
    assert.ok(res.body.reply.includes('5:00 AM - 10:00 PM'));
    assert.strictEqual(networkCalled, false, 'LLM network call must NOT be triggered for deterministic queries');
  });

  test('Test 7 — Demo cannot access arbitrary tenants', async () => {
    // Create an isolated secondary tenant in database
    tenantService.createTenant({
      id: 'gym_competitor_demo_test',
      name: 'Competitor Fitness',
      whatsappPhoneNumberId: '999111222333444',
      configuration: { pricing_monthly: 9999 }
    });

    // Attempt to submit tenantId override
    const res = await request(app)
      .post('/demo/chat')
      .send({
        message: 'Hello, what are your gym timings?',
        tenantId: 'gym_competitor_demo_test'
      });

    assert.strictEqual(res.status, 200);
    // Verified that response used Goldkraft (server scoped strictly to Goldkraft)
    assert.strictEqual(res.body.lead.tenant_id, 'goldkraft');

    // Verify no leads or messages were created in the competitor tenant
    const competitorLead = db.prepare(
      'SELECT * FROM leads WHERE tenant_id = ?'
    ).get('gym_competitor_demo_test');
    assert.strictEqual(competitorLead, undefined, 'Must not create lead under another tenant');

    const competitorMsg = db.prepare(
      'SELECT * FROM messages WHERE tenant_id = ?'
    ).get('gym_competitor_demo_test');
    assert.strictEqual(competitorMsg, undefined, 'Must not create messages under another tenant');

    // Cleanup secondary tenant
    db.prepare('DELETE FROM tenants WHERE id = ?').run('gym_competitor_demo_test');
  });

  test('Test 8 — OpenRouter API key and system prompt are never exposed', async () => {
    const secretKey = 'sk-or-v1-secret-ultra-confidential-998877';
    env.openRouterApiKey = secretKey;

    axios.post = async () => ({
      data: {
        choices: [{ message: { role: 'assistant', content: 'Our membership is ₹4,040/mo.' } }],
        usage: { prompt_tokens: 50, completion_tokens: 15 }
      }
    });

    // 1. Check /demo/chat response
    const chatRes = await request(app)
      .post('/demo/chat')
      .send({ message: 'How much is membership?' });

    assert.strictEqual(chatRes.status, 200);
    assert.ok(!JSON.stringify(chatRes.body).includes(secretKey), 'Must not leak secretKey in chat response');
    assert.ok(!JSON.stringify(chatRes.body).includes('OPENROUTER_API_KEY'), 'Must not leak env key name');
    assert.ok(!JSON.stringify(chatRes.body).includes('SECURITY AND FACTUAL ACCURACY DIRECTIVES'), 'Must not leak system prompt internals');

    // 2. Check /demo/conversation response
    const convRes = await request(app).get('/demo/conversation');
    assert.strictEqual(convRes.status, 200);
    assert.ok(!JSON.stringify(convRes.body).includes(secretKey));

    // 3. Check /demo/lead response
    const leadRes = await request(app).get('/demo/lead');
    assert.strictEqual(leadRes.status, 200);
    assert.ok(!JSON.stringify(leadRes.body).includes(secretKey));

    // 4. Check static frontend HTML and JS assets
    const htmlRes = await request(app).get('/demo');
    assert.ok(!htmlRes.text.includes(secretKey));
    assert.ok(!htmlRes.text.includes('OPENROUTER'));

    const jsRes = await request(app).get('/js/app.js');
    assert.ok(!jsRes.text.includes(secretKey));
    assert.ok(!jsRes.text.includes('OPENROUTER'));
    assert.ok(!jsRes.text.includes('sk-or-v1'));
  });

  test('Test 9 — Demo reset deterministically resets only demo data', async () => {
    // Insert a real customer lead and message to guarantee isolation
    const realCustomerWaId = '919999988888';
    leadRepository.getOrCreateLead(realCustomerWaId, 'Real Customer', new Date().toISOString(), DEMO_TENANT);
    leadRepository.saveMessage({
      messageId: 'real_msg_001',
      waId: realCustomerWaId,
      direction: 'in',
      text: 'Real customer message that must never be deleted',
      timestamp: new Date().toISOString(),
      tenantId: DEMO_TENANT
    });

    // Also populate demo messages
    await request(app)
      .post('/demo/chat')
      .send({ message: 'Demo message to clear' });

    // Call demo reset
    const resetRes = await request(app).post('/demo/reset');
    assert.strictEqual(resetRes.status, 200);
    assert.strictEqual(resetRes.body.success, true);

    // Verify demo messages are wiped
    const demoMsgs = db.prepare(
      'SELECT * FROM messages WHERE tenant_id = ? AND wa_id = ?'
    ).all(DEMO_TENANT, DEMO_WA_ID);
    assert.strictEqual(demoMsgs.length, 0, 'Demo messages must be empty after reset');

    // Verify demo lead is reset to initial state
    const demoLead = leadRepository.findByWaId(DEMO_WA_ID, DEMO_TENANT);
    assert.ok(demoLead, 'Clean demo lead must be recreated');
    assert.strictEqual(demoLead.status, 'new');

    // CRITICAL: Verify real customer lead and message are untouched
    const realLead = leadRepository.findByWaId(realCustomerWaId, DEMO_TENANT);
    assert.ok(realLead, 'Real customer lead must still exist');
    assert.strictEqual(realLead.display_name, 'Real Customer');

    const realMsg = db.prepare('SELECT * FROM messages WHERE message_id = ?').get('real_msg_001');
    assert.ok(realMsg, 'Real customer message must NOT be deleted');

    // Cleanup real test lead
    db.prepare('DELETE FROM messages WHERE wa_id = ?').run(realCustomerWaId);
    db.prepare('DELETE FROM leads WHERE wa_id = ?').run(realCustomerWaId);
  });

  test('Test 10 — Production security guard blocks demo endpoints when disabled', async () => {
    const originalEnv = process.env.NODE_ENV;
    const originalEnableDemo = process.env.ENABLE_DEMO;

    try {
      process.env.NODE_ENV = 'production';
      delete process.env.ENABLE_DEMO;

      const prodRes = await request(app)
        .post('/demo/chat')
        .send({ message: 'Attempt in production' });

      assert.strictEqual(prodRes.status, 403);
      assert.strictEqual(prodRes.body.success, false);
      assert.strictEqual(prodRes.body.error, 'Demo endpoints are disabled in production environment.');

      const convRes = await request(app).get('/demo/conversation');
      assert.strictEqual(convRes.status, 403);

      const leadRes = await request(app).get('/demo/lead');
      assert.strictEqual(leadRes.status, 403);

      const resetRes = await request(app).post('/demo/reset');
      assert.strictEqual(resetRes.status, 403);
    } finally {
      process.env.NODE_ENV = originalEnv;
      if (originalEnableDemo !== undefined) {
        process.env.ENABLE_DEMO = originalEnableDemo;
      } else {
        delete process.env.ENABLE_DEMO;
      }
    }
  });
});

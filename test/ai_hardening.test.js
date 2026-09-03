const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const testDbPath = path.join(__dirname, '../data/test_ai_hardening.db');
process.env.DATABASE_PATH = testDbPath;

const { getDatabase, closeDatabase } = require('../src/db/database');
const leadRepository = require('../src/db/leadRepository');
const aiPolicy = require('../src/services/aiPolicy');
const deterministicRouter = require('../src/services/deterministicRouter');
const aiCostTracker = require('../src/services/aiCostTracker');
const aiService = require('../src/services/aiService');

describe('AI Policy Hardening, Safety & Cost Guardrails', () => {
  before(() => {
    closeDatabase();
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch (e) {}
    }
    getDatabase(testDbPath);
  });

  after(() => {
    closeDatabase();
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch (e) {}
    }
  });

  describe('Conversion & Status Transition Protection (Invariant 5)', () => {
    test('blocks AI from setting lead status to converted', () => {
      const currentLead = { wa_id: '919000000001', status: 'hot' };
      const proposed = {
        status: 'converted',
        notes: 'User agreed to sign up for annual pinnacle'
      };

      const sanitized = aiPolicy.validateAndSanitizeUpdates(currentLead, proposed);
      // Status must NOT be converted
      assert.strictEqual(sanitized.status, undefined);
      assert.ok(sanitized.notes.includes('annual pinnacle'));
    });

    test('rejects arbitrary invalid status enums', () => {
      const currentLead = { wa_id: '919000000002', status: 'new' };
      const proposed = { status: 'vip_champion_deal' };

      const sanitized = aiPolicy.validateAndSanitizeUpdates(currentLead, proposed);
      assert.strictEqual(sanitized.status, undefined);
    });

    test('allows legitimate qualification transitions (contacted, qualified, hot)', () => {
      const currentLead = { wa_id: '919000000003', status: 'contacted' };
      const proposed = { status: 'qualified', interest: 'CrossFit' };

      const sanitized = aiPolicy.validateAndSanitizeUpdates(currentLead, proposed);
      assert.strictEqual(sanitized.status, 'qualified');
      assert.strictEqual(sanitized.interest, 'CrossFit');
    });
  });

  describe('Medical & Injury Safety (Phase 40)', () => {
    test('detects herniated disc and triggers human handoff with safe disclaimer', () => {
      const message = "I have a severe herniated disc in L4-L5. Can you cure it with deadlifts?";
      const check = aiPolicy.checkMedicalInjurySafety(message);

      assert.strictEqual(check.isMedicalQuery, true);
      assert.strictEqual(check.handoffReason, 'injury_question');
      assert.ok(check.disclaimerText.includes('do not diagnose injuries or provide medical advice'));
    });

    test('detects ACL tear / ligament questions and refuses diagnosis', () => {
      const message = "Had an ACL tear surgery 3 months ago, what rehab exercises should I do?";
      const check = aiPolicy.checkMedicalInjurySafety(message);

      assert.strictEqual(check.isMedicalQuery, true);
      assert.strictEqual(check.handoffReason, 'injury_question');
    });

    test('permits ordinary fitness questions without false medical trigger', () => {
      const message = "Do you have squat racks and heavy dumbbells for hypertrophy training?";
      const check = aiPolicy.checkMedicalInjurySafety(message);

      assert.strictEqual(check.isMedicalQuery, false);
      assert.strictEqual(check.disclaimerText, null);
    });
  });

  describe('Deterministic Router Cost Control (Phase 14)', () => {
    test('routes opening hours deterministically without calling LLM', () => {
      const route = deterministicRouter.routeMessage('What are your gym timings on sunday?', {}, { wa_id: '919000000004' });
      assert.strictEqual(route.matched, true);
      assert.ok(route.replyText.includes('Mon-Sat 5:00 AM - 10:00 PM'));
      assert.ok(route.replyText.includes('Sunday 8:00 AM - 2:00 PM'));
    });

    test('routes location and parking query deterministically', () => {
      const route = deterministicRouter.routeMessage('Where are you located?', {}, { wa_id: '919000000005' });
      assert.strictEqual(route.matched, true);
      assert.ok(route.replyText.includes('JP Nagar') || route.replyText.includes('J.P. Nagar'));
    });

    test('routes explicit staff request to human handoff', () => {
      const route = deterministicRouter.routeMessage('Please connect me to human staff', {}, { wa_id: '919000000006' });
      assert.strictEqual(route.matched, true);
      assert.strictEqual(route.updates.needs_human, true);
      assert.strictEqual(route.updates.handoff_reason, 'human_requested');
    });

    test('returns matched: false for complex or open-ended conversations', () => {
      const route = deterministicRouter.routeMessage('I have been sedentary for 5 years and want to prepare for a marathon in 6 months.', {}, {});
      assert.strictEqual(route.matched, false);
    });
  });

  describe('AI Usage Tracking & Budget Guardrails (Phase 17 & 18)', () => {
    test('records token usage and calculates estimated INR cost', () => {
      aiCostTracker.recordUsage({
        tenantId: 'goldkraft',
        requestId: 'req_test_001',
        model: 'google/gemini-2.5-flash',
        inputTokens: 1000,
        outputTokens: 500,
        latencyMs: 350,
        success: true
      });

      const db = getDatabase(testDbPath);
      const row = db.prepare('SELECT * FROM ai_usage WHERE request_id = ?').get('req_test_001');
      assert.ok(row, 'Usage record should exist');
      assert.strictEqual(row.input_tokens, 1000);
      assert.strictEqual(row.output_tokens, 500);
      assert.ok(row.estimated_cost_inr > 0);
    });

    test('enforces monthly token budget guardrail and prevents runaway spend', async () => {
      const tenantConfigWithLowBudget = {
        monthly_token_budget: 1200 // Current tokens already at 1500
      };

      const budgetCheck = aiCostTracker.checkBudget('goldkraft', tenantConfigWithLowBudget);
      assert.strictEqual(budgetCheck.exceeded, true);
      assert.strictEqual(budgetCheck.reason, 'token_budget_exceeded');

      // AI Service honors budget limit and routes to fallback
      const lead = leadRepository.getOrCreateLead('919000000099', 'Budget Lead', new Date().toISOString(), 'goldkraft');
      const result = await aiService.processInboundMessage(lead, 'Hi! How much is gym?', tenantConfigWithLowBudget, 'goldkraft');

      assert.strictEqual(result.extractedUpdates.needs_human, true);
      assert.strictEqual(result.extractedUpdates.handoff_reason, 'budget_exceeded');
    });
  });
});

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const testDbPath = path.join(__dirname, '../data/test_ai_evals.db');
process.env.DATABASE_PATH = testDbPath;

const { getDatabase, closeDatabase } = require('../src/db/database');
const leadRepository = require('../src/db/leadRepository');
const aiService = require('../src/services/aiService');
const aiPolicy = require('../src/services/aiPolicy');
const deterministicRouter = require('../src/services/deterministicRouter');

describe('AI Conversational Evaluation Fixtures (Phase 38)', () => {
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

  const evaluationFixtures = [
    {
      name: 'Pricing inquiry',
      input: 'How much does your monthly membership cost?',
      expectedInterest: 'membership_pricing',
      expectedStatus: 'qualified',
      needsHuman: false
    },
    {
      name: 'Trial session booking',
      input: 'Hey, I would like to book a trial workout tomorrow morning',
      expectedInterest: 'trial_booking',
      expectedStatus: 'hot',
      needsHuman: true,
      expectedHandoff: 'ready_to_book'
    },
    {
      name: 'Price negotiation / discount seeking',
      input: 'Can you give me a 50% student discount or cheap deal?',
      needsHuman: true,
      expectedHandoff: 'price_negotiation'
    },
    {
      name: 'Explicit human request',
      input: 'I want to speak with a human coach please call me',
      needsHuman: true,
      expectedHandoff: 'human_requested'
    },
    {
      name: 'Injury / Medical safety query',
      input: 'I have severe sciatica and a herniated disc in my spine, can you fix it?',
      needsHuman: true,
      expectedHandoff: 'injury_question',
      isMedical: true
    },
    {
      name: 'Complaint / grievance',
      input: 'Your locker room was dirty today and AC was turned off',
      needsHuman: true,
      expectedHandoff: 'complaint'
    },
    {
      name: 'Hinglish / Slang beginner inquiry',
      input: 'Bhai gym join karna hai, beginner hu kuch idea nahi hai',
      needsHuman: false
    },
    {
      name: 'Emoji heavy message',
      input: '💪🔥🏋️‍♂️ What are the gym timings today??',
      needsHuman: false,
      isTimings: true
    },
    {
      name: 'Very short message',
      input: 'Fees?',
      expectedInterest: 'membership_pricing',
      expectedStatus: 'qualified'
    }
  ];

  for (const fixture of evaluationFixtures) {
    test(`evaluates fixture: ${fixture.name}`, async () => {
      const waId = `91${Math.floor(1000000000 + Math.random() * 9000000000)}`;
      const lead = leadRepository.getOrCreateLead(waId, 'Eval User', new Date().toISOString(), 'goldkraft');

      let replyText = null;
      let updates = {};

      // 1. Check medical policy
      const medicalCheck = aiPolicy.checkMedicalInjurySafety(fixture.input);
      if (medicalCheck.isMedicalQuery) {
        replyText = medicalCheck.disclaimerText;
        updates = {
          needs_human: true,
          handoff_reason: medicalCheck.handoffReason
        };
        aiService.applyLeadUpdates(lead, updates, 'goldkraft');
      } else {
        // 2. Check deterministic router
        const route = deterministicRouter.routeMessage(fixture.input, {}, lead);
        if (route.matched) {
          replyText = route.replyText;
          updates = route.updates || {};
          aiService.applyLeadUpdates(lead, updates, 'goldkraft');
        } else {
          // 3. AI Service processing
          const result = await aiService.processInboundMessage(lead, fixture.input, {}, 'goldkraft');
          replyText = result.replyText;
          updates = result.extractedUpdates || {};
        }
      }

      // Assertions
      assert.ok(replyText && typeof replyText === 'string', 'Reply text must be non-empty string');

      // Invariant 8: Customer text must never leak JSON or tags
      assert.strictEqual(replyText.includes('<<<'), false, 'Reply must not contain delimiter opening');
      assert.strictEqual(replyText.includes('>>>'), false, 'Reply must not contain delimiter closing');
      assert.strictEqual(replyText.includes('{"name":'), false, 'Reply must not contain raw JSON');

      // Invariant 5: Status must never be converted
      assert.notStrictEqual(updates.status, 'converted', 'AI must never produce converted status');

      // Specific fixture expectations
      if (fixture.expectedInterest) {
        assert.strictEqual(updates.interest, fixture.expectedInterest);
      }
      if (fixture.expectedStatus) {
        assert.strictEqual(updates.status, fixture.expectedStatus);
      }
      if (fixture.needsHuman !== undefined) {
        assert.strictEqual(Boolean(updates.needs_human), fixture.needsHuman);
      }
      if (fixture.expectedHandoff) {
        assert.strictEqual(updates.handoff_reason, fixture.expectedHandoff);
      }
      if (fixture.isMedical) {
        assert.ok(replyText.includes('do not diagnose injuries'));
      }
      if (fixture.isTimings) {
        assert.ok(replyText.includes('5:00 AM') || replyText.includes('operating hours'));
      }
    });
  }
});

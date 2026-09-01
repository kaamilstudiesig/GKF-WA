const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = path.join(__dirname, '../data/test_ai.db');

const { getDatabase, closeDatabase } = require('../src/db/database');
const leadRepository = require('../src/db/leadRepository');
const aiService = require('../src/services/aiService');
const gymConfig = require('../src/config/gymConfig');

describe('AI Service & Dual Extraction Parsing', () => {
  before(() => {
    if (fs.existsSync(process.env.DATABASE_PATH)) {
      fs.unlinkSync(process.env.DATABASE_PATH);
    }
    getDatabase(process.env.DATABASE_PATH);
  });

  after(() => {
    closeDatabase();
    if (fs.existsSync(process.env.DATABASE_PATH)) {
      try { fs.unlinkSync(process.env.DATABASE_PATH); } catch (e) {}
    }
  });

  test('parses delimited LEAD_UPDATE block and cleanly strips it from customer reply', () => {
    const rawAiText = `We would love to welcome you for a trial at Goldkraft Fitness! We are open from 5:00 AM tomorrow.

<<<LEAD_UPDATE: {
  "name": "Vikram Seth",
  "interest": "Trial Booking",
  "status": "hot",
  "needs_human": true,
  "handoff_reason": "ready_to_book",
  "notes": "Wants to visit tomorrow morning at 6 AM"
}>>>`;

    const { cleanText, leadUpdate } = aiService.parseDelimitedLeadUpdate(rawAiText);

    assert.strictEqual(cleanText, "We would love to welcome you for a trial at Goldkraft Fitness! We are open from 5:00 AM tomorrow.");
    assert.ok(leadUpdate, "leadUpdate should be extracted");
    assert.strictEqual(leadUpdate.name, "Vikram Seth");
    assert.strictEqual(leadUpdate.interest, "Trial Booking");
    assert.strictEqual(leadUpdate.status, "hot");
    assert.strictEqual(leadUpdate.needs_human, true);
    assert.strictEqual(leadUpdate.handoff_reason, "ready_to_book");
  });

  test('handles clean text without delimiter block gracefully', () => {
    const rawAiText = "Our monthly membership is ₹4,040 and includes full gym access and an initial assessment.";
    const { cleanText, leadUpdate } = aiService.parseDelimitedLeadUpdate(rawAiText);

    assert.strictEqual(cleanText, rawAiText);
    assert.strictEqual(leadUpdate, null);
  });

  test('applies extracted updates to lead record in database', () => {
    const waId = '919876500001';
    const lead = leadRepository.getOrCreateLead(waId, 'Unknown', new Date().toISOString());

    aiService.applyLeadUpdates(lead, {
      name: 'Rohan Roy',
      interest: 'Personal Coaching',
      status: 'qualified',
      needs_human: true,
      handoff_reason: 'custom_program',
      summary: 'Lead wants 1-on-1 PT for marathon preparation'
    });

    const updatedLead = leadRepository.findByWaId(waId);
    assert.strictEqual(updatedLead.display_name, 'Rohan Roy');
    assert.strictEqual(updatedLead.interest, 'Personal Coaching');
    assert.strictEqual(updatedLead.status, 'qualified');
    assert.strictEqual(updatedLead.needs_human, true);
    assert.strictEqual(updatedLead.handoff_reason, 'custom_program');
    assert.ok(updatedLead.notes.includes('1-on-1 PT for marathon preparation'));
  });

  test('system prompt includes Goldkraft specific pricing, location, and brand rules', () => {
    const prompt = gymConfig.getSystemPrompt();
    assert.ok(prompt.includes('Goldkraft Fitness'));
    assert.ok(prompt.includes('JP Nagar'));
    assert.ok(prompt.includes('₹4,040/mo'));
    assert.ok(prompt.includes('₹7,080/3mo'));
    assert.ok(prompt.includes('₹10,640/6mo'));
    assert.ok(prompt.includes('₹14,000/yr'));
    assert.ok(prompt.includes('save_lead'));
    assert.ok(prompt.includes('notify_staff'));
  });
});

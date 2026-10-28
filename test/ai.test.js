const { db, reset } = require('./helpers');
const { test, describe, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert');
const env = require('../src/config/env');
const aiService = require('../src/services/aiService');
const aiCostTracker = require('../src/services/aiCostTracker');
const leadRepository = require('../src/db/leadRepository');

after(() => db.close());
beforeEach(() => reset());
afterEach(() => { aiService.transport = null; });

/** Fake OpenRouter: each call shifts the next scripted response (or error). */
function script(...steps) {
  const calls = [];
  aiService.transport = async body => {
    calls.push(body);
    const step = steps.shift();
    if (!step) throw new Error('unexpected extra model call');
    if (step.error) throw Object.assign(new Error(step.error), step.status ? { response: { status: step.status } } : {});
    return { choices: [{ message: step.message }], usage: { prompt_tokens: 1000, completion_tokens: 50, cost: 0.0002 } };
  };
  return calls;
}
const toolCall = (name, args) => ({ id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const newLead = async (waId = '919833333301') => {
  const l = await leadRepository.upsertInbound(waId, 'Kiran');
  await leadRepository.saveMessage({ messageId: `m_${waId}`, waId, direction: 'in', text: 'hi' });
  return l;
};

describe('AI replies', () => {
  test('reply and tool call in one response cost one model call', async () => {
    const calls = script({ message: { content: 'Great, see you Saturday!', tool_calls: [toolCall('save_lead', { interest: 'fat loss', status: 'qualified' })] } });
    const lead = await newLead();
    const out = await aiService.reply(lead, 'hi');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(out.replyText, 'Great, see you Saturday!');
    const l = await leadRepository.findByWaId(lead.wa_id);
    assert.strictEqual(l.interest, 'fat loss');
    assert.strictEqual(l.status, 'qualified');
    const usage = await db.one('SELECT * FROM ai_usage');
    assert.strictEqual(usage.cost_usd, 0.0002);
    assert.strictEqual(usage.success, true);
    assert.deepStrictEqual(calls[0].usage, { include: true });
  });

  test('a tool call without text triggers one short follow-up call', async () => {
    const calls = script(
      { message: { content: '', tool_calls: [toolCall('notify_staff', { handoff_reason: 'ready_to_book', summary: 'Wants Sat 7am' })] } },
      { message: { content: 'A coach will call you to confirm.' } }
    );
    const lead = await newLead();
    const out = await aiService.reply(lead, 'book me in');
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[1].tools, undefined);
    assert.strictEqual(out.replyText, 'A coach will call you to confirm.');
    const l = await leadRepository.findByWaId(lead.wa_id);
    assert.strictEqual(l.needs_human, true);
    assert.strictEqual(l.handoff_reason, 'ready_to_book');
  });

  test('a temporary failure falls back to the backup model', async () => {
    env.openRouterModel = 'primary/model';
    env.openRouterFallbackModel = 'backup/model';
    const calls = script({ error: 'overloaded', status: 503 }, { message: { content: 'Hello from backup' } });
    const out = await aiService.reply(await newLead(), 'hi');
    assert.deepStrictEqual(calls.map(c => c.model), ['primary/model', 'backup/model']);
    assert.strictEqual(out.replyText, 'Hello from backup');
    const rows = await db.many('SELECT model, success FROM ai_usage ORDER BY id');
    assert.deepStrictEqual(rows.map(r => [r.model, r.success]), [['primary/model', false], ['backup/model', true]]);
  });

  test('a permanent error (bad request) skips the fallback and hands off to staff', async () => {
    env.openRouterFallbackModel = 'backup/model';
    const calls = script({ error: 'bad request', status: 400 });
    const lead = await newLead();
    const out = await aiService.reply(lead, 'hi');
    assert.strictEqual(calls.length, 1);
    assert.match(out.replyText, /get back to you shortly/);
    assert.strictEqual((await leadRepository.findByWaId(lead.wa_id)).handoff_reason, 'ai_service_unavailable');
  });

  test('network failure on both models hands off with ai_network_error', async () => {
    env.openRouterModel = 'primary/model';
    env.openRouterFallbackModel = 'backup/model';
    script({ error: 'ECONNRESET' }, { error: 'ECONNRESET' });
    const lead = await newLead();
    await aiService.reply(lead, 'hi');
    assert.strictEqual((await leadRepository.findByWaId(lead.wa_id)).handoff_reason, 'ai_network_error');
  });

  test('the monthly budget stops AI calls and hands leads to staff', async () => {
    const calls = script();
    await db.query(`INSERT INTO ai_usage (request_id, model, input_tokens, output_tokens) VALUES ('x', 'm', $1, 0)`, [env.aiMonthlyTokenBudget]);
    const lead = await newLead();
    await aiService.reply(lead, 'hi');
    assert.strictEqual(calls.length, 0);
    assert.strictEqual((await leadRepository.findByWaId(lead.wa_id)).handoff_reason, 'budget_exceeded');
    assert.strictEqual((await aiCostTracker.checkBudget()).exceeded, true);
  });

  test('the AI cannot mark a lead converted or clear a staff hand-off', async () => {
    script({ message: { content: 'Done!', tool_calls: [toolCall('save_lead', { status: 'converted' })] } });
    const lead = await newLead();
    await leadRepository.update(lead.wa_id, { needs_human: true, handoff_reason: 'complaint' });
    await aiService.reply(await leadRepository.findByWaId(lead.wa_id), 'hi');
    const l = await leadRepository.findByWaId(lead.wa_id);
    assert.notStrictEqual(l.status, 'converted');
    assert.strictEqual(l.needs_human, true);
  });

  test('legacy <<<LEAD_UPDATE>>> blocks are applied and never shown to the lead', async () => {
    script({ message: { content: 'Welcome Kiran! <<<LEAD_UPDATE: {"interest": "yoga", "status": "qualified"}>>>' } });
    const lead = await newLead();
    const out = await aiService.reply(lead, 'hi');
    assert.strictEqual(out.replyText, 'Welcome Kiran!');
    assert.strictEqual((await leadRepository.findByWaId(lead.wa_id)).interest, 'yoga');
  });

  test('only the last N history messages are sent, with the system prompt first', async () => {
    const calls = script({ message: { content: 'ok' } });
    const lead = await newLead('919833333309');
    for (let i = 0; i < 25; i++) {
      await leadRepository.saveMessage({ messageId: `h${i}`, waId: lead.wa_id, direction: i % 2 ? 'out' : 'in', text: `msg ${i}`, timestamp: new Date(Date.now() - (30 - i) * 1000).toISOString() });
    }
    await leadRepository.saveMessage({ messageId: 'now', waId: lead.wa_id, direction: 'in', text: 'latest question' });
    await aiService.reply(lead, 'latest question');
    const msgs = calls[0].messages;
    assert.strictEqual(msgs[0].role, 'system');
    assert.match(msgs[0].content, /Goldkraft Fitness/);
    assert.strictEqual(msgs.length, 2 + env.aiHistoryMessages + 1);
    assert.deepStrictEqual(msgs[msgs.length - 1], { role: 'user', content: 'latest question' });
  });

  test('replies are stripped of JSON and fall back to a safe default when empty', () => {
    assert.strictEqual(aiService.sanitizeReply('Hi {"name": "x"} there'), 'Hi  there');
    assert.match(aiService.sanitizeReply('', { needs_human: true }), /coach .* will reach out/);
    const leaked = 'Great goal!\n<parameter name="notes">Beginner, lose 8 kg</parameter>\n<parameter name="name">Live';
    assert.strictEqual(aiService.sanitizeReply(leaked), 'Great goal!');
  });
});

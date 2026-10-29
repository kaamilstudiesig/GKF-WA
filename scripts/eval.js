/**
 * Compares OpenRouter models on realistic lead messages. Opt-in, costs a few cents;
 * not part of `npm test`.
 *
 *   OPENROUTER_API_KEY=... node scripts/eval.js google/gemini-2.5-flash-lite google/gemini-2.5-flash
 *   node scripts/eval.js --full <model...>    print every reply in full
 *
 * Each message goes through the same prompt the bot uses (aiService.buildMessages)
 * and one model call (aiService.callModel), with no conversation history.
 * Nothing is written to the database.
 */
require('dotenv').config({ quiet: true });
const env = require('../src/config/env');
const aiService = require('../src/services/aiService');
const aiCostTracker = require('../src/services/aiCostTracker');

const CASES = [
  { id: 'pricing', text: 'Hi, what are your membership prices?' },
  { id: 'trial', text: 'Can I book a free trial session this Saturday morning?' },
  { id: 'discount', text: '3000 a month is too much yaar, any discount if I pay for 6 months?' },
  { id: 'injury', text: 'I had knee surgery last year, is it safe for me to do squats at your gym?' },
  { id: 'complaint', text: 'The AC was not working again yesterday and nobody at the desk cared. Very disappointed.' },
  { id: 'hinglish', text: 'Bhai main beginner hoon, kabhi gym nahi gaya. Weight loss karna hai, kaise start karu?' },
  { id: 'human', text: 'I want to talk to a real person please, not a bot' },
  { id: 'short', text: 'Fees?' }
];

const LEAD = { display_name: null, status: 'new', interest: null, needs_human: false, metadata: {} };
const LEAK = /<[a-z/!]|<<<|\{|```|tool_call|function_call/i;

// Usage is recorded in the database by the app; the eval only reads it from the response.
let lastUsage = null;
aiCostTracker.record = async (u) => { lastUsage = u; };

function cut(s, n) {
  const flat = String(s || '').replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

function printTable(rows) {
  const cols = Object.keys(rows[0]);
  const width = cols.map(c => Math.max(c.length, ...rows.map(r => String(r[c]).length)));
  const line = r => cols.map((c, i) => String(r[c]).padEnd(width[i])).join(' | ');
  console.log(line(Object.fromEntries(cols.map(c => [c, c]))));
  console.log(width.map(w => '-'.repeat(w)).join('-|-'));
  rows.forEach(r => console.log(line(r)));
}

async function runCase(model, testCase) {
  lastUsage = null;
  const messages = aiService.buildMessages(LEAD, [], testCase.text);
  const started = Date.now();
  try {
    const msg = await aiService.callModel(model, messages, { requestId: `eval_${testCase.id}`, timeoutMs: 45000 });
    const content = msg.content || '';
    const tools = (msg.tool_calls || []).map(t => t.function?.name).join(',');
    return {
      model, case: testCase.id,
      ms: Date.now() - started,
      tokens: lastUsage ? `${lastUsage.inputTokens ?? '?'}/${lastUsage.outputTokens ?? '?'}` : '?',
      cost_usd: typeof lastUsage?.costUsd === 'number' ? lastUsage.costUsd.toFixed(6) : '?',
      tools: tools || '-',
      flag: LEAK.test(content) ? 'LEAK' : (content.trim() ? '' : 'NO TEXT'),
      reply: content
    };
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    return { model, case: testCase.id, ms: Date.now() - started, tokens: '-', cost_usd: '-', tools: '-', flag: 'ERROR', reply: detail };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const full = args.includes('--full');
  const models = args.filter(a => !a.startsWith('--'));
  if (!models.length) {
    console.error('Usage: node scripts/eval.js [--full] <model> [model...]');
    process.exit(1);
  }
  if (!env.openRouterApiKey) {
    console.error('OPENROUTER_API_KEY is not set; the eval calls the real API and needs a key.');
    process.exit(1);
  }

  const results = [];
  for (const model of models) {
    for (const testCase of CASES) {
      const r = await runCase(model, testCase);
      results.push(r);
      process.stderr.write(`${model} ${testCase.id} ${r.ms}ms ${r.flag}\n`);
    }
  }

  console.log('');
  printTable(results.map(r => ({ ...r, reply: full ? r.reply.replace(/\s+/g, ' ') : cut(r.reply, 70) })));

  console.log('\nPer model:');
  printTable(models.map(model => {
    const rs = results.filter(r => r.model === model);
    const ok = rs.filter(r => r.flag !== 'ERROR');
    const cost = ok.reduce((s, r) => s + (Number(r.cost_usd) || 0), 0);
    return {
      model,
      avg_ms: ok.length ? Math.round(ok.reduce((s, r) => s + r.ms, 0) / ok.length) : '-',
      total_cost_usd: cost.toFixed(6),
      with_tools: rs.filter(r => r.tools !== '-').length,
      flagged: rs.filter(r => r.flag).length
    };
  }));
  console.log('\nFlags: LEAK = raw reply has <, {, ``` or tool markup (the bot strips it, but it means the model is unreliable);');
  console.log('NO TEXT = tool call only, so the bot would need a second call; ERROR = request failed.');
}

main().catch(err => { console.error(err); process.exit(1); });

/**
 * K29 check: does each model still route with our data policy (no storage or training,
 * zero data retention when OPENROUTER_ZDR is on)? One tiny paid call per model, a fraction
 * of a cent each; needs the owner's OK. Sends no lead data.
 *
 *   heroku run -a gkf-wa "node scripts/ai-privacy-check.js"
 *
 * Exit code 1 if any model has no provider that meets the policy (OpenRouter answers 404).
 */
require('dotenv').config({ quiet: true });
const axios = require('axios');
const env = require('../src/config/env');
const { AIService } = require('../src/services/aiService');

async function check(model) {
  const body = {
    model,
    messages: [{ role: 'user', content: 'Reply with the word OK.' }],
    max_tokens: 50,
    usage: { include: true },
    provider: AIService.providerPrefs()
  };
  try {
    const { data } = await axios.post(`${env.openRouterBaseUrl}/chat/completions`, body, {
      headers: { Authorization: `Bearer ${env.openRouterApiKey}`, 'Content-Type': 'application/json', 'X-Title': 'Lead Engine (privacy check)' },
      timeout: 45000
    });
    const cost = typeof data?.usage?.cost === 'number' ? ` $${data.usage.cost.toFixed(6)}` : '';
    console.log(`OK    ${model} -> ${data?.provider || 'unknown provider'}${cost}`);
    return true;
  } catch (err) {
    const status = err.response?.status;
    const msg = err.response?.data?.error?.message || err.message;
    console.log(`FAIL  ${model} -> ${status || 'network'}: ${String(msg).slice(0, 200)}`);
    return false;
  }
}

(async () => {
  if (!env.openRouterApiKey) { console.error('OPENROUTER_API_KEY is not set.'); process.exit(2); }
  console.log(`Policy: ${JSON.stringify(AIService.providerPrefs())}`);
  const models = [...new Set([env.openRouterModel, env.openRouterFallbackModel].filter(Boolean))];
  let ok = true;
  for (const m of models) ok = (await check(m)) && ok;
  process.exit(ok ? 0 : 1);
})();

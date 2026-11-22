/**
 * R8: a free preview of the assistant's fixed answers, for the setup wizard. Same checks and order
 * as the bot (src/workers/webhookWorker.js: STOP, health-related mode, medical safety, fixed replies),
 * for a brand-new lead. No AI call, nothing saved, nothing sent: when the AI would answer, it says so.
 * Keep the order in step with the bot's.
 */
const MAX_CHARS = 300;

function replyPreview(input, profile = {}) {
  const text = String(input || '').trim().slice(0, MAX_CHARS);
  if (!text) return null;
  // Required here: a standalone CRM (without the bot) never calls this.
  const optOut = require('../../src/services/optOut');
  const aiPolicy = require('../../src/services/aiPolicy');
  const deterministicRouter = require('../../src/services/deterministicRouter');

  if (optOut.classify(text) === 'stop') return { text, kind: 'fixed', reply: optOut.replyFor('stop', text), buttons: [], handoff: false };
  if (profile.healthRelated) {
    const health = aiPolicy.checkHealthQuestion(text);
    if (health.isHealthQuestion) return { text, kind: 'fixed', reply: health.replyText, buttons: [], handoff: true };
  }
  const medical = aiPolicy.checkMedicalInjurySafety(text);
  if (medical.isMedicalQuery) return { text, kind: 'fixed', reply: medical.disclaimerText, buttons: [], handoff: true };
  const routed = deterministicRouter.routeMessage(text, {}, {});
  if (routed.matched) {
    return {
      text, kind: 'fixed', reply: routed.replyText, buttons: (routed.buttons || []).map(b => b.title),
      handoff: Boolean(routed.updates && routed.updates.needs_human)
    };
  }
  return { text, kind: 'ai', reply: null, buttons: [], handoff: false };
}

module.exports = { replyPreview, MAX_CHARS };

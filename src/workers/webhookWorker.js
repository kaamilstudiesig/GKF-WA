const QueueWorker = require('./queueWorker');
const outboundWorker = require('./outboundWorker');
const eventRepository = require('../db/eventRepository');
const outboundRepository = require('../db/outboundRepository');
const leadRepository = require('../db/leadRepository');
const aiPolicy = require('../services/aiPolicy');
const deterministicRouter = require('../services/deterministicRouter');
const aiService = require('../services/aiService');
const whatsappService = require('../services/whatsappService');
const { applyLeadUpdates } = require('../services/leadUpdates');
const { applyReferral } = require('../services/adAttribution');
const gymConfig = require('../config/gymConfig');
const logger = require('../utils/logger');
const { captureException } = require('../utils/sentry');

/** Text the lead actually sent, including taps on buttons and list items. */
function textOf(msg) {
  switch (msg.type) {
    case 'text': return msg.text?.body || '';
    case 'button': return msg.button?.text || '';
    case 'interactive': return msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '';
    default: return null;
  }
}

/** Decides the reply to one inbound message: safety check, fixed replies, then AI. */
async function decideReply(lead, text) {
  const medical = aiPolicy.checkMedicalInjurySafety(text);
  if (medical.isMedicalQuery) {
    await applyLeadUpdates(lead, { needs_human: true, handoff_reason: medical.handoffReason, summary: 'Asked an injury/medical question.' });
    return medical.disclaimerText;
  }
  const routed = deterministicRouter.routeMessage(text, {}, lead);
  if (routed.matched) {
    if (routed.updates) await applyLeadUpdates(lead, routed.updates);
    return routed.replyText;
  }
  return (await aiService.reply(lead, text)).replyText;
}

async function processEvent(event) {
  try {
    const { msg, contact } = event.payload || {};
    const waId = event.wa_id;
    if (!msg || !waId || !msg.id) {
      await eventRepository.failPermanent(event.id, 'Event is missing the message or sender');
      return;
    }
    const timestamp = msg.timestamp ? new Date(Number(msg.timestamp) * 1000).toISOString() : new Date().toISOString();

    let lead = await leadRepository.upsertInbound(waId, contact?.profile?.name || null, timestamp);
    lead = await applyReferral(lead, msg);

    const replyKey = `reply:${msg.id}`;
    const alreadySaved = await leadRepository.hasMessage(msg.id);
    if (alreadySaved && await outboundRepository.findByDedupKey(replyKey)) {
      await eventRepository.complete(event.id); // replayed after a crash; reply already queued
      return;
    }

    const text = textOf(msg);
    if (!alreadySaved) {
      await leadRepository.saveMessage({
        messageId: msg.id, waId, direction: 'in', timestamp,
        text: text !== null ? text : `[${String(msg.type || 'unknown').toUpperCase()} message]`
      });
    }
    whatsappService.markReadWithTyping(msg.id); // fire and forget

    const replyText = text !== null && text.trim()
      ? await decideReply(lead, text)
      : gymConfig.fallbackMessages.nonTextMessage;

    await outboundRepository.enqueue({ dedupKey: replyKey, waId, text: replyText, metadata: { in_reply_to: msg.id } });
    if (outboundWorker.running) outboundWorker.kick();
    await eventRepository.complete(event.id);
  } catch (err) {
    captureException(err, { component: 'webhook_worker', eventId: event.id });
    logger.error('Failed to process inbound message', { event_id: event.id, error: err.message });
    await eventRepository.fail(event.id, err.message);
  }
}

const webhookWorker = new QueueWorker('Inbound message worker', {
  claim: () => eventRepository.claimNext(),
  handle: processEvent,
  concurrency: 3
});

module.exports = webhookWorker;
module.exports.processEvent = processEvent;
module.exports.textOf = textOf;

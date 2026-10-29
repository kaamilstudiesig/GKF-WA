const QueueWorker = require('./queueWorker');
const outboundWorker = require('./outboundWorker');
const eventRepository = require('../db/eventRepository');
const outboundRepository = require('../db/outboundRepository');
const leadRepository = require('../db/leadRepository');
const aiPolicy = require('../services/aiPolicy');
const deterministicRouter = require('../services/deterministicRouter');
const aiService = require('../services/aiService');
const whatsappService = require('../services/whatsappService');
const botGuard = require('../services/botGuard');
const notifyService = require('../services/notifyService');
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

/**
 * Decides the reply to one inbound message: safety check, fixed replies, then AI.
 * Returns { text, buttons?, location? }.
 */
async function decideReply(lead, text) {
  const medical = aiPolicy.checkMedicalInjurySafety(text);
  if (medical.isMedicalQuery) {
    await applyLeadUpdates(lead, { needs_human: true, handoff_reason: medical.handoffReason, summary: 'Asked an injury/medical question.' });
    return { text: medical.disclaimerText };
  }
  const routed = deterministicRouter.routeMessage(text, {}, lead);
  if (routed.matched) {
    if (routed.updates) await applyLeadUpdates(lead, routed.updates);
    return { text: routed.replyText, buttons: routed.buttons, location: routed.location };
  }
  return { text: (await aiService.reply(lead, text)).replyText };
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
    const guard = await botGuard.check(waId);
    if (guard.paused || guard.overCap) {
      // Staff are handling this lead (or it hit the daily cap): record the message, don't answer.
      whatsappService.markReadWithTyping(msg.id, { typing: false });
      if (guard.paused) notifyService.notifyLeadMessage({ waId, text: text ?? `[${msg.type} message]` });
      logger.info('Bot stayed quiet', { wa_id: waId, reason: guard.paused ? 'staff_handling' : 'daily_cap' });
      await eventRepository.complete(event.id);
      return;
    }
    whatsappService.markReadWithTyping(msg.id); // fire and forget

    let reply;
    if (guard.capReached) {
      await applyLeadUpdates(lead, { needs_human: true, handoff_reason: 'other', summary: 'Daily bot reply limit reached for this lead.' });
      reply = { text: gymConfig.fallbackMessages.systemError };
    } else {
      reply = text !== null && text.trim()
        ? await decideReply(lead, text)
        : { text: gymConfig.fallbackMessages.nonTextMessage };
    }

    const metadata = { in_reply_to: msg.id };
    if (reply.buttons?.length) metadata.buttons = reply.buttons;
    if (reply.location) metadata.location = reply.location;
    await outboundRepository.enqueue({ dedupKey: replyKey, waId, text: reply.text, metadata });
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
module.exports.decideReply = decideReply;
